import type { EngineInterface } from 'claude-code'

import type { Effort, Tier } from '../types'

/**
 * ~/.claude/model-tier.log: one JSON line per event, from every session on the
 * machine. `$.fs` can only rewrite a whole file, and a read-modify-write from
 * two sessions at once drops one session's line, so a line is appended by the
 * shell (`>>`, one small write per line). Past `LOG_ROTATE_BYTES` the file moves
 * to `model-tier.log.1` (replacing the older one), so the two files hold the
 * last 3 to 6 MiB, at least 5000 lines, and each stays under `$.fs.read`'s 4 MiB.
 */
export const LOG_ROTATE_BYTES = 3 * 1024 * 1024
/** Lines kept when the shell is unavailable and the file is rewritten instead. */
export const LOG_FALLBACK_MAX_LINES = 5000

// $1 the log, $2 the rotation bound in bytes. A failed append exits non-zero,
// so the caller falls back to rewriting the file.
const APPEND = 'cat >> "$1" || exit 1; s=$(wc -c < "$1"); if [ "$s" -gt "$2" ]; then mv -f "$1" "$1.1"; fi; exit 0'

/** Tokens one model spent on the main loop in one turn. */
export type ModelTotals = { requests: number; promptTokens: number; cacheWriteTokens: number; outputTokens: number }

export type LogEntry =
  /** A prompt waited for its label and the bound passed first. */
  | { event: 'classifier-timeout'; classifier: 'tier' | 'effort' | 'subagent'; ranMs: number; kept: { tier: Tier; effort: Effort | null } }
  /** A label that came after the prompt went on: `ms` is the classifier's real latency. */
  | { event: 'classifier-late'; ms: number; applied: boolean; waited: boolean; wantTier: boolean }
  /**
   * A main-loop prompt that was classified: the pick before (`from`) and after
   * (`tier`, `effort`), what the classifier said in time (`verdict`), whether the
   * tier was asked at all (`wantTier`), and the latency when it answered in time.
   */
  | {
      event: 'prompt'
      tier: Tier
      effort: Effort | null
      from: { tier: Tier; effort: Effort | null }
      verdict: { tier: Tier | null; effort: Effort | null }
      wantTier: boolean
      /** A prompt of at most `followUpChars` characters: it could raise the pick, not lower it. */
      followUp?: boolean
      waited: boolean
      timedOut: boolean
      ms: number | null
      tokens: number
    }
  /** A subagent spawn that was routed: its type and the tier it got (null keeps the parent's). */
  | { event: 'spawn'; agent: string; tier: Tier | null; timedOut: boolean; ms: number | null }
  /** A main-loop request answered by another model than the one before: the prefix was written again. */
  | { event: 'switch'; from: string; to: string; tokens: number }
  /** One finished main-loop turn: requests and tokens per model that answered. */
  | { event: 'turn'; models: Record<string, ModelTotals> }

export type LogLine = LogEntry & { ts: string }

async function logPath($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  return home === undefined ? undefined : `${home}/.claude/model-tier.log`
}

async function writeLine($: EngineInterface, path: string, line: string): Promise<void> {
  try {
    const ran = await $.process.run(['sh', '-c', APPEND, 'sh', path, String(LOG_ROTATE_BYTES)], { stdin: `${line}\n`, timeoutMs: 5_000 })
    if (ran.exitCode === 0) return
  } catch {
    // No shell here: rewrite the file below.
  }
  let text = ''
  try {
    text = await $.fs.read(path)
  } catch {
    // First line.
  }
  const lines = text.split('\n').filter(l => l !== '')
  lines.push(line)
  await $.fs.write(path, `${lines.slice(-LOG_FALLBACK_MAX_LINES).join('\n')}\n`)
}

// Lines from this session go out one at a time, in order: two writes in
// flight at once would race in the rewrite fallback.
let queue: Promise<void> = Promise.resolve()

/** Appends one line; never throws (a log line is never worth failing a prompt over). */
export async function appendLog($: EngineInterface, entry: LogEntry): Promise<void> {
  const write = async () => {
    try {
      const path = await logPath($)
      if (path === undefined) return
      await writeLine($, path, JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), ...entry }))
    } catch {
      // Dropped: see above.
    }
  }
  queue = queue.then(write, write)
  return queue
}

/** Every parsable line of the rotated file, then the live one. */
export async function readLog($: EngineInterface): Promise<LogLine[]> {
  const path = await logPath($)
  if (path === undefined) return []
  const lines: LogLine[] = []
  for (const file of [`${path}.1`, path]) {
    let text = ''
    try {
      text = await $.fs.read(file)
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue
      try {
        const line = JSON.parse(raw) as LogLine
        if (typeof line.ts === 'string' && typeof line.event === 'string') lines.push(line)
      } catch {
        // A torn or foreign line.
      }
    }
  }
  return lines
}
