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

// Brackets in untrusted text become parentheses, so a title such as "[ABC-9] x" can never add
// another issue's tag to the line (the run would then move and comment on that issue).
export function untagged(text: string): string {
  return text.replace(/\[/g, '(').replace(/\]/g, ')')
}

export function agentLine(identifier: string, title: string, again = false): string {
  return `- [ ] [${identifier}] ${cleanTitle(untagged(title), 90)}: what Linear ${identifier} asks (delegated to auto-claude${again ? ' again' : ''}) is resolved on this branch`
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

// ---------------------------------------------------------------- autonomy (1.17.0)

// SHA-256 of a UTF-8 string, in plain JS: the hooks import no node builtins.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const bitLen = bytes.length * 8
  const total = Math.ceil((bytes.length + 9) / 64) * 64
  const msg = new Uint8Array(total)
  msg.set(bytes)
  msg[bytes.length] = 0x80
  const view = new DataView(msg.buffer)
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(total - 4, bitLen >>> 0)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      ;[hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0]
    }
    const add = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + add[i]!) >>> 0
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('')
}

// The marker a Triage issue carries in its description, so it is never filed twice.
export function fingerprint(kind: string, key: string): string {
  return `auto-claude:fp=${kind}:${sha256Hex(key).slice(0, 12)}`
}

export type HeldInput = { goal: string; reason: string; issues: string[]; link?: string }
export type RedInput = { workflow: string; sha: string; polls: number; link?: string }
export type Candidate = { kind: 'held' | 'ci-red'; key: string; fingerprint: string; title: string; reason?: string; link?: string }

const MAX_TITLE = 100

// What to file as Triage issues: held milestones whose line names no issue, then workflows red
// on 2 or more polls; already filed (existing) or repeated ones skipped; within the day's room.
export function issueCandidates(input: { held: readonly HeldInput[]; ciRed: readonly RedInput[]; existing: readonly string[]; createdToday: number; cap: number }): Candidate[] {
  const seen = new Set(input.existing)
  const room = Math.max(0, input.cap - input.createdToday)
  const out: Candidate[] = []
  const add = (c: Omit<Candidate, 'fingerprint'>) => {
    const fp = fingerprint(c.kind, c.key)
    if (seen.has(fp) || out.length >= room) return
    seen.add(fp)
    out.push({ ...c, fingerprint: fp })
  }
  for (const h of input.held) {
    if (h.issues.length > 0) continue
    add({ kind: 'held', key: h.goal, title: `Held: ${h.goal}`.slice(0, MAX_TITLE), reason: h.reason, ...(h.link !== undefined ? { link: h.link } : {}) })
  }
  for (const c of input.ciRed) {
    if (c.polls < 2) continue
    add({ kind: 'ci-red', key: c.workflow, title: `CI red on the default branch: ${c.workflow}`.slice(0, MAX_TITLE), reason: `red at ${c.sha.slice(0, 12)} on ${c.polls} polls in a row`, ...(c.link !== undefined ? { link: c.link } : {}) })
  }
  return out
}

const LEADING_TAGS = /^((?:\[[A-Z][A-Z0-9]{0,9}-[0-9]+\]\s*)+)/
const MAX_SUB_TITLE = 80

// The open lines a delegated issue splits into: untagged, or tagged only with the session's issue.
// Fewer than 2 means nothing to split.
export function decomposeTargets(queueText: string, sessionIdentifier: string): Array<{ line: number; title: string }> {
  const targets = parseQueue(queueText)
    .filter(i => i.mark === ' ' && issuesOf(i.condition).every(id => id === sessionIdentifier))
    .map(i => ({ line: i.line, title: i.condition.replace(LEADING_TAGS, '').slice(0, MAX_SUB_TITLE) }))
  return targets.length < 2 ? [] : targets
}

// That raw line's leading tags replaced by the single tag [id] (added when it has none); every
// other line byte for byte as it was.
export function tagLine(queueText: string, line: number, id: string): string {
  const lines = queueText.split('\n')
  const raw = lines[line]
  if (raw === undefined) return queueText
  lines[line] = raw.replace(/^(\s*[-*] \[[ xX!]\] )((?:\[[A-Z][A-Z0-9]{0,9}-[0-9]+\]\s*)+)?/, `$1[${id}] `)
  return lines.join('\n')
}
