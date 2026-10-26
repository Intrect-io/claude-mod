import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { FleetToggles, Link } from '../types'
import type { Msg, SessionInfo, SessionState } from './wire'
import { segment } from './segment'
import { backoffMs, formatMessages, formatSessions, HEARTBEAT_MS, isChannel, POLL_MS, promptFor, registryName, repoChannel, summaryOf } from './wire'

// fleet: this session's link to fleet-hub (fleet-hub/ in this repository).
// Outbound, over the hub's Unix socket: hello, busy/idle/waiting state and a
// one-line summary for the dashboard. Inbound: DMs addressed to this session
// (from the orchestrator, the person or another session) are polled and
// submitted as a prompt, each with its §6.5 grant verdict, so they arrive
// between turns. Channel tools let the model talk IRC-style. A hub that is
// down costs a status line entry, never a word in the model's context.

const INITIAL_LINK: Link = { isOnline: false, retryAt: 0, failures: 0, channels: ['#all'], delivered: 0 }
const DEFAULT_TOGGLES: FleetToggles = { enabled: true, mirrorBodies: false }
const linkAtom = atom({ plugin: 'fleet', key: 'link' } as const, INITIAL_LINK, { shape: 'link-1' })
const togglesAtom = atom({ plugin: 'fleet', key: 'toggles' } as const, DEFAULT_TOGGLES, { shape: 'toggles-1' })
const STORE_KEY = 'toggles'

// One set of timers per loaded module; a reload starts the module over.
let timers: Timer[] = []
let polling = false
let socket = ''
let home: string | undefined

const TOOLS = [
  {
    name: 'fleet_post',
    description:
      'Post to fleet-hub: a channel (#all, #<repo>, #slack) that other sessions and the person read, or a DM (@<sessionId>, or @fleet-hub for the orchestrator). ' +
      'A DM reaches that session as a prompt between its turns; a channel message wakes nobody.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', description: '#all, #<repo>, #slack, @<sessionId> or @fleet-hub' }, text: { type: 'string' } },
      required: ['channel', 'text'],
    },
    isDeferred: false,
  },
  {
    name: 'fleet_read',
    description: "Read the newest messages of a fleet-hub channel (#all, #<repo>, #slack, #orchestrator) or of this session's DMs (@<own sessionId>).",
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string' }, limit: { type: 'number', description: 'at most 100; 20 by default' } },
      required: ['channel'],
    },
    isDeferred: false,
  },
  {
    name: 'fleet_who',
    description: 'List the sessions fleet-hub knows: name, state (idle, busy, waiting_on_user, offline), repo@branch and the DM address of each.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  },
] as const

type HubResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

