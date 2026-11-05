import type { Lang, SmellLimits } from '../types'
import { smellAdvice, techniqueUrl } from './catalog'

// Code-smell heuristics. Notes only: function boundaries are found by brace
// matching or indentation, not by a parser, so a number can be off by a few
// lines. Measure false positives before letting any of this refuse.

export type Fn = { name: string; start: number; end: number; params: number; nesting: number }

export type Finding = { smell: string; where: string; detail: string }

// Strings and comments out of the way, offsets kept, so braces inside them do not count.
function blankCode(text: string, lang: Lang): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] as string
    const next = text[i + 1]
    if (lang !== 'python' && ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (lang !== 'python' && ch === '/' && next === '*') {
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    if (lang === 'python' && ch === '#') {
      while (i < n && text[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    // Rust lifetimes ('a) and chars are not strings worth tracking.
    if (ch === '"' || ch === '`' || (ch === "'" && lang !== 'rust')) {
      const triple = lang === 'python' && text.startsWith(ch.repeat(3), i)
      const close = triple ? ch.repeat(3) : ch
      out += ' '.repeat(close.length)
      i += close.length
      while (i < n && !text.startsWith(close, i)) {
        if (text[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        if (!triple && ch !== '`' && text[i] === '\n') break
        out += text[i] === '\n' ? '\n' : ' '
        i++
      }
      out += ' '.repeat(Math.min(close.length, n - i))
      i += close.length
      continue
    }
    out += ch
    i++
  }

  return out
}

const lineOf = (text: string, index: number) => {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++

  return line
}

function countParams(list: string, lang: Lang): number {
  let depth = 0
  let count = 0
  let current = ''
  const flush = () => {
    const param = current.trim()
    current = ''
    if (param === '') return
    if (lang === 'python' && /^(self|cls|\*|\/)$/.test(param.split(/[:=]/)[0]?.trim() ?? '')) return
    if (lang === 'rust' && /^&?\s*(mut\s+)?self\b|^&'\w+\s+(mut\s+)?self\b/.test(param)) return
    count++
  }
  for (const ch of list) {
    if ('([{<'.includes(ch)) depth++
    else if (')]}>'.includes(ch)) depth--
    if (ch === ',' && depth === 0) flush()
    else current += ch
  }
  flush()

  return count
}

// The matching close of the bracket at `open`, or -1.
function matchClose(code: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === openCh) depth++
    else if (code[i] === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

const BRACE_FN: Record<'ts' | 'rust', RegExp> = {
  ts: /(?:\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^>]*>)?\s*\(|\b([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=>\s*\{|^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\((?=[^()]*\)\s*(?::[^{;]+)?\{))/gm,
  rust: /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g,
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'match', 'loop', 'else'])

function braceFunctions(text: string, lang: 'ts' | 'rust'): Fn[] {
  const code = blankCode(text, lang)
  const fns: Fn[] = []
  for (const match of code.matchAll(BRACE_FN[lang])) {
    const name = match[1] ?? match[2] ?? match[3] ?? '(anonymous)'
    if (KEYWORDS.has(name)) continue
    const at = match.index ?? 0
    const parenOpen = code.indexOf('(', at + (match[2] !== undefined ? match[0].indexOf('=') : 0))
    const parenClose = parenOpen === -1 ? -1 : matchClose(code, parenOpen, '(', ')')
    const params = parenOpen !== -1 && parenClose !== -1 && parenOpen < at + match[0].length + 1 ? countParams(code.slice(parenOpen + 1, parenClose), lang) : 0
    const braceOpen = code.indexOf('{', Math.max(parenClose, at))
    if (braceOpen === -1) continue
    // A declaration without a body (trait fn, overload) ends at ';' first.
    const semi = code.indexOf(';', Math.max(parenClose, at))
    if (semi !== -1 && semi < braceOpen) continue
    const braceClose = matchClose(code, braceOpen, '{', '}')
    if (braceClose === -1) continue
    let depth = 0
    let nesting = 0
    for (let i = braceOpen; i <= braceClose; i++) {
      if (code[i] === '{') nesting = Math.max(nesting, ++depth)
      else if (code[i] === '}') depth--
    }
    fns.push({ name, start: lineOf(code, at), end: lineOf(code, braceClose), params, nesting: nesting - 1 })
  }

  return fns
}

function pythonFunctions(text: string): Fn[] {
  const code = blankCode(text, 'python')
  const lines = code.split('\n')
  const fns: Fn[] = []
  const indentOf = (line: string) => line.length - line.trimStart().length
  for (let i = 0; i < lines.length; i++) {
    const head = (lines[i] ?? '').match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
    if (head === null) continue
    const base = head[1]?.length ?? 0
    // The signature may span lines: up to the ':' that closes it.
    let sig = (lines[i] ?? '').slice((lines[i] ?? '').indexOf('(') + 1)
    let j = i
    while (!/\)\s*(->[^:]+)?:\s*$/.test(sig) && j + 1 < lines.length && j - i < 30) sig += ` ${lines[++j]}`
    const params = countParams(sig.replace(/\)\s*(->[^:]+)?:\s*$/, ''), 'python')
    let end = j
    let maxIndent = base
    for (let k = j + 1; k < lines.length; k++) {
      const line = lines[k] ?? ''
      if (line.trim() === '') continue
      const indent = indentOf(line)
      if (indent <= base) break
      end = k
      if (/^\s*(if|elif|else|for|while|try|except|with|match|case)\b/.test(line)) maxIndent = Math.max(maxIndent, indent)
    }
    const unit = detectIndent(lines) || 4
    fns.push({ name: head[2] ?? '?', start: i + 1, end: end + 1, params, nesting: Math.max(0, Math.round((maxIndent - base) / unit)) })
  }

  return fns
}

function detectIndent(lines: string[]): number {
  for (const line of lines) {
    const indent = line.length - line.trimStart().length
    if (indent > 0 && line.trim() !== '') return line.startsWith('\t') ? 1 : indent
  }

  return 0
}

export function functionsIn(lang: Lang, text: string): Fn[] {
  return lang === 'python' ? pythonFunctions(text) : braceFunctions(text, lang)
}

/** Runs of `min` non-trivial lines that appear twice in the text. */
export function duplicateRuns(text: string, min: number): Array<{ first: number; second: number }> {
  const lines = text.split('\n').map(line => line.trim())
  const trivial = (line: string) => line.length < 4 || /^[\s{}()[\];,]*$/.test(line) || /^(\/\/|#|\*)/.test(line)
  const seen = new Map<string, number>()
  const runs: Array<{ first: number; second: number }> = []
  let skipUntil = -1
  for (let i = 0; i + min <= lines.length; i++) {
    const window = lines.slice(i, i + min)
    if (window.some(trivial) || i < skipUntil) continue
    const k = window.join('\n')
    const first = seen.get(k)
    if (first !== undefined && first + min <= i) {
      runs.push({ first: first + 1, second: i + 1 })
      skipUntil = i + min
    } else if (first === undefined) seen.set(k, i)
  }

  return runs
}

// Beyond this a file is a bundle or a data dump, not code to refactor, and the
// scans below cost seconds per file (a 350 KB minified chunk took 5 s).
const MAX_ANALYZED_CHARS = 300_000
const MINIFIED_AVG_LINE = 300

/** Bundles, minified output and data dumps: skipped by every smell scan. */
export function isMachineText(text: string): boolean {
  if (text.length > MAX_ANALYZED_CHARS) return true
  if (text.length < 20_000) return false
  let lines = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++

  return text.length / lines > MINIFIED_AVG_LINE
}

/** Findings in a file's text, limited to functions that overlap the lines in `touched` (all when undefined). */
export function smellsIn(lang: Lang, text: string, limits: SmellLimits, touched?: { from: number; to: number }): Finding[] {
  if (isMachineText(text)) return []
  const overlaps = (start: number, end: number) => touched === undefined || (start <= touched.to && end >= touched.from)
  const findings: Finding[] = []
  for (const fn of functionsIn(lang, text)) {
    if (!overlaps(fn.start, fn.end)) continue
    const where = `${fn.name} (line ${fn.start})`
    const length = fn.end - fn.start + 1
    if (length > limits.maxFunctionLines) findings.push({ smell: 'Long Method', where, detail: `${length} lines > ${limits.maxFunctionLines}` })
    if (fn.params > limits.maxParams) findings.push({ smell: 'Long Parameter List', where, detail: `${fn.params} parameters > ${limits.maxParams}` })
    if (fn.nesting > limits.maxNesting) findings.push({ smell: 'Deep Nesting', where, detail: `nesting ${fn.nesting} > ${limits.maxNesting}` })
  }
  const lines = text.split('\n').length
  if (lines > limits.maxFileLines && touched !== undefined) findings.push({ smell: 'Large Class', where: 'the file', detail: `${lines} lines > ${limits.maxFileLines}` })
  for (const run of duplicateRuns(text, limits.minDuplicateLines)) {
    if (overlaps(run.first, run.first + limits.minDuplicateLines) || overlaps(run.second, run.second + limits.minDuplicateLines)) {
      findings.push({ smell: 'Duplicate Code', where: `lines ${run.first} and ${run.second}`, detail: `${limits.minDuplicateLines}+ identical lines` })
    }
  }

  return findings
}

function advice(smell: string): string {
  // Not a refactoring.guru smell of its own: the arrow-shaped code of nested conditionals.
  if (smell === 'Deep Nesting') return `Deep Nesting → Replace Nested Conditional with Guard Clauses (${techniqueUrl('Replace Nested Conditional with Guard Clauses')}), Extract Method (${techniqueUrl('Extract Method')})`

  return smellAdvice(smell)
}

export function smellNote(file: string, findings: Finding[]): string | undefined {
  if (findings.length === 0) return undefined
  const lines = findings.map(f => `- ${f.where}: ${f.detail}. ${advice(f.smell)}`)

  return [`refactor: code smells in ${file} after this edit (a note, nothing was refused; fix them now if this change owns them, otherwise leave them):`, ...lines].join('\n')
}
