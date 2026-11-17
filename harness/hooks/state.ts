import type { Hook } from 'claude-code'

import type { HeartbeatState, LintState, ShipState, Toggles } from '../types'

// Initial values of the plugin's state. Each module declares the atoms it uses
// itself (the engine reads atom definitions only from the file that uses them);
// all of them name the same plugin, key and shape, so they share one value.
// Change a shape tag when that value's fields change: it declines what an
// earlier version stored, which outlives a reload.

export const DEFAULT_TOGGLES: Toggles = { guards: true, shipGate: true, reportLint: true, repoSize: true }

export const INITIAL_SHIP: ShipState = {
  mentioned: [],
  linearRequested: false,
  pending: [],
  stopBlocks: 0,
  prListed: false,
  codeqlRan: false,
  skipCodeql: false,
}

export const INITIAL_HEARTBEAT: HeartbeatState = {
  on: false,
  intervalMs: 5 * 60_000,
  lastUserAt: 0,
  lastFireAt: 0,
  busy: false,
  firing: false,
}

export const INITIAL_LINT: LintState = { codeEdited: false, askUsed: false, nudged: false }

export type ToolCallHook = Hook<'tool.call'>
export type PromptHook = Hook<'classic.UserPromptSubmit'>
export type StopHook = Hook<'classic.Stop'>
