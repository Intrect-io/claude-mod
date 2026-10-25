import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const PRESENTATION = { isFullscreen: false, columns: 80 }
const STOP = { stop_hook_active: false, last_assistant_message: '완료했습니다.', transcript_path: '/tmp/s.jsonl' }

type World = {
  ran: string[]
  files: Map<string, string>
  prView: string
  toasts: string[]
  messages: Array<{ role: 'user' | 'assistant'; text: string; toolUses: never[] }>
  // Extra process answers a test adds: stdout for an argv, or undefined to fall through.
  proc?: (argv: readonly string[]) => string | undefined
  logs: string[]
}

// The engine beneath the plugin: tools answer with what they were given, so a
// test reads the command the guard let through.
function world(on: On, store: Record<string, unknown> = {}): World {
  const w: World = { ran: [], files: new Map([['/repo/.git/info/exclude', '# excludes\n']]), prView: '', toasts: [], messages: [], logs: [] }
  on('session.messages', () => ({ value: w.messages }))
  on('ui.log', (_, e) => {
    w.logs.push(String(e.text))
    return { value: undefined }
  })
  mock.store(on, store)
  mock.env(on, { HOME: '/Users/u', TMPDIR: '/var/folders/xx/T/' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = e.argv
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const extra = w.proc?.(argv)
    if (extra !== undefined) return out(extra)
    if (argv[0] === 'uname') return out('Darwin\n')
    if (argv[0] === 'test') return out('')
    if (argv.includes('rev-parse')) return out('/repo/.git\n')
    if (argv[0] === 'gh' && argv[2] === 'view') return out(w.prView)
    return out('', 1)
  })
  on('tool.call', (_, e) => {
    const input = e as unknown as { command?: string }
    w.ran.push(input.command ?? e.tool)
    return { result: input.command ?? 'ok' }
  })

  return w
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

const command = ($: Engine, args: string) =>
  $.command.run({ command: 'harness', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

const prompt = ($: Engine, text: string) => $.classic.UserPromptSubmit({ prompt: text, permission_mode: 'default' })

describe('guards', () => {
  test('rewrites Python to run in the venv and refuses a plain rm', async ($, on) => {
    const w = world(on)
    await start($)

    const py = await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
    expect(w.ran.at(-1)).toBe('source /Users/u/dev/mlx_env/bin/activate && pytest -q')
    expect(py.context?.join(' ')).toContain('inside the platform venv')

    const rm = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(rm.deny).toContain('trash')
    expect(w.ran).toHaveLength(1)
  })

  test('a successful worktree add puts worktrees/ in .git/info/exclude', async ($, on) => {
    const w = world(on)
    await start($)

    await $.tool.call({ tool: 'Bash', command: 'git worktree add worktrees/feat -b feat' })
    expect(w.files.get('/repo/.git/info/exclude')).toContain('worktrees/')
    expect((await $.tool.call({ tool: 'Bash', command: 'git worktree add /tmp/feat' })).deny).toContain('/repo/worktrees')
  })

  test('turned off, commands pass untouched, and the choice is stored', async ($, on) => {
    const w = world(on)
    await start($)

    expect((await command($, 'off guards')).text).toContain('guards off')
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(w.ran.at(-1)).toBe('rm -rf build')

    // A new session start reloads the toggles from the store: still off.
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'rm notes.txt' })
    expect(w.ran.at(-1)).toBe('rm notes.txt')
  })
})

describe('ship-gate', () => {
  test('a merged PR must close the issues the user handed over, Done and comment', async ($, on) => {
    const w = world(on)
    w.prView = JSON.stringify({ title: 'feat: x (QQQ-1)', body: 'also ZZZ-2', commits: [] })
    await start($)
    await prompt($, 'QQQ-1 작업 PR 머지해줘')

    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 5 --squash' })
    expect(w.toasts.some(text => text.includes('ZZZ-2'))).toBe(true)

    const first = await $.classic.Stop(STOP)
    expect(first.block).toContain('QQQ-1')
    expect(first.block).not.toContain('ZZZ-2')

    await $.tool.call({ tool: 'mcp__linear-server__save_issue', id: 'QQQ-1', state: 'Done' })
    const second = await $.classic.Stop(STOP)
    expect(second.block).toContain('evidence comment')

    await $.tool.call({ tool: 'mcp__linear-server__save_comment', issueId: 'QQQ-1', body: 'merged in abc1234' })
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
  })

  test('the stop block gives up after two tries', async ($, on) => {
    const w = world(on)
    w.prView = 'QQQ-1'
    await start($)
    await prompt($, 'QQQ-1')
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 5' })

    expect((await $.classic.Stop(STOP)).block).toBeDefined()
    expect((await $.classic.Stop(STOP)).block).toBeDefined()
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
    expect(w.toasts.some(text => text.includes('still not closed'))).toBe(true)
  })

  test('a release needs the open-PR check and CodeQL, which only the user can waive', async ($, on) => {
    const w = world(on)
    await start($)

    const first = await $.tool.call({ tool: 'Bash', command: 'gh release create v1.0.0' })
    expect(first.deny).toContain('gh pr list')
    expect(first.deny).toContain('CodeQL')

    await $.tool.call({ tool: 'Bash', command: 'gh pr list --author @me' })
    const second = await $.tool.call({ tool: 'Bash', command: 'gh release create v1.0.0' })
    expect(second.deny).not.toContain('gh pr list')
    expect(second.deny).toContain('CodeQL')

    await command($, 'skip-codeql')
    expect((await $.tool.call({ tool: 'Bash', command: 'gh release create v1.0.0' })).deny).toBeUndefined()
    expect(w.ran.at(-1)).toBe('gh release create v1.0.0')
  })
})

describe('report-lint', () => {
  test('on by default; off, it is silent; on, it nudges once per turn and resets on the next prompt', async ($, on) => {
    world(on)
    await start($)
    await command($, 'off report-lint')
    await prompt($, '고쳐줘')
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.py', content: 'x = 1\n' })
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()

    await command($, 'on report-lint')
    await prompt($, '다시 고쳐줘')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py', old_string: '1', new_string: '2' })
    const first = await $.classic.Stop(STOP)
    expect(first.block).toContain('SELF-AUDIT')
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()

    await prompt($, '설명해줘')
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
  })

  test('a markdown edit is not a code change', async ($, on) => {
    world(on, { toggles: { guards: true, shipGate: true, reportLint: true } })
    await start($)
    await prompt($, '문서 고쳐줘')
    await $.tool.call({ tool: 'Edit', file_path: '/repo/README.md', old_string: 'a', new_string: 'b' })
    expect((await $.classic.Stop(STOP)).block).toBeUndefined()
  })

  test('subagent stops are left alone', async ($, on) => {
    world(on, { toggles: { guards: true, shipGate: true, reportLint: true } })
    await start($)
    await prompt($, '고쳐줘')
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.py', content: 'x\n' })
    expect((await $.classic.Stop({ ...STOP, agent_id: 'a1' })).block).toBeUndefined()
  })
})

test('one stop carries one block: report-lint first, the ship gate on the next stop', async ($, on) => {
  const w = world(on, { toggles: { guards: true, shipGate: true, reportLint: true } })
  w.prView = 'QQQ-1'
  await start($)
  await prompt($, 'QQQ-1 고치고 머지')
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.py', content: 'x\n' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 5' })

  const first = await $.classic.Stop(STOP)
  expect(first.block).toContain('Report lint')
  expect(first.block).not.toContain('Ship gate')
  expect((await $.classic.Stop(STOP)).block).toContain('Ship gate')
})

