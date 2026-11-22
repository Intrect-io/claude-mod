import { afterEach, describe, expect, test } from 'bun:test'
import { route } from '../src/index'
import { readToken, REFRESH_BACKOFF_MS, REFRESH_WITHIN_MS, refreshIfDue, STATE_PREFIX, TOKEN_KEY } from '../src/oauth'
import { fakeCtx, gqlReply, installedToken, makeEnv, mockFetch, SECRETS } from './fakes'

const NOW = 1_795_000_000_000
const noSleep = async () => {}
let restore = () => {}
afterEach(() => restore())

const get = (env: ReturnType<typeof makeEnv>['env'], path: string) => route(new Request(`https://linear-agent.intrect.io${path}`), env, fakeCtx().ctx as never, NOW)

const tokenReply = (access = 'access-new', refresh = 'refresh-new') => (call: { url: string }) =>
  call.url === 'https://api.linear.app/oauth/token' ? { json: { access_token: access, refresh_token: refresh, expires_in: 86_399, scope: 'read write app:assignable app:mentionable', token_type: 'Bearer' } } : undefined

describe('oauth install', () => {
  test('install: POST /v1/install with the session token mints an authorize link with actor=app, the app scopes and a stored single-use state', async () => {
    const { env, kv } = makeEnv()
    const req = new Request('https://linear-agent.intrect.io/v1/install', { method: 'POST', headers: { authorization: `Bearer ${SECRETS.SESSION_TOKEN}` } })
    const res = await route(req, env, fakeCtx().ctx as never, NOW)
    expect(res.status).toBe(200)
    const to = new URL(((await res.json()) as { url: string }).url)
    expect(to.origin + to.pathname).toBe('https://linear.app/oauth/authorize')
    expect(to.searchParams.get('actor')).toBe('app')
    expect(to.searchParams.get('scope')).toBe('read,write,app:assignable,app:mentionable')
    expect(to.searchParams.get('client_id')).toBe(SECRETS.LINEAR_CLIENT_ID)
    expect(to.searchParams.get('redirect_uri')).toBe('https://linear-agent.intrect.io/oauth/callback')
    expect(kv.has(`${STATE_PREFIX}${to.searchParams.get('state')}`)).toBe(true)
  })

  test('install: nobody without the session token can mint a state (no KV write), and /oauth/start is gone', async () => {
    const { env, kv } = makeEnv()
    const anon = new Request('https://linear-agent.intrect.io/v1/install', { method: 'POST' })
    expect((await route(anon, env, fakeCtx().ctx as never, NOW)).status).toBe(401)
    expect((await get(env, '/oauth/start')).status).toBe(410)
    expect(kv.size).toBe(0)
  })

  test('the callback exchanges the code, stores the pair with the app user, and never shows a token', async () => {
    const { env, kv } = makeEnv()
    kv.set(`${STATE_PREFIX}s1`, '1')
    const m = mockFetch(tokenReply(), gqlReply('viewer', { viewer: { id: 'app-user-1', organization: { id: 'org-1' } } }))
    restore = m.restore
    const res = await get(env, '/oauth/callback?code=c1&state=s1')
    expect(res.status).toBe(200)
    const page = await res.text()
    expect(page).not.toContain('access-new')
    expect(page).not.toContain('refresh-new')
    const stored = JSON.parse(kv.get(TOKEN_KEY)!)
    expect(stored).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-new', appUserId: 'app-user-1', organizationId: 'org-1', expiresAt: NOW + 86_399_000 })
    expect(kv.has(`${STATE_PREFIX}s1`)).toBe(false)
    const form = new URLSearchParams(m.calls[0]!.body)
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'c1', client_secret: SECRETS.LINEAR_CLIENT_SECRET, redirect_uri: 'https://linear-agent.intrect.io/oauth/callback' })
  })

  test('an unknown or replayed state is refused without calling Linear', async () => {
    const { env } = makeEnv()
    const m = mockFetch(tokenReply())
    restore = m.restore
    expect((await get(env, '/oauth/callback?code=c1&state=nope')).status).toBe(400)
    expect(m.calls).toHaveLength(0)
  })

  test('an install from another workspace does not replace the installed token', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    kv.set(`${STATE_PREFIX}s2`, '1')
    restore = mockFetch(tokenReply('access-evil'), gqlReply('viewer', { viewer: { id: 'u-x', organization: { id: 'org-other' } } })).restore
    expect((await get(env, '/oauth/callback?code=c2&state=s2')).status).toBe(409)
    expect(JSON.parse(kv.get(TOKEN_KEY)!).accessToken).toBe('access-fixture')
  })

  test('install: a grant for a different user in the installed workspace does not replace the app token', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW))
    kv.set(`${STATE_PREFIX}s3`, '1')
    restore = mockFetch(tokenReply('access-person'), gqlReply('viewer', { viewer: { id: 'person-1', organization: { id: 'org-1' } } })).restore
    expect((await get(env, '/oauth/callback?code=c3&state=s3')).status).toBe(409)
    expect(JSON.parse(kv.get(TOKEN_KEY)!).accessToken).toBe('access-fixture')
  })

  test('/health says whether the app is installed and shows no token', async () => {
    const { env, kv } = makeEnv()
    expect(await (await get(env, '/health')).json()).toEqual({ ok: true, installed: false })
    kv.set(TOKEN_KEY, installedToken(NOW))
    const text = await (await get(env, '/health')).text()
    expect(JSON.parse(text)).toEqual({ ok: true, installed: true })
    expect(text).not.toContain('access-fixture')
  })
})

