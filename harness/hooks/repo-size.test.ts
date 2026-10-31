import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  buildReport,
  checkLargeFiles,
  checkWorktreeGrowth,
  gcHint,
  goneBranches,
  isWorktreeAdd,
  mergedWorktrees,
  parseBranches,
  parseCountObjects,
  parseDu,
  readBudget,
  sizeSignature,
  stagedTargets,
  statusText,
  trashCandidates,
} from './repo-size'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const ROOT = '/Users/u/dev/repo'
const GB = 1024 * 1024
const MB = 1024 * 1024
const DU = [`${3 * GB}\t${ROOT}/worktrees`, `${2 * GB}\t${ROOT}/trash`, `${GB}\t${ROOT}/.git`, `100\t${ROOT}/src`, `${6 * GB + 100}\t${ROOT}`].join('\n')
const OBJECTS = 'count: 10\nsize: 1048576\nin-pack: 3\npacks: 1\nsize-pack: 2048\n'

describe('repo-size parsing', () => {
  test('du lines become a total and named entries', async () => {
    const { totalKb, entries } = parseDu(DU, ROOT)
    expect(totalKb).toBe(6 * GB + 100)
    expect(entries.map(entry => entry.name)).toEqual(['worktrees', 'trash', '.git', 'src'])
  })

  test('count-objects gives loose and pack sizes, and a gc hint when loose dominates', async () => {
    const sizes = parseCountObjects(OBJECTS)
    expect(sizes).toEqual({ looseKb: 1048576, packKb: 2048 })
    expect(gcHint(sizes)).toContain('git gc')
    expect(gcHint({ looseKb: 100, packKb: 2048 })).toBeUndefined()
  })

  test('the budget file sets the budget and ignored dirs; a bad file keeps 5 GB', async () => {
    expect(readBudget('{"budgetGB": 8, "ignore": ["db/"]}')).toEqual({ budgetKb: 8 * GB, ignore: ['db'] })
    expect(readBudget('not json').budgetKb).toBe(5 * GB)
    expect(readBudget(undefined)).toEqual({ budgetKb: 5 * GB, ignore: [] })
  })

  test('a report is over budget unless the ignored dirs bring it under', async () => {
    const over = buildReport(ROOT, 0, DU, OBJECTS, readBudget(undefined))
    expect(over.over).toBe(true)
    expect(over.top[0]?.name).toBe('worktrees')
    expect(statusText(over)).toBe('repo 6.0GB/5.0GB')

    const under = buildReport(ROOT, 0, DU, OBJECTS, readBudget('{"ignore": ["worktrees"]}'))
    expect(under.over).toBe(false)
    expect(statusText(under)).toBeUndefined()
    expect(sizeSignature(over)).not.toBe(sizeSignature(under))
  })
})

describe('repo-size guards', () => {
  const cases: Array<[string, ReturnType<typeof stagedTargets>]> = [
    ['git add big.bin', { paths: ['big.bin'], tracked: false }],
    ['git add -A', { paths: ['.'], tracked: false }],
    ['git add -u', { paths: ['.'], tracked: true }],
    ['git -C sub add .', { paths: ['.'], tracked: false }],
    ['git commit -am "add -A everything"', { paths: ['.'], tracked: true }],
    ['git commit --amend -m "x"', undefined],
    ['git status && git diff', undefined],
    ['echo "git add x"', undefined],
  ]
  for (const [command, expected] of cases) {
    test(`staged targets: ${command}`, async () => {
      expect(stagedTargets(command)).toEqual(expected)
    })
  }

  test('only non-LFS files over 50MB are refused', async () => {
    expect(checkLargeFiles([{ path: 'a.bin', bytes: 60 * MB, lfs: false }])).toContain('a.bin')
    expect(checkLargeFiles([{ path: 'a.bin', bytes: 60 * MB, lfs: true }])).toBeUndefined()
    expect(checkLargeFiles([{ path: 'a.txt', bytes: 10 * MB, lfs: false }])).toBeUndefined()
  })

  test('merged worktrees are found, the main checkout never', async () => {
    const porcelain = [
      `worktree ${ROOT}\nHEAD a\nbranch refs/heads/main`,
      `worktree ${ROOT}/worktrees/old\nHEAD b\nbranch refs/heads/feat/old`,
      `worktree ${ROOT}/worktrees/live\nHEAD c\nbranch refs/heads/feat/live`,
    ].join('\n\n')
    const merged = parseBranches('* main\n  feat/old\n+ feat/x\n')
    expect(merged).toEqual(['main', 'feat/old', 'feat/x'])
    expect(mergedWorktrees(porcelain, merged, ROOT)).toEqual([`${ROOT}/worktrees/old`])
    // A squash merge leaves the branch unmerged in git's eyes; its remote branch is gone.
    expect(goneBranches('feat/live \nfeat/squashed [gone]\nfeat/ahead [ahead 3]\n')).toEqual(['feat/squashed'])
  })

  test('a worktree add is refused only over budget with leftovers', async () => {
    const over = buildReport(ROOT, 0, DU, OBJECTS, readBudget(undefined))
    const under = buildReport(ROOT, 0, DU, OBJECTS, readBudget('{"budgetGB": 10}'))
    expect(checkWorktreeGrowth(over, ['/w/old'])).toContain('/w/old')
    expect(checkWorktreeGrowth(over, [])).toBeUndefined()
    expect(checkWorktreeGrowth(under, ['/w/old'])).toBeUndefined()
    expect(isWorktreeAdd('git worktree add worktrees/x -b x')).toBe(true)
    expect(isWorktreeAdd('git worktree remove worktrees/x')).toBe(false)
  })

  test('trash entries find named as moved in over 30 days ago, largest first', async () => {
    const sizes = [
      { name: 'new', kb: 900 },
      { name: 'old-small', kb: 10 },
      { name: 'old-big', kb: 500 },
    ]
    const found = `${ROOT}/trash/old-small\0${ROOT}/trash/old-big\0`
    expect(trashCandidates(sizes, found, `${ROOT}/trash`).map(entry => entry.name)).toEqual(['old-big', 'old-small'])
    expect(trashCandidates(sizes, '', `${ROOT}/trash`)).toEqual([])
  })
})

