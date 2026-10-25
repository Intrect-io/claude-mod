import { describe, expect, test } from 'claude-code/testing'
import type { AgentSpawnInput, HookStream, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import type { TierState } from '../types'
import { decide, INITIAL, isTier } from './register'

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
const answered = (e: TurnStepInput, tokens = 1000): TurnStepResult => ({
  turnId: e.turnId,
  index: e.index,
  answer: 'ok',
  toolUses: [],
  stopReason: 'end_turn',
  usage: {
    model: e.model,
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

  test('isTier reads resolved ids', () => {
    expect(isTier('claude-opus-5-5[1m]', 'opus')).toBe(true)
    expect(isTier('claude-haiku-5-5', 'sonnet')).toBe(false)
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

    expect(sent).toEqual(['opus'])
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
    expect(sent).toEqual(['claude-opus-5-5', 'haiku'])
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

    expect(model).toBe('haiku')
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
    on('state.get', () => ({ value: { value: { shape: 'tier-1', value: { ...INITIAL, tier: 'haiku' } }, version: 1 } }))
    const sent: string[] = []
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      return answered(e)
    })

    await drain($.turn.step({ ...STEP, agentId: 'a1' }))

    expect(sent).toEqual(['claude-opus-5-5'])
  })

  test('a refused tier falls back to the session model', async ($, on) => {
    on('state.get', () => ({ value: { value: { shape: 'tier-1', value: { ...INITIAL, tier: 'haiku' } }, version: 1 } }))
    on('ui.toast', () => ({ value: undefined }))
    const sent: string[] = []
    on('turn.step', async function* (_, e) {
      sent.push(e.model)
      if (e.model === 'haiku') throw new Error('model not allowed')
      return answered(e)
    })

    const r = await drain($.turn.step(STEP))

    expect(sent).toEqual(['haiku', 'claude-opus-5-5'])
    expect(r.usage?.model).toBe('claude-opus-5-5')
  })
})
