import type { EngineInterface } from 'claude-code'

import { commandWords, isInside, programOf, segments, stripProse } from './shell'

// repo-size: keeps repos under ~/dev within a size budget (5 GB unless the repo's
// .claude/repo-size.json says otherwise). Measured 2026-10-31: the overruns were
// mostly worktrees/, trash/ and testing/ (byproducts of the user's own rules),
// and in a few repos a .git with loose objects `git gc` would pack.
// It measures and warns, refuses what makes a repo grow (a large non-LFS file
// staged, a new worktree while merged ones are left over), and lists cleanup
// candidates. It never deletes anything itself.

export const DEFAULT_BUDGET_KB = 5 * 1024 * 1024
export const LARGE_FILE_MB = 50
export const TRASH_DAYS = 30
const GC_LOOSE_KB = 500 * 1024

export type SizeEntry = { name: string; kb: number }

export type SizeReport = {
  root: string
  at: number
  totalKb: number
  budgetKb: number
  over: boolean
  top: SizeEntry[]
  looseKb: number
  packKb: number
}

export type Budget = { budgetKb: number; ignore: string[] }

export function storeKey(root: string): string {
  return `repoSize:${root}`
}

// `du -k -d 1 <root>` lines: "<kb>\t<path>". The root's own line is the total.
export function parseDu(text: string, root: string): { totalKb: number; entries: SizeEntry[] } {
  const base = root.replace(/\/$/, '')
  let totalKb = 0
  const entries: SizeEntry[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^(\d+)\s+(.+)$/)
    if (match === null) continue
    const kb = Number(match[1])
    const path = (match[2] ?? '').replace(/\/$/, '')
    if (path === base) totalKb = kb
    else if (path.startsWith(`${base}/`)) entries.push({ name: path.slice(base.length + 1), kb })
  }

  return { totalKb, entries }
}

// `git count-objects -v`: `size` is loose objects, `size-pack` packs, both KiB.
export function parseCountObjects(text: string): { looseKb: number; packKb: number } {
  const field = (name: string) => Number(text.match(new RegExp(`^${name}: (\\d+)$`, 'm'))?.[1] ?? 0)

  return { looseKb: field('size'), packKb: field('size-pack') }
}

// `.claude/repo-size.json`: { "budgetGB": 8, "ignore": ["db/", "models"] }.
export function readBudget(text: string | undefined): Budget {
  const fallback = { budgetKb: DEFAULT_BUDGET_KB, ignore: [] }
  if (text === undefined) return fallback
  try {
    const value = JSON.parse(text) as { budgetGB?: unknown; ignore?: unknown }
    const gb = typeof value.budgetGB === 'number' && value.budgetGB > 0 ? value.budgetGB : undefined
    const ignore = Array.isArray(value.ignore) ? value.ignore.filter((item): item is string => typeof item === 'string').map(item => item.replace(/\/$/, '')) : []

    return { budgetKb: gb === undefined ? DEFAULT_BUDGET_KB : Math.round(gb * 1024 * 1024), ignore }
  } catch {
    return fallback
  }
}

export function buildReport(root: string, at: number, du: string, countObjects: string, budget: Budget): SizeReport {
  const { totalKb, entries } = parseDu(du, root)
  const ignored = entries.filter(entry => budget.ignore.includes(entry.name)).reduce((sum, entry) => sum + entry.kb, 0)
  const counted = Math.max(0, totalKb - ignored)
  const top = entries
    .filter(entry => !budget.ignore.includes(entry.name))
    .sort((a, b) => b.kb - a.kb)
    .slice(0, 5)

  return { root, at, totalKb: counted, budgetKb: budget.budgetKb, over: counted > budget.budgetKb, top, ...parseCountObjects(countObjects) }
}

