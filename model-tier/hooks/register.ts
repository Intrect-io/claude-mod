import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, Tier, TierState } from '../types'
import { evalCommand } from './eval'
import { capTier, labelPrompt, RANK } from './label'
import type { PromptLabels } from './label'
import { newerModel, validLearned } from './latest'
import { appendLog } from './log'
import type { ModelTotals } from './log'
import { statsCommand } from './stats'
import { segment } from './segment'

export { capTier }

const PLUGIN = 'model-tier'
const SET_TIER = `mcp__${PLUGIN}__set_tier`
const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']
const isTierName = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
// The highest tier anything but the person picks: the classifier, subagent
// routing and the model's own set_tier. Fable has its own, tighter rate limit
// on Claude Teams, so by default only /tier fable reaches it.
export const DEFAULT_MAX_AUTO_TIER: Tier = 'opus'
export const maxAutoTier = (v: unknown): Tier => (isTierName(v) ? v : DEFAULT_MAX_AUTO_TIER)
// How much thinking the prompt needs, as the classifier names it. `max` is never
// proposed: only the model (set_tier) or the person (/tier effort) asks for it.
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
// The model class a prompt's tier means on the provider that has to answer.
// Claude names carry each other ('claude-opus-5-5' is 'opus'); another
// provider's model (cc-router's codex or its ollama fallback, when Claude
// quota runs out) keeps the same tier there, by that provider's map in
// `providerTierModels`. A provider with no map is left at its own model:
// we know no id to send.
export function providerOf(model: string): string {
  const m = model.toLowerCase()
  if (m.startsWith('claude') || m.includes('anthropic')) return 'anthropic'
  if (/^(codex|o\d|gpt-|gpt\)|.*\b(gpt)-)/.test(m)) return 'openai'
  const slash = model.indexOf('/')
  if (slash > 0 && !m.includes('anthropic/')) return m.slice(0, slash)
  return 'unknown'
}

// The model that answers when cc-router moves a session to OpenAI.
export const OPENAI_MODEL: Record<Tier, string> = { fable: 'codex', opus: 'codex', sonnet: 'default', haiku: 'default' }
export const OLLAMA_MODEL = 'ollama'

export const DEFAULT_PROVIDER_TIER_MODELS: Record<string, Partial<Record<Tier, string>>> = {
  anthropic: {},
  openai: OPENAI_MODEL,
  ollama: {},
}

// Subagent types that carry no model of their own; others keep their definition's.
// Explore joined after a live probe (2026-11-04, Claude Code 2.1.317): its spawn
// reached agent.spawn with no model and its steps ran on the parent's opus.
export const DEFAULT_ROUTABLE_AGENTS = 'general-purpose,claude,Explore'

/** The `routableAgents` list (`a,b,c`) as a set; an unset value takes the default, an empty one routes none. */
export function routableAgents(spec: unknown): Set<string> {
  const text = typeof spec === 'string' ? spec : DEFAULT_ROUTABLE_AGENTS
  return new Set(text.split(',').map(t => t.trim()).filter(t => t !== ''))
}

// Full model ids per tier. A request built here goes to the API as written:
// unlike /model or --model, an alias ('sonnet') is not resolved, and a router
// in ANTHROPIC_BASE_URL answers it 404, which the engine then papers over with
// fallbackModel ("Switched to Opus 5 because sonnet is not available").
export const DEFAULT_TIER_MODELS: Record<Tier, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

/** `opus=claude-opus-5-5,haiku=…` over the defaults; bad entries are ignored. */
export function tierModels(spec: unknown): Record<Tier, string> {
  const models = { ...DEFAULT_TIER_MODELS }
  if (typeof spec !== 'string') return models
  for (const pair of spec.split(',')) {
    const [tier, id] = pair.split('=').map(part => part?.trim() ?? '')
    if (isTierName(tier) && id) models[tier] = id
  }
  return models
}

/** The tiers a `tierModels` spec names: the person chose those ids, so none is replaced by a newer one. */
export function explicitTiers(spec: unknown): Set<Tier> {
  const named = new Set<Tier>()
  if (typeof spec !== 'string') return named
  for (const pair of spec.split(',')) {
    const [tier, id] = pair.split('=').map(part => part?.trim() ?? '')
    // An id equal to the built-in one is no choice: a saved copy of an old default stays replaceable.
    if (isTierName(tier) && id && id !== DEFAULT_TIER_MODELS[tier]) named.add(tier)
  }
  return named
}

