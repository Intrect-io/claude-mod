import { afterEach, describe, expect, test } from 'bun:test'
import { route } from '../src/index'
import { REFRESH_WITHIN_MS, refreshIfDue, STATE_PREFIX, TOKEN_KEY } from '../src/oauth'
import { fakeCtx, gqlReply, installedToken, makeEnv, mockFetch, SECRETS } from './fakes'

const NOW = 1_795_000_000_000
let restore = () => {}
afterEach(() => restore())

const get = (env: ReturnType<typeof makeEnv>['env'], path: string) => route(new Request(`https://linear-agent.intrect.io${path}`), env, fakeCtx().ctx as never, NOW)

const tokenReply = (access = 'access-new', refresh = 'refresh-new') => (call: { url: string }) =>
  call.url === 'https://api.linear.app/oauth/token' ? { json: { access_token: access, refresh_token: refresh, expires_in: 86_399, scope: 'read write app:assignable app:mentionable', token_type: 'Bearer' } } : undefined

describe('oauth install', () => {
  test('/oauth/start redirects to Linear with actor=app, the app scopes and a stored single-use state', async () => {
    const { env, kv } = makeEnv()
    const res = await get(env, '/oauth/start')
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(to.origin + to.pathname).toBe('https://linear.app/oauth/authorize')
    expect(to.searchParams.get('actor')).toBe('app')
    expect(to.searchParams.get('scope')).toBe('read,write,app:assignable,app:mentionable')
    expect(to.searchParams.get('client_id')).toBe(SECRETS.LINEAR_CLIENT_ID)
    expect(to.searchParams.get('redirect_uri')).toBe('https://linear-agent.intrect.io/oauth/callback')
    expect(kv.has(`${STATE_PREFIX}${to.searchParams.get('state')}`)).toBe(true)
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
    expect(await refreshIfDue(env, NOW)).toBe('fresh')
    expect(m.calls).toHaveLength(0)
  })

  test('a token under 12 hours is refreshed and the rotated pair written together', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + 3_600_000 }))
    const m = mockFetch(tokenReply('access-2', 'refresh-2'))
    restore = m.restore
    expect(await refreshIfDue(env, NOW)).toBe('refreshed')
    expect(Object.fromEntries(new URLSearchParams(m.calls[0]!.body))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-fixture' })
    expect(JSON.parse(kv.get(TOKEN_KEY)!)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', appUserId: 'app-user-1', expiresAt: NOW + 86_399_000 })
  })

  test('a failed refresh is retried once and keeps the old pair', async () => {
    const { env, kv } = makeEnv()
    kv.set(TOKEN_KEY, installedToken(NOW, { expiresAt: NOW + 3_600_000 }))
    const m = mockFetch(call => (call.url.includes('/oauth/token') ? { status: 500, json: { error: 'boom' } } : undefined))
    restore = m.restore
    expect(await refreshIfDue(env, NOW)).toBe('failed')
    expect(m.calls).toHaveLength(2)
    expect(JSON.parse(kv.get(TOKEN_KEY)!).refreshToken).toBe('refresh-fixture')
  })

  test('nothing to refresh before the install', async () => {
    const { env } = makeEnv()
    expect(await refreshIfDue(env, NOW)).toBe('not-installed')
  })
})
