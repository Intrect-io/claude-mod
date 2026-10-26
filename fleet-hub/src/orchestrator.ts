import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { Bus, BusEvent } from './bus'
import type { GrantRequests } from './grant'
import type { GrantFile } from './grant'
import { grantStatus, readGrantFile } from './grant'
import type { OrchestratorPort, SlackPort } from './http'
import type { From, SessionInfo } from './schema'
import { isChannel, ORCHESTRATOR_NAME } from './schema'

// The top-level orchestrator: one long-lived Agent SDK session in the hub,
// not a Claude Code terminal session. It is isolated from the person's
// settings (no plugins, hooks or CLAUDE.md load: `settingSources: []`) and has
// no built-in tools, only the hub's: it acts on sessions by messaging them,
// and their own harness decides what a message may make them do.

export const ORCHESTRATOR_CHANNEL = '#orchestrator'
export const ORCHESTRATOR_DM = `@${ORCHESTRATOR_NAME}`

const SYSTEM_PROMPT = `You are fleet-hub, the orchestrator of the person's Claude Code sessions on this machine.
You run inside a local hub, not in a terminal. You cannot run commands or edit files; you act only through the hub tools:
- list_sessions: every session, its repo, branch, state (idle, busy, waiting_on_user, offline) and its last summary.
- read_channel: read #all, #<repo>, #slack, #orchestrator or a session's DM (@<sessionId>).
- send_to_session: message a session that runs the fleet mod (via=fleet). It arrives there as a prompt between its turns.
- SendMessage / ListAgents (native cross-session messaging): reach any session on this machine, fleet mod or not (via=native), by the name list_sessions shows. Your session is named "${ORCHESTRATOR_NAME}". For a via=native session, send_to_session tells you to use SendMessage instead. Put a clear one-line summary first: the person sees only the first line until they expand it.
Either way the session checks your message against the person's grant (~/.claude/orchestration-grant.json, CLAUDE.md §6.5): without a valid grant naming "${ORCHESTRATOR_NAME}" it treats your message as information, not as the person's instruction.
- post: write to a channel (#all reaches every session's readers, but wakes no one).
- request_grant: ask the person for a grant. You can never issue or widen one yourself; the person approves it on the dashboard or in Slack.
- slack_post: tell the person something in Slack (intrect). Use it for things they must see while away: a session waiting on them, a failure, a finished goal.
Rules: the person's sessions answer to the person first. Message a session only when the person asked you to, or when grant_status shows a valid grant naming you; a fleet digest alone is something to report to the person, not a reason to message their sessions. Never ask a session to answer an AskUserQuestion or permission prompt for the person. Never ask for anything in the grant's forbidden list. Prefer unblocking and continuing a session's existing work over starting new work. Report to the person in Korean; keep technical terms as they are. Be brief.`

// The digest of what happened in the fleet since the agent last heard: only
// what it should react to (a session waiting on the person, going offline,
// a DM addressed to the orchestrator).
export function digestLine(event: BusEvent): string | undefined {
  if (event.type === 'session') {
    const s = event.session
    if (s.state === 'waiting_on_user') return `session ${s.name} (${s.id.slice(0, 8)}, ${s.repo ?? s.cwd}) is waiting on the person${s.summary ? `: ${s.summary}` : ''}`
    if (s.state === 'offline') return `session ${s.name} (${s.id.slice(0, 8)}) went offline`
    return undefined
  }
  const m = event.msg
  if (m.channel === ORCHESTRATOR_DM && m.from.kind === 'session') return `DM from session ${m.from.name} (${m.from.id}): ${m.text}`
  return undefined
}

