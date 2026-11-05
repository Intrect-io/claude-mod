import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Architecture, RefactorState, Toggles } from '../types'
import { addedViolations, auditRepo, draftArchitecture, normalize, parseArchitecture, refusal, summary, violationsIn } from './arch'
import type { Violation } from './arch'
import { renderCatalog, SMELLS } from './catalog'
import { extractImports, langOf } from './imports'
import { smellNote, smellsIn } from './smells'

// refactor: the architecture a repository declares in .claude/architecture.json,
// enforced where the model edits (Edit, Write); code-smell notes keyed
// to refactoring.guru; a stop-time audit for what reached the disk another way.

const STORE_KEY = 'toggles'
const COMMAND = 'arch'
const FEATURES: Record<string, keyof Toggles> = { arch: 'arch', smells: 'smells', 'stop-audit': 'stopAudit', 'llm-review': 'llmReview' }
const INITIAL_STATE: RefactorState = { noted: [] }
// A whole-repo audit reads at most this many source files.
const AUDIT_MAX_FILES = 4000
// The model review sees at most this much diff.
const REVIEW_MAX_CHARS = 12_000

type Options = Record<string, unknown>
type Edit = { old_string: string; new_string: string; replace_all?: boolean }
type EditInput = { file_path?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown; content?: unknown; edits?: unknown }

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

export function defaultToggles(options: Options): Toggles {
  return {
    arch: bool(options.arch, true),
    smells: bool(options.smells, true),
    stopAudit: bool(options.stopAudit, true),
    llmReview: bool(options.llmReview, false),
  }
}

const togglesAtom = atom({ plugin: 'refactor', key: 'toggles' } as const, defaultToggles({}), { shape: 'toggles-1' })
const stateAtom = atom({ plugin: 'refactor', key: 'state' } as const, INITIAL_STATE, { shape: 'state-1' })

async function run($: EngineInterface, argv: string[], timeoutMs = 10_000): Promise<{ ok: boolean; out: string }> {
  try {
    const ran = await $.process.run(argv, { timeoutMs })

    return { ok: ran.exitCode === 0, out: ran.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 1))

// Repo roots by directory: one git call per directory per module load.
const rootCache = new Map<string, string | undefined>()

async function repoRoot($: EngineInterface, dir: string): Promise<string | undefined> {
  if (rootCache.has(dir)) return rootCache.get(dir)
  const ran = await run($, ['git', '-C', dir, 'rev-parse', '--show-toplevel'], 5_000)
  const root = ran.ok && ran.out.trim() !== '' ? ran.out.trim() : undefined
  rootCache.set(dir, root)

  return root
}

/** Read fresh on every use: the file is small, and an edit to it applies at once. */
async function loadArchitecture($: EngineInterface, root: string, archFile: string): Promise<Architecture | undefined> {
  const text = await readText($, `${root}/${archFile}`)

  return text === undefined ? undefined : parseArchitecture(text)
}

/** The file as the edit would leave it, or undefined when the edit would not apply. */
export function applyEdit(tool: string, input: EditInput, before: string | undefined): { after: string; touched: { from: number; to: number } } | undefined {
  if (tool === 'Write') {
    if (typeof input.content !== 'string') return undefined

    return { after: input.content, touched: { from: 1, to: input.content.split('\n').length } }
  }
  // An `edits` array (several replacements in one call) is applied in order.
  const edits: Edit[] =
    Array.isArray(input.edits)
      ? (input.edits as unknown[]).filter((edit): edit is Edit => typeof edit === 'object' && edit !== null && typeof (edit as Edit).old_string === 'string' && typeof (edit as Edit).new_string === 'string')
      : typeof input.old_string === 'string' && typeof input.new_string === 'string'
        ? [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all === true }]
        : []
  if (edits.length === 0) return undefined
  let text = before ?? ''
  let from = Number.POSITIVE_INFINITY
  let to = 0
  for (const edit of edits) {
    const at = edit.old_string === '' ? (before === undefined ? 0 : -1) : text.indexOf(edit.old_string)
    if (at === -1) return undefined
    text = edit.replace_all === true && edit.old_string !== '' ? text.split(edit.old_string).join(edit.new_string) : text.slice(0, at) + edit.new_string + text.slice(at + edit.old_string.length)
    const startLine = text.slice(0, at).split('\n').length
    from = Math.min(from, startLine)
    to = Math.max(to, startLine + edit.new_string.split('\n').length - 1)
  }

  return { after: text, touched: { from, to } }
}

