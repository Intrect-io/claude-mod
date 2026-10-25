import type { EngineInterface } from 'claude-code'

import { commandWords, expandHome, programOf, segments, stripProse } from './shell'

// Rules a single tool call can decide, beyond guards.ts. Deterministic ones
// refuse; heuristic ones (version bumps, leftover worktrees) only add a note.

const SECRET = [
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|api[_-]?key|secret)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
]

export function isMemoryPath(path: string, home: string | undefined): boolean {
  const full = expandHome(path, home)

  return /\/\.claude\/projects\/[^/]+\/memory\//.test(full)
}

// CLAUDE.md §7.5: no secrets in memory files.
export function checkMemorySecret(path: string, text: string, home: string | undefined): string | undefined {
  if (!isMemoryPath(path, home)) return undefined

  return SECRET.some(pattern => pattern.test(text))
    ? 'Harness rule (CLAUDE.md §7.5): this memory write holds what looks like a secret (key, token, password or private key). Memory never stores secrets; write the fact without the value.'
    : undefined
}

const SYSTEM_PYTHON = /^\/(usr\/bin|usr\/local\/bin|opt\/homebrew\/bin|bin)\/(python(\d+(\.\d+)?)?|pip3?|pytest)$/

// CLAUDE.md §3: an absolute system interpreter path bypasses the venv.
export function checkSystemPython(command: string): string | undefined {
  const used = segments(stripProse(command))
    .map(segment => commandWords(segment)[0] ?? '')
    .find(first => SYSTEM_PYTHON.test(first))

  return used === undefined
    ? undefined
    : `Harness rule (CLAUDE.md §3): ${used} is the system Python; run python/pytest/pip by name so the platform venv is used.`
}

// CLAUDE.md §3: worktrees live only under <repo>/worktrees/<name>, subagents included.
export function checkAgentWorktree(input: Record<string, unknown>): string | undefined {
  return input.isolation === 'worktree'
    ? 'Harness rule (CLAUDE.md §3): isolation "worktree" places the worktree outside <repo>/worktrees/. Create it with `git worktree add worktrees/<name> -b <branch>` and pass that folder as the agent\'s cwd instead.'
    : undefined
}

export const DEFAULT_ORDER_TOOLS = '^mcp__(pykis|pykiwoom|stockapi)[\\w-]*__.*(order|buy|sell|cancel)'

// rules/trading-systems.md: "주문 실행은 반드시 사용자 승인 후".
export function checkTradingOrder(tool: string, pattern: string, askUsed: boolean): string | undefined {
  let matcher: RegExp
  try {
    matcher = new RegExp(pattern, 'i')
  } catch {
    matcher = new RegExp(DEFAULT_ORDER_TOOLS, 'i')
  }
  if (!matcher.test(tool) || askUsed) return undefined

  return `Harness rule (rules/trading-systems.md): ${tool} places or changes an order; it runs only after the user approves it with AskUserQuestion in this turn.`
}

const BUMP_MESSAGE = /\b(bump(ed)? (the )?version|release v?\d+\.\d+|chore\(release\))/i

// Heuristic: a version bump without the open-PR check (linear-grooming §5).
export function isVersionBump(command: string): boolean {
  return segments(stripProse(command)).some(segment => {
    const words = commandWords(segment)
    const program = programOf(words)
    if ((program === 'npm' || program === 'pnpm' || program === 'yarn') && words[1] === 'version') return true
    if (program === 'cargo' && (words[1] === 'set-version' || words[1] === 'release')) return true
    if (program === 'poetry' && words[1] === 'version') return true

    return false
  }) || (/\bgit\b[^\n;&|]*\bcommit\b/.test(command) && BUMP_MESSAGE.test(command))
}

export function versionBumpNote(): string {
  return 'Harness note (rules/linear-grooming.md §5): this looks like a version bump. Before a release, check open PRs with `gh pr list --state open --author @me`.'
}

// Worktrees whose branch the merged PR came from (CLAUDE.md §3: remove merged
// worktrees right away). `porcelain` is `git worktree list --porcelain`.
export function leftoverWorktrees(porcelain: string, branch: string): string[] {
  const paths: string[] = []
  for (const block of porcelain.split('\n\n')) {
    const path = block.match(/^worktree (.+)$/m)?.[1]
    const ref = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]
    if (path !== undefined && ref === branch) paths.push(path)
  }

  return paths
}

export async function mergedWorktreeNote($: EngineInterface, pr: string): Promise<string | undefined> {
  try {
    const view = await $.process.run(['gh', 'pr', 'view', ...(pr === '' ? [] : [pr]), '--json', 'headRefName', '-q', '.headRefName'], { timeoutMs: 20_000 })
    const branch = view.stdout.trim()
    if (view.exitCode !== 0 || branch === '') return undefined
    const list = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { timeoutMs: 5_000 })
    const left = leftoverWorktrees(list.stdout, branch)
    if (left.length === 0) return undefined

    return `Harness note (CLAUDE.md §3): the merged branch ${branch} still has a worktree at ${left.join(', ')}. Check it has no uncommitted changes, then \`git worktree remove <path>\`.`
  } catch {
    return undefined
  }
}