/** Where the model ids learned from answers wait for the next session. */
const LEARNED_KEY = 'latestModels'

/** Keeps the ids learned from answers for the next session; a failed write is dropped (they are learned again). */
function saveLearned($: EngineInterface, learned: Set<Tier>, models: Record<Tier, string>): Promise<void> {
  return $.store.set(LEARNED_KEY, Object.fromEntries([...learned].map(t => [t, models[t]]))).catch(() => undefined)
}

/** Whether this turn gets the pick note: the first one, a new pick, or an uncertain one. */
export function noteDue(noted: string | undefined, pick: string, uncertain: boolean): boolean {
  return noted === undefined || noted !== pick || uncertain
}

export const INITIAL: TierState = {
  tier: 'opus',
  source: 'auto',
  pendingCount: 0,
  lastInputTokens: 0,
  effortSource: 'auto',
  pendingEffortCount: 0,
}

// Change the tag when TierState's fields change: it declines an older value.
const state = atom({ plugin: 'model-tier', key: 'tier' } as const, INITIAL, {
  shape: 'tier-2',
})

export type DecideOptions = {
  downgradeAfterTurns: number
  maxTokensForHaiku: number
  maxTokensForDowngrade: number
}

export const DEFAULT_FOLLOW_UP_CHARS = 40

/**
 * A short prompt ("continue", "다음 단계 진행해") goes on with the work in
 * progress, but the classifier sees only its text and labels it trivial.
 * Measured 2026-11-03: 51% of 2,668 real prompts over 14 days were 40
 * characters or fewer. Such a prompt may raise the pick but never lower it.
 */
export function isFollowUp(text: string, followUpChars: number): boolean {
  return text.trim().length <= followUpChars
}

/**
 * Folds one classifier verdict into the state. Upgrades apply at once;
 * downgrades wait for `downgradeAfterTurns` consecutive lower verdicts, since
 * every model switch re-bills the conversation prefix outside the prompt cache.
 */
export function decide(s: TierState, proposed: Tier, o: DecideOptions, followUp = false): TierState {
  if (s.source === 'pinned') return s
  let target = proposed
  if (target === 'haiku' && s.lastInputTokens > o.maxTokensForHaiku) target = 'sonnet'
  // A short follow-up in a session that has sent requests only raises: a
  // same or lower verdict leaves the tier and any pending downgrade as they are.
  if (followUp && s.lastInputTokens > 0 && RANK[target] <= RANK[s.tier]) return s

  if (RANK[target] >= RANK[s.tier]) {
    const changed = target !== s.tier
    return {
      ...s,
      tier: target,
      source: changed ? 'auto' : s.source,
      pendingDown: undefined,
      pendingCount: 0,
    }
  }

  // Nothing sent yet means no cached prefix to lose: step down at once.
  // A large context re-billed outside the cache costs more than a cheaper model saves.
  if (s.lastInputTokens > o.maxTokensForDowngrade) return { ...s, pendingDown: undefined, pendingCount: 0 }

  const count = s.pendingDown === target ? s.pendingCount + 1 : 1
  if (s.lastInputTokens === 0 || count >= o.downgradeAfterTurns) {
    return { ...s, tier: target, source: 'auto', pendingDown: undefined, pendingCount: 0 }
  }
  return { ...s, pendingDown: target, pendingCount: count }
}

/**
 * Whether any tier verdict could change the main loop's tier now. False when the
 * person pinned it, or when it already sits at the highest automatic tier and the
 * context is past `maxTokensForDowngrade`: no label can raise it (capped) or lower
 * it (the ceiling). Measured 2026-11-03: the average main-loop context was ~400k
 * tokens, so this holds on most turns, and classifying there only spends quota.
 */
export function canTierChange(s: TierState, o: DecideOptions, maxAuto: Tier): boolean {
  if (s.source === 'pinned') return false
  return !(RANK[s.tier] >= RANK[maxAuto] && s.lastInputTokens > o.maxTokensForDowngrade)
}

/**
 * Folds one effort verdict into the state, the way `decide` folds a tier:
 * more effort at once, less only after `downgradeAfterTurns` lower verdicts in
 * a row (a request's thinking setting is part of what the prompt cache keys on).
 */
