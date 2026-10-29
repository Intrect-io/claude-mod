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
  // Goals the loop has started (its `start` events).
  started: number
  // Goals the loop has finished (met, blocked or deferred): equal to started when it is idle.
  finished: number
  // goal-loop.gate is a credit (starts still allowed), which goal-mode spends.
  // Unset on a record from before that: its gate is rewritten once.
  credit?: true
  // A loop command waiting for the next tick.
  want?: 'on' | 'off'
  // `loop on` runs since the loop last started a goal, the last one's time and
  // its reply, and whether the person was told it is not taking the goal.
  kicks?: number
  kickedAt?: number
  kickReply?: string
  kickTold?: boolean
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
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'auto-claude': {
      piece: Shaped<string>
    }
  }
}
