import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

import { autoGoalCandidate, parseSetArgs, parseVerdict, transcriptTail } from './register'

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
function engine(on: On, verdicts: Array<string | 'fail' | 'throw'>, transcript: string | 'too-big' = TRANSCRIPT, clock = true) {
  const calls = { complete: 0, fork: 0, lastPrompt: '' }
  on('tool.register', (_, e) => ({ value: { tool: `mcp__goal-mode__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // A test that drives timers brings mock.clock, which answers clock.now itself.
  if (clock) on('clock.now', () => ({ value: 1_000 }))
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
  on('model.complete', (_, e) => {
    calls.complete++
    calls.lastPrompt = String(e.prompt)
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

describe('auto goal', () => {
  const TASK = '이 저장소의 모든 테스트가 통과하도록 실패하는 테스트를 전부 고쳐줘'

  test('a plan approved mid-turn no longer leaves set_goal refusing plan mode', async ($, on) => {
    engine(on, [])
    on('tool.call', () => ({ result: 'approved' }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.UserPromptSubmit({ prompt: 'plan it', permission_mode: 'plan' })

    const exit = await $.tool.call({ tool: 'ExitPlanMode' })
    expect(exit.context?.join('\n')).toContain('set the session goal now')
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })).deny).toBeUndefined()
  })

  test('an outcome request gets the nudge; chat and questions do not', async ($, on) => {
    engine(on, [])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const yes = await $.classic.UserPromptSubmit({ prompt: TASK, permission_mode: 'default' })
    expect(yes.additionalContext?.join('\n')).toContain('mcp__goal-mode__set_goal')

    const chat = await $.classic.UserPromptSubmit({ prompt: '오늘 회의에서 나온 이야기들을 그냥 들려줄게 잘 들어봐 정말 길어', permission_mode: 'default' })
    expect(chat.additionalContext ?? []).toEqual([])

    const question = await $.classic.UserPromptSubmit({ prompt: '이 함수가 왜 테스트에서 실패하는지 설명해 줄 수 있나요?', permission_mode: 'default' })
    expect(question.additionalContext ?? []).toEqual([])
  })

  test('no nudge once a goal is set, in plan mode, or when turned off', async ($, on) => {
    engine(on, [])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect((await $.classic.UserPromptSubmit({ prompt: TASK, permission_mode: 'plan' })).additionalContext ?? []).toEqual([])
    await $.classic.UserPromptSubmit({ prompt: 'ok', permission_mode: 'default' })
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })).deny).toBeUndefined()
    expect((await $.classic.UserPromptSubmit({ prompt: TASK, permission_mode: 'default' })).additionalContext ?? []).toEqual([])
  })

  test('cheap gates', async () => {
    expect(autoGoalCandidate('고쳐줘')).toBe(false)
    expect(autoGoalCandidate('<command-name>/context</command-name> 이건 명령 턴이라 건너뛴다')).toBe(false)
    expect(autoGoalCandidate('왜 이렇게 동작하는지 원인을 자세히 설명해 줄 수 있을까요?')).toBe(false)
    expect(autoGoalCandidate('harness mod의 Phase 0부터 3까지 전부 구현하고 테스트까지 통과시켜줘')).toBe(true)
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

describe('/goal-mode set', () => {
  const run = ($: Parameters<TestBody>[0], args: string) =>
    $.command.run({ command: 'goal-mode', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

  test('the person sets the goal; the evaluator then judges it and work starts', async ($, on) => {
    const calls = engine(on, ['{"met": false, "reason": "no test output yet"}'], TRANSCRIPT, false)
    const clock = mock.clock(on, { now: 1_000 })
    const prompts: string[] = []
    on('prompt.submit', (_, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const set = await run($, 'set `bun test` exits 0 --check bun test')
    expect(set.text).toContain('Goal set: `bun test` exits 0')
    expect(set.text).toContain('Check: bun test')
    expect((await run($, '')).text).toContain('(set by you)')
    // The kickoff is submitted once the command has returned.
    await clock.advance(100)
    expect(prompts[0]).toContain('The person set this session\'s goal')

    expect((await $.classic.Stop(STOP)).block).toContain('no test output yet')
    expect(calls.complete).toBe(1)
  })

  test('Claude refines a direction the person set, once; the evaluator sees their words', async ($, on) => {
    const calls = engine(on, ['{"met": false, "reason": "not yet"}'])
    on('prompt.submit', (_, e) => ({ text: e.text }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await run($, 'set 새로 추진할 목표를 정해봐')

    const refined = await $.tool.call({ tool: TOOL_ID, condition: 'PR #12 merged with CI green', check: 'gh pr view 12' })
    expect(refined.deny).toBeUndefined()
    expect(String(refined.result)).toContain('is now: PR #12 merged with CI green')
    const status = (await run($, '')).text
    expect(status).toContain('(yours, refined by Claude): PR #12 merged with CI green')
    expect(status).toContain('Your words: 새로 추진할 목표를 정해봐')
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'something easier' })).deny).toContain('already refined once')

    await $.classic.Stop(STOP)
    expect(calls.lastPrompt).toContain('The person asked for: 새로 추진할 목표를 정해봐')
  })

  test('replaces a goal, refuses an empty one and plan mode', async ($, on) => {
    engine(on, [])
    on('prompt.submit', (_, e) => ({ text: e.text }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL_ID, condition: 'old goal' })

    expect((await run($, 'set new goal')).text).toContain('Goal replaced: new goal\n(was: old goal)')
    expect((await run($, 'set')).text).toContain('Usage: /goal-mode set')
    await $.classic.UserPromptSubmit({ prompt: 'plan it', permission_mode: 'plan' })
    expect((await run($, 'set another')).text).toContain('Plan mode is active')
  })
})

describe('helpers', () => {
  test('parseSetArgs splits the condition from --check', () => {
    expect(parseSetArgs(' tests pass --check  pytest -q | tail -1 ')).toEqual({ condition: 'tests pass', check: 'pytest -q | tail -1' })
    expect(parseSetArgs('grep a | wc -l prints 0')).toEqual({ condition: 'grep a | wc -l prints 0' })
    expect(parseSetArgs('x --check')).toEqual({ condition: 'x', check: undefined })
    expect(parseSetArgs('use --checkout flag')).toEqual({ condition: 'use --checkout flag' })
  })

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