export function decideEffort(s: TierState, proposed: Effort, o: DecideOptions, followUp = false): TierState {
  if (s.effortSource === 'pinned') return s
  if (followUp && s.lastInputTokens > 0 && s.effort !== undefined && EFFORT_RANK[proposed] <= EFFORT_RANK[s.effort]) return s
  if (s.effort === undefined || EFFORT_RANK[proposed] >= EFFORT_RANK[s.effort]) {
    const changed = proposed !== s.effort
    return { ...s, effort: proposed, effortSource: changed ? 'auto' : s.effortSource, pendingEffortDown: undefined, pendingEffortCount: 0 }
  }
  const count = s.pendingEffortDown === proposed ? s.pendingEffortCount + 1 : 1
  if (s.lastInputTokens === 0 || count >= o.downgradeAfterTurns) {
    return { ...s, effort: proposed, effortSource: 'auto', pendingEffortDown: undefined, pendingEffortCount: 0 }
  }
  return { ...s, pendingEffortDown: proposed, pendingEffortCount: count }
}

const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

/** Whether a resolved model id (`claude-opus-5-5[1m]`) is the given tier. */
export function isTier(model: string, tier: Tier): boolean {
  return model === tier || model.toLowerCase().includes(tier)
}

/** The tier's model on the provider now answering.
 * `claude` is routed within anthropic by name; on another provider the map
 * answers it (`openai` → codex/default aliases), or the provider's own model
 * stands when the tier names no model there. */
export function modelFor(model: string, tier: Tier, claude: string, providers: Record<string, Partial<Record<Tier, string>>>): string {
  const provider = providerOf(model)
  if (provider === 'anthropic' || provider === 'unknown') return claude
  const mapped = providers[provider]?.[tier]

  return mapped !== undefined && mapped !== '' ? mapped : model
}

/** `openai=fable:x,opus:y;ollama=…` over the defaults; bad entries are ignored. */
export function providerTierModels(spec: unknown): Record<string, Partial<Record<Tier, string>>> {
  const maps = Object.fromEntries(Object.entries(DEFAULT_PROVIDER_TIER_MODELS).map(([k, v]) => [k, { ...v }]))
  if (typeof spec !== 'string') return maps
  for (const entry of spec.split(';')) {
    const eq = entry.indexOf('=')
    if (eq < 0) continue
    const provider = entry.slice(0, eq).trim()
    const pairs = entry.slice(eq + 1).trim()
    if (provider === '' || pairs === '') continue
    const map = (maps[provider] ??= ({} as Partial<Record<Tier, string>>))
    for (const pair of pairs.split(',')) {
      if (!pair.includes(':')) continue
      const [tier, id] = pair.split(':').map(part => part?.trim() ?? '')
      if (isTierName(tier) && id) map[tier] = id
    }
  }
  return maps
}

export function tierOf(model: string): Tier | undefined {
  return TIERS.find(t => isTier(model, t))
}


const label = (s: TierState) => `${s.tier}${s.effort ? `·${s.effort}` : ''} (${s.source === s.effortSource || s.effort === undefined ? s.source : `${s.source}/${s.effortSource}`})`

// The tier rides the person's status line; nothing about it needs a notice row.
function show($: EngineInterface, s: TierState, enabled: boolean): Promise<void> {
  const pinned = s.source === 'pinned' || s.effortSource === 'pinned'
  // A row an earlier version pinned outlives a reload: take it down.
  $.ui.status(undefined)
  return segment($, enabled ? `${s.tier}${s.effort ? `·${s.effort}` : ''}${pinned ? ' (pin)' : ''}` : '')
}

// The model that answered the session's last main-loop request: a request on
// another one writes the prefix again (a `switch` log line).
let lastAnswered: string | undefined
// Main-loop requests and tokens per model, by turn, until the turn completes.
const turnUsage = new Map<string, Record<string, ModelTotals>>()

// The latest prompt's number: a late label applies only while its prompt is
// still the latest. A reload starts both over (fast, nothing pending).
let promptSeq = 0
// The last classifier answer came later than the bound.
let classifierSlow = false

type LateOptions = { decideOptions: DecideOptions; timeoutMs: number; enabled: boolean; wantTier: boolean; followUp: boolean }

/**
 * A label that missed the bound still decides the rest of the turn: turn.step
 * reads the state before every request, so the steps after the first tool call
 * run on it. A newer prompt, or a pin made meanwhile, wins over it.
 */
