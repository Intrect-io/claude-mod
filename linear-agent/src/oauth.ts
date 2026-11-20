// The app's OAuth install (actor=app) and its token: one KV key holds the access
// token, the refresh token, the expiry and the app user together. Only the
// scheduled handler refreshes it: Linear rotates the refresh token on every
// refresh and KV is eventually consistent, so two refreshers could lose the pair.

import { type Env, errorText, json } from './env'
import { viewer } from './linear'

export const AUTHORIZE_URL = 'https://linear.app/oauth/authorize'
export const TOKEN_URL = 'https://api.linear.app/oauth/token'
export const SCOPES = 'read,write,app:assignable,app:mentionable'
export const TOKEN_KEY = 'oauth:token'
export const STATE_PREFIX = 'oauth-state:'
export const STATE_TTL_SECONDS = 600
export const REFRESH_WITHIN_MS = 12 * 3_600_000

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

export async function readToken(kv: KVNamespace): Promise<StoredToken | undefined> {
  const raw = await kv.get(TOKEN_KEY)
  if (raw === null) return undefined
  return JSON.parse(raw) as StoredToken
}

// The whole pair in one write, so a reader never sees a new access token with an old refresh token.
export async function writeToken(kv: KVNamespace, token: StoredToken): Promise<void> {
  await kv.put(TOKEN_KEY, JSON.stringify(token))
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

async function tokenRequest(form: Record<string, string>): Promise<TokenReply> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  if (!res.ok) throw new Error(`token endpoint answered ${res.status}`)
  const reply = (await res.json()) as TokenReply
  if (typeof reply.access_token !== 'string' || typeof reply.refresh_token !== 'string' || typeof reply.expires_in !== 'number') {
    throw new Error('token endpoint reply lacks access_token, refresh_token or expires_in')
  }
  return reply
}

const scopeText = (scope: TokenReply['scope']) => (Array.isArray(scope) ? scope.join(' ') : scope)

export async function startInstall(env: Env, url: URL): Promise<Response> {
  const state = randomHex(16)
  await env.TOKENS.put(`${STATE_PREFIX}${state}`, '1', { expirationTtl: STATE_TTL_SECONDS })
  return Response.redirect(authorizeUrl(env.LINEAR_CLIENT_ID, callbackUrl(url), state), 302)
}

const page = (status: number, text: string) => new Response(`<!doctype html><title>linear-agent</title><p>${text}</p>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

export async function finishInstall(env: Env, url: URL, now: number): Promise<Response> {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (code === null || state === null) return page(400, 'Missing code or state.')
  const stateKey = `${STATE_PREFIX}${state}`
  if ((await env.TOKENS.get(stateKey)) === null) return page(400, 'Unknown or expired state. Start again from /oauth/start.')
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
  const existing = await readToken(env.TOKENS)
  if (existing !== undefined && existing.organizationId !== who.organizationId) {
    return page(409, 'This Worker is already installed in another Linear workspace.')
  }
  const scope = scopeText(reply.scope)
  await writeToken(env.TOKENS, {
    accessToken,
    refreshToken: reply.refresh_token as string,
    expiresAt: now + (reply.expires_in as number) * 1000,
    appUserId: who.id,
    organizationId: who.organizationId,
    ...(scope !== undefined ? { scope } : {}),
    savedAt: now,
  })
  return page(200, 'auto-claude is installed in this Linear workspace.')
}

export type RefreshResult = 'not-installed' | 'fresh' | 'refreshed' | 'failed'

// Called only from the scheduled handler.
export async function refreshIfDue(env: Env, now: number): Promise<RefreshResult> {
  const token = await readToken(env.TOKENS)
  if (token === undefined) return 'not-installed'
  if (token.expiresAt - now > REFRESH_WITHIN_MS) return 'fresh'
  const form = { grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: env.LINEAR_CLIENT_ID, client_secret: env.LINEAR_CLIENT_SECRET }
  // Linear accepts the same refresh token again for 30 minutes, so one immediate retry recovers a lost reply.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await tokenRequest(form)
      const scope = scopeText(reply.scope) ?? token.scope
      await writeToken(env.TOKENS, {
        ...token,
        accessToken: reply.access_token as string,
        refreshToken: reply.refresh_token as string,
        expiresAt: now + (reply.expires_in as number) * 1000,
        ...(scope !== undefined ? { scope } : {}),
        savedAt: now,
      })
      return 'refreshed'
    } catch (error) {
      console.warn(`token refresh attempt ${attempt} failed: ${errorText(error)}`)
    }
  }
  return 'failed'
}

export async function health(env: Env): Promise<Response> {
  return json({ ok: true, installed: (await readToken(env.TOKENS)) !== undefined })
}
