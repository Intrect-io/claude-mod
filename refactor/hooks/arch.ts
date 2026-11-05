import type { Architecture, Lang, SmellLimits } from '../types'
import { techniqueUrl } from './catalog'
import { extractImports, langOf } from './imports'
import type { ImportRef } from './imports'

// Layer rules from `.claude/architecture.json`. Pure: paths are relative to the
// repository root, POSIX-style. Only an import that resolves to a path inside a
// declared layer is judged; everything else (aliases not declared, external
// packages, crates) gets no verdict, so a refusal is never a guess.

export const DEFAULT_LIMITS: SmellLimits = { maxFunctionLines: 60, maxParams: 5, maxNesting: 4, maxFileLines: 600, minDuplicateLines: 6 }

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads the file's text; a malformed part is dropped and named in `problems`, never guessed at. */
export function parseArchitecture(text: string): Architecture {
  const arch: Architecture = { layers: [], allow: {}, packages: {}, forbidImports: [], smells: { ...DEFAULT_LIMITS }, problems: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    arch.problems.push(`not valid JSON (${String(error).slice(0, 120)})`)
    return arch
  }
  if (!isRecord(raw)) {
    arch.problems.push('the top level is not an object')
    return arch
  }
  if (Array.isArray(raw.layers)) {
    for (const [i, layer] of raw.layers.entries()) {
      if (isRecord(layer) && typeof layer.name === 'string' && isStringArray(layer.paths) && layer.paths.length > 0) {
        if (arch.layers.some(existing => existing.name === layer.name)) arch.problems.push(`layer "${layer.name}" is declared twice; the first is kept`)
        else arch.layers.push({ name: layer.name, paths: layer.paths })
      } else arch.problems.push(`layers[${i}] needs a name and a non-empty paths array`)
    }
  } else if (raw.layers !== undefined) arch.problems.push('layers is not an array')
  const names = new Set(arch.layers.map(layer => layer.name))
  if (isRecord(raw.allow)) {
    for (const [layer, targets] of Object.entries(raw.allow)) {
      if (!names.has(layer)) arch.problems.push(`allow names an unknown layer "${layer}"`)
      else if (!isStringArray(targets)) arch.problems.push(`allow.${layer} is not a list of layer names`)
      else {
        const unknown = targets.filter(target => !names.has(target))
        if (unknown.length > 0) arch.problems.push(`allow.${layer} names unknown layers: ${unknown.join(', ')}; the rule is dropped`)
        else arch.allow[layer] = targets
      }
    }
  } else if (raw.allow !== undefined) arch.problems.push('allow is not an object')
  if (isRecord(raw.packages)) {
    for (const [prefix, path] of Object.entries(raw.packages)) {
      if (typeof path === 'string') arch.packages[prefix] = normalize(path)
      else arch.problems.push(`packages["${prefix}"] is not a path`)
    }
  }
  if (Array.isArray(raw.forbidImports)) {
    for (const [i, rule] of raw.forbidImports.entries()) {
      if (!isRecord(rule) || typeof rule.layer !== 'string' || typeof rule.pattern !== 'string') {
        arch.problems.push(`forbidImports[${i}] needs a layer and a pattern`)
        continue
      }
      try {
        new RegExp(rule.pattern)
      } catch {
        arch.problems.push(`forbidImports[${i}].pattern is not a valid regex`)
        continue
      }
      if (!names.has(rule.layer)) arch.problems.push(`forbidImports[${i}] names an unknown layer "${rule.layer}"`)
      else arch.forbidImports.push({ layer: rule.layer, pattern: rule.pattern })
    }
  }
  if (isRecord(raw.smells)) {
    for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof SmellLimits>) {
      const value = raw.smells[key]
      if (typeof value === 'number' && value > 0) arch.smells[key] = value
    }
  }

  return arch
}

export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }

  return out.join('/')
}

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

const globCache = new Map<string, RegExp>()

