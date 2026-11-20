// Diff-aware verification before a milestone lands: what its diff did to the
// tests and to what runs them. Pure, so it runs under plain bun
// (fixtures/tamper-v1/run.ts) with no engine. The driver part (git, the base
// re-run and the judge) is in register.ts.
//
// Why: a check that passes proves nothing when the same branch changed the
// tests or their runner. Coding agents were measured doing exactly that
// (ImpossibleBench, arXiv 2510.20270; METR 2025-06), and a prompt telling
// them not to barely changes the rate.

// Same as harness's isTestPath (harness/hooks/doc-guards.ts); a mod imports nothing outside its folder.
const TEST_PATH = [
  /(^|\/)test_[^/]*\.py$/,
  /(^|\/)conftest\.py$/,
  /_test\.(py|go|rs)$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(tests?|__tests__)\/[^/]*\.(py|[cm]?[jt]sx?)$/,
]

export function isTestPath(path: string): boolean {
  return TEST_PATH.some(pattern => pattern.test(path))
}

// Files whose content decides whether tests pass, apart from the tests.
const TEST_INFRA = [
  /(^|\/)conftest\.py$/,
  /(^|\/)(?:pytest\.ini|tox\.ini|setup\.cfg|bunfig\.toml)$/,
  /(^|\/)(?:jest|vitest)\.config\.[^/]+$/,
  /(^|\/)\.mocharc[^/]*$/,
  /^\.github\/workflows\//,
]

