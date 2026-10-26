import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, Tier, TierState } from '../types'
import { segment } from './segment'

const PLUGIN = 'model-tier'
const SET_TIER = `mcp__${PLUGIN}__set_tier`
const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']
const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 }
const LABELS = ['trivial', 'standard', 'complex'] as const
const LABEL_TIER: Record<(typeof LABELS)[number], Tier> = {
  trivial: 'haiku',
  standard: 'sonnet',
  complex: 'opus',
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
// Subagent types that carry no model of their own; others keep their definition's.
const ROUTABLE_AGENTS = new Set(['general-purpose', 'claude'])
const CLASSIFY_CHARS = 4000

// Full model ids per tier. A request built here goes to the API as written:
// unlike /model or --model, an alias ('sonnet') is not resolved, and a router
// in ANTHROPIC_BASE_URL answers it 404, which the engine then papers over with
// fallbackModel ("Switched to Opus 5 because sonnet is not available").
export const DEFAULT_TIER_MODELS: Record<Tier, string> = {
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
    if ((tier === 'opus' || tier === 'sonnet' || tier === 'haiku') && id) models[tier] = id
  }
  return models
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

export function tierOf(model: string): Tier | undefined {
  return TIERS.find(t => isTier(model, t))
}

const isTierName = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)

const label = (s: TierState) => `${s.tier}${s.effort ? `·${s.effort}` : ''} (${s.source === s.effortSource || s.effort === undefined ? s.source : `${s.source}/${s.effortSource}`})`

// The tier rides the person's status line; nothing about it needs a notice row.
function show($: EngineInterface, s: TierState, enabled: boolean) {
  const pinned = s.source === 'pinned' || s.effortSource === 'pinned'
  // A row an earlier version pinned outlives a reload: take it down.
  $.ui.status(undefined)
  void segment($, enabled ? `${s.tier}${s.effort ? `·${s.effort}` : ''}${pinned ? ' (pin)' : ''}` : '')
}

/** Labels `text`, or gives up after `timeoutMs` so a slow classifier never holds the prompt. */
async function classify($: EngineInterface, text: string, model: string, timeoutMs: number): Promise<Tier | undefined> {
  const stop = new AbortController()
  // A sleep that fails or is aborted never wins the race: only a real timeout does.
  const timeout = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(
    () => undefined,
    () => new Promise<undefined>(() => {}),
  )
  const labelled = $.model.classify(text.slice(0, CLASSIFY_CHARS), LABELS, { model }).then(label =>
    label === undefined ? undefined : LABEL_TIER[label as (typeof LABELS)[number]],
  )
  try {
    return await Promise.race([labelled, timeout])
  } finally {
    stop.abort()
  }
}

