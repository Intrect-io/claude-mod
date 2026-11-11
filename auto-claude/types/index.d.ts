export type ShipState = 'push' | 'ci' | 'fixing' | 'merged' | 'held'

export type ShipItem = {
  // The goal-mode queue line this milestone came from.
  goal: string
  // The branch the PR is opened from (the milestone's own goal/NN branch).
  headRef: string
  // The branch holding its latest commits: headRef, or a fix goal's branch built on it.
  branch: string
  worktree?: string
  check?: string
  state: ShipState
  pr?: number
  // Red CI runs (or merge conflicts) so far.
  red: number
  since: number
  note?: string
  // Ticks the same note came back in a row (an error that does not clear).
  repeats?: number
  // Remedies already tried on this item (ship.ts remedy), by name.
  tried?: string[]
  // When a CI that would not finish was cancelled and run again.
  rerunAt?: number
}

export type AutoPhase = 'plan' | 'run' | 'final' | 'done' | 'stopped'

export type AutoRecord = {
  on: boolean
  phase: AutoPhase
  root: string
  sessionId?: string
  hint: string
  round: number
  startedAt: number
  remote: string
  defaultBranch: string
  ciMode: 'github' | 'local'
  // Lines of .claude/goal-loop.log already read.
  logOffset: number
  // The last line of it read: the cursor once the log's 2000-line cap stops the count growing.
  logLast?: string
  // Ticks in a row the log read shorter than logOffset without logLast in it (a write in progress, or a cleared log).
  logHeld?: number
  // Goals the loop has started (its `start` events).
  started: number
  // Goals the loop has finished (met, blocked or deferred): equal to started when it is idle.
  finished: number
  // /auto-claude start --queue: build the queue's lines into branches; nothing is pushed, merged or deployed.
  buildOnly?: boolean
  // Last tick of the owning session: a run whose owner went quiet is shown as
  // orphaned in other sessions.
  beatAt?: number
  // When the run last entered planning or was last reminded, and the reminders so far.
  phaseAt?: number
  nudges?: number
  worktrees: Record<string, string>
  ships: ShipItem[]
  // Fix goals by their queue condition, each naming the headRef it repairs.
  fixes: Record<string, string>
  merges: number
  held: number
  queueEmpty: boolean
  // What the run deploys, fixed when it started (.claude/auto-deploy.json) or
  // when auto_plan_ready accepted the plan's Deploy line; unset: no deploys.
  deploy?: { command: string; codeql: string[]; timeoutMs: number; smoke?: string; source?: 'file' | 'plan' }
  // Why the plan deploys nothing (`Deploy: none (<reason>)`).
  deployNone?: string
  deploys?: number
  // Deploy failures in a row (reset by a deploy that passes its smoke check).
  deployFails?: number
  // A merge happened whose deploy has not passed yet: skipped (the command is
  // not in the default branch yet) or failed; the run is not done until it has.
  deployDue?: boolean
  // Why milestones were last held, as a cause class (ship.ts causeOf), and how
  // many in a row share it: two in a row stop the run (a cause the whole run shares).
  holdCause?: string
  holdStreak?: number
  note?: string
  // The phase a stopped run was in, so resume goes back to it (planning stays planning).
  pausedPhase?: AutoPhase
  // Idle detection: what the run last did (ship.ts progressSig), when that last changed,
  // and the idle nudges sent since (at most MAX_IDLE_NUDGES, reset by any progress).
  sig?: string
  movedAt?: number
  idleNudges?: number
  idleNudgedAt?: number
}

// A goal of the loop: one queue line being built in its own worktree.
export type Goal = {
  condition: string
  check?: string
  setAt: number
  checks: number
  unmetThisTurn: number
  parseFailures: number
  recentReasons: string[]
  lastReason?: string
  deferPending?: string
}

// What the guards need while a goal runs in this session.
export type LoopView = {
  repoRoot: string
  worktree: string
  branch: string
  extraDeny: string[]
}

export type LoopCurrent = {
  condition: string
  check?: string
  worktree: string
  branch: string
  startedAt: number
}

// The loop's own state, under `loop:<root>` in this plugin's store.
export type LoopRecord = {
  repoRoot: string
  seq: number
  retries: number
  current?: LoopCurrent
  // Continue prompts the watchdog sent for the current goal while the session sat idle.
  wakes?: number
}

declare module 'claude-code' {
  interface PluginState {
    'auto-claude': {
      piece: Shaped<string>
      goal: Shaped<Goal | null>
      view: Shaped<LoopView | null>
    }
  }
}
