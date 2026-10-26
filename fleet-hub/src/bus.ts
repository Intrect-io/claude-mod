import { Database } from 'bun:sqlite'

import type { From, Msg, SessionInfo, SessionState } from './schema'
import { isDm, ORCHESTRATOR_NAME } from './schema'

// The channel bus and session registry: one SQLite file, WAL, append-only
// messages. A DM (channel "@<sessionId>") also lands in that session's inbox,
// which the fleet mod polls and turns into a prompt; channel messages are read
// on demand and never wake a session.

export const OFFLINE_AFTER_MS = 90_000
export const RETAIN_MS = 90 * 24 * 3600_000

export type BusEvent = { type: 'message'; msg: Msg } | { type: 'session'; session: SessionInfo }

type SessionRow = { id: string; name: string; cwd: string; repo: string | null; branch: string | null; state: string; last_seen: number; summary: string | null; via: string | null }
type MsgRow = { id: string; ts: number; channel: string; from_kind: string; from_id: string; from_name: string; text: string; reply_to: string | null }

const toSession = (r: SessionRow): SessionInfo => ({
  id: r.id,
  name: r.name,
  cwd: r.cwd,
  repo: r.repo ?? undefined,
  branch: r.branch ?? undefined,
  state: r.state as SessionState,
  lastSeen: r.last_seen,
  summary: r.summary ?? undefined,
  via: r.via === 'fleet' || r.via === 'native' ? r.via : undefined,
})

const toMsg = (r: MsgRow): Msg => ({
  id: r.id,
  ts: r.ts,
  channel: r.channel,
  from: { kind: r.from_kind as From['kind'], id: r.from_id, name: r.from_name },
  text: r.text,
  replyTo: r.reply_to ?? undefined,
})

export class Bus {
  readonly db: Database
  private listeners = new Set<(event: BusEvent) => void>()