describe('phase 1 guards', () => {
  test('Linear writes need a request; a reload counts earlier prompts', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, '테스트 고쳐줘')
    const create = await $.tool.call({ tool: 'mcp__linear-server__save_issue', title: 'x', team: 'T' })
    expect(create.deny).toContain('§1.5')

    await prompt($, '이거 리니어 이슈로 남겨줘')
    expect((await $.tool.call({ tool: 'mcp__linear-server__save_issue', title: 'x', team: 'T' })).deny).toBeUndefined()
    expect(w.ran.at(-1)).toBe('mcp__linear-server__save_issue')
  })

  test('a plugin loaded mid-session seeds the request from the transcript', async ($, on) => {
    const w = world(on)
    w.messages = [{ role: 'user', text: 'QQQ-7 진행해줘', toolUses: [] }]
    await start($)
    expect((await $.tool.call({ tool: 'mcp__linear-server__save_comment', issueId: 'QQQ-7', body: 'done' })).deny).toBeUndefined()
  })

  test('cancel needs an AskUserQuestion in the same turn', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'QQQ-1 정리해줘')
    expect((await $.tool.call({ tool: 'mcp__linear-server__save_issue', id: 'QQQ-1', state: 'Canceled' })).deny).toContain('approval')
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
    expect((await $.tool.call({ tool: 'mcp__linear-server__save_issue', id: 'QQQ-1', state: 'Canceled' })).deny).toBeUndefined()
  })

  test('unscoped list_issues, memory secrets, system Python, agent worktrees and orders', async ($, on) => {
    world(on)
    await start($)
    await prompt($, '정리해줘')
    expect((await $.tool.call({ tool: 'mcp__linear-server__list_issues', state: 'started' })).deny).toContain('list_issues')
    expect((await $.tool.call({ tool: 'mcp__linear-server__list_issues', project: 'P' })).deny).toBeUndefined()
    const secret = await $.tool.call({ tool: 'Write', file_path: '/Users/u/.claude/projects/-x/memory/a.md', content: 'ghp_' + 'c'.repeat(36) })
    expect(secret.deny).toContain('§7.5')
    expect((await $.tool.call({ tool: 'Bash', command: '/usr/bin/python3 -V' })).deny).toContain('system Python')
    expect((await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x', isolation: 'worktree' })).deny).toContain('worktrees/')
    expect((await $.tool.call({ tool: 'mcp__pykis-local__place_order', code: '005930' })).deny).toContain('approves')
  })
})

