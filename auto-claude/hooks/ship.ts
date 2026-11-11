import type { AutoRecord, ShipItem } from '../types'

// The loop's JSONL log as events, from after the last line already read.
// The loop keeps only its last 2000 lines (loop.ts LOG_MAX_LINES), so once the
// log is full its line count stops growing: a line offset alone then reads
// nothing new, ever. The cursor is the last line read (each carries a ts),
// looked for backwards from where it was; `offset` alone is the fallback for
// a record from before `last`.
export type LogEntry = { event: string; goal?: string; branch?: string; worktree?: string; reason?: string }

export function readLog(text: string, offset: number, last?: string): { entries: LogEntry[]; offset: number; last?: string; held?: true } {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  let from: number
  if (last !== undefined) {
    // The line moves only towards the start when the log is trimmed.
    const at = lines.lastIndexOf(last, Math.min(offset, lines.length) - 1)
    // Not found in a log shorter than what was read: the loop rewrites the
    // whole file on each append, so this is a read in the middle of that
    // write. Nothing is read and the cursor stays; the next tick sees it whole.
    // (A log cleared by hand reads the same way, until the caller decides it
    // was replaced: see `held`.)
    if (at < 0 && lines.length < offset) return { entries: [], offset, last, held: true }
    // Not found otherwise: trimmed past it, so every line in the window is new.
    from = at >= 0 ? at + 1 : 0
  } else {
    // A shorter file than we read means it was trimmed.
    from = offset > lines.length ? Math.max(lines.length - 50, 0) : offset
  }
  const entries: LogEntry[] = []
  // The cursor only ever rests on a line that parsed: a torn last line is read
  // again, whole, next time.
  let cursor = from
  let cursorLine = from > 0 ? lines[from - 1] : last
  for (let i = from; i < lines.length; i++) {
    try {
      const value = JSON.parse(lines[i]!) as LogEntry
      if (typeof value.event === 'string') entries.push(value)
      cursor = i + 1
      cursorLine = lines[i]
    } catch {
      // A torn last line waits for the next read; one in the middle is skipped.
      if (i < lines.length - 1) {
        cursor = i + 1
        cursorLine = lines[i]
      }
    }
  }

  return { entries, offset: cursor, last: cursorLine }
}

export type Checks = 'pending' | 'green' | 'red' | 'none'

// `gh pr checks <n> --required --json bucket`: an array of { bucket: pass|fail|pending|skipping|cancel }.
// Only required checks decide (measured in vega-agent: a failing check that was
// not required read as a red CI 6679 ticks in a row, for 16 h); a repository
// with no required checks makes gh fail, and every check counts then.
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
export function mergeable(json: string): { open: boolean; merged: boolean; conflict: boolean; unknown: boolean } {
  try {
    const v = JSON.parse(json) as { state?: string; mergeable?: string }
    // GitHub reports mergeable UNKNOWN for a merged PR, so merged is read first.
    const merged = v.state === 'MERGED'
    return { open: v.state === 'OPEN', merged, conflict: v.mergeable === 'CONFLICTING', unknown: !merged && v.mergeable === 'UNKNOWN' }
  } catch {
    return { open: false, merged: false, conflict: false, unknown: true }
  }
}

// gh's answer to --required on a repository without required checks.
export function noRequired(r: { exitCode: number; stdout: string; stderr: string }): boolean {
  return r.exitCode !== 0 && /no required checks/i.test(`${r.stdout}\n${r.stderr}`)
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
  // How long the session has had no turn while a milestone is being built (undefined: a turn runs, or none is open).
  quietMs?: number
  // What the plan files lack, while planning.
  planErrors: readonly string[]
  maxNudges: number
  // Planning this long is no longer just planning (the first reminder's wait).
  planWaitMs: number
  // How long nothing has moved (now - movedAt), when known.
  idleMs?: number
  // Ticks of the owner failed in a row, and the last error, once that is a streak.
  tickFails?: number
  tickError?: string
}

const ago = (now: number, at: number) => `${Math.max(0, Math.round((now - at) / 60_000))} min ago`

