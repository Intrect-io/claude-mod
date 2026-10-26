// Message and session shapes shared by the hub, the dashboard and the fleet mod.
// The fleet mod keeps its own copy of the wire shapes (a mod imports nothing
// outside its folder); keep the two in step.

export type FromKind = 'session' | 'orchestrator' | 'human' | 'slack'

export type From = { kind: FromKind; id: string; name: string }

export type Msg = {
  id: string
  ts: number
  // "#all", "#<repo>", "#slack", "#orchestrator", or "@<sessionId>" for a DM.
  channel: string
  from: From
  text: string
  replyTo?: string
}

export type SessionState = 'idle' | 'busy' | 'waiting_on_user' | 'offline'

export type SessionInfo = {
  id: string
  name: string
  cwd: string
  repo?: string
  branch?: string
  state: SessionState
  lastSeen: number
  summary?: string
  // How the hub reaches it: the fleet mod's inbox, or native SendMessage to its name.
  via?: 'fleet' | 'native'
}

export const ORCHESTRATOR_NAME = 'fleet-hub'

const CHANNEL = /^(#[a-z0-9][a-z0-9._-]{0,63}|@[A-Za-z0-9_-]{1,128})$/
const STATES: readonly SessionState[] = ['idle', 'busy', 'waiting_on_user', 'offline']
export const MAX_TEXT = 16_000

export function isChannel(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL.test(value)
}

export function isDm(channel: string): boolean {
  return channel.startsWith('@')
}

// A repo channel name from a repository name: lowercased, unsafe characters dashed.
export function repoChannel(repo: string | undefined | null): string | undefined {
  if (repo === undefined || repo === null || repo === '') return undefined
  const slug = repo
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)

  return slug === '' ? undefined : `#${slug}`
}

const str = (value: unknown, max = 512): string | undefined => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined)

// The body of POST /api/sessions/hello, or undefined when it does not hold one.
export function parseHello(body: unknown): Omit<SessionInfo, 'state' | 'lastSeen'> | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as Record<string, unknown>
  const id = str(b.id, 128)
  const cwd = str(b.cwd, 4096)
  if (id === undefined || !/^[A-Za-z0-9_-]+$/.test(id) || cwd === undefined) return undefined

  return { id, cwd, name: str(b.name, 128) ?? id.slice(0, 8), repo: str(b.repo, 256), branch: str(b.branch, 256), summary: str(b.summary, 400), via: 'fleet' }
}

export function parseState(body: unknown): { state: SessionState; summary?: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as Record<string, unknown>
  if (!STATES.includes(b.state as SessionState)) return undefined

  return { state: b.state as SessionState, summary: str(b.summary, 400) }
}

export function parsePost(body: unknown): { channel: string; text: string; replyTo?: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as Record<string, unknown>
  if (!isChannel(b.channel)) return undefined
  const text = str(b.text, MAX_TEXT)
  if (text === undefined) return undefined

  return { channel: b.channel, text, replyTo: str(b.replyTo, 64) }
}
