import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, Tier, TierState } from '../types'
import { segment } from './segment'

const PLUGIN = 'model-tier'
const SET_TIER = `mcp__${PLUGIN}__set_tier`
const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']
const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
const isTierName = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
// The highest tier anything but the person picks: the classifier, subagent
// routing and the model's own set_tier. Fable has its own, tighter rate limit
// on Claude Teams, so by default only /tier fable reaches it.
export const DEFAULT_MAX_AUTO_TIER: Tier = 'opus'
export const maxAutoTier = (v: unknown): Tier => (isTierName(v) ? v : DEFAULT_MAX_AUTO_TIER)
export const capTier = (t: Tier, max: Tier): Tier => (RANK[t] > RANK[max] ? max : t)
// The top label names a rare case outright: label names steer the classifier
// (see EFFORT_LABELS), and fable is the scarcest, most rate-limited tier. The
// label set stays the same under a lower `maxAutoTier`, so the other three
// labels classify as before; only the tier it maps to is capped.
const LABELS = ['trivial', 'standard', 'complex', 'exceptionally-hard'] as const
const LABEL_TIER: Record<(typeof LABELS)[number], Tier> = {
  trivial: 'haiku',
  standard: 'sonnet',
  complex: 'opus',
  'exceptionally-hard': 'fable',
}
// How much thinking the prompt needs, as the classifier names it. `max` is never
// proposed: only the model (set_tier) or the person (/tier effort) asks for it.
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
// Named for how hard the problem is to think through, not how long the answer
// is: measured live, 'quick-answer' caught a hard design question that asked
// for a three-line reply.
const EFFORT_LABELS = ['recall-or-lookup', 'routine-reasoning', 'tricky-problem', 'hard-open-problem'] as const
const LABEL_EFFORT: Record<(typeof EFFORT_LABELS)[number], Effort> = {
  'recall-or-lookup': 'low',
  'routine-reasoning': 'medium',
  'tricky-problem': 'high',
  'hard-open-problem': 'xhigh',
}
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
const ROUTABLE_AGENTS = new Set(['general-purpose', 'claude'])
const CLASSIFY_CHARS = 4000

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

/**
 * Folds one classifier verdict into the state. Upgrades apply at once;
 * downgrades wait for `downgradeAfterTurns` consecutive lower verdicts, since
 * every model switch re-bills the conversation prefix outside the prompt cache.
 */
