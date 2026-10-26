import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Bus, OFFLINE_AFTER_MS } from '../src/bus'
import { buildGrant, grantStatus, GrantRequests, readGrantFile, revoked, writeGrantFile } from '../src/grant'
import { createApp } from '../src/http'
import { allowedHosts, isOwnerPeer, routerEnv, tailnetAuth } from '../src/net'
import { Budget, digestLine, findSession, mandate } from '../src/orchestrator'
import { parseEntry, readRegistry, syncRegistry } from '../src/registry'
import { isChannel, parseHello, parsePost, repoChannel } from '../src/schema'
import { isAllowed, parseAllowed, stripMention } from '../src/slack'

let dir: string
let clock = 1_800_000_000_000
const now = () => clock

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-hub-test-'))
  clock = 1_800_000_000_000
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('schema', () => {
  test('channels', () => {
    expect(isChannel('#all')).toBe(true)
    expect(isChannel('@abc-123')).toBe(true)
    expect(isChannel('all')).toBe(false)
    expect(isChannel('#a b')).toBe(false)
    expect(repoChannel('Claude Mod')).toBe('#claude-mod')
    expect(repoChannel(null)).toBeUndefined()
  })
  test('hello needs a safe id and a cwd', () => {
    expect(parseHello({ id: 'abc', cwd: '/x' })?.name).toBe('abc')
    expect(parseHello({ id: '../x', cwd: '/x' })).toBeUndefined()
    expect(parseHello({ id: 'abc' })).toBeUndefined()
  })
  test('post', () => {
    expect(parsePost({ channel: '#all', text: 'hi' })).toEqual({ channel: '#all', text: 'hi', replyTo: undefined })
    expect(parsePost({ channel: '#all', text: '' })).toBeUndefined()
  })
})

describe('bus', () => {
  test('a DM lands in the inbox once, and ack delivers it', () => {
    const bus = new Bus(join(dir, 'f.db'), now)
    bus.hello({ id: 's1', name: 'one', cwd: '/a' })
    const msg = bus.post('@s1', { kind: 'orchestrator', id: 'fleet-hub', name: 'fleet-hub' }, 'do it')
    bus.post('#all', { kind: 'session', id: 's2', name: 'two' }, 'channel talk wakes nobody')
    expect(bus.inbox('s1').map(m => m.id)).toEqual([msg.id])
    expect(bus.ack('s1', [msg.id])).toBe(1)
    expect(bus.inbox('s1')).toEqual([])
    expect(bus.ack('s1', [msg.id])).toBe(0)
  })
  test('a session DMing itself gets no inbox row', () => {
    const bus = new Bus(join(dir, 'f.db'), now)
    bus.post('@s1', { kind: 'session', id: 's1', name: 'one' }, 'note to self')
    expect(bus.inbox('s1')).toEqual([])
  })
  test('a DM to the orchestrator leaves no inbox row', () => {
    const bus = new Bus(join(dir, 'f.db'), now)
    bus.post('@fleet-hub', { kind: 'session', id: 's1', name: 'one' }, 'PONG')
    expect(bus.db.query('SELECT COUNT(*) AS n FROM inbox').get()).toEqual({ n: 0 })
    expect(bus.read('@fleet-hub').map(m => m.text)).toEqual(['PONG'])
  })
  test('hello upserts; sweep takes silent sessions offline; touch brings them back', () => {
    const bus = new Bus(join(dir, 'f.db'), now)
    const events: string[] = []
    bus.subscribe(e => e.type === 'session' && events.push(`${e.session.id}:${e.session.state}`))
    bus.hello({ id: 's1', name: 'one', cwd: '/a' })
    bus.hello({ id: 's1', name: 'one-renamed', cwd: '/a' })
    expect(bus.sessions()).toHaveLength(1)
    expect(bus.session('s1')?.name).toBe('one-renamed')
    clock += OFFLINE_AFTER_MS + 1
    bus.sweep()
    expect(bus.session('s1')?.state).toBe('offline')
    bus.touch('s1')
    expect(bus.session('s1')?.state).toBe('idle')
    expect(events).toEqual(['s1:idle', 's1:idle', 's1:offline', 's1:idle'])
  })
  test('read returns the newest messages oldest first', () => {
    const bus = new Bus(join(dir, 'f.db'), now)
    for (let i = 0; i < 5; i++) {
      clock += 1
      bus.post('#all', { kind: 'human', id: 'h', name: 'h' }, `m${i}`)
    }
    expect(bus.read('#all', 0, 2).map(m => m.text)).toEqual(['m3', 'm4'])
  })
})

