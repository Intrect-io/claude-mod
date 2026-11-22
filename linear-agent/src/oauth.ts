// The app's OAuth install (actor=app) and its token: one record holds the access
// token, the refresh token, the expiry and the app user together. It is written to
// both D1 (oauth_token) and KV, and the copy saved last wins on read, so a refreshed
// pair survives one failed write. Only the scheduled handler refreshes it: Linear
// rotates the refresh token on every refresh, so two refreshers could lose the pair.
// Install links are minted only by the session API (POST /v1/install), so nobody
// without SESSION_TOKEN can start an install that would bind or replace the token.

import { type Env, errorText, json } from './env'
import { viewer } from './linear'

export const AUTHORIZE_URL = 'https://linear.app/oauth/authorize'
export const TOKEN_URL = 'https://api.linear.app/oauth/token'
export const SCOPES = 'read,write,app:assignable,app:mentionable'
export const TOKEN_KEY = 'oauth:token'
export const STATE_PREFIX = 'oauth-state:'
export const STATE_TTL_SECONDS = 600
export const REFRESH_WITHIN_MS = 12 * 3_600_000
// Linear accepts the same refresh token again for 30 minutes after a rotation, so a lost reply is
// recovered by retrying inside that window, within one scheduled run (wall limit 15 minutes).
export const REFRESH_BACKOFF_MS = [0, 30_000, 120_000, 300_000]
// Refresh (7.5 min) plus write (2.6 min) backoff stays inside the 15-minute cron wall limit.
export const WRITE_BACKOFF_MS = [0, 5_000, 30_000, 120_000]
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export type StoredToken = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  appUserId: string
  organizationId: string
  scope?: string
  savedAt: number
}

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string | string[] }

type Stores = Pick<Env, 'DB' | 'TOKENS'>

// A dropped token is a tombstone, not a deleted row: it carries a later savedAt than any copy a
// one-sided delete could leave behind, so the newest-wins read cannot bring a revoked grant back.
type Tombstone = { dropped: true; savedAt: number }
type TokenRecord = StoredToken | Tombstone

function parseRecord(raw: string | null | undefined): TokenRecord | undefined {
  if (raw === null || raw === undefined) return undefined
  try {
    return JSON.parse(raw) as TokenRecord
  } catch {
    return undefined
  }
}

// Each store's record, or 'unreadable' when the read itself failed (not the same as no record).
type Copy = TokenRecord | undefined | 'unreadable'

function unreadable(where: string) {
  return (error: unknown): 'unreadable' => {
    console.warn(`reading the token from ${where} failed: ${errorText(error)}`)
    return 'unreadable'
  }
}

async function readCopies(env: Stores): Promise<[Copy, Copy]> {
  return Promise.all([
    env.TOKENS.get(TOKEN_KEY).then(parseRecord, unreadable('KV')),
    env.DB.prepare('SELECT value FROM oauth_token WHERE id = 1')
      .first<{ value: string }>()
      .then(row => parseRecord(row?.value), unreadable('D1')),
  ])
}

// Copies come as [KV, D1]; on a tie D1 (strongly consistent) wins.
function newest(copies: Copy[]): StoredToken | undefined {
  const records = copies.filter((c): c is TokenRecord => c !== undefined && c !== 'unreadable')
  const latest = records.reduce<TokenRecord | undefined>((best, r) => (best === undefined || r.savedAt >= best.savedAt ? r : best), undefined)
  return latest === undefined || 'dropped' in latest ? undefined : latest
}

// The later of the two copies; for serving requests either store alone is enough.
export async function readToken(env: Stores): Promise<StoredToken | undefined> {
  return newest(await readCopies(env))
}

// The token only when both stores answered, for decisions that must not rest on a stale copy
// (refreshing with a rotated-away refresh token, or dropping a grant as dead).
export async function readTokenStrict(env: Stores): Promise<{ token: StoredToken | undefined } | 'unreadable'> {
  const copies = await readCopies(env)
  return copies.includes('unreadable') ? 'unreadable' : { token: newest(copies) }
}

