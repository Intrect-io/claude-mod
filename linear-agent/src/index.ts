// linear-agent: auto-claude's Linear agent app on Cloudflare Workers.
// Routes: POST /webhook, GET /oauth/callback, GET /health, /v1/* (session API, including
// POST /v1/install, which mints the install link).

import { handleApi } from './api'
import { type Env, errorText, json } from './env'
import { createActivity, issueProject } from './linear'
import { deleteToken, finishInstall, health, readToken, refreshIfDue } from './oauth'
import { confirmEvent, insertEvent, NO_PROJECT, setProject } from './store'
import { handleWebhook, type QueuedEvent } from './webhook'

// After the row is written: its project, looked up with the app token. A failure leaves it null,
// and the events read looks it up again.
async function resolveProject(env: Env, e: QueuedEvent): Promise<void> {
  try {
    const token = await readToken(env)
    if (token === undefined) return
    await setProject(env.DB, e.key, (await issueProject(token.accessToken, e.issueId)) ?? NO_PROJECT)
  } catch (error) {
    console.warn(`project lookup for ${e.key} failed: ${errorText(error)}`)
  }
}

// An app revoke for this client and the installed workspace drops the token, so health and the
// API say "not installed" instead of failing every call with a dead token.
async function onIgnored(env: Env, body: unknown): Promise<void> {
  if (typeof body !== 'object' || body === null) return
  const b = body as Record<string, unknown>
  if (b.type !== 'OAuthApp' || b.action !== 'revoked' || b.oauthClientId !== env.LINEAR_CLIENT_ID) return
  const token = await readToken(env)
  if (token !== undefined && token.organizationId === b.organizationId) await deleteToken(env)
}

// Linear's payloads are a few kilobytes; anything far larger is refused before it is hashed.
export const MAX_WEBHOOK_BYTES = 1 << 20

// The raw body, or undefined past the cap. Decoded once from the joined bytes, so a multi-byte
// character split across chunks stays intact (the signature is over those exact bytes).
async function cappedText(req: Request, max: number): Promise<string | undefined> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > max) return undefined
  if (req.body === null) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function organizationOf(raw: string): unknown {
  try {
    const body = JSON.parse(raw) as unknown
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>).organizationId : undefined
  } catch {
    return undefined
  }
}

// A session event from a workspace other than the installed one is answered 200 and not queued,
// so it can neither reach the driver nor hold back the installed workspace's events. Before the
// install (no token) events are queued and held: dropping them would lose sessions for good.
async function foreign(env: Env, organizationId: unknown): Promise<boolean> {
  const token = await readToken(env)
  return token !== undefined && organizationId !== token.organizationId
}

export async function webhook(req: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Response> {
  const raw = await cappedText(req, MAX_WEBHOOK_BYTES)
  if (raw === undefined) return json({ error: 'payload too large' }, 413)
  let written: string | undefined
  const res = await handleWebhook(raw, req.headers, {
    secret: env.LINEAR_WEBHOOK_SECRET,
    now,
    enqueue: async e => {
      if (await foreign(env, organizationOf(raw))) {
        console.warn(`dropping ${e.key}: its workspace is not the installed one`)
        return false
      }
      const fresh = await insertEvent(env.DB, e, now)
      if (fresh) {
        written = e.key
        ctx.waitUntil(resolveProject(env, e))
      }
      return fresh
    },
    ignored: body => onIgnored(env, body),
    thought: async (sessionId, body) => {
      const token = await readToken(env)
      if (token === undefined) throw new Error('the app is not installed')
      await createActivity(token.accessToken, sessionId, { type: 'thought', body })
    },
    after: p => ctx.waitUntil(p),
  })
  // Only a delivery answered 200 makes later deliveries duplicates; after a 503 the retry takes over.
  if (res.status === 200 && written !== undefined) {
    try {
      await confirmEvent(env.DB, written)
    } catch (error) {
      // Left unconfirmed, a redelivery is taken as new: at worst a second first-thought.
      console.warn(`confirming ${written} failed: ${errorText(error)}`)
    }
  }
  return res
}

export async function route(req: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === '/webhook') return req.method === 'POST' ? webhook(req, env, ctx, now) : json({ error: 'POST only' }, 405)
  if (url.pathname === '/oauth/start') return json({ error: 'install links are minted by POST /v1/install with the session token' }, 410)
  if (url.pathname === '/oauth/callback' && req.method === 'GET') return finishInstall(env, url, now)
  if (url.pathname === '/health' && req.method === 'GET') return health(env)
  if (url.pathname.startsWith('/v1/')) return handleApi(req, env, url, now)
  return json({ error: 'not found' }, 404)
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(req, env, ctx, Date.now())
  },
  // The only place tokens are refreshed (cron in wrangler.toml).
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      refreshIfDue(env, Date.now()).then(result => {
        if (result === 'failed') console.warn('token refresh failed; the next cron tries again')
        if (result === 'dead') console.warn('the grant is dead; the app must be installed again')
      }),
    )
  },
} satisfies ExportedHandler<Env>
