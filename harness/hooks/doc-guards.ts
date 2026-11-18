// Two deterministic refusals decided from the text of one tool call:
//  - swallow guard: a test file must not swallow exceptions, because a test that
//    cannot fail proves nothing;
//  - doc budget: CLAUDE.md and plan.md stay light, so a write may not grow one
//    past its line budget.

// ---- swallowed exceptions in tests ---------------------------------------

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

type Swallow = { name: string; pattern: RegExp }

const PYTHON: Swallow[] = [
  { name: 'an `except` block whose body is only pass or `...`', pattern: /\bexcept\b[^\n:]*:[ \t]*(?:#[^\n]*)?\n[ \t]*(?:pass|\.\.\.)[ \t]*(?:#[^\n]*)?(?=\n|$)/ },
  { name: 'a one-line `except ...: pass`', pattern: /\bexcept\b[^\n:]*:[ \t]*(?:pass|\.\.\.)[ \t]*(?:#[^\n]*)?(?=\n|$)/ },
  { name: 'a bare `except:`', pattern: /^[ \t]*except[ \t]*:/m },
  { name: '`contextlib.suppress`', pattern: /\b(?:contextlib\.)?suppress\s*\(/ },
]

const SCRIPT: Swallow[] = [
  { name: 'an empty `catch` block', pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*\}/ },
  { name: 'a `.catch` that returns nothing', pattern: /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*(?:\/\/[^\n]*\s*)*\}|undefined|null|void 0)\s*\)/ },
]

function swallowsFor(path: string): Swallow[] {
  if (/\.py$/.test(path)) return PYTHON
  if (/\.[cm]?[jt]sx?$/.test(path)) return SCRIPT

  return []
}

function swallowRefusal(where: string, found: string): string {
  return `Harness rule (rules/code-quality.md): ${where} swallows an exception (${found}). A test that swallows an exception cannot fail, so it proves nothing. Assert the error instead (pytest.raises(SpecificError, match=...) or expect(...).rejects/toThrow(message)), or let it propagate.`
}

// An Edit/Write of a test file: only the text being written is judged, so
// editing a file that already has one does not block unrelated changes.
export function checkSwallowedTest(path: string, texts: readonly string[]): string | undefined {
  if (!isTestPath(path)) return undefined
  const text = texts.join('\n')
  const hit = swallowsFor(path).find(entry => entry.pattern.test(text))

  return hit === undefined ? undefined : swallowRefusal(path, hit.name)
}

const BASH_TEST_PATH = /(?:test_\w+\.py|conftest\.py|_test\.(?:py|go|rs)|\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|[\s/'"])(?:tests?|__tests__)\/)/
const BASH_WRITE = /(?:>>?\s*['"]?[^\s|&;]*(?:test|spec)|\btee\b|\bsed\s+-[a-zA-Z]*i|\bperl\s+-[a-zA-Z]*i|write_text|writeFileSync|\bwriteFile\()/

// A shell command that writes a test file (redirect, tee, sed -i, a script) must
// not be a way around the Edit/Write check. The raw command is read, heredoc
// bodies included, since the body is the file's text.
export function checkSwallowedBash(command: string): string | undefined {
  if (!BASH_TEST_PATH.test(command) || !BASH_WRITE.test(command)) return undefined
  const hit = [...PYTHON, ...SCRIPT].find(entry => entry.pattern.test(command))

  return hit === undefined ? undefined : swallowRefusal('this command writes a test file that', hit.name)
}

// ---- CLAUDE.md / plan.md budget ------------------------------------------

export type DocBudgets = { claude: number; plan: number }
export const DEFAULT_DOC_BUDGETS: DocBudgets = { claude: 200, plan: 150 }

export function docKind(path: string): 'claude' | 'plan' | undefined {
  const name = path.split('/').pop() ?? ''
  if (name === 'CLAUDE.md') return 'claude'
  if (name === 'plan.md') return 'plan'

  return undefined
}

export function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
}

// A file already over its budget may shrink or stay the same size; it may not
// grow. One at or under budget may grow up to the budget.
export function checkDocBudget(path: string, before: number, after: number, budgets: DocBudgets = DEFAULT_DOC_BUDGETS): string | undefined {
  const kind = docKind(path)
  if (kind === undefined) return undefined
  const budget = budgets[kind]
  if (after <= budget || after <= before) return undefined
  const name = kind === 'claude' ? 'CLAUDE.md' : 'plan.md'
  const keep = kind === 'claude' ? 'rules that still apply and facts the code does not show' : 'open work and decisions that still hold'

  return `Harness rule (doc budget): ${path} would be ${after} lines (budget ${budget}, was ${before}). ${name} stays light and current: trim what is finished or stale in the same edit, and keep ${keep}. Move history to git log, a wiki or an archive file.`
}

// Net line change of one Edit (old_string -> new_string, once or everywhere).
export function editDelta(current: string, oldString: string, newString: string, replaceAll: boolean): number {
  if (oldString === '') return lineCount(newString)
  const hits = replaceAll ? current.split(oldString).length - 1 : current.includes(oldString) ? 1 : 0

  return hits * (newString.split('\n').length - oldString.split('\n').length)
}

// The new text blocks an Edit/Write/MultiEdit input carries.
export function writtenTexts(input: Record<string, unknown>): string[] {
  const texts: string[] = []
  for (const key of ['new_string', 'content']) {
    const value = input[key]
    if (typeof value === 'string') texts.push(value)
  }
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      const value = (edit as Record<string, unknown> | null)?.new_string
      if (typeof value === 'string') texts.push(value)
    }
  }

  return texts
}

const DOC_APPEND = /(?:>>\s*['"]?[^\s|&;]*(?:CLAUDE|plan)\.md|\btee\s+-a\s+['"]?[^\s|&;]*(?:CLAUDE|plan)\.md)/

// An append through the shell is a growth by definition.
export function checkDocAppend(command: string): string | undefined {
  return DOC_APPEND.test(command)
    ? 'Harness rule (doc budget): appending to CLAUDE.md or plan.md through the shell grows it without a trim. Edit the file instead, and remove what is finished or stale in the same change.'
    : undefined
}
