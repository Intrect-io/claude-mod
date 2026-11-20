// The Linear agent session bridge's pure part (1.16.0), pinned by
// fixtures/linear-agent-v1 (bridge section). It imports under plain bun with no
// engine; bridge.ts does the I/O with the linear-agent Worker.

import { parseQueue } from './queue'

export type PlanEntry = { content: string; status: 'pending' | 'inProgress' | 'completed' | 'canceled' }
export type AgentEvent = {
  id: number
  action: string
  sessionId: string
  projectId?: string | null
  identifier?: string
  title?: string | null
  prompt?: string | null
  signal?: string | null
}
export type Moment = { kind: 'start' | 'held' | 'deferred' | 'diff-judge-hold' | 'awaiting-human' | 'merged' | 'stopped'; goal: string; reason?: string; pr?: string }
export type ActivityContent = { type: 'action'; action: string; parameter: string } | { type: 'elicitation' | 'response'; body: string }

const MAX_PLAN = 100
const MAX_CONTENT = 200
// An issue identifier: a team key of 1 to 10 characters, a dash and a number.
const IDENTIFIER = /^[A-Z][A-Z0-9]{0,9}-[0-9]+$/

// The Linear plan for goals.md: one entry per queue line, the mark deciding first.
export function planOf(queueText: string, currentCondition?: string): PlanEntry[] {
  const all = parseQueue(queueText).map((i): PlanEntry => {
    const collapsed = i.condition.replace(/\s+/g, ' ').trim()
    const content = collapsed.length > MAX_CONTENT ? `${collapsed.slice(0, MAX_CONTENT - 1)}…` : collapsed
    const status = i.mark === 'x' ? 'completed' : i.mark === '!' ? 'canceled' : i.condition === currentCondition ? 'inProgress' : 'pending'
    return { content, status }
  })
  // Linear takes at most 100 entries: the earliest finished ones go first.
  let over = all.length - MAX_PLAN
  const kept = all.filter(e => {
    if (over > 0 && (e.status === 'completed' || e.status === 'canceled')) {
      over--
      return false
    }
    return true
  })
  return kept.slice(0, MAX_PLAN)
}

// Untrusted text (an issue title) made into part of one queue line that parses back
// with no check: comment markers and colons are removed until none can re-form.
export function cleanTitle(text: string, max: number): string {
  let out = text.replace(/\s+/g, ' ')
  for (let prev = ''; prev !== out; ) {
    prev = out
    out = out.replace(/<!--|-->/g, ' ').replace(/:(\s*:)+/g, ':')
  }
  return out.slice(0, max).replace(/[\s:]+$/, '').trim()
}

// Leading [KEY-123] tags of a queue condition, adjacent or separated by whitespace.
export function issuesOf(condition: string): string[] {
  const m = condition.match(/^((?:\[[A-Z][A-Z0-9]{0,9}-[0-9]+\]\s*)+)/)
  return m === null ? [] : [...m[1]!.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]!)
}

export function agentLine(identifier: string, title: string): string {
  return `- [ ] [${identifier}] ${cleanTitle(title, 90)}: what Linear ${identifier} asks (delegated to auto-claude) is resolved on this branch`
}

export function eventLines(
  events: readonly AgentEvent[],
  projectId: string,
  known: Readonly<Record<string, string>>,
  since: number,
): { lines: string[]; sessions: Record<string, string>; prompts: Array<{ identifier: string; sessionId: string; text: string }>; stops: Array<{ identifier: string; sessionId: string }>; cursor: number } {
  const sessions: Record<string, string> = { ...known }
  const lines: string[] = []
  const prompts: Array<{ identifier: string; sessionId: string; text: string }> = []
  const stops: Array<{ identifier: string; sessionId: string }> = []
  let cursor = since
  for (const e of events) {
    if (typeof e.id === 'number' && e.id > cursor) cursor = e.id
    if (e.projectId !== projectId || typeof e.identifier !== 'string' || !IDENTIFIER.test(e.identifier)) continue
    if (e.action === 'created') {
      const had = sessions[e.identifier] !== undefined
      sessions[e.identifier] = e.sessionId
      if (!had) lines.push(agentLine(e.identifier, e.title ?? ''))
    } else if (e.action === 'prompted' && e.signal === 'stop') {
      stops.push({ identifier: e.identifier, sessionId: e.sessionId })
    } else if (e.action === 'prompted') {
      const text = (e.prompt ?? '').trim()
      if (text !== '') prompts.push({ identifier: e.identifier, sessionId: e.sessionId, text })
    }
  }
  return { lines, sessions, prompts, stops, cursor }
}

export function activityFor(m: Moment): ActivityContent {
  const tail = [m.reason, m.pr].filter((x): x is string => typeof x === 'string' && x !== '').join('\n\n')
  switch (m.kind) {
    case 'start':
      return { type: 'action', action: 'Building', parameter: m.goal }
    case 'merged':
      return { type: 'response', body: `Landed: ${m.goal}${m.pr !== undefined ? `\n\n${m.pr}` : ''}` }
    case 'stopped':
      return { type: 'response', body: `Stopped as asked: ${m.goal} is not built or shipped further.` }
    case 'held':
      return { type: 'elicitation', body: `Held, needs a person: ${m.goal}${tail !== '' ? `\n\n${tail}` : ''}` }
    case 'deferred':
      return { type: 'elicitation', body: `Deferred, needs a person: ${m.goal}${tail !== '' ? `\n\n${tail}` : ''}` }
    case 'diff-judge-hold':
      return { type: 'elicitation', body: `Held by the diff judge before merging: ${m.goal}${tail !== '' ? `\n\n${tail}` : ''}` }
    case 'awaiting-human':
      return { type: 'elicitation', body: `This PR changes protected files, so a person merges or closes it: ${m.goal}${tail !== '' ? `\n\n${tail}` : ''}` }
  }
}