export function decide(s: TierState, proposed: Tier, o: DecideOptions): TierState {
  if (s.source === 'pinned') return s
  let target = proposed
  if (target === 'haiku' && s.lastInputTokens > o.maxTokensForHaiku) target = 'sonnet'

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
 * Folds one effort verdict into the state, the way `decide` folds a tier:
 * more effort at once, less only after `downgradeAfterTurns` lower verdicts in
 * a row (a request's thinking setting is part of what the prompt cache keys on).
 */
export function decideEffort(s: TierState, proposed: Effort, o: DecideOptions): TierState {
  if (s.effortSource === 'pinned') return s
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

// A classifier's answer, or the timeout that beat it.
type Labelled<T> = { value: T | undefined; timedOut: boolean }

const TIMED_OUT = Symbol('timed out')

/** The first of `labelled` and a `timeoutMs` sleep, so a slow classifier never holds the prompt. */
async function within<T>($: EngineInterface, labelled: Promise<T | undefined>, timeoutMs: number): Promise<Labelled<T>> {
  const stop = new AbortController()
  // A sleep that fails or is aborted never wins the race: only a real timeout does.
  const timeout = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(
    () => TIMED_OUT,
    () => new Promise<typeof TIMED_OUT>(() => {}),
  )
  try {
    const got = await Promise.race([labelled, timeout])
    return got === TIMED_OUT ? { value: undefined, timedOut: true } : { value: got, timedOut: false }
  } finally {
    stop.abort()
  }
}

/** Labels `text` with a tier, capped at `max`. */
function classify($: EngineInterface, text: string, model: string, timeoutMs: number, max: Tier): Promise<Labelled<Tier>> {
  const labelled = $.model.classify(text.slice(0, CLASSIFY_CHARS), LABELS, { model }).then(label =>
    label === undefined || !(label in LABEL_TIER) ? undefined : capTier(LABEL_TIER[label as (typeof LABELS)[number]], max),
  )
  return within($, labelled, timeoutMs)
}

/** The effort a prompt needs; undefined for a label outside the set. */
function classifyEffort($: EngineInterface, text: string, model: string, timeoutMs: number): Promise<Labelled<Effort>> {
  const labelled = $.model.classify(text.slice(0, CLASSIFY_CHARS), EFFORT_LABELS, { model }).then(found =>
    found !== undefined && found in LABEL_EFFORT ? LABEL_EFFORT[found as (typeof EFFORT_LABELS)[number]] : undefined,
  )
  return within($, labelled, timeoutMs)
}

const LOG_MAX_LINES = 500

/**
 * One JSON line per classifier timeout in ~/.claude/model-tier.log: which
 * classifier, how long it ran before it was given up on, and the tier and
 * effort the turn kept. This is the data for tuning `classifierTimeoutMs`
 * (measured once: a design prompt stayed on haiku·low after a timeout).
 */
async function logTimeout($: EngineInterface, entry: { classifier: 'tier' | 'effort' | 'subagent'; ranMs: number; kept: { tier: Tier; effort?: Effort } }): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined) return
    const path = `${home}/.claude/model-tier.log`
    let text = ''
    try {
      text = await $.fs.read(path)
    } catch {
      // First line.
    }
    const lines = text.split('\n').filter(line => line !== '')
    lines.push(JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), event: 'classifier-timeout', ...entry, kept: { tier: entry.kept.tier, effort: entry.kept.effort ?? null } }))
    await $.fs.write(path, `${lines.slice(-LOG_MAX_LINES).join('\n')}\n`)
  } catch {
    // A log line is never worth failing a prompt over.
  }
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
  const classifierTimeoutMs = Number(options.classifierTimeoutMs ?? 3000)
  const providers = providerTierModels(options.providerTierModels)
  const routeEffort = options.routeEffort !== false
  const maxAuto = maxAutoTier(options.maxAutoTier)
  const autoTiers = TIERS.filter(t => RANK[t] <= RANK[maxAuto])

  on('session.start', async ($, e, next) => {
    const started = await next(e)

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
      description: 'Pin the model tier (fable|opus|sonnet|haiku) or effort, or return to auto routing',
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
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      const s = await read($, state)
      return { text: `tier: ${label(s)}` }
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
    if (!isTierName(arg)) return { text: 'Usage: /tier [auto|fable|opus|sonnet|haiku] | /tier effort [auto|low|medium|high|xhigh|max]' }
    const s = await update($, state, (v): TierState => ({ ...v, tier: arg, source: 'pinned', pendingDown: undefined, pendingCount: 0 }))
    void show($, s, enabled)
    return { text: `Pinned to ${arg}. /tier auto to release.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!enabled || e.isMeta || e.command !== undefined || e.text.trim() === '') return next(e)
    const current = await read($, state)
    let s = current
    const wantTier = current.source !== 'pinned'
    const wantEffort = routeEffort && current.effortSource !== 'pinned'
    const [tierLabel, effortLabel] = await Promise.all([
      wantTier ? classify($, e.text, classifierModel, classifierTimeoutMs, maxAuto).catch(() => undefined) : undefined,
      wantEffort ? classifyEffort($, e.text, classifierModel, classifierTimeoutMs).catch(() => undefined) : undefined,
    ])
    const proposed = tierLabel?.value
    const effort = effortLabel?.value
    if (proposed) s = await update($, state, v => decide(v, proposed, decideOptions))
    if (effort) s = await update($, state, v => decideEffort(v, effort, decideOptions))
    const kept = { tier: s.tier, effort: s.effort }
    if (tierLabel?.timedOut) await logTimeout($, { classifier: 'tier', ranMs: classifierTimeoutMs, kept })
    if (effortLabel?.timedOut) await logTimeout($, { classifier: 'effort', ranMs: classifierTimeoutMs, kept })
    void show($, s, enabled)
    // The note asks the model to review the pick. Measured with inkblot on
    // 2026-10-29: 0 of 6 set_tier calls when the pick stood. So it speaks only
    // when there is news: the first turn, a changed pick, or a pick that may
    // be wrong (a classifier timed out, or its verdict was held back: a
    // downgrade waiting for more turns, or the haiku context guard).
    const pick = `${s.tier}·${s.effort ?? ''}`
    const uncertain =
      tierLabel?.timedOut === true ||
      effortLabel?.timedOut === true ||
      (proposed !== undefined && proposed !== s.tier) ||
      (effort !== undefined && effort !== s.effort)
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
      result = yield* next(e)
    }

    const u = result.usage
    if (u) {
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
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    if (!enabled || e.fork || e.model !== undefined || !ROUTABLE_AGENTS.has(e.subagentType)) return next(e)
    const labelled = await classify($, e.prompt, classifierModel, classifierTimeoutMs, maxAuto).catch(() => undefined)
    const tier = labelled?.value
    if (labelled?.timedOut) {
      const s = await read($, state)
      await logTimeout($, { classifier: 'subagent', ranMs: classifierTimeoutMs, kept: { tier: s.tier, effort: s.effort } })
    }
    return next(tier ? { ...e, model: models[tier] } : e)
  }).catch(($, e, next) => next(e))
}
