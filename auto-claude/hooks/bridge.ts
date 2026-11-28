// The Linear agent session bridge (1.16.0): auto-claude's side of the linear-agent
// Worker. Delegated issues arrive as queue lines; the run's progress goes back to
// each issue's agent session as activities and a plan. The Worker is reached through
// curl ($ has no HTTP API). Config: ~/.claude/linear-agent.json {url, token};
// without it nothing changes.

import type { EngineInterface } from 'claude-code'

import type { AgentBridge, AutoRecord, ShipItem } from '../types'
import { activityFor, agentLine, type AgentEvent, type Candidate, cleanTitle, decomposeTargets, eventLines, type HeldInput, issueCandidates, issuesOf, type Moment, planOf, type RedInput, sha256Hex, tagLine, untagged } from './agent'
import { FILES, readText, run, tell } from './io'
import { getIssue, isOpen } from './linear'
import { appendLog, readLoop } from './loop'
import { markItem, parseQueue, type QueueItem } from './queue'


export const AGENT_CONFIG = '.claude/linear-agent.json'
export const AGENT_POLL_MS = 60_000
const CURL_TIMEOUT_S = 15
// curl reads the authorization header from a file in a directory only this user can enter, so
// the token is never in a process's argv (visible to every local user through ps).
export const AGENT_HEADER_DIR = '.claude/linear-agent.d'
export const AGENT_HEADER_FILE = 'auth.header'

export type AgentConfig = { url: string; token: string }

// Replies that become follow-up lines per issue; later ones go under ## Decisions.
export const MAX_AGENT_FOLLOW_UPS = 3

