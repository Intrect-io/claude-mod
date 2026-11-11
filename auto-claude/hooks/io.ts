// Shared I/O of the driver: processes, files, notifications and the paths a run keeps.

import type { EngineInterface } from 'claude-code'

import type { AutoRecord } from '../types'

export const FILES = (root: string) => ({
  plan: `${root}/.claude/auto-plan.md`,
  queue: `${root}/.claude/goals.md`,
  log: `${root}/.claude/goal-loop.log`,
  deny: `${root}/.claude/goal-loop.deny`,
  stop: `${root}/.claude/auto-claude.stop`,
  exclude: `${root}/.git/info/exclude`,
})
export type Run = { exitCode: number; stdout: string; stderr: string }

export async function run($: EngineInterface, argv: string[], cwd: string, timeoutMs = 120_000): Promise<Run> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error) }
  }
}

export const out = (r: Run) => (r.stderr.trim() || r.stdout.trim()).slice(0, 400)

// A repository with no remote lands its milestones in its own default branch: its "remote" is itself.
export const LOCAL = '.'
export const refOf = (r: { remote: string; defaultBranch: string }, branch = r.defaultBranch) => (r.remote === LOCAL ? branch : `${r.remote}/${branch}`)
export async function fetchRemote($: EngineInterface, r: { remote: string }, cwd: string): Promise<void> {
  if (r.remote !== LOCAL) await run($, ['git', '-C', cwd, 'fetch', '-q', r.remote], cwd)
}

export async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

export async function tell($: EngineInterface, r: Pick<AutoRecord, 'root'>, text: string): Promise<void> {
  const line = `auto-claude (${r.root.split('/').pop()}): ${text}`
  $.ui.toast(line.slice(0, 200))
  try {
    await $.ui.notify(line, { title: 'auto-claude' })
  } catch {
    // No notification channel.
  }
}

export async function repoRoot($: EngineInterface, cwd: string): Promise<string | undefined> {
  const r = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, 15_000)
  const common = r.stdout.trim()
  return r.exitCode === 0 && common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : undefined
}

export async function ensureLines($: EngineInterface, path: string, lines: readonly string[], header: string): Promise<void> {
  const text = (await readText($, path)) ?? ''
  const have = new Set(text.split('\n').map(l => l.trim()))
  const missing = lines.filter(l => !have.has(l))
  if (missing.length === 0) return
  const head = text === '' || text.endsWith('\n') ? text : `${text}\n`
  await $.fs.write(path, `${head}${header}\n${missing.join('\n')}\n`)
}
