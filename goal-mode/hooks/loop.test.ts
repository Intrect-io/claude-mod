import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const ROOT = '/repo'
const QUEUE = `- [ ] fix add :: check: pytest -q
- [ ] fix mul :: check: pytest -q
`
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PRESENTATION = { isFullscreen: false, columns: 80 }
const STOP = { stop_hook_active: false, last_assistant_message: 'done', transcript_path: '/tmp/s.jsonl' }

type World = {
  files: Map<string, string>
  prompts: string[]
  worktrees: string[]
  // Every git worktree add argv, for the base ref.
  adds: string[][]
  checkExit: number
  dirty: string
  verdicts: string[]
  evaluations: number
  notifications: string[]
  clock: ReturnType<typeof mock.clock>
}

// The engine and the machine beneath the plugin: files in memory, git and the
// check answered by argv, prompts recorded.
function world(on: On, queue = QUEUE, store: Record<string, unknown> = {}): World {
  const w: World = {
    files: new Map([
      [`${ROOT}/.claude/goals.md`, queue],
      [`${ROOT}/.git/info/exclude`, '# git ls-files --others --exclude-from=.git/info/exclude\n'],
      ['/tmp/s.jsonl', ''],
    ]),
    prompts: [],
    worktrees: [],
    adds: [],
    checkExit: 1,
    dirty: '',
    verdicts: [],
    evaluations: 0,
    notifications: [],
    clock: mock.clock(on, { now: 0 }),
  }
  mock.store(on, store)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__goal-mode__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', (_, e) => {
    w.notifications.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('process.run', (_, e) => {
    const argv = e.argv
    const ok = (stdout = '', exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv.includes('rev-parse')) return ok(`${ROOT}/.git\n`)
    if (argv.includes('worktree')) {
      w.worktrees.push(String(argv[5]))
      w.adds.push([...argv])
      return ok()
    }
    if (argv[0] === 'bash') return ok(w.checkExit === 0 ? '2 passed' : '1 failed', w.checkExit)
    if (argv.includes('status')) return ok(w.dirty)
    return ok('', 1)
  })
  on('model.complete', () => {
    w.evaluations++
    return { value: { isAnswered: true as const, text: w.verdicts.shift() ?? '{"met": false, "reason": "x"}', usage: USAGE } }
  })
  on('tool.call', () => ({ result: 'ran' }))

  return w
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', session_id: 'me' })
}

