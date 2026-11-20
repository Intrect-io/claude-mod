// Linear webhook handling: signature and replay checks, event classification,
// and the request handler. The contract is fixtures/linear-agent-v1/README.md.
// Web APIs only (crypto.subtle, Headers, Response), so it runs under plain bun
// as well as on Workers.

const encoder = new TextEncoder()
const SIGNATURE_HEX = /^[0-9a-f]{64}$/i
const REPLAY_WINDOW_MS = 60_000
export const DEFAULT_WRITE_TIMEOUT_MS = 3_000

export type SessionEvent = {
  action: 'created' | 'prompted'
  sessionId: string
  issueId: string
  identifier?: string
  title?: string
  url?: string
  prompt?: string
  signal?: string
  activityId?: string
}

// What the queue write receives: the event plus its dedup key.
export type QueuedEvent = SessionEvent & { key: string; deliveryId?: string }

export type Verified =
  | { ok: true; body: unknown }
  | { ok: false; status: 400 | 401; reason: 'signature' | 'json' | 'timestamp' }

export type Classified = { kind: 'session'; event: SessionEvent } | { kind: 'ignore'; reason: string }

export type WebhookDeps = {
  secret: string
  now: number
  writeTimeoutMs?: number
  // Writes the event durably; true when it is new, false when its key was already queued.
  enqueue(event: QueuedEvent): Promise<boolean>
  thought(sessionId: string, body: string): Promise<void>
  // ctx.waitUntil: work that must finish after the answer is sent.
  after(promise: Promise<unknown>): void
}

export const FIRST_THOUGHT = 'auto-claude picked this up. It will plan the issue as milestones and report progress in this session.'

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// Compares every byte whatever the first difference, so timing does not reveal it.
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Signature first, then JSON, then the replay window; the first failure decides. Never throws.
export async function verifyWebhook(raw: string, signature: string | null, secret: string, nowMs: number): Promise<Verified> {
  try {
    if (signature === null || !SIGNATURE_HEX.test(signature)) return { ok: false, status: 401, reason: 'signature' }
    const expected = await hmacSha256(secret, raw)
    if (!constantTimeEqual(expected, hexBytes(signature))) return { ok: false, status: 401, reason: 'signature' }
  } catch {
    return { ok: false, status: 401, reason: 'signature' }
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, status: 400, reason: 'json' }
  }
  const ts = isRecord(body) ? body.webhookTimestamp : undefined
  if (typeof ts !== 'number' || !Number.isFinite(ts) || Math.abs(nowMs - ts) > REPLAY_WINDOW_MS) return { ok: false, status: 401, reason: 'timestamp' }
  return { ok: true, body }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

// An agent session event is recognised by its shape, never by `type`, which the schema does not fix.
export function classifyEvent(body: unknown): Classified {
  if (!isRecord(body)) return { kind: 'ignore', reason: 'not an object' }
  const session = body.agentSession
  if (!isRecord(session) || typeof session.id !== 'string') return { kind: 'ignore', reason: 'not an agent session event' }
  const action = body.action
  if (action !== 'created' && action !== 'prompted') return { kind: 'ignore', reason: `agent session action ${String(action)}` }
  const issue = isRecord(session.issue) ? session.issue : {}
  const issueId = str(issue.id) ?? str(session.issueId)
  if (issueId === undefined) return { kind: 'ignore', reason: 'agent session without an issue' }
  const activity = isRecord(body.agentActivity) ? body.agentActivity : {}
  const content = isRecord(activity.content) ? activity.content : {}
  const prompt = action === 'created' ? str(body.promptContext) : (str(content.body) ?? str(activity.body))
  const signal = str(activity.signal)
  const activityId = str(activity.id)
  const event: SessionEvent = { action, sessionId: session.id, issueId }
  const identifier = str(issue.identifier)
  const title = str(issue.title)
  const url = str(issue.url)
  if (identifier !== undefined) event.identifier = identifier
  if (title !== undefined) event.title = title
  if (url !== undefined) event.url = url
  if (prompt !== undefined) event.prompt = prompt
  if (signal !== undefined) event.signal = signal
  if (activityId !== undefined) event.activityId = activityId
  return { kind: 'session', event }
}

// The dedup key does not rely on Linear reusing a delivery id across retries.
export function eventKey(event: SessionEvent, delivery: string | null, webhookTimestamp?: unknown): string {
  if (event.action === 'created') return `created:${event.sessionId}`
  if (event.activityId !== undefined) return `prompted:${event.activityId}`
  if (delivery !== null) return `delivery:${delivery}`
  return `prompted:${event.sessionId}:${String(webhookTimestamp)}`
}

const TIMED_OUT = Symbol('timed out')

// The write's outcome, or TIMED_OUT when it rejects or does not finish in time.
async function writeWithin(write: () => Promise<boolean>, ms: number): Promise<boolean | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([write(), timeout])
  } catch {
    return TIMED_OUT
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function handleWebhook(raw: string, headers: Headers, deps: WebhookDeps): Promise<Response> {
  const verified = await verifyWebhook(raw, headers.get('Linear-Signature'), deps.secret, deps.now)
  if (!verified.ok) return new Response(verified.reason, { status: verified.status })
  const classified = classifyEvent(verified.body)
  if (classified.kind === 'ignore') return new Response('ignored', { status: 200 })

  const delivery = headers.get('Linear-Delivery')
  const timestamp = isRecord(verified.body) ? verified.body.webhookTimestamp : undefined
  const queued: QueuedEvent = { ...classified.event, key: eventKey(classified.event, delivery, timestamp) }
  if (delivery !== null) queued.deliveryId = delivery

  const written = await writeWithin(() => deps.enqueue(queued), deps.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS)
  // 503 lets Linear retry; nothing was recorded, so the retry is handled like a first delivery.
  if (written === TIMED_OUT) return new Response('queue write failed', { status: 503 })
  if (!written) return new Response('duplicate', { status: 200 })
  if (queued.action === 'created') {
    // Never awaited: a slow Linear API must not delay the answer. A failure is logged,
    // never rethrown, so the promise handed to waitUntil always settles.
    const sent = deps.thought(queued.sessionId, FIRST_THOUGHT).catch((error: unknown) => {
      console.warn(`first thought for session ${queued.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    deps.after(sent)
  }
  return new Response('queued', { status: 200 })
}
