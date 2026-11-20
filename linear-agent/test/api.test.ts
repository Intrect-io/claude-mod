import { afterEach, describe, expect, test } from 'bun:test'
import { route } from '../src/index'
import { TOKEN_KEY } from '../src/oauth'
import { HOLD_BACK_MS } from '../src/store'
import { fakeCtx, gqlReply, installedToken, makeEnv, mockFetch, SECRETS } from './fakes'

const NOW = 1_795_000_000_000
let restore = () => {}
afterEach(() => restore())

type Env = ReturnType<typeof makeEnv>['env']
const auth = { authorization: `Bearer ${SECRETS.SESSION_TOKEN}` }

function call(env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = auth) {
  const init: RequestInit = { method, headers: { ...headers, 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  return route(new Request(`https://linear-agent.intrect.io${path}`, init), env, fakeCtx().ctx as never, NOW)
}

function insert(db: ReturnType<typeof makeEnv>['db'], key: string, project: string | null, over: Record<string, unknown> = {}) {
  const row = { action: 'created', session_id: `s-${key}`, issue_id: `i-${key}`, identifier: 'AGT-1', created_at: NOW, ...over }
  db.query('INSERT INTO events (key, action, session_id, issue_id, identifier, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(key, row.action as string, row.session_id as string, row.issue_id as string, row.identifier as string, project, row.created_at as number)
}

describe('session API auth', () => {
  test('no token or a wrong token is refused on every route', async () => {
    const { env } = makeEnv()
    expect((await call(env, 'GET', '/v1/events?since=0&project=p', undefined, {})).status).toBe(401)
    expect((await call(env, 'POST', '/v1/activity', {}, { authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await call(env, 'POST', '/v1/plan', {}, { authorization: SECRETS.SESSION_TOKEN })).status).toBe(401)
  })
})

describe('GET /v1/events', () => {
  test('returns the project\'s rows after the cursor, in order, with a cursor', async () => {
    const { env, db } = makeEnv()
    insert(db, 'a', 'p1')
    insert(db, 'b', 'p2')
    insert(db, 'c', 'p1')
    const res = await (await call(env, 'GET', '/v1/events?since=1&project=p1')).json()
    expect(res.events.map((e: { id: number; projectId: string }) => [e.id, e.projectId])).toEqual([[3, 'p1']])
    expect(res.cursor).toBe(3)
    expect(res.events[0]).toMatchObject({ action: 'created', sessionId: 's-c', issueId: 'i-c', identifier: 'AGT-1' })
  })

  test('a row whose project is unknown is looked up again when read', async () => {
    const { env, db, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    insert(db, 'a', null)
    restore = mockFetch(gqlReply('issue(id: $id)', { issue: { project: { id: 'p1' } } })).restore
    const res = await (await call(env, 'GET', '/v1/events?since=0&project=p1')).json()
    expect(res.events.map((e: { id: number }) => e.id)).toEqual([1])
  })

  test('a row whose lookup still fails holds back later rows until it is old', async () => {
    const { env, db, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    insert(db, 'a', null)
    insert(db, 'b', 'p1')
    restore = mockFetch().restore
    expect((await (await call(env, 'GET', '/v1/events?since=0&project=p1')).json()).events).toEqual([])
    db.query('UPDATE events SET created_at = ? WHERE key = ?').run(NOW - HOLD_BACK_MS - 1, 'a')
    expect((await (await call(env, 'GET', '/v1/events?since=0&project=p1')).json()).events.map((e: { id: number }) => e.id)).toEqual([2])
  })

  test('more unresolved rows than one lookup batch: the answer stops below the rest of the batch', async () => {
    const { env, db, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    for (let i = 0; i < 21; i++) insert(db, `u${i}`, null)
    insert(db, 'late', 'p1')
    restore = mockFetch(gqlReply('issue(id: $id)', { issue: { project: { id: 'p-other' } } })).restore
    expect((await (await call(env, 'GET', '/v1/events?since=0&project=p1')).json()).events).toEqual([])
    expect((await (await call(env, 'GET', '/v1/events?since=0&project=p1')).json()).events.map((e: { id: number }) => e.id)).toEqual([22])
  })

  test('rows still unresolved after the hold-back window are given up and cost no lookup', async () => {
    const { env, db, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    for (let i = 0; i < 25; i++) insert(db, `old${i}`, null, { created_at: NOW - HOLD_BACK_MS - 1 })
    insert(db, 'young', null)
    insert(db, 'mine', 'p1')
    const m = mockFetch()
    restore = m.restore
    expect((await (await call(env, 'GET', '/v1/events?since=0&project=p1')).json()).events).toEqual([])
    expect(m.calls).toHaveLength(1)
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE project_id = ''").get()).toEqual({ n: 25 })
  })

  test('project and since are required', async () => {
    const { env } = makeEnv()
    expect((await call(env, 'GET', '/v1/events?since=0')).status).toBe(400)
    expect((await call(env, 'GET', '/v1/events?since=-1&project=p')).status).toBe(400)
  })
})

describe('session writes', () => {
  test('before the install the write routes answer 409', async () => {
    const { env } = makeEnv()
    expect((await call(env, 'POST', '/v1/activity', { sessionId: 's1', content: { type: 'thought', body: 'x' } })).status).toBe(409)
  })

  test('POST /v1/activity validates the content and calls agentActivityCreate', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch(gqlReply('agentActivityCreate', { agentActivityCreate: { success: true } }))
    restore = m.restore
    expect((await call(env, 'POST', '/v1/activity', { sessionId: 's1', content: { type: 'prompt', body: 'x' } })).status).toBe(400)
    expect((await call(env, 'POST', '/v1/activity', { sessionId: 's1', content: { type: 'action', action: 'Building', parameter: 'AGT-1' } })).status).toBe(200)
    expect(JSON.parse(m.calls[0]!.body).variables.input).toEqual({ agentSessionId: 's1', content: { type: 'action', action: 'Building', parameter: 'AGT-1' } })
  })

  test('ephemeral is accepted only on thought and action; long bodies up to Linear\'s limit pass', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch(gqlReply('agentActivityCreate', { agentActivityCreate: { success: true } }))
    restore = m.restore
    expect((await call(env, 'POST', '/v1/activity', { sessionId: 's1', content: { type: 'elicitation', body: 'x' }, ephemeral: true })).status).toBe(400)
    expect((await call(env, 'POST', '/v1/activity', { sessionId: 's1', content: { type: 'thought', body: 'x' }, ephemeral: true })).status).toBe(200)
    expect((await call(env, 'POST', '/v1/activity', { sessionId: 's1', content: { type: 'response', body: 'y'.repeat(12_000) } })).status).toBe(200)
    expect((await call(env, 'POST', '/v1/activity', { sessionId: 's1', content: { type: 'response', body: 'y'.repeat(250_001) } })).status).toBe(400)
    expect((await call(env, 'POST', '/v1/activity', { sessionId: 's1', content: { type: 'action', action: 'Run', parameter: 'p', result: 'z'.repeat(250_001) } })).status).toBe(400)
    expect(JSON.parse(m.calls[0]!.body).variables.input.ephemeral).toBe(true)
  })

  test('POST /v1/plan replaces the plan whole, accepts null, and refuses more than 100 entries', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch(gqlReply('agentSessionUpdate', { agentSessionUpdate: { success: true } }))
    restore = m.restore
    const plan = [{ content: 'build', status: 'inProgress' }]
    expect((await call(env, 'POST', '/v1/plan', { sessionId: 's1', plan })).status).toBe(200)
    expect((await call(env, 'POST', '/v1/plan', { sessionId: 's1', plan: null })).status).toBe(200)
    expect((await call(env, 'POST', '/v1/plan', { sessionId: 's1', plan: Array.from({ length: 101 }, () => plan[0]) })).status).toBe(400)
    expect((await call(env, 'POST', '/v1/plan', { sessionId: 's1', plan: [{ content: 'x', status: 'done' }] })).status).toBe(400)
    expect(m.calls.map(c => JSON.parse(c.body).variables)).toEqual([{ id: 's1', input: { plan } }, { id: 's1', input: { plan: null } }])
  })

  test('POST /v1/external-url adds one https link', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch(gqlReply('agentSessionUpdate', { agentSessionUpdate: { success: true } }))
    restore = m.restore
    expect((await call(env, 'POST', '/v1/external-url', { sessionId: 's1', label: 'PR #9', url: 'javascript:alert(1)' })).status).toBe(400)
    expect((await call(env, 'POST', '/v1/external-url', { sessionId: 's1', label: 'PR #9', url: 'https://github.com/o/r/pull/9' })).status).toBe(200)
    expect(JSON.parse(m.calls[0]!.body).variables.input).toEqual({ addedExternalUrls: [{ label: 'PR #9', url: 'https://github.com/o/r/pull/9' }] })
  })

  test('POST /v1/issue resolves the team key, adds the auto-claude label, and delegates only when asked', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch(
      gqlReply('teams(filter', { teams: { nodes: [{ id: 'team-1', labels: { nodes: [{ id: 'label-ac' }] } }] } }),
      gqlReply('issueCreate', { issueCreate: { success: true, issue: { id: 'i-9', identifier: 'AGT-9', url: 'https://linear.app/x/issue/AGT-9' } } }),
    )
    restore = m.restore
    const plain = await (await call(env, 'POST', '/v1/issue', { team: 'AGT', title: 'Held: wire the cron', description: 'why' })).json()
    expect(plain).toEqual({ ok: true, id: 'i-9', identifier: 'AGT-9', url: 'https://linear.app/x/issue/AGT-9', triaged: false })
    await call(env, 'POST', '/v1/issue', { team: 'AGT', title: 'step', parentId: 'i-5', projectId: 'p1', delegate: true })
    const inputs = m.calls.filter(c => c.body.includes('issueCreate')).map(c => JSON.parse(c.body).variables.input)
    expect(inputs[0]).toEqual({ teamId: 'team-1', title: 'Held: wire the cron', description: 'why', labelIds: ['label-ac'] })
    expect(inputs[1]).toEqual({ teamId: 'team-1', title: 'step', parentId: 'i-5', projectId: 'p1', delegateId: 'app-user-1', labelIds: ['label-ac'] })
  })

  test('POST /v1/issue with triage puts the issue in the team\'s triage state when triage is on', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch(
      gqlReply('teams(filter', { teams: { nodes: [{ id: 'team-1', triageEnabled: true, triageIssueState: { id: 'state-triage' }, labels: { nodes: [] } }] } }),
      gqlReply('issueCreate', { issueCreate: { success: true, issue: { id: 'i-10', identifier: 'AGT-10', url: 'https://linear.app/x/issue/AGT-10' } } }),
    )
    restore = m.restore
    const res = await (await call(env, 'POST', '/v1/issue', { team: 'AGT', title: 'Held: x', description: 'why', triage: true })).json()
    expect(res.triaged).toBe(true)
    expect(JSON.parse(m.calls.find(c => c.body.includes('issueCreate'))!.body).variables.input).toEqual({ teamId: 'team-1', title: 'Held: x', description: 'why', stateId: 'state-triage' })
  })

  test('POST /v1/issue with triage on a team without triage uses the default state', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    const m = mockFetch(
      gqlReply('teams(filter', { teams: { nodes: [{ id: 'team-1', triageEnabled: false, triageIssueState: null, labels: { nodes: [] } }] } }),
      gqlReply('issueCreate', { issueCreate: { success: true, issue: { id: 'i-11', identifier: 'AGT-11', url: 'u' } } }),
    )
    restore = m.restore
    expect((await (await call(env, 'POST', '/v1/issue', { team: 'AGT', title: 't', triage: true })).json()).triaged).toBe(false)
    expect(JSON.parse(m.calls.find(c => c.body.includes('issueCreate'))!.body).variables.input.stateId).toBeUndefined()
  })

  test('GET /v1/fingerprints returns the markers of the project\'s open and recently closed issues, across pages', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    let page = 0
    const m = mockFetch(call => {
      if (!call.url.includes('graphql')) return undefined
      page++
      return page === 1
        ? { json: { data: { issues: { nodes: [{ description: 'x\n\nauto-claude:fp=held:0b54ad7f0675' }, { description: null }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } } }
        : { json: { data: { issues: { nodes: [{ description: 'auto-claude:fp=ci-red:fe8ee15bb86d and auto-claude:fp=held:0b54ad7f0675' }], pageInfo: { hasNextPage: false, endCursor: null } } } } }
    })
    restore = m.restore
    const res = await (await call(env, 'GET', '/v1/fingerprints?project=p1')).json()
    expect(res).toEqual({ fingerprints: ['auto-claude:fp=ci-red:fe8ee15bb86d', 'auto-claude:fp=held:0b54ad7f0675'] })
    const vars = JSON.parse(m.calls[0]!.body).variables
    expect(vars.project).toBe('p1')
    expect(vars.since).toBe(new Date(NOW - 30 * 24 * 3_600_000).toISOString())
    expect(JSON.parse(m.calls[1]!.body).variables.after).toBe('c1')
  })

  test('GET /v1/fingerprints needs a project and the install', async () => {
    const { env } = makeEnv()
    expect((await call(env, 'GET', '/v1/fingerprints')).status).toBe(400)
    expect((await call(env, 'GET', '/v1/fingerprints?project=p1')).status).toBe(409)
    expect((await call(env, 'GET', '/v1/fingerprints?project=p1', undefined, {})).status).toBe(401)
  })

  test('a Linear error comes back as 502 with its message and no token', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    restore = mockFetch(call => (call.url.includes('graphql') ? { status: 400, json: { errors: [{ message: 'Entity not found' }] } } : undefined)).restore
    const res = await call(env, 'POST', '/v1/activity', { sessionId: 's1', content: { type: 'thought', body: 'x' } })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).toContain('Entity not found')
    expect(text).not.toContain('access-fixture')
  })
})
