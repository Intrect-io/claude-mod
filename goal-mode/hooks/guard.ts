// Loop-mode guards: pure checks on a tool call while an unattended loop runs.
// Each returns the refusal text, or undefined to let the call through.
// Regexes are a second line of defence; worktree isolation and the push rules
// are the first.

export type GuardContext = {
  repoRoot: string
  worktree: string
  extraDeny: readonly string[]
}

const DEPLOY =
  /\b(kubectl|helm)\b|\bterraform\s+apply\b|\bdocker\s+push\b|\bgcloud\b[^\n;&|]*\bdeploy\b|\bfly(ctl)?\s+deploy\b|\bvercel\b/
const RESET_HARD = /\bgit\b[^\n;&|]*\breset\b[^\n;&|]*--hard\b/
const SUDO = /(^|[\s;&|(])sudo\s/
const PUSH = /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*/g
const FORCE = /(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S)/
const PROTECTED_BRANCH = /(^|[\s:/])(main|master)(\s|$)/
const RM_RF = /(^|[\s;&|(])rm\s+((?:-[a-zA-Z]+\s+)+)([^\n;&|]*)/g

// Message arguments and heredoc bodies are prose, not commands: a commit
// message that mentions "git push origin main" must not be refused. Other
// quoted strings (bash -c "...") are still checked.
const MESSAGE_ARG = /(\s(?:-m|--message|--body|--title))(=|\s+)("(?:\\.|[^"\\])*"|'[^']*')/g
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g

export function stripProse(command: string): string {
  return command.replace(MESSAGE_ARG, "$1$2''").replace(HEREDOC, "<<'$2'\n$2")
}

export function checkBash(raw: string, ctx: GuardContext): string | undefined {
  const command = stripProse(raw)
  for (const push of command.matchAll(PUSH)) {
    const text = push[0]
    if (FORCE.test(text)) {
      return 'Autonomous loop: force-push is refused.'
    }
    if (PROTECTED_BRANCH.test(text)) {
      return 'Autonomous loop: pushing main/master is refused; push only your goal/* branch.'
    }
    if (!/\bgoal\//.test(text)) {
      return 'Autonomous loop: name the branch when pushing: git push -u origin goal/<your-branch>.'
    }
  }
  if (RESET_HARD.test(command)) return 'Autonomous loop: git reset --hard is refused; commit or revert instead.'
  if (SUDO.test(command)) return 'Autonomous loop: sudo is refused.'
  if (DEPLOY.test(command)) return 'Autonomous loop: deploy and cluster commands are refused.'

  for (const rm of command.matchAll(RM_RF)) {
    const flags = rm[2] ?? ''
    if (!/r/i.test(flags) || !/f/.test(flags)) continue
    for (const target of (rm[3] ?? '').trim().split(/\s+/)) {
      if (target === '') continue
      if (!isSafeRmTarget(target, ctx.worktree)) {
        return `Autonomous loop: rm -rf ${target} is refused; only paths inside ${ctx.worktree} (or relative ones without ..) may be removed.`
      }
    }
  }

  for (const pattern of ctx.extraDeny) {
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch {
      continue
    }
    if (re.test(command)) return `Autonomous loop: refused by .claude/goal-loop.deny (${pattern}).`
  }

  return undefined
}

function isSafeRmTarget(target: string, worktree: string): boolean {
  const bare = target.replace(/^['"]|['"]$/g, '')
  if (bare.includes('..') || bare.startsWith('~') || bare.includes('$') || bare === '*' || bare === '.' || bare === '/') {
    return false
  }
  if (bare.startsWith('/')) return isInside(bare, worktree)

  return true
}

// Edits inside the repository but outside the goal's worktree would change the
// main checkout; anything outside the repository (scratch, memory) is allowed.
export function checkPath(filePath: string, ctx: GuardContext): string | undefined {
  if (!filePath.startsWith('/')) return undefined
  if (isInside(filePath, ctx.repoRoot) && !isInside(filePath, ctx.worktree)) {
    return `Autonomous loop: edits inside the repository must stay in the goal's worktree ${ctx.worktree}.`
  }

  return undefined
}

const ARTIFACT =
  /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|node_modules|target|dist|build|\.next)(\/|$)|\.py[co]$|(^|\/)\.DS_Store$/

// The `git status --porcelain` lines that still need a commit: any change to a
// tracked file, and new files other than build and cache artifacts (which
// running the check itself leaves behind).
export function uncommitted(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter(line => line.trim() !== '')
    .filter(line => !(line.startsWith('??') && ARTIFACT.test(line.slice(3).trim())))
}

export function isInside(path: string, dir: string): boolean {
  const base = dir.endsWith('/') ? dir : `${dir}/`

  return path === dir || path.startsWith(base)
}