describe('grant', () => {
  test('built grants name the hub, cap at 24h and keep the forbidden list', () => {
    const g = buildGrant({ hours: 100, goal: 'g', grantedBy: 'me' }, clock)
    expect(g.orchestrator).toBe('fleet-hub')
    expect(Date.parse(g.expires_at) - Date.parse(g.issued_at)).toBe(24 * 3600_000)
    expect(g.forbidden).toContain('force push')
    expect(grantStatus(JSON.stringify(g), clock).state).toBe('valid')
    expect(grantStatus(JSON.stringify(g), clock + 25 * 3600_000).state).toBe('expired')
    expect(grantStatus(JSON.stringify({ ...g, orchestrator: 'x' }), clock).state).toBe('foreign')
    expect(grantStatus(JSON.stringify(revoked(g, clock + 1000, 'me')), clock + 2000).state).toBe('expired')
    expect(grantStatus('{', clock).state).toBe('invalid')
    expect(grantStatus(undefined, clock).state).toBe('none')
  })
  test('the file is written owner-only and the previous one kept', async () => {
    const path = join(dir, 'grant.json')
    await Bun.write(path, '{"old":true}')
    await writeGrantFile(path, buildGrant({ hours: 1, goal: 'g', grantedBy: 'me' }, clock))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readGrantFile(`${path}.prev`)).toBe('{"old":true}')
  })
  test('requests settle once', () => {
    const r = new GrantRequests()
    expect(r.add({ hours: 0, goal: 'g', reason: 'r' }, clock)).toBeUndefined()
    const req = r.add({ hours: 2, goal: 'g', reason: 'r' }, clock)!
    expect(r.settle(req.id, 'approved')?.status).toBe('approved')
    expect(r.settle(req.id, 'denied')).toBeUndefined()
  })
})

