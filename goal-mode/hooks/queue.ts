// The loop's work queue: a Markdown checklist a person writes, one goal per
// line. `[ ]` pending, `[x]` done, `[!]` blocked; the loop appends its note as
// a trailing HTML comment so the line stays readable.
//
//   - [ ] fix add() :: check: pytest -q tests/test_counter.py
//   - [x] fix add() :: check: pytest -q <!-- done 2026-10-24T13:10Z goal/01-fix-add, 4 checks -->
//   - [ ] make CI green on PR #4 :: check: gh pr checks 4 :: base: goal/03-x   (worktree starts from that ref)

export type QueueMark = ' ' | 'x' | '!'

export type QueueItem = {
  line: number
  mark: QueueMark
  condition: string
  check?: string
  // The ref the goal's worktree starts from, over .claude/goal-loop.base.
  base?: string
  note?: string
}

const ITEM = /^\s*[-*] \[([ xX!])\] (.*)$/
const NOTE = /\s*<!--([\s\S]*?)-->\s*$/
const CHECK = ' :: check:'
const BASE = /\s+:: base:\s*(\S+)\s*$/

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
    const at = body.indexOf(CHECK)
    const condition = (at < 0 ? body : body.slice(0, at)).trim()
    const check = at < 0 ? undefined : body.slice(at + CHECK.length).trim() || undefined
    if (condition === '') return
    items.push({ line, mark, condition, check, ...(base !== undefined ? { base } : {}), note })
  })

  return items
}

export function nextPending(items: readonly QueueItem[]): QueueItem | undefined {
  return items.find(item => item.mark === ' ')
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
  lines[target.line] = `${marked} <!-- ${note.replace(/--!?>/g, '- ->').replace(/\n/g, ' ')} -->`

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
