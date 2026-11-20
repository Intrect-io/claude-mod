// linear-agent: auto-claude's Linear agent app on Cloudflare Workers.
// Routes: POST /webhook, GET /oauth/start, GET /oauth/callback, GET /health, /v1/* (session API).

import { handleApi } from './api'
import { type Env, errorText, json } from './env'
import { createActivity, issueProject } from './linear'
import { finishInstall, health, readToken, refreshIfDue, startInstall, TOKEN_KEY } from './oauth'
import { confirmEvent, insertEvent, NO_PROJECT, setProject } from './store'
import { handleWebhook, type QueuedEvent } from './webhook'

// After the row is written: its project, looked up with the app token. A failure leaves it null,
// and the events read looks it up again.
async function resolveProject(env: Env, e: QueuedEvent): Promise<void> {
  try {
    const token = await readToken(env.TOKENS)
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
  const token = await readToken(env.TOKENS)
  if (token !== undefined && token.organizationId === b.organizationId) await env.TOKENS.delete(TOKEN_KEY)
}

export async function webhook(req: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Response> {
  const raw = await req.text()
  let written: string | undefined
  const res = await handleWebhook(raw, req.headers, {
    secret: env.LINEAR_WEBHOOK_SECRET,
    now,
    enqueue: async e => {
      const fresh = await insertEvent(env.DB, e, now)
      if (fresh) {
        written = e.key
        ctx.waitUntil(resolveProject(env, e))
      }
      return fresh
    },
    ignored: body => onIgnored(env, body),
    thought: async (sessionId, body) => {
      const token = await readToken(env.TOKENS)
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
  if (url.pathname === '/oauth/start' && req.method === 'GET') return startInstall(env, url)
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
      }),
    )
  },
} satisfies ExportedHandler<Env>
