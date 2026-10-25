export type Toggles = {
  guards: boolean
  shipGate: boolean
  reportLint: boolean
}

export type GuardEnv = {
  home?: string
  tmpdir?: string
  // The platform venv's activate script, when it exists.
  venv?: string
  venvMissing?: string
}

export type PendingIssue = {
  id: string
  pr: string
  done: boolean
  commented: boolean
}

export type ShipState = {
  mentioned: string[]
  // The user asked for Linear work in this session (CLAUDE.md §1.5).
  linearRequested: boolean
  pending: PendingIssue[]
  stopBlocks: number
  prListed: boolean
  codeqlRan: boolean
  skipCodeql: boolean
}

export type LintState = {
  codeEdited: boolean
  askUsed: boolean
  nudged: boolean
  mode?: string
}

export type HeartbeatState = {
  on: boolean
  intervalMs: number
  // When the user last submitted a prompt, and when the heartbeat last fired.
  lastUserAt: number
  lastFireAt: number
  // A main-loop turn is running.
  busy: boolean
  // The next prompt is the heartbeat's own submit, not the user's.
  firing: boolean
  // The last fire's status tag ("[fire focus: …]").
  lastTag?: string
}

declare module 'claude-code' {
  interface PluginState {
    'harness': {
      toggles: Shaped<Toggles>
      env: Shaped<GuardEnv>
      ship: Shaped<ShipState>
      lint: Shaped<LintState>
      activity: Shaped<{ files: string[] }>
      heartbeat: Shaped<HeartbeatState>
    }
  }
}
