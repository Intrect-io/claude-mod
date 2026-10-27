import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { finalCheckOf, fixLine, kickoffText, parseQueue, validatePlan } from './plan'
import { capReached, inFlight, mergeable, parseChecks, prNumber, readLog } from './ship'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const PLAN = '## Goal\nadd and sub work\n\nFinal check: `python3 -m unittest -q`\n\n## Milestones\n1. add\n2. sub\n\n## Decisions\n'
const QUEUE = '- [ ] add() returns a+b :: check: python3 -m unittest -q test_add\n- [ ] sub() returns a-b :: check: python3 -m unittest -q test_sub\n'

describe('plan', () => {
  test('the queue grammar matches goal-mode\'s, :: base: included', () => {
    expect(parseQueue('- [ ] a :: check: x :: base: goal/01-a\n- [x] b <!-- done -->\n- [!] c :: check: y')).toEqual([
      { line: 0, mark: ' ', condition: 'a', check: 'x', base: 'goal/01-a' },
      { line: 1, mark: 'x', condition: 'b', check: undefined },
      { line: 2, mark: '!', condition: 'c', check: 'y' },
    ])
  })

  test('a plan needs a final check and checked milestones', () => {
    expect(finalCheckOf(PLAN)).toBe('python3 -m unittest -q')
    expect(finalCheckOf('- **Final check**: make test')).toBe('make test')
    expect(validatePlan(PLAN, QUEUE, true)).toMatchObject({ ok: true, finalCheck: 'python3 -m unittest -q' })
    const bad = validatePlan('## Goal\nx', '- [ ] only one\n', true)
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.errors.join(' ')).toContain('no "Final check')
    expect(!bad.ok && bad.errors.join(' ')).toContain('at least 2')
    expect(!bad.ok && bad.errors.join(' ')).toContain('without a check')
    expect(validatePlan(PLAN, `${QUEUE}- [ ] add() returns a+b :: check: z\n`, true).ok).toBe(false)
    // A later round needs only one new milestone.
    expect(validatePlan(PLAN, '- [x] a :: check: x\n- [ ] b :: check: y\n', false).ok).toBe(true)
    expect(validatePlan(PLAN, '- [ ] a :: check: x :: base: main\n- [ ] b :: check: y\n', true).ok).toBe(false)
    // Shipping is not a milestone's end state.
    const shipped = validatePlan(PLAN, '- [ ] add works, merged to main :: check: x\n- [ ] b :: check: y\n', true)
    expect(!shipped.ok && shipped.errors.join(' ')).toContain('merging, pushing and PRs happen after')
  })

  test('the kickoff aims at the end state and asks nobody', () => {
    const k = kickoffText('finish the CLI', 'origin/main')
    expect(k).toContain('Their aim: finish the CLI')
    expect(k).toContain('long-term end state')
    expect(k).toContain('from origin/main')
    expect(k).toContain('decide every choice yourself')
  })

  test('a fix line builds on the failing branch with the milestone\'s check', () => {
    const line = fixLine('add() returns a+b', 7, 'CI failed', 'pytest -q', 'goal/01-add')
    expect(parseQueue(line)[0]).toMatchObject({ check: 'pytest -q', base: 'goal/01-add' })
    expect(line).toContain('PR #7')
  })
})