/** The effort a prompt needs, or undefined on a timeout or a label outside the set. */
async function classifyEffort($: EngineInterface, text: string, model: string, timeoutMs: number): Promise<Effort | undefined> {
  const stop = new AbortController()
  const timeout = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(
    () => undefined,
    () => new Promise<undefined>(() => {}),
  )
  const labelled = $.model.classify(text.slice(0, CLASSIFY_CHARS), EFFORT_LABELS, { model }).then(found =>
    found !== undefined && found in LABEL_EFFORT ? LABEL_EFFORT[found as (typeof EFFORT_LABELS)[number]] : undefined,
  )
  try {
    return await Promise.race([labelled, timeout])
  } finally {
    stop.abort()
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
  const routeEffort = options.routeEffort !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.tool.register({
      name: 'set_tier',
      description:
        'Switch the model and/or the reasoning effort that run the rest of this task: ' +
        'opus for design, debugging and multi-file reasoning; sonnet for routine implementation; ' +
        'haiku for lookups, formatting and mechanical edits. Effort: low for quick answers, ' +
        'medium for ordinary work, high for careful reasoning, xhigh for hard investigations, ' +
        'max only when nothing less will do. Call it when the classifier\'s pick is clearly too ' +
        'weak or wasteful for the work ahead. Takes effect from the next model request.',
      inputSchema: {
        type: 'object',
        properties: {
          tier: { type: 'string', enum: TIERS },
          effort: { type: 'string', enum: EFFORTS },
          reason: { type: 'string', description: 'One line on why' },
        },
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'tier',
      description: 'Pin the model tier (opus|sonnet|haiku) or return to auto routing',
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
    show($, await read($, state), enabled)
    return started
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
        show($, s, enabled)
        return { text: 'Effort follows the classifier again from the next prompt.' }
      }
      if (!isEffort(level)) return { text: 'Usage: /tier effort [auto|low|medium|high|xhigh|max]' }
      const s = await update($, state, (v): TierState => ({ ...v, effort: level, effortSource: 'pinned', pendingEffortDown: undefined, pendingEffortCount: 0 }))
      show($, s, enabled)
      return { text: `Effort pinned to ${level}. /tier effort auto to release.` }
    }
    if (arg === 'auto') {
      const s = await update($, state, (v): TierState => ({ ...v, source: 'auto', pendingDown: undefined, pendingCount: 0 }))
      show($, s, enabled)
      return { text: `Auto routing on; tier stays ${s.tier} until the next prompt.` }
    }
    if (!isTierName(arg)) return { text: 'Usage: /tier [auto|opus|sonnet|haiku] | /tier effort [auto|low|medium|high|xhigh|max]' }
    const s = await update($, state, (v): TierState => ({ ...v, tier: arg, source: 'pinned', pendingDown: undefined, pendingCount: 0 }))
    show($, s, enabled)
    return { text: `Pinned to ${arg}. /tier auto to release.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!enabled || e.isMeta || e.command !== undefined || e.text.trim() === '') return next(e)
    const current = await read($, state)
    let s = current
    const wantTier = current.source !== 'pinned'
    const wantEffort = routeEffort && current.effortSource !== 'pinned'
    const [proposed, effort] = await Promise.all([
      wantTier ? classify($, e.text, classifierModel, classifierTimeoutMs).catch(() => undefined) : undefined,
      wantEffort ? classifyEffort($, e.text, classifierModel, classifierTimeoutMs).catch(() => undefined) : undefined,
    ])
    if (proposed) s = await update($, state, v => decide(v, proposed, decideOptions))
    if (effort) s = await update($, state, v => decideEffort(v, effort, decideOptions))
    show($, s, enabled)
    const effortPart = s.effort ? ` with ${s.effort} effort (${s.effortSource})` : ''
    const note =
      `[model-tier] This turn runs on ${s.tier} (${s.source})${effortPart}. Review that pick against the work ahead: ` +
      `if it clearly needs a stronger model or more effort, or allows a cheaper model or less, call ${SET_TIER} with tier and/or effort.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__model-tier__set_tier' }, async ($, e) => {
    const input = e as unknown as { tier?: unknown; effort?: unknown; reason?: unknown }
    if (input.tier !== undefined && !isTierName(input.tier)) return { deny: 'tier must be one of opus, sonnet, haiku' }
    if (input.effort !== undefined && !isEffort(input.effort)) return { deny: 'effort must be one of low, medium, high, xhigh, max' }
    if (input.tier === undefined && input.effort === undefined) return { deny: 'give tier, effort or both' }
    const tier = input.tier as Tier | undefined
    const effort = input.effort as Effort | undefined
    const s = await update($, state, (v): TierState => {
      let next = v
      if (tier !== undefined && v.source !== 'pinned') next = { ...next, tier, source: 'model', pendingDown: undefined, pendingCount: 0 }
      if (effort !== undefined && v.effortSource !== 'pinned') next = { ...next, effort, effortSource: 'model', pendingEffortDown: undefined, pendingEffortCount: 0 }
      return next
    })
    show($, s, enabled)
    const parts: string[] = []
    if (tier !== undefined) parts.push(s.source === 'pinned' ? `The person pinned ${s.tier} with /tier; it stays.` : `Switched to ${tier} from the next request.`)
    if (effort !== undefined) parts.push(s.effortSource === 'pinned' ? `The person pinned ${s.effort} effort with /tier effort; it stays.` : `Effort ${effort} from the next request.`)
    return { result: parts.join(' ') }
  }).catch(() => ({ deny: 'model-tier: set_tier failed; the tier is unchanged.' }))

  on('turn.step', async function* ($, e, next) {
    if (!enabled || e.agentId !== undefined) return yield* next(e)
    const s = await read($, state)
    const switching = !isTier(e.model, s.tier)
    // A model that takes no effort reads `effort` absent: nothing to rewrite there.
    const reEffort = s.effort !== undefined && e.effort !== undefined && e.effort !== s.effort
    const stream = next({ ...e, ...(switching ? { model: models[s.tier] } : {}), ...(reEffort ? { effort: s.effort } : {}) })

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
      if (!switching || yielded) throw err
      $.ui.toast(`model-tier: ${models[s.tier]} was refused, staying on ${e.model}`)
      result = yield* next(e)
    }

    const u = result.usage
    if (u) {
      const tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, state, v => ({ ...v, lastInputTokens: tokens }))
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    if (!enabled || e.fork || e.model !== undefined || !ROUTABLE_AGENTS.has(e.subagentType)) return next(e)
    const tier = await classify($, e.prompt, classifierModel, classifierTimeoutMs).catch(() => undefined)
    return next(tier ? { ...e, model: models[tier] } : e)
  }).catch(($, e, next) => next(e))
}
