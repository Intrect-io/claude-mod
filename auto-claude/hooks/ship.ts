import type { ShipItem } from '../types'

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
