export type GoalStatus = 'active' | 'paused'

export type Goal = {
  condition: string
  check?: string
  // 'model': set by the model with set_goal; 'queue': taken from the loop's
  // goals.md, whose check the loop runs itself.
  source: 'model' | 'queue'
  setAt: number
  checks: number
  unmetThisTurn: number
  parseFailures: number
  recentReasons: string[]
  lastReason?: string
  status: GoalStatus
  pausedBecause?: string
  deferPending?: string
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