describe('ship', () => {
  test('log tail reads from the offset and survives a trimmed log', () => {
    const log = '{"event":"start","branch":"goal/01-a"}\n{"event":"met","goal":"a","branch":"goal/01-a"}\nnot json\n'
    expect(readLog(log, 0).entries.map(e => e.event)).toEqual(['start', 'met'])
    expect(readLog(log, 2)).toEqual({ entries: [], offset: 3 })
    expect(readLog(log, 99).entries).toHaveLength(2)
  })

  test('checks, mergeability and PR numbers', () => {
    expect(parseChecks('[{"bucket":"pass"},{"bucket":"skipping"}]')).toBe('green')
    expect(parseChecks('[{"bucket":"pass"},{"bucket":"pending"}]')).toBe('pending')
    expect(parseChecks('[{"bucket":"fail"}]')).toBe('red')
    expect(parseChecks('')).toBe('none')
    expect(mergeable('{"state":"OPEN","mergeable":"CONFLICTING"}')).toEqual({ open: true, conflict: true, unknown: false })
    expect(prNumber('https://github.com/o/r/pull/42\n')).toBe(42)
  })

  test('one milestone ships at a time; caps stop the run', () => {
    const s = (state: 'push' | 'ci' | 'merged' | 'held', headRef: string) => ({ goal: headRef, headRef, branch: headRef, state, red: 0, since: 0 })
    expect(inFlight([s('merged', 'a'), s('ci', 'b'), s('push', 'c')])?.headRef).toBe('b')
    expect(inFlight([s('merged', 'a'), s('held', 'b')])).toBeUndefined()
    expect(capReached({ merges: 20, startedAt: 0 }, { maxRounds: 3, maxMerges: 20, maxHours: 24 }, 1)).toContain('merge cap')
    expect(capReached({ merges: 0, startedAt: 0 }, { maxRounds: 3, maxMerges: 20, maxHours: 1 }, 3600_001)).toContain('time cap')
  })
})

