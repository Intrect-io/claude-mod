import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { Bus } from './bus'
import type { SessionInfo, SessionState } from './schema'
import { ORCHESTRATOR_NAME } from './schema'

// Every Claude Code session on this machine, fleet mod or not, from the
// engine's own registry (~/.claude/sessions/<pid>.json, read only): its name,
// cwd and status. A session without the mod is reached natively, by the
// orchestrator's SendMessage to that name; one with the mod reports itself
// over the socket and its own reports win.

export const REGISTRY_POLL_MS = 15_000

type Entry = {
  pid?: unknown
  sessionId?: unknown
  cwd?: unknown
  name?: unknown
  status?: unknown
  waitingFor?: unknown
  kind?: unknown
  entrypoint?: unknown
  procStart?: unknown
}

export type NativeSession = Pick<SessionInfo, 'id' | 'name' | 'cwd' | 'repo' | 'state' | 'summary'> & { pid: number; procStart?: string }

export function nativeState(status: unknown): SessionState {
  if (status === 'busy') return 'busy'
  if (status === 'waiting') return 'waiting_on_user'
  return 'idle'
}

// One registry file's entry as a session, or undefined for what is not one
// to orchestrate: a malformed file, the orchestrator itself, an SDK child.
export function parseEntry(text: string): NativeSession | undefined {
  let e: Entry
  try {
    e = JSON.parse(text) as Entry
  } catch {
    return undefined
  }
  if (typeof e.pid !== 'number' || typeof e.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(e.sessionId) || typeof e.cwd !== 'string') return undefined
  if (e.name === ORCHESTRATOR_NAME || e.entrypoint === 'sdk-cli' || e.entrypoint === 'sdk-ts') return undefined
  const name = typeof e.name === 'string' && e.name !== '' ? e.name : e.sessionId.slice(0, 8)
  return {
    pid: e.pid,
    procStart: typeof e.procStart === 'string' ? e.procStart : undefined,
    id: e.sessionId,
    name,
    cwd: e.cwd,
    repo: basename(e.cwd),
    state: nativeState(e.status),
    summary: typeof e.waitingFor === 'string' && e.status === 'waiting' ? e.waitingFor : undefined,
  }
}

// `ps -o lstart=` of a pid in the registry's own spelling (C locale, UTC), or
// undefined when no such process runs.
export function processStart(pid: number): string | undefined {
  const ran = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/bin:/usr/bin' } })
  const text = ran.stdout.toString().trim().replace(/\s+/g, ' ')
  return ran.exitCode === 0 && text !== '' ? text : undefined
}

// Alive means this very process: a pid the OS handed to another program since
// (measured: a dead session's 481 became distnoted) does not count.
export function isAlive(pid: number, procStart?: string, start: (pid: number) => string | undefined = processStart): boolean {
  const now = start(pid)
  if (now === undefined) return false
  return procStart === undefined || now === procStart.trim().replace(/\s+/g, ' ')
}

export async function readRegistry(dir = join(homedir(), '.claude', 'sessions'), alive: (pid: number, procStart?: string) => boolean = isAlive): Promise<NativeSession[]> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: NativeSession[] = []
  for (const file of files.slice(0, 256)) {
    const entry = parseEntry(await Bun.file(join(dir, file)).text().catch(() => ''))
    if (entry !== undefined && alive(entry.pid, entry.procStart)) out.push(entry)
  }
  return out
}

// Fold the registry into the bus: new or changed native sessions are said
// hello (an event the dashboard and the digest see); unchanged ones are only
// touched, so a waiting session is reported once, not every poll. A session
// whose fleet mod reports for it is left to the mod.
export function syncRegistry(bus: Bus, natives: readonly NativeSession[]) {
  for (const n of natives) {
    const known = bus.session(n.id)
    if (known?.via === 'fleet' && known.state !== 'offline') continue
    if (known !== undefined && known.state === n.state && known.name === n.name && known.summary === (n.summary ?? known.summary)) {
      bus.touch(n.id)
      continue
    }
    bus.hello({ id: n.id, name: n.name, cwd: n.cwd, repo: n.repo, state: n.state, summary: n.summary, via: 'native' })
  }
}
