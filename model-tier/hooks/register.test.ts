import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, HookStream, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import type { TierState } from '../types'
import { capTier, decide, decideEffort, INITIAL, isTier, maxAutoTier, modelFor, providerOf, providerTierModels, tierModels } from './register'

const OPTS = { downgradeAfterTurns: 2, maxTokensForHaiku: 150000, maxTokensForDowngrade: 200000 }
const at = (over: Partial<TierState>): TierState => ({ ...INITIAL, ...over })

const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }
const SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_1',
  prompt: 'find the config file',
  description: 'find config',
  subagentType: 'general-purpose',
  provider: { plugin: 'core', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
}
const answered = (e: TurnStepInput, tokens = 1000, answeredModel?: string): TurnStepResult => ({
  turnId: e.turnId,
  index: e.index,
  answer: 'ok',
  toolUses: [],
  stopReason: 'end_turn',
  usage: {
    model: answeredModel ?? e.model,
    input_tokens: tokens,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
})

// A step's result settles only once its stream has been read to the end.
async function drain(stream: HookStream<TurnStepChunk, TurnStepResult>) {
  for (;;) {
    const r = await stream.next()
    if (r.done) return r.value
  }
}

describe('decide', () => {
  test('upgrades at once', () => {
    expect(decide(at({ tier: 'haiku' }), 'opus', OPTS).tier).toBe('opus')
  })

  test('steps down at once before any request was sent', () => {
    expect(decide(at({ tier: 'opus' }), 'haiku', OPTS).tier).toBe('haiku')
  })

  test('downgrades only after consecutive lower verdicts', () => {
    const once = decide(at({ tier: 'opus', lastInputTokens: 5000 }), 'sonnet', OPTS)
    expect(once.tier).toBe('opus')
    expect(once.pendingCount).toBe(1)
    const twice = decide(once, 'sonnet', OPTS)
    expect(twice.tier).toBe('sonnet')
    expect(twice.pendingCount).toBe(0)
  })

  test('a same-tier verdict between lower ones resets the count', () => {
    const once = decide(at({ tier: 'opus', lastInputTokens: 5000 }), 'sonnet', OPTS)
    const reset = decide(once, 'opus', OPTS)
    expect(decide(reset, 'sonnet', OPTS).tier).toBe('opus')
  })

  test('a large context never drops to haiku', () => {
    const big = at({ tier: 'sonnet', lastInputTokens: 200000 })
    const s = decide(decide(big, 'haiku', OPTS), 'haiku', OPTS)
    expect(s.tier).toBe('sonnet')
  })

  test('a context past the downgrade ceiling never steps down', () => {
    const big = at({ tier: 'opus', lastInputTokens: 600000 })
    expect(decide(decide(big, 'sonnet', OPTS), 'sonnet', OPTS).tier).toBe('opus')
    expect(decide(big, 'opus', OPTS).tier).toBe('opus')
  })

  test('a large context still upgrades', () => {
    expect(decide(at({ tier: 'sonnet', lastInputTokens: 600000 }), 'opus', OPTS).tier).toBe('opus')
  })

  test('a pinned tier ignores the classifier', () => {
    expect(decide(at({ tier: 'haiku', source: 'pinned' }), 'opus', OPTS).tier).toBe('haiku')
  })

  test('tiers map to full ids, fable included, overridable per tier', () => {
    expect(tierModels(undefined).fable).toBe('claude-fable-5-1')
    expect(tierModels('fable=claude-fable-5').fable).toBe('claude-fable-5')
    expect(tierModels(undefined).sonnet).toBe('claude-sonnet-5-5')
    expect(tierModels('sonnet=claude-sonnet-5, bogus=x').sonnet).toBe('claude-sonnet-5')
    expect(tierModels('sonnet=claude-sonnet-5').haiku).toBe('claude-haiku-5-5')
  })

  test('isTier reads resolved ids', () => {
    expect(isTier('claude-opus-5-5[1m]', 'opus')).toBe(true)
    expect(isTier('claude-haiku-5-5', 'sonnet')).toBe(false)
  })
})

describe('maxAutoTier', () => {
  test('defaults to opus, and a bad value falls back to it', () => {
    expect(maxAutoTier(undefined)).toBe('opus')
    expect(maxAutoTier('ultra')).toBe('opus')
    expect(maxAutoTier('fable')).toBe('fable')
  })

  test('caps a verdict above it and leaves the rest alone', () => {
    expect(capTier('fable', 'opus')).toBe('opus')
    expect(capTier('opus', 'opus')).toBe('opus')
    expect(capTier('haiku', 'opus')).toBe('haiku')
    expect(capTier('fable', 'fable')).toBe('fable')
    expect(capTier('opus', 'sonnet')).toBe('sonnet')
  })
})

describe('decideEffort', () => {
  test('more effort at once; less only after consecutive lower verdicts', () => {
    const sent = at({ lastInputTokens: 5000, effort: 'high' })
    expect(decideEffort(sent, 'xhigh', OPTS).effort).toBe('xhigh')
    const once = decideEffort(sent, 'low', OPTS)
    expect(once.effort).toBe('high')
    expect(decideEffort(once, 'low', OPTS).effort).toBe('low')
  })
  test('nothing sent yet: the first verdict applies, down included', () => {
    expect(decideEffort(at({ effort: 'high' }), 'low', OPTS).effort).toBe('low')
  })
  test('a pinned effort ignores the classifier', () => {
    expect(decideEffort(at({ effort: 'max', effortSource: 'pinned' }), 'low', OPTS).effort).toBe('max')
  })
})

describe('providers (the router answering on codex or ollama)', () => {
  test('providerOf reads the answering model', () => {
    expect(providerOf('claude-opus-5-5')).toBe('anthropic')
    expect(providerOf('gpt-6.1-sol')).toBe('openai')
    expect(providerOf('codex')).toBe('openai')
    expect(providerOf('qwen3:8b')).toBe('unknown')
    expect(providerOf('anthropic/claude-haiku-5-5')).toBe('anthropic')
  })
  test('modelFor maps the tier per provider and leaves what no map names', () => {
    const providers = providerTierModels(undefined)
    expect(modelFor('claude-opus-5-5', 'fable', 'claude-fable-5-1', providers)).toBe('claude-fable-5-1')
    expect(modelFor('x', 'opus', 'claude-opus-5-5', providers)).toBe('claude-opus-5-5')
    expect(modelFor('openai/x', 'opus', 'claude-opus-5-5', providers)).toBe('codex')
    expect(modelFor('openai/x', 'sonnet', 'claude-sonnet-5-5', providers)).toBe('default')
    expect(modelFor('ollama/x', 'opus', 'claude-opus-5-5', providers)).toBe('ollama/x')
    expect(providerTierModels('openai=fable:gpt-6.1-sol').openai?.fable).toBe('gpt-6.1-sol')
  })
  test('an answer on codex turns the tier into the codex mapping; back on Claude, back to claude ids', async ($, on) => {
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    const sent: string[] = []
    // opus tier, auto, with requests sent (so start does not re-read /model).
    let seeded = false
    on('state.get', (_, e, next) => {
      const key = ((e as { key?: string }).key ?? (e as { ref?: { key?: string } }).ref?.key)
      if (key === 'tier' && !seeded) {
        seeded = true
        return { value: { value: { shape: 'tier-2', value: { ...INITIAL, tier: 'opus' as const, lastInputTokens: 1000 } }, version: 1 } } as never
      }
      return next(e)
    })
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      return answered(e, 1000, e.index === 1 ? 'gpt-6.1-sol' : e.model)
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await drain($.turn.step(STEP)) // anthropic
    await drain($.turn.step({ ...STEP, index: 1 })) // router answers on codex
    await drain($.turn.step({ ...STEP, index: 2 })) // now sent as the openai alias for haiku
    await drain($.turn.step({ ...STEP, index: 3, model: 'claude-opus-5-5' })) // engine still on Claude: the map sends sonnet? haiku→default? sent below

    expect(sent).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'codex', 'codex'])
  })
})