export function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}GB`
  if (kb >= 1024) return `${Math.round(kb / 1024)}MB`

  return `${kb}KB`
}

export function gcHint(report: Pick<SizeReport, 'looseKb' | 'packKb'>): string | undefined {
  return report.looseKb > GC_LOOSE_KB && report.looseKb > report.packKb
    ? `.git loose objects ${formatKb(report.looseKb)} > pack ${formatKb(report.packKb)}: \`git gc\` reclaims most of it.`
    : undefined
}

export function statusText(report: SizeReport): string | undefined {
  return report.over ? `repo ${formatKb(report.totalKb)}/${formatKb(report.budgetKb)}` : undefined
}

export function sizeSummary(report: SizeReport, pointer = true): string {
  const top = report.top.map(entry => `${entry.name} ${formatKb(entry.kb)}`).join(' · ')
  const lines = [
    `[repo-size] ${report.root}: ${formatKb(report.totalKb)} (budget ${formatKb(report.budgetKb)})${report.over ? ' — over budget' : ''}`,
    `largest: ${top || '(none)'}`,
  ]
  const gc = gcHint(report)
  if (gc !== undefined) lines.push(gc)
  if (report.over && pointer) lines.push('Run /repo-size for cleanup candidates (leftover worktrees, old trash/ entries). Delete nothing without an AskUserQuestion approval.')

  return lines.join('\n')
}

// Changes only when the total moves by half a gigabyte or the verdict flips.
export function sizeSignature(report: SizeReport): string {
  return `${report.over ? 'over' : 'ok'}:${Math.round(report.totalKb / (512 * 1024))}`
}

// --- Growth guards (pure parts) ---

// What a command stages: pathspecs of `git add`, or `all` for `git add -A/-u/.`
// with no pathspec and `git commit -a`. Undefined when nothing is staged.
export function stagedTargets(command: string): { paths: string[]; tracked: boolean } | undefined {
  for (const segment of segments(stripProse(command))) {
    const words = commandWords(segment)
    if (programOf(words) !== 'git') continue
    const args = words.slice(1).filter((word, at, all) => !(word === '-C' || all[at - 1] === '-C'))
    const sub = args[0]
    if (sub === 'add') {
      const paths = args.slice(1).filter(word => !word.startsWith('-'))
      const tracked = args.includes('-u') || args.includes('--update')

      return { paths: paths.length === 0 ? ['.'] : paths, tracked }
    }
    if (sub === 'commit' && args.slice(1).some(word => /^-[a-zA-Z]*a/.test(word) || word === '--all')) return { paths: ['.'], tracked: true }
  }

  return undefined
}

export type StagedFile = { path: string; bytes: number; lfs: boolean }

export function checkLargeFiles(files: readonly StagedFile[], limitMb = LARGE_FILE_MB): string | undefined {
  const large = files.filter(file => !file.lfs && file.bytes > limitMb * 1024 * 1024)
  if (large.length === 0) return undefined
  const list = large
    .slice(0, 5)
    .map(file => `${file.path} (${formatKb(Math.round(file.bytes / 1024))})`)
    .join(', ')

  return `Harness rule (repo-size): staging files over ${limitMb}MB that are not LFS-tracked makes the repo's history grow for good: ${list}${large.length > 5 ? ` and ${large.length - 5} more` : ''}. Add them to .gitignore (data, outputs, models), or track them with \`git lfs track\` first.`
}

// Worktrees (other than the main checkout) whose branch is merged.
export function mergedWorktrees(porcelain: string, merged: readonly string[], mainPath: string): string[] {
  const paths: string[] = []
  for (const block of porcelain.split('\n\n')) {
    const path = block.match(/^worktree (.+)$/m)?.[1]
    const ref = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]
    if (path !== undefined && path !== mainPath && ref !== undefined && merged.includes(ref)) paths.push(path)
  }

  return paths
}

// `git branch --merged <base>` lines ("* main", "  feat/x", "+ feat/y").
export function parseBranches(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^[*+ ]+/, '').trim())
    .filter(line => line !== '' && !line.startsWith('('))
}