// TS specifiers that look like project aliases but are not declared: worth one line.
const ALIAS_LIKE = /^(@\/|~\/|#|src\/)/

export const register: Register = (on, options: Options) => {
  const archFile = typeof options.archFile === 'string' && options.archFile.trim() !== '' ? normalize(options.archFile) : '.claude/architecture.json'

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    const toggles = { ...defaultToggles(options), ...(typeof stored === 'object' && stored !== null ? (stored as Partial<Toggles>) : {}) }
    await update($, togglesAtom, () => toggles)
    await update($, stateAtom, () => INITIAL_STATE)
    rootCache.clear()
    try {
      await $.command.register({
        name: COMMAND,
        description: 'refactor: /arch [status | audit | init | catalog [smell|technique] | on|off arch|smells|stop-audit|llm-review]',
      })
    } catch {
      $.ui.log('refactor: /arch not registered (a command of that name exists)', { to: 'debug' })
    }

    return next(e)
  })

  // Told before the first edit, once per session: the rules, not only refusals.
  on('classic.SessionStart', async ($, e, next) => {
    const below = await next(e)
    const toggles = await read($, togglesAtom)
    if (!toggles.arch) return below
    const cwd = await $.session.cwd().catch(() => undefined)
    const root = cwd === undefined ? undefined : await repoRoot($, cwd)
    const arch = root === undefined ? undefined : await loadArchitecture($, root, archFile)
    if (arch === undefined || arch.layers.length === 0) return below

    return { ...below, additionalContext: [...(below.additionalContext ?? []), summary(arch, archFile)] }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Edit' && e.tool !== 'Write') return next(e)
    const toggles = await read($, togglesAtom)
    if (!toggles.arch && !toggles.smells) return next(e)
    const input = e as unknown as EditInput
    if (typeof input.file_path !== 'string') return next(e)
    let path = input.file_path
    if (!path.startsWith('/')) {
      const cwd = await $.session.cwd().catch(() => undefined)
      if (cwd === undefined) return next(e)
      path = `${cwd}/${path}`
    }
    const lang = langOf(path)
    if (lang === undefined) return next(e)
    const root = await repoRoot($, dirOf(path))
    if (root === undefined || !path.startsWith(`${root}/`)) return next(e)
    const file = normalize(path.slice(root.length + 1))
    const before = await readText($, path)
    const edit = applyEdit(e.tool, input, before)
    if (edit === undefined) return next(e)
    const arch = await loadArchitecture($, root, archFile)
    const notes: string[] = []
    if (arch !== undefined && toggles.arch) {
      const added = addedViolations(arch, file, before, edit.after)
      if (added.length > 0) return { deny: refusal(arch, archFile, added) }
      if (lang === 'ts') {
        const old = new Set(before === undefined ? [] : extractImports(lang, before).map(ref => ref.spec))
        const unknown = extractImports(lang, edit.after)
          .map(ref => ref.spec)
          .filter(spec => !old.has(spec) && ALIAS_LIKE.test(spec) && !Object.keys(arch.packages).some(prefix => spec.startsWith(prefix)))
        if (unknown.length > 0) notes.push(`refactor: ${[...new Set(unknown)].join(', ')} could not be judged against ${archFile}: declare the alias under "packages" (e.g. "@/": "src/") to have it checked.`)
      }
    }
    if (toggles.smells) {
      const note = smellNote(file, smellsIn(lang, edit.after, arch?.smells ?? parseArchitecture('{}').smells, edit.touched))
      if (note !== undefined) notes.push(note)
    }
    const result = await next(e)
    if (result.deny !== undefined || notes.length === 0) return result

    return { ...result, context: [...(result.context ?? []), ...notes] }
  })

  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    if (e.agent_id !== undefined || below.block !== undefined || below.preventContinuation === true) return below
    const toggles = await read($, togglesAtom)
    if (!toggles.stopAudit && !toggles.llmReview) return below
    const cwd = await $.session.cwd().catch(() => undefined)
    const root = cwd === undefined ? undefined : await repoRoot($, cwd)
    if (root === undefined) return below
    const changed = await changedFiles($, root)
    if (changed.length === 0) return below
    const notes: string[] = []
    const arch = toggles.stopAudit ? await loadArchitecture($, root, archFile) : undefined
    if (arch !== undefined) {
      const state = await read($, stateAtom)
      const fresh: Array<{ key: string; v: Violation }> = []
      for (const file of changed) {
        const text = await readText($, `${root}/${file}`)
        if (text === undefined) continue
        for (const v of violationsIn(arch, file, text)) {
          const key = `${v.file}|${v.spec}`
          if (!state.noted.includes(key)) fresh.push({ key, v })
        }
      }
      if (fresh.length > 0) {
        await update($, stateAtom, s => ({ ...s, noted: [...s.noted, ...fresh.map(f => f.key)] }))
        notes.push(
          [
            `refactor: files changed since HEAD break ${archFile} (they reached the disk without passing the Edit/Write check, or were already there):`,
            ...fresh.map(f => `- ${refusal(arch, archFile, [f.v]).split('\n')[1]?.slice(2)}`),
          ].join('\n'),
        )
      }
    }
    if (toggles.llmReview) {
      const review = await llmReview($, root)
      if (review !== undefined) notes.push(review)
    }
    if (notes.length === 0) return below

    return { ...below, additionalContext: [...(below.additionalContext ?? []), ...notes] }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    const [action = 'status', ...rest] = words
    const toggles = await read($, togglesAtom)
    if (action === 'catalog') return { text: renderCatalog(rest.join(' ')) }
    if (action === 'on' || action === 'off') {
      const key = FEATURES[rest[0] ?? '']
      if (key === undefined) return { text: `Unknown feature "${rest[0] ?? ''}". One of: ${Object.keys(FEATURES).join(', ')}.` }
      const changed = { ...toggles, [key]: action === 'on' }
      await update($, togglesAtom, () => changed)
      await $.store.set(STORE_KEY, changed)

      return { text: `refactor: ${rest[0]} ${action} (kept for later sessions).` }
    }
    const cwd = await $.session.cwd().catch(() => undefined)
    const root = cwd === undefined ? undefined : await repoRoot($, cwd)
    if (root === undefined) return { text: 'refactor: not inside a git repository.' }
    const arch = await loadArchitecture($, root, archFile)
    if (action === 'init') {
      const files = (await run($, ['git', '-C', root, 'ls-files'], 20_000)).out.split('\n').filter(line => line !== '')
      const exists = arch !== undefined ? `\n\n${archFile} already exists; this draft does not replace it.` : ''

      return { text: `Draft for ${root}/${archFile} (not written; review the layers and allow list, then save it):\n\n\`\`\`json\n${draftArchitecture(files)}\n\`\`\`${exists}` }
    }
    if (action === 'audit') return { text: await auditCommand($, root, arch) }
    const flags = Object.entries(FEATURES)
      .map(([name, key]) => `${name} ${toggles[key] ? 'on' : 'off'}`)
      .join(' · ')

    return { text: [flags, arch === undefined ? `No ${archFile} in ${root}: nothing is enforced here. /arch init drafts one.` : summary(arch, archFile)].join('\n') }
  })
}