// The repository's Linear project id from ~/.claude/linear.json (the Worker stores ids, not names).
export async function projectIdOf($: EngineInterface, root: string): Promise<string | undefined> {
  const home = (await $.env.get('HOME').catch(() => undefined))?.replace(/\/$/, '')
  if (home === undefined) return undefined
  try {
    const mapping = (JSON.parse(await $.fs.read(`${home}/.claude/linear.json`)) as { repo_mapping?: Record<string, { projectId?: unknown }> }).repo_mapping
    const id = mapping?.[root.split('/').pop() ?? '']?.projectId
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

export async function readAgentConfig($: EngineInterface): Promise<AgentConfig | undefined> {
  const home = (await $.env.get('HOME').catch(() => undefined))?.replace(/\/$/, '')
  if (home === undefined) return undefined
  const text = await readText($, `${home}/${AGENT_CONFIG}`)
  if (text === undefined) return undefined
  try {
    const c = JSON.parse(text) as { url?: unknown; token?: unknown }
    return typeof c.url === 'string' && /^https?:\/\//.test(c.url) && typeof c.token === 'string' && c.token !== '' ? { url: c.url.replace(/\/$/, ''), token: c.token } : undefined
  } catch {
    return undefined
  }
}

// Why the bridge is off, one reason per input it needs (never the token or the config's text).
export const BRIDGE_OFF = {
  buildOnly: 'a build-only run does not use the bridge',
  noConfig: 'no ~/.claude/linear-agent.json',
  badConfig: '~/.claude/linear-agent.json is not {"url": "https://...", "token": "<SESSION_TOKEN>"}',
  noMapping: 'this folder maps to no project in ~/.claude/linear.json repo_mapping',
  noProjectId: 'repo_mapping.<folder> in ~/.claude/linear.json has no projectId',
  noSync: 'the Linear sync is off for this run',
} as const

export type BridgeState = { on: true; projectId: string } | { on: false; reason: string }

// Whether agentSync would poll the Worker for this run, and if not, the first input that stops it.
export async function bridgeState($: EngineInterface, r: AutoRecord): Promise<BridgeState> {
  if (r.buildOnly === true) return { on: false, reason: BRIDGE_OFF.buildOnly }
  const home = (await $.env.get('HOME').catch(() => undefined))?.replace(/\/$/, '')
  if (home === undefined || (await readText($, `${home}/${AGENT_CONFIG}`)) === undefined) return { on: false, reason: BRIDGE_OFF.noConfig }
  if ((await readAgentConfig($)) === undefined) return { on: false, reason: BRIDGE_OFF.badConfig }
  let entry: { projectId?: unknown } | undefined
  try {
    entry = (JSON.parse(await $.fs.read(`${home}/.claude/linear.json`)) as { repo_mapping?: Record<string, { projectId?: unknown }> }).repo_mapping?.[r.root.split('/').pop() ?? '']
  } catch {
    entry = undefined
  }
  if (entry === undefined || entry === null) return { on: false, reason: BRIDGE_OFF.noMapping }
  if (typeof entry.projectId !== 'string' || entry.projectId === '') return { on: false, reason: BRIDGE_OFF.noProjectId }
  if (r.linear === undefined) return { on: false, reason: BRIDGE_OFF.noSync }
  return { on: true, projectId: entry.projectId }
}

// The bridge's state, logged as one agent-bridge event and told, once per run and again only when
// it changes. Looked at no more than once a poll interval unless forced (at plan acceptance).
export async function noteBridge($: EngineInterface, r: AutoRecord, force = false): Promise<AutoRecord> {
  const now = await $.clock.now()
  if (!force && r.bridge !== undefined && now - r.bridge.at < AGENT_POLL_MS) return r
  const s = await bridgeState($, r)
  const sig = s.on ? `on:${s.projectId}` : `off:${s.reason}`
  if (r.bridge?.sig === sig) return { ...r, bridge: { ...r.bridge, at: now } }
  if (s.on) {
    await appendLog($, r.root, { event: 'agent-bridge', run: r.startedAt, on: true, projectId: s.projectId })
    await tell($, r, `Linear agent bridge on: delegated issues of project ${s.projectId} are polled from the Worker`)
  } else {
    await appendLog($, r.root, { event: 'agent-bridge', run: r.startedAt, on: false, reason: s.reason })
    await tell($, r, `Linear agent bridge off: ${s.reason}`)
  }
  return { ...r, bridge: { sig, on: s.on, ...(s.on ? { projectId: s.projectId } : { reason: s.reason }), at: now } }
}

// The status line for the bridge: off for a missing config file says nothing (most repositories).
export function bridgeStatusLine(r: AutoRecord): string | undefined {
  const b = r.bridge
  if (b === undefined || (!b.on && b.reason === BRIDGE_OFF.noConfig)) return undefined
  return b.on ? `linear agent bridge: on (project ${b.projectId})` : `linear agent bridge: off (${b.reason})`
}

export type AgentReply = { ok: true; json: unknown } | { ok: false; error: string }

// One Worker call. The token goes only into a header file curl reads (-H @file), never into an
// argv, a reply, a log or a message: any text that comes back is scrubbed of it before it is used.
export type AgentRequest = { method: 'GET' | 'POST'; path: string; body?: unknown }

// The header file for this token, written when missing or stale. The directory is made mode 700
// first by a command whose argv holds no secret, so the file is never readable by others.
async function headerFile($: EngineInterface, cfg: AgentConfig, cwd: string): Promise<string | undefined> {
  const home = (await $.env.get('HOME').catch(() => undefined))?.replace(/\/$/, '')
  if (home === undefined) return undefined
  const dir = `${home}/${AGENT_HEADER_DIR}`
  const file = `${dir}/${AGENT_HEADER_FILE}`
  const want = `authorization: Bearer ${cfg.token}\n`
  if ((await readText($, file)) === want) return file
  const made = await run($, ['sh', '-c', 'umask 077 && mkdir -p "$1" && chmod 700 "$1"', 'sh', dir], cwd, 10_000)
  if (made.exitCode !== 0) return undefined
  try {
    await $.fs.write(file, want)
  } catch {
    return undefined
  }
  return file
}

export async function agentCall($: EngineInterface, cfg: AgentConfig, cwd: string, req: AgentRequest): Promise<AgentReply> {
  const { method, path, body } = req
  const header = await headerFile($, cfg, cwd)
  if (header === undefined) return { ok: false, error: `could not write the curl header file under ~/${AGENT_HEADER_DIR}` }
  const argv = ['curl', '-sS', '-m', String(CURL_TIMEOUT_S), '-X', method, '-H', `@${header}`, '-w', '\n%{http_code}']
  if (body !== undefined) argv.push('-H', 'content-type: application/json', '--data-binary', JSON.stringify(body))
  argv.push(`${cfg.url}${path}`)
  const r = await run($, argv, cwd, (CURL_TIMEOUT_S + 5) * 1000)
  const scrub = (text: string) => text.split(cfg.token).join('***').trim().slice(0, 300)
  if (r.exitCode !== 0) return { ok: false, error: `curl exited ${r.exitCode}: ${scrub(r.stderr || r.stdout)}` }
  const at = r.stdout.lastIndexOf('\n')
  const status = Number(r.stdout.slice(at + 1).trim())
  const text = at < 0 ? '' : r.stdout.slice(0, at)
  if (!(status >= 200 && status < 300)) return { ok: false, error: `the Worker answered ${Number.isFinite(status) ? status : '?'}: ${scrub(text)}` }
  try {
    return { ok: true, json: text.trim() === '' ? {} : (JSON.parse(text) as unknown) }
  } catch {
    return { ok: false, error: `the Worker's answer is not JSON: ${scrub(text)}` }
  }
}

// ---------------------------------------------------------------- the run's side

// The sessions a goal's line names, by issue.
function sessionsOf(r: Pick<AutoRecord, 'agent'>, goal: string): Array<{ identifier: string; sessionId: string }> {
  const map = r.agent?.sessions ?? {}
  return issuesOf(goal).flatMap(identifier => (map[identifier] ? [{ identifier, sessionId: map[identifier]! }] : []))
}

export function stoppedGoal(r: Pick<AutoRecord, 'agent'>, goal: string): boolean {
  const stopped = new Set(r.agent?.stopped ?? [])
  return issuesOf(goal).some(id => stopped.has(id))
}

// Every failure of the Worker is told once, when it starts failing; a call that works clears it.
async function noteFailure($: EngineInterface, r: AutoRecord, error: string): Promise<AutoRecord> {
  if (r.agent?.error === undefined) await tell($, r, `Linear agent Worker unreachable or refusing (${error.slice(0, 160)}); retried on the next poll, the run goes on`)
  return { ...r, agent: { ...(r.agent ?? { cursor: 0, sessions: {} }), error, failedAt: await $.clock.now() } }
}

// The error stays until a whole poll goes through without a failure, so a call that keeps
// failing between successful ones is told once, not on every poll.
async function post($: EngineInterface, r: AutoRecord, cfg: AgentConfig, path: string, body: unknown): Promise<{ r: AutoRecord; ok: boolean }> {
  const reply = await agentCall($, cfg, r.root, { method: 'POST', path, body })
  return reply.ok ? { r, ok: true } : { r: await noteFailure($, r, reply.error), ok: false }
}

// A moment of the run, sent to the session of every mapped issue its line names.
export async function agentMoment($: EngineInterface, r: AutoRecord, moment: Moment): Promise<AutoRecord> {
  const targets = sessionsOf(r, moment.goal)
  if (targets.length === 0) return r
  const cfg = await readAgentConfig($)
  if (cfg === undefined) return r
  const content = activityFor(moment)
  for (const t of targets) {
    r = (await post($, r, cfg, '/v1/activity', { sessionId: t.sessionId, content })).r
    if (moment.kind === 'merged' && moment.pr !== undefined && /^https:\/\//.test(moment.pr)) {
      r = (await post($, r, cfg, '/v1/external-url', { sessionId: t.sessionId, label: `PR ${moment.pr.split('/').pop()}`, url: moment.pr })).r
    }
  }
  return r
}

async function appendQueueLine($: EngineInterface, root: string, line: string): Promise<void> {
  const queue = (await readText($, FILES(root).queue)) ?? ''
  await $.fs.write(FILES(root).queue, `${queue}${queue === '' || queue.endsWith('\n') ? '' : '\n'}${line}\n`)
}

// A line under ## Decisions in auto-plan.md (the section is added when missing).
async function appendDecision($: EngineInterface, root: string, line: string): Promise<void> {
  const plan = (await readText($, FILES(root).plan)) ?? ''
  const at = plan.search(/^## Decisions\s*$/m)
  if (at < 0) {
    await $.fs.write(FILES(root).plan, `${plan}${plan === '' || plan.endsWith('\n') ? '' : '\n'}\n## Decisions\n\n${line}\n`)
    return
  }
  const after = plan.slice(at)
  const next = after.slice(1).search(/^## /m)
  const end = next < 0 ? plan.length : at + 1 + next
  const head = plan.slice(0, end).replace(/\s*$/, '\n')
  await $.fs.write(FILES(root).plan, `${head}${line}\n${end < plan.length ? `\n${plan.slice(end)}` : ''}`)
}

// The person's reply in a session: a follow-up line for an issue with an open line (built on its
// branch when it has one), else a line under ## Decisions.
async function applyPrompt($: EngineInterface, r: AutoRecord, queue: QueueItem[], p: { identifier: string; text: string }): Promise<'line' | 'decision'> {
  const text = cleanTitle(untagged(p.text), 300)
  // Open: a line still to build. A stopped issue's [!] line is not open, and the follow-ups are capped.
  const open = queue.filter(i => i.mark === ' ' && issuesOf(i.condition).includes(p.identifier))
  const stopped = (r.agent?.stopped ?? []).includes(p.identifier)
  if (open.length === 0 || stopped || (r.agent?.followUps?.[p.identifier] ?? 0) >= MAX_AGENT_FOLLOW_UPS) {
    await appendDecision($, r.root, `- **Linear ${p.identifier} (agent session).** The person wrote: ${text}`)
    return 'decision'
  }
  // Built on the issue's branch while its milestone has one (shipping or held), else from the default branch.
  const branch = [...r.ships].reverse().find(s => s.state !== 'merged' && issuesOf(s.goal).includes(p.identifier))?.branch
  await appendQueueLine($, r.root, `- [ ] [${p.identifier}] what the person asked in the Linear session is done: ${text}${branch !== undefined ? ` :: base: ${branch}` : ''}`)
  return 'line'
}

// A stop: a pending line is marked [!]; a milestone already built or shipping is held at the
// driver's next step; the session gets the final response.
async function applyStop($: EngineInterface, r: AutoRecord, cfg: AgentConfig, s: { identifier: string; sessionId: string }): Promise<AutoRecord> {
  let queue = (await readText($, FILES(r.root).queue)) ?? ''
  const current = (await readLoop($, r.root).catch(() => undefined))?.current?.condition
  // The issue and the sub-issues it was split into.
  const ids = new Set([s.identifier, ...Object.entries(r.agent?.subOf ?? {}).filter(([, p]) => p === s.identifier).map(([sub]) => sub)])
  const ofIssue = (goal: string) => issuesOf(goal).some(id => ids.has(id))
  // Their own lines, and the fix goals repairing one of their PRs (the tag sits inside the text).
  const heads = new Set(r.ships.filter(it => ofIssue(it.goal)).map(it => it.headRef))
  const lines = parseQueue(queue).filter(i => i.mark === ' ' && (ofIssue(i.condition) || heads.has(r.fixes[i.condition] ?? '')))
  for (const i of lines) if (i.condition !== current) queue = markItem(queue, i.condition, '!', 'stopped in Linear')
  if (lines.length > 0) await $.fs.write(FILES(r.root).queue, queue)
  const ships = r.ships.map((it): ShipItem => (ofIssue(it.goal) && it.state !== 'merged' && it.state !== 'held' ? { ...it, state: 'held', note: 'stopped in Linear' } : it))
  const goal = lines[0]?.condition ?? r.ships.find(it => ofIssue(it.goal))?.goal ?? s.identifier
  await appendLog($, r.root, { event: 'agent-stop', run: r.startedAt, issue: s.identifier, goal })
  await tell($, r, `Linear ${s.identifier}: stopped in its agent session; not built or shipped further`)
  const stopped = [...new Set([...(r.agent?.stopped ?? []), ...ids])]
  r = { ...r, ships, agent: { ...(r.agent ?? { cursor: 0, sessions: {} }), stopped } }
  return (await post($, r, cfg, '/v1/activity', { sessionId: s.sessionId, content: activityFor({ kind: 'stopped', goal }) })).r
}

// An issue delegated again (a new, non-empty session id) is live again: a stop on it is lifted, and
// it gets a fresh line unless one is still open. A sub-issue the run registered ('') is only mapped.
async function redelegations($: EngineInterface, r: AutoRecord, events: readonly AgentEvent[], project: string): Promise<AutoRecord> {
  const stopped = new Set(r.agent?.stopped ?? [])
  const known = r.agent?.sessions ?? {}
  const open = new Set(parseQueue((await readText($, FILES(r.root).queue)) ?? '').filter(i => i.mark === ' ').flatMap(i => issuesOf(i.condition)))
  for (const e of events) {
    if (e.action !== 'created' || e.projectId !== project || typeof e.identifier !== 'string') continue
    const before = known[e.identifier]
    if (before === undefined || before === '' || before === e.sessionId) continue
    stopped.delete(e.identifier)
    if (open.has(e.identifier)) continue
    await appendQueueLine($, r.root, agentLine(e.identifier, e.title ?? '', true))
    open.add(e.identifier)
    await appendLog($, r.root, { event: 'agent-session', run: r.startedAt, issue: e.identifier, queued: true, again: true })
  }
  return { ...r, agent: { ...(r.agent ?? { cursor: 0, sessions: {} }), stopped: [...stopped] } }
}

// A pending line of a stopped issue (queued later, by the MCP sync for one) is marked, never built.
async function holdStopped($: EngineInterface, r: AutoRecord): Promise<void> {
  const stopped = new Set(r.agent?.stopped ?? [])
  if (stopped.size === 0) return
  const current = (await readLoop($, r.root).catch(() => undefined))?.current?.condition
  let queue = (await readText($, FILES(r.root).queue)) ?? ''
  const lines = parseQueue(queue).filter(i => i.mark === ' ' && i.condition !== current && issuesOf(i.condition).some(id => stopped.has(id)))
  for (const i of lines) queue = markItem(queue, i.condition, '!', 'stopped in Linear')
  if (lines.length > 0) await $.fs.write(FILES(r.root).queue, queue)
}

// The plan of every mapped session whose issue still has a line, replaced whole when goals.md changed.
// Each session gets the plan when it is new to the session; a failed send is tried on the next poll.
async function syncPlans($: EngineInterface, r: AutoRecord, cfg: AgentConfig, queueText: string): Promise<AutoRecord> {
  const current = (await readLoop($, r.root).catch(() => undefined))?.current?.condition
  const plan = planOf(queueText, current)
  const sig = JSON.stringify(plan)
  const named = new Set([...parseQueue(queueText).flatMap(i => issuesOf(i.condition)), ...(r.agent?.parents ?? [])])
  const sigs: Record<string, string> = { ...r.agent?.planSigs }
  for (const [id, sessionId] of Object.entries(r.agent?.sessions ?? {})) {
    if (sessionId === '' || !named.has(id) || sigs[sessionId] === sig) continue
    const sent = await post($, r, cfg, '/v1/plan', { sessionId, plan: plan.length === 0 ? null : plan })
    r = sent.r
    if (sent.ok) sigs[sessionId] = sig
  }
  return { ...r, agent: { ...(r.agent ?? { cursor: 0, sessions: {} }), planSigs: sigs } }
}

// One poll: new sessions become queue lines, replies and stops are applied, plans are refreshed.
export async function agentSync($: EngineInterface, r: AutoRecord, now: number): Promise<AutoRecord> {
  r = await noteBridge($, r)
  if (r.buildOnly === true || r.linear === undefined) return r
  const cfg = await readAgentConfig($)
  if (cfg === undefined) return r
  if (r.agent?.polledAt !== undefined && now - r.agent.polledAt < AGENT_POLL_MS) return r
  const state: AgentBridge = { cursor: 0, sessions: {}, ...r.agent, polledAt: now }
  r = { ...r, agent: state }
  const project = await projectIdOf($, r.root)
  if (project === undefined) return noteFailure($, r, 'the repository maps to a Linear project by name only; the bridge needs repo_mapping.<folder>.projectId in ~/.claude/linear.json')
  const reply = await agentCall($, cfg, r.root, { method: 'GET', path: `/v1/events?since=${state.cursor}&project=${encodeURIComponent(project)}` })
  if (!reply.ok) return noteFailure($, r, reply.error)
  const events = ((reply.json as { events?: unknown }).events ?? []) as AgentEvent[]
  const list = Array.isArray(events) ? events : []
  r = await redelegations($, r, list, project)
  const got = eventLines(list, project, state.sessions, state.cursor)
  r = { ...r, agent: { ...(r.agent ?? state), cursor: got.cursor, sessions: got.sessions } }
  // On the queue the planner wrote, before this poll adds lines of its own.
  r = await decompose($, r, cfg)
  r = await askSpecAmbiguous($, r)

  let queue = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  // Issues the accepted plan deferred as spec-ambiguous are asked in their session, not built:
  // a line for one only made the builder defer it again (1.19.2). A reply still reaches it
  // through applyPrompt below.
  const deferred = new Set(specAmbiguous((await readText($, FILES(r.root).plan)) ?? '').map(d => d.identifier))
  let queued = 0
  for (const line of got.lines) {
    const id = issuesOf(parseQueue(line)[0]?.condition ?? '')[0]
    // The MCP sync may have queued the issue already, or the run split it into sub-issues.
    if (id !== undefined && (queue.some(i => issuesOf(i.condition).includes(id)) || (r.agent?.parents ?? []).includes(id))) continue
    if (id !== undefined && deferred.has(id)) {
      await appendLog($, r.root, { event: 'agent-session', run: r.startedAt, issue: id, queued: false, reason: 'spec-ambiguous' })
      continue
    }
    const open = id === undefined ? true : await delegationOpen($, id)
    if (open === false) {
      await appendLog($, r.root, { event: 'agent-session', run: r.startedAt, issue: id, queued: false, reason: 'closed' })
      continue
    }
    await appendQueueLine($, r.root, line)
    await appendLog($, r.root, { event: 'agent-session', run: r.startedAt, issue: id, queued: true, ...(typeof open === 'string' ? { error: open } : {}) })
    queued++
  }
  if (queued > 0) await tell($, r, `Linear: ${queued} delegated issue(s) queued from agent sessions`)
  queue = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  for (const p of got.prompts) {
    const as = await applyPrompt($, r, queue, p)
    if (as === 'line') r = { ...r, agent: { ...r.agent!, followUps: { ...r.agent!.followUps, [p.identifier]: (r.agent!.followUps?.[p.identifier] ?? 0) + 1 } } }
    await appendLog($, r.root, { event: 'agent-prompt', run: r.startedAt, issue: p.identifier, as })
  }
  for (const s of got.stops) r = await applyStop($, r, cfg, s)
  await holdStopped($, r)
  r = await syncPlans($, r, cfg, (await readText($, FILES(r.root).queue)) ?? '')
  // A poll with no failure clears the error, so the next failure is told again.
  return (r.agent?.failedAt ?? 0) >= now || r.agent?.error === undefined ? r : { ...r, agent: { ...r.agent, error: undefined } }
}

// ---------------------------------------------------------------- autonomy (1.17.0)

let maxIssuesPerDay = 3
export function setMaxIssuesPerDay(n: number): void {
  maxIssuesPerDay = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3
}

const DAY_MS = 24 * 3_600_000
export const TRIAGE_EVERY_MS = 10 * 60_000

// The repository's Linear mapping the bridge files issues under.
async function mappingOf($: EngineInterface, root: string): Promise<{ projectId: string; team: string } | undefined> {
  const home = (await $.env.get('HOME').catch(() => undefined))?.replace(/\/$/, '')
  if (home === undefined) return undefined
  try {
    const entry = (JSON.parse(await $.fs.read(`${home}/.claude/linear.json`)) as { repo_mapping?: Record<string, { projectId?: unknown; team?: unknown }> }).repo_mapping?.[root.split('/').pop() ?? '']
    return typeof entry?.projectId === 'string' && typeof entry.team === 'string' ? { projectId: entry.projectId, team: entry.team } : undefined
  } catch {
    return undefined
  }
}

const recent = (times: readonly number[] | undefined, now: number) => (times ?? []).filter(t => now - t < DAY_MS)

type Created = { id: string; identifier: string; url?: string; triaged?: boolean }
const STOPPED_NOTE = 'stopped in Linear'

async function createIssue($: EngineInterface, r: AutoRecord, cfg: AgentConfig, body: Record<string, unknown>): Promise<{ r: AutoRecord; created?: Created }> {
  const reply = await agentCall($, cfg, r.root, { method: 'POST', path: '/v1/issue', body })
  if (!reply.ok) return { r: await noteFailure($, r, reply.error) }
  const c = reply.json as { id?: unknown; identifier?: unknown; url?: unknown; triaged?: unknown }
  if (typeof c.identifier !== 'string' || typeof c.id !== 'string') return { r: await noteFailure($, r, 'the Worker created an issue but sent no identifier') }
  const now = await $.clock.now()
  r = { ...r, agent: { ...(r.agent ?? { cursor: 0, sessions: {} }), issueTimes: [...recent(r.agent?.issueTimes, now), now] } }
  return { r, created: { id: c.id, identifier: c.identifier, ...(typeof c.url === 'string' ? { url: c.url } : {}), ...(typeof c.triaged === 'boolean' ? { triaged: c.triaged } : {}) } }
}

// The one delegated issue an accepted plan belongs to: the only mapped session issue its open lines name.
function sessionIssueOf(r: AutoRecord, queueText: string): string | undefined {
  const sessions = r.agent?.sessions ?? {}
  const named = new Set(parseQueue(queueText).filter(i => i.mark === ' ').flatMap(i => issuesOf(i.condition)).filter(id => (sessions[id] ?? '') !== ''))
  return named.size === 1 ? [...named][0] : undefined
}

// Whether a delegated issue is still open, read through the MCP before its line is queued: a stale
// `created` event for an issue already done (AGT-4924, 2026-11-22) became a line with nothing to
// build (1.19.2). A failed or empty read is the error text: the caller queues it anyway (fail open),
// because losing a delegation is worse than a line that finds nothing to do.
async function delegationOpen($: EngineInterface, id: string): Promise<boolean | string> {
  try {
    const issue = await getIssue($, id)
    return issue === undefined ? 'get_issue returned no issue' : isOpen(issue)
  } catch (error) {
    return String(error).slice(0, 160)
  }
}

// `- **Deferred (spec-ambiguous).** [AGT-12] <what is unclear>` lines the planner wrote under ## Decisions.
export function specAmbiguous(plan: string): Array<{ identifier: string; text: string }> {
  return [...plan.matchAll(/^\s*-\s*\*\*Deferred \(spec-ambiguous\)\.\*\*\s*\[([A-Z][A-Z0-9]{0,9}-[0-9]+)\]\s*(.*)$/gm)].map(m => ({ identifier: m[1]!, text: m[2]!.trim() }))
}

// What a new run keeps of the last run's bridge: the cursor, the sessions and what was decided about
// them; not the per-run timers and errors.
export function carryAgent(a: AgentBridge | undefined): { agent?: AgentBridge } {
  if (a === undefined) return {}
  // Per-run state stays behind: timers, errors, splits and plans belong to the run that made them.
  const { polledAt: _p, error: _e, failedAt: _f, decomposedFor: _d, triageAt: _t, parents: _pa, planSigs: _ps, subOf: _so, followUps: _fu, decomposePending: _dp, ...kept } = a
  return { agent: kept }
}

export const SPEC_AMBIGUOUS_HINT =
  'Issues delegated to auto-claude in Linear come with an agent session. A milestone you cannot give a deterministic check (the spec leaves the end state open, or contradicts itself) is not planned: write it under ## Decisions as `- **Deferred (spec-ambiguous).** [AGT-12] <what is unclear>`, and auto-claude asks the person in that issue\'s session (category spec-ambiguous) instead of guessing.'

// Once a plan is accepted: a delegated issue with 2 or more milestones is split into sub-issues,
// one per line (delegated to the app, registered before their own sessions arrive), and the
// planner's spec-ambiguous deferrals are asked in their sessions.
// Called when a plan is accepted: only a run's first plan is split, and only the lines it held then.
export function markPlanAccepted(r: AutoRecord, pending: readonly string[]): AutoRecord {
  if (r.buildOnly === true || r.round !== 1) return r
  return { ...r, agent: { cursor: 0, sessions: {}, ...r.agent, decomposePending: { key: `${r.startedAt}:${r.round}`, lines: [...pending] } } }
}

// Open lines tagged with nothing or only with the parent, by condition (a retry has no 2-line minimum).
function splitLines(queueText: string, parent: string): string[] {
  return parseQueue(queueText).filter(i => i.mark === ' ' && issuesOf(i.condition).every(id => id === parent)).map(i => i.condition)
}

// A delegated issue's plan split into sub-issues, one per line: the run's first accepted plan only,
// only lines that plan held, never one already being built or shipped, a fix goal or a CI/GitHub line.
// Each sub-issue is delegated to the app and registered before its own session arrives; a failure
// leaves the rest for the next poll.
async function decompose($: EngineInterface, r: AutoRecord, cfg: AgentConfig): Promise<AutoRecord> {
  const pend = r.agent?.decomposePending
  if (pend === undefined || r.phase !== 'run') return r
  const done = (x: AutoRecord): AutoRecord => {
    const { decomposePending: _p, ...rest } = x.agent!
    return { ...x, agent: { ...rest, decomposedFor: pend.key } }
  }
  const queue0 = (await readText($, FILES(r.root).queue)) ?? ''
  const planned = new Set(pend.lines)
  const parent = pend.parent ?? sessionIssueOf(r, parseQueue(queue0).filter(i => planned.has(i.condition)).map(i => `- [ ] ${i.condition}`).join('\n'))
  if (parent === undefined) return done(r)
  const current = (await readLoop($, r.root).catch(() => undefined))?.current?.condition
  const busy = new Set([...r.ships.map(s => s.goal), ...(current !== undefined ? [current] : [])])
  const eligible = (c: string) => planned.has(c) && !busy.has(c) && r.fixes[c] === undefined && !/^\[(ci:|gh#)/.test(c)
  const conditions = pend.parent === undefined ? decomposeTargets(queue0, parent).map(t => parseQueue(queue0).find(i => i.line === t.line)!.condition) : splitLines(queue0, parent)
  const targets = conditions.filter(eligible)
  if (targets.length === 0) return done(r)
  const mapping = await mappingOf($, r.root)
  if (mapping === undefined) return done(await noteFailure($, r, 'decomposing needs repo_mapping.<folder>.projectId and team in ~/.claude/linear.json'))
  r = { ...r, agent: { ...r.agent!, decomposePending: { ...pend, parent } } }
  const now = await $.clock.now()
  let room = maxIssuesPerDay - recent(r.agent?.issueTimes, now).length
  let made = 0
  for (const condition of targets) {
    const title = condition.replace(/^((?:\[[A-Z][A-Z0-9]{0,9}-[0-9]+\]\s*)+)/, '').slice(0, 80)
    if (room <= 0) {
      await appendLog($, r.root, { event: 'agent-issue', run: r.startedAt, kind: 'sub', parent, skipped: 'maxIssuesPerDay', title })
      continue
    }
    const got = await createIssue($, r, cfg, { team: mapping.team, title: untagged(title), parentId: parent, projectId: mapping.projectId, delegate: true, description: `Milestone of ${parent}, planned by auto-claude:\n\n${untagged(title)}` })
    r = got.r
    // Left pending with its parent: the next poll splits the lines still untagged.
    if (got.created === undefined) return r
    room--
    made++
    const id = got.created.identifier
    // Registered before its own created event arrives (no second line), and covered for the MCP sync.
    r = { ...r, agent: { ...r.agent!, sessions: { ...r.agent!.sessions, [id]: '' }, subOf: { ...r.agent!.subOf, [id]: parent }, parents: [...new Set([...(r.agent?.parents ?? []), parent])] } }
    if (r.linear !== undefined) r = { ...r, linear: { ...r.linear, seen: { ...r.linear.seen, [id]: COVERED_FOREVER } } }
    // Re-read: the loop may have marked a line meanwhile; the line is found again by its condition.
    const now2 = (await readText($, FILES(r.root).queue)) ?? ''
    const at = parseQueue(now2).find(i => i.mark === ' ' && i.condition === condition)
    if (at !== undefined) await $.fs.write(FILES(r.root).queue, tagLine(now2, at.line, id))
    await appendLog($, r.root, { event: 'agent-issue', run: r.startedAt, kind: 'sub', parent, identifier: id, title })
  }
  if (made > 0) {
    await tell($, r, `Linear ${parent}: split into ${made} sub-issue(s), one per milestone`)
    // The parent session's plan is replaced on this poll.
    const parentSession = r.agent?.sessions[parent]
    if (parentSession !== undefined) {
      const { [parentSession]: _old, ...sigs } = r.agent?.planSigs ?? {}
      r = { ...r, agent: { ...r.agent!, planSigs: sigs } }
    }
  }
  return done(r)
}

// A stamp later than any Linear change: an issue the run created itself is never queued by the MCP sync.
export const COVERED_FOREVER = '9999-12-31T00:00:00.000Z'

// Each spec-ambiguous deferral the planner wrote is asked once in its issue's session.
async function askSpecAmbiguous($: EngineInterface, r: AutoRecord): Promise<AutoRecord> {
  if (r.phase !== 'run') return r
  for (const d of specAmbiguous((await readText($, FILES(r.root).plan)) ?? '')) {
    const key = sha256Hex(`${d.identifier}\n${d.text}`).slice(0, 16)
    if ((r.agent?.asked ?? []).includes(key) || (r.agent?.sessions[d.identifier] ?? '') === '') continue
    r = await agentMoment($, r, { kind: 'deferred', goal: `[${d.identifier}] ${d.text}`, reason: 'spec-ambiguous: the spec gives no deterministic end state, so this was not planned. Please say what done means.' })
    r = { ...r, agent: { ...r.agent!, asked: [...(r.agent?.asked ?? []), key] } }
  }
  return r
}

// Standby GitHub poll: which default-branch workflows are red now, counted over consecutive polls.
export function noteCiRed(r: AutoRecord, events: ReadonlyArray<{ id: string; stamp: string; workflow?: string; runId?: number }>, slug: string | undefined): AutoRecord {
  const before = r.agent?.ciRed ?? {}
  const next: Record<string, { polls: number; sha: string; link?: string }> = {}
  for (const e of events) {
    if (!e.id.startsWith('ci:') || e.workflow === undefined || next[e.workflow] !== undefined) continue
    const link = slug !== undefined && e.runId !== undefined ? `https://github.com/${slug}/actions/runs/${e.runId}` : undefined
    next[e.workflow] = { polls: (before[e.workflow]?.polls ?? 0) + 1, sha: e.stamp, ...(link !== undefined ? { link } : {}) }
  }
  return { ...r, agent: { ...(r.agent ?? { cursor: 0, sessions: {} }), ciRed: next } }
}

function triageBody(c: Candidate): string {
  return [
    c.kind === 'held' ? 'auto-claude held this milestone; it needs a person before it can go on.' : 'The default branch has been red on consecutive polls.',
    '',
    // Untrusted text: a marker inside it must not count as this issue's fingerprint.
    c.reason !== undefined ? `Reason: ${untagged(c.reason).replace(/auto-claude:fp=/g, 'auto-claude: fp =').slice(0, 2_000)}` : '',
    c.link !== undefined ? `Link: ${c.link}` : '',
    '',
    'Delegate this issue to auto-claude once it is unblocked.',
    '',
    '---',
    c.fingerprint,
  ]
    .filter((line, i, all) => line !== '' || (all[i - 1] ?? '') !== '')
    .join('\n')
}

// In standby: Triage issues for held or deferred milestones whose line names no issue, and for
// workflows red on 2 or more polls; never twice (fingerprints), within maxIssuesPerDay, not delegated.
export async function fileTriage($: EngineInterface, r: AutoRecord, now: number, prLinkOf: (pr: number) => string | undefined): Promise<AutoRecord> {
  if (r.buildOnly === true || r.linear === undefined) return r
  if (r.agent?.triageAt !== undefined && now - r.agent.triageAt < TRIAGE_EVERY_MS) return r
  const cfg = await readAgentConfig($)
  const mapping = cfg === undefined ? undefined : await mappingOf($, r.root)
  if (cfg === undefined || mapping === undefined) return r
  r = { ...r, agent: { ...(r.agent ?? { cursor: 0, sessions: {} }), triageAt: now } }
  const queue = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  const held: HeldInput[] = [
    // Fix goals count under their PR's milestone, and what a person stopped is not reopened.
    ...queue.filter(i => i.mark === '!' && r.fixes[i.condition] === undefined && !(i.note ?? '').includes(STOPPED_NOTE)).map(i => ({ goal: i.condition, reason: i.note ?? 'held', issues: issuesOf(i.condition) })),
    ...r.ships.filter(s => s.state === 'held' && s.note !== STOPPED_NOTE).map(s => ({ goal: s.goal, reason: s.note ?? 'held', issues: issuesOf(s.goal), ...(s.pr !== undefined && prLinkOf(s.pr) !== undefined ? { link: prLinkOf(s.pr)! } : {}) })),
  ]
  const ciRed: RedInput[] = Object.entries(r.agent?.ciRed ?? {}).map(([workflow, v]) => ({ workflow, ...v }))
  const createdToday = recent(r.agent?.issueTimes, now).length
  if (createdToday >= maxIssuesPerDay || (held.every(h => h.issues.length > 0) && ciRed.every(c => c.polls < 2))) return r
  const fp = await agentCall($, cfg, r.root, { method: 'GET', path: `/v1/fingerprints?project=${encodeURIComponent(mapping.projectId)}` })
  if (!fp.ok) return noteFailure($, r, fp.error)
  const existing = ((fp.json as { fingerprints?: unknown }).fingerprints ?? []) as string[]
  for (const c of issueCandidates({ held, ciRed, existing: Array.isArray(existing) ? existing : [], createdToday, cap: maxIssuesPerDay })) {
    const got = await createIssue($, r, cfg, { team: mapping.team, title: untagged(c.title), description: triageBody(c), projectId: mapping.projectId, triage: true })
    r = got.r
    if (got.created === undefined) break
    const id = got.created.identifier
    // The run's own MCP sync must not queue it as work: it is for a person.
    if (r.linear !== undefined) r = { ...r, linear: { ...r.linear, seen: { ...r.linear.seen, [id]: COVERED_FOREVER } } }
    const triaged = got.created.triaged !== false
    await appendLog($, r.root, { event: 'agent-issue', run: r.startedAt, kind: 'triage', source: c.kind, identifier: id, fingerprint: c.fingerprint, triaged })
    await tell($, r, `Linear: filed ${id} ${triaged ? 'in Triage' : "in the team's default state (the team has no triage)"} (${c.title.slice(0, 80)})`)
  }
  return r
}
