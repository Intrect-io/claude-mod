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
  // Goals the loop has started (its `start` events), and the gate last written.
  started: number
  // Goals the loop has finished (met, blocked or deferred): equal to started when it is idle.
  finished: number
  gate: number
  // The gate value `loop on` last ran for, and a loop command waiting for the next tick.
  kicked?: number
  want?: 'on' | 'off'
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