describe('phase 2', () => {
  const GRANT = JSON.stringify({ orchestrator: 'boss', expires_at: '2999-01-01T00:00:00Z', allowed: ['deploy'], forbidden: ['CLAUDE.md'] })
  const envelope = (name: string) => `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="${name}" from-mode="bypass">\nship it\n</cross-session-message>`

  test('a peer message carries the grant verdict on top', async ($, on) => {
    const w = world(on)
    w.files.set('/Users/u/.claude/orchestration-grant.json', GRANT)
    let seen = ''
    on('session.receive', (_, e) => {
      seen = e.text
      return { text: e.text }
    })
    await start($)

    await $.session.receive({ origin: { kind: 'peer' }, text: envelope('boss') })
    expect(seen.startsWith('[harness grant check')).toBe(true)
    expect(seen).toContain('VALID until')
    await $.session.receive({ origin: { kind: 'peer' }, text: envelope('mallory') })
    expect(seen).toContain('INVALID: sender "mallory"')
    await $.session.receive({ origin: { kind: 'bridge' }, text: 'hello' })
    expect(seen).toBe('hello')
  })

  test('memory-gc: a toast every session, the model reads it once per report', async ($, on) => {
    const w = world(on)
    w.files.set('/Users/u/.claude/memory-gc-report.json', JSON.stringify({ generated_at: 'g', broken_links: 3 }))
    on('classic.SessionStart', () => ({}))
    await start($)

    const first = await $.classic.SessionStart({ source: 'startup' })
    expect(first.additionalContext?.join('\n')).toContain('깨진 링크 3')
    const second = await $.classic.SessionStart({ source: 'startup' })
    expect(second.additionalContext ?? []).toEqual([])
    expect(w.toasts.filter(t => t.includes('Memory GC'))).toHaveLength(2)
  })

  test('/slim writes the context file with the files this session edited', async ($, on) => {
    const w = world(on)
    on('session.root', () => ({ value: '/repo' }))
    on('model.complete', () => ({ value: { isAnswered: true, text: '## 작업 요약\n테스트', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
    w.messages = [{ role: 'user', text: '고쳐줘', toolUses: [] }]
    await start($)
    await prompt($, 'QQQ-3 고쳐줘')
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.py', content: 'x\n' })

    const r = await $.command.run({ command: 'slim', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })
    expect(r.text).toContain('slim-context.md')
    const file = w.files.get('/Users/u/.claude/context/slim-context.md') ?? ''
    expect(file).toContain('- /repo/a.py')
    expect(file).toContain('## 작업 요약')
    expect(file).toContain('QQQ-3')
  })
})

describe('phase 3', () => {
  test('heartbeat fires only after a whole idle interval, and a user prompt defers it', async ($, on) => {
    const w = world(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    const submitted: string[] = []
    on('prompt.submit', (_, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })
    on('agent.list', () => ({ value: [] }))
    const statuses: string[] = []
    on('ui.status', (_, e) => {
      statuses.push(String((e as { text?: unknown }).text))
      return { value: undefined }
    })
    on('fs.stat', () => ({ deny: 'ENOENT' }))
    await start($)

    expect((await command($, 'heartbeat start 2m')).text).toContain('Heartbeat on')
    await clock.advance(60_000)
    expect(submitted).toHaveLength(0)
    await prompt($, '이거 같이 보자')
    await clock.advance(90_000)
    expect(submitted).toHaveLength(0)
    await clock.advance(60_000)
    expect(w.logs.filter(l => l.includes('heartbeat'))).toEqual([])
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.startsWith('[harness heartbeat]')).toBe(true)
    expect(submitted[0]).toContain('[harness heartbeat facts]')
    void w

    expect((await command($, 'heartbeat stop')).text).toContain('off')
    await clock.advance(600_000)
    expect(submitted).toHaveLength(1)
  })

  test("heartbeat refuses to start while goal-mode's loop is active", async ($, on) => {
    world(on)
    mock.clock(on, { now: 1_000_000 })
    on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 999_000, isLink: false } }))
    on('ui.status', () => ({ value: undefined }))
    await start($)
    expect((await command($, 'heartbeat start 5m')).text).toContain('goal-mode')
  })

  test('commit_preflight reports branch, files, PR and issue IDs', async ($, on) => {
    const w = world(on)
    w.proc = argv => {
      const a = argv.join(' ')
      if (a.includes('--show-toplevel')) return '/repo\n'
      if (a.includes('branch --show-current')) return 'feat/QQQ-9-x\n'
      if (a.includes('status --porcelain')) return 'M  a.ts\n?? b.ts\n'
      if (a.includes('ls-remote')) return ''
      if (a.includes('symbolic-ref')) return 'origin/main\n'
      if (a.startsWith('gh pr list')) return ''
      return undefined
    }
    await start($)
    const r = await $.tool.call({ tool: 'mcp__harness__commit_preflight' })
    const text = String(r.result)
    expect(text).toContain('branch: feat/QQQ-9-x · default: main')
    expect(text).toContain('staged (1): a.ts')
    expect(text).toContain('on origin: no (push with -u)')
    expect(text).toContain('issue IDs in branch: QQQ-9')
    // The branch's issue counts as mentioned: /commit may comment on it.
    expect((await $.tool.call({ tool: 'mcp__linear-server__save_comment', issueId: 'QQQ-9', body: 'PR' })).deny).toBeUndefined()
  })
})
