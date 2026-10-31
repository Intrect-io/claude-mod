export type Goal = {
  condition: string
  check?: string
  // 'queue': taken from the loop's goals.md, whose check the loop runs itself.
  // 'model' and 'user' are goals earlier versions judged themselves; they move
  // to /goal at session start.
  source: 'model' | 'user' | 'queue'
  setAt: number
  checks: number
  unmetThisTurn: number
  parseFailures: number
  recentReasons: string[]
  lastReason?: string
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
