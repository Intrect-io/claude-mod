export type Link = {
  // The hub answered the last request.
  isOnline: boolean
  // No request before this time (ms), after a failure.
  retryAt: number
  failures: number
  // This session's id and name as the hub knows them.
  sessionId?: string
  name?: string
  // Channels this session reads besides its DMs.
  channels: string[]
  // Messages delivered as prompts, newest last, for /fleet status.
  delivered: number
}

export type FleetToggles = {
  enabled: boolean
  // Mirror the full text of SendMessage traffic into the hub, not just its first line.
  mirrorBodies: boolean
}

declare module 'claude-code' {
  interface PluginState {
    fleet: {
      link: Shaped<Link>
      toggles: Shaped<FleetToggles>
    }
  }
}