export function diagnose(r: AutoRecord, f: StallFacts): string | undefined {
  if (!r.on) return undefined
  const beat = r.beatAt ?? r.startedAt
  if (r.sessionId !== undefined && r.sessionId !== f.sessionId && f.now - beat >= f.staleMs) {
    return `orphaned: the session running it (${r.sessionId.slice(0, 8)}) last ticked ${ago(f.now, beat)}, so nothing moves; /auto-claude resume here to go on`
  }
  if (f.tickFails !== undefined) return `every tick fails (${f.tickFails} in a row), so nothing moves: ${(f.tickError ?? '').slice(0, 200)}`
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
  if (r.phase === 'run' && r.started > r.finished && f.quietMs !== undefined && f.quietMs >= LOOP_QUIET_MS) {
    return `the session has done nothing for ${Math.round(f.quietMs / 60_000)} min while a milestone is open; the watchdog prompts it again`
  }
  const stuck = r.phase === 'run' ? ciStuck(r, f.now) : undefined
  if (stuck !== undefined) {
    return `PR #${stuck.pr ?? '?'} has waited ${stuck.minutes} min for CI to finish or GitHub to decide it can merge (a queued check with no runner?)`
  }
  if (r.phase === 'run' && f.idleMs !== undefined && f.idleMs >= IDLE_NUDGE_MS && !isWaiting(r, f.now)) {
    return `idle ${Math.round(f.idleMs / 60_000)} min: nothing was started, shipped or merged`
  }

  return undefined
}


// "owner/name" of a GitHub remote URL (https or ssh form), else undefined.
// gh picks its target repository itself: in a fork that also has an `upstream`
// remote it can choose the parent, where the run's branch does not exist
// ("Head sha can't be blank ... Head ref must be a branch"; measured on a fork
// with no `gh repo set-default`). Every gh call names the pushed remote's repo.
export function repoSlug(url: string): string | undefined {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return m === null ? undefined : `${m[1]}/${m[2]}`
}

// Idle: the run is on and nothing has been started, shipped or merged for this
// long. The first nudge comes after IDLE_NUDGE_MS, the next ones IDLE_REPEAT_MS
// apart, MAX_IDLE_NUDGES in all; any progress starts the count again.
export const IDLE_NUDGE_MS = 15 * 60_000
export const IDLE_REPEAT_MS = 30 * 60_000
export const MAX_IDLE_NUDGES = 3

// What the run has done, so far: it changes when a goal starts or ends, a PR
// moves on or a milestone is merged or held. A repeating error note is not progress.
export function progressSig(r: Pick<AutoRecord, 'started' | 'finished' | 'merges' | 'held' | 'ships'>): string {
  return [r.started, r.finished, r.merges, r.held, ...r.ships.map(s => `${s.headRef}:${s.state}:${s.pr ?? ''}`)].join('|')
}

// A PR waits this long for its CI to finish (or for GitHub to decide whether it
// can be merged) before the wait itself counts as a stall: a check queued for
// a self-hosted runner that is offline stays pending for good.
export const CI_STUCK_MS = 90 * 60_000

// Every run of the PR still queued (none started) this long means no runner
// will take it: no need to wait the whole CI_STUCK_MS.
export const CI_QUEUED_MS = 30 * 60_000

// The in-flight PR waiting past CI_STUCK_MS (since it was opened or its CI
// last re-run), with how long, else undefined.
export function ciStuck(r: Pick<AutoRecord, 'ships'>, now: number): { pr?: number; minutes: number } | undefined {
  const item = inFlight(r.ships)
  if (item?.state !== 'ci' || item.note !== undefined) return undefined
  const from = item.rerunAt ?? item.since
  if (now - from < CI_STUCK_MS) return undefined
  return { pr: item.pr, minutes: Math.round((now - item.since) / 60_000) }
}

// What to do about a PR whose CI does not finish: re-run it once (cancelling
// what is queued), then hold it. `allQueued`: gh run list shows every run still queued.
export function ciAction(item: Pick<ShipItem, 'state' | 'since' | 'rerunAt' | 'note'>, now: number, allQueued: boolean): 'rerun' | 'hold' | undefined {
  if (item.state !== 'ci' || item.note !== undefined) return undefined
  const from = item.rerunAt ?? item.since
  const waited = now - from
  if (waited < CI_STUCK_MS && !(allQueued && waited >= CI_QUEUED_MS)) return undefined
  return item.rerunAt === undefined ? 'rerun' : 'hold'
}