describe('scheduled token refresh', () => {
  test('a token with more than 12 hours left is left alone', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + REFRESH_WITHIN_MS + 60_000 }))
    const m = mockFetch(tokenReply())
    restore = m.restore
    expect(await refreshIfDue(env, NOW, noSleep)).toBe('fresh')
    expect(m.calls).toHaveLength(0)
  })

  test('a token under 12 hours is refreshed and the rotated pair written together', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + 3_600_000 }))
    const m = mockFetch(tokenReply('access-2', 'refresh-2'))
    restore = m.restore
    expect(await refreshIfDue(env, NOW, noSleep)).toBe('refreshed')
    expect(Object.fromEntries(new URLSearchParams(m.calls[0]!.body))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-fixture' })
    expect(JSON.parse(kv.get(TOKEN_KEY)!)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', appUserId: 'app-user-1', expiresAt: NOW + 86_399_000 })
  })

  test('a failing refresh is retried with backoff inside the 30-minute reuse window and keeps the old pair', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + 3_600_000 }))
    const m = mockFetch(call => (call.url.includes('/oauth/token') ? { status: 500, json: { error: 'boom' } } : undefined))
    restore = m.restore
    const slept: number[] = []
    expect(await refreshIfDue(env, NOW, async ms => void slept.push(ms))).toBe('failed')
    expect(m.calls).toHaveLength(REFRESH_BACKOFF_MS.length)
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30 * 60_000)
    expect(JSON.parse(kv.get(TOKEN_KEY)!).refreshToken).toBe('refresh-fixture')
  })

  test('a lost refresh reply is recovered by the next attempt with the same refresh token', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + 3_600_000 }))
    let n = 0
    const m = mockFetch(call => (call.url.includes('/oauth/token') ? (++n === 1 ? { status: 502, json: {} } : { json: { access_token: 'a3', refresh_token: 'r3', expires_in: 86_399 } }) : undefined))
    restore = m.restore
    expect(await refreshIfDue(env, NOW, noSleep)).toBe('refreshed')
    expect(m.calls.map(c => new URLSearchParams(c.body).get('refresh_token'))).toEqual(['refresh-fixture', 'refresh-fixture'])
    expect(JSON.parse(kv.get(TOKEN_KEY)!).refreshToken).toBe('r3')
  })

  test('when KV refuses every write after Linear rotated, the pair lands in D1 and the next cron reads it', async () => {
    const { env, kv, kvApi } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + 3_600_000 }))
    kvApi.put = async () => {
      throw new Error('KV write quota used up')
    }
    const m = mockFetch(tokenReply('access-4', 'refresh-4'))
    restore = m.restore
    expect(await refreshIfDue(env, NOW, noSleep)).toBe('refreshed')
    expect(m.calls).toHaveLength(1)
    expect(JSON.parse(kv.get(TOKEN_KEY)!).refreshToken).toBe('refresh-fixture')
    expect((await readToken(env))!.refreshToken).toBe('refresh-4')
    // The next cron, a day later, refreshes with the pair D1 kept, not the stale KV copy.
    const later = NOW + 23 * 3_600_000
    const m2 = mockFetch(tokenReply('access-5', 'refresh-5'))
    restore = m2.restore
    expect(await refreshIfDue(env, later, noSleep)).toBe('refreshed')
    expect(new URLSearchParams(m2.calls[0]!.body).get('refresh_token')).toBe('refresh-4')
  })

  test('when both stores refuse every write, only the write is retried, never the refresh', async () => {
    const { env, kv, kvApi } = makeEnv({ failWrites: true })
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + 3_600_000 }))
    kvApi.put = async () => {
      throw new Error('KV unavailable')
    }
    const m = mockFetch(tokenReply('access-6', 'refresh-6'))
    restore = m.restore
    expect(await refreshIfDue(env, NOW, noSleep)).toBe('failed')
    expect(m.calls).toHaveLength(1)
  })

  test('an invalid_grant answer is not retried and drops the dead token, so health says not installed', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + 3_600_000 }))
    const m = mockFetch(call => (call.url.includes('/oauth/token') ? { status: 400, json: { error: 'invalid_grant' } } : undefined))
    restore = m.restore
    expect(await refreshIfDue(env, NOW, noSleep)).toBe('dead')
    expect(m.calls).toHaveLength(1)
    expect(await readToken(env)).toBeUndefined()
    expect(await (await get(env, '/health')).json()).toEqual({ ok: true, installed: false })
  })

  test('a 400 that is not invalid_grant is retried and keeps the token', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + 3_600_000 }))
    const m = mockFetch(call => (call.url.includes('/oauth/token') ? { status: 400, json: { error: 'invalid_request' } } : undefined))
    restore = m.restore
    expect(await refreshIfDue(env, NOW, noSleep)).toBe('failed')
    expect(m.calls).toHaveLength(REFRESH_BACKOFF_MS.length)
    expect(await readToken(env)).toBeDefined()
  })

  test('a cron that cannot read one store neither refreshes nor drops the token', async () => {
    const { env, kv, kvApi, db } = makeEnv()
    // D1 still holds the pair before the last rotation; KV, which holds the live pair, cannot be read.
    db.query('INSERT INTO oauth_token (id, value, saved_at) VALUES (1, ?, ?)').run(installedToken(NOW, { refreshToken: 'rotated-away', expiresAt: NOW + 3_600_000, savedAt: NOW - 1 }), NOW - 1)
    kv.set(TOKEN_KEY, installedToken(NOW, { refreshToken: 'live', savedAt: NOW }))
    kvApi.get = async () => {
      throw new Error('KV read failed')
    }
    const m = mockFetch(call => (call.url.includes('/oauth/token') ? { status: 400, json: { error: 'invalid_grant' } } : undefined))
    restore = m.restore
    expect(await refreshIfDue(env, NOW, noSleep)).toBe('failed')
    expect(m.calls).toHaveLength(0)
    expect(JSON.parse(kv.get(TOKEN_KEY)!).refreshToken).toBe('live')
  })

  test('the later of the KV and D1 copies wins on read', async () => {
    const { env, kv, db } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { refreshToken: 'kv-old', savedAt: NOW - 1 }))
    db.query('INSERT INTO oauth_token (id, value, saved_at) VALUES (1, ?, ?)').run(installedToken(NOW, { refreshToken: 'd1-new', savedAt: NOW }), NOW)
    expect((await readToken(env))!.refreshToken).toBe('d1-new')
    kv.set(TOKEN_KEY, installedToken(NOW, { refreshToken: 'kv-newer', savedAt: NOW + 1 }))
    expect((await readToken(env))!.refreshToken).toBe('kv-newer')
  })

  test('nothing to refresh before the install', async () => {
    const { env } = makeEnv()
    expect(await refreshIfDue(env, NOW, noSleep)).toBe('not-installed')
  })
})
