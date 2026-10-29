import type { AutoRecord, ShipItem } from '../types'

// The loop's JSONL log as events, from the line after `offset` on.
export type LogEntry = { event: string; goal?: string; branch?: string; worktree?: string; reason?: string }

export function readLog(text: string, offset: number): { entries: LogEntry[]; offset: number } {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  // The loop caps its log; a shorter file than we read means it was trimmed.
  const from = offset > lines.length ? Math.max(lines.length - 50, 0) : offset
  const entries: LogEntry[] = []
  for (const line of lines.slice(from)) {
    try {
      const value = JSON.parse(line) as LogEntry
      if (typeof value.event === 'string') entries.push(value)
    } catch {
      // A torn line is skipped.
    }
  }

  return { entries, offset: lines.length }
}

// goal-loop.gate as goal-mode reads it: starts still allowed, undefined for none.
export function gateCredit(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const n = Number.parseInt(text.trim(), 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export type Checks = 'pending' | 'green' | 'red' | 'none'

// `gh pr checks <n> --json bucket`: an array of { bucket: pass|fail|pending|skipping|cancel }.
export function parseChecks(json: string): Checks {
  let rows: Array<{ bucket?: string }>
  try {
    rows = JSON.parse(json) as Array<{ bucket?: string }>
  } catch {
    return 'none'
  }
  if (!Array.isArray(rows) || rows.length === 0) return 'none'
  if (rows.some(r => r.bucket === 'fail' || r.bucket === 'cancel')) return 'red'
  if (rows.some(r => r.bucket === 'pending')) return 'pending'

  return 'green'
}

// `gh pr view <n> --json state,mergeable`: may it be merged now.
export function mergeable(json: string): { open: boolean; conflict: boolean; unknown: boolean } {
  try {
    const v = JSON.parse(json) as { state?: string; mergeable?: string }
    return { open: v.state === 'OPEN', conflict: v.mergeable === 'CONFLICTING', unknown: v.mergeable === 'UNKNOWN' }
  } catch {
    return { open: false, conflict: false, unknown: true }
  }
}

export function prNumber(output: string): number | undefined {
  const m = output.match(/\/pull\/(\d+)/)
  return m === null ? undefined : Number(m[1])
}

export const MAX_RED = 3

// The one item auto-claude works on now: the oldest not yet merged or held.
// Milestones ship one at a time, so each builds on the merged one before it.
export function inFlight(ships: readonly ShipItem[]): ShipItem | undefined {
  return ships.find(s => s.state === 'push' || s.state === 'ci' || s.state === 'fixing')
}

// What a stop of the run (a cap, the kill switch) or its end reports.
export function summary(merges: number, held: number, ships: readonly ShipItem[]): string {
  const prs = ships.filter(s => s.pr !== undefined).map(s => `#${s.pr}`)

  return `${merges} merged, ${held} held${prs.length > 0 ? ` (PRs ${prs.join(' ')})` : ''}`
}

export type Caps = { maxRounds: number; maxMerges: number; maxHours: number }

export function capReached(r: { merges: number; startedAt: number }, caps: Caps, now: number): string | undefined {
  if (r.merges >= caps.maxMerges) return `the merge cap (${caps.maxMerges}) was reached`
  if (now - r.startedAt >= caps.maxHours * 3600_000) return `the time cap (${caps.maxHours} h) was reached`
  return undefined
}

// Why a run that is on is not moving, with its evidence; undefined when it
// moves or nothing points to a stall. Worst first: an orphaned owner moves
// nothing at all.
export type StallFacts = {
  now: number
  // The session asking (/auto-claude status), and whether the record's owner may be stale.
  sessionId?: string
  staleMs: number
  // .claude/goal-loop.gate as goal-mode reads it.
  credit?: number
  // What the plan files lack, while planning.
  planErrors: readonly string[]
  maxNudges: number
  // Planning this long is no longer just planning (the first reminder's wait).
  planWaitMs: number
}

const ago = (now: number, at: number) => `${Math.max(0, Math.round((now - at) / 60_000))} min ago`

export function diagnose(r: AutoRecord, f: StallFacts): string | undefined {
  if (!r.on) return undefined
  const beat = r.beatAt ?? r.startedAt
  if (r.sessionId !== undefined && r.sessionId !== f.sessionId && f.now - beat >= f.staleMs) {
    return `orphaned: the session running it (${r.sessionId.slice(0, 8)}) last ticked ${ago(f.now, beat)}, so nothing moves; /auto-claude resume here to go on`
  }
  // phaseAt is when planning began or was last reminded: a reminder already
  // sent, or the first one's wait run out, means the plan is overdue.
  const since = r.phaseAt ?? r.startedAt
  if (r.phase === 'plan' && ((r.nudges ?? 0) >= 1 || f.now - since >= f.planWaitMs)) {
    const lack = f.planErrors.length > 0 ? `the plan files lack: ${f.planErrors.join('; ').slice(0, 300)}` : 'the plan files look ready: call auto_plan_ready'
    return `planning still waiting (reminder ${r.nudges ?? 0}/${f.maxNudges}, the last ${ago(f.now, since)}); ${lack}`
  }
  const item = inFlight(r.ships)
  if (item !== undefined && item.note !== undefined && (item.repeats ?? 0) >= 1) {
    return `shipping stuck at ${item.state}${item.pr !== undefined ? ` (PR #${item.pr})` : ''}: the same error ${(item.repeats ?? 0) + 1} checks in a row: ${item.note.slice(0, 200)}`
  }
  const idle = r.finished >= r.started && (item === undefined || item.state === 'fixing')
  // One loop on whose start the next tick has not read yet is no stall: it
  // takes a second ask (the watchdog's) to say the grant is not being taken.
  if (r.phase === 'run' && idle && (f.credit ?? 0) > 0 && (r.kicks ?? 0) >= 2) {
    const reply = (r.kickReply ?? 'no reply').replace(/\s+/g, ' ').slice(0, 200)
    return `a granted start is not taken: /goal-mode loop on ran ${r.kicks}× (last ${r.kickedAt !== undefined ? ago(f.now, r.kickedAt) : 'at an unknown time'}) and answered: ${reply}`
  }

  return undefined
}

