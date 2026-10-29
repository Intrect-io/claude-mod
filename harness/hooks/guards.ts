import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { GuardEnv } from '../types'
import { checkAgentWorktree, checkMemorySecret, checkSystemPython, checkTradingOrder, DEFAULT_ORDER_TOOLS, isVersionBump, versionBumpNote } from './extra-guards'
import { commandWords, expandHome, isInside, programOf, segments, stripProse, unquote } from './shell'
import { DEFAULT_TOGGLES, INITIAL_LINT, INITIAL_SHIP } from './state'
import type { ToolCallHook } from './state'

const envAtom = atom({ plugin: 'harness', key: 'env' } as const, {}, { shape: 'env-1' })
const togglesAtom = atom({ plugin: 'harness', key: 'toggles' } as const, DEFAULT_TOGGLES, { shape: 'toggles-1' })
const lintAtom = atom({ plugin: 'harness', key: 'lint' } as const, INITIAL_LINT, { shape: 'lint-1' })
const shipAtom = atom({ plugin: 'harness', key: 'ship' } as const, INITIAL_SHIP, { shape: 'ship-2' })
// The venv note was given in this session: once is enough (it rode every
// Python call, measured 2026-10-29, saying the same thing each time).
const venvNotedAtom = atom({ plugin: 'harness', key: 'venvNoted' } as const, false, { shape: 'venv-noted-1' })

// Always-on guards for the user's CLAUDE.md rules that a single tool call can
// decide. Each check is pure and returns the refusal text, or undefined.

