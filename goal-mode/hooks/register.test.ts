import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

import { autoGoalCandidate, nativeGoalArgs, parseSetArgs, parseVerdict, transcriptTail } from './register'

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

// Stands in for the engine beneath the plugin; `native` offers Claude Code's
// /goal, and `calls` counts evaluator requests.
function engine(on: On, native = true, clock = true) {
  const calls = { complete: 0, logs: [] as string[] }
  on('tool.register', (_, e) => ({ value: { tool: `mcp__goal-mode__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  if (native) on('command.list', () => ({ value: [{ name: 'goal', description: 'Set a goal', source: 'builtin' }] }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // A test that drives timers brings mock.clock, which answers clock.now itself.
  if (clock) on('clock.now', () => ({ value: 1_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    calls.logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('classic.Stop', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('fs.read', () => ({ value: TRANSCRIPT }))
  on('model.complete', () => {
    calls.complete++
    return { value: { isAnswered: true as const, text: '{"met": false, "reason": "x"}', usage: USAGE } }
  })

  return calls
}

const PRESENTATION = { isFullscreen: false, columns: 80 }

const STOP = {
  stop_hook_active: false,
  last_assistant_message: 'Done, tests pass.',
  transcript_path: '/tmp/session.jsonl',
}

const run = ($: Parameters<TestBody>[0], args: string) =>
  $.command.run({ command: 'goal-mode', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

describe('set_goal', () => {
  test('refuses an empty or oversized condition', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect((await $.tool.call({ tool: TOOL_ID, condition: '  ' })).deny).toContain('required')
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'x'.repeat(601) })).deny).toContain('limited')
  })

  test('refuses in plan mode', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.UserPromptSubmit({ prompt: 'plan it', permission_mode: 'plan' })

    expect((await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })).deny).toContain('Plan mode')
  })

  test('defers to the native ProposeGoal tool once it is seen', async ($, on) => {
    engine(on)
    on('tool.describe', (_, e) => ({ description: e.description }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.describe({ tool: 'ProposeGoal', description: 'native', provider: { plugin: 'engine', tier: 'core' } })

    expect((await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })).deny).toContain('ProposeGoal')
  })

  test('without /goal, goals are unavailable: logged once at start, refused, never nudged or judged', async ($, on) => {
    const calls = engine(on, false)
    on('prompt.submit', (_, e) => ({ text: e.text }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(calls.logs).toEqual([expect.stringContaining('no /goal command')])

    expect((await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })).deny).toContain('no /goal command')
    expect((await run($, 'set tests pass')).text).toContain('no /goal command')
    expect((await run($, 'auto')).text).toContain('no /goal command')
    expect((await run($, '')).text).toContain('no /goal command')
    const prompt = await $.classic.UserPromptSubmit({ prompt: '이 저장소의 모든 테스트가 통과하도록 실패하는 테스트를 전부 고쳐줘', permission_mode: 'default' })
    expect(prompt.additionalContext ?? []).toEqual([])
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect(calls.complete).toBe(0)
  })
})

describe('auto goal', () => {
  const TASK = '이 저장소의 모든 테스트가 통과하도록 실패하는 테스트를 전부 고쳐줘'

  test('a plan approved mid-turn no longer leaves set_goal refusing plan mode', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'approved' }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.UserPromptSubmit({ prompt: 'plan it', permission_mode: 'plan' })

    const exit = await $.tool.call({ tool: 'ExitPlanMode' })
    expect(exit.context?.join('\n')).toContain('set the session goal now')
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'tests pass' })).deny).toBeUndefined()
  })

  test('an outcome request gets the nudge; chat, questions and plan mode do not', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const yes = await $.classic.UserPromptSubmit({ prompt: TASK, permission_mode: 'default' })
    expect(yes.additionalContext?.join('\n')).toContain('mcp__goal-mode__set_goal')

    const chat = await $.classic.UserPromptSubmit({ prompt: '오늘 회의에서 나온 이야기들을 그냥 들려줄게 잘 들어봐 정말 길어', permission_mode: 'default' })
    expect(chat.additionalContext ?? []).toEqual([])

    const question = await $.classic.UserPromptSubmit({ prompt: '이 함수가 왜 테스트에서 실패하는지 설명해 줄 수 있나요?', permission_mode: 'default' })
    expect(question.additionalContext ?? []).toEqual([])

    expect((await $.classic.UserPromptSubmit({ prompt: TASK, permission_mode: 'plan' })).additionalContext ?? []).toEqual([])
  })

  test('cheap gates', async () => {
    expect(autoGoalCandidate('고쳐줘')).toBe(false)
    expect(autoGoalCandidate('[auto-claude] The person started an autonomous run of this repository. Plan it now and fix the build.')).toBe(false)
    expect(autoGoalCandidate('<command-name>/context</command-name> 이건 명령 턴이라 건너뛴다')).toBe(false)
    expect(autoGoalCandidate('왜 이렇게 동작하는지 원인을 자세히 설명해 줄 수 있을까요?')).toBe(false)
    expect(autoGoalCandidate('harness mod의 Phase 0부터 3까지 전부 구현하고 테스트까지 통과시켜줘')).toBe(true)
  })
})

// What an earlier version stored for this session's goal, held until the
// plugin writes the goal.
function seedHeldGoal(on: On) {
  let written = false
  const keyOf = (e: unknown) => (e as { key?: string }).key ?? (e as { ref?: { key?: string } }).ref?.key
  on('state.set', (_, e, next) => {
    if (keyOf(e) === 'goal') written = true
    return next(e)
  })
  on('state.get', (_, e, next) => {
    if (keyOf(e) !== 'goal' || written) return next(e)
    return { value: { value: { shape: 'goal-2', value: { condition: 'tests pass', check: 'pytest -q', source: 'model', setAt: 0, checks: 4, unmetThisTurn: 0, parseFailures: 0, recentReasons: [], status: 'active' } }, version: 1 } } as never
  })
}

describe("Claude Code's own /goal", () => {
  function withNative(on: On) {
    const calls = engine(on, true, false)
    const clock = mock.clock(on, { now: 1_000 })
    const goals: string[] = []
    const prompts: string[] = []
    on('command.run', ($, e, next) => {
      if (e.command === 'goal') {
        goals.push(e.args ?? '')
        return { text: 'Goal set' }
      }
      return next(e)
    })
    on('prompt.submit', (_, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    // Nothing beneath the plugin answers turn.start: a hook stands for the engine.
    on('turn.start', (_, e) => e as never)
    return { calls, clock, goals, prompts }
  }

  test('set_goal hands the goal to /goal as the turn ends; no evaluator of its own runs', async ($, on) => {
    const { calls, clock, goals } = withNative(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const r = await $.tool.call({ tool: TOOL_ID, condition: 'bun test exits 0', check: 'bun test' })
    // No ProposeGoal beneath: queued for /goal, landing as the turn ends.
    expect(String(r.result)).toContain("queued for Claude Code's /goal")
    expect(goals).toEqual([])
    // Nothing runs mid-turn; the stop hands it to /goal.
    await clock.advance(100)
    expect(goals).toEqual([])
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    await clock.advance(100)
    expect(goals).toEqual(['bun test exits 0 (check: bun test)'])
    // One per turn: a second call in the same turn is refused, a new turn may set one.
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'bun test exits 0, faster' })).deny).toContain('already handed')
    await $.turn.start({ text: 'next', turnId: 't2' } as never)
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'lint clean' })).deny).toBeUndefined()
    // Interrupted (no stop): the next turn's start runs it.
    await $.turn.start({ text: 'again', turnId: 't3' } as never)
    await clock.advance(100)
    expect(goals).toEqual(['bun test exits 0 (check: bun test)', 'lint clean'])
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect(calls.complete).toBe(0)
  })

  test('where ProposeGoal answers, the goal is set at once and nothing is queued', async ($, on) => {
    const { clock, goals } = withNative(on)
    const proposed: unknown[] = []
    on('tool.call', { tool: 'ProposeGoal' }, (_, e) => {
      proposed.push(e)
      return { result: 'Goal set' }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const r = await $.tool.call({ tool: TOOL_ID, condition: 'lint clean', check: 'bun lint' })
    expect(String(r.result)).toContain("Goal set in Claude Code's /goal")
    expect(proposed).toEqual([expect.objectContaining({ tool: 'ProposeGoal', condition: 'lint clean (check: bun lint)', ask_user: false })])
    await clock.advance(100)
    expect(goals).toEqual([])
  })

  test('/goal-mode set and clear go to /goal; an over-long goal is refused', async ($, on) => {
    const { clock, goals } = withNative(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    expect((await run($, 'set PR merged --check gh pr view')).text).toBe('Goal → /goal: PR merged (check: gh pr view)')
    expect((await run($, 'clear')).text).toBe('Clearing /goal.')
    await clock.advance(100)
    expect(goals).toEqual(['PR merged (check: gh pr view)', 'clear'])
    expect((await $.tool.call({ tool: TOOL_ID, condition: 'x'.repeat(490), check: 'y'.repeat(20) })).deny).toContain('at most 500')
  })

  test('a goal an earlier version held moves to /goal on load', async ($, on) => {
    const { clock, goals } = withNative(on)
    seedHeldGoal(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(100)
    expect(goals).toEqual(['tests pass (check: pytest -q)'])
  })

  test('without /goal, a goal an earlier version held is dropped', async ($, on) => {
    const calls = engine(on, false)
    seedHeldGoal(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect((await run($, '')).text).toContain('no /goal command')
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect(calls.complete).toBe(0)
  })

  test('auto clears the running /goal and hands the choice of the next to Claude', async ($, on) => {
    const { clock, goals, prompts } = withNative(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect((await run($, 'auto 배포 마무리 위주로')).text).toContain('Claude plans the long-term goal')
    await clock.advance(100)
    expect(goals).toEqual(['clear'])
    expect(prompts[0]).toContain('choose this session\'s goal yourself')
    expect(prompts[0]).toContain('Their hint: 배포 마무리 위주로')
    expect(prompts[0]).toContain('without asking the person anything')
    expect(prompts[0]).toContain('the end state of the whole plan')
    expect(prompts[0]).toContain('.claude/goal-plan.md')
    // A bare `set` is the same as `auto`.
    expect((await run($, 'set')).text).toContain('Claude plans the long-term goal')
  })
})

describe('helpers', () => {
  test('nativeGoalArgs folds the check into one line', () => {
    expect(nativeGoalArgs('a', undefined)).toBe('a')
    expect(nativeGoalArgs('a', 'b')).toBe('a (check: b)')
  })
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
