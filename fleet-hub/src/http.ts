import type { Server, ServerWebSocket } from 'bun'

import type { Bus, BusEvent } from './bus'
import type { GrantFile, GrantRequests } from './grant'
import { buildGrant, grantStatus, readGrantFile, revoked, writeGrantFile } from './grant'
import type { From } from './schema'
import { isChannel, parseHello, parsePost, parseState } from './schema'

// Two doors onto one bus:
// - the Unix socket (owner-only) for the fleet mod in each session: a session
//   speaks only as itself;
// - 127.0.0.1 for the dashboard: every /api call carries the dashboard token
//   in a header (never a cookie, so no other page can ride it), and only this
//   door may speak as the person, talk to the orchestrator or write the grant.

export type OrchestratorPort = {
  send(text: string, from: From): void
  // A grant was issued (or approved) or revoked: the orchestrator's mandate changed.
  granted?(grant: GrantFile | undefined): void
  status(): { state: string; detail?: string }
}

export type SlackPort = {
  notify(text: string): Promise<void>
  askGrant?(id: string, summary: string): Promise<void>
  status(): { state: string; detail?: string }
}

export type AppDeps = {
  bus: Bus
  grantPath: string
  requests: GrantRequests
  token: string
  webDir: string
  orchestrator?: OrchestratorPort
  slack?: SlackPort
  now?: () => number
  // Host headers the dashboard door answers; loopback on the server's port when absent.
  allowedHosts?: Set<string>
  // True for a request from one of the person's own tailnet devices (not this node).
  tailnetOwner?: (ip: string) => Promise<boolean>
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const bad = (error: string, status = 400) => json({ error }, status)

async function body(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}

const HUMAN: From = { kind: 'human', id: 'dashboard', name: 'user (dashboard)' }

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now
  const sockets = new Set<ServerWebSocket<unknown>>()
  deps.bus.subscribe((event: BusEvent) => {
    const text = JSON.stringify(event)
    for (const ws of sockets) ws.send(text)
  })
  const broadcast = (event: unknown) => {
    const text = JSON.stringify(event)
    for (const ws of sockets) ws.send(text)
  }

  // Routes both doors share: reading, and a session's own writes.
  async function shared(req: Request, url: URL): Promise<Response | undefined> {
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method
    if (method === 'GET' && url.pathname === '/api/sessions') return json(deps.bus.sessions())
    if (method === 'GET' && url.pathname === '/api/channels') return json(deps.bus.channels())
    if (method === 'GET' && url.pathname === '/api/messages') {
      const channel = url.searchParams.get('channel') ?? ''
      if (!isChannel(channel)) return bad('channel must be #name or @sessionId')
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)
      return json(deps.bus.read(channel, since, limit))
    }
    if (method === 'GET' && url.pathname === '/api/grant') {
      return json({ ...grantStatus(await readGrantFile(deps.grantPath), now()), path: deps.grantPath })
    }
    if (method === 'GET' && url.pathname === '/api/status') {
      return json({ orchestrator: deps.orchestrator?.status() ?? { state: 'off' }, slack: deps.slack?.status() ?? { state: 'off' } })
    }
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3 && parts[2] === 'hello' && method === 'POST') {
      const hello = parseHello(await body(req))
      if (hello === undefined) return bad('hello needs id and cwd')
      return json(deps.bus.hello(hello))
    }
    return undefined
  }

  // The fleet mod's door.
  async function uds(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const found = await shared(req, url)
    if (found !== undefined) return found
    // /api/sessions/:id/state | /api/sessions/:id/post | /api/inbox/:id | /api/inbox/:id/ack
    const id = parts[2]
    if (id === undefined || !/^[A-Za-z0-9_-]+$/.test(id)) return bad('not found', 404)
    const session = deps.bus.session(id)
    if (session === undefined) return bad('unknown session: say hello first', 409)
    deps.bus.touch(id)
    if (parts[1] === 'sessions' && parts[3] === 'state' && req.method === 'POST') {
      const state = parseState(await body(req))
      if (state === undefined) return bad('state must be idle, busy, waiting_on_user or offline')
      return json(deps.bus.setState(id, state.state, state.summary))
    }
    if (parts[1] === 'sessions' && parts[3] === 'post' && req.method === 'POST') {
      const post = parsePost(await body(req))
      if (post === undefined) return bad('post needs channel (#name or @sessionId) and text')
      return json(deps.bus.post(post.channel, { kind: 'session', id, name: session.name }, post.text, post.replyTo))
    }
    if (parts[1] === 'inbox' && parts.length === 3 && req.method === 'GET') return json(deps.bus.inbox(id))
    if (parts[1] === 'inbox' && parts[3] === 'ack' && req.method === 'POST') {
      const b = (await body(req)) as { ids?: unknown } | undefined
      const ids = Array.isArray(b?.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : []
      return json({ acked: deps.bus.ack(id, ids) })
    }
    return bad('not found', 404)
  }

  function hostOk(req: Request, port: number): boolean {
    const host = req.headers.get('host') ?? ''
    if (deps.allowedHosts !== undefined) return deps.allowedHosts.has(host)
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`
  }

  // The dashboard's door.
  async function tcp(req: Request, server: Server<unknown>): Promise<Response | undefined> {
    const url = new URL(req.url)
    // A page on another name resolving here (DNS rebinding) is turned away.
    if (!hostOk(req, server.port ?? 0)) return bad('bad host', 403)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(Bun.file(`${deps.webDir}/index.html`), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      })
    }
    const peer = server.requestIP(req)?.address?.replace(/^::ffff:/, '') ?? ''
    const authed = async (given: string | null) => given === deps.token || (deps.tailnetOwner !== undefined && (await deps.tailnetOwner(peer)))
    if (url.pathname === '/ws') {
      if (!(await authed(url.searchParams.get('token')))) return bad('token', 401)
      return server.upgrade(req, { data: undefined }) ? undefined : bad('upgrade failed', 500)
    }
    if (!url.pathname.startsWith('/api/')) return bad('not found', 404)
    if (!(await authed(req.headers.get('x-fleet-token')))) return bad('token', 401)

    const found = await shared(req, url)
    if (found !== undefined) return found
    const parts = url.pathname.split('/').filter(Boolean)

    if (url.pathname === '/api/human/post' && req.method === 'POST') {
      const post = parsePost(await body(req))
      if (post === undefined) return bad('post needs channel and text')
      return json(deps.bus.post(post.channel, HUMAN, post.text, post.replyTo))
    }
    if (url.pathname === '/api/orchestrator' && req.method === 'POST') {
      const b = (await body(req)) as { text?: unknown } | undefined
      if (typeof b?.text !== 'string' || b.text.trim() === '') return bad('text')
      if (deps.orchestrator === undefined) return bad('orchestrator is off', 503)
      deps.bus.post('#orchestrator', HUMAN, b.text)
      deps.orchestrator.send(b.text, HUMAN)
      return json({ queued: true })
    }
    if (url.pathname === '/api/grant' && req.method === 'POST') {
      const b = (await body(req)) as { hours?: unknown; goal?: unknown; allowed?: unknown } | undefined
      const hours = typeof b?.hours === 'number' ? b.hours : Number.NaN
      if (!(hours > 0) || typeof b?.goal !== 'string' || b.goal === '') return bad('grant needs hours > 0 and goal')
      const allowed = Array.isArray(b.allowed) ? b.allowed.filter((a): a is string => typeof a === 'string' && a !== '') : undefined
      const grant = buildGrant({ hours, goal: b.goal, allowed, grantedBy: `user via fleet dashboard ${new Date(now()).toISOString()}` }, now())
      await writeGrantFile(deps.grantPath, grant)
      broadcast({ type: 'grant' })
      deps.orchestrator?.granted?.(grant)
      return json(grant)
    }
    if (url.pathname === '/api/grant' && req.method === 'DELETE') {
      const status = grantStatus(await readGrantFile(deps.grantPath), now())
      if (status.state !== 'valid' && status.state !== 'foreign') return bad('no live grant', 409)
      await writeGrantFile(deps.grantPath, revoked(status.grant, now(), 'user via fleet dashboard'))
      broadcast({ type: 'grant' })
      deps.orchestrator?.granted?.(undefined)
      return json({ revoked: true })
    }
    if (url.pathname === '/api/grant/requests' && req.method === 'GET') return json(deps.requests.list())
    if (parts[0] === 'api' && parts[1] === 'grant' && parts[2] === 'requests' && parts.length === 5 && req.method === 'POST') {
      return settleRequest(parts[3]!, parts[4] === 'approve' ? 'approved' : parts[4] === 'deny' ? 'denied' : undefined, 'user via fleet dashboard')
    }
    return bad('not found', 404)
  }

  async function settleRequest(id: string, status: 'approved' | 'denied' | undefined, by: string): Promise<Response> {
    if (status === undefined) return bad('approve or deny')
    const request = deps.requests.settle(id, status)
    if (request === undefined) return bad('no pending request by that id', 404)
    if (status === 'approved') {
      const grant = buildGrant({ hours: request.hours, goal: request.goal, allowed: request.allowed, grantedBy: `${by} ${new Date(now()).toISOString()} (request ${id})` }, now())
      await writeGrantFile(deps.grantPath, grant)
      deps.orchestrator?.granted?.(grant)
    }
    deps.bus.post('#orchestrator', { kind: 'human', id: 'grant', name: by }, `grant request ${id} ${status}`)
    broadcast({ type: 'grant' })
    return json(request)
  }

  return {
    uds,
    tcp,
    settleRequest,
    websocket: {
      open(ws: ServerWebSocket<unknown>) {
        sockets.add(ws)
      },
      close(ws: ServerWebSocket<unknown>) {
        sockets.delete(ws)
      },
      message() {
        // The dashboard writes through /api; the socket only pushes.
      },
    },
  }
}