// What a grant asks of the orchestrator, sent to it as the person's turn when
// the person issues or approves one (and when the hub starts under a live one).
export function mandate(grant: GrantFile, reason: 'issued' | 'restart'): string {
  return [
    reason === 'issued'
      ? `The person just issued you a grant (CLAUDE.md §6.5), valid until ${grant.expires_at}.`
      : `The hub restarted under a live grant, valid until ${grant.expires_at}. Sessions may already be working on it: check their state before instructing anyone again.`,
    `Goal: ${grant.goal}`,
    `allowed: ${grant.allowed.join(' | ')}`,
    `forbidden: ${grant.forbidden.join(' | ')}`,
    'Work toward the goal now: list_sessions; message idle sessions (never busy ones mid-turn, never ones waiting on the person) with one concrete next step each, through send_to_session (via=fleet) or SendMessage (via=native); then tell the person in one short Korean summary what you asked of whom. Follow up as digests and replies arrive.',
  ].join('\n')
}

export function sessionTable(sessions: readonly SessionInfo[]): string {
  if (sessions.length === 0) return 'No sessions have said hello.'
  return sessions
    .map(s => `- ${s.id} | ${s.name} | ${s.state} | via=${s.via ?? 'fleet'} | ${s.repo ?? '-'}@${s.branch ?? '-'} | ${s.cwd}${s.summary ? ` | ${s.summary}` : ''}`)
    .join('\n')
}

// A session by id, id prefix or name; undefined when none or several match.
export function findSession(sessions: readonly SessionInfo[], key: string): SessionInfo | undefined {
  const exact = sessions.find(s => s.id === key)
  if (exact !== undefined) return exact
  const matches = sessions.filter(s => s.id.startsWith(key) || s.name === key)
  return matches.length === 1 ? matches[0] : undefined
}

export class Budget {
  private day = ''
  private spent = 0
  constructor(private limitUsd: number, private now: () => number = Date.now) {}

  private roll() {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    if (day !== this.day) {
      this.day = day
      this.spent = 0
    }
  }

  add(usd: number) {
    this.roll()
    this.spent += Math.max(usd, 0)
  }

  get exhausted(): boolean {
    this.roll()
    return this.limitUsd > 0 && this.spent >= this.limitUsd
  }

  get summary(): string {
    this.roll()
    // The SDK's list-price estimate, not a bill: through cc-router the requests
    // ride subscription accounts. The cap only stops a runaway loop.
    return `usage ≈$${this.spent.toFixed(2)} / $${this.limitUsd.toFixed(2)} today (list-price estimate, not billed)`
  }
}

// A queue the SDK reads as its streaming input.
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false

  push(text: string, origin: From) {
    this.items.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      // The dashboard and Slack are the person's own input; a session's DM is not.
      ...(origin.kind === 'human' || origin.kind === 'slack' ? { origin: { kind: 'human' } } : {}),
    } as SDKUserMessage)
    this.wake?.()
  }

  close() {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      await new Promise<void>(resolve => (this.wake = resolve))
      this.wake = undefined
    }
  }
}

