import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { DEFAULT_TOGGLES, INITIAL_LINT } from './state'
import type { PromptHook, StopHook, ToolCallHook } from './state'

const lintAtom = atom({ plugin: 'harness', key: 'lint' } as const, INITIAL_LINT, { shape: 'lint-1' })
const togglesAtom = atom({ plugin: 'harness', key: 'toggles' } as const, DEFAULT_TOGGLES, { shape: 'toggles-1' })

// Report lint (toggle, on by default): at most one nudge per turn when the
// final message breaks the user's reporting rules (CLAUDE.md §1, §2). The turn
// facts come from the tool calls this hook saw, not from the transcript. The
// only wording rules are the question endings CLAUDE.md §2 itself names; no
// uncertainty heuristics ("아마도", "일단") are used.

const FALLBACK = /\[FALLBACK: AskUserQuestion unavailable\]/
// Question endings CLAUDE.md §2 names as violations, wherever they sit near the end.
const ASKING = /(어떻게 할까요|진행해도 될까요|진행할까요|원하시나요|괜찮을까요|할까요|하시겠어요|드릴까요)\s*[?？]?\s*$/
const AUDIT_FIELDS = ['실행/테스트 확인', '호출처/영향 범위 확인', '요구사항 충족 확인', '동시성/경합']
const CODE_FILE = /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|rs|go|java|kt|swift|c|cc|cpp|h|hpp|m|mm|cs|rb|php|sh|bash|zsh|sql|lua|scala|dart|vue|svelte|ipynb)$/i
const HANGUL = /[가-힣]/

export function isCodePath(path: unknown): boolean {
  return typeof path === 'string' && CODE_FILE.test(path)
}

export type LintFacts = { codeEdited: boolean; askUsed: boolean; planMode: boolean }

export function lintReport(text: string, facts: LintFacts): string[] {
  const prose = proseLines(text)
  const issues: string[] = []

  const audited = /\[SELF-AUDIT\]/.test(text)
  if (facts.codeEdited && !facts.askUsed && !audited && !/\[CONFIDENCE HALT\]/.test(text)) {
    issues.push('This turn changed code: end the completion report with the [SELF-AUDIT] block (CLAUDE.md §2).')
  }
  if (audited) {
    const missing = AUDIT_FIELDS.filter(field => !text.includes(field))
    if (missing.length > 0) issues.push(`The [SELF-AUDIT] block is missing: ${missing.join(', ')} (CLAUDE.md §2).`)
  }

  const last = prose.at(-1)?.trim() ?? ''
  const asking = prose.slice(-3).some(line => ASKING.test(line.trim()))
  if (!facts.planMode && !facts.askUsed && !FALLBACK.test(text) && (/[?？]$/.test(last) || asking)) {
    issues.push(
      'The reply ends with a plain-text question: ask it with AskUserQuestion, or, if asking is not possible here, state your conclusion without a question (CLAUDE.md §2).',
    )
  }

  const english = prose.filter(isEnglishLine)
  if (english.length > 0) {
    issues.push(
      `Report to the user in Korean; technical terms may stay in English (CLAUDE.md §1). English-only lines: ${english
        .slice(0, 2)
        .map(line => `"${line.trim().slice(0, 80)}"`)
        .join(', ')}`,
    )
  }

  return issues
}

// Lines of the message outside fenced code blocks and block quotes.
export function proseLines(text: string): string[] {
  const lines: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || line.trim() === '' || /^\s*>/.test(line)) continue
    lines.push(line)
  }

  return lines
}

// A prose line with four or more English words and no Hangul at all. Inline
// code, URLs, paths, table separators and lone identifiers do not count, so a
// Korean sentence dense with technical terms is fine.
export function isEnglishLine(line: string): boolean {
  if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return false
  if (HANGUL.test(line)) return false
  const words = line
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S*[/\\]\S*/g, ' ')
    .replace(/\S+\.(py|ts|md|json|sh|js|tsx|rs|toml|yaml|yml)\b/g, ' ')
    .match(/[A-Za-z][A-Za-z'-]*[A-Za-z]/g)

  return (words?.length ?? 0) >= 4
}

export async function lintPrompt($: EngineInterface, e: Parameters<PromptHook>[1], next: Parameters<PromptHook>[2]) {
    if (e.agent_id === undefined) {
      await update($, lintAtom, () => ({ codeEdited: false, askUsed: false, nudged: false, mode: e.permission_mode }))
    }

    return next(e)
}

export async function lintToolCall($: EngineInterface, e: Parameters<ToolCallHook>[1], next: Parameters<ToolCallHook>[2]) {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'AskUserQuestion') {
      await update($, lintAtom, lint => ({ ...lint, askUsed: true }))
    } else if (
      ran.isError !== true &&
      (((e.tool === 'Edit' || e.tool === 'Write') && isCodePath(input.file_path)) ||
        (e.tool === 'NotebookEdit' && isCodePath(input.notebook_path)))
    ) {
      await update($, lintAtom, lint => ({ ...lint, codeEdited: true }))
    }

    return ran
}

export async function lintStop($: EngineInterface, e: Parameters<StopHook>[1], next: Parameters<StopHook>[2]) {
    const below = await next(e)
    const toggles = await read($, togglesAtom)
    if (!toggles.reportLint || e.agent_id !== undefined || below.block !== undefined || below.preventContinuation === true) {
      return below
    }
    const lint = await read($, lintAtom)
    if (lint.nudged) return below
    const issues = lintReport(e.last_assistant_message ?? '', {
      codeEdited: lint.codeEdited,
      askUsed: lint.askUsed,
      planMode: (e.permission_mode ?? lint.mode) === 'plan',
    })
    if (issues.length === 0) return below
    await update($, lintAtom, l => ({ ...l, nudged: true }))

    return { ...below, block: `Report lint (once per turn; rewrite your final message):\n- ${issues.join('\n- ')}` }
}
