import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

import { parseVerdict, transcriptTail } from './register'

const TOOL_ID = 'mcp__goal-mode__set_goal'
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'make tests pass' } }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest -q' } }] },
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: '3 passed' }] },
  }),
].join('\n')

// Stands in for the engine beneath the plugin; `verdicts` are the evaluator's
// replies in order, `calls` counts evaluator requests.
function engine(on: On, verdicts: Array<string | 'fail' | 'throw'>, transcript: string | 'too-big' = TRANSCRIPT) {
  const calls = { complete: 0, fork: 0 }
  on('tool.register', (_, e) => ({ value: { tool: `mcp__goal-mode__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [] }))
  on('classic.Stop', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('fs.read', () =>
    transcript === 'too-big' ? { deny: 'over 4 MiB' } : { value: transcript },
  )
  const reply = () => {
    const next = verdicts.shift() ?? '{"met": false, "reason": "default"}'
    if (next === 'throw') throw new Error('blocked model')
    return next === 'fail'
      ? { value: { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: 'server_error' as const, usage: USAGE } }
      : { value: { isAnswered: true as const, text: next, usage: USAGE } }
  }
  on('model.complete', () => {
    calls.complete++
    return reply()
  })
  on('model.fork', () => {
    calls.fork++
    return reply()
  })

  return calls
}

// The kit stamps an empty transcript_path, which $.fs.read refuses; a session
// always has one.
const PRESENTATION = { isFullscreen: false, columns: 80 }

const STOP = {
  stop_hook_active: false,
  last_assistant_message: 'Done, tests pass.',
  transcript_path: '/tmp/session.jsonl',
}

describe('set_goal', () => {
  test('sets a goal once and refuses a second one', async ($, on) => {
    engine(on, [])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const first = await $.tool.call({ tool: TOOL_ID, condition: '`pytest -q` exits 0' })
    expect(first.deny).toBeUndefined()
    expect(String(first.result)).toContain('Goal set')

    const second = await $.tool.call({ tool: TOOL_ID, condition: 'something else' })
    expect(second.deny).toContain('already set')
  })

  test('refuses an empty or oversized condition', async ($, on) => {
    engine(on, [])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect((await $.tool.call({ tool: TOOL_ID, condition: '  ' })).deny).toContain('required')
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'x'.repeat(601) })).deny).toContain('limited')
  })

  test('refuses in plan mode', async ($, on) => {
    engine(on, [])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.UserPromptSubmit({ prompt: 'plan it', permission_mode: 'plan' })

    expect((await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })).deny).toContain('Plan mode')
  })

  test('defers to the native ProposeGoal tool once it is seen', async ($, on) => {
    engine(on, [])
    on('tool.describe', (_, e) => ({ description: e.description }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.describe({ tool: 'ProposeGoal', description: 'native', provider: { plugin: 'engine', tier: 'core' } })

    expect((await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })).deny).toContain('ProposeGoal')
  })
})

describe('Stop evaluator', () => {
  test('no goal: the stop passes and no evaluator runs', async ($, on) => {
    const calls = engine(on, [])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const stop = await $.classic.Stop(STOP)
    expect(stop.block).toBeUndefined()
    expect(calls.complete + calls.fork).toBe(0)
  })

  test('unmet blocks with the reason, met clears the goal', async ($, on) => {
    const calls = engine(on, [
      '{"met": false, "reason": "no test run after the last edit"}',
      '{"met": true, "reason": "pytest shows 3 passed"}',
    ])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL_ID, condition: '`pytest -q` exits 0' })

    const first = await $.classic.Stop(STOP)
    expect(first.block).toContain('no test run after the last edit')
    expect(first.block).toContain('`pytest -q` exits 0')

    const second = await $.classic.Stop({ ...STOP, stop_hook_active: true })
    expect(second.block).toBeUndefined()
    expect(calls.complete).toBe(2)

    // Cleared: a new goal can be set and further stops are free.
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'next' })).deny).toBeUndefined()
  })

  test('pauses after the per-turn cap, and a typed prompt resumes it', async ($, on) => {
    const calls = engine(on, Array(20).fill('{"met": false, "reason": "still failing"}'))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL_ID, condition: 'impossible' })

    for (let i = 0; i < 4; i++) {
      expect((await $.classic.Stop({ ...STOP, stop_hook_active: i > 0 })).block).toBeDefined()
    }
    expect((await $.classic.Stop({ ...STOP, stop_hook_active: true })).block).toBeUndefined()
    expect(calls.complete).toBe(5)

    // Paused: stops pass without evaluating.
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect(calls.complete).toBe(5)

    await $.classic.UserPromptSubmit({ prompt: 'keep going', permission_mode: 'default' })
    expect((await $.classic.Stop(STOP)).block).toBeDefined()
    expect(calls.complete).toBe(6)
  })

  test('an evaluator failure pauses instead of blocking', async ($, on) => {
    engine(on, ['fail'])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })

    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    const status = await $.command.run({ command: 'goal-mode', args: 'status', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(status.text).toContain('Paused')
  })

  test('a request the engine refuses to send pauses instead of throwing', async ($, on) => {
    engine(on, ['throw'])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })

    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    const status = await $.command.run({ command: 'goal-mode', args: 'status', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(status.text).toContain('Paused')
    expect(status.text).toContain('could not complete')
  })

  test('a transcript past the read cap is judged by a fork', async ($, on) => {
    const calls = engine(on, ['{"met": false, "reason": "x"}'], 'too-big')
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })

    expect((await $.classic.Stop(STOP)).block).toBeDefined()
    expect(calls.fork).toBe(1)
    expect(calls.complete).toBe(0)
  })

  test("a subagent's stop is not evaluated", async ($, on) => {
    const calls = engine(on, [])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })

    expect((await $.classic.Stop({ ...STOP, agent_id: 'a1' })).block).toBeUndefined()
    expect(calls.complete).toBe(0)
  })

  test('/goal-mode clear removes the goal', async ($, on) => {
    const calls = engine(on, [])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })

    const cleared = await $.command.run({ command: 'goal-mode', args: 'clear', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(cleared.text).toContain('Goal cleared')
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect(calls.complete).toBe(0)
  })
})

describe('helpers', () => {
  test('parseVerdict reads the JSON line and rejects anything else', async () => {
    expect(parseVerdict('{"met": true, "reason": "ok"}')).toEqual({ kind: 'met', reason: 'ok' })
    expect(parseVerdict('sure! {"met": false, "reason": "no"}').kind).toBe('unmet')
    expect(parseVerdict('I think it is done').kind).toBe('unparsable')
    expect(parseVerdict('{"met": "yes"}').kind).toBe('unparsable')
  })

  test('transcriptTail keeps tool calls and their outputs', async () => {
    const tail = transcriptTail(`${TRANSCRIPT}\nnot json\n`)
    expect(tail).toContain('[tool_use Bash]')
    expect(tail).toContain('[tool_result] 3 passed')
  })
})
