// The loop's work queue: a Markdown checklist a person writes, one goal per
// line. auto-claude's loop reads and marks it; its driver writes it and reads
// it, so both must parse it the same way. `[ ]` pending, `[x]` done, `[!]` blocked; the loop appends its note as
// a trailing HTML comment so the line stays readable.
//
//   - [ ] fix add() :: check: pytest -q tests/test_counter.py
//   - [x] fix add() :: check: pytest -q <!-- done 2026-10-24T13:10Z goal/01-fix-add, 4 checks -->
//   - [ ] make CI green on PR #4 :: check: gh pr checks 4 :: base: goal/03-x   (worktree starts from that ref)
//
// A line that waits on something with its own clock (a training run, a cache
// build, a file another milestone lands) names it as shell commands after its
// check, in this order, each optional, `base` always last:
//
//   - [ ] record the M21 cache :: check: pytest -q :: after: grep -q DONE ~/data/cache.log :: alive: tmux has-session -t cache :: within: 12h
//
// `after` must exit 0 before the line starts; the driver polls it. `alive`
// failing says the awaited job died; `within` is how long the wait may take
// before the model is asked to look (`90m`, `12h`, `2d`).

export type QueueMark = ' ' | 'x' | '!'

export type QueueItem = {
  line: number
  mark: QueueMark
  condition: string
  check?: string
  // The ref the goal's worktree starts from, over .claude/goal-loop.base.
  base?: string
  // A wait: the line starts only once `after` exits 0.
  after?: string
  alive?: string
  withinMs?: number
  note?: string
}

const ITEM = /^\s*[-*] \[([ xX!])\] (.*)$/
const NOTE = /\s*<!--([\s\S]*?)-->\s*$/
const CHECK = ' :: check:'
const BASE = /\s+:: base:\s*(\S+)\s*$/
const WITHIN = /\s+:: within:\s*(\S+)\s*$/
const ALIVE = ' :: alive:'
const AFTER = ' :: after:'

// `90m`, `12h`, `2d`, `1.5h` in milliseconds; undefined for anything else.
export function parseDuration(text: string): number | undefined {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*([mhd])$/)
  if (m === null) return undefined
  const unit = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000
  const ms = Number(m[1]) * unit
  return ms > 0 ? ms : undefined
}

// Takes the last ` :: <name>:` field off the end of a line body.
function takeLast(body: string, marker: string): { body: string; value?: string } {
  const at = body.lastIndexOf(marker)
  if (at < 0) return { body }
  const value = body.slice(at + marker.length).trim()
  return { body: body.slice(0, at), value: value === '' ? undefined : value }
}

export function parseQueue(text: string): QueueItem[] {
  const items: QueueItem[] = []
  text.split('\n').forEach((raw, line) => {
    const match = raw.match(ITEM)
    if (match === null) return
    const mark = (match[1] === 'X' ? 'x' : match[1]) as QueueMark
    let body = match[2] ?? ''
    let note: string | undefined
    const noteMatch = body.match(NOTE)
    if (noteMatch !== null) {
      note = (noteMatch[1] ?? '').trim()
      body = body.slice(0, noteMatch.index)
    }
    let base: string | undefined
    const baseMatch = body.match(BASE)
    if (baseMatch !== null) {
      base = baseMatch[1]
      body = body.slice(0, baseMatch.index)
    }
    let withinMs: number | undefined
    const withinMatch = body.match(WITHIN)
    if (withinMatch !== null) {
      withinMs = parseDuration(withinMatch[1] ?? '')
      body = body.slice(0, withinMatch.index)
    }
    const alive = takeLast(body, ALIVE)
    body = alive.body
    const after = takeLast(body, AFTER)
    body = after.body
    const at = body.indexOf(CHECK)
    const condition = (at < 0 ? body : body.slice(0, at)).trim()
    const check = at < 0 ? undefined : body.slice(at + CHECK.length).trim() || undefined
    if (condition === '') return
    items.push({
      line,
      mark,
      condition,
      check,
      ...(after.value !== undefined ? { after: after.value } : {}),
      ...(alive.value !== undefined ? { alive: alive.value } : {}),
      ...(withinMs !== undefined ? { withinMs } : {}),
      ...(base !== undefined ? { base } : {}),
      note,
    })
  })

  return items
}

// The next line to build. A line built on another branch (`:: base:`, a
// driver's fix goal) goes first: it repairs work already shipped, which later
// lines may build on. `ready` says whether a waiting line's `after` passed;
// by default a waiting line is never ready, so a caller that does not poll
// waits never starts one early.
export function nextPending(items: readonly QueueItem[], ready: (item: QueueItem) => boolean = item => item.after === undefined): QueueItem | undefined {
  const open = items.filter(item => item.mark === ' ' && ready(item))
  return open.find(item => item.base !== undefined) ?? open[0]
}

// Pending lines still waiting on their `after`.
export function waitingItems(items: readonly QueueItem[], ready: (item: QueueItem) => boolean): QueueItem[] {
  return items.filter(item => item.mark === ' ' && item.after !== undefined && !ready(item))
}

// Marks the first pending line whose condition matches, so a person editing
// the file meanwhile does not shift the loop onto the wrong line.
export function markItem(text: string, condition: string, mark: 'x' | '!', note: string): string {
  const lines = text.split('\n')
  const target = parseQueue(text).find(item => item.mark === ' ' && item.condition === condition)
  if (target === undefined) return text
  const raw = lines[target.line] ?? ''
  const withoutNote = raw.replace(NOTE, '')
  const marked = withoutNote.replace(/\[[ xX!]\]/, `[${mark}]`)
  lines[target.line] = `${marked} <!-- ${cleanNote(note)} -->`

  return lines.join('\n')
}

export type Wait = { after: string; alive?: string; within?: string }

// Puts a pending line back to wait: it keeps its condition and check, waits on
// `after`, and starts again from `base` (the branch it was built on so far).
export function requeueItem(text: string, condition: string, wait: Wait, base: string, note: string): string {
  const lines = text.split('\n')
  const target = parseQueue(text).find(item => item.mark === ' ' && item.condition === condition)
  if (target === undefined) return text
  const raw = lines[target.line] ?? ''
  const bullet = raw.match(/^(\s*[-*]) \[/)?.[1] ?? '-'
  const fields = [
    target.check !== undefined ? `${CHECK} ${target.check}` : '',
    `${AFTER} ${oneLine(wait.after)}`,
    wait.alive !== undefined && wait.alive.trim() !== '' ? `${ALIVE} ${oneLine(wait.alive)}` : '',
    wait.within !== undefined && wait.within.trim() !== '' ? ` :: within: ${wait.within.trim()}` : '',
    ` :: base: ${base}`,
  ].join('')
  lines[target.line] = `${bullet} [ ] ${target.condition}${fields} <!-- ${cleanNote(note)} -->`

  return lines.join('\n')
}

export function summarize(items: readonly QueueItem[]): { done: number; blocked: number; pending: number; total: number } {
  const count = (mark: QueueMark) => items.filter(item => item.mark === mark).length

  return { done: count('x'), blocked: count('!'), pending: count(' '), total: items.length }
}

export function slugify(condition: string): string {
  const slug = condition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '')

  return slug === '' ? 'goal' : slug
}

function cleanNote(note: string): string {
  return note.replace(/--!?>/g, '- ->').replace(/\n/g, ' ')
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}
