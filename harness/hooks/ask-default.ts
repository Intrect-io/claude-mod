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
  return questions.filter(question => {
    const at = text.indexOf(`"${question.question}"`)
    if (at < 0) return true
    const tail = text.slice(at + question.question.length + 2, at + question.question.length + 2 + 200)

    return /^\s*=\s*"?\s*\(?(no answer|not answered|unanswered|skipped|timed out)/i.test(tail) || /^\s*=\s*""/.test(tail)
  })
}

export function defaultContext(missing: readonly AskQuestion[]): string {
  const picks = missing.map(question => `- "${question.question}" → "${recommendedLabel(question) ?? '(no options)'}"`)

  return [
    'harness: the user did not answer within the timeout (they may be asleep). Their standing instruction (2026-10-25) is to proceed with the Recommended option instead of stopping or asking again:',
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