async function changedFiles($: EngineInterface, root: string): Promise<string[]> {
  const tracked = await run($, ['git', '-C', root, 'diff', '--name-only', 'HEAD'])
  const untracked = await run($, ['git', '-C', root, 'ls-files', '--others', '--exclude-standard'])

  return [...new Set([...tracked.out.split('\n'), ...untracked.out.split('\n')].map(line => line.trim()).filter(line => line !== '' && langOf(line) !== undefined))]
}

async function auditCommand($: EngineInterface, root: string, arch: Architecture | undefined): Promise<string> {
  const listed = (await run($, ['git', '-C', root, 'ls-files'], 20_000)).out
    .split('\n')
    .filter(file => file !== '' && langOf(file) !== undefined)
  const files = new Map<string, string>()
  for (const file of listed.slice(0, AUDIT_MAX_FILES)) {
    const text = await readText($, `${root}/${file}`)
    if (text !== undefined) files.set(file, text)
  }
  const lines = [`refactor audit of ${root}: ${files.size} source files${listed.length > AUDIT_MAX_FILES ? ` (first ${AUDIT_MAX_FILES} of ${listed.length})` : ''}.`]
  const limits = arch?.smells ?? parseArchitecture('{}').smells
  if (arch !== undefined) {
    const audit = auditRepo(arch, files)
    lines.push('', `## Layer violations (${audit.violations.length})`)
    for (const v of audit.violations.slice(0, 50)) lines.push(`- ${v.file}:${v.line} ${v.fromLayer} → ${v.kind === 'forbidden' ? `forbidden "${v.spec}"` : `${v.toLayer} ("${v.spec}")`}`)
    lines.push('', `## Layer cycles (${audit.layerCycles.length})`, ...audit.layerCycles.map(c => `- ${c.join(' ⇄ ')}`))
    lines.push('', `## File import cycles (${audit.fileCycles.length})`, ...audit.fileCycles.slice(0, 20).map(c => `- ${c.join(' ⇄ ')}`))
    if (audit.unlayered > 0) lines.push('', `${audit.unlayered} source files match no layer and are not judged.`)
    if (arch.problems.length > 0) lines.push('', `Problems in the architecture file: ${arch.problems.join('; ')}`)
  } else lines.push('', 'No architecture file: layers are not checked. /arch init drafts one.')
  const smells: Array<{ file: string; smell: string; where: string; detail: string }> = []
  for (const [file, text] of files) {
    const lang = langOf(file)
    if (lang !== undefined) for (const f of smellsIn(lang, text, limits)) smells.push({ file, ...f })
  }
  const counts = new Map<string, number>()
  for (const s of smells) counts.set(s.smell, (counts.get(s.smell) ?? 0) + 1)
  lines.push('', `## Smells (${smells.length}): ${[...counts].map(([name, n]) => `${name} ${n}`).join(', ') || 'none'}`)
  for (const s of smells.slice(0, 30)) lines.push(`- ${s.file} ${s.where}: ${s.smell}, ${s.detail}`)
  lines.push('', '/arch catalog <smell> names the refactorings for each.')

  return lines.join('\n')
}

