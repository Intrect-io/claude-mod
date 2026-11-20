// stacked: built on the branch of a milestone still shipping; it waits for
// that one to land (or be held), is rebased onto the default branch, then pushed.
// awaiting-human (1.15.0): the PR touches protected files; the driver neither
// merges nor holds it, and polls it until a person lands or closes it.
export type ShipState = 'stacked' | 'push' | 'ci' | 'fixing' | 'merged' | 'held' | 'awaiting-human'

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
  // When the current note first came (repeats counted from then).
  noteSince?: number
  // Remedies already tried on this item (ship.ts remedy), by name.
  tried?: string[]
  // When a CI that would not finish was cancelled and run again.
  rerunAt?: number
  // A stacked milestone: the commit it was started from (its parent's tip
  // then), so `git rebase --onto <default> <onto>` drops the parent's commits.
  onto?: string
  // Rebased by the driver after it was built: pushed with --force-with-lease
  // (the session may have pushed the branch before the rebase).
  rebased?: boolean
  // When the session model was given this item's repeating error (shipRemedy).
  askedAt?: number
  // The repair of a broken deploy: it ships ahead of every stacked milestone.
  repair?: boolean
  // awaiting-human: the protected files its diff touches.
  protectedFiles?: string[]
}

// The run's Linear sync (hooks/linear.ts): the project, the change stamp each
// issue is covered up to, and follow-up lines queued per issue.
export type LinearSync = {
  project: string
  seen: Record<string, string>
  followUps?: Record<string, number>
  syncedAt?: number
  error?: string
}

// The Linear agent session bridge (hooks/bridge.ts): the Worker's event cursor, each delegated
// issue's session, the issues stopped in their session, and the last plan sent.
export type AgentBridge = {
  cursor: number
  sessions: Record<string, string>
  stopped?: string[]
  // The last plan sent to each session (its JSON), so a session gets the plan when it is new or the plan changed.
  planSigs?: Record<string, string>
  // Follow-up lines queued from each issue's replies (capped; past the cap a reply goes under ## Decisions).
  followUps?: Record<string, number>
  polledAt?: number
  // The Worker's last failure, told once when it starts failing; cleared by a poll with no failure.
  error?: string
  failedAt?: number
  // Issues the run created (sub-issues and Triage issues) in the last 24 h, for maxIssuesPerDay.
  issueTimes?: number[]
  // The accepted plan already decomposed and its spec-ambiguous deferrals sent (`<startedAt>:<round>`).
  decomposedFor?: string
  // Default-branch workflows red on consecutive standby polls, by workflow name.
  ciRed?: Record<string, { polls: number; sha: string; link?: string }>
  // When the Triage candidates were last looked at.
  triageAt?: number
  // Delegated issues split into sub-issues: their sessions keep getting the plan though no line names them.
  parents?: string[]
  // Each sub-issue's parent, so a stop on the parent stops its sub-issues too.
  subOf?: Record<string, string>
  // Set when a run's first plan is accepted: the open lines it held, and the delegated issue being
  // split once known; cleared when every line was split (a failure leaves it for the next poll).
  decomposePending?: { key: string; lines: string[]; parent?: string }
  // Spec-ambiguous deferrals already asked (sha of issue and text), so each is asked once.
  asked?: string[]
}