describe('the plugin', () => {
  test('a complex prompt sends the next request to opus', async ($, on) => {
    on('ui.status', () => ({ value: undefined }))
    on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('model.classify', () => ({ value: 'complex' }))
    let context: readonly string[] | undefined
    on('prompt.submit', (_, e) => {
      context = e.context
      return { text: e.text }
    })
    const sent: string[] = []
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      return answered(e)
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: 'Redesign the cache layer across these services', wait: false, origin: { kind: 'composer' } })
    await drain($.turn.step({ ...STEP, model: 'claude-sonnet-5-5' }))

    expect(sent).toEqual(['claude-opus-5-5'])
    expect(context?.some(c => c.includes('runs on opus'))).toBe(true)
  })

  test('set_tier switches the next request', async ($, on) => {
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('ui.status', () => ({ value: undefined }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    const sent: string[] = []
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      return answered(e)
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await drain($.turn.step(STEP))
    const r = await $.tool.call({ tool: 'mcp__model-tier__set_tier', tier: 'haiku', reason: 'rename only' })
    await drain($.turn.step({ ...STEP, index: 1 }))

    expect(r.deny).toBeUndefined()
    expect(r.result).toBe('Switched to haiku from the next request.')
    expect(sent).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
  })

  test('loaded into a large running session, a trivial prompt keeps opus', async ($, on) => {
    on('ui.status', () => ({ value: undefined }))
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({
      value: { startedAt: 0, context: { tokens: 600000, window: 1000000 }, rateLimits: [] },
    }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('model.classify', () => ({ value: 'trivial' }))
    on('clock.sleep', () => new Promise(() => {}))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    const sent: string[] = []
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      return answered(e)
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: 'thanks', wait: false, origin: { kind: 'composer' } })
    await drain($.turn.step(STEP))

    expect(sent).toEqual(['claude-opus-5-5'])
  })

  test('a slow classifier keeps the current tier', async ($, on) => {
    on('ui.status', () => ({ value: undefined }))
    on('clock.sleep', () => ({ value: undefined }))
    on('model.classify', () => new Promise(() => {}))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    const sent: string[] = []
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      return answered(e)
    })

    await $.prompt.submit({ text: 'rename x to y', wait: false, origin: { kind: 'composer' } })
    await drain($.turn.step(STEP))

    expect(sent).toEqual(['claude-opus-5-5'])
  })

  test('an untyped general-purpose subagent gets the classified tier', async ($, on) => {
    on('model.classify', () => ({ value: 'trivial' }))
    on('clock.sleep', () => new Promise(() => {}))
    let model: string | undefined
    on('agent.spawn', (_, e) => {
      model = e.model
      return { model: e.model ?? e.parentModel }
    })

    await $.agent.spawn(SPAWN)

    expect(model).toBe('claude-haiku-5-5')
  })

  test('an exceptionally hard subagent prompt runs on opus, not fable', async ($, on) => {
    on('model.classify', () => ({ value: 'exceptionally-hard' }))
    on('clock.sleep', () => new Promise(() => {}))
    let model: string | undefined
    on('agent.spawn', (_, e) => {
      model = e.model
      return { model: e.model ?? e.parentModel }
    })

    await $.agent.spawn(SPAWN)

    expect(model).toBe('claude-opus-5-5')
  })

  test('a typed subagent keeps its own model', async ($, on) => {
    on('model.classify', () => ({ value: 'trivial' }))
    let model: string | undefined = 'unset'
    on('agent.spawn', (_, e) => {
      model = e.model
      return { model: e.model ?? e.parentModel }
    })

    await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' })

    expect(model).toBeUndefined()
  })

  test('a subagent step is left alone', async ($, on) => {
    on('state.get', () => ({ value: { value: { shape: 'tier-2', value: { ...INITIAL, tier: 'haiku' } }, version: 1 } }))
    const sent: string[] = []
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      return answered(e)
    })

    await drain($.turn.step({ ...STEP, agentId: 'a1' }))

    expect(sent).toEqual(['claude-opus-5-5'])
  })

  test('a refused tier falls back to the session model', async ($, on) => {
    on('state.get', () => ({ value: { value: { shape: 'tier-2', value: { ...INITIAL, tier: 'haiku' } }, version: 1 } }))
    on('ui.toast', () => ({ value: undefined }))
    const sent: string[] = []
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      if (e.model === 'claude-haiku-5-5') throw new Error('model not allowed')
      return answered(e)
    })

    const r = await drain($.turn.step(STEP))

    expect(sent).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
    expect(r.usage?.model).toBe('claude-opus-5-5')
  })

  test('the classified effort rides the request; the model can correct it', async ($, on) => {
    on('ui.status', () => ({ value: undefined }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    // Each label set gets its own answer.
    on('model.classify', (_, e) => ({ value: (e.labels as readonly string[]).includes('complex') ? 'complex' : 'recall-or-lookup' }))
    let context: readonly string[] | undefined
    on('prompt.submit', (_, e) => {
      context = e.context
      return { text: e.text }
    })
    const sent: Array<string | number | undefined> = []
    on('turn.step', async function* (_, e) {
      sent.push(e.effort)
      return answered(e)
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: 'what does this flag do', wait: false, origin: { kind: 'composer' } })
    await drain($.turn.step({ ...STEP, effort: 'high' }))
    const r = await $.tool.call({ tool: 'mcp__model-tier__set_tier', effort: 'xhigh', reason: 'it is a race condition' })
    await drain($.turn.step({ ...STEP, index: 1, effort: 'high' }))
    // A model that takes no effort is sent none.
    await drain($.turn.step({ ...STEP, index: 2 }))

    expect(context?.some(c => c.includes('with low effort (auto)') && c.includes('Review that pick'))).toBe(true)
    expect(r.result).toBe('Effort xhigh from the next request.')
    expect(sent).toEqual(['low', 'xhigh', undefined])
  })

  test('set_tier needs tier or effort, each from its own set', async ($, on) => {
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('ui.status', () => ({ value: undefined }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect((await $.tool.call({ tool: 'mcp__model-tier__set_tier', reason: 'x' })).deny).toBe('give tier, effort or both')
    expect((await $.tool.call({ tool: 'mcp__model-tier__set_tier', effort: 'ultra' })).deny).toContain('effort must be one of')
    const both = await $.tool.call({ tool: 'mcp__model-tier__set_tier', tier: 'sonnet', effort: 'medium' })
    expect(both.result).toBe('Switched to sonnet from the next request. Effort medium from the next request.')
  })

  test('an exceptionally hard prompt stays on opus, set_tier cannot pick fable, /tier fable can', async ($, on) => {
    on('ui.status', () => ({ value: undefined }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('model.classify', (_, e) => ({ value: (e.labels as readonly string[]).includes('complex') ? 'exceptionally-hard' : 'hard-open-problem' }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    const sent: string[] = []
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      return answered(e)
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: 'Prove the scheduler is starvation-free under every interleaving', wait: false, origin: { kind: 'composer' } })
    await drain($.turn.step(STEP))
    const r = await $.tool.call({ tool: 'mcp__model-tier__set_tier', tier: 'fable', effort: 'max', reason: 'opus is not enough' })
    await drain($.turn.step({ ...STEP, index: 1 }))
    const pinned = await $.command.run({ command: 'tier', args: 'fable', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await drain($.turn.step({ ...STEP, index: 2 }))

    expect(r.result).toBe('fable is above the auto tier cap (opus); only the person can pick it with /tier fable. The tier stays opus. Effort max from the next request.')
    expect(pinned.text).toBe('Pinned to fable. /tier auto to release.')
    expect(sent).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])
  })

  test('session.start draws the tier piece and takes down any row; session.end clears the piece by the ending id', async ($, on) => {
    const statuses: unknown[] = []
    on('ui.status', (_, e) => {
      statuses.push((e as { text?: unknown }).text)
      return { value: undefined }
    })
    on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    on('session.id', () => ({ value: 'live' }))
    mock.env(on, { HOME: '/h' })
    const files = new Map<string, string>()
    on('fs.write', (_, e) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(statuses[0]).toBeUndefined()
    expect(files.get('/h/.claude/statusline/live/model-tier.txt')).toBe('sonnet')
    await $.session.end({ reason: 'clear', sessionId: 'live' })
    expect(files.get('/h/.claude/statusline/live/model-tier.txt')).toBe('')
  })

  test('a classifier that times out leaves a timeout log line in ~/.claude/model-tier.log with the tier and effort kept', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    on('ui.status', () => ({ value: undefined }))
    on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'live' }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    mock.env(on, { HOME: '/h' })
    const files = new Map<string, string>()
    on('fs.read', (_, e) => {
      const text = files.get(e.path)
      return text === undefined ? { deny: 'ENOENT' } : { value: text }
    })
    on('fs.write', (_, e) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })
    let slow = true
    on('model.classify', async () => {
      if (slow) await new Promise(() => {})
      return { value: 'trivial' }
    })
    const LOG = '/h/.claude/model-tier.log'

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const submitted = $.prompt.submit({ text: 'Redesign the cache layer across these services', wait: false, origin: { kind: 'composer' } })
    await clock.advance(3_000)
    await submitted
    const lines = (files.get(LOG) ?? '').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(l => l.classifier).sort()).toEqual(['effort', 'tier'])
    for (const line of lines) {
      expect(line).toMatchObject({ event: 'classifier-timeout', ranMs: 3000, kept: { tier: 'sonnet', effort: null } })
      expect(typeof line.ts).toBe('string')
    }

    // An answer in time writes nothing.
    slow = false
    await $.prompt.submit({ text: 'what time is it', wait: false, origin: { kind: 'composer' } })
    expect((files.get(LOG) ?? '').trim().split('\n')).toHaveLength(2)
  })
})

