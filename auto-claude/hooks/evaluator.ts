// The loop's independent judge: whether a goal is met, from the agent's final
// message and the tail of its transcript (real tool output only counts).
// Moved from goal-mode (0.7.0) when it merged into auto-claude.

import type { EngineInterface, ModelForkResult } from 'claude-code'

import type { Goal } from '../types'

export const EVALUATOR_MODEL = 'claude-sonnet-5-5'
const EVALUATOR_TIMEOUT_MS = 60_000
const TRANSCRIPT_TAIL_CHARS = 40_000

export const EVALUATOR_SYSTEM = `You are a strict, skeptical judge of whether an AI coding agent has met a goal. You receive the goal, the agent's final message, and the tail of its transcript (tool calls and their real outputs).

Rules:
- Only real tool output in the transcript counts as evidence. The agent's own claims ("tests pass", "done") are NOT evidence.
- If the goal names a check (a command, a file state), the latest run of that check in the transcript must show success. An earlier success followed by further edits without a re-run is NOT met.
- If evidence is missing, partial, or ambiguous, the goal is NOT met.
- Judge only the stated goal; do not add requirements.

Reply with exactly one line of JSON and nothing else:
{"met": true|false, "reason": "<one sentence: what evidence shows it is met, or what is still missing>"}`

export type Verdict =
  | { kind: 'met'; reason: string }
  | { kind: 'unmet'; reason: string }
  | { kind: 'unparsable'; raw: string }
  | { kind: 'failed'; reason: string }

export type StopFields = {
  transcript_path: string
  last_assistant_message?: string
}

export async function evaluate($: EngineInterface, goal: Goal, e: StopFields, evidence?: string): Promise<Verdict> {
  const ask = [
    `Goal: ${goal.condition}`,
    goal.check ? `Check: ${goal.check}` : undefined,
    evidence ? `\nVerified by the harness (trustworthy):\n${evidence}` : undefined,
    '',
    "The agent's final message:",
    e.last_assistant_message ?? '(none)',
  ]
    .filter(line => line !== undefined)
    .join('\n')

  let tail: string | undefined
  try {
    tail = transcriptTail(await $.fs.read(e.transcript_path))
  } catch {
    tail = undefined
  }

  // A transcript past the read cap is judged by a fork over the session's own
  // context: same model, so less independent, but it sees everything.
  // A request the engine refuses to send (a blocked model) rejects; it must
  // pause the goal, not throw and leave every later Stop silently skipped.
  let reply: ModelForkResult
  try {
    reply =
      tail === undefined
        ? await $.model.fork({
            prompt: `${EVALUATOR_SYSTEM}\n\nThe transcript above is the agent's work. ${ask}`,
          })
        : await $.model.complete({
            model: EVALUATOR_MODEL,
            system: EVALUATOR_SYSTEM,
            prompt: `${ask}\n\nTranscript tail (oldest first):\n${tail}`,
            maxTokens: 300,
            timeoutMs: EVALUATOR_TIMEOUT_MS,
          })
  } catch (error) {
    return { kind: 'failed', reason: clip(String(error), 200) }
  }

  if (!reply.isAnswered) {
    return { kind: 'failed', reason: reply.reason }
  }

  return parseVerdict(reply.text)
}

export function parseVerdict(text: string): Verdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (match === null) {
    return { kind: 'unparsable', raw: text }
  }
  try {
    const parsed = JSON.parse(match[0]) as { met?: unknown; reason?: unknown }
    const reason = typeof parsed.reason === 'string' ? parsed.reason : 'no reason given'
    if (parsed.met === true) return { kind: 'met', reason }
    if (parsed.met === false) return { kind: 'unmet', reason }

    return { kind: 'unparsable', raw: text }
  } catch {
    return { kind: 'unparsable', raw: text }
  }
}

// Renders the newest transcript rows (text, tool calls, tool results) as plain
// lines, keeping the last TRANSCRIPT_TAIL_CHARS characters.
export function transcriptTail(jsonl: string): string {
  const lines: string[] = []
  for (const raw of jsonl.split('\n')) {
    if (raw.trim() === '') continue
    let row: { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown } }
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.message === undefined) continue
    const role = row.message.role ?? row.type
    const content = row.message.content
    if (typeof content === 'string') {
      lines.push(`[${role}] ${clip(content, 2_000)}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        lines.push(`[${role}] ${clip(block.text, 2_000)}`)
      } else if (block.type === 'tool_use') {
        lines.push(`[tool_use ${String(block.name)}] ${clip(JSON.stringify(block.input), 1_000)}`)
      } else if (block.type === 'tool_result') {
        lines.push(`[tool_result${block.is_error === true ? ' error' : ''}] ${clip(resultText(block.content), 2_500)}`)
      }
    }
  }
  const joined = lines.join('\n')

  return joined.length > TRANSCRIPT_TAIL_CHARS ? joined.slice(-TRANSCRIPT_TAIL_CHARS) : joined
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(part =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text)
        : '',
    )
    .join('\n')
}

export function clip(text: string, max: number, fromEnd = false): string {
  if (text.length <= max) return text

  return fromEnd ? `…${text.slice(-(max - 1))}` : `${text.slice(0, max - 1)}…`
}