/** `**` any depth, `*` within one segment, `?` one character. `dir/**` also matches `dir` itself. */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached !== undefined) return cached
  let source = ''
  const g = normalize(glob)
  for (let i = 0; i < g.length; i++) {
    const ch = g[i] as string
    if (ch === '*' && g[i + 1] === '*') {
      // "a/**" matches a and everything below; "**/b" matches b at any depth.
      if (g[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source = source.endsWith('/') ? `${source.slice(0, -1)}(?:/.*)?` : `${source}.*`
        i += 1
      }
    } else if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const regex = new RegExp(`^${source}$`)
  globCache.set(glob, regex)

  return regex
}

export function layerOf(arch: Architecture, path: string): string | undefined {
  const p = normalize(path)

  return arch.layers.find(layer => layer.paths.some(glob => globToRegExp(glob).test(p)))?.name
}

/**
 * Where an import points, as candidate paths (most specific first), or
 * undefined when it cannot be resolved without guessing.
 */
export function resolveImport(arch: Architecture, lang: Lang, from: string, ref: ImportRef): string[] | undefined {
  const spec = ref.spec
  const dir = dirname(normalize(from))
  if (lang === 'ts') {
    let base: string | undefined
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') base = normalize(`${dir}/${spec}`)
    else {
      const prefix = longestPrefix(arch.packages, spec)
      if (prefix !== undefined) base = normalize(`${arch.packages[prefix]}/${spec.slice(prefix.length)}`)
    }
    if (base === undefined) return undefined
    const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '')

    return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}.js`]
  }
  if (lang === 'python') {
    let base: string | undefined
    const dots = spec.match(/^\.+/)?.[0].length ?? 0
    if (dots > 0) {
      let pkg = dir
      for (let i = 1; i < dots; i++) pkg = dirname(pkg)
      const rest = spec.slice(dots).replace(/\./g, '/')
      base = normalize(rest === '' ? pkg : `${pkg}/${rest}`)
    } else {
      const prefix = longestDottedPrefix(arch.packages, spec)
      if (prefix !== undefined) base = normalize(`${arch.packages[prefix]}/${spec.slice(prefix.length).replace(/^\./, '').replace(/\./g, '/')}`)
    }
    if (base === undefined) return undefined
    const subs = (ref.names ?? []).flatMap(name => [`${base}/${name}.py`, `${base}/${name}/__init__.py`, `${base}/${name}`])

    return [...subs, `${base}.py`, `${base}/__init__.py`, base]
  }
  // Rust: crate::, super::, self:: resolve within the file's own crate.
  const segments = spec.split('::')
  const head = segments[0]
  const crateSrc = crateSrcDir(normalize(from))
  if (crateSrc === undefined) return undefined
  let moduleDir: string
  if (head === 'crate') moduleDir = crateSrc
  else if (head === 'self' || head === 'super') {
    moduleDir = rustModuleDir(normalize(from), crateSrc)
    let i = 0
    while (segments[i] === 'super' || segments[i] === 'self') {
      if (segments[i] === 'super') moduleDir = moduleDir === crateSrc ? crateSrc : dirname(moduleDir)
      i++
    }
    segments.splice(0, i, 'self')
  } else {
    const prefix = arch.packages[head ?? '']
    if (prefix === undefined) return undefined
    moduleDir = prefix
  }
  const path = segments.slice(1)
  const candidates: string[] = []
  for (let n = path.length; n >= 1; n--) {
    const joined = normalize(`${moduleDir}/${path.slice(0, n).join('/')}`)
    candidates.push(`${joined}.rs`, `${joined}/mod.rs`, joined)
  }
  candidates.push(moduleDir)

  return candidates
}

function longestPrefix(map: Record<string, string>, spec: string): string | undefined {
  return Object.keys(map)
    .filter(prefix => spec === prefix || spec.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || (prefix.endsWith('/') && spec.startsWith(prefix)))
    .sort((a, b) => b.length - a.length)[0]
}

function longestDottedPrefix(map: Record<string, string>, spec: string): string | undefined {
  return Object.keys(map)
    .filter(prefix => spec === prefix || spec.startsWith(`${prefix}.`))
    .sort((a, b) => b.length - a.length)[0]
}

// The crate's src/ directory: the last "src" segment of the path.
function crateSrcDir(path: string): string | undefined {
  const parts = path.split('/')
  const at = parts.lastIndexOf('src')
  if (at === -1 || at === parts.length - 1) return undefined

  return parts.slice(0, at + 1).join('/')
}

// The directory that holds the current module's children: src/a/b.rs → src/a/b,
// src/a/mod.rs → src/a, src/lib.rs → src.
function rustModuleDir(path: string, crateSrc: string): string {
  const dir = dirname(path)
  const file = path.slice(dir.length + (dir === '' ? 0 : 1))
  if (file === 'mod.rs') return dir
  if (dir === crateSrc && (file === 'lib.rs' || file === 'main.rs')) return crateSrc

  return `${dir}/${file.replace(/\.rs$/, '')}`
}

/** The layer an import lands in, judged on its most specific candidate inside a layer. */
export function targetLayer(arch: Architecture, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const layer = layerOf(arch, candidate)
    if (layer !== undefined) return layer
  }

  return undefined
}

export type Violation = {
  file: string
  line: number
  spec: string
  fromLayer: string
  toLayer?: string
  kind: 'direction' | 'forbidden'
  pattern?: string
}

/** Every violating import in one file's text. */
export function violationsIn(arch: Architecture, file: string, text: string): Violation[] {
  const lang = langOf(file)
  if (lang === undefined) return []
  const fromLayer = layerOf(arch, file)
  if (fromLayer === undefined) return []

  return extractImports(lang, text).flatMap(ref => judgeImport(arch, lang, file, fromLayer, ref))
}

function judgeImport(arch: Architecture, lang: Lang, file: string, fromLayer: string, ref: ImportRef): Violation[] {
  const forbidden = arch.forbidImports.find(rule => rule.layer === fromLayer && new RegExp(rule.pattern).test(ref.spec))
  if (forbidden !== undefined) return [{ file, line: ref.line, spec: ref.spec, fromLayer, kind: 'forbidden', pattern: forbidden.pattern }]
  const allowed = arch.allow[fromLayer]
  if (allowed === undefined) return []
  const candidates = resolveImport(arch, lang, file, ref)
  if (candidates === undefined) return []
  const toLayer = targetLayer(arch, candidates)
  if (toLayer === undefined || toLayer === fromLayer || allowed.includes(toLayer)) return []

  return [{ file, line: ref.line, spec: ref.spec, fromLayer, toLayer, kind: 'direction' }]
}

const key = (v: Violation) => `${v.file}|${v.spec}|${v.kind}`

/** Violations in `after` that were not already in `before`: an edit is judged on what it adds. */
export function addedViolations(arch: Architecture, file: string, before: string | undefined, after: string): Violation[] {
  const old = new Set(before === undefined ? [] : violationsIn(arch, file, before).map(key))

  return violationsIn(arch, file, after).filter(v => !old.has(key(v)))
}

export function describeViolation(arch: Architecture, v: Violation): string {
  if (v.kind === 'forbidden') {
    return `${v.file}:${v.line} (layer ${v.fromLayer}) may not import "${v.spec}" (forbidImports /${v.pattern}/). Keep the dependency in an outer layer and reach it through an interface this layer owns (Extract Interface — ${techniqueUrl('Extract Interface')}).`
  }
  const allowed = arch.allow[v.fromLayer] ?? []

  return `${v.file}:${v.line} (layer ${v.fromLayer}) may not import "${v.spec}" (layer ${v.toLayer}). ${v.fromLayer} may import: ${allowed.length === 0 ? 'no other layer' : allowed.join(', ')}. Move the code to the layer that owns it (Move Method — ${techniqueUrl('Move Method')}) or invert the dependency with an interface declared in ${v.fromLayer} (Extract Interface — ${techniqueUrl('Extract Interface')}).`
}

export function refusal(arch: Architecture, archFile: string, violations: Violation[]): string {
  return [`Architecture rule (${archFile}):`, ...violations.map(v => `- ${describeViolation(arch, v)}`), 'If the rule itself is wrong, change the architecture file first, with the user\'s agreement.'].join('\n')
}

/** The rules in a few lines, for the model before it edits. */
export function summary(arch: Architecture, archFile: string): string {
  const lines = [`This repository declares its architecture in ${archFile}; refactor refuses an Edit/Write that adds an import breaking it.`]
  for (const layer of arch.layers) {
    const allow = arch.allow[layer.name]
    lines.push(`- ${layer.name} (${layer.paths.join(', ')}) → ${allow === undefined ? 'not judged' : allow.length === 0 ? 'imports no other layer' : `may import ${allow.join(', ')}`}`)
  }
  for (const rule of arch.forbidImports) lines.push(`- ${rule.layer} may not import /${rule.pattern}/`)
  if (arch.problems.length > 0) lines.push(`Problems in the file (those rules are off): ${arch.problems.join('; ')}`)

  return lines.join('\n')
}

// ---------- whole-repo audit ----------

export type Audit = { violations: Violation[]; layerCycles: string[][]; fileCycles: string[][]; unlayered: number }

/** Resolves every import to an existing file where it can, then reports violations and cycles. */
export function auditRepo(arch: Architecture, files: Map<string, string>): Audit {
  const violations: Violation[] = []
  const fileEdges = new Map<string, Set<string>>()
  const layerEdges = new Map<string, Set<string>>()
  let unlayered = 0
  for (const [file, text] of files) {
    const lang = langOf(file)
    if (lang === undefined) continue
    const fromLayer = layerOf(arch, file)
    if (fromLayer === undefined) unlayered++
    for (const ref of extractImports(lang, text)) {
      if (fromLayer !== undefined) violations.push(...judgeImport(arch, lang, file, fromLayer, ref))
      const candidates = resolveImport(arch, lang, file, ref)
      const target = candidates?.find(candidate => files.has(candidate))
      if (target === undefined || target === file) continue
      edge(fileEdges, file, target)
      const toLayer = layerOf(arch, target)
      if (fromLayer !== undefined && toLayer !== undefined && toLayer !== fromLayer) edge(layerEdges, fromLayer, toLayer)
    }
  }

  return { violations, layerCycles: cycles(layerEdges), fileCycles: cycles(fileEdges), unlayered }
}

function edge(map: Map<string, Set<string>>, from: string, to: string) {
  const set = map.get(from) ?? new Set<string>()
  set.add(to)
  map.set(from, set)
}

/** Strongly connected components of more than one node (Tarjan), each sorted. */
export function cycles(edges: Map<string, Set<string>>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const out: string[][] = []
  const nodes = new Set<string>([...edges.keys(), ...[...edges.values()].flatMap(set => [...set])])
  const visit = (node: string) => {
    indices.set(node, index)
    low.set(node, index)
    index++
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number))
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node) as number, indices.get(next) as number))
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = []
      let top: string | undefined
      do {
        top = stack.pop() as string
        onStack.delete(top)
        component.push(top)
      } while (top !== node)
      if (component.length > 1) out.push(component.sort())
    }
  }
  for (const node of nodes) if (!indices.has(node)) visit(node)

  return out
}

/** A starting architecture.json from the directory names a repo already has. */
export function draftArchitecture(files: string[]): string {
  const KNOWN: Array<[string, RegExp]> = [
    ['domain', /^(domain|core|model|models|entities|entity)$/],
    ['app', /^(app|application|services|service|usecases|use_cases)$/],
    ['infra', /^(infra|infrastructure|adapters|adapter|db|repositories|repository|persistence|storage)$/],
    ['interface', /^(api|routes|routers|handlers|controllers|cli|ui|web|views|commands)$/],
  ]
  const found = new Map<string, Set<string>>()
  for (const file of files) {
    if (langOf(file) === undefined) continue
    const parts = normalize(file).split('/')
    for (let i = 0; i < parts.length - 1 && i < 4; i++) {
      const hit = KNOWN.find(([, pattern]) => pattern.test(parts[i] as string))
      if (hit === undefined) continue
      const set = found.get(hit[0]) ?? new Set<string>()
      set.add(`${parts.slice(0, i + 1).join('/')}/**`)
      found.set(hit[0], set)
      break
    }
  }
  const layers = KNOWN.map(([name]) => name).filter(name => found.has(name))
  const order = ['domain', 'app', 'infra', 'interface']
  const allow: Record<string, string[]> = {}
  for (const name of layers) {
    // Inner layers know nothing of outer ones; infra implements app/domain ports.
    const inner = name === 'infra' ? ['domain', 'app'] : order.slice(0, order.indexOf(name))
    allow[name] = inner.filter(layer => layers.includes(layer))
  }

  return JSON.stringify(
    { layers: layers.map(name => ({ name, paths: [...(found.get(name) ?? [])].sort() })), allow, packages: {}, forbidImports: [], smells: DEFAULT_LIMITS },
    null,
    2,
  )
}
