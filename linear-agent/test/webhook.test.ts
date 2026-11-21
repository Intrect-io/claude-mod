import { afterEach, describe, expect, test } from 'bun:test'
import { MAX_WEBHOOK_BYTES, route } from '../src/index'
import { TOKEN_KEY } from '../src/oauth'
import { fakeCtx, gqlReply, installedToken, makeEnv, mockFetch, sign } from './fakes'

const NOW = 1_795_000_000_000
let restore = () => {}
afterEach(() => restore())

const created = (sessionId = 'sess-1', ts = NOW - 1_000) => ({
  type: 'AgentSessionEvent',
  action: 'created',
  webhookTimestamp: ts,
  organizationId: 'org-1',
  promptContext: '<issue identifier="AGT-12"/>',
  agentSession: { id: sessionId, issueId: 'iss-12', issue: { id: 'iss-12', identifier: 'AGT-12', title: 'Add a health endpoint', url: 'https://linear.app/x/issue/AGT-12' } },
})

async function post(env: ReturnType<typeof makeEnv>['env'], body: unknown, ctx = fakeCtx(), delivery = 'd-1', raw = JSON.stringify(body)) {
  const req = new Request('https://linear-agent.intrect.io/webhook', {
    method: 'POST',
    headers: { 'Linear-Signature': await sign(raw), 'Linear-Delivery': delivery, 'content-type': 'application/json' },
    body: raw,
  })
  const res = await route(req, env, ctx.ctx as never, NOW)
  await ctx.settle()
  return res
}

