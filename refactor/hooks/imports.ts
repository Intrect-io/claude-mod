import type { Lang } from '../types'

// Import extraction by regex, per language. It errs toward missing an import
// rather than inventing one: only what an extractor returns is ever judged.

export type ImportRef = {
  /** As written: "./x", "@/app/y", ".models", "pkg.mod", "crate::a::b". */
  spec: string
  /** Python `from <spec> import <names>`: the names, which may be submodules. */
  names?: string[]
  line: number
}

const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

export function langOf(path: string): Lang | undefined {
  if (TS_EXT.test(path)) return 'ts'
  if (path.endsWith('.py') || path.endsWith('.pyi')) return 'python'
  if (path.endsWith('.rs')) return 'rust'

  return undefined
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length

// Blanks comments while keeping offsets (and so line numbers) intact.
function blankTsComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (match, lead: string) => lead + ' '.repeat(match.length - lead.length))
}

function tsImports(text: string): ImportRef[] {
  const clean = blankTsComments(text)
  const found: ImportRef[] = []
  const patterns = [
    // import x from 'y'; import { a } from 'y'; import 'y'; export * from 'y'; import type ...
    /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[\w*$\s{},]*?\s*from\s*)?['"]([^'"\n]+)['"]/g,
    /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const spec = match[1]
      if (spec === undefined) continue
      found.push({ spec, line: lineAt(clean, (match.index ?? 0) + match[0].indexOf(spec)) })
    }
  }

  return found.sort((a, b) => a.line - b.line)
}

function pythonImports(text: string): ImportRef[] {
  const found: ImportRef[] = []
  const lines = text.split('\n')
  let inString: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    // Skip docstrings: a line opening a triple quote that does not close it.
    const quotes = raw.match(/"""|'''/g)
    if (inString !== undefined) {
      if (quotes?.includes(inString as '"""')) inString = undefined
      continue
    }
    if (quotes !== null && quotes.length % 2 === 1) {
      inString = quotes[0]
      continue
    }
    const line = raw.replace(/#.*$/, '')
    const from = line.match(/^\s*from\s+(\.+[\w.]*|[A-Za-z_][\w.]*)\s+import\s+(.*)$/)
    if (from !== null) {
      let rest = from[2] ?? ''
      // A parenthesized list may run over several lines.
      if (rest.includes('(') && !rest.includes(')')) {
        let j = i + 1
        while (j < lines.length && !(lines[j] ?? '').includes(')')) {
          rest += ` ${(lines[j] ?? '').replace(/#.*$/, '')}`
          j++
        }
        rest += ` ${(lines[j] ?? '').replace(/#.*$/, '')}`
        i = j
      }
      const names = rest
        .replace(/[()\\]/g, ' ')
        .replace(/#.*$/gm, '')
        .split(',')
        .map(part => part.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter(name => /^[A-Za-z_]\w*$/.test(name))
      found.push({ spec: from[1] ?? '', names, line: i + 1 })
      continue
    }
    const plain = line.match(/^\s*import\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)\s*$/)
    if (plain !== null) {
      for (const part of (plain[1] ?? '').split(',')) {
        const spec = part.trim().split(/\s+as\s+/)[0]?.trim()
        if (spec) found.push({ spec, line: i + 1 })
      }
    }
  }

  return found
}

function rustImports(text: string): ImportRef[] {
  const clean = blankTsComments(text)
  const found: ImportRef[] = []
  for (const match of clean.matchAll(/(?:^|[\n;{}])\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/g)) {
    const body = (match[1] ?? '').replace(/\s+as\s+\w+/g, '').replace(/\s+/g, '')
    const index = (match.index ?? 0) + match[0].indexOf('use')
    for (const spec of expandUseTree(body)) found.push({ spec, line: lineAt(clean, index) })
  }

  return found
}

// `crate::a::{b, c::d}` → crate::a::b, crate::a::c::d (one level of braces is the
// common case; deeper nesting is expanded recursively).
export function expandUseTree(body: string): string[] {
  const open = body.indexOf('{')
  if (open === -1) return [body.replace(/::\*$/, '')].filter(spec => spec !== '')
  const prefix = body.slice(0, open).replace(/::$/, '')
  const inner = body.slice(open + 1, body.lastIndexOf('}'))
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  parts.push(inner.slice(start))

  return parts
    .filter(part => part !== '')
    .flatMap(part => (part === 'self' ? [prefix] : expandUseTree(part).map(spec => `${prefix}::${spec}`)))
}

export function extractImports(lang: Lang, text: string): ImportRef[] {
  if (lang === 'ts') return tsImports(text)
  if (lang === 'python') return pythonImports(text)

  return rustImports(text)
}