// standby: an always-on run between cycles; it is on, but owns nothing and runs no model turn.
export type AutoPhase = 'plan' | 'run' | 'final' | 'done' | 'stopped' | 'standby'

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
  // Milestones started ahead, on a branch still shipping: the commit each
  // branch started from, by branch name.
  onto?: Record<string, string>
  merges: number
  held: number
  queueEmpty: boolean
  // What the run deploys, fixed when it started (.claude/auto-deploy.json) or
  // when auto_plan_ready accepted the plan's Deploy line; unset: no deploys.
  deploy?: { command: string; scan?: string; timeoutMs: number; smoke?: string; source?: 'file' | 'plan' }
  // Why the plan deploys nothing (`Deploy: none (<reason>)`).
  deployNone?: string
  deploys?: number
  // Deploy failures in a row (reset by a deploy that passes its smoke check).
  deployFails?: number
  // A merge happened whose deploy has not passed yet: skipped (the command is
  // not in the default branch yet) or failed; the run is not done until it has.
  deployDue?: boolean
  // The queue condition of the deploy repair under way: until it lands (or is
  // blocked), stacked milestones are neither started nor shipped, so no merge
  // deploys on top of what is broken.
  repair?: string
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
  // Linear sync; unset when the repository maps to no project.
  linear?: LinearSync
  // The Linear agent session bridge; unset until ~/.claude/linear-agent.json exists and a poll ran.
  agent?: AgentBridge
  // Queue lines waiting on their `:: after:` command, by condition (register.ts pollWaits).
  waits?: Record<string, WaitState>
  // How many pending lines wait, as of the last tick: while only waits are left the run is not idle.
  waitCount?: number
  // The final check failed while CI still ran on the merged head: when that wait began, and when CI was last asked.
  finalCiSince?: number
  finalCiAt?: number
  // Time spent with nothing to do but wait, left out of the time cap; and the tick it was last counted at.
  waitedMs?: number
  waitTickAt?: number
  // A stacked milestone put back to wait keeps the commit it was stacked on,
  // by condition, so the branch it restarts on is rebased off its parent too.
  waitOnto?: Record<string, string>
  // Always-on (hooks/standby.ts): the run stands by after its final check
  // passes instead of ending, and wakes for a new cycle when a source queues work.
  alwaysOn?: boolean
  // When it last entered standby; the cycle now running or last run (0: the first, planned one).
  standbyAt?: number
  cycle?: number
  // The counts when the cycle woke, for its line under ## Cycles; what woke it.
  cycleBase?: { merges: number; held: number; deploys: number }
  wokeFor?: string[]
  // When each standby source is next polled.
  timers?: { health?: number; github?: number }
  // Smoke checks failing in a row, in standby.
  healthFails?: number
  // GitHub events covered, by id (ci:<run>, gh#<n>), with the stamp each is covered up to; follow-ups per id.
  seen?: Record<string, string>
  followUps?: Record<string, number>
  // The last GitHub poll's error, told once when it starts failing.
  githubError?: string
  // Merge times in the last 24 h, for the rolling cap, and whether its hold was told.
  mergeTimes?: number[]
  dayCapTold?: boolean
  // The standby whose entry already compacted the session (its standbyAt).
  compactedFor?: number
  // The default branch's commit when the run started: output a scan already
  // printed there does not block its deploys (deploy-run.ts scanGate).
  baseSha?: string
  // Normalized lines of the scan's output known to predate the run (deploy.ts findingsOf).
  scanKnown?: string[]
  // Once its final check passes, the run plans the next run toward the same aim
  // by itself (not with --once); the run's number in that chain, and when each
  // run of it started in the last 24 h, for the daily cap.
  continues?: boolean
  runNo?: number
  runTimes?: number[]
  // The first prompt of a run that went on by itself, held while a person used the session.
  kickoff?: string
}

// One waiting queue line, as the driver polls it.
export type WaitState = {
  since: number
  checkedAt?: number
  // `after` exited 0: the line may start.
  ok?: boolean
  // The last output of a failing `after` or `alive`, for the model and status.
  out?: string
  // `alive` failures in a row.
  aliveFails?: number
  // The model was asked to look (the job looks dead, or `within` passed), once each.
  askedDead?: boolean
  askedLate?: boolean
  // It reads a removed milestone worktree, so it can never pass; asked at once.
  askedBroken?: boolean
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
  // Its category (loop.ts DEFER_CATEGORIES), from 1.14.0.
  deferCategory?: 'credentials' | 'payment' | 'human-decision' | 'access' | 'spec-ambiguous'
  // wait_until: applied at the next Stop, like deferPending.
  waitPending?: { after: string; alive?: string; within?: string; reason: string }
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
