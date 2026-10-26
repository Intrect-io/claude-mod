export type GoalStatus = 'active' | 'paused'

export type Goal = {
  condition: string
  check?: string
  // 'model': set by the model with set_goal; 'user': set by the person with
  // /goal-mode set; 'queue': taken from the loop's goals.md, whose check the
  // loop runs itself.
  source: 'model' | 'user' | 'queue'
  setAt: number
  checks: number
  unmetThisTurn: number
  parseFailures: number
  recentReasons: string[]
  lastReason?: string
  status: GoalStatus
  pausedBecause?: string
  deferPending?: string
  // A goal the person set with /goal-mode set that Claude then turned into a
  // measurable end state (once): the person's own words, kept beside it.
  intent?: string
}

export type LoopView = {
  repoRoot: string
  worktree: string
  branch: string
  extraDeny: string[]
}

export type GoalMeta = {
  nativeSeen: boolean
  lastMode?: string
  sessionId?: string
  cwd?: string
  // Set while this session owns a running loop goal; the guards read it.
  loop?: LoopView
}

declare module 'claude-code' {
  interface PluginState {
    'goal-mode': {
      goal: Shaped<Goal | null>
      meta: Shaped<GoalMeta>
    }
  }
}