async function hub<T>($: EngineInterface, path: string, body?: unknown, force = false): Promise<HubResult<T>> {
  const link = await read($, linkAtom)
  if (!force && !link.isOnline && Date.now() < link.retryAt) return { ok: false, status: 0, error: 'fleet-hub is offline' }
  try {
    const res = await $.http.fetch(`http://fleet${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      socketPath: socket,
    })
    if (!link.isOnline) await update($, linkAtom, l => ({ ...l, isOnline: true, failures: 0, retryAt: 0 }))
    if (!link.isOnline) await showStatus($)
    let parsed: unknown
    try {
      parsed = JSON.parse(res.text)
    } catch {
      parsed = undefined
    }
    if (!res.ok) return { ok: false, status: res.status, error: (parsed as { error?: string } | undefined)?.error ?? `HTTP ${res.status}` }

    return { ok: true, value: parsed as T }
  } catch {
    await update($, linkAtom, l => ({ ...l, isOnline: false, failures: l.failures + 1, retryAt: Date.now() + backoffMs(l.failures + 1) }))
    if (link.isOnline || link.failures === 0) await showStatus($)
    return { ok: false, status: 0, error: 'fleet-hub is offline' }
  }
}

// Whether this module saw the hub answer: a hub that never ran here (another
// machine) is a quiet ○, a lost one is worth a notice row.
let wasOnline = false

async function showStatus($: EngineInterface) {
  const [link, toggles] = await Promise.all([read($, linkAtom), read($, togglesAtom)])
  if (link.isOnline) wasOnline = true
  const lost = toggles.enabled && !link.isOnline && wasOnline
  await segment($, !toggles.enabled ? '' : link.isOnline ? 'fleet●' : lost ? '!fleet○' : 'fleet○')
  // The engine prefixes the plugin's name.
  $.ui.status(lost ? 'hub offline (was online)' : undefined)
}

async function hello($: EngineInterface, force = false): Promise<boolean> {
  const id = await $.session.id()
  const [cwd, repo] = await Promise.all([$.session.cwd(), $.session.repo().catch(() => null)])
  let name: string | undefined
  if (home !== undefined) {
    try {
      const dir = `${home}/.claude/sessions`
      const entries = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.json')).slice(0, 64)
      const texts = await Promise.all(entries.map(entry => $.fs.read(`${dir}/${entry.name}`).catch(() => '')))
      name = registryName(texts, id)
    } catch {
      // No registry: the hub names the session by its id.
    }
  }
  let branch: string | undefined
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 3_000 })
    if (ran.exitCode === 0) branch = ran.stdout.trim() || undefined
  } catch {
    // Not a repository.
  }
  // A repository with no remote has no name: its folder's stands in.
  const repoName = repo?.name ?? (repo ? repo.root.split('/').filter(Boolean).at(-1) : undefined)
  const result = await hub<SessionInfo>($, '/api/sessions/hello', { id, name: name ?? repoName, cwd, repo: repoName, branch }, force)
  if (!result.ok) return false
  const repoCh = repoChannel(repoName)
  await update($, linkAtom, l => ({ ...l, sessionId: id, name: result.value.name, channels: [...new Set(['#all', ...(repoCh ? [repoCh] : []), ...l.channels])] }))
  await showStatus($)

  return true
}

async function setState($: EngineInterface, state: SessionState, summary?: string) {
  const link = await read($, linkAtom)
  if (link.sessionId === undefined) return
  const result = await hub($, `/api/sessions/${link.sessionId}/state`, { state, summary })
  // The hub restarted and forgot this session: say hello again.
  if (!result.ok && result.status === 409) await hello($)
}

async function poll($: EngineInterface) {
  if (polling) return
  polling = true
  try {
    const toggles = await read($, togglesAtom)
    const link = await read($, linkAtom)
    if (!toggles.enabled) return
    if (link.sessionId === undefined) {
      if (Date.now() >= link.retryAt) await hello($)
      return
    }
    const inbox = await hub<Msg[]>($, `/api/inbox/${link.sessionId}`)
    if (!inbox.ok) {
      if (inbox.status === 409) await hello($)
      return
    }
    if (inbox.value.length === 0) return
    // At most once: acknowledged before the prompt is queued, so a reload
    // between the two never delivers a message twice.
    await hub($, `/api/inbox/${link.sessionId}/ack`, { ids: inbox.value.map(m => m.id) })
    const grantText = home === undefined ? undefined : await $.fs.read(`${home}/.claude/orchestration-grant.json`).catch(() => undefined)
    await update($, linkAtom, l => ({ ...l, delivered: l.delivered + inbox.value.length }))
    $.ui.toast(`fleet: ${inbox.value.length === 1 ? `message from ${inbox.value[0]!.from.name}` : `${inbox.value.length} messages`}`)
    // Resolves as that turn starts; the session takes it once idle.
    void $.prompt.submit({ text: promptFor(inbox.value, grantText, Date.now()) }).catch(error => $.ui.log(`fleet: submit failed: ${String(error).slice(0, 200)}`, { to: 'debug' }))
  } finally {
    polling = false
  }
}

const text = (t: string) => ({ result: t })

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    await update($, togglesAtom, () => ({ ...DEFAULT_TOGGLES, ...(typeof stored === 'object' && stored !== null ? (stored as Partial<FleetToggles>) : {}) }))
    home = await $.env.get('HOME')
    socket = typeof options.socketPath === 'string' && options.socketPath !== '' ? options.socketPath : `${home}/.claude/fleet/hub.sock`
    await $.command.register({ name: 'fleet', description: 'fleet-hub link: /fleet [status | on | off | join #ch | part #ch | mirror on|off]' })
    for (const spec of TOOLS) {
      try {
        await $.tool.register(spec)
      } catch {
        $.ui.log(`fleet: tool ${spec.name} not registered`, { to: 'debug' })
      }
    }
    for (const timer of timers) timer.cancel()
    timers = [
      $.clock.every(POLL_MS, () => void poll($).catch(error => $.ui.log(`fleet: poll failed: ${String(error).slice(0, 200)}`, { to: 'debug' }))),
      $.clock.every(HEARTBEAT_MS, () => void read($, togglesAtom).then(t => (t.enabled ? hello($) : undefined)).catch(() => {})),
    ]
    // Not awaited: a hub that is down never delays the session's start.
    void read($, togglesAtom)
      .then(async t => void (t.enabled ? await hello($, true) : await showStatus($)))
      .catch(error => $.ui.log(`fleet: hello failed: ${String(error).slice(0, 200)}`, { to: 'debug' }))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) void setState($, 'busy').catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) void setState($, 'idle', summaryOf(e.answer)).catch(() => {})
    return done
  })

  // A question up for the person: the dashboard shows the session waiting on them.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      const questions = (e as unknown as { questions?: Array<{ question?: string }> }).questions ?? []
      void setState($, 'waiting_on_user', summaryOf(questions[0]?.question ?? 'AskUserQuestion')).catch(() => {})
    }
    const answered = await next(e)
    if (e.agentId === undefined) void setState($, 'busy').catch(() => {})
    return answered
  })

  // The dashboard token lets whoever holds it speak as the person: no session reads it.
  on('tool.call', ($, e, next) => {
    const target = e.tool === 'Bash' ? (e as unknown as { command?: string }).command : e.tool === 'Read' ? (e as unknown as { file_path?: string }).file_path : undefined
    if (typeof target === 'string' && /fleet\/dashboard-token/.test(target)) {
      return { deny: 'fleet: ~/.claude/fleet/dashboard-token is the person\'s key to the fleet dashboard; a session never reads or uses it.' }
    }
    return next(e)
  })

  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    const [link, toggles] = await Promise.all([read($, linkAtom), read($, togglesAtom)])
    if (sent.isDelivered && link.sessionId !== undefined && toggles.enabled && e.agentId === undefined) {
      const line = toggles.mirrorBodies ? e.text : (e.text.split('\n')[0] ?? '').slice(0, 200)
      void hub($, `/api/sessions/${link.sessionId}/post`, { channel: `@${link.sessionId}`, text: `[SendMessage → ${e.to}] ${line}` }).catch(() => {})
    }
    return sent
  })

  on('tool.call', { tool: 'mcp__fleet__fleet_post' }, async ($, e) => {
    const input = e as unknown as { channel?: unknown; text?: unknown }
    const link = await read($, linkAtom)
    if (!isChannel(input.channel)) return text('channel must be #name or @sessionId (@fleet-hub for the orchestrator)')
    if (typeof input.text !== 'string' || input.text.trim() === '') return text('text is empty')
    if (link.sessionId === undefined && !(await hello($, true))) return text('fleet-hub is offline; nothing sent.')
    const sessionId = (await read($, linkAtom)).sessionId!
    const posted = await hub<Msg>($, `/api/sessions/${sessionId}/post`, { channel: input.channel, text: input.text }, true)

    return text(posted.ok ? `posted to ${input.channel} as ${posted.value.id}` : `not posted: ${posted.error}`)
  })

  on('tool.call', { tool: 'mcp__fleet__fleet_read' }, async ($, e) => {
    const input = e as unknown as { channel?: unknown; limit?: unknown }
    if (!isChannel(input.channel)) return text('channel must be #name or @sessionId')
    const limit = typeof input.limit === 'number' ? Math.min(Math.max(Math.floor(input.limit), 1), 100) : 20
    const msgs = await hub<Msg[]>($, `/api/messages?channel=${encodeURIComponent(input.channel)}&limit=${limit}`, undefined, true)

    return text(msgs.ok ? formatMessages(msgs.value) : `not read: ${msgs.error}`)
  })

  on('tool.call', { tool: 'mcp__fleet__fleet_who' }, async $ => {
    const sessions = await hub<SessionInfo[]>($, '/api/sessions', undefined, true)
    const link = await read($, linkAtom)

    return text(sessions.ok ? formatSessions(sessions.value, link.sessionId) : `not listed: ${sessions.error}`)
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    const [action = 'status', arg = ''] = e.args.trim().split(/\s+/).filter(w => w !== '')
    const toggles = await read($, togglesAtom)
    const save = async (next: FleetToggles) => {
      await update($, togglesAtom, () => next)
      await $.store.set(STORE_KEY, next)
      await showStatus($)
    }
    if (action === 'on' || action === 'off') {
      await save({ ...toggles, enabled: action === 'on' })
      if (action === 'on') await hello($, true)
      else await setState($, 'offline')
      return { text: `fleet ${action}` }
    }
    if (action === 'mirror' && (arg === 'on' || arg === 'off')) {
      await save({ ...toggles, mirrorBodies: arg === 'on' })
      return { text: `SendMessage bodies ${arg === 'on' ? 'mirrored in full' : 'mirrored as first lines'}` }
    }
    if ((action === 'join' || action === 'part') && isChannel(arg) && arg.startsWith('#')) {
      await update($, linkAtom, l => ({ ...l, channels: action === 'join' ? [...new Set([...l.channels, arg])] : l.channels.filter(c => c !== arg) }))
      return { text: `${action === 'join' ? 'joined' : 'left'} ${arg}` }
    }
    if (action !== 'status') return { text: 'usage: /fleet [status | on | off | join #ch | part #ch | mirror on|off]' }
    const link = await read($, linkAtom)
    const online = await hello($, true)

    return {
      text: [
        `fleet: ${toggles.enabled ? 'on' : 'off'} · hub ${online ? 'online' : 'offline'} (${socket})`,
        `session: ${link.name ?? '?'} (${link.sessionId ?? '?'})`,
        `channels: ${link.channels.join(' ')} · delivered ${link.delivered} message(s)`,
      ].join('\n'),
    }
  })

  on('session.end', async ($, e, next) => {
    for (const timer of timers) timer.cancel()
    timers = []
    await setState($, 'offline').catch(() => {})
    return next(e)
  })
}