// --- Through the engine ---

type World = { ran: string[]; toasts: string[]; statuses: Array<string | undefined>; sizes: Map<string, number>; lfs: Set<string>; worktrees: string }

function world(on: On, store: Record<string, unknown> = {}): World {
  const w: World = { ran: [], toasts: [], statuses: [], sizes: new Map(), lfs: new Set(), worktrees: `worktree ${ROOT}\nHEAD a\nbranch refs/heads/main` }
  mock.store(on, store)
  mock.env(on, { HOME: '/Users/u', TMPDIR: '/var/folders/xx/T/' })
  on('session.messages', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/Users/u/dev/mlx_env/bin/activate' }))
  on('fs.stat', (_, e) => {
    const size = w.sizes.get(e.path)
    return size === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size, mtimeMs: 0, isLink: false } }
  })
  on('process.run', (_, e) => {
    const argv = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv.includes('--git-common-dir')) return out(`${ROOT}/.git\n`)
    if (argv.includes('--show-toplevel')) return out(`${ROOT}\n`)
    if (argv[0] === 'du') return out(DU)
    if (argv.includes('count-objects')) return out(OBJECTS)
    if (argv.includes('ls-files')) return out([...w.sizes.keys()].map(path => path.slice(ROOT.length + 1)).join('\0'))
    if (argv.includes('check-attr')) {
      return out(
        argv
          .slice(argv.indexOf('--') + 1)
          .map(path => `${path}: filter: ${w.lfs.has(path) ? 'lfs' : 'unspecified'}`)
          .join('\n'),
      )
    }
    if (argv.includes('list') && argv.includes('worktree')) return out(w.worktrees)
    if (argv.includes('symbolic-ref')) return out('origin/main\n')
    if (argv.includes('--merged')) return out('* main\n')
    if (argv.includes('for-each-ref')) return out('main \nfeat/old [gone]\n')
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
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

describe('repo-size in a session', () => {
  test('a 60MB non-LFS file is refused at git add; LFS-tracked it passes', async ($, on) => {
    const w = world(on)
    await start($)
    w.sizes.set(`${ROOT}/data/big.bin`, 60 * MB)
    w.sizes.set(`${ROOT}/src/a.ts`, 1_000)

    const denied = await $.tool.call({ tool: 'Bash', command: 'git add -A' })
    expect(denied.deny).toContain('data/big.bin')
    expect(denied.deny).not.toContain('a.ts')
    expect(w.ran).toHaveLength(0)

    w.lfs.add('data/big.bin')
    const allowed = await $.tool.call({ tool: 'Bash', command: 'git add -A' })
    expect(allowed.deny).toBeUndefined()
    expect(w.ran.at(-1)).toBe('git add -A')
  })

  test('the background measure shows the status, toasts, and gates a worktree add', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await start($)

    // Before any measurement there is nothing to judge a worktree add by.
    w.worktrees += `\n\nworktree ${ROOT}/worktrees/old\nHEAD b\nbranch refs/heads/feat/old`
    await $.tool.call({ tool: 'Bash', command: 'git worktree add worktrees/new -b new' })
    expect(w.ran.at(-1)).toBe('git worktree add worktrees/new -b new')

    await clock.advance(5_000)
    expect(w.statuses.at(-1)).toBe('repo 6.0GB/5.0GB')
    expect(w.toasts.some(text => text.includes('/repo-size'))).toBe(true)

    const denied = await $.tool.call({ tool: 'Bash', command: 'git worktree add worktrees/next -b next' })
    expect(denied.deny).toContain(`${ROOT}/worktrees/old`)
    expect((await $.tool.call({ tool: 'EnterWorktree', path: `${ROOT}/worktrees/next` })).deny).toContain('worktrees/old')
  })

  test('the next session start hands the model the breakdown once', async ($, on) => {
    const clock = mock.clock(on)
    world(on)
    await start($)
    await clock.advance(5_000)

    const first = await $.classic.SessionStart({ source: 'startup' })
    expect(first.additionalContext?.join('\n')).toContain('worktrees 3.0GB')
    const second = await $.classic.SessionStart({ source: 'startup' })
    expect(second.additionalContext?.join('\n') ?? '').not.toContain('repo-size')
  })

  test('/repo-size lists merged worktrees and lists, never deletes', async ($, on) => {
    const w = world(on)
    w.worktrees += `\n\nworktree ${ROOT}/worktrees/old\nHEAD b\nbranch refs/heads/feat/old`
    await start($)

    const ran = await $.command.run({ command: 'repo-size', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(ran.text).toContain('over budget')
    expect(ran.text).toContain(`${ROOT}/worktrees/old`)
    expect(ran.text).toContain('git gc')
  })

  test('turned off, nothing is measured or refused', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    await start($)
    await $.command.run({ command: 'harness', args: 'off repo-size', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    w.sizes.set(`${ROOT}/data/big.bin`, 60 * MB)

    await clock.advance(5_000)
    expect((await $.tool.call({ tool: 'Bash', command: 'git add -A' })).deny).toBeUndefined()
  })
})