  constructor(path: string, private now: () => number = Date.now) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, repo TEXT, branch TEXT,
        state TEXT NOT NULL, last_seen INTEGER NOT NULL, summary TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, channel TEXT NOT NULL,
        from_kind TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL,
        text TEXT NOT NULL, reply_to TEXT);
      CREATE INDEX IF NOT EXISTS messages_channel_ts ON messages(channel, ts);
      CREATE TABLE IF NOT EXISTS inbox (
        msg_id TEXT NOT NULL, session_id TEXT NOT NULL, delivered_at INTEGER,
        PRIMARY KEY (msg_id, session_id));
    `)
    // Added after the first release: a database from then gains the column.
    const columns = this.db.query('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    if (!columns.some(c => c.name === 'via')) this.db.exec('ALTER TABLE sessions ADD COLUMN via TEXT')
  }

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: BusEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A broken listener (a closed socket) never stops the bus.
      }
    }
  }

  // A session says hello on every start and every mod reload: upsert by id.
  hello(info: Omit<SessionInfo, 'state' | 'lastSeen'> & { state?: SessionState }): SessionInfo {
    const now = this.now()
    this.db
      .query(
        `INSERT INTO sessions (id, name, cwd, repo, branch, state, last_seen, summary, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, cwd = excluded.cwd, repo = excluded.repo,
           branch = excluded.branch, state = excluded.state, last_seen = excluded.last_seen,
           summary = COALESCE(excluded.summary, sessions.summary), via = COALESCE(excluded.via, sessions.via)`,
      )
      .run(info.id, info.name, info.cwd, info.repo ?? null, info.branch ?? null, info.state ?? 'idle', now, info.summary ?? null, info.via ?? null)
    const session = this.session(info.id)!
    this.emit({ type: 'session', session })
    return session
  }

  setState(id: string, state: SessionState, summary?: string): SessionInfo | undefined {
    const changed = this.db
      .query('UPDATE sessions SET state = ?, last_seen = ?, summary = COALESCE(?, summary) WHERE id = ?')
      .run(state, this.now(), summary ?? null, id)
    if (changed.changes === 0) return undefined
    const session = this.session(id)!
    this.emit({ type: 'session', session })
    return session
  }

  // Any request from a session counts as a heartbeat; no event unless it was offline.
  touch(id: string) {
    const before = this.session(id)
    if (before === undefined) return
    this.db.query('UPDATE sessions SET last_seen = ? WHERE id = ?').run(this.now(), id)
    if (before.state === 'offline') this.setState(id, 'idle')
  }

  session(id: string): SessionInfo | undefined {
    const row = this.db.query('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | null
    return row === null ? undefined : toSession(row)
  }

  sessions(): SessionInfo[] {
    return (this.db.query('SELECT * FROM sessions ORDER BY last_seen DESC').all() as SessionRow[]).map(toSession)
  }

  // Sessions not heard from in OFFLINE_AFTER_MS go offline.
  sweep() {
    const cutoff = this.now() - OFFLINE_AFTER_MS
    const stale = this.db.query("SELECT * FROM sessions WHERE state != 'offline' AND last_seen < ?").all(cutoff) as SessionRow[]
    for (const row of stale) {
      this.db.query("UPDATE sessions SET state = 'offline' WHERE id = ?").run(row.id)
      this.emit({ type: 'session', session: { ...toSession(row), state: 'offline' } })
    }
    this.db.query('DELETE FROM messages WHERE ts < ?').run(this.now() - RETAIN_MS)
  }

  post(channel: string, from: From, text: string, replyTo?: string): Msg {
    const msg: Msg = { id: crypto.randomUUID(), ts: this.now(), channel, from, text, replyTo }
    this.db
      .query('INSERT INTO messages (id, ts, channel, from_kind, from_id, from_name, text, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(msg.id, msg.ts, channel, from.kind, from.id, from.name, text, replyTo ?? null)
    if (isDm(channel)) {
      const target = channel.slice(1)
      // The orchestrator reads its DMs from the bus, not from an inbox.
      if (target !== from.id && target !== ORCHESTRATOR_NAME) this.db.query('INSERT OR IGNORE INTO inbox (msg_id, session_id) VALUES (?, ?)').run(msg.id, target)
    }
    this.emit({ type: 'message', msg })
    return msg
  }

  // Messages of one channel after `since`, oldest first, at most `limit`.
  read(channel: string, since = 0, limit = 50): Msg[] {
    const rows = this.db
      .query('SELECT * FROM (SELECT * FROM messages WHERE channel = ? AND ts > ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC')
      .all(channel, since, limit) as MsgRow[]
    return rows.map(toMsg)
  }

  // A session's DMs as well as the ones it sent: its conversation view.
  dmThread(sessionId: string, since = 0, limit = 50): Msg[] {
    const rows = this.db
      .query(
        `SELECT * FROM (SELECT * FROM messages WHERE (channel = ? OR (channel LIKE '@%' AND from_id = ?)) AND ts > ?
         ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC`,
      )
      .all(`@${sessionId}`, sessionId, since, limit) as MsgRow[]
    return rows.map(toMsg)
  }

  channels(): Array<{ channel: string; count: number; lastTs: number }> {
    return this.db
      .query("SELECT channel, COUNT(*) AS count, MAX(ts) AS lastTs FROM messages WHERE channel LIKE '#%' GROUP BY channel ORDER BY lastTs DESC")
      .all() as Array<{ channel: string; count: number; lastTs: number }>
  }

  // Undelivered inbox messages of a session, oldest first.
  inbox(sessionId: string): Msg[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM inbox i JOIN messages m ON m.id = i.msg_id
         WHERE i.session_id = ? AND i.delivered_at IS NULL ORDER BY m.ts ASC LIMIT 20`,
      )
      .all(sessionId) as MsgRow[]
    return rows.map(toMsg)
  }

  ack(sessionId: string, ids: readonly string[]): number {
    let count = 0
    const stmt = this.db.query('UPDATE inbox SET delivered_at = ? WHERE session_id = ? AND msg_id = ? AND delivered_at IS NULL')
    for (const id of ids) count += stmt.run(this.now(), sessionId, id).changes
    return count
  }

  close() {
    this.db.close()
  }
}