// `git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads`:
// branches whose remote branch is gone, as after a squash merge that
// `--merged` cannot see.
export function goneBranches(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.match(/^(\S+) \[gone\]$/)?.[1])
    .filter((branch): branch is string => branch !== undefined)
}

export function checkWorktreeGrowth(report: SizeReport | undefined, leftovers: readonly string[]): string | undefined {
  if (report === undefined || !report.over || leftovers.length === 0) return undefined

  return `Harness rule (repo-size): ${report.root} is ${formatKb(report.totalKb)}, over its ${formatKb(report.budgetKb)} budget, and worktrees of merged branches (or ones whose remote branch is gone) are still there: ${leftovers.join(', ')}. Check each has no uncommitted changes and \`git worktree remove <path>\` them before adding another (CLAUDE.md §3).`
}

export function isWorktreeAdd(command: string): boolean {
  return segments(stripProse(command)).some(segment => {
    const words = commandWords(segment)
    return programOf(words) === 'git' && words.includes('worktree') && words[words.indexOf('worktree') + 1] === 'add'
  })
}

export type TrashEntry = { name: string; kb: number }

// Entries `find -ctime +N` named (moved into trash/ that long ago: `mv` keeps an
// item's mtime, so a years-old file trashed today would look old by mtime),
// sized from `du`, largest first.
export function trashCandidates(sizes: readonly SizeEntry[], findOut: string, dir: string): TrashEntry[] {
  const base = dir.replace(/\/$/, '')
  const aged = new Set(
    findOut
      .split('\0')
      .filter(path => path.startsWith(`${base}/`))
      .map(path => path.slice(base.length + 1)),
  )

  return sizes.filter(entry => aged.has(entry.name)).sort((a, b) => b.kb - a.kb)
}

// --- Engine glue ---

async function run($: EngineInterface, argv: string[], timeoutMs = 20_000, cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const ran = await $.process.run(argv, { timeoutMs, ...(cwd === undefined ? {} : { cwd }) })
    return { ok: ran.exitCode === 0, out: ran.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

// The main checkout's root (also from inside a worktree), when it is under ~/dev.
export async function devRepoRoot($: EngineInterface, home: string | undefined): Promise<string | undefined> {
  if (home === undefined) return undefined
  const ran = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], 5_000)
  const common = ran.out.trim()
  if (!ran.ok || !common.endsWith('/.git')) return undefined
  const root = common.slice(0, -'/.git'.length)

  return isInside(root, `${home}/dev`) && root !== `${home}/dev` ? root : undefined
}

export async function measureRepo($: EngineInterface, root: string, now: number): Promise<SizeReport | undefined> {
  const du = await run($, ['du', '-k', '-d', '1', root], 180_000)
  if (du.out.trim() === '') return undefined
  const objects = await run($, ['git', '-C', root, 'count-objects', '-v'], 20_000)
  let config: string | undefined
  try {
    config = await $.fs.read(`${root}/.claude/repo-size.json`)
  } catch {
    // No per-repo budget: the default applies.
  }
  const report = buildReport(root, now, du.out, objects.out, readBudget(config))
  await $.store.set(storeKey(root), report)

  return report
}

export async function cachedReport($: EngineInterface, root: string): Promise<SizeReport | undefined> {
  const value = await $.store.get(storeKey(root))

  return typeof value === 'object' && value !== null && typeof (value as SizeReport).totalKb === 'number' ? (value as SizeReport) : undefined
}

