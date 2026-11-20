// The D1 event queue (migrations/0001_init.sql). A row is unique on its event key,
// so a retried or re-sent webhook is written once.

import type { QueuedEvent } from './webhook'

// project_id: null = not looked up yet (or the lookup failed), '' = the issue has no project.
export const NO_PROJECT = ''
// How long an unresolved row holds back the rows after it before it is passed over.
export const HOLD_BACK_MS = 30 * 60_000
export const PAGE = 100

export type EventRow = {
  id: number
  action: 'created' | 'prompted'
  sessionId: string
  issueId: string
  projectId: string | null
  identifier: string | null
  title: string | null
  url: string | null
  prompt: string | null
  signal: string | null
  createdAt: number
}

type DbRow = {
  id: number
  key: string
  action: 'created' | 'prompted'
  session_id: string
  issue_id: string
  project_id: string | null
  identifier: string | null
  title: string | null
  url: string | null
  prompt: string | null
  signal: string | null
  created_at: number
}

const toRow = (r: DbRow): EventRow => ({
  id: r.id,
  action: r.action,
  sessionId: r.session_id,
  issueId: r.issue_id,
  projectId: r.project_id,
  identifier: r.identifier,
  title: r.title,
  url: r.url,
  prompt: r.prompt,
  signal: r.signal,
  createdAt: r.created_at,
})

// True when this delivery should be answered as new: the row is new, or an earlier delivery's
// write committed only after that delivery was answered 503 (never confirmed). False when a
// delivery of this event was already answered 200.
export async function insertEvent(db: D1Database, e: QueuedEvent, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      'INSERT OR IGNORE INTO events (key, delivery_id, action, session_id, issue_id, identifier, title, url, prompt, signal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(e.key, e.deliveryId ?? null, e.action, e.sessionId, e.issueId, e.identifier ?? null, e.title ?? null, e.url ?? null, e.prompt ?? null, e.signal ?? null, now)
    .run()
  if ((result.meta.changes ?? 0) > 0) return true
  const row = await db.prepare('SELECT confirmed FROM events WHERE key = ?').bind(e.key).first<{ confirmed: number }>()
  return row !== null && row.confirmed === 0
}

// Marks the event answered 200, so later deliveries of it are duplicates.
export async function confirmEvent(db: D1Database, key: string): Promise<void> {
  await db.prepare('UPDATE events SET confirmed = 1 WHERE key = ?').bind(key).run()
}

export async function setProject(db: D1Database, key: string, projectId: string): Promise<void> {
  await db.prepare('UPDATE events SET project_id = ? WHERE key = ?').bind(projectId, key).run()
}

export async function setProjectById(db: D1Database, id: number, projectId: string): Promise<void> {
  await db.prepare('UPDATE events SET project_id = ? WHERE id = ?').bind(projectId, id).run()
}

export const LOOKUP_BATCH = 20

// Rows after the cursor whose project is not known yet and that are young enough to hold the
// rest back, oldest first.
export async function unresolvedSince(db: D1Database, since: number, youngerThan: number, limit = LOOKUP_BATCH): Promise<Array<{ id: number; issueId: string }>> {
  const { results } = await db
    .prepare('SELECT id, issue_id FROM events WHERE id > ? AND project_id IS NULL AND created_at > ? ORDER BY id LIMIT ?')
    .bind(since, youngerThan, limit)
    .all<{ id: number; issue_id: string }>()
  return results.map(r => ({ id: r.id, issueId: r.issue_id }))
}

// Rows whose lookup kept failing past the hold-back window are given up (no project), so they
// neither hold anything back nor cost a Linear call on every read.
export async function giveUpUnresolved(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare('UPDATE events SET project_id = ? WHERE project_id IS NULL AND created_at <= ?').bind(NO_PROJECT, olderThan).run()
}

// The project's rows after the cursor, below `before` when an unresolved row holds the rest back.
export async function eventsSince(db: D1Database, projectId: string, since: number, before?: number): Promise<EventRow[]> {
  const sql =
    before === undefined
      ? 'SELECT * FROM events WHERE id > ? AND project_id = ? ORDER BY id LIMIT ?'
      : 'SELECT * FROM events WHERE id > ? AND id < ? AND project_id = ? ORDER BY id LIMIT ?'
  const stmt = before === undefined ? db.prepare(sql).bind(since, projectId, PAGE) : db.prepare(sql).bind(since, before, projectId, PAGE)
  const { results } = await stmt.all<DbRow>()
  return results.map(toRow)
}
