import type { EngineInterface } from 'claude-code'

import type { LinearSync } from '../types'

// Linear sync (2026-11-13: runs kept missing issue updates). The driver, not
// the model, reads the repository's Linear project on a timer and writes back:
// - a planning prompt lists the project's open issues; a milestone that
//   resolves one starts with its ID: `- [ ] [AX-12] <end state> :: check: ...`;
// - every SYNC_MS the open issues and their newest comments are read; an issue
//   that is new or changed since the run last covered it, and has no milestone
//   pending, gets one appended to the queue (the driver's line has no check:
//   the evaluator judges it);
// - a milestone that starts moves its issues to started; one that merges moves
//   them to completed with an evidence comment, unless comments came in while it
//   was built (then a follow-up line is queued instead); a held or blocked one
//   gets a comment only.
// Only a repository mapped to a project in ~/.claude/linear.json (projectId or
// projectName under repo_mapping.<folder name>) syncs: a team alone is shared
// by many repositories. Comments the driver writes start with MARK, so its own
// writes never count as changes. Comments do not move an issue's updatedAt
// (measured 2026-11-13), so they are read on their own.

export const LINEAR_SERVER = 'linear-server'
export const SYNC_MS = 10 * 60_000
export const MARK = '[auto-claude]'
// Issues whose comments are read on each sync, newest first (plus every issue the run tracks).
export const COMMENT_SCAN = 25
// Lines appended per sync at most; the rest come on the next one.
export const MAX_APPENDS = 5
// Follow-up lines per issue at most: comments that keep coming (a model that
// comments on its own issue) must not grow the queue forever.
export const MAX_FOLLOW_UPS = 2

const ID = /^\s*((?:\[[A-Z][A-Z0-9]{1,5}-\d+\]\s*)+)/
const DONE_TYPES = new Set(['completed', 'canceled', 'cancelled', 'duplicate'])

export type LinearIssue = { id: string; title: string; updatedAt: string; statusType?: string; status?: string }
export type LinearComment = { body: string; createdAt: string }

// Issue IDs a queue condition names at its start: "[AX-1][AX-2] ...".
export function lineIssues(condition: string): string[] {
  const m = condition.match(ID)
  return m === null ? [] : [...m[1]!.matchAll(/\[([A-Z][A-Z0-9]{1,5}-\d+)\]/g)].map(x => x[1]!)
}

export function isOpen(issue: Pick<LinearIssue, 'statusType'>): boolean {
  return !DONE_TYPES.has((issue.statusType ?? '').toLowerCase())
}

// The latest change on an issue: its own update, or the newest comment a
// person wrote (the driver's own, marked, do not count).
export function stampOf(issue: Pick<LinearIssue, 'updatedAt'>, comments: readonly LinearComment[]): string {
  let stamp = issue.updatedAt
  for (const c of comments) if (!c.body.trimStart().startsWith(MARK) && c.createdAt > stamp) stamp = c.createdAt
  return stamp
}

// What one sync does with the open issues: lines to append and the stamps the
// run now covers. `pending`: IDs with a queue line not yet started (it reads
// the issue when it starts, so it covers any change); `active`: IDs being
// built or shipped (their changes are looked at when they merge).
export function planSync(
  issues: readonly LinearIssue[],
  comments: Readonly<Record<string, readonly LinearComment[]>>,
  seen: Readonly<Record<string, string>>,
  pending: ReadonlySet<string>,
  active: ReadonlySet<string>,
  followUps: Readonly<Record<string, number>> = {},
): { append: LinearIssue[]; seen: Record<string, string> } {
  const next: Record<string, string> = { ...seen }
  const append: LinearIssue[] = []
  for (const issue of issues) {
    if (!isOpen(issue)) continue
    const stamp = stampOf(issue, comments[issue.id] ?? [])
    const covered = seen[issue.id]
    if (covered !== undefined && stamp <= covered) continue
    if (active.has(issue.id)) continue
    if (pending.has(issue.id)) {
      next[issue.id] = stamp
      continue
    }
    if (append.length >= MAX_APPENDS) continue
    if (covered !== undefined && (followUps[issue.id] ?? 0) >= MAX_FOLLOW_UPS) {
      next[issue.id] = stamp
      continue
    }
    append.push(issue)
    next[issue.id] = stamp
  }
  return { append, seen: next }
}

