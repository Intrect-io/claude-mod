import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { DAY_MS, staleFolders } from './statusline-gc'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const NOW = 100 * DAY_MS
const HOUR = 60 * 60_000

describe('statusline sweep rule', () => {
  test('all-empty folders go after a day, filled ones after two weeks', async () => {
    const folders = [
      { id: 'empty-old', newestMtimeMs: NOW - 2 * DAY_MS, allEmpty: true },
      { id: 'empty-fresh', newestMtimeMs: NOW - HOUR, allEmpty: true },
      { id: 'filled-week', newestMtimeMs: NOW - 7 * DAY_MS, allEmpty: false },
      { id: 'filled-crashed', newestMtimeMs: NOW - 15 * DAY_MS, allEmpty: false },
    ]
    expect(staleFolders(folders, NOW, 'live')).toEqual(['filled-crashed', 'empty-old'])
  })

  test('the running session is never swept, however old', async () => {
    const folders = [
      { id: 'live', newestMtimeMs: 0, allEmpty: true },
      { id: 'other', newestMtimeMs: 0, allEmpty: true },
    ]
    expect(staleFolders(folders, NOW, 'live')).toEqual(['other'])
  })

  test('a backlog is capped, oldest first', async () => {
    const folders = [3, 1, 2].map(age => ({ id: `d${age}`, newestMtimeMs: NOW - (10 + age) * DAY_MS, allEmpty: true }))
    expect(staleFolders(folders, NOW, 'live', 2)).toEqual(['d3', 'd2'])
  })
})

// --- Through the engine ---

const HOME = '/Users/u'
const ROOT = `${HOME}/.claude/statusline`
const TRASH = `${HOME}/.claude/trash/statusline`

type File = { name: string; size: number; mtimeMs: number }
type World = { argv: string[][]; logs: string[]; dirs: Map<string, File[]>; trashed: Set<string> }

function world(on: On, now: number, store: Record<string, unknown> = {}): World {
  const w: World = {
    argv: [],
    logs: [],
    trashed: new Set(['old-filled']),
    dirs: new Map([
      ['live', [{ name: 'harness.txt', size: 0, mtimeMs: 0 }]],
      ['old-empty', [{ name: 'harness.txt', size: 0, mtimeMs: now - 2 * DAY_MS }]],
      ['old-filled', [{ name: 'harness.txt', size: 4, mtimeMs: now - 20 * DAY_MS }]],
      ['fresh-filled', [{ name: 'harness.txt', size: 4, mtimeMs: now - HOUR }]],
      ['no-files', []],
    ]),
  }
  mock.store(on, store)
  mock.env(on, { HOME })
  on('session.id', () => ({ value: 'live' }))
  on('session.messages', () => ({ value: [] }))
  on('ui.log', (_, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.exists', (_, e) => ({ value: e.path.startsWith(`${TRASH}/`) && w.trashed.has(e.path.slice(TRASH.length + 1)) }))
  on('fs.list', (_, e) => {
    if (e.path === ROOT) return { value: [...w.dirs.keys()].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
    const files = w.dirs.get(e.path.slice(ROOT.length + 1))
    return files === undefined ? { deny: 'ENOENT' } : { value: files.map(file => ({ ...file, kind: 'file' as const, isLink: false })) }
  })
  on('fs.stat', (_, e) => (e.path === `${ROOT}/no-files` ? { value: { kind: 'dir', size: 0, mtimeMs: now - 3 * DAY_MS, isLink: false } } : { deny: 'ENOENT' }))
  on('process.run', (_, e) => {
    w.argv.push([...e.argv])
    return { value: { exitCode: e.argv[0] === 'mv' || e.argv[0] === 'mkdir' ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return w
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true })
}

const moves = (w: World) => w.argv.filter(argv => argv[0] === 'mv' || argv[0] === 'mkdir')

describe('statusline sweep in a session', () => {
  test('stale folders move to the trash in the background; the live one stays', async ($, on) => {
    const clock = mock.clock(on)
    const now = clock.now()
    const w = world(on, now)
    await start($)
    expect(moves(w)).toEqual([])

    await clock.advance(10_000)
    const at = clock.now()
    expect(moves(w)).toEqual([
      ['mkdir', '-p', TRASH],
      ['mv', `${ROOT}/old-filled`, `${TRASH}/old-filled-${at}`],
      ['mv', `${ROOT}/no-files`, `${TRASH}/no-files`],
      ['mv', `${ROOT}/old-empty`, `${TRASH}/old-empty`],
    ])
    expect(w.argv.flat().some(arg => arg.includes('/live'))).toBe(false)
    expect(w.logs.some(text => text.includes('moved 3 folder(s)'))).toBe(true)
  })

  test('a sweep less than a day ago means no sweep now', async ($, on) => {
    const clock = mock.clock(on)
    const now = clock.now()
    const w = world(on, now, { statuslineGcAt: now - HOUR })
    await start($)
    await clock.advance(10_000)
    expect(moves(w)).toEqual([])
  })
})