async function both(what: string, kv: () => Promise<unknown>, db: () => Promise<unknown>): Promise<void> {
  const [k, d] = await Promise.allSettled([kv(), db()])
  for (const [where, r] of [['KV', k], ['D1', d]] as const) if (r.status === 'rejected') console.warn(`${what} in ${where} failed: ${errorText(r.reason)}`)
  if (k.status === 'rejected' && d.status === 'rejected') throw new Error(`${what} failed in both KV and D1`)
}

async function writeRecord(env: Stores, record: TokenRecord, what: string): Promise<void> {
  const value = JSON.stringify(record)
  await both(
    what,
    () => env.TOKENS.put(TOKEN_KEY, value),
    () => env.DB.prepare('INSERT INTO oauth_token (id, value, saved_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value, saved_at = excluded.saved_at').bind(value, record.savedAt).run(),
  )
}

// The whole pair in one record, so a reader never sees a new access token with an old refresh
// token. It counts as saved when either store took it: the later savedAt wins on read.
export async function writeToken(env: Stores, token: StoredToken): Promise<void> {
  await writeRecord(env, token, 'writing the token')
}

export async function deleteToken(env: Stores, now: number): Promise<void> {
  await writeRecord(env, { dropped: true, savedAt: now }, 'dropping the token')
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function callbackUrl(requestUrl: URL): string {
  return `${requestUrl.origin}/oauth/callback`
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES, actor: 'app', state })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

// Linear said the grant is gone for good (invalid_grant): retrying cannot help.
export class DeadGrant extends Error {}

async function tokenRequest(form: Record<string, string>): Promise<TokenReply> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  if (!res.ok) {
    const error = await res.json().then((b: unknown) => (typeof b === 'object' && b !== null ? (b as { error?: unknown }).error : undefined), () => undefined)
    if (error === 'invalid_grant') throw new DeadGrant(`token endpoint answered ${res.status} invalid_grant`)
    throw new Error(`token endpoint answered ${res.status}`)
  }
  const reply = (await res.json()) as TokenReply
  if (typeof reply.access_token !== 'string' || typeof reply.refresh_token !== 'string' || typeof reply.expires_in !== 'number') {
    throw new Error('token endpoint reply lacks access_token, refresh_token or expires_in')
  }
  return reply
}

const scopeText = (scope: TokenReply['scope']) => (Array.isArray(scope) ? scope.join(' ') : scope)

// A Linear authorize link with a fresh single-use state. Called only behind the session token.
export async function mintInstallUrl(env: Env, url: URL): Promise<string> {
  const state = randomHex(16)
  await env.TOKENS.put(`${STATE_PREFIX}${state}`, '1', { expirationTtl: STATE_TTL_SECONDS })
  return authorizeUrl(env.LINEAR_CLIENT_ID, callbackUrl(url), state)
}