export async function leftoverMerged($: EngineInterface, root: string): Promise<string[]> {
  const list = await run($, ['git', '-C', root, 'worktree', 'list', '--porcelain'], 5_000)
  if (!list.ok) return []
  const head = await run($, ['git', '-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 5_000)
  const base = head.ok && head.out.trim() !== '' ? head.out.trim() : 'main'
  const merged = await run($, ['git', '-C', root, 'branch', '--merged', base], 5_000)
  const gone = await run($, ['git', '-C', root, 'for-each-ref', '--format=%(refname:short) %(upstream:track)', 'refs/heads'], 5_000)
  const branches = [...parseBranches(merged.out), ...goneBranches(gone.out)].filter(branch => branch !== base.replace(/^origin\//, ''))

  return mergedWorktrees(list.out, branches, root)
}

// Refusal for a command that stages large non-LFS files, judged from the files
// git would stage (untracked and modified, ignored files left out).
export async function largeStageRefusal($: EngineInterface, command: string, cwd: string | undefined): Promise<string | undefined> {
  const targets = stagedTargets(command)
  if (targets === undefined) return undefined
  const listArgs = targets.tracked ? ['-m'] : ['-m', '-o', '--exclude-standard']
  const listed = await run($, ['git', 'ls-files', '-z', '--full-name', ...listArgs, '--', ...targets.paths], 10_000, cwd)
  if (!listed.ok) return undefined
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'], 5_000, cwd)
  if (!top.ok) return undefined
  const root = top.out.trim()
  const paths = [...new Set(listed.out.split('\0').filter(path => path !== ''))].slice(0, 5_000)
  const sized = await Promise.all(
    paths.map(async path => {
      const stat = await $.fs.stat(`${root}/${path}`).catch(() => undefined)
      return { path, bytes: stat?.kind === 'file' ? stat.size : 0 }
    }),
  )
  const big = sized.filter(file => file.bytes > LARGE_FILE_MB * 1024 * 1024)
  if (big.length === 0) return undefined
  const attrs = await run($, ['git', 'check-attr', 'filter', '--', ...big.map(file => file.path)], 10_000, root)
  const lfs = new Set(
    attrs.out
      .split('\n')
      .map(line => line.match(/^(.+): filter: lfs$/)?.[1])
      .filter((path): path is string => path !== undefined),
  )

  return checkLargeFiles(big.map(file => ({ ...file, lfs: lfs.has(file.path) })))
}

export async function trashReport($: EngineInterface, root: string): Promise<TrashEntry[]> {
  const dir = `${root}/trash`
  if (!(await $.fs.exists(dir).catch(() => false))) return []
  const aged = await run($, ['find', dir, '-mindepth', '1', '-maxdepth', '1', '-ctime', `+${TRASH_DAYS}`, '-print0'], 30_000)
  if (aged.out === '') return []
  const du = await run($, ['du', '-k', '-d', '1', dir], 120_000)

  return trashCandidates(parseDu(du.out, dir).entries, aged.out, dir)
}

export async function repoSizeCommand($: EngineInterface, home: string | undefined, now: number): Promise<string> {
  const root = await devRepoRoot($, home)
  if (root === undefined) return 'repo-size: not inside a git repository under ~/dev.'
  const report = await measureRepo($, root, now)
  if (report === undefined) return `repo-size: could not measure ${root}.`
  const lines = [sizeSummary(report, false)]
  const leftovers = await leftoverMerged($, root)
  if (leftovers.length > 0) lines.push(`worktrees of merged or remote-deleted branches (check for uncommitted changes, then \`git worktree remove\`): ${leftovers.join(', ')}`)
  const trash = await trashReport($, root)
  if (trash.length > 0) {
    const total = trash.reduce((sum, entry) => sum + entry.kb, 0)
    const list = trash
      .slice(0, 10)
      .map(entry => `trash/${entry.name} ${formatKb(entry.kb)}`)
      .join(', ')
    lines.push(`trash/ entries older than ${TRASH_DAYS} days (${formatKb(total)}): ${list}${trash.length > 10 ? ` and ${trash.length - 10} more` : ''}`)
    lines.push('Emptying trash/ cannot be undone: ask the user with AskUserQuestion before removing any of these.')
  }
  if (leftovers.length === 0 && trash.length === 0 && gcHint(report) === undefined) lines.push('No cleanup candidates found.')

  return lines.join('\n')
}