const ASSERTION = /^\s*assert\b|\bself\.assert[A-Z]\w*\(|\bexpect\(|\bassert\.\w+\(|\bpytest\.raises\(/

export type NameStatus = { status: string; path: string; from?: string }

// `git diff --name-status` output. A rename or copy (R100, C75) carries both paths.
export function parseNameStatus(text: string): NameStatus[] {
  const out: NameStatus[] = []
  for (const line of text.split('\n')) {
    const parts = line.split('\t').filter(p => p !== '')
    if (parts.length < 2) continue
    const status = parts[0]!.trim()
    if (/^[RC]/.test(status) && parts.length >= 3) out.push({ status, path: parts[2]!, from: parts[1]! })
    else out.push({ status, path: parts[1]! })
  }

  return out
}

// Paths a check command names (`bash scripts/ci.sh`, `python scripts/verify.py`).
function checkPaths(check: string | undefined): Set<string> {
  if (check === undefined) return new Set()

  return new Set(check.split(/[\s;&|()<>'"`]+/).map(w => w.replace(/^\.\//, '')).filter(w => w.includes('/') || /\.\w+$/.test(w)))
}

export type Classified = { testInfra: string[]; testsModified: string[]; testsAdded: string[]; assertsRemoved: number }

export function isTestInfra(path: string, check?: string): boolean {
  return TEST_INFRA.some(p => p.test(path)) || checkPaths(check).has(path)
}

export function classifyDiff(nameStatus: string, patch: string, check?: string): Classified {
  const out: Classified = { testInfra: [], testsModified: [], testsAdded: [], assertsRemoved: 0 }
  for (const entry of parseNameStatus(nameStatus)) {
    if (isTestInfra(entry.path, check) || (entry.from !== undefined && isTestInfra(entry.from, check))) {
      out.testInfra.push(entry.path)
      continue
    }
    if (!isTestPath(entry.path) && !(entry.from !== undefined && isTestPath(entry.from))) continue
    if (entry.status.startsWith('A')) out.testsAdded.push(entry.path)
    else out.testsModified.push(entry.path)
  }
  for (const file of filePatches(patch)) {
    if (!isTestPath(file.path)) continue
    let removed = 0
    let added = 0
    for (const line of file.body.split('\n')) {
      if (line.startsWith('---') || line.startsWith('+++')) continue
      if (line.startsWith('-') && ASSERTION.test(line.slice(1))) removed++
      else if (line.startsWith('+') && ASSERTION.test(line.slice(1))) added++
    }
    out.assertsRemoved += Math.max(0, removed - added)
  }

  return out
}

type FilePatch = { path: string; body: string }

// A unified diff cut into its files; the path is the new one (b/...).
export function filePatches(patch: string): FilePatch[] {
  return patch
    .split(/^diff --git /m)
    .slice(1)
    .map(chunk => {
      const m = chunk.match(/^a\/\S+ b\/(\S+)/)
      return { path: m?.[1] ?? '', body: `diff --git ${chunk}` }
    })
    .filter(f => f.path !== '')
}

// What the base re-run puts back: existing test files the branch modified or
// deleted, and testInfra files, as the base had them. testInfra the branch
// added is removed instead. Added tests stay: they are new evidence.
export function restorePlan(nameStatus: string, check?: string): { restore: string[]; remove: string[] } {
  const restore = new Set<string>()
  const remove = new Set<string>()
  for (const entry of parseNameStatus(nameStatus)) {
    const infra = isTestInfra(entry.path, check) || (entry.from !== undefined && isTestInfra(entry.from, check))
    const test = isTestPath(entry.path) || (entry.from !== undefined && isTestPath(entry.from))
    if (!infra && !test) continue
    if (entry.status.startsWith('A')) {
      if (infra) remove.add(entry.path)
      continue
    }
    if (entry.from !== undefined) {
      restore.add(entry.from)
      if (/^R/.test(entry.status)) remove.add(entry.path)
    } else restore.add(entry.path)
  }

  return { restore: [...restore], remove: [...remove] }
}

// The diff the judge reads: test and testInfra files first, the rest after,
// cut near `max` characters with a note of what was left out.
export function judgeDiffText(patch: string, classified: Classified, max = 60_000): string {
  const first = new Set([...classified.testInfra, ...classified.testsModified, ...classified.testsAdded])
  const files = filePatches(patch)
  const ordered = [...files.filter(f => first.has(f.path) || isTestPath(f.path)), ...files.filter(f => !(first.has(f.path) || isTestPath(f.path)))]
  let text = ''
  const left: string[] = []
  for (const f of ordered) {
    if (text.length + f.body.length > max) {
      const room = max - text.length
      if (room > 2000 && left.length === 0) text += `${f.body.slice(0, room)}\n[... ${f.path} cut ...]\n`
      else left.push(f.path)
      continue
    }
    text += f.body.endsWith('\n') ? f.body : `${f.body}\n`
  }
  if (left.length > 0) text += `\n[left out for length: ${left.join(', ')}]\n`

  return text
}

export type DiffVerdict = { verdict: 'ok' | 'circumvents' | 'unsure'; reason: string }

// What the driver does with a verdict: hold the milestone for a person, go on
// with a note, or go on.
export function diffAction(v: DiffVerdict, c: Classified): 'hold' | 'note' | 'go' {
  if (v.verdict === 'circumvents') return 'hold'
  if (v.verdict === 'unsure') return c.testInfra.length > 0 || c.testsModified.length > 0 ? 'hold' : 'note'

  return 'go'
}

// ---- protected paths (1.15.0) ------------------------------------------------
// Files whose change a person lands: the detectors, the CI and the run's own
// rules. An agent that may merge changes to what judges it can weaken it
// (Anthropic, "Natural emergent misalignment from reward hacking": a
// hack-trained model sabotaged its detector 12% of the time).

export const BUILTIN_PROTECTED = ['.github/workflows/**', '.claude/protected.json', '.claude/auto-deploy.json', '.claude/architecture.json', '.claude/goal-loop.deny']

// A glob as git paths use it: `**` any depth, `*` within one segment, `?` one
// character, `{a,b}` alternatives.
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) re += '\\{'
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map(x => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`
        i = end
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }

  return new RegExp(`^${re}$`)
}

export function protectedHits(paths: readonly string[], globs: readonly string[]): string[] {
  const res = globs.map(globToRegExp)

  return [...new Set(paths.filter(p => res.some(r => r.test(p))))].sort()
}

// .claude/protected.json as read from the default branch: its globs, or why it was not read.
export function parseProtected(text: string | undefined): { paths: string[]; error?: string } {
  if (text === undefined || text.trim() === '') return { paths: [] }
  try {
    const raw = JSON.parse(text) as { paths?: unknown }
    if (!Array.isArray(raw.paths) || raw.paths.some(p => typeof p !== 'string')) return { paths: [], error: '.claude/protected.json needs {"paths": ["<glob>", ...]}' }
    return { paths: raw.paths as string[] }
  } catch (error) {
    return { paths: [], error: `.claude/protected.json does not parse: ${String(error).slice(0, 120)}` }
  }
}