// A queue line that stays one line and parses back to the same condition.
function clean(text: string, max: number): string {
  return text.replace(/<!--|-->/g, ' ').replace(/::/g, ':').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function issueLine(issue: Pick<LinearIssue, 'id' | 'title'>, followUp: boolean, since?: string): string {
  const what = followUp
    ? `the comments and changes on ${issue.id} since ${since ?? 'its last milestone'} are handled on this branch`
    : `what Linear ${issue.id} asks is resolved on this branch`
  return `- [ ] [${issue.id}] ${clean(issue.title, 90)}: ${what} (read it first: get_issue and list_comments on ${issue.id}; never change its state or comment on it: auto-claude does)`
}

// The open issues for the planning prompt.
export function issueBrief(issues: readonly LinearIssue[], project: string): string {
  const open = issues.filter(isOpen)
  if (open.length === 0) return `Linear project "${project}" has no open issue now; auto-claude still checks it every ${SYNC_MS / 60_000} min while the run goes.`
  return [
    `Linear project "${project}" has ${open.length} open issue(s) (auto-claude reads it every ${SYNC_MS / 60_000} min and queues what changes):`,
    ...open.slice(0, 60).map(i => `- ${i.id} [${i.status ?? i.statusType ?? '?'}] ${clean(i.title, 100)}`),
    'Read the ones that bear on the goal (get_issue, list_comments). Each milestone that resolves issues starts with their IDs: `- [ ] [AX-12] <end state> :: check: <command>`. auto-claude moves them to started and, once merged, to Done with an evidence comment: never change their state or comment on them yourself. An open issue you leave out gets one line under ## Decisions saying why.',
  ].join('\n')
}

// ~/.claude/linear.json's project for this repository, by its folder name.
export async function projectOf($: EngineInterface, root: string): Promise<string | undefined> {
  const home = (await $.env.get('HOME').catch(() => undefined))?.replace(/\/$/, '')
  if (home === undefined) return undefined
  try {
    const mapping = (JSON.parse(await $.fs.read(`${home}/.claude/linear.json`)) as { repo_mapping?: Record<string, { projectId?: unknown; projectName?: unknown }> }).repo_mapping
    const entry = mapping?.[root.split('/').pop() ?? '']
    const project = entry?.projectId ?? entry?.projectName
    return typeof project === 'string' && project !== '' ? project : undefined
  } catch {
    return undefined
  }
}

async function call($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await $.mcp.call(LINEAR_SERVER, tool, args)
  const text = res.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('')
  if (res.isError) throw new Error(`${tool}: ${text.slice(0, 200)}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// Open state types, asked one by one: a single list sorted by updatedAt fills
// up with recently closed issues and cuts old open ones off (measured
// 2026-11-13). New issues land in backlog by default, so backlog counts.
export const OPEN_TYPES = ['triage', 'backlog', 'unstarted', 'started'] as const

export async function listOpen($: EngineInterface, project: string): Promise<LinearIssue[]> {
  const all: LinearIssue[] = []
  for (const state of OPEN_TYPES) {
    const got = (await call($, 'list_issues', { project, state, limit: 100, orderBy: 'updatedAt', fields: ['id', 'title', 'updatedAt', 'status', 'statusType'] })) as { issues?: unknown[] }
    for (const raw of got.issues ?? []) {
      const i = raw as Record<string, unknown>
      if (typeof i.id === 'string' && typeof i.updatedAt === 'string' && !all.some(x => x.id === i.id)) {
        all.push({ id: i.id, title: String(i.title ?? ''), updatedAt: i.updatedAt, statusType: typeof i.statusType === 'string' ? i.statusType : state, status: typeof i.status === 'string' ? i.status : undefined })
      }
    }
  }
  // Newest change first, so the comment scan reads the live ones.
  return all.filter(isOpen).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export async function listComments($: EngineInterface, id: string): Promise<LinearComment[]> {
  const got = (await call($, 'list_comments', { issueId: id, limit: 10, orderBy: 'createdAt' })) as { comments?: unknown[] }
  return (got.comments ?? []).flatMap(raw => {
    const c = raw as Record<string, unknown>
    return typeof c.body === 'string' && typeof c.createdAt === 'string' ? [{ body: c.body, createdAt: c.createdAt }] : []
  })
}

export async function getIssue($: EngineInterface, id: string): Promise<LinearIssue | undefined> {
  const i = (await call($, 'get_issue', { id, fields: ['id', 'title', 'updatedAt', 'status', 'statusType'] })) as Record<string, unknown>
  return typeof i?.id === 'string' && typeof i.updatedAt === 'string'
    ? { id: i.id, title: String(i.title ?? ''), updatedAt: i.updatedAt, statusType: typeof i.statusType === 'string' ? i.statusType : undefined }
    : undefined
}

export async function setState($: EngineInterface, id: string, state: 'started' | 'completed'): Promise<void> {
  await call($, 'save_issue', { id, state })
}

export async function comment($: EngineInterface, id: string, body: string): Promise<void> {
  await call($, 'save_comment', { issueId: id, body: `${MARK} ${body}` })
}

// One sync: reads the open issues and the newest comments, returns the lines to
// append and the new record. Errors are kept on the record, never thrown.
export async function readChanges(
  $: EngineInterface,
  sync: LinearSync,
  pending: ReadonlySet<string>,
  active: ReadonlySet<string>,
  now: number,
): Promise<{ sync: LinearSync; lines: string[] }> {
  try {
    const issues = await listOpen($, sync.project)
    const tracked = new Set([...pending, ...active, ...Object.keys(sync.seen)])
    const scan = issues.filter((issue, at) => at < COMMENT_SCAN || tracked.has(issue.id))
    const comments: Record<string, LinearComment[]> = {}
    for (const issue of scan) comments[issue.id] = await listComments($, issue.id)
    const planned = planSync(issues, comments, sync.seen, pending, active, sync.followUps ?? {})
    const lines = planned.append.map(issue => issueLine(issue, sync.seen[issue.id] !== undefined, sync.seen[issue.id]))
    const followUps = { ...(sync.followUps ?? {}) }
    for (const issue of planned.append) if (sync.seen[issue.id] !== undefined) followUps[issue.id] = (followUps[issue.id] ?? 0) + 1
    return { sync: { ...sync, seen: planned.seen, followUps, syncedAt: now, error: undefined }, lines }
  } catch (error) {
    return { sync: { ...sync, syncedAt: now, error: String(error).slice(0, 200) }, lines: [] }
  }
}

// The run starts covering every open issue as it is now: the planning prompt
// shows them, so only later changes are queued by the timer.
export async function baseline($: EngineInterface, project: string, now: number): Promise<{ sync: LinearSync; brief: string }> {
  try {
    const issues = await listOpen($, project)
    const seen: Record<string, string> = {}
    for (const issue of issues.slice(0, COMMENT_SCAN)) seen[issue.id] = stampOf(issue, await listComments($, issue.id))
    for (const issue of issues.slice(COMMENT_SCAN)) seen[issue.id] = issue.updatedAt
    return { sync: { project, seen, syncedAt: now }, brief: issueBrief(issues, project) }
  } catch (error) {
    const why = String(error).slice(0, 200)
    return { sync: { project, seen: {}, syncedAt: now, error: why }, brief: `Linear project "${project}" could not be read (${why}); auto-claude tries again every ${SYNC_MS / 60_000} min.` }
  }
}

// The stamp an issue has right after the driver wrote to it, so the driver's
// own write is never read as a change.
async function restamp($: EngineInterface, sync: LinearSync, id: string): Promise<LinearSync> {
  const issue = await getIssue($, id).catch(() => undefined)
  if (issue === undefined) return sync
  const prev = sync.seen[id]
  return { ...sync, seen: { ...sync.seen, [id]: prev !== undefined && prev > issue.updatedAt ? prev : issue.updatedAt } }
}

// A milestone naming issues started: they move to started.
export async function onStart($: EngineInterface, sync: LinearSync, ids: readonly string[]): Promise<LinearSync> {
  for (const id of ids) {
    try {
      await setState($, id, 'started')
      sync = await restamp($, sync, id)
    } catch (error) {
      sync = { ...sync, error: `${id}: ${String(error).slice(0, 160)}` }
    }
  }
  return sync
}

// A milestone naming issues merged: each moves to completed with the evidence,
// unless a person changed it while it was built; then a follow-up line is
// queued and the issue stays open.
export async function onMerged($: EngineInterface, sync: LinearSync, ids: readonly string[], evidence: string): Promise<{ sync: LinearSync; lines: string[] }> {
  const lines: string[] = []
  for (const id of ids) {
    try {
      const issue = await getIssue($, id)
      if (issue === undefined) continue
      const stamp = stampOf(issue, await listComments($, id))
      const covered = sync.seen[id]
      const ups = sync.followUps?.[id] ?? 0
      if (covered !== undefined && stamp > covered && ups < MAX_FOLLOW_UPS) {
        await comment($, id, `${evidence}. It changed in Linear while this was built, so it stays open and a follow-up milestone is queued.`)
        lines.push(issueLine(issue, true, covered))
        sync = { ...sync, seen: { ...sync.seen, [id]: stamp }, followUps: { ...(sync.followUps ?? {}), [id]: ups + 1 } }
        continue
      }
      await comment($, id, `${evidence}. Moved to Done by auto-claude.`)
      await setState($, id, 'completed')
      sync = { ...sync, seen: { ...sync.seen, [id]: stamp } }
    } catch (error) {
      sync = { ...sync, error: `${id}: ${String(error).slice(0, 160)}` }
    }
  }
  return { sync, lines }
}

// A milestone naming issues was held or blocked: a comment, the state kept.
export async function onHeld($: EngineInterface, sync: LinearSync, ids: readonly string[], why: string): Promise<LinearSync> {
  for (const id of ids) {
    try {
      await comment($, id, `The milestone for this issue was held: ${why.slice(0, 300)}. The issue stays open.`)
    } catch (error) {
      sync = { ...sync, error: `${id}: ${String(error).slice(0, 160)}` }
    }
  }
  return sync
}
