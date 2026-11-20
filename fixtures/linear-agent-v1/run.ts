#!/usr/bin/env bun
// Created: 2026-11-20
// Purpose: Pinned acceptance fixtures for the Linear agent app: the Cloudflare Worker's
//   webhook handling, auto-claude's agent session bridge, and its autonomous issue
//   creation and decomposition. The fixtures and this runner are committed before the
//   code they judge, and their hashes are pinned in the auto-claude milestone checks, so
//   a builder cannot weaken them to pass.
// Dependencies: bun. Contracts (see README.md; every module imports under plain bun, with
//   no engine and no network):
//   - linear-agent/src/webhook.ts  verifyWebhook, classifyEvent, handleWebhook
//   - auto-claude/hooks/agent.ts   planOf, eventLines, activityFor                (bridge)
//                                  fingerprint, issueCandidates, decomposeTargets, tagLine (autonomy)
// Test Status: written before the implementations; each section fails until its module lands.
//
// Usage: bun fixtures/linear-agent-v1/run.ts [--section worker|bridge|autonomy]   (default: all)

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

let failures = 0
function result(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `: ${detail}`}`)
}

async function load(rel: string): Promise<Record<string, unknown> | undefined> {
  const file = join(root, rel)
  if (!existsSync(file)) {
    result(false, rel, 'module not found')
    return undefined
  }
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>
}

function fns(mod: Record<string, unknown>, names: string[], section: string): Record<string, (...a: never[]) => unknown> | undefined {
  const missing = names.filter(n => typeof mod[n] !== 'function')
  if (missing.length > 0) {
    result(false, section, `not exported: ${missing.join(', ')}`)
    return undefined
  }
  return mod as Record<string, (...a: never[]) => unknown>
}

const json = (name: string) => JSON.parse(readFileSync(join(here, name), 'utf8'))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
// Every expected field is present with the same value; other fields are free.
const partial = (got: Record<string, unknown> | undefined, want: Record<string, unknown>) =>
  got !== undefined && Object.entries(want).every(([k, v]) => same(got[k], v))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- worker

type WebhookCase = {
  name: string
  raw: string
  signature: string | null
  delivery: string | null
  enqueue?: 'queued' | 'duplicate' | 'hang' | 'reject' | 'slow'
  delayMs?: number
  thought?: 'ok' | 'reject' | 'hang'
  omitTimeout?: boolean
  expect: { status: number; reason?: string; enqueued: number; thoughts: string[]; event?: Record<string, unknown>; within?: number }
}

type Fns = Record<string, (...a: never[]) => unknown>
type Seen = { enqueued: Record<string, unknown>[]; thoughts: string[]; deferred: Promise<unknown>[] }

function fakeDeps(c: WebhookCase, secret: string, now: number, writeTimeoutMs: number) {
  const seen: Seen = { enqueued: [], thoughts: [], deferred: [] }
  const deps = {
    secret,
    now,
    ...(c.omitTimeout === true ? {} : { writeTimeoutMs }),
    enqueue: (e: Record<string, unknown>) => {
      seen.enqueued.push(e)
      if (c.enqueue === 'hang') return new Promise<boolean>(() => {})
      if (c.enqueue === 'reject') return Promise.reject(new Error('queue write failed'))
      if (c.enqueue === 'slow') return sleep(c.delayMs ?? 0).then(() => true)
      return Promise.resolve(c.enqueue !== 'duplicate')
    },
    thought: (sessionId: string, body: string) => {
      seen.thoughts.push(typeof body === 'string' && body.trim() !== '' ? sessionId : `${sessionId} (empty body)`)
      if (c.thought === 'hang') return new Promise<void>(() => {})
      return c.thought === 'reject' ? Promise.reject(new Error('activity failed')) : Promise.resolve()
    },
    after: (p: Promise<unknown>) => {
      seen.deferred.push(p)
    },
  }
  return { deps, seen }
}

function headersOf(c: WebhookCase): Headers {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  if (c.signature !== null) headers.set('Linear-Signature', c.signature)
  if (c.delivery !== null) headers.set('Linear-Delivery', c.delivery)
  return headers
}

// verifyWebhook on its own: the reason, and that it never throws.
async function verifyProblem(f: Fns, c: WebhookCase, secret: string, now: number): Promise<string | undefined> {
  if (c.expect.reason === undefined) return undefined
  const v = (await (f.verifyWebhook as (r: string, s: string | null, k: string, n: number) => unknown)(c.raw, c.signature, secret, now)) as { ok?: boolean; status?: number; reason?: string }
  if (v?.ok === false && v.status === c.expect.status && v.reason === c.expect.reason) return undefined
  return `verifyWebhook gave ${JSON.stringify(v)}, want status ${c.expect.status} reason ${c.expect.reason}`
}

// The deferred work must settle, and never reject.
async function deferredProblem(deferred: Promise<unknown>[]): Promise<string | undefined> {
  const settled = await Promise.race([Promise.allSettled(deferred), sleep(5_000).then(() => 'timeout' as const)])
  if (settled === 'timeout') return 'deferred work did not settle within 5 s'
  const rejected = settled.filter(s => s.status === 'rejected').length
  return rejected > 0 ? `${rejected} deferred promise(s) rejected; failures must be caught inside` : undefined
}

function callsProblem(c: WebhookCase, seen: Seen): string | undefined {
  const e = c.expect
  if (seen.enqueued.length !== e.enqueued) return `enqueue called ${seen.enqueued.length} time(s), want ${e.enqueued}`
  if (!same(seen.thoughts, e.thoughts)) return `thoughts ${JSON.stringify(seen.thoughts)}, want ${JSON.stringify(e.thoughts)}`
  // A thought must reach Linear through ctx.waitUntil, or the isolate may stop before it is sent.
  if (e.thoughts.length > 0 && seen.deferred.length === 0) return 'the thought was not handed to after() (ctx.waitUntil)'
  if (e.event !== undefined && !partial(seen.enqueued[0], e.event)) return `wrote ${JSON.stringify(seen.enqueued[0])}, want fields ${JSON.stringify(e.event)}`
  return undefined
}

async function webhookProblem(f: Fns, c: WebhookCase, secret: string, now: number, writeTimeoutMs: number): Promise<string | undefined> {
  const verified = await verifyProblem(f, c, secret, now)
  if (verified !== undefined) return verified
  const { deps, seen } = fakeDeps(c, secret, now, writeTimeoutMs)
  const within = c.expect.within ?? 3_000
  const raced = await Promise.race([
    (f.handleWebhook as (r: string, h: Headers, d: typeof deps) => Promise<Response>)(c.raw, headersOf(c), deps),
    sleep(within).then(() => 'timeout' as const),
  ])
  if (raced === 'timeout') return `no response within ${within} ms`
  if (raced.status !== c.expect.status) return `status ${raced.status}, want ${c.expect.status}`
  // A thought that never finishes leaves its deferred promise pending; only the calls are checked.
  const deferred = c.thought === 'hang' ? undefined : await deferredProblem(seen.deferred)
  return deferred ?? callsProblem(c, seen)
}

async function workerSection(): Promise<void> {
  const mod = await load('linear-agent/src/webhook.ts')
  if (mod === undefined) return
  const f = fns(mod, ['verifyWebhook', 'classifyEvent', 'handleWebhook'], 'worker')
  if (f === undefined) return
  const { secret, now, writeTimeoutMs, everyByte, cases } = json('webhook.json') as {
    secret: string
    now: number
    writeTimeoutMs: number
    everyByte: { raw: string; signatures: string[] }
    cases: WebhookCase[]
  }
  const accepted: number[] = []
  for (const [i, sig] of everyByte.signatures.entries()) {
    const v = (await (f.verifyWebhook as (r: string, s: string, k: string, n: number) => Promise<{ ok?: boolean }>)(everyByte.raw, sig, secret, now)) as { ok?: boolean }
    if (v?.ok !== false) accepted.push(i)
  }
  result(accepted.length === 0, 'worker: a signature wrong in any single byte is refused', accepted.length === 0 ? '' : `accepted with byte(s) ${accepted.join(', ')} wrong`)
  for (const c of cases) {
    let problem: string | undefined
    try {
      problem = await webhookProblem(f, c, secret, now, writeTimeoutMs)
    } catch (error) {
      problem = `threw: ${error instanceof Error ? error.message : String(error)}`
    }
    result(problem === undefined, `worker: ${c.name}`, problem ?? '')
  }
}

// ---------------------------------------------------------------- bridge

const LINE_ID = /^- \[ \] \[([A-Z][A-Z0-9]{0,9}-\d+)\] /

// A created line must stay one queue line that parses back to no check.
const UNCLEAN = /[\n\r\v\f\u00a0]|::|<!--|-->/

type Parse = (text: string) => Array<{ mark: string; condition: string; check?: string }>

function eventLinesProblems(c: any, got: any, known: unknown, parse: Parse): string[] {
  const lines: string[] = got?.lines ?? []
  const ids = lines.map(l => l.match(LINE_ID)?.[1] ?? '?')
  const problems: string[] = []
  if (!same(ids, c.expect.lineIds)) problems.push(`line ids ${JSON.stringify(ids)}, want ${JSON.stringify(c.expect.lineIds)}`)
  for (const l of lines) {
    if (UNCLEAN.test(l)) problems.push(`line is not one clean queue line: ${JSON.stringify(l)}`)
    const items = parse(l)
    if (items.length !== 1 || items[0]!.mark !== ' ' || items[0]!.check !== undefined) problems.push(`line does not parse back as one open item with no check: ${JSON.stringify(items)}`)
  }
  for (const [id, text] of Object.entries((c.expect.lineContains ?? {}) as Record<string, string>)) {
    const l = lines.find(x => x.match(LINE_ID)?.[1] === id)
    if (l === undefined || !l.includes(text)) problems.push(`line for ${id} lacks ${JSON.stringify(text)}`)
  }
  if (!same(got?.sessions, c.expect.sessions)) problems.push(`sessions ${JSON.stringify(got?.sessions)}`)
  if (!same(got?.prompts, c.expect.prompts)) problems.push(`prompts ${JSON.stringify(got?.prompts)}`)
  if (!same(got?.stops, c.expect.stops)) problems.push(`stops ${JSON.stringify(got?.stops)}`)
  if (got?.cursor !== c.expect.cursor) problems.push(`cursor ${got?.cursor}, want ${c.expect.cursor}`)
  if (!same(known, c.known)) problems.push('the known map passed in was changed; sessions must be a copy')
  return problems
}

async function bridgeSection(): Promise<void> {
  const mod = await load('auto-claude/hooks/agent.ts')
  if (mod === undefined) return
  const f = fns(mod, ['planOf', 'eventLines', 'activityFor'], 'bridge')
  if (f === undefined) return
  // The real queue parser: a created line must read back as an open item with no check.
  const queue = await load('auto-claude/hooks/queue.ts')
  if (queue === undefined || typeof queue.parseQueue !== 'function') return result(false, 'bridge', 'auto-claude/hooks/queue.ts parseQueue not found')
  const parse = queue.parseQueue as Parse
  const data = json('bridge.json')

  for (const c of data.planOf) {
    const got = (f.planOf as (q: string, cur?: string) => unknown)(c.queue, c.current)
    result(same(got, c.expect), `bridge planOf: ${c.name}`, same(got, c.expect) ? '' : `got ${JSON.stringify(got)}`)
  }

  for (const c of data.eventLines) {
    const known = structuredClone(c.known)
    const got = (f.eventLines as (e: unknown, p: string, k: unknown, s: number) => unknown)(c.events, c.project, known, c.since) as {
      lines?: string[]
      sessions?: Record<string, string>
      prompts?: unknown[]
      stops?: unknown[]
      cursor?: number
    }
    const problems = eventLinesProblems(c, got, known, parse)
    result(problems.length === 0, `bridge eventLines: ${c.name}`, problems.join('; '))
  }

  for (const c of data.activityFor) {
    const got = (f.activityFor as (m: unknown) => unknown)(c.moment) as Record<string, unknown>
    const problems: string[] = []
    if (got?.type !== c.expect.type) problems.push(`type ${got?.type}, want ${c.expect.type}`)
    if (c.expect.type === 'action') {
      if (typeof got?.action !== 'string' || got.action.trim() === '') problems.push('action is empty')
      for (const s of c.expect.parameterContains ?? []) if (typeof got?.parameter !== 'string' || !got.parameter.includes(s)) problems.push(`parameter lacks ${JSON.stringify(s)}`)
    } else {
      for (const s of c.expect.bodyContains ?? []) if (typeof got?.body !== 'string' || !got.body.includes(s)) problems.push(`body lacks ${JSON.stringify(s)}`)
    }
    result(problems.length === 0, `bridge activityFor: ${c.name}`, problems.join('; '))
  }
}

// ---------------------------------------------------------------- autonomy

const fp = (kind: string, key: string) => `auto-claude:fp=${kind}:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`

async function autonomySection(): Promise<void> {
  const mod = await load('auto-claude/hooks/agent.ts')
  if (mod === undefined) return
  const f = fns(mod, ['fingerprint', 'issueCandidates', 'decomposeTargets', 'tagLine'], 'autonomy')
  if (f === undefined) return
  const data = json('autonomy.json')

  for (const c of data.fingerprint) {
    const got = await (f.fingerprint as (k: string, key: string) => unknown)(c.kind, c.key)
    result(got === c.expect && got === fp(c.kind, c.key), `autonomy fingerprint ${c.kind}/${c.key}`, got === c.expect ? '' : `got ${JSON.stringify(got)}`)
  }

  for (const c of data.issueCandidates) {
    const got = (await (f.issueCandidates as (i: unknown) => unknown)(c.input)) as Array<Record<string, unknown>>
    const problems: string[] = []
    const kinds = (got ?? []).map(g => ({ kind: g.kind, key: g.key }))
    if (!same(kinds, c.expect)) problems.push(`got ${JSON.stringify(kinds)}`)
    for (const g of got ?? []) {
      if (g.fingerprint !== fp(String(g.kind), String(g.key))) problems.push(`fingerprint ${JSON.stringify(g.fingerprint)} for ${g.kind}/${g.key}`)
      const title = typeof g.title === 'string' ? g.title : ''
      const want = (g.kind === 'held' ? `Held: ${g.key}` : `CI red on the default branch: ${g.key}`).slice(0, 100)
      if (title !== want) problems.push(`title ${JSON.stringify(title)}, want ${JSON.stringify(want)}`)
    }
    result(problems.length === 0, `autonomy issueCandidates: ${c.name}`, problems.join('; '))
  }

  for (const c of data.decomposeTargets) {
    const got = (f.decomposeTargets as (q: string, s: string) => unknown)(c.queue, c.session)
    result(same(got, c.expect), `autonomy decomposeTargets: ${c.name}`, same(got, c.expect) ? '' : `got ${JSON.stringify(got)}`)
  }

  for (const c of data.tagLine) {
    const got = (f.tagLine as (q: string, l: number, id: string) => unknown)(c.queue, c.line, c.id)
    result(got === c.expect, `autonomy tagLine: ${c.name}`, got === c.expect ? '' : `got ${JSON.stringify(got)}`)
  }
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2)
const at = args.indexOf('--section')
const wanted = at >= 0 ? [args[at + 1] ?? ''] : ['worker', 'bridge', 'autonomy']

for (const section of wanted) {
  try {
    if (section === 'worker') await workerSection()
    else if (section === 'bridge') await bridgeSection()
    else if (section === 'autonomy') await autonomySection()
    else result(false, `unknown section ${section}`)
  } catch (error) {
    result(false, `${section} threw`, error instanceof Error ? error.message : String(error))
  }
}

console.log(failures === 0 ? 'linear-agent-v1: all passed' : `linear-agent-v1: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