// Phase 2, off by default: one small-model read of the turn's diff, a note only.
// Reviewed once per distinct diff, so a stop with nothing new costs nothing.
let lastReviewed = ''

async function llmReview($: EngineInterface, root: string): Promise<string | undefined> {
  const diff = (await run($, ['git', '-C', root, 'diff', 'HEAD', '--unified=3'], 20_000)).out
  if (diff.trim() === '' || diff === lastReviewed) return undefined
  lastReviewed = diff
  const prompt = [
    'You review a code diff for code smells from this catalog (refactoring.guru names):',
    SMELLS.map(smell => smell.name).join(', '),
    'Report at most 5 findings that the added lines (+) introduce, one per line, as: file:line — Smell — the refactoring to apply.',
    'Report only clear cases. If there are none, answer exactly: none',
    '',
    diff.slice(0, REVIEW_MAX_CHARS),
  ].join('\n')
  const reply = await $.model.complete({ model: 'haiku', prompt, effort: 'low', timeoutMs: 20_000 }).catch(() => undefined)
  if (reply === undefined || !reply.isAnswered) return undefined
  const text = reply.text.trim()
  if (text === '' || /^none\.?$/i.test(text)) return undefined

  return `refactor (model review of the diff, a note only; check before acting):\n${text}`
}