const page = (status: number, text: string) => new Response(`<!doctype html><title>linear-agent</title><p>${text}</p>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

export async function finishInstall(env: Env, url: URL, now: number): Promise<Response> {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (code === null || state === null) return page(400, 'Missing code or state.')
  const stateKey = `${STATE_PREFIX}${state}`
  if ((await env.TOKENS.get(stateKey)) === null) return page(400, 'Unknown or expired state. Mint a new install link with POST /v1/install.')
  // Single use: a replayed callback finds no state.
  await env.TOKENS.delete(stateKey)

  let reply: TokenReply
  try {
    reply = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(url),
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
    })
  } catch (error) {
    console.warn(`oauth code exchange failed: ${errorText(error)}`)
    return page(502, 'Linear did not issue a token.')
  }
  const accessToken = reply.access_token as string
  let who: { id: string; organizationId: string }
  try {
    who = await viewer(accessToken)
  } catch (error) {
    console.warn(`oauth viewer lookup failed: ${errorText(error)}`)
    return page(502, 'Linear issued a token but did not say which app user it belongs to.')
  }
  const existing = await readToken(env)
  if (existing !== undefined && existing.organizationId !== who.organizationId) {
    return page(409, 'This Worker is already installed in another Linear workspace.')
  }
  if (existing !== undefined && existing.appUserId !== who.id) {
    return page(409, 'This grant belongs to a different user than the installed app. Revoke the app in Linear first to install again.')
  }
  const scope = scopeText(reply.scope)
  try {
    await writeToken(env, {
      accessToken,
      refreshToken: reply.refresh_token as string,
      expiresAt: now + (reply.expires_in as number) * 1000,
      appUserId: who.id,
      organizationId: who.organizationId,
      ...(scope !== undefined ? { scope } : {}),
      savedAt: now,
    })
  } catch (error) {
    console.warn(`storing the installed token failed: ${errorText(error)}`)
    return page(503, 'Linear issued a token but it could not be stored. Mint a new install link and try again.')
  }
  return page(200, 'auto-claude is installed in this Linear workspace.')
}

export type RefreshResult = 'not-installed' | 'fresh' | 'refreshed' | 'failed' | 'dead'

// A DeadGrant is not retried: it is thrown to the caller.
async function attempts<T>(delays: readonly number[], sleep: (ms: number) => Promise<void>, what: string, run: () => Promise<T>): Promise<T | undefined> {
  for (const [i, delay] of delays.entries()) {
    if (delay > 0) await sleep(delay)
    try {
      return await run()
    } catch (error) {
      if (error instanceof DeadGrant) throw error
      console.warn(`${what} attempt ${i + 1} failed: ${errorText(error)}`)
    }
  }
  return undefined
}

// Called only from the scheduled handler. The refresh is retried within Linear's 30-minute reuse
// window, and once Linear has answered, only the KV write is retried: refreshing again would
// rotate past the pair just issued. A grant Linear calls invalid is dropped (unless a newer pair
// was saved meanwhile), so health and the API say "not installed" instead of failing every call.
export async function refreshIfDue(env: Env, now: number, sleep: (ms: number) => Promise<void> = wait): Promise<RefreshResult> {
  const read = await readTokenStrict(env)
  if (read === 'unreadable') return 'failed'
  const token = read.token
  if (token === undefined) return 'not-installed'
  if (token.expiresAt - now > REFRESH_WITHIN_MS) return 'fresh'
  const form = { grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: env.LINEAR_CLIENT_ID, client_secret: env.LINEAR_CLIENT_SECRET }
  let reply: TokenReply | undefined
  try {
    reply = await attempts(REFRESH_BACKOFF_MS, sleep, 'token refresh', () => tokenRequest(form))
  } catch (error) {
    const current = await readTokenStrict(env)
    if (current === 'unreadable' || current.token === undefined || current.token.savedAt !== token.savedAt) return 'failed'
    console.warn(`${errorText(error)}: dropping the dead grant; reinstall through POST /v1/install`)
    await deleteToken(env, now)
    return 'dead'
  }
  if (reply === undefined) return 'failed'
  const scope = scopeText(reply.scope) ?? token.scope
  const next: StoredToken = {
    ...token,
    accessToken: reply.access_token as string,
    refreshToken: reply.refresh_token as string,
    expiresAt: now + (reply.expires_in as number) * 1000,
    ...(scope !== undefined ? { scope } : {}),
    savedAt: now,
  }
  const saved = await attempts(WRITE_BACKOFF_MS, sleep, 'token write', () => writeToken(env, next).then(() => true))
  return saved === true ? 'refreshed' : 'failed'
}

export async function health(env: Env): Promise<Response> {
  return json({ ok: true, installed: (await readToken(env)) !== undefined })
}