async function applyLate($: EngineInterface, labels: PromptLabels, seq: number, waited: boolean, o: LateOptions): Promise<void> {
  const got = await labels.settled
  // Missing a bound it waited for makes it late by definition; otherwise the
  // answer's real latency says whether the classifier is back under the bound.
  classifierSlow = waited || got.ms > o.timeoutMs
  const current = seq === promptSeq
  const tier = labels.tierTimedOut ? got.tier : undefined
  const effort = labels.effortTimedOut ? got.effort : undefined
  if (current && (tier !== undefined || effort !== undefined)) {
    let s = await update($, state, v => (tier !== undefined && v.source !== 'pinned' ? decide(v, tier, o.decideOptions, o.followUp) : v))
    s = await update($, state, v => (effort !== undefined && v.effortSource !== 'pinned' ? decideEffort(v, effort, o.decideOptions, o.followUp) : v))
    void show($, s, o.enabled)
  }
  await appendLog($, { event: 'classifier-late', ms: got.ms, applied: current, waited, wantTier: o.wantTier })
}

export const register: Register = (on, options) => {
  const enabled = options.enabled !== false
  const decideOptions: DecideOptions = {
    downgradeAfterTurns: Number(options.downgradeAfterTurns ?? 2),
    maxTokensForHaiku: Number(options.maxTokensForHaiku ?? 150000),
    maxTokensForDowngrade: Number(options.maxTokensForDowngrade ?? 200000),
  }
  const classifierModel = String(options.classifierModel ?? 'haiku')
  const models = tierModels(options.tierModels)
  // A newer version of a tier's model that answered a request replaces the
  // built-in id for that tier (and is kept across sessions), unless the person
  // set the tier in `tierModels` or turned `learnModels` off.
  const learnModels = options.learnModels !== false
  const pinnedIds = explicitTiers(options.tierModels)
  const learned = new Set<Tier>()
  // Ids refused this session: not adopted again before the next reload.
  const refusedIds = new Set<string>()
  const classifierTimeoutMs = Number(options.classifierTimeoutMs ?? 3000)
  const providers = providerTierModels(options.providerTierModels)
  const routeEffort = options.routeEffort !== false
  const maxAuto = maxAutoTier(options.maxAutoTier)
  const routable = routableAgents(options.routableAgents)
  const followUpChars = Number(options.followUpChars ?? DEFAULT_FOLLOW_UP_CHARS)
  const autoTiers = TIERS.filter(t => RANK[t] <= RANK[maxAuto])

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lastAnswered = undefined

    if (learnModels) {
      const stored = validLearned(await $.store.get(LEARNED_KEY).catch(() => undefined))
      for (const tier of TIERS) {
        const id = stored[tier]
        // Only above what this build knows: an update that ships newer ids wins over a stale store.
        if (id !== undefined && !pinnedIds.has(tier) && newerModel(models[tier], id) !== undefined) {
          models[tier] = id
          learned.add(tier)
        }
      }
      await saveLearned($, learned, models)
    }

    await $.tool.register({
      name: 'set_tier',
      description:
        'Switch the model and/or the reasoning effort that run the rest of this task: ' +
        (autoTiers.includes('fable')
          ? 'fable for exceptionally hard problems (novel research, deep design across many systems, or where opus already failed); '
          : '') +
        'opus for design, debugging and multi-file reasoning; sonnet for routine implementation; ' +
        'haiku for lookups, formatting and mechanical edits. Effort: low for quick answers, ' +
        'medium for ordinary work, high for careful reasoning, xhigh for hard investigations, ' +
        'max only when nothing less will do. Call it when the classifier\'s pick is clearly too ' +
        'weak or wasteful for the work ahead. Takes effect from the next model request.',
      inputSchema: {
        type: 'object',
        properties: {
          tier: { type: 'string', enum: autoTiers },
          effort: { type: 'string', enum: EFFORTS },
          reason: { type: 'string', description: 'One line on why' },
        },
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'tier',
      description: 'Pin the model tier (fable|opus|sonnet|haiku) or effort, return to auto routing, summarize the log (stats), or eval the classifier on a prompt set',
    })

    // A fresh session starts on whatever /model is set to.
    const s = await read($, state)
    if (s === INITIAL || (s.lastInputTokens === 0 && s.source === 'auto')) {
      const tier = tierOf(await $.session.model())
      if (tier) await update($, state, v => ({ ...v, tier }))
    }
    // Loaded into a running session: its context is already large and cached.
    const { context } = await $.session.usage()
    const tokens = context.tokens ?? 0
    if (tokens > 0) await update($, state, v => ({ ...v, lastInputTokens: Math.max(v.lastInputTokens, tokens) }))
    await show($, await read($, state), enabled)
    return started
  })

  // A piece never outlives its session: cleared at its end, by the ending id.
  on('session.end', async ($, e, next) => {
    await segment($, '', e.sessionId)
    return next(e)
  })

  on('command.run', { command: 'tier' }, async ($, e) => {
    const raw = e.args.trim()
    // Only the path keeps its case.
    if (/^eval(\s|$)/i.test(raw)) {
      return { text: await evalCommand($, raw.slice('eval'.length).trim(), { model: classifierModel, productionTimeoutMs: classifierTimeoutMs }) }
    }
    if (/^stats(\s|$)/i.test(raw)) return { text: await statsCommand($, raw.slice('stats'.length).trim()) }
    const arg = raw.toLowerCase()
    if (arg === '') {
      const s = await read($, state)
      return { text: `tier: ${label(s)}` }
    }
    if (arg === 'models') {
      const how = (t: Tier) => (pinnedIds.has(t) ? 'tierModels option' : learned.has(t) ? 'learned from an answer' : 'built in')
      return { text: TIERS.slice().reverse().map(t => `${t}: ${models[t]} (${how(t)})`).join('\n') + (learnModels ? '' : '\nlearnModels is off.') }
    }
    if (arg.startsWith('effort')) {
      const level = arg.slice('effort'.length).trim()
      if (level === 'auto') {
        const s = await update($, state, (v): TierState => ({ ...v, effortSource: 'auto', pendingEffortDown: undefined, pendingEffortCount: 0 }))
        void show($, s, enabled)
        return { text: 'Effort follows the classifier again from the next prompt.' }
      }
      if (!isEffort(level)) return { text: 'Usage: /tier effort [auto|low|medium|high|xhigh|max]' }
      const s = await update($, state, (v): TierState => ({ ...v, effort: level, effortSource: 'pinned', pendingEffortDown: undefined, pendingEffortCount: 0 }))
      void show($, s, enabled)
      return { text: `Effort pinned to ${level}. /tier effort auto to release.` }
    }
    if (arg === 'auto') {
      const s = await update($, state, (v): TierState => ({ ...v, source: 'auto', pendingDown: undefined, pendingCount: 0 }))
      void show($, s, enabled)
      return { text: `Auto routing on; tier stays ${s.tier} until the next prompt.` }
    }
    if (!isTierName(arg)) return { text: 'Usage: /tier [auto|fable|opus|sonnet|haiku] | /tier effort [auto|low|medium|high|xhigh|max] | /tier models | /tier stats [days] | /tier eval [path.jsonl]' }
    const s = await update($, state, (v): TierState => ({ ...v, tier: arg, source: 'pinned', pendingDown: undefined, pendingCount: 0 }))
    void show($, s, enabled)
    return { text: `Pinned to ${arg}. /tier auto to release.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!enabled || e.isMeta || e.command !== undefined || e.text.trim() === '') return next(e)
    const current = await read($, state)
    let s = current
    const wantTier = canTierChange(current, decideOptions, maxAuto)
    const wantEffort = routeEffort && current.effortSource !== 'pinned'
    const seq = ++promptSeq
    const followUp = isFollowUp(e.text, followUpChars)
    // While the classifier is slower than the bound (measured: whole sessions
    // at ~21 s a call), waiting only delays the prompt; the label still lands
    // late, for the rest of the turn.
    const waited = !classifierSlow
    const labels = await labelPrompt($, e.text, { model: classifierModel, timeoutMs: waited ? classifierTimeoutMs : 0, maxAuto, wantTier, wantEffort })
    if (labels.tierTimedOut || labels.effortTimedOut) void applyLate($, labels, seq, waited, { decideOptions, timeoutMs: classifierTimeoutMs, enabled, wantTier, followUp }).catch(() => undefined)
    else classifierSlow = false
    const proposed = labels.tier
    const effort = labels.effort
    if (proposed) s = await update($, state, v => decide(v, proposed, decideOptions, followUp))
    if (effort) s = await update($, state, v => decideEffort(v, effort, decideOptions, followUp))
    const kept = { tier: s.tier, effort: s.effort ?? null }
    if (waited && labels.tierTimedOut) await appendLog($, { event: 'classifier-timeout', classifier: 'tier', ranMs: classifierTimeoutMs, kept })
    if (waited && labels.effortTimedOut) await appendLog($, { event: 'classifier-timeout', classifier: 'effort', ranMs: classifierTimeoutMs, kept })
    if (wantTier || wantEffort) {
      const timedOut = labels.tierTimedOut || labels.effortTimedOut
      // In time, both answers are in and `settled` holds their latency.
      const ms = timedOut ? null : (await labels.settled).ms
      void appendLog($, {
        event: 'prompt',
        tier: s.tier,
        effort: s.effort ?? null,
        from: { tier: current.tier, effort: current.effort ?? null },
        verdict: { tier: proposed ?? null, effort: effort ?? null },
        wantTier,
        followUp,
        waited,
        timedOut,
        ms,
        tokens: current.lastInputTokens,
      })
    }
    void show($, s, enabled)
    // The note asks the model to review the pick. Measured with inkblot on
    // 2026-10-29: 0 of 6 set_tier calls when the pick stood. So it speaks only
    // when there is news: the first turn, a changed pick, or a pick that may
    // be wrong (a classifier timed out, or its verdict was held back: a
    // downgrade waiting for more turns, or the haiku context guard).
    const pick = `${s.tier}·${s.effort ?? ''}`
    // A short follow-up held below the pick is the rule working, not doubt.
    const uncertain =
      labels.tierTimedOut ||
      labels.effortTimedOut ||
      (!followUp && proposed !== undefined && proposed !== s.tier) ||
      (!followUp && effort !== undefined && effort !== s.effort)
    if (!noteDue(s.notedPick, pick, uncertain)) return next(e)
    s = await update($, state, v => ({ ...v, notedPick: pick }))
    const effortPart = s.effort ? ` with ${s.effort} effort (${s.effortSource})` : ''
    const note =
      `[model-tier] This turn runs on ${s.tier} (${s.source})${effortPart}. Review that pick against the work ahead: ` +
      `if it clearly needs a stronger model or more effort, or allows a cheaper model or less, call ${SET_TIER} with tier and/or effort.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__model-tier__set_tier' }, async ($, e) => {
    const input = e as unknown as { tier?: unknown; effort?: unknown; reason?: unknown }
    if (input.tier !== undefined && !isTierName(input.tier)) return { deny: `tier must be one of ${autoTiers.join(', ')}` }
    if (input.effort !== undefined && !isEffort(input.effort)) return { deny: 'effort must be one of low, medium, high, xhigh, max' }
    if (input.tier === undefined && input.effort === undefined) return { deny: 'give tier, effort or both' }
    // Above the cap only the person may go (/tier): keep the tier, still apply the effort.
    const refused = input.tier !== undefined && !autoTiers.includes(input.tier as Tier) ? (input.tier as Tier) : undefined
    const tier = refused ? undefined : (input.tier as Tier | undefined)
    const effort = input.effort as Effort | undefined
    const s = await update($, state, (v): TierState => {
      let next = v
      if (tier !== undefined && v.source !== 'pinned') next = { ...next, tier, source: 'model', pendingDown: undefined, pendingCount: 0 }
      if (effort !== undefined && v.effortSource !== 'pinned') next = { ...next, effort, effortSource: 'model', pendingEffortDown: undefined, pendingEffortCount: 0 }
      return next
    })
    void show($, s, enabled)
    const parts: string[] = []
    if (refused) parts.push(`${refused} is above the auto tier cap (${maxAuto}); only the person can pick it with /tier ${refused}. The tier stays ${s.tier}.`)
    if (tier !== undefined) parts.push(s.source === 'pinned' ? `The person pinned ${s.tier} with /tier; it stays.` : `Switched to ${tier} from the next request.`)
    if (effort !== undefined) parts.push(s.effortSource === 'pinned' ? `The person pinned ${s.effort} effort with /tier effort; it stays.` : `Effort ${effort} from the next request.`)
    return { result: parts.join(' ') }
  }).catch(() => ({ deny: 'model-tier: set_tier failed; the tier is unchanged.' }))

  on('turn.step', async function* ($, e, next) {
    if (!enabled || e.agentId !== undefined) return yield* next(e)
    const s = await read($, state)
    // switched when the tier's model differs from the engine's.
    // The provider that answered most recently leads: cc-router's codex or
    // ollama fallback leaves `e.model` naming the engine's Claude, so e.model
    // itself cannot be read for it. On anthropic the tier's claude id goes;
    // on another provider the id in `providerTierModels` (openai → codex /
    // default), or the engine's own model where the map names none.
    const provider = s.lastProvider ?? providerOf(e.model)
    const sendModel = provider === 'anthropic' ? models[s.tier] : (providers[provider]?.[s.tier] ?? e.model)
    const switching = sendModel !== e.model
    // A model that takes no effort reads `effort` absent: nothing to rewrite there.
    const reEffort = s.effort !== undefined && e.effort !== undefined && e.effort !== s.effort
    const stream = next({ ...e, ...(switching ? { model: sendModel } : {}), ...(reEffort ? { effort: s.effort } : {}) })

    let yielded = false
    let result
    try {
      while (true) {
        const step = await stream.next()
        if (step.done) {
          result = step.value
          break
        }
        yielded = true
        yield step.value
      }
    } catch (err) {
      // Refused before anything streamed: retry on the session's own model.
      if (sendModel === e.model || yielded) throw err
      $.ui.toast(`model-tier: ${sendModel} was refused, staying on ${e.model}`)
      // An id learned from an answer that the API now refuses goes back to the built-in one.
      if (learned.has(s.tier) && sendModel === models[s.tier]) {
        const back = DEFAULT_TIER_MODELS[s.tier]
        refusedIds.add(sendModel)
        models[s.tier] = back
        learned.delete(s.tier)
        void saveLearned($, learned, models)
        void appendLog($, { event: 'unlearn', tier: s.tier, from: sendModel, to: back })
      }
      result = yield* next(e)
    }

    const u = result.usage
    if (u) {
      const newer = learnModels && !pinnedIds.has(s.tier) ? newerModel(models[s.tier], u.model) : undefined
      if (newer !== undefined && !refusedIds.has(newer) && tierOf(newer) === s.tier) {
        const from = models[s.tier]
        models[s.tier] = newer
        learned.add(s.tier)
        void saveLearned($, learned, models)
        void appendLog($, { event: 'learn', tier: s.tier, from, to: newer })
        $.ui.toast(`model-tier: ${newer} answered, so ${s.tier} goes as ${newer} now (was ${from})`)
      }
      const tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const provider = providerOf(u.model)
      const move = s.lastProvider !== undefined && s.lastProvider !== provider
      if (move) {
        const target = providers[provider]?.[s.tier]
        // The router moved the session between providers: anthropic quota out
        // or back. codex keeps the tier's map; a provider with no map keeps
        // whatever model answered.
        $.ui.toast(`model-tier: answered on ${u.model} (${provider})${target !== undefined ? `; ${s.tier} goes as ${target} there now` : '; the tier stays whatever this provider answers'}`)
      }
      await update($, state, v => ({ ...v, lastInputTokens: tokens, lastProvider: provider }))
      if (lastAnswered !== undefined && lastAnswered !== u.model) void appendLog($, { event: 'switch', from: lastAnswered, to: u.model, tokens })
      lastAnswered = u.model
      const byModel = turnUsage.get(e.turnId) ?? {}
      const t = (byModel[u.model] ??= { requests: 0, promptTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
      t.requests++
      t.promptTokens += tokens
      t.cacheWriteTokens += u.cache_creation_input_tokens
      t.outputTokens += u.output_tokens
      turnUsage.set(e.turnId, byModel)
    }
    return result
  })

  // One line per finished main-loop turn: what each model answered in it.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const models = turnUsage.get(e.turnId)
      turnUsage.delete(e.turnId)
      if (models !== undefined) void appendLog($, { event: 'turn', models })
    }
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    if (!enabled || e.fork || e.model !== undefined || !routable.has(e.subagentType)) return next(e)
    const { tier, tierTimedOut, settled } = await labelPrompt($, e.prompt, { model: classifierModel, timeoutMs: classifierTimeoutMs, maxAuto, wantTier: true, wantEffort: false })
    if (tierTimedOut) {
      const s = await read($, state)
      await appendLog($, { event: 'classifier-timeout', classifier: 'subagent', ranMs: classifierTimeoutMs, kept: { tier: s.tier, effort: s.effort ?? null } })
    }
    void appendLog($, { event: 'spawn', agent: e.subagentType, tier: tier ?? null, timedOut: tierTimedOut, ms: tierTimedOut ? null : (await settled).ms })
    return next(tier ? { ...e, model: models[tier] } : e)
  }).catch(($, e, next) => next(e))
}
