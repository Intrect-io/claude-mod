// /auto-claude stats: where a run's wall time went, read from .claude/goal-loop.log.
//
// The driver logs an `activity` event each time what the run is doing changes
// (and at least every HEARTBEAT_MS while it stays the same), so the time between
// two activity events belongs to the earlier one's state. The summarizer here is
// pure: it takes the log's lines and the time now.

import type { AutoPhase, ShipState } from '../types'

export const STATES = ['building', 'waiting-ci', 'waiting-after', 'standby', 'idle-quiet'] as const
export type StatState = (typeof STATES)[number]
export type Activity = StatState | 'off'

// An unchanged state is logged again this often, so a gap much longer than it
// means the driver was not running (the session exited or the machine slept).
export const HEARTBEAT_MS = 30 * 60_000
// Of a gap between two activity events, at most this much is counted to the
// earlier state; the rest is unobserved.
export const MAX_GAP_MS = 2 * HEARTBEAT_MS

const WAITING_CI: ReadonlySet<ShipState> = new Set(['push', 'ci', 'fixing'])

// What the run is doing now. A turn running (or the Stop hook judging, or a
// workflow the turn started) is building, whatever else waits meanwhile.
// idle-quiet: no turn running and nothing awaited.
export function activityOf(input: {
  on: boolean
  phase: AutoPhase
  busy: boolean
  ships: readonly { state: ShipState }[]
  waitCount?: number
  finalCiSince?: number
}): Activity {
  if (!input.on || input.phase === 'done' || input.phase === 'stopped') return 'off'
  if (input.phase === 'standby') return 'standby'
  if (input.busy) return 'building'
  if (input.ships.some(s => WAITING_CI.has(s.state))) return 'waiting-ci'
  if ((input.waitCount ?? 0) > 0 || input.finalCiSince !== undefined) return 'waiting-after'

  return 'idle-quiet'
}

// Whether the driver should log the activity now: on a change, or when the
// same state has not been logged for a heartbeat.
export function activityDue(last: { state: Activity; at: number } | undefined, state: Activity, now: number): boolean {
  if (last === undefined) return state !== 'off'
  if (last.state !== state) return true

  return state !== 'off' && now - last.at >= HEARTBEAT_MS
}

export type RunStats = {
  // The run's startedAt, the key its activity events carry.
  run: number
  from: number
  to: number
  ms: Record<StatState, number>
  unobservedMs: number
  merges: number
  holds: number
  deferrals: number
  open: boolean
}

type Entry = { ts: number; event: string; state?: string; run?: number }

function parse(lines: readonly string[]): Entry[] {
  const out: Entry[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    if (raw === null || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const ts = typeof o.ts === 'string' ? Date.parse(o.ts) : NaN
    if (!Number.isFinite(ts) || typeof o.event !== 'string') continue
    out.push({ ts, event: o.event, state: typeof o.state === 'string' ? o.state : undefined, run: typeof o.run === 'number' ? o.run : undefined })
  }

  return out.sort((a, b) => a.ts - b.ts)
}

function isState(s: string | undefined): s is StatState {
  return (STATES as readonly string[]).includes(s ?? '')
}

// One summary per run with an activity event in the log, newest last. A run is
// kept when it was active within the last `days` days.
export function summarizeStats(lines: readonly string[], now: number, days = 7): RunStats[] {
  const entries = parse(lines)
  const activity = entries.filter(e => e.event === 'activity' && e.run !== undefined)
  const runs = new Map<number, Entry[]>()
  for (const e of activity) runs.set(e.run as number, [...(runs.get(e.run as number) ?? []), e])
  const ends = entries.filter(e => e.event === 'run-done' || e.event === 'run-stopped')
  const out: RunStats[] = []
  for (const [run, evs] of runs) {
    const ms = Object.fromEntries(STATES.map(s => [s, 0])) as Record<StatState, number>
    let unobservedMs = 0
    const from = evs[0].ts
    const last = evs[evs.length - 1]
    // One run owns a repository at a time: a later run's first event ends this one.
    const successor = activity.find(e => e.ts > last.ts && e.run !== run)
    const endAt = Math.min(ends.find(e => e.ts >= last.ts)?.ts ?? Infinity, successor?.ts ?? Infinity)
    const open = last.state !== 'off' && endAt === Infinity
    const to = last.state === 'off' ? last.ts : Number.isFinite(endAt) ? endAt : now
    for (let i = 0; i < evs.length; i++) {
      const cur = evs[i]
      if (!isState(cur.state)) continue
      let next = i + 1 < evs.length ? evs[i + 1].ts : to
      // A run stopped and resumed later: the time it was stopped is not the state's.
      const stopped = ends.find(e => e.ts > cur.ts && e.ts < next)
      if (stopped !== undefined) next = stopped.ts
      const gap = Math.max(0, next - cur.ts)
      ms[cur.state] += Math.min(gap, MAX_GAP_MS)
      unobservedMs += Math.max(0, gap - MAX_GAP_MS)
    }
    const inRun = (e: Entry) => e.ts >= from && e.ts <= to && (e.run === undefined || e.run === run)
    const count = (names: readonly string[]) => entries.filter(e => names.includes(e.event) && inRun(e)).length
    out.push({ run, from, to, ms, unobservedMs, merges: count(['merged']), holds: count(['blocked', 'held']), deferrals: count(['deferred']), open })
  }

  return out.filter(r => r.to >= now - days * 86_400_000).sort((a, b) => a.from - b.from)
}

function hm(ms: number): string {
  const min = Math.round(ms / 60_000)

  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`
}

// The share of observed time with no turn running and nothing awaited.
export function idleShare(r: RunStats): number {
  const total = STATES.reduce((a, s) => a + r.ms[s], 0)

  return total === 0 ? 0 : r.ms['idle-quiet'] / total
}

export function statsText(runs: readonly RunStats[], days: number): string {
  if (runs.length === 0) return `No auto-claude run with activity in the last ${days} day(s). Activity is logged from auto-claude 1.11.0 on.`
  const lines = [`auto-claude stats, last ${days} day(s): ${runs.length} run(s)`]
  for (const r of runs) {
    const when = `${new Date(r.from).toISOString().slice(0, 16).replace('T', ' ')} → ${r.open ? 'now' : new Date(r.to).toISOString().slice(11, 16)}`
    const parts = STATES.map(s => `${s} ${hm(r.ms[s])}`).join(', ')
    const unobserved = r.unobservedMs > 0 ? `, unobserved ${hm(r.unobservedMs)}` : ''
    lines.push(`- run ${when}: ${parts}${unobserved}; idle-quiet ${(idleShare(r) * 100).toFixed(1)}%; ${r.merges} merged, ${r.holds} held, ${r.deferrals} deferred`)
  }

  return lines.join('\n')
}

// `/auto-claude stats [days]`: the days argument, 7 when absent or not a positive number.
export function statsDays(args: readonly string[]): number {
  const n = Number(args[0])

  return Number.isFinite(n) && n > 0 ? n : 7
}
