// The status line's word on a run (1.19.0): is it working, waiting on
// something it watches, or stalled? A milestone can take hours (ArtifactNet's
// training waits ran 6 h), and "auto·R1·M6/14" alone did not say whether those
// hours were spent working or stuck. Pure: register.ts gathers the facts.
//
// The label leads the piece; a leading '!' asks the status line to draw it in
// red. The piece is written on every pulse (30 s), and segment() writes an
// unchanged one again each minute, so its file's mtime tells the status line
// the writer still runs (see ~/.claude/statusline-command.sh).

import type { Stall } from './ship'

// Past these, a turn whose session called no tool reads as quiet, then as stalled.
export const TOOL_QUIET_MS = 10 * 60_000
export const TOOL_STALL_MS = 30 * 60_000
// A wait not polled for this long means the driver stopped polling it.
export const WAIT_UNPOLLED_MS = 10 * 60_000

export type LiveFacts = {
  now: number
  phase: 'plan' | 'run' | 'standby'
  // The driver's tick has run this long without ending (set past its bound only).
  tickHungMs?: number
  stall?: Stall
  // PRs held for the person (protected files), and since when.
  awaiting: readonly { pr?: number; since: number }[]
  // The main turn running now, and the last tool call of the session (any loop).
  turnSince?: number
  lastToolAt?: number
  judging: boolean
  // Background work (workflow, subagent) or a background git commit the session waits on.
  backgroundSince?: number
  commitSince?: number
  // The in-flight PR while it waits on CI (push, ci, fixing).
  ci?: { since: number; pr?: number }
  finalCiSince?: number
  // Queue lines waiting on their `:: after:`, not yet passed.
  waits: readonly { since: number; checkedAt?: number; aliveFails?: number }[]
  // The session's last turn end (or the load, after a reload).
  quietSince: number
}

// 42m, 6h12m, 3d4h.
export function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

const STALL_WORD: Record<Stall['kind'], string> = {
  orphaned: 'orphaned',
  'tick-fails': 'ticks failing',
  'plan-overdue': 'plan overdue',
  'ship-stuck': 'ship stuck',
  'session-quiet': 'session idle',
  'ci-stuck': 'CI stuck',
  idle: 'no progress',
}

// Stalls a turn at work, or a PR waiting on the person, explains: a long
// planning turn is still planning (it goes red on its own once no tool is
// called), and a run with only an approval left has no progress to make.
const SOFT: ReadonlySet<Stall['kind']> = new Set(['plan-overdue', 'idle'])

// The label, most urgent first. '!' first: something needs the person's eye.
export function liveLabel(f: LiveFacts): string {
  const since = (at: number) => age(f.now - at)
  const stalled = (st: Stall) => `!stalled: ${STALL_WORD[st.kind]}${st.pr !== undefined ? ` #${st.pr}` : ''}${st.ms !== undefined ? ` ${age(st.ms)}` : ''}`
  if (f.tickHungMs !== undefined) return `!driver hung ${age(f.tickHungMs)}`
  if (f.stall !== undefined && !SOFT.has(f.stall.kind)) return stalled(f.stall)
  if (f.awaiting.length > 0) {
    const first = Math.min(...f.awaiting.map(a => a.since))
    return `!needs you: approve ${f.awaiting.map(a => `#${a.pr ?? '?'}`).join(' ')} ${since(first)}`
  }
  // A watched job that looks dead, or that the driver stopped polling.
  const dead = f.waits.find(w => (w.aliveFails ?? 0) > 0)
  if (dead !== undefined) return `!wait ${since(dead.since)}, alive check failing`
  const unpolled = f.waits.find(w => f.now - (w.checkedAt ?? w.since) >= WAIT_UNPOLLED_MS)
  if (unpolled !== undefined) return `!wait ${since(unpolled.since)}, unpolled ${since(unpolled.checkedAt ?? unpolled.since)}`
  if (f.turnSince !== undefined) {
    const tool = Math.max(f.lastToolAt ?? f.turnSince, f.turnSince)
    const quiet = f.now - tool
    if (quiet >= TOOL_STALL_MS) return `!working ${since(f.turnSince)}, no tool ${age(quiet)}`
    if (quiet >= TOOL_QUIET_MS) return `working ${since(f.turnSince)}, no tool ${age(quiet)}`
    return `${f.phase === 'plan' ? 'planning' : 'working'} ${since(f.turnSince)}`
  }
  if (f.stall !== undefined) return stalled(f.stall)
  if (f.judging) return 'judging'
  if (f.commitSince !== undefined) return `committing ${since(f.commitSince)}`
  if (f.backgroundSince !== undefined) return `background ${since(f.backgroundSince)}`
  if (f.ci !== undefined) return `CI ${since(f.ci.since)}`
  if (f.finalCiSince !== undefined) return `final CI ${since(f.finalCiSince)}`
  if (f.waits.length > 0) {
    const first = f.waits.reduce((a, b) => (b.since < a.since ? b : a))
    const polled = Math.max(...f.waits.map(w => w.checkedAt ?? w.since))
    return `wait ${since(first.since)}, polled ${since(polled)} ago`
  }
  if (f.phase === 'standby') return `standby ${since(f.quietSince)}`

  return `idle ${since(f.quietSince)}`
}