const command = ($: Engine, args: string) =>
  $.command.run({ command: 'goal-mode', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

// Prompts are sent from a timer after the hook that decided them returned.
async function loopOn($: Engine, w: World) {
  const reply = await command($, 'loop on')
  await w.clock.advance(1_000)

  return reply
}

describe('loop', () => {
  test('a gate holds the loop before the next goal; raising it and loop on goes on', async ($, on) => {
    const w = world(on)
    w.checkExit = 0
    w.verdicts.push('{"met": true, "reason": "ok"}')
    w.files.set(`${ROOT}/.claude/goal-loop.gate`, '1\n')
    await start($)
    await loopOn($, w)
    expect(w.worktrees).toHaveLength(1)

    await $.classic.Stop(STOP)
    await w.clock.advance(1_000)
    expect(w.worktrees).toHaveLength(1)
    expect(w.files.get(`${ROOT}/.claude/goal-loop.log`)).toContain('"event":"gated"')

    w.files.set(`${ROOT}/.claude/goal-loop.gate`, '2')
    const reply = await loopOn($, w)
    expect(reply.text).toContain('started "fix mul"')
    expect(w.worktrees).toHaveLength(2)
  })

  test('worktrees start from goal-loop.base, or the line\'s own :: base:', async ($, on) => {
    const w = world(on, `- [ ] fix add :: check: pytest -q :: base: goal/07-pr-branch
- [ ] fix mul :: check: pytest -q
`)
    w.checkExit = 0
    w.verdicts.push('{"met": true, "reason": "ok"}')
    w.files.set(`${ROOT}/.claude/goal-loop.base`, 'origin/main\n')
    await start($)
    await loopOn($, w)
    expect(w.adds[0]?.at(-1)).toBe('goal/07-pr-branch')
    expect(w.prompts[0]).toContain('Goal #1: fix add')
    await $.classic.Stop(STOP)
    await w.clock.advance(1_000)
    expect(w.adds[1]?.at(-1)).toBe('origin/main')
  })

  test('loop on takes the first goal into its own worktree and queues the kickoff', async ($, on) => {
    const w = world(on)
    await start($)

    const reply = await loopOn($, w)
    expect(reply.text).toContain('started "fix add"')
    expect(w.worktrees).toEqual([`${ROOT}/worktrees/goal-01-fix-add`])
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('goal/01-fix-add')
    expect(w.files.get(`${ROOT}/.git/info/exclude`)).toContain('worktrees/')
    expect(w.files.get(`${ROOT}/.git/info/exclude`)).toContain('.claude/goals.md')
  })

  test('a failing check blocks without asking the model', async ($, on) => {
    const w = world(on)
    await start($)
    await loopOn($, w)

    const stop = await $.classic.Stop(STOP)
    expect(stop.block).toContain('exited 1')
    expect(w.evaluations).toBe(0)
  })

  test('uncommitted changes block even when the check passes', async ($, on) => {
    const w = world(on)
    w.checkExit = 0
    w.dirty = ' M counter.py'
    await start($)
    await loopOn($, w)

    expect((await $.classic.Stop(STOP)).block).toContain('uncommitted')
    expect(w.evaluations).toBe(0)
  })

  test('met marks the line done and starts the next goal; the stop does not wait on the prompt', async ($, on) => {
    const w = world(on)
    w.checkExit = 0
    w.verdicts.push('{"met": true, "reason": "2 passed"}')
    await start($)
    await loopOn($, w)

    const stop = await $.classic.Stop(STOP)
    expect(stop.block).toBeUndefined()
    expect(w.evaluations).toBe(1)
    await w.clock.advance(1_000)
    expect(w.files.get(`${ROOT}/.claude/goals.md`)).toMatch(/- \[x\] fix add :: check: pytest -q <!-- done/)
    expect(w.worktrees).toHaveLength(2)
    expect(w.prompts).toHaveLength(2)
    expect(w.prompts[1]).toContain('Goal #2: fix mul')
    expect(w.files.get(`${ROOT}/.claude/goal-loop.log`)).toContain('"event":"met"')
  })

  test('stuck: two delayed retries with a change of approach, then blocked and the next goal', async ($, on) => {
    const w = world(on)
    await start($)
    await loopOn($, w)

    for (let round = 1; round <= 3; round++) {
      for (let i = 1; i <= 4; i++) expect((await $.classic.Stop(STOP)).block).toBeDefined()
      expect((await $.classic.Stop(STOP)).block).toBeUndefined()
      if (round < 3) {
        expect(w.prompts).toHaveLength(round)
        await w.clock.advance(120_000)
        expect(w.prompts).toHaveLength(round + 1)
        expect(w.prompts[round]).toContain(`Retry ${round}/2`)
      }
    }
    expect(w.files.get(`${ROOT}/.claude/goals.md`)).toMatch(/- \[!\] fix add/)
    await w.clock.advance(1_000)
    expect(w.prompts.at(-1)).toContain('Goal #2: fix mul')
    expect(w.notifications.some(text => text.includes('blocked'))).toBe(true)
  })

  test('defer_goal is refused early, then applied at the next stop', async ($, on) => {
    const w = world(on)
    await start($)
    await loopOn($, w)

    const early = await $.tool.call({ tool: 'mcp__goal-mode__defer_goal', reason: 'needs API key' })
    expect(early.deny).toContain('Too early')

    await $.classic.Stop(STOP)
    await $.classic.Stop(STOP)
    const accepted = await $.tool.call({ tool: 'mcp__goal-mode__defer_goal', reason: 'needs API key' })
    expect(accepted.deny).toBeUndefined()
    // Nothing moves until the stop.
    expect(w.files.get(`${ROOT}/.claude/goals.md`)).toBe(QUEUE)

    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect(w.files.get(`${ROOT}/.claude/goals.md`)).toMatch(/- \[!\] fix add .*deferred.*needs API key/)
    await w.clock.advance(1_000)
    expect(w.prompts.at(-1)).toContain('fix mul')
  })

  test('guards apply while the loop runs, and only then', async ($, on) => {
    world(on, '- [ ] only goal :: check: true\n')
    await start($)

    expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' })).deny).toBeUndefined()

    await command($, 'loop on')
    const wt = `${ROOT}/worktrees/goal-01-only-goal`
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] })).deny).toContain('nobody can answer')
    expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' })).deny).toContain('main')
    expect((await $.tool.call({ tool: 'Bash', command: 'git push -u origin goal/01-only-goal' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/a.py`, old_string: 'a', new_string: 'b' })).deny).toContain('worktree')
    expect((await $.tool.call({ tool: 'Edit', file_path: `${wt}/a.py`, old_string: 'a', new_string: 'b' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'mcp__goal-mode__set_goal', condition: 'x' })).deny).toContain('loop is running')
  })

  test('an empty queue turns the loop off and the guards with it', async ($, on) => {
    const w = world(on, '- [x] all done\n')
    await start($)

    expect((await command($, 'loop on')).text).toContain('no pending goals')
    expect(w.notifications.some(text => text.includes('queue finished'))).toBe(true)
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] })).deny).toBeUndefined()
    expect((await command($, 'loop status')).text).toContain('Loop off')
  })

  test('another session that was active recently keeps the loop', async ($, on) => {
    world(on, QUEUE, {
      [`loop:${ROOT}`]: { on: true, repoRoot: ROOT, sessionId: 'other', heartbeatAt: Date.now(), seq: 1, retries: 0 },
    })
    await start($)

    expect((await command($, 'loop on')).text).toContain('Another session')
  })

  test('a resumed owner session picks its goal back up', async ($, on) => {
    const w = world(on, QUEUE, {
      [`loop:${ROOT}`]: {
      on: true,
      repoRoot: ROOT,
      sessionId: 'me',
      heartbeatAt: 0,
      seq: 1,
      retries: 0,
      current: { condition: 'fix add', check: 'pytest -q', worktree: `${ROOT}/worktrees/goal-01-fix-add`, branch: 'goal/01-fix-add', startedAt: 0 },
      },
    })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', session_id: 'me' })
    await w.clock.advance(1_000)

    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('Continuing (resumed session)')
    expect((await $.classic.Stop(STOP)).block).toContain('exited 1')
  })
})
