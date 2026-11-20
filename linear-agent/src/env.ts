// Bindings and secrets the Worker reads (wrangler.toml and `wrangler secret put`).
export interface Env {
  DB: D1Database
  TOKENS: KVNamespace
  LINEAR_CLIENT_ID: string
  LINEAR_CLIENT_SECRET: string
  LINEAR_WEBHOOK_SECRET: string
  SESSION_TOKEN: string
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