describe('http', () => {
  async function setup() {
    const bus = new Bus(join(dir, 'f.db'), now)
    const sent: string[] = []
    const app = createApp({
      bus,
      grantPath: join(dir, 'grant.json'),
      requests: new GrantRequests(),
      token: 't'.repeat(48),
      webDir: dir,
      now,
      orchestrator: { send: t => sent.push(t), status: () => ({ state: 'idle' }) },
    })
    const uds = Bun.serve({ unix: join(dir, 'hub.sock'), fetch: req => app.uds(req) })
    const tcp = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req, s) => app.tcp(req, s), websocket: app.websocket })
    const viaUds = (path: string, init?: RequestInit) =>
      fetch(`http://fleet${path}`, { ...init, unix: join(dir, 'hub.sock'), headers: { 'content-type': 'application/json' } } as RequestInit)
    const viaTcp = (path: string, init: RequestInit = {}, tok = 't'.repeat(48)) =>
      fetch(`http://127.0.0.1:${tcp.port}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-fleet-token': tok } })
    return { bus, sent, uds, tcp, viaUds, viaTcp, stop: () => (uds.stop(true), tcp.stop(true), bus.close()) }
  }

  test('a session says hello, posts as itself, and receives a DM through its inbox', async () => {
    const h = await setup()
    try {
      expect((await h.viaUds('/api/sessions/s1/post', { method: 'POST', body: JSON.stringify({ channel: '#all', text: 'x' }) })).status).toBe(409)
      expect((await h.viaUds('/api/sessions/hello', { method: 'POST', body: JSON.stringify({ id: 's1', name: 'one', cwd: '/a' }) })).ok).toBe(true)
      const posted = await (await h.viaUds('/api/sessions/s1/post', { method: 'POST', body: JSON.stringify({ channel: '#all', text: 'hello all' }) })).json()
      expect(posted.from).toEqual({ kind: 'session', id: 's1', name: 'one' })
      h.bus.post('@s1', { kind: 'orchestrator', id: 'fleet-hub', name: 'fleet-hub' }, 'please continue')
      const inbox = await (await h.viaUds('/api/inbox/s1')).json()
      expect(inbox.map((m: { text: string }) => m.text)).toEqual(['please continue'])
      await h.viaUds('/api/inbox/s1/ack', { method: 'POST', body: JSON.stringify({ ids: [inbox[0].id] }) })
      expect(await (await h.viaUds('/api/inbox/s1')).json()).toEqual([])
      expect((await h.viaUds('/api/sessions/s1/state', { method: 'POST', body: JSON.stringify({ state: 'waiting_on_user' }) })).ok).toBe(true)
      expect(h.bus.session('s1')?.state).toBe('waiting_on_user')
    } finally {
      h.stop()
    }
  })

  test('the socket cannot speak as the person, write the grant or reach the orchestrator', async () => {
    const h = await setup()
    try {
      for (const path of ['/api/human/post', '/api/grant', '/api/orchestrator']) {
        expect((await h.viaUds(path, { method: 'POST', body: JSON.stringify({ channel: '#all', text: 'x', hours: 1, goal: 'g' }) })).ok).toBe(false)
      }
      expect(await readGrantFile(join(dir, 'grant.json'))).toBeUndefined()
    } finally {
      h.stop()
    }
  })

  test('the dashboard door needs the token and the loopback host', async () => {
    const h = await setup()
    try {
      expect((await h.viaTcp('/api/sessions', {}, 'wrong')).status).toBe(401)
      expect((await h.viaTcp('/api/sessions')).ok).toBe(true)
      const rebind = await fetch(`http://127.0.0.1:${h.tcp.port}/api/sessions`, { headers: { host: 'evil.example', 'x-fleet-token': 't'.repeat(48) } })
      expect(rebind.status).toBe(403)
      expect((await h.viaTcp('/api/orchestrator', { method: 'POST', body: JSON.stringify({ text: '상태 알려줘' }) })).ok).toBe(true)
      expect(h.sent).toEqual(['상태 알려줘'])
      const grant = await (await h.viaTcp('/api/grant', { method: 'POST', body: JSON.stringify({ hours: 2, goal: 'unblock' }) })).json()
      expect(grant.orchestrator).toBe('fleet-hub')
      expect((await (await h.viaTcp('/api/grant')).json()).state).toBe('valid')
      expect((await h.viaTcp('/api/grant', { method: 'DELETE' })).ok).toBe(true)
      clock += 1000
      expect((await (await h.viaTcp('/api/grant')).json()).state).toBe('expired')
    } finally {
      h.stop()
    }
  })
})

