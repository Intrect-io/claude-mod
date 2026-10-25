import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import { DEFAULT_TOGGLES } from './state'

// Unattended default for AskUserQuestion (user request 2026-10-25: "자고있는데
// 가만히 멈춰있는거 막기"). With askUserQuestionTimeout set, an unanswered
// question auto-continues as "(No answer provided)", and the model tends to
// stop or ask again. This hook tells it to proceed with each unanswered
// question's Recommended option, unless that option is irreversible.

type On = Parameters<Register>[0]

const togglesAtom = atom({ plugin: 'harness', key: 'toggles' } as const, DEFAULT_TOGGLES, { shape: 'toggles-1' })

export type AskQuestion = { question: string; options: ReadonlyArray<{ label: string }> }

export function recommendedLabel(question: AskQuestion): string | undefined {
  const marked = question.options.find(option => /\(recommended\)|\(권장\)|\(추천\)/i.test(option.label))

  return (marked ?? question.options[0])?.label
}

// Questions the result text gives no answer for. The tool result names each
// answered question as `"<question>"="<answer>"`; an auto-continued one is
// missing or reads "(No answer provided)".
export function unanswered(questions: readonly AskQuestion[], text: string): AskQuestion[] {
  const named = questions.filter(question => text.includes(`"${question.question}"`))
  const missingNamed = questions.filter(question => !named.includes(question))

  const flagged = named.filter(question => {
    const at = text.indexOf(`"${question.question}"`)
    const tail = at < 0 ? '' : text.slice(at + question.question.length + 2, at + question.question.length + 2 + 200)

    // Only the answer right after the question counts: the result's closing
    // advice talks about "declined or did not answer" even when all were answered.
    return /^\s*["']?\s*[=:]\s*["']?\s*\(?\s*(user )?(no answer|not answered|unanswered|skipped|timed out|declined)/i.test(tail) || /^\s*["']?\s*=\s*""/.test(tail)
  })

  // Question order, as the tool showed them.
  return questions.filter(question => missingNamed.includes(question) || flagged.includes(question))
}

export function defaultContext(missing: readonly AskQuestion[]): string {
  const picks = missing.map(question => `- "${question.question}" → "${recommendedLabel(question) ?? '(no options)'}"`)

  return [
    'harness: the user did not answer within the timeout (5m; they may be away or asleep). Their standing instruction (2026-10-25) is to proceed with the Recommended option instead of stopping or asking again:',
    ...picks,
    'State in your next message which option you assumed. EXCEPTION: if that option is irreversible (payments or purchases, credential or release-trust changes, deleting data, force push or pushing main, publishing a new public repo), pick the safest non-destructive option (hold/skip) instead and leave the decision for the user.',
  ].join('\n')
}

export function registerAskDefault(on: On): void {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const ran = await next(e)
    const toggles = await read($, togglesAtom)
    if (!toggles.guards || ran.deny !== undefined || typeof ran.text !== 'string') return ran
    const questions = (e as unknown as { questions?: AskQuestion[] }).questions ?? []
    const missing = unanswered(questions, ran.text)
    if (missing.length === 0) return ran

    return { ...ran, context: [...(ran.context ?? []), defaultContext(missing)] }
  })
}

