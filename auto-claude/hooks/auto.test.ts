import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { finalCheckOf, fixLine, kickoffText, parseQueue, validatePlan } from './plan'
import { capReached, inFlight, mergeable, parseChecks, prNumber, readLog } from './ship'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const PLAN = '## Goal\nadd and sub work\n\nFinal check: `python3 -m unittest -q`\n\n## Milestones\n1. add\n2. sub\n\n## Decisions\n'
const QUEUE = '- [ ] add() returns a+b :: check: python3 -m unittest -q test_add\n- [ ] sub() returns a-b :: check: python3 -m unittest -q test_sub\n'

describe('plan', () => {
  test('the queue grammar is goal-mode\'s own (generated from shared/queue.ts), :: base: and notes included', () => {
    expect(parseQueue('- [ ] a :: check: x :: base: goal/01-a\n- [x] b <!-- done -->\n- [!] c :: check: y')).toEqual([
      { line: 0, mark: ' ', condition: 'a', check: 'x', base: 'goal/01-a' },
      { line: 1, mark: 'x', condition: 'b', check: undefined, note: 'done' },
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
function world(on: On, store: Record<string, unknown> = {}) {
  const w = {
    files: new Map<string, string>([['/repo/.git/info/exclude', '']]),
    prompts: [] as string[],
    commands: [] as string[],
    runs: [] as string[],
    notifies: [] as string[],
    pushes: [] as string[],
    checkExit: 0,
    // What `gh pr checks` reports, how often it was asked, and the PRs merged.
    checks: '[{"bucket":"pass"}]',
    ciLooks: 0,
    merged: [] as string[],
    // Worktree directories removed from under the run, and whether their branches went too.
    gone: new Set<string>(),
    branchGone: false,
    // GitHub CI mode, and a branch push whose git cannot be spawned.
    github: false,
    gitGone: false,
    // What goal-mode answers to `loop on`.
    loopReply: 'Loop on: started',
    clock: mock.clock(on, { now: 1_000 }),
  }
  mock.store(on, store)
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
  on('fs.exists', (_, e) => ({ value: w.files.has(e.path) }))
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
    return { text: w.loopReply }
  })
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    w.runs.push(a)
    const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a.includes('--git-common-dir')) return ok('/repo/.git\n')
    if (e.argv[0] === 'mv') {
      const [from, to] = e.argv.slice(-2) as [string, string]
      const text = w.files.get(from)
      if (text === undefined) return ok('', 1)
      w.files.set(to, text)
      w.files.delete(from)
      return ok()
    }
    if (a.endsWith(' remote')) return ok('origin\n')
    if (a.includes('symbolic-ref')) return ok('origin/main\n')
    if (a.startsWith('gh repo view')) return ok('', w.github ? 0 : 1)
    if (a.startsWith('gh pr create')) return ok('https://github.com/o/r/pull/7\n')
    if (a.startsWith('gh pr checks')) {
      w.ciLooks++
      return ok(w.checks)
    }
    if (a.startsWith('gh pr view')) return ok('{"state":"OPEN","mergeable":"MERGEABLE"}')
    if (a.startsWith('gh pr merge')) {
      w.merged.push(a)
      return ok()
    }
    if (e.argv[0] === 'test' && e.argv[1] === '-d') return ok('', w.gone.has(String(e.argv[2])) ? 1 : 0)
    if (a.includes('rev-parse --verify')) return ok('', w.branchGone ? 1 : 0)
    if (a.includes('worktree add') && !a.includes('--detach')) w.gone.delete(String(e.argv[5]))
    if (e.argv[0] === 'bash') return ok('', w.checkExit)
    if (w.gitGone && a.includes(' push -u ')) return { value: { exitCode: -1, stdout: '', stderr: "posix_spawn 'git' ENOENT", isStdoutTruncated: false, isStderrTruncated: false } }
    if (a.includes(' push ')) {
      w.pushes.push(a)
      return ok()
    }
    return ok()
  })
  return w
}

const cmd = ($: Engine, args: string) => $.command.run({ command: 'auto-claude', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
// goal-mode's side: each start is logged, then spends one of the gate's credit.
const log = (w: ReturnType<typeof world>, lines: Array<{ event: string } & Record<string, unknown>>) => {
  for (const line of lines) {
    const prev = w.files.get('/repo/.claude/goal-loop.log') ?? ''
    w.files.set('/repo/.claude/goal-loop.log', `${prev}${JSON.stringify(line)}\n`)
    if (line.event !== 'start') continue
    const credit = Number.parseInt(w.files.get('/repo/.claude/goal-loop.gate') ?? '', 10)
    if (Number.isFinite(credit)) w.files.set('/repo/.claude/goal-loop.gate', `${Math.max(credit - 1, 0)}\n`)
  }
}
const GATE = '/repo/.claude/goal-loop.gate'
const MIN = 60_000

async function planned($: Engine, w: ReturnType<typeof world>) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await cmd($, 'start')
  w.files.set('/repo/.claude/auto-plan.md', PLAN)
  w.files.set('/repo/.claude/goals.md', QUEUE)
  await $.tool.call({ tool: 'mcp__auto-claude__auto_plan_ready' } as never)
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
    // One tick: check, rebase, push to main, worktree removed, the next
    // start granted and the loop asked on.
    await w.clock.advance(30_000)
    expect(w.pushes.some(p => p.includes('HEAD:main') && p.includes('goal-01-add'))).toBe(true)
    expect(w.runs.some(r => r.includes('worktree remove /repo/worktrees/goal-01-add'))).toBe(true)
    // One more start granted, whatever goal-mode's own seq is.
    expect(w.files.get('/repo/.claude/goal-loop.gate')).toBe('1\n')
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
    // Spent by that start and not granted again.
    expect(w.files.get('/repo/.claude/goal-loop.gate')).toBe('0\n')
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

  test('a loop on that starts nothing is asked again, backing off, and the person told with its reply', async ($, on) => {
    const w = world(on)
    w.loopReply = 'A session goal is active ("x"): /goal-mode clear it before starting the loop.'
    await planned($, w)
    await w.clock.advance(30_000)
    expect(w.commands).toEqual(['goal-mode loop on'])
    // Nothing is logged: the grant stands, and the loop is asked again.
    for (let i = 0; i < 40; i++) await w.clock.advance(30_000)
    expect(w.commands.filter(c => c === 'goal-mode loop on').length).toBeGreaterThanOrEqual(4)
    expect(w.commands.filter(c => c === 'goal-mode loop on').length).toBeLessThan(10)
    expect(w.notifies.some(n => n.includes('does not take the next milestone') && n.includes('A session goal is active'))).toBe(true)
    expect((await cmd($, 'status')).text).toContain('/goal-mode loop on starts nothing')
    expect(w.files.get(GATE)).toBe('1\n')

    // Once the loop starts it, the tries reset.
    log(w, [{ event: 'start', goal: 'add() returns a+b', worktree: '/repo/worktrees/goal-01-add', branch: 'goal/01-add' }])
    await w.clock.advance(30_000)
    expect((await cmd($, 'status')).text).not.toContain('starts nothing')
  })

  test('a run from before the credit gate has its absolute gate rewritten, then one start granted', async ($, on) => {
    const old = { on: true, phase: 'run', root: '/repo', sessionId: 'me', hint: '', round: 1, startedAt: Date.now(), remote: 'origin', defaultBranch: 'main', ciMode: 'local', logOffset: 0, started: 1, finished: 1, gate: 2, kicked: 2, worktrees: {}, ships: [], fixes: {}, merges: 1, held: 0, queueEmpty: false }
    const w = world(on, { 'auto:/repo': old })
    w.files.set(GATE, '2\n')
    w.files.set('/repo/.claude/goals.md', QUEUE.replace('- [ ] add', '- [x] add'))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await w.clock.advance(30_000)
    expect(w.files.get(GATE)).toBe('1\n')
    await w.clock.advance(30_000)
    expect(w.commands).toEqual(['goal-mode loop on'])
  })

  test('a run whose owning session went quiet is reported elsewhere, unattended rules kept out, and resumed on request', async ($, on) => {
    const other = { on: true, phase: 'run', root: '/repo', sessionId: 'gone', hint: '', round: 1, startedAt: Date.now(), beatAt: -20 * MIN, remote: 'origin', defaultBranch: 'main', ciMode: 'local', logOffset: 0, started: 1, finished: 1, credit: true, worktrees: {}, ships: [], fixes: {}, merges: 1, held: 0, queueEmpty: false }
    const w = world(on, { 'auto:/repo': other })
    w.files.set('/repo/.claude/goals.md', QUEUE.replace('- [ ] add', '- [x] add'))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const composed = await $.prompt.compose({ sections: [], text: '', model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(JSON.stringify(composed)).not.toContain('auto-claude:policy')
    await w.clock.advance(30_000)
    await w.clock.advance(30_000)
    expect(w.notifies.filter(n => n.includes('went quiet'))).toHaveLength(1)
    expect(w.commands).toEqual([])

    expect((await cmd($, 'resume')).text).toContain('Resumed: phase run')
    await w.clock.advance(30_000)
    await w.clock.advance(30_000)
    expect(w.commands).toEqual(['goal-mode loop on'])
    expect(JSON.stringify(await $.prompt.compose({ sections: [], text: '', model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never))).toContain('auto-claude:policy')
  })

  test('a run still planning is reminded with what the files lack, then stopped', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await cmd($, 'start')
    await w.clock.advance(200)
    expect(w.prompts).toHaveLength(1)
    await w.clock.advance(16 * MIN)
    expect(w.prompts[1]).toContain('Reminder 1/3')
    expect(w.prompts[1]).toContain('auto-plan.md is missing')
    for (let i = 0; i < 3; i++) await w.clock.advance(16 * MIN)
    expect(w.prompts.filter(p => p.includes('Reminder'))).toHaveLength(3)
    expect((await cmd($, 'status')).text).toContain('no plan was accepted after 3 reminders')
    expect(w.files.get(GATE)).toBe('')
  })

  test('the same shipping error tick after tick is told once', async ($, on) => {
    const w = world(on)
    w.github = true
    w.gitGone = true
    await planned($, w)
    log(w, [
      { event: 'start', goal: 'add() returns a+b', worktree: '/repo/worktrees/goal-01-add', branch: 'goal/01-add' },
      { event: 'met', goal: 'add() returns a+b', branch: 'goal/01-add' },
    ])
    for (let i = 0; i < 14; i++) await w.clock.advance(30_000)
    // Not a CI failure, so no fix goal: it repeats, and is told exactly once.
    expect(w.notifies.filter(n => n.includes('stuck at push') && n.includes('ENOENT'))).toHaveLength(1)
  })

  test('a milestone whose worktree was removed is made again from its branch, or held when the branch is gone too', async ($, on) => {
    const w = world(on)
    await planned($, w)
    log(w, [
      { event: 'start', goal: 'add() returns a+b', worktree: '/repo/worktrees/goal-01-add', branch: 'goal/01-add' },
      { event: 'met', goal: 'add() returns a+b', branch: 'goal/01-add' },
    ])
    w.gone.add('/repo/worktrees/goal-01-add')
    await w.clock.advance(30_000)
    expect(w.runs).toContain('git -C /repo worktree add /repo/worktrees/goal-01-add goal/01-add')
    await w.clock.advance(30_000)
    expect(w.pushes.some(p => p.includes('HEAD:main'))).toBe(true)

    // The next one loses its branch as well: held and told, not retried forever.
    log(w, [
      { event: 'start', goal: 'sub() returns a-b', worktree: '/repo/worktrees/goal-02-sub', branch: 'goal/02-sub' },
      { event: 'met', goal: 'sub() returns a-b', branch: 'goal/02-sub' },
    ])
    w.gone.add('/repo/worktrees/goal-02-sub')
    w.branchGone = true
    await w.clock.advance(30_000)
    expect(w.notifies.some(n => n.includes('held') && n.includes('branch goal/02-sub are gone'))).toBe(true)
  })

  test('a run started over a stale stop file keeps running, and resume sets one aside too', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/.claude/auto-claude.stop', '')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect((await cmd($, 'start')).text).toContain('moved to .claude/auto-claude.stop.cleared')
    expect(w.files.has('/repo/.claude/auto-claude.stop')).toBe(false)
    expect(w.files.has('/repo/.claude/auto-claude.stop.cleared')).toBe(true)
    expect(w.files.get('/repo/.git/info/exclude')).toContain('.claude/auto-claude.stop.cleared')
    for (let i = 0; i < 3; i++) await w.clock.advance(30_000)
    expect((await cmd($, 'status')).text).toContain('auto-claude on · phase plan')

    // A stop file written while the run is on still stops it.
    w.files.set('/repo/.claude/auto-claude.stop', '')
    await w.clock.advance(30_000)
    expect((await cmd($, 'status')).text).toContain('phase stopped')

    // Resuming is the person's word to go on: the file is set aside again.
    expect((await cmd($, 'resume')).text).toContain('moved to .claude/auto-claude.stop.cleared')
    for (let i = 0; i < 3; i++) await w.clock.advance(30_000)
    expect((await cmd($, 'status')).text).toContain('auto-claude on')
  })

  test('github: a met milestone with green CI reaches its successor\'s start in one tick; a pending CI is looked at every 10 s', async ($, on) => {
    const w = world(on)
    w.github = true
    await planned($, w)
    await w.clock.advance(30_000)
    expect(w.commands).toEqual(['goal-mode loop on'])

    // Met, CI already green: push, PR, checks, landing, grant and loop on in one tick.
    log(w, [
      { event: 'start', goal: 'add() returns a+b', worktree: '/repo/worktrees/goal-01-add', branch: 'goal/01-add' },
      { event: 'met', goal: 'add() returns a+b', branch: 'goal/01-add' },
      { event: 'gated', goal: 'sub() returns a-b' },
    ])
    w.files.set('/repo/.claude/goals.md', QUEUE.replace('- [ ] add', '- [x] add'))
    await w.clock.advance(30_000)
    expect(w.merged).toHaveLength(1)
    expect(w.files.get(GATE)).toBe('1\n')
    expect(w.commands).toEqual(['goal-mode loop on', 'goal-mode loop on'])

    // The next one's CI is pending: looked at again within 10 s, landed once green.
    log(w, [
      { event: 'start', goal: 'sub() returns a-b', worktree: '/repo/worktrees/goal-02-sub', branch: 'goal/02-sub' },
      { event: 'met', goal: 'sub() returns a-b', branch: 'goal/02-sub' },
    ])
    w.checks = '[{"bucket":"pending"}]'
    await w.clock.advance(30_000)
    expect(w.merged).toHaveLength(1)
    const looks = w.ciLooks
    w.checks = '[{"bucket":"pass"}]'
    await w.clock.advance(10_000)
    expect(w.ciLooks).toBe(looks + 1)
    expect(w.merged).toHaveLength(2)
  })

  test('github: no checks reported right after the PR opens waits for the grace, then counts as no CI', async ($, on) => {
    const w = world(on)
    w.github = true
    w.checks = ''
    await planned($, w)
    log(w, [
      { event: 'start', goal: 'add() returns a+b', worktree: '/repo/worktrees/goal-01-add', branch: 'goal/01-add' },
      { event: 'met', goal: 'add() returns a+b', branch: 'goal/01-add' },
    ])
    await w.clock.advance(30_000)
    // Opened this tick: GitHub has not registered its checks yet.
    expect(w.merged).toHaveLength(0)
    for (let i = 0; i < 4; i++) await w.clock.advance(30_000)
    expect(w.merged).toHaveLength(1)
  })

  test('session.start draws the piece even with no run (taking down a stale one); session.end clears it by the ending id', async ($, on) => {
    const w = world(on)
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    const PIECE = '/home/.claude/statusline/me/auto-claude.txt'
    w.files.set(PIECE, 'auto·R1·M2/7')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(w.files.get(PIECE)).toBe('')
    await cmd($, 'start')
    expect(w.files.get(PIECE)).toContain('auto·R1·plan')
    await $.session.end({ reason: 'clear', sessionId: 'me' })
    expect(w.files.get(PIECE)).toBe('')
  })
})