describe('orchestrator helpers', () => {
  const s = (id: string, name: string, state = 'idle' as const) => ({ id, name, cwd: '/', state, lastSeen: 0 })
  test('findSession by id, unique prefix or name', () => {
    const list = [s('abc111', 'web'), s('abd222', 'api')]
    expect(findSession(list, 'abc111')?.name).toBe('web')
    expect(findSession(list, 'abd')?.name).toBe('api')
    expect(findSession(list, 'ab')).toBeUndefined()
    expect(findSession(list, 'web')?.id).toBe('abc111')
  })
  test('digest keeps only what to react to', () => {
    expect(digestLine({ type: 'session', session: s('a', 'web', 'waiting_on_user' as never) })).toContain('waiting on the person')
    expect(digestLine({ type: 'session', session: s('a', 'web') })).toBeUndefined()
    const msg = { id: 'm', ts: 0, channel: '@fleet-hub', from: { kind: 'session' as const, id: 'a', name: 'web' }, text: 'blocked' }
    expect(digestLine({ type: 'message', msg })).toContain('blocked')
    expect(digestLine({ type: 'message', msg: { ...msg, channel: '#all' } })).toBeUndefined()
  })
  test('budget rolls over daily', () => {
    let t = Date.parse('2026-10-26T10:00:00Z')
    const b = new Budget(1, () => t)
    b.add(0.6)
    expect(b.exhausted).toBe(false)
    b.add(0.5)
    expect(b.exhausted).toBe(true)
    t += 24 * 3600_000
    expect(b.exhausted).toBe(false)
  })
})

describe('slack', () => {
  test('only listed user ids pass', () => {
    const allowed = parseAllowed('U012ABC, bogus, W99XYZ')
    expect(allowed).toEqual(['U012ABC', 'W99XYZ'])
    expect(isAllowed('U012ABC', allowed)).toBe(true)
    expect(isAllowed('U999', allowed)).toBe(false)
    expect(isAllowed(undefined, allowed)).toBe(false)
    expect(stripMention('<@U0BOT> 상태 알려줘')).toBe('상태 알려줘')
  })
})

describe('net', () => {
  const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://100.64.0.20:3456', ANTHROPIC_AUTH_TOKEN: 'cc-rtr-x', OTHER: 'y' } })
  test('the router comes from FLEET_*, then the environment, then settings.json', () => {
    expect(routerEnv({}, settings)).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://100.64.0.20:3456', ANTHROPIC_AUTH_TOKEN: 'cc-rtr-x' }, source: 'settings.json', baseUrl: 'http://100.64.0.20:3456' })
    expect(routerEnv({ ANTHROPIC_BASE_URL: 'http://env:1' }, settings).source).toBe('environment')
    expect(routerEnv({ ANTHROPIC_BASE_URL: 'http://env:1', FLEET_ANTHROPIC_BASE_URL: 'http://fleet:2', FLEET_ANTHROPIC_AUTH_TOKEN: 't' }, settings)).toEqual({
      env: { ANTHROPIC_BASE_URL: 'http://fleet:2', ANTHROPIC_AUTH_TOKEN: 't' },
      source: 'FLEET_*',
      baseUrl: 'http://fleet:2',
    })
    expect(routerEnv({}, '{').source).toBe('none')
    expect(routerEnv({}, undefined).source).toBe('none')
  })
  test('hosts: loopback always, tailnet names when listening there', () => {
    expect([...allowedHosts(4848, undefined)]).toEqual(['127.0.0.1:4848', 'localhost:4848'])
    const hosts = allowedHosts(4848, { ip: '100.1.2.3', dnsName: 'macstudio.tail.ts.net' })
    for (const h of ['100.1.2.3:4848', 'macstudio.tail.ts.net:4848', 'macstudio:4848']) expect(hosts.has(h)).toBe(true)
    expect(hosts.has('evil.example:4848')).toBe(false)
  })
})

describe('tailnet identity', () => {
  const net = { ip: '100.64.0.10', userId: 42 }
  test('only the same user\'s other devices pass', async () => {
    const auth = tailnetAuth(net, async ip => (ip === '100.64.0.30' ? 42 : 7))
    expect(await auth('100.64.0.30')).toBe(true)
    expect(await auth('100.1.1.1')).toBe(false)
    // This node's own tailnet IP is how a local session would dial in: never the person.
    expect(await auth('100.64.0.10')).toBe(false)
    expect(await auth('127.0.0.1')).toBe(false)
    expect(await tailnetAuth(undefined, async () => 42)('100.64.0.30')).toBe(false)
    expect(isOwnerPeer('100.64.0.30', { ip: '100.64.0.10' }, 42)).toBe(false)
  })
})

