import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Tier, TierState } from '../types'

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
}

// Change the tag when TierState's fields change: it declines an older value.
const state = atom({ plugin: 'model-tier', key: 'tier' } as const, INITIAL, {
  shape: 'tier-1',
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

/** Whether a resolved model id (`claude-opus-5-5[1m]`) is the given tier. */
export function isTier(model: string, tier: Tier): boolean {
  return model === tier || model.toLowerCase().includes(tier)
}

export function tierOf(model: string): Tier | undefined {
  return TIERS.find(t => isTier(model, t))
}

const isTierName = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)

function show($: EngineInterface, s: TierState, enabled: boolean) {
  $.ui.status(enabled ? `tier: ${s.tier} (${s.source})` : undefined)
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

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.tool.register({
      name: 'set_tier',
      description:
        'Switch the model that runs the rest of this task: opus for design, ' +
        'debugging and multi-file reasoning; sonnet for routine implementation; ' +
        'haiku for lookups, formatting and mechanical edits. Call it when the ' +
        'current tier is clearly too weak or wasteful for the work ahead. ' +
        'Takes effect from the next model request.',
      inputSchema: {
        type: 'object',
        properties: {
          tier: { type: 'string', enum: TIERS },
          reason: { type: 'string', description: 'One line on why' },
        },
        required: ['tier'],
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
      return { text: `tier: ${s.tier} (${s.source})` }
    }
    if (arg === 'auto') {
      const s = await update($, state, (v): TierState => ({ ...v, source: 'auto', pendingDown: undefined, pendingCount: 0 }))
      show($, s, enabled)
      return { text: `Auto routing on; tier stays ${s.tier} until the next prompt.` }
    }
    if (!isTierName(arg)) return { text: 'Usage: /tier [auto|opus|sonnet|haiku]' }
    const s = await update($, state, (v): TierState => ({ ...v, tier: arg, source: 'pinned', pendingDown: undefined, pendingCount: 0 }))
    show($, s, enabled)
    return { text: `Pinned to ${arg}. /tier auto to release.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!enabled || e.isMeta || e.command !== undefined || e.text.trim() === '') return next(e)
    const current = await read($, state)
    let s = current
    if (current.source !== 'pinned') {
      const proposed = await classify($, e.text, classifierModel, classifierTimeoutMs).catch(() => undefined)
      if (proposed) s = await update($, state, v => decide(v, proposed, decideOptions))
    }
    show($, s, enabled)
    const note =
      `[model-tier] This turn runs on ${s.tier} (${s.source}). If the work ahead ` +
      `clearly needs a stronger or allows a cheaper model, call ${SET_TIER}.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__model-tier__set_tier' }, async ($, e) => {
    const input = e as unknown as { tier?: unknown; reason?: unknown }
    if (!isTierName(input.tier)) return { deny: 'tier must be one of opus, sonnet, haiku' }
    const tier = input.tier
    const s = await update($, state, (v): TierState =>
      v.source === 'pinned' ? v : { ...v, tier, source: 'model', pendingDown: undefined, pendingCount: 0 },
    )
    show($, s, enabled)
    const text =
      s.source === 'pinned'
        ? `The person pinned ${s.tier} with /tier; it stays.`
        : `Switched to ${tier} from the next request.`
    return { result: text }
  }).catch(() => ({ deny: 'model-tier: set_tier failed; the tier is unchanged.' }))

  on('turn.step', async function* ($, e, next) {
    if (!enabled || e.agentId !== undefined) return yield* next(e)
    const s = await read($, state)
    const switching = !isTier(e.model, s.tier)
    const stream = next(switching ? { ...e, model: models[s.tier] } : e)

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
