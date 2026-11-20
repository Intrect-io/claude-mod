// Test doubles: D1 over bun:sqlite running the real migrations, an in-memory KV,
// an ExecutionContext that collects waitUntil promises, and a fetch mock that
// records Linear calls. Every secret here is a fixture value.

import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Env } from '../src/env'

export const SECRETS = {
  LINEAR_CLIENT_ID: 'client-id-fixture',
  LINEAR_CLIENT_SECRET: 'client-secret-fixture',
  LINEAR_WEBHOOK_SECRET: 'lin_wh_test_fixture_secret',
  SESSION_TOKEN: 'session-token-fixture',
}

type Bound = { run(): Promise<{ meta: { changes: number } }>; all<T>(): Promise<{ results: T[] }>; first<T>(): Promise<T | null> }

// One prepared statement with its bound arguments, answered by bun:sqlite.
function bound(db: Database, sql: string, args: unknown[], failWrites: boolean, writeDelayMs: () => number): Bound {
  const params = args as never[]
  return {
    async run() {
      if (failWrites) throw new Error('D1 is unavailable')
      const delay = writeDelayMs()
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      return { meta: { changes: db.query(sql).run(...params).changes } }
    },
    async all<T>() {
      return { results: db.query(sql).all(...params) as T[] }
    },
    async first<T>() {
      return (db.query(sql).get(...params) as T) ?? null
    },
  }
}

export function fakeD1(options: { failWrites?: boolean; writeDelayMs?: () => number } = {}) {
  const db = new Database(':memory:')
  const dir = join(import.meta.dir, '..', 'migrations')
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'))
  const fail = options.failWrites === true
  const delay = options.writeDelayMs ?? (() => 0)
  const d1 = {
    prepare: (sql: string) => ({ ...bound(db, sql, [], fail, delay), bind: (...args: unknown[]) => bound(db, sql, args, fail, delay) }),
  }
  return { d1, db }
}

export function fakeKV() {
  const map = new Map<string, string>()
  const kv = {
    async get(key: string) {
      return map.get(key) ?? null
    },
    async put(key: string, value: string, _opts?: { expirationTtl?: number }) {
      map.set(key, value)
    },
    async delete(key: string) {
      map.delete(key)
    },
  }
  return { kv, map }
}

export function fakeCtx() {
  const waits: Promise<unknown>[] = []
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} },
    settle: () => Promise.allSettled(waits),
    waits,
  }
}

export function makeEnv(options: { failWrites?: boolean; writeDelayMs?: () => number } = {}) {
  const d1 = fakeD1(options)
  const kv = fakeKV()
  const env = { DB: d1.d1, TOKENS: kv.kv, ...SECRETS } as unknown as Env
  return { env, db: d1.db, kv: kv.map, kvApi: kv.kv }
}

export type Call = { url: string; body: string; headers: Record<string, string> }
type Reply = { status?: number; json: unknown }
type Responder = (call: Call, parsed: Record<string, any>) => Reply | undefined

// Replaces global fetch: each call is recorded; the first responder that answers decides.
export function mockFetch(...responders: Responder[]) {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    const call = { url, body: String(init?.body ?? ''), headers }
    calls.push(call)
    let parsed: Record<string, any> = {}
    try {
      parsed = JSON.parse(call.body)
    } catch {
      parsed = Object.fromEntries(new URLSearchParams(call.body))
    }
    for (const r of responders) {
      const reply = r(call, parsed)
      if (reply !== undefined) return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ errors: [{ message: `no mock for ${url}` }] }), { status: 500 })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

// A GraphQL responder for queries whose text contains `needle`.
export const gqlReply = (needle: string, data: unknown): Responder => (call, parsed) =>
  call.url === 'https://api.linear.app/graphql' && typeof parsed.query === 'string' && parsed.query.includes(needle) ? { json: { data } } : undefined

export async function sign(raw: string, secret = SECRETS.LINEAR_WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const installedToken = (now: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({ accessToken: 'access-fixture', refreshToken: 'refresh-fixture', expiresAt: now + 24 * 3_600_000, appUserId: 'app-user-1', organizationId: 'org-1', savedAt: now, ...over })