// The machine beneath the plugin, local CI mode: files in memory, git and
// checks answered by argv, goal-mode's loop played by the test.
function world(on: On) {
  const w = {
    files: new Map<string, string>([['/repo/.git/info/exclude', '']]),
    prompts: [] as string[],
    commands: [] as string[],
    runs: [] as string[],
    notifies: [] as string[],
    pushes: [] as string[],
    checkExit: 0,
    clock: mock.clock(on, { now: 1_000 }),
  }
  mock.store(on, {})
  on('tool.register', (_, e) => ({ value: { tool: `mcp__auto-claude__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.notify', (_, e) => {
    w.notifies.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('env.get', () => ({ value: '/home' }))
  on('fs.read', (_, e) => {
    const t = w.files.get(e.path)
    return t === undefined ? { deny: `ENOENT ${e.path}` } : { value: t }
  })
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('command.run', (_, e) => {
    w.commands.push(`${e.command} ${e.args ?? ''}`.trim())
    return { text: 'ok' }
  })
  on('tool.call', () => ({ result: 'no fleet' }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    w.runs.push(a)
    const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a.includes('--git-common-dir')) return ok('/repo/.git\n')
    if (a.endsWith(' remote')) return ok('origin\n')
    if (a.includes('symbolic-ref')) return ok('origin/main\n')
    if (a.startsWith('gh repo view')) return ok('', 1)
    if (e.argv[0] === 'bash') return ok('', w.checkExit)
    if (a.includes(' push ')) {
      w.pushes.push(a)
      return ok()
    }
    return ok()
  })
  return w
}

const cmd = ($: Engine, args: string) => $.command.run({ command: 'auto-claude', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const log = (w: ReturnType<typeof world>, lines: object[]) => {
  const prev = w.files.get('/repo/.claude/goal-loop.log') ?? ''
  w.files.set('/repo/.claude/goal-loop.log', prev + lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

describe('a run, local CI', () => {
  test('plan → each milestone merged into main one at a time → final check → done', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

    expect((await cmd($, 'start add and sub')).text).toContain('local CI, merges into main')
    await w.clock.advance(200)
    expect(w.prompts[0]).toContain('Their aim: add and sub')
    expect(w.files.get('/repo/.claude/goal-loop.base')).toBe('origin/main\n')
    expect(w.files.get('/repo/.claude/goal-loop.gate')).toBe('0\n')
    expect(w.files.get('/repo/.claude/goal-loop.deny')).toContain('gh\\s+pr\\s+merge')

    // Not ready until both files hold up.
    expect(String((await $.tool.call({ tool: 'mcp__auto-claude__auto_plan_ready' } as never)).result)).toContain('Not ready')
    w.files.set('/repo/.claude/auto-plan.md', PLAN)
    w.files.set('/repo/.claude/goals.md', QUEUE)
    expect(String((await $.tool.call({ tool: 'mcp__auto-claude__auto_plan_ready' } as never)).result)).toContain('Plan accepted: 2 milestone(s)')
    expect(w.files.get('/repo/.claude/goal-loop.gate')).toBe('1\n')
    // The loop command runs from the next tick, not from the tool call.
    expect(w.commands).toEqual([])
    await w.clock.advance(30_000)
    expect(w.commands).toEqual(['goal-mode loop on'])

    // The loop builds milestone 1 and holds at the gate.
    log(w, [
      { event: 'start', goal: 'add() returns a+b', worktree: '/repo/worktrees/goal-01-add', branch: 'goal/01-add' },
      { event: 'met', goal: 'add() returns a+b', branch: 'goal/01-add' },
      { event: 'gated', goal: 'sub() returns a-b' },
    ])
    w.files.set('/repo/.claude/goals.md', QUEUE.replace('- [ ] add', '- [x] add'))
    await w.clock.advance(30_000) // push → ci
    await w.clock.advance(30_000) // check, rebase, push to main → merged, gate raised
    expect(w.pushes.some(p => p.includes('HEAD:main') && p.includes('goal-01-add'))).toBe(true)
    expect(w.runs.some(r => r.includes('worktree remove /repo/worktrees/goal-01-add'))).toBe(true)
    expect(w.files.get('/repo/.claude/goal-loop.gate')).toBe('2\n')
    await w.clock.advance(30_000)
    expect(w.commands).toEqual(['goal-mode loop on', 'goal-mode loop on'])

    // Milestone 2, then the queue empties: the final check runs on merged main.
    log(w, [
      { event: 'start', goal: 'sub() returns a-b', worktree: '/repo/worktrees/goal-02-sub', branch: 'goal/02-sub' },
      { event: 'met', goal: 'sub() returns a-b', branch: 'goal/02-sub' },
      { event: 'queue-empty' },
    ])
    w.files.set('/repo/.claude/goals.md', QUEUE.replace(/- \[ \]/g, '- [x]'))
    for (let i = 0; i < 4; i++) await w.clock.advance(30_000)
    expect(w.runs.some(r => r.includes('worktree add --detach /repo/worktrees/auto-final origin/main'))).toBe(true)
    expect(w.files.get('/repo/.claude/auto-plan.md')).toContain('## Result')
    expect(w.notifies.at(-1)).toContain('finished: the final check passed after 1 round(s). 2 merged, 0 held')
    expect((await cmd($, 'status')).text).toContain('auto-claude off · phase done')
  })

  test('the gate stays shut while the loop is still building a milestone', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await cmd($, 'start')
    w.files.set('/repo/.claude/auto-plan.md', PLAN)
    w.files.set('/repo/.claude/goals.md', QUEUE)
    await $.tool.call({ tool: 'mcp__auto-claude__auto_plan_ready' } as never)
    log(w, [{ event: 'start', goal: 'add() returns a+b', worktree: '/repo/worktrees/goal-01-add', branch: 'goal/01-add' }])
    for (let i = 0; i < 3; i++) await w.clock.advance(30_000)
    expect(w.files.get('/repo/.claude/goal-loop.gate')).toBe('1\n')
  })

  test('a failing check adds a fix goal on the milestone branch; three failures hold it', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await cmd($, 'start')
    w.files.set('/repo/.claude/auto-plan.md', PLAN)
    w.files.set('/repo/.claude/goals.md', QUEUE)
    await $.tool.call({ tool: 'mcp__auto-claude__auto_plan_ready' } as never)
    log(w, [
      { event: 'start', goal: 'add() returns a+b', worktree: '/repo/worktrees/goal-01-add', branch: 'goal/01-add' },
      { event: 'met', goal: 'add() returns a+b', branch: 'goal/01-add' },
    ])
    w.checkExit = 1
    await w.clock.advance(30_000)
    await w.clock.advance(30_000)
    const queue = w.files.get('/repo/.claude/goals.md') ?? ''
    expect(queue).toContain(':: base: goal/01-add')
    expect((await cmd($, 'status')).text).toContain('fixing')
    expect(w.pushes.some(p => p.includes('HEAD:main'))).toBe(false)
  })

  test('the stop file ends the run and turns the loop off', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await cmd($, 'start')
    w.files.set('/repo/.claude/auto-claude.stop', '')
    await w.clock.advance(30_000)
    await w.clock.advance(30_000)
    expect(w.commands).toContain('goal-mode loop off')
    expect((await cmd($, 'status')).text).toContain('phase stopped')
  })
})
