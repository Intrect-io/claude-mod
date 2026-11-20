// The Linear agent session bridge (1.16.0): auto-claude's side of the linear-agent
// Worker. Delegated issues arrive as queue lines; the run's progress goes back to
// each issue's agent session as activities and a plan. The Worker is reached through
// curl ($ has no HTTP API). Config: ~/.claude/linear-agent.json {url, token};
// without it nothing changes.

import type { EngineInterface } from 'claude-code'

import type { AgentBridge, AutoRecord, ShipItem } from '../types'
import { activityFor, agentLine, type AgentEvent, cleanTitle, eventLines, issuesOf, type Moment, planOf, untagged } from './agent'
import { FILES, readText, run, tell } from './io'
import { appendLog, readLoop } from './loop'
import { markItem, parseQueue, type QueueItem } from './queue'


export const AGENT_CONFIG = '.claude/linear-agent.json'
export const AGENT_POLL_MS = 60_000
const CURL_TIMEOUT_S = 15

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

export type AgentReply = { ok: true; json: unknown } | { ok: false; error: string }

// One Worker call. The token goes only into curl's argv, never into a reply, a log or a message:
// any text that comes back is scrubbed of it before it is used.
export type AgentRequest = { method: 'GET' | 'POST'; path: string; body?: unknown }

export async function agentCall($: EngineInterface, cfg: AgentConfig, cwd: string, req: AgentRequest): Promise<AgentReply> {
  const { method, path, body } = req
  const argv = ['curl', '-sS', '-m', String(CURL_TIMEOUT_S), '-X', method, '-H', `authorization: Bearer ${cfg.token}`, '-w', '\n%{http_code}']
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
  // The issue's own lines, and the fix goals repairing one of its PRs (their tag sits inside the text).
  const heads = new Set(r.ships.filter(it => issuesOf(it.goal).includes(s.identifier)).map(it => it.headRef))
  const lines = parseQueue(queue).filter(i => i.mark === ' ' && (issuesOf(i.condition).includes(s.identifier) || heads.has(r.fixes[i.condition] ?? '')))
  for (const i of lines) if (i.condition !== current) queue = markItem(queue, i.condition, '!', 'stopped in Linear')
  if (lines.length > 0) await $.fs.write(FILES(r.root).queue, queue)
  const ships = r.ships.map((it): ShipItem => (issuesOf(it.goal).includes(s.identifier) && it.state !== 'merged' && it.state !== 'held' ? { ...it, state: 'held', note: 'stopped in Linear' } : it))
  const goal = lines[0]?.condition ?? r.ships.find(it => issuesOf(it.goal).includes(s.identifier))?.goal ?? s.identifier
  await appendLog($, r.root, { event: 'agent-stop', run: r.startedAt, issue: s.identifier, goal })
  await tell($, r, `Linear ${s.identifier}: stopped in its agent session; not built or shipped further`)
  const stopped = [...new Set([...(r.agent?.stopped ?? []), s.identifier])]
  r = { ...r, ships, agent: { ...(r.agent ?? { cursor: 0, sessions: {} }), stopped } }
  return (await post($, r, cfg, '/v1/activity', { sessionId: s.sessionId, content: activityFor({ kind: 'stopped', goal }) })).r
}

// A stopped issue delegated again (a new session) is live again: its stop is lifted and it gets a fresh line.
async function liftStops($: EngineInterface, r: AutoRecord, events: readonly AgentEvent[], project: string): Promise<AutoRecord> {
  const stopped = new Set(r.agent?.stopped ?? [])
  for (const e of events) {
    if (e.action !== 'created' || e.projectId !== project || typeof e.identifier !== 'string' || !stopped.has(e.identifier)) continue
    if ((r.agent?.sessions ?? {})[e.identifier] === e.sessionId) continue
    stopped.delete(e.identifier)
    await appendQueueLine($, r.root, agentLine(e.identifier, e.title ?? '', true))
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
  const named = new Set(parseQueue(queueText).flatMap(i => issuesOf(i.condition)))
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
  r = await liftStops($, r, list, project)
  const got = eventLines(list, project, state.sessions, state.cursor)
  r = { ...r, agent: { ...(r.agent ?? state), cursor: got.cursor, sessions: got.sessions } }

  let queue = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  for (const line of got.lines) {
    const id = issuesOf(parseQueue(line)[0]?.condition ?? '')[0]
    // The MCP sync may have queued the issue already.
    if (id !== undefined && queue.some(i => issuesOf(i.condition).includes(id))) continue
    await appendQueueLine($, r.root, line)
    await appendLog($, r.root, { event: 'agent-session', run: r.startedAt, issue: id, queued: true })
  }
  if (got.lines.length > 0) await tell($, r, `Linear: ${got.lines.length} delegated issue(s) queued from agent sessions`)
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
