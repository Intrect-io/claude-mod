import type { EngineInterface } from 'claude-code'

import { issueIds } from './ship-gate'

// The deterministic part of ~/.claude/commands/commit.md as one tool call:
// branch and default branch, what is staged, remote and PR state, issue IDs
// in the branch name. The model writes only the commit message.

export const PREFLIGHT_TOOL = {
  name: 'commit_preflight',
  description:
    'Before committing (the /commit flow): returns the branch and whether it is the default branch, staged/unstaged/untracked files, ' +
    'the last commits, whether the branch exists on origin, an open PR for it, upstream ahead/behind, and Linear issue IDs in the branch name. ' +
    'Call it once at the start of /commit instead of running git status, git log, git ls-remote and gh pr list yourself.',
  inputSchema: { type: 'object', properties: {} },
  isDeferred: false,
} as const

async function run($: EngineInterface, argv: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  try {
    const ran = await $.process.run(argv, { timeoutMs })
    return { ok: ran.exitCode === 0, out: ran.stdout.trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

export type Porcelain = { staged: string[]; unstaged: string[]; untracked: string[] }

export function splitPorcelain(porcelain: string): Porcelain {
  const result: Porcelain = { staged: [], unstaged: [], untracked: [] }
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const path = line.slice(3)
    if (line.startsWith('??')) {
      result.untracked.push(path)
      continue
    }
    if (line[0] !== ' ') result.staged.push(path)
    if (line[1] !== ' ') result.unstaged.push(path)
  }

  return result
}

const listed = (label: string, items: readonly string[], max = 30) =>
  `${label} (${items.length}): ${items.length === 0 ? '-' : items.slice(0, max).join(', ')}${items.length > max ? ', …' : ''}`

export async function commitPreflight($: EngineInterface): Promise<string> {
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'])
  if (!top.ok) return 'Not inside a git repository.'
  const branch = (await run($, ['git', 'branch', '--show-current'])).out
  const [status, log, remote, pr, counts, head] = await Promise.all([
    run($, ['git', 'status', '--porcelain']),
    run($, ['git', 'log', '-3', '--oneline']),
    branch === '' ? Promise.resolve({ ok: false, out: '' }) : run($, ['git', 'ls-remote', '--heads', 'origin', branch]),
    branch === '' ? Promise.resolve({ ok: false, out: '' }) : run($, ['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '-q', '.[0] | "#\\(.number) \\(.url)"']),
    run($, ['git', 'rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    run($, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
  ])
  const defaultBranch = head.ok ? head.out.replace(/^origin\//, '') : undefined
  const files = splitPorcelain(status.out)
  const [behind = '0', ahead = '0'] = counts.out.split(/\s+/)
  const ids = issueIds(branch)
  const warnings = [
    branch === '' ? 'Detached HEAD: create a branch before committing.' : undefined,
    branch !== '' && (branch === defaultBranch || branch === 'main' || branch === 'master')
      ? `On ${branch}, a main-line branch: commit.md's safety rule 1 says work on a feature branch. Create one first unless the user asked for this.`
      : undefined,
    files.staged.length + files.unstaged.length + files.untracked.length === 0 ? 'Nothing to commit.' : undefined,
    counts.ok && behind !== '0' ? `Behind upstream by ${behind}: pull/rebase before pushing; never force-push.` : undefined,
  ].filter((line): line is string => line !== undefined)

  return [
    `repo: ${top.out}`,
    `branch: ${branch || '(detached)'} · default: ${defaultBranch ?? 'unknown (no origin/HEAD)'}`,
    listed('staged', files.staged),
    listed('unstaged', files.unstaged),
    listed('untracked', files.untracked),
    `last commits:\n${log.out || '(none)'}`,
    `on origin: ${remote.out === '' ? 'no (push with -u)' : 'yes'} · upstream: ${counts.ok ? `ahead ${ahead} / behind ${behind}` : 'none'}`,
    `open PR for this branch: ${pr.out === '' ? 'none (create one)' : `${pr.out} (do not create another)`}`,
    `issue IDs in branch: ${ids.length === 0 ? 'none' : ids.join(', ')}`,
    ...(warnings.length === 0 ? [] : ['warnings:', ...warnings.map(w => `- ${w}`)]),
  ].join('\n')
}
