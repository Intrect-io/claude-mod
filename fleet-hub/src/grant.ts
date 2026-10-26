import { chmod, rename, writeFile } from 'node:fs/promises'

import { ORCHESTRATOR_NAME } from './schema'

// CLAUDE.md §6.5 grant, issued by the hub. The file format is the one the
// harness grant check already reads; only `orchestrator` names the hub. A grant
// is written only from a person's action (a dashboard button behind the
// dashboard token, or an allowed Slack user's button): the orchestrator agent
// can only file a request, so it never widens its own authority.

export type GrantFile = {
  granted_by: string
  orchestrator: string
  issued_at: string
  expires_at: string
  goal: string
  allowed: string[]
  forbidden: string[]
  note: string
}

export type GrantRequest = {
  id: string
  requestedAt: number
  hours: number
  goal: string
  allowed: string[]
  reason: string
  status: 'pending' | 'approved' | 'denied'
}

export const DEFAULT_ALLOWED = [
  'local commits',
  'push your own feature branch',
  'create a PR',
  'merge a PR whose CI is green (re-check the PR state just before merging)',
  "deploy or release, when the session's own plan already prepared it",
]

export const DEFAULT_FORBIDDEN = [
  'force push',
  'direct push to main/master',
  'creating a new public repository or changing visibility',
  "answering a pending AskUserQuestion or permission prompt on the user's behalf",
  'deleting data (databases, docker volumes, caches holding data)',
  'the receiving session changing permission settings, CLAUDE.md or hooks',
]

export const MAX_HOURS = 24

const kst = (ms: number) => {
  // ISO with the +09:00 offset the existing grant uses.
  const d = new Date(ms + 9 * 3600_000)
  return `${d.toISOString().slice(0, 19)}+09:00`
}

export function buildGrant(input: { hours: number; goal: string; allowed?: string[]; grantedBy: string }, now: number): GrantFile {
  const hours = Math.min(Math.max(input.hours, 0.25), MAX_HOURS)
  return {
    granted_by: input.grantedBy,
    orchestrator: ORCHESTRATOR_NAME,
    issued_at: kst(now),
    expires_at: kst(now + hours * 3600_000),
    goal: input.goal,
    allowed: input.allowed && input.allowed.length > 0 ? input.allowed : DEFAULT_ALLOWED,
    forbidden: DEFAULT_FORBIDDEN,
    note: 'Written by fleet-hub on a person\'s action (dashboard or Slack button). The orchestrator agent can only request a grant.',
  }
}

export type GrantStatus = { state: 'none' } | { state: 'invalid'; reason: string } | { state: 'expired' | 'valid' | 'foreign'; grant: GrantFile }

export function grantStatus(text: string | undefined, now: number): GrantStatus {
  if (text === undefined) return { state: 'none' }
  let grant: GrantFile
  try {
    grant = JSON.parse(text) as GrantFile
  } catch {
    return { state: 'invalid', reason: 'does not parse' }
  }
  const expires = Date.parse(grant.expires_at)
  if (Number.isNaN(expires)) return { state: 'invalid', reason: 'no readable expires_at' }
  if (now >= expires) return { state: 'expired', grant }
  if (grant.orchestrator !== ORCHESTRATOR_NAME) return { state: 'foreign', grant }
  return { state: 'valid', grant }
}

export async function readGrantFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path)
  return (await file.exists()) ? file.text() : undefined
}

// Atomic replace, owner-only; the previous grant is kept beside it.
export async function writeGrantFile(path: string, grant: GrantFile): Promise<void> {
  const previous = await readGrantFile(path)
  if (previous !== undefined) await writeFile(`${path}.prev`, previous, { mode: 0o600 })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

// Revoking ends the grant now and keeps its record.
export function revoked(grant: GrantFile, now: number, by: string): GrantFile {
  return { ...grant, expires_at: kst(now), note: `${grant.note} Revoked ${kst(now)} by ${by}.` }
}

export class GrantRequests {
  private items: GrantRequest[] = []

  add(input: { hours: unknown; goal: unknown; allowed?: unknown; reason: unknown }, now: number): GrantRequest | undefined {
    const hours = typeof input.hours === 'number' && Number.isFinite(input.hours) ? input.hours : Number.NaN
    if (Number.isNaN(hours) || hours <= 0 || typeof input.goal !== 'string' || input.goal === '' || typeof input.reason !== 'string') return undefined
    const allowed = Array.isArray(input.allowed) ? input.allowed.filter((a): a is string => typeof a === 'string' && a !== '').slice(0, 20) : []
    const request: GrantRequest = {
      id: crypto.randomUUID().slice(0, 8),
      requestedAt: now,
      hours: Math.min(hours, MAX_HOURS),
      goal: input.goal.slice(0, 500),
      allowed,
      reason: input.reason.slice(0, 1000),
      status: 'pending',
    }
    this.items.push(request)
    return request
  }

  list(): GrantRequest[] {
    return [...this.items]
  }

  get(id: string): GrantRequest | undefined {
    return this.items.find(r => r.id === id)
  }

  settle(id: string, status: 'approved' | 'denied'): GrantRequest | undefined {
    const request = this.get(id)
    if (request === undefined || request.status !== 'pending') return undefined
    request.status = status
    return request
  }
}