// A shipping error that keeps coming back: what is tried, in order.
// https-push: an SSH remote refused (a key not loaded in an unattended shell);
// the push goes to the https URL of the same repository once.
// diagnose: the session model gets the error and what was tried, to fix what
// it can (gh auth, a remote, a branch).
// hold: give up on the milestone and go on.
export const DIAGNOSE_AT = 5
export const HOLD_AT = 10

export function shipRemedy(item: Pick<ShipItem, 'note' | 'repeats' | 'tried'>): 'https-push' | 'diagnose' | 'hold' | undefined {
  if (item.note === undefined) return undefined
  const tried = item.tried ?? []
  const repeats = item.repeats ?? 0
  if (/Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository/i.test(item.note) && !tried.includes('https-push')) return 'https-push'
  if (repeats >= HOLD_AT) return 'hold'
  if (repeats >= DIAGNOSE_AT && !tried.includes('diagnose')) return 'diagnose'
  return undefined
}

// The class of a hold's cause: two milestones in a row held for the same class
// is a problem of the whole run (no CI runner, gh not logged in), and the run
// stops instead of holding every milestone after them.
export function causeOf(note: string): string {
  if (/waited \d+ min for CI|CI did not finish/i.test(note)) return 'ci-stuck'
  if (/publickey|authenticat|auth login|HTTP 40[13]|credential/i.test(note)) return 'auth'
  if (/Head sha can't be blank|Head ref must be a branch|could not resolve to a Repository/i.test(note)) return 'gh-repo'
  if (/CI failed/i.test(note)) return 'ci-red'
  if (/conflict/i.test(note)) return 'conflict'
  if (/deploy/i.test(note)) return 'deploy'
  if (/worktree|branch .* gone/i.test(note)) return 'worktree'
  if (/push/i.test(note)) return 'push'
  return 'other'
}

// The https URL of a GitHub repository, for a push an SSH remote refused.
export function httpsOf(slug: string): string {
  return `https://github.com/${slug}.git`
}

// A session with a milestone open and no turn for this long is not building it
// (a dropped prompt, an interrupt, a turn that ended to "wait"): the watchdog
// prompts it again, backing off, LOOP_WAKES times, then blocks the milestone.
export const LOOP_QUIET_MS = 3 * 60_000
export const LOOP_WAKES = 3

// The wait before wake number `wakes + 1`: 3, 6, then 12 min of quiet.
export function wakeDue(quietMs: number, wakes: number): boolean {
  return quietMs >= LOOP_QUIET_MS * 2 ** Math.min(wakes, 4)
}

// Waiting on something that has its own clock is not idle: the loop building a
// goal (while the session works on it), or a PR's CI pending with nothing
// wrong, for up to CI_STUCK_MS.
export function isWaiting(r: Pick<AutoRecord, 'started' | 'finished' | 'ships'>, now: number, quietMs?: number): boolean {
  if (r.started > r.finished) return quietMs === undefined || quietMs < LOOP_QUIET_MS
  const item = inFlight(r.ships)
  return item?.state === 'ci' && item.note === undefined && ciStuck(r, now) === undefined
}

// The number of the nudge due now (1..MAX_IDLE_NUDGES), or undefined.
export function idleDue(r: Pick<AutoRecord, 'on' | 'phase' | 'movedAt' | 'idleNudges' | 'idleNudgedAt'>, now: number): number | undefined {
  if (!r.on || r.phase !== 'run' || r.movedAt === undefined) return undefined
  const sent = r.idleNudges ?? 0
  if (sent >= MAX_IDLE_NUDGES) return undefined
  if (sent === 0) return now - r.movedAt >= IDLE_NUDGE_MS ? 1 : undefined
  return now - (r.idleNudgedAt ?? r.movedAt) >= IDLE_REPEAT_MS ? sent + 1 : undefined
}