describe('POST /webhook', () => {
  test('a created event is written once, its project resolved, and the first thought sent with the app token', async () => {
    const { env, db, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch(gqlReply('agentActivityCreate', { agentActivityCreate: { success: true } }), gqlReply('issue(id: $id)', { issue: { project: { id: 'proj-1' } } }))
    restore = m.restore
    const res = await post(env, created())
    expect(res.status).toBe(200)
    const rows = db.query('SELECT key, session_id, issue_id, identifier, project_id, prompt FROM events').all() as Array<Record<string, unknown>>
    expect(rows).toEqual([{ key: 'created:sess-1', session_id: 'sess-1', issue_id: 'iss-12', identifier: 'AGT-12', project_id: 'proj-1', prompt: '<issue identifier="AGT-12"/>' }])
    const thought = m.calls.find(c => c.body.includes('agentActivityCreate'))!
    expect(thought.headers.authorization).toBe('Bearer access-fixture')
    expect(JSON.parse(thought.body).variables.input).toMatchObject({ agentSessionId: 'sess-1', content: { type: 'thought' } })
  })

  test('the same session event delivered again (new delivery id) is not written twice', async () => {
    const { env, db, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    restore = mockFetch(gqlReply('agentActivityCreate', { agentActivityCreate: { success: true } }), gqlReply('issue(id: $id)', { issue: { project: null } })).restore
    expect((await post(env, created(), fakeCtx(), 'd-1')).status).toBe(200)
    expect(await (await post(env, created(), fakeCtx(), 'd-2')).text()).toBe('duplicate')
    expect(db.query('SELECT project_id FROM events').all()).toEqual([{ project_id: '' }])
  })

  test('a failing D1 write answers 503 so Linear retries', async () => {
    const { env } = makeEnv({ failWrites: true })
    restore = mockFetch().restore
    const res = await post(env, created())
    expect(res.status).toBe(503)
  })

  test('a write that commits only after its delivery got 503 is taken over by the retry, which sends the first thought', async () => {
    let delay = 3_200
    const { env, db, kv } = makeEnv({ writeDelayMs: () => delay })
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch(gqlReply('agentActivityCreate', { agentActivityCreate: { success: true } }), gqlReply('issue(id: $id)', { issue: { project: { id: 'proj-1' } } }))
    restore = m.restore
    expect((await post(env, created(), fakeCtx(), 'd-1')).status).toBe(503)
    await new Promise(r => setTimeout(r, 400))
    expect(db.query('SELECT key, confirmed FROM events').all()).toEqual([{ key: 'created:sess-1', confirmed: 0 }])
    delay = 0
    const retry = await post(env, created(), fakeCtx(), 'd-1')
    expect(await retry.text()).toBe('queued')
    expect(db.query('SELECT confirmed FROM events').all()).toEqual([{ confirmed: 1 }])
    expect(m.calls.filter(c => c.body.includes('agentActivityCreate'))).toHaveLength(1)
    expect((await (await post(env, created(), fakeCtx(), 'd-1')).text())).toBe('duplicate')
  }, 10_000)

  test('an app revoke for this client and workspace drops the installed token', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    restore = mockFetch().restore
    const other = { type: 'OAuthApp', action: 'revoked', webhookTimestamp: NOW - 500, organizationId: 'org-other', oauthClientId: 'client-id-fixture' }
    expect((await post(env, other)).status).toBe(200)
    expect(kv.has(TOKEN_KEY)).toBe(true)
    expect((await post(env, { ...other, organizationId: 'org-1' })).status).toBe(200)
    expect(kv.has(TOKEN_KEY)).toBe(false)
  })

  test('a bad signature is refused before anything is written', async () => {
    const { env, db } = makeEnv()
    const raw = JSON.stringify(created())
    const req = new Request('https://linear-agent.intrect.io/webhook', { method: 'POST', headers: { 'Linear-Signature': '0'.repeat(64) }, body: raw })
    const res = await route(req, env, fakeCtx().ctx as never, NOW)
    expect(res.status).toBe(401)
    expect(db.query('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })
  })

  test('before the app is installed the event is still written; the thought fails quietly', async () => {
    const { env, db } = makeEnv()
    const m = mockFetch()
    restore = m.restore
    const res = await post(env, created())
    expect(res.status).toBe(200)
    expect(db.query('SELECT project_id FROM events').all()).toEqual([{ project_id: null }])
    expect(m.calls).toHaveLength(0)
  })

  test('a prompted event stores the text and the stop signal', async () => {
    const { env, db, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    restore = mockFetch(gqlReply('issue(id: $id)', { issue: { project: { id: 'proj-1' } } })).restore
    const body = { ...created(), action: 'prompted', promptContext: undefined, agentActivity: { id: 'act-1', content: { type: 'prompt', body: 'stop now' }, signal: 'stop' } }
    expect((await post(env, body)).status).toBe(200)
    expect(db.query('SELECT key, prompt, signal FROM events').all()).toEqual([{ key: 'prompted:act-1', prompt: 'stop now', signal: 'stop' }])
  })
})

describe('webhook hardening', () => {
  test('a body over the cap is refused with 413 before anything is written', async () => {
    const { env, db } = makeEnv()
    restore = mockFetch().restore
    const big = 'x'.repeat(MAX_WEBHOOK_BYTES + 1)
    const declared = new Request('https://linear-agent.intrect.io/webhook', { method: 'POST', headers: { 'Linear-Signature': 'ab'.repeat(32), 'content-length': String(big.length) }, body: big })
    expect((await route(declared, env, fakeCtx().ctx as never, NOW)).status).toBe(413)
    // No Content-Length: the stream itself is cut off at the cap.
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close() } })
    const chunked = new Request('https://linear-agent.intrect.io/webhook', { method: 'POST', headers: { 'Linear-Signature': 'ab'.repeat(32) }, body: stream, duplex: 'half' } as RequestInit)
    expect((await route(chunked, env, fakeCtx().ctx as never, NOW)).status).toBe(413)
    expect(db.query('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })
  })

  test('a Korean title split across stream chunks still verifies and is stored intact', async () => {
    const { env, db, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    restore = mockFetch(gqlReply('agentActivityCreate', { agentActivityCreate: { success: true } }), gqlReply('issue(id: $id)', { issue: { project: { id: 'proj-1' } } })).restore
    const body = created()
    body.agentSession.issue.title = '헬스 엔드포인트 추가'
    const raw = JSON.stringify(body)
    const bytes = new TextEncoder().encode(raw)
    const cut = new TextEncoder().encode(raw.slice(0, raw.indexOf('헬') + 1)).length - 1
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close() } })
    const req = new Request('https://linear-agent.intrect.io/webhook', { method: 'POST', headers: { 'Linear-Signature': await sign(raw), 'Linear-Delivery': 'd-ko' }, body: stream, duplex: 'half' } as RequestInit)
    const ctx = fakeCtx()
    expect((await route(req, env, ctx.ctx as never, NOW)).status).toBe(200)
    await ctx.settle()
    expect(db.query('SELECT title FROM events').get()).toEqual({ title: '헬스 엔드포인트 추가' })
  })

  test('a signed session event from another workspace is answered 200 and not queued', async () => {
    const { env, db, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch()
    restore = m.restore
    const res = await post(env, { ...created('sess-x'), organizationId: 'org-other' })
    expect(res.status).toBe(200)
    expect(db.query('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })
    expect(m.calls).toHaveLength(0)
  })

  test('before the install a session event is still queued (held until a token can resolve it)', async () => {
    const { env, db } = makeEnv()
    restore = mockFetch().restore
    expect((await post(env, created('sess-early'))).status).toBe(200)
    expect(db.query('SELECT key, project_id FROM events').all()).toEqual([{ key: 'created:sess-early', project_id: null }])
  })
})