export type OrchestratorOptions = {
  bus: Bus
  requests: GrantRequests
  grantPath: string
  slack?: SlackPort
  model: string
  dailyUsd: number
  digestMs: number
  cwd: string
  log: (line: string) => void
  // The router's variables (cc-router), laid over the hub's environment.
  routerEnv?: Record<string, string>
  route?: string
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

export class Orchestrator implements OrchestratorPort {
  private inbox = new Inbox()
  private q: Query | undefined
  private state = 'starting'
  private detail: string | undefined
  private sessionId: string | undefined
  private pending: string[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private budget: Budget
  private lastCost = 0
  private stopped = false
  readonly from: From = { kind: 'orchestrator', id: ORCHESTRATOR_NAME, name: ORCHESTRATOR_NAME }

  constructor(private o: OrchestratorOptions) {
    this.budget = new Budget(o.dailyUsd)
  }

  status() {
    return { state: this.state, detail: [this.detail, this.o.route, this.budget.summary].filter(Boolean).join(' · ') }
  }

  send(textIn: string, from: From) {
    if (this.budget.exhausted) {
      this.o.bus.post(ORCHESTRATOR_CHANNEL, this.from, `오늘 사용량 상한에 닿아 멈췄습니다 (${this.budget.summary}). 실제 과금이 아니라 폭주 방지용 상한입니다. FLEET_DAILY_USD로 조정할 수 있습니다.`)
      return
    }
    const label = from.kind === 'human' ? 'The person (dashboard)' : from.kind === 'slack' ? `The person (Slack ${from.name})` : `${from.kind} ${from.name}`
    this.inbox.push(`[${label}] ${textIn}`, from)
  }

  granted(grant: GrantFile | undefined, reason: 'issued' | 'restart' = 'issued') {
    const person: From = { kind: 'human', id: 'grant', name: 'user (grant)' }
    if (grant === undefined) {
      this.send('The person revoked your grant. Stop instructing sessions; messages you send are information only from now on.', person)
      return
    }
    this.send(mandate(grant, reason), person)
  }

  private tools() {
    const { bus, requests, slack } = this.o
    return createSdkMcpServer({
      name: 'hub',
      version: '0.1.0',
      tools: [
        tool('list_sessions', 'List every Claude Code session the hub knows: id, name, state, repo@branch, cwd, last summary.', {}, async () => text(sessionTable(bus.sessions())), {
          alwaysLoad: true,
        }),
        tool(
          'read_channel',
          'Read the newest messages of a channel (#all, #<repo>, #slack, #orchestrator) or a DM (@<sessionId>).',
          { channel: z.string(), limit: z.number().int().min(1).max(100).optional() },
          async ({ channel, limit }) => {
            if (!isChannel(channel)) return text('channel must be #name or @sessionId')
            const msgs = bus.read(channel, 0, limit ?? 30)
            return text(msgs.length === 0 ? '(empty)' : msgs.map(m => `${new Date(m.ts).toISOString()} <${m.from.name}> ${m.text}`).join('\n'))
          },
          { alwaysLoad: true },
        ),
        tool(
          'send_to_session',
          'Send a message to one session (by id, id prefix or name). It reaches that session as a prompt once it is idle.',
          { session: z.string(), text: z.string().min(1).max(8000) },
          async args => {
            const target = findSession(bus.sessions(), args.session)
            if (target === undefined) return text(`No single session matches "${args.session}". Call list_sessions.`)
            if (target.state === 'offline') return text(`Session ${target.name} is offline; nothing sent.`)
            if (target.via !== 'fleet') return text(`Session ${target.name} has no fleet mod. Reach it natively: SendMessage({ to: "${target.name}", message }).`)
            const msg = bus.post(`@${target.id}`, this.from, args.text)
            return text(`Queued for ${target.name} (${target.id}) as ${msg.id}; it arrives when the session is idle (now ${target.state}).`)
          },
          { alwaysLoad: true },
        ),
        tool(
          'post',
          'Post to a channel. Channel messages wake no session; sessions read them with their fleet_read tool.',
          { channel: z.string(), text: z.string().min(1).max(8000) },
          async args => {
            if (!isChannel(args.channel) || args.channel.startsWith('@')) return text('channel must be #name (use send_to_session for one session)')
            bus.post(args.channel, this.from, args.text)
            return text('posted')
          },
          { alwaysLoad: true },
        ),
        tool(
          'request_grant',
          'Ask the person to approve a grant (CLAUDE.md §6.5) so sessions treat your messages as their instruction. You cannot approve it yourself.',
          { hours: z.number().min(0.25).max(24), goal: z.string().min(1).max(500), reason: z.string().min(1).max(1000), allowed: z.array(z.string()).max(20).optional() },
          async args => {
            const request = requests.add(args, Date.now())
            if (request === undefined) return text('invalid request')
            bus.post(ORCHESTRATOR_CHANNEL, this.from, `grant request ${request.id}: ${args.hours}h — ${args.goal} (${args.reason})`)
            const summary = `${args.hours}시간 — ${args.goal}\n사유: ${args.reason}`
            await (slack?.askGrant ? slack.askGrant(request.id, summary) : slack?.notify(`fleet-hub grant 요청 ${request.id}: ${summary}\n대시보드에서 승인/거절하세요.`))?.catch(() => {})
            return text(`Request ${request.id} filed. The person approves or denies it on the dashboard or in Slack.`)
          },
          { alwaysLoad: true },
        ),
        tool(
          'grant_status',
          'Read the current grant: valid, expired, none, or one naming another orchestrator.',
          {},
          async () => {
            const status = grantStatus(await readGrantFile(this.o.grantPath), Date.now())
            return text(JSON.stringify(status))
          },
          { alwaysLoad: true },
        ),
        tool(
          'slack_post',
          'Send the person a Slack message in the intrect workspace (their fleet channel or DM).',
          { text: z.string().min(1).max(3000) },
          async args => {
            if (slack === undefined || slack.status().state !== 'connected') return text('Slack is not connected; nothing sent.')
            await slack.notify(args.text)
            bus.post('#slack', this.from, args.text)
            return text('sent')
          },
          { alwaysLoad: true },
        ),
      ],
    })
  }

  start() {
    this.stopped = false
    this.o.bus.subscribe(event => {
      if (event.type === 'message' && event.msg.channel === ORCHESTRATOR_DM && event.msg.from.kind === 'session') {
        // A session talking to the orchestrator is answered now, not at the digest.
        this.send(event.msg.text, event.msg.from)
        return
      }
      const line = digestLine(event)
      if (line !== undefined) this.pending.push(line)
    })
    this.timer = setInterval(() => this.flushDigest(), this.o.digestMs)
    void this.run()
  }

  flushDigest() {
    if (this.pending.length === 0) return
    const lines = this.pending.splice(0)
    this.send(`Fleet digest:\n${[...new Set(lines)].join('\n')}`, { kind: 'orchestrator', id: 'digest', name: 'fleet digest' })
  }

  private async run() {
    while (!this.stopped) {
      try {
        this.state = 'running'
        this.detail = undefined
        this.q = query({
          prompt: this.inbox,
          options: {
            model: this.o.model,
            cwd: this.o.cwd,
            systemPrompt: SYSTEM_PROMPT,
            settingSources: [],
            // Native cross-session messaging only; no shell, files or web.
            tools: ['ListAgents', 'SendMessage'],
            mcpServers: { hub: this.tools() },
            allowedTools: ['mcp__hub__*', 'ListAgents', 'SendMessage'],
            // The name other sessions see it by, and the one the grant names.
            extraArgs: { name: ORCHESTRATOR_NAME },
            // settingSources: [] drops the person's own crossSessionInbound: replies from
            // sessions would be held unread. Sessions answering the orchestrator is the point.
            settings: { crossSessionInbound: 'accept' },
            permissionMode: 'dontAsk',
            ...(this.o.routerEnv !== undefined && Object.keys(this.o.routerEnv).length > 0
              ? { env: { ...(process.env as Record<string, string>), ...this.o.routerEnv } }
              : {}),
            ...(this.sessionId !== undefined ? { resume: this.sessionId } : {}),
            stderr: (data: string) => this.o.log(`orchestrator stderr: ${data.trim().slice(0, 300)}`),
          },
        })
        for await (const message of this.q) this.onMessage(message)
        if (this.stopped) break
        this.state = 'restarting'
      } catch (error) {
        this.state = 'error'
        this.detail = String(error).slice(0, 300)
        this.o.log(`orchestrator: ${this.detail}`)
      }
      if (this.stopped) break
      // The inbox survives the restart; the conversation resumes by session id.
      await new Promise(r => setTimeout(r, 10_000))
    }
  }

  private onMessage(message: SDKMessage) {
    if (message.type === 'system' && 'session_id' in message && this.sessionId === undefined) this.sessionId = message.session_id
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      const said = message.message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim()
      if (said !== '') this.o.bus.post(ORCHESTRATOR_CHANNEL, this.from, said)
    }
    if (message.type === 'result') {
      const cost = 'total_cost_usd' in message && typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0
      // total_cost_usd is the query's running total: count the new part.
      this.budget.add(cost >= this.lastCost ? cost - this.lastCost : cost)
      this.lastCost = cost
      this.state = 'idle'
    }
  }

  stop() {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.inbox.close()
    this.q?.close()
  }
}
