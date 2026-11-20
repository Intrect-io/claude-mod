import { afterEach, describe, expect, test } from 'bun:test'
import { route } from '../src/index'
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
