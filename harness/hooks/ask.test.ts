import { describe, expect, mock, test } from 'claude-code/testing'

import { defaultContext, recommendedLabel, unanswered } from './ask-default'

const Q1 = { question: '어떤 방식으로 할까요?', options: [{ label: 'A안' }, { label: 'B안 (Recommended)' }] }
const Q2 = { question: '언제 할까요?', options: [{ label: '지금' }, { label: '나중' }] }

describe('ask-default helpers', () => {
  test('recommended option, else the first', async () => {
    expect(recommendedLabel(Q1)).toBe('B안 (Recommended)')
    expect(recommendedLabel(Q2)).toBe('지금')
  })

  test('answered questions are left alone; missing or "No answer" ones are caught', async () => {
    const answered = `Your questions have been answered: "${Q1.question}"="A안", "${Q2.question}"="나중". You can now continue.`
    expect(unanswered([Q1, Q2], answered)).toEqual([])
    const partial = `Your questions have been answered: "${Q1.question}"="A안". You can now continue.`
    expect(unanswered([Q1, Q2], partial)).toEqual([Q2])
    const none = `"${Q1.question}"="(No answer provided)", "${Q2.question}"=""`
    expect(unanswered([Q1, Q2], none)).toEqual([Q1, Q2])
    const declined = `"${Q1.question}": (user declined)`
    expect(unanswered([Q1, Q2], declined)).toEqual([Q1, Q2])
    const advice = `${answered} Questions you did not answer were skipped.`
    expect(unanswered([Q1, Q2], advice)).toEqual([])
    // The same closing advice plus no answer for Q1: only Q1 is missing.
    const mixed = `"${Q1.question}": (user declined), "${Q2.question}"="나중". Questions you did not answer were skipped.`
    expect(unanswered([Q1, Q2], mixed)).toEqual([Q1])
  })

  test('the context names each pick and the irreversible exception', async () => {
    const text = defaultContext([Q1])
    expect(text).toContain('"B안 (Recommended)"')
    expect(text).toContain('irreversible')
  })
})

test('a timed-out question gets the default context; an answered one does not', async ($, on) => {
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  let reply = ''
  on('tool.call', () => ({ result: { answers: {} }, text: reply }) as never)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })

  reply = `"${Q1.question}"="(No answer provided)"`
  const timedOut = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ ...Q1, header: 'h', multiSelect: false, options: Q1.options.map(o => ({ ...o, description: 'd' })) }] })
  expect(timedOut.context?.join(' ')).toContain('B안 (Recommended)')

  reply = `"${Q1.question}"="A안"`
  const answered = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ ...Q1, header: 'h', multiSelect: false, options: Q1.options.map(o => ({ ...o, description: 'd' })) }] })
  expect(answered.context ?? []).toEqual([])
})