const ATTRIBUTION = [/co-authored-by:/i, /generated with \[?claude/i, /noreply@anthropic\.com/i, /🤖\s*generated/i]

export function checkAttribution(command: string, files: readonly string[] = []): string | undefined {
  if (!/\bgit\b[^\n;&|]*\bcommit\b|\bgh\s+pr\s+(create|edit)\b/.test(command)) return undefined
  const text = [command, ...files].join('\n')
  if (ATTRIBUTION.some(pattern => pattern.test(text))) {
    return 'Harness rule (CLAUDE.md §5): no Co-Authored-By or AI attribution in commits or PRs; it overrides the default attribution. Remove those lines and run it again.'
  }

  return undefined
}

// Files a commit or PR body is read from (-F / --file / --body-file).
export function messageFiles(command: string): string[] {
  const files: string[] = []
  for (const segment of segments(command)) {
    const words = commandWords(segment)
    words.forEach((word, i) => {
      const next = words[i + 1]
      if ((word === '-F' || word === '--file' || word === '--body-file') && next !== undefined && next !== '-') files.push(next)
      const inline = word.match(/^--(?:file|body-file)=(.+)$/)
      if (inline?.[1] !== undefined) files.push(inline[1])
    })
  }

  return files
}

const WORKTREE_VALUE_FLAGS = new Set(['-b', '-B', '--reason', '--orphan'])

export function checkWorktree(command: string, env: GuardEnv, repoRoot?: string): string | undefined {
  for (const segment of segments(stripProse(command))) {
    const words = commandWords(segment)
    if (programOf(words) !== 'git') continue
    const add = words.indexOf('add')
    if (!words.includes('worktree') || add < 0) continue
    let path: string | undefined
    for (let i = add + 1; i < words.length; i++) {
      const word = words[i] ?? ''
      if (WORKTREE_VALUE_FLAGS.has(word)) {
        i++
        continue
      }
      if (word.startsWith('-')) continue
      path = word
      break
    }
    if (path === undefined) continue
    const full = expandHome(path, env.home)
    const bad =
      full.includes('.claude/worktrees') ||
      full.includes('/.codex/') ||
      full.startsWith('/tmp') ||
      full.startsWith('/private/') ||
      full.startsWith('../') ||
      full.includes('/../') ||
      !/(^|\/)worktrees\/[^/]+/.test(full) ||
      (full.startsWith('/') && repoRoot !== undefined && !isInside(full, `${repoRoot}/worktrees`))
    if (bad) {
      return `Harness rule (CLAUDE.md §3): worktrees live only under <repo>/worktrees/<name>${repoRoot ? ` (${repoRoot}/worktrees/…)` : ''}, never ${path}. Use: git worktree add worktrees/<name> -b <branch>.`
    }
  }

  return undefined
}

export function checkEnterWorktree(input: { name?: unknown; path?: unknown }): string | undefined {
  if (typeof input.path === 'string') {
    return /(^|\/)worktrees\//.test(input.path) && !input.path.includes('.claude/worktrees')
      ? undefined
      : 'Harness rule (CLAUDE.md §3): enter only worktrees under <repo>/worktrees/.'
  }

  return 'Harness rule (CLAUDE.md §3): EnterWorktree would create it under .claude/worktrees/. Create it with `git worktree add worktrees/<name> -b <branch>` and enter it with EnterWorktree path.'
}

// An absolute, normalized path: `target` against `cwd` when it is relative.
function resolvePath(target: string, cwd: string | undefined): string {
  const joined = target.startsWith('/') || cwd === undefined ? target : `${cwd}/${target}`
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return `/${parts.join('/')}`
}

// Deleting goes through a trash folder. Removing things already in a trash
// folder, or in temporary and scratch space, stays allowed. A relative target
// is judged where it lands from the session's cwd (and any `cd` before it), so
// `rm junk.txt` inside /tmp is allowed just like `rm /tmp/…/junk.txt`.
export function checkDelete(command: string, env: GuardEnv, cwd?: string): string | undefined {
  let dir = cwd
  const allowed = (target: string): boolean => {
    const expanded = expandHome(target, env.home)
    if (/(^|\/)trash(\/|$)/.test(expanded) && !expanded.includes('..')) return true
    if (!expanded.startsWith('/') && dir === undefined) return false
    const full = resolvePath(expanded, dir)
    const roots = ['/tmp', '/private/tmp', '/var/folders', env.tmpdir].filter((root): root is string => root !== undefined && root !== '')

    return roots.some(root => isInside(full, resolvePath(root, undefined)))
  }

  for (const segment of segments(stripProse(command))) {
    const words = commandWords(segment)
    const program = programOf(words)
    if (program === 'cd') {
      const to = words[1] === undefined ? env.home : expandHome(words[1], env.home)
      dir = to === undefined ? undefined : to.startsWith('/') ? resolvePath(to, undefined) : dir === undefined ? undefined : resolvePath(to, dir)
      continue
    }
    if (program === 'rm' || program === 'unlink' || program === 'rmdir') {
      const targets = words.slice(1).filter(word => !word.startsWith('-'))
      const blocked = targets.find(target => !allowed(target))
      if (blocked !== undefined) return deleteRefusal(blocked)
    }
    if (program === 'find' && words.includes('-delete')) {
      const root = words[1] ?? '.'
      if (!allowed(root)) return deleteRefusal(root)
    }
    if (program === 'git' && words[1] === 'clean' && words.some(word => /^-[a-zA-Z]*f/.test(word))) {
      return deleteRefusal('(git clean)')
    }
  }

  return undefined
}

function deleteRefusal(target: string): string {
  return `Harness rule (CLAUDE.md §3): do not delete ${target} directly; move it to a trash folder instead: mkdir -p trash && mv <path> trash/. (Paths already in a trash/ folder, /tmp and $TMPDIR may be removed.)`
}

export function checkForcePush(command: string): string | undefined {
  for (const segment of segments(stripProse(command))) {
    const words = commandWords(segment)
    if (programOf(words) !== 'git' || !words.includes('push')) continue
    const forced = words.some(
      word => word === '--force' || word === '-f' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(word) || (word.startsWith('+') && word.length > 1),
    )
    if (forced) {
      return 'Harness rule (concurrency F): force-push is refused; a rejected push means someone else pushed. Fetch and integrate, or use --force-with-lease on your own branch.'
    }
  }

  return undefined
}

const PYTHON = /^(python(\d+(\.\d+)?)?|pytest|pip3?)$/

// Prefixes the platform venv's activation when the command runs Python
// without one; an absolute interpreter path or an activation is left alone.
export function venvRewrite(command: string, env: GuardEnv): { command: string } | { deny: string } | undefined {
  if (/\bactivate\b|VIRTUAL_ENV=/.test(command)) return undefined
  const runsPython = segments(stripProse(command)).some(segment => {
    const first = commandWords(segment)[0] ?? ''

    return PYTHON.test(first)
  })
  if (!runsPython) return undefined
  if (env.venv === undefined) {
    return {
      deny: `Harness rule (CLAUDE.md §3): Python must run in the platform venv, but ${env.venvMissing ?? 'it'} does not exist. Create it (python3.12 -m venv) or tell the user; do not use the system Python.`,
    }
  }

  return { command: `source ${env.venv} && ${command}` }
}

const WRONG_PORT = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0):1234\b/

export function checkLlmPort(text: string): string | undefined {
  return WRONG_PORT.test(text)
    ? 'Harness rule (rules/local-llm.md): LM Studio serves on port 1237, not 1234.'
    : undefined
}

export function checkOpenswarm(command: string): string | undefined {
  return /\bopenswarm\s+(pr\s+)?review\b/.test(stripProse(command))
    ? 'Harness rule (rules/commit-gate.md): the OpenSwarm review gate is disabled since 2026-10-02; do not run it.'
    : undefined
}

export type GuardOptions = { orderTools: string }