describe('registry', () => {
  const entry = (o: Record<string, unknown>) => JSON.stringify({ pid: 1, sessionId: 'abc', cwd: '/Users/u/dev/STONKS', name: 'replay-engine', status: 'busy', ...o })
  test('entries become native sessions; the orchestrator and SDK children are skipped', () => {
    expect(parseEntry(entry({}))).toEqual({ pid: 1, id: 'abc', name: 'replay-engine', cwd: '/Users/u/dev/STONKS', repo: 'STONKS', state: 'busy', summary: undefined })
    expect(parseEntry(entry({ status: 'waiting', waitingFor: 'input needed' }))?.state).toBe('waiting_on_user')
    expect(parseEntry(entry({ status: 'waiting', waitingFor: 'input needed' }))?.summary).toBe('input needed')
    expect(parseEntry(entry({ name: 'fleet-hub' }))).toBeUndefined()
    expect(parseEntry(entry({ entrypoint: 'sdk-cli' }))).toBeUndefined()
    expect(parseEntry('{')).toBeUndefined()
    expect(parseEntry(entry({ sessionId: '../x' }))).toBeUndefined()
  })
  test('sync says hello on change only, and leaves fleet sessions to the mod', () => {
    const bus = new Bus(join(dir, 'f.db'), now)
    const events: string[] = []
    bus.subscribe(e => e.type === 'session' && events.push(`${e.session.id}:${e.session.state}:${e.session.via}`))
    const n = { pid: 1, id: 'abc', name: 'replay-engine', cwd: '/x', repo: 'x', state: 'busy' as const }
    syncRegistry(bus, [n])
    syncRegistry(bus, [n])
    syncRegistry(bus, [{ ...n, state: 'waiting_on_user', summary: 'input needed' }])
    syncRegistry(bus, [{ ...n, state: 'waiting_on_user' }])
    expect(events).toEqual(['abc:busy:native', 'abc:waiting_on_user:native'])
    bus.hello({ id: 'm1', name: 'mod', cwd: '/y', via: 'fleet', state: 'busy' })
    syncRegistry(bus, [{ ...n, id: 'm1', state: 'idle' }])
    expect(bus.session('m1')).toMatchObject({ state: 'busy', via: 'fleet' })
  })
  test('readRegistry keeps only live pids', async () => {
    await Bun.write(join(dir, '1.json'), entry({ pid: 1 }))
    await Bun.write(join(dir, '2.json'), entry({ pid: 2, sessionId: 'dead' }))
    const live = await readRegistry(dir, pid => pid === 1)
    expect(live.map(s => s.id)).toEqual(['abc'])
  })
})

describe('mandate', () => {
  test('issuing a grant hands the orchestrator its goal; revoking takes it back', async () => {
    const bus = new Bus(join(dir, 'f.db'), now)
    const got: Array<string | undefined> = []
    const app = createApp({
      bus,
      grantPath: join(dir, 'grant.json'),
      requests: new GrantRequests(),
      token: 'k'.repeat(48),
      webDir: dir,
      now,
      orchestrator: { send: () => {}, status: () => ({ state: 'idle' }), granted: g => got.push(g?.goal) },
    })
    const tcp = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req, s) => app.tcp(req, s), websocket: app.websocket })
    const call = (method: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${tcp.port}/api/grant`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-fleet-token': 'k'.repeat(48) } })
    try {
      await call('POST', { hours: 1, goal: 'Linear backlog' })
      await call('DELETE')
      expect(got).toEqual(['Linear backlog', undefined])
    } finally {
      tcp.stop(true)
      bus.close()
    }
    const text = mandate(buildGrant({ hours: 1, goal: 'Linear backlog', grantedBy: 'me' }, clock), 'restart')
    expect(text).toContain('Goal: Linear backlog')
    expect(text).toContain('check their state before instructing')
    expect(text).toContain('never ones waiting on the person')
  })
})
