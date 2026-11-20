// The session API auto-claude's driver calls: Authorization: Bearer SESSION_TOKEN.

import { type Env, errorText, json } from './env'
import { type ActivityContent, addExternalUrl, createActivity, createIssue, issueProject, type PlanEntry, teamByKey, updatePlan } from './linear'
import { readToken, type StoredToken } from './oauth'
import { eventsSince, HOLD_BACK_MS, NO_PROJECT, setProjectById, unresolvedSince } from './store'
import { constantTimeEqual } from './webhook'

const encoder = new TextEncoder()
const PLAN_STATUSES = new Set(['pending', 'inProgress', 'completed', 'canceled'])
const BODY_TYPES = new Set(['thought', 'elicitation', 'response', 'error'])
const MAX_PLAN = 100
const MAX_TEXT = 10_000

export function authorized(req: Request, env: Env): boolean {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer (.+)$/)
  if (match === null || env.SESSION_TOKEN === undefined || env.SESSION_TOKEN === '') return false
  return constantTimeEqual(encoder.encode(match[1]!), encoder.encode(env.SESSION_TOKEN))
}

const text = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max

export function activityContent(v: unknown): ActivityContent | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const c = v as Record<string, unknown>
  if (typeof c.type === 'string' && BODY_TYPES.has(c.type) && text(c.body)) return { type: c.type as 'thought', body: c.body }
  if (c.type === 'action' && text(c.action, 200) && typeof c.parameter === 'string' && c.parameter.length <= MAX_TEXT) {
    return { type: 'action', action: c.action, parameter: c.parameter, ...(typeof c.result === 'string' ? { result: c.result.slice(0, MAX_TEXT) } : {}) }
  }
  return undefined
}

export function planEntries(v: unknown): PlanEntry[] | null | undefined {
  if (v === null) return null
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_PLAN) return undefined
  const out: PlanEntry[] = []
  for (const e of v) {
    if (typeof e !== 'object' || e === null) return undefined
    const { content, status } = e as Record<string, unknown>
    if (!text(content) || typeof status !== 'string' || !PLAN_STATUSES.has(status)) return undefined
    out.push({ content, status: status as PlanEntry['status'] })
  }
  return out
}

async function body(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = (await req.json()) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// Rows whose project is unknown are looked up again before reading. One that still fails holds back
// the rows after it (so the driver's cursor does not pass it) until it is HOLD_BACK_MS old.
async function resolvePending(env: Env, token: StoredToken | undefined, since: number, now: number): Promise<number | undefined> {
  const pending = await unresolvedSince(env.DB, since)
  for (const row of pending) {
    if (token !== undefined) {
      try {
        await setProjectById(env.DB, row.id, (await issueProject(token.accessToken, row.issueId)) ?? NO_PROJECT)
        continue
      } catch (error) {
        console.warn(`project lookup for event ${row.id} failed: ${errorText(error)}`)
      }
    }
    if (now - row.createdAt < HOLD_BACK_MS) return row.id
  }
  return undefined
}

async function events(env: Env, url: URL, now: number): Promise<Response> {
  const project = url.searchParams.get('project')
  const since = Number(url.searchParams.get('since') ?? '0')
  if (project === null || project === '' || !Number.isInteger(since) || since < 0) return json({ error: 'project and a non-negative integer since are required' }, 400)
  const before = await resolvePending(env, await readToken(env.TOKENS), since, now)
  const rows = await eventsSince(env.DB, project, since, before)
  return json({ events: rows, cursor: rows.length > 0 ? rows[rows.length - 1]!.id : since })
}

type Handler = (env: Env, token: StoredToken, input: Record<string, unknown>) => Promise<Response>

const sessionId = (input: Record<string, unknown>) => (text(input.sessionId, 200) ? input.sessionId : undefined)

const activity: Handler = async (_env, token, input) => {
  const id = sessionId(input)
  const content = activityContent(input.content)
  if (id === undefined || content === undefined) return json({ error: 'sessionId and a valid content are required' }, 400)
  await createActivity(token.accessToken, id, content, input.ephemeral === true)
  return json({ ok: true })
}

const plan: Handler = async (_env, token, input) => {
  const id = sessionId(input)
  const entries = planEntries(input.plan)
  if (id === undefined || entries === undefined) return json({ error: 'sessionId and a plan of 1 to 100 entries (or null) are required' }, 400)
  await updatePlan(token.accessToken, id, entries)
  return json({ ok: true })
}

const externalUrl: Handler = async (_env, token, input) => {
  const id = sessionId(input)
  if (id === undefined || !text(input.label, 200) || !text(input.url, 2_000) || !/^https:\/\//.test(input.url)) return json({ error: 'sessionId, label and an https url are required' }, 400)
  await addExternalUrl(token.accessToken, id, input.label, input.url)
  return json({ ok: true })
}

const issue: Handler = async (_env, token, input) => {
  if (!text(input.team, 20) || !text(input.title, 255)) return json({ error: 'team (key) and title are required' }, 400)
  const team = await teamByKey(token.accessToken, input.team)
  if (team === undefined) return json({ error: `no team with key ${input.team}` }, 404)
  const created = await createIssue(token.accessToken, {
    teamId: team.id,
    title: input.title,
    ...(typeof input.description === 'string' ? { description: input.description.slice(0, 50_000) } : {}),
    ...(text(input.parentId, 200) ? { parentId: input.parentId } : {}),
    ...(text(input.projectId, 200) ? { projectId: input.projectId } : {}),
    ...(input.delegate === true ? { delegateId: token.appUserId } : {}),
    ...(team.labelId !== undefined ? { labelIds: [team.labelId] } : {}),
  })
  return json({ ok: true, ...created })
}

const POSTS: Record<string, Handler> = { '/v1/activity': activity, '/v1/plan': plan, '/v1/external-url': externalUrl, '/v1/issue': issue }

export async function handleApi(req: Request, env: Env, url: URL, now: number): Promise<Response> {
  if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401)
  if (req.method === 'GET' && url.pathname === '/v1/events') return events(env, url, now)
  const handler = req.method === 'POST' ? POSTS[url.pathname] : undefined
  if (handler === undefined) return json({ error: 'not found' }, 404)
  const input = await body(req)
  if (input === undefined) return json({ error: 'a JSON object body is required' }, 400)
  const token = await readToken(env.TOKENS)
  if (token === undefined) return json({ error: 'the app is not installed yet: open /oauth/start' }, 409)
  try {
    return await handler(env, token, input)
  } catch (error) {
    return json({ error: errorText(error) }, 502)
  }
}