export async function guardsToolCall(
  $: EngineInterface,
  e: Parameters<ToolCallHook>[1],
  next: Parameters<ToolCallHook>[2],
  options: GuardOptions = { orderTools: DEFAULT_ORDER_TOOLS },
) {
    const toggles = await read($, togglesAtom)
    if (!toggles.guards) return next(e)
    const input = e as unknown as Record<string, unknown>
    const env = await read($, envAtom)

    if (e.tool === 'Bash' && typeof input.command === 'string') {
      const command = input.command
      const files = await readAll($, messageFiles(command))
      const refusal =
        checkAttribution(command, files) ??
        checkOpenswarm(command) ??
        checkForcePush(command) ??
        checkDelete(command, env, await $.session.cwd().catch(() => undefined)) ??
        checkWorktree(command, env, await repoRoot($)) ??
        checkLlmPort(stripProse(command)) ??
        checkSystemPython(command)
      if (refusal !== undefined) return { deny: refusal }

      const venv = venvRewrite(command, env)
      if (venv !== undefined && 'deny' in venv) return { deny: venv.deny }
      const ran = await next(venv === undefined ? e : { ...e, command: venv.command })
      if (/\bgit\b[^\n;&|]*\bworktree\s+add\b/.test(command) && ran.deny === undefined && ran.isError !== true) {
        await ensureWorktreeExcluded($)
      }
      const notes: string[] = []
      // The model sees its own command in the transcript; tell it the run
      // happened inside the venv so it does not report a system-Python result.
      if (venv !== undefined && ran.deny === undefined && !(await read($, venvNotedAtom))) {
        await update($, venvNotedAtom, () => true)
        notes.push(`harness ran this inside the platform venv (${env.venv}); the result is from the venv, not the system Python.`)
      }
      if (ran.deny === undefined && isVersionBump(command) && !(await read($, shipAtom)).prListed) notes.push(versionBumpNote())

      if (ran.deny !== undefined || notes.length === 0) return ran

      return { ...ran, context: [...(ran.context ?? []), ...notes] }
    }

    if (e.tool === 'Agent') {
      const refusal = checkAgentWorktree(input)
      if (refusal !== undefined) return { deny: refusal }
    }

    const order = checkTradingOrder(e.tool, options.orderTools, (await read($, lintAtom)).askUsed)
    if (order !== undefined) return { deny: order }

    if (e.tool === 'EnterWorktree') {
      const refusal = checkEnterWorktree(input)
      if (refusal !== undefined) return { deny: refusal }
    }

    if (e.tool === 'Edit' || e.tool === 'Write') {
      const text = [input.new_string, input.content, JSON.stringify(input.edits ?? '')]
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
      const path = typeof input.file_path === 'string' ? input.file_path : ''
      const refusal = checkLlmPort(text) ?? checkMemorySecret(path, text, env.home)
      if (refusal !== undefined) return { deny: refusal }
    }

    return next(e)
}

// Facts the guards need, read once per session.
export async function loadGuardEnv($: EngineInterface): Promise<void> {
  const home = await $.env.get('HOME')
  const tmpdir = await $.env.get('TMPDIR')
  // No `uname` process: the two platform venvs are probed directly, which also
  // covers a shell that differs from the session's platform.
  const candidates = [`${home}/dev/mlx_env`, `${home}/dev/venvs/vega`]
  let venv: string | undefined
  let dir: string | undefined
  for (const candidate of candidates) {
    try {
      if (await $.fs.exists(`${candidate}/bin/activate`)) {
        venv = `${candidate}/bin/activate`
        dir = candidate
        break
      }
    } catch {
      // Unreadable: try the next candidate.
    }
  }
  if (venv === undefined) dir = (await $.env.get('OSTYPE'))?.startsWith('darwin') ? candidates[0] : candidates[1]
  await update($, envAtom, () => ({ home, tmpdir, venv, venvMissing: venv === undefined ? dir ?? 'the platform venv' : undefined }))
}

async function readAll($: EngineInterface, paths: readonly string[]): Promise<string[]> {
  const texts: string[] = []
  for (const path of paths) {
    try {
      texts.push(await $.fs.read(unquote(path)))
    } catch {
      // Unreadable: the command itself is still checked.
    }
  }

  return texts
}

// The main checkout's root, also from inside a worktree.
async function repoRoot($: EngineInterface): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 5_000 })
    const common = ran.stdout.trim()

    return ran.exitCode === 0 && common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : undefined
  } catch {
    return undefined
  }
}

async function ensureWorktreeExcluded($: EngineInterface): Promise<void> {
  const root = await repoRoot($)
  if (root === undefined) return
  const path = `${root}/.git/info/exclude`
  let text = ''
  try {
    text = await $.fs.read(path)
  } catch {
    // No exclude file yet.
  }
  if (text.split('\n').some(line => line.trim() === 'worktrees/')) return
  const head = text === '' || text.endsWith('\n') ? text : `${text}\n`
  await $.fs.write(path, `${head}worktrees/\n`)
}
