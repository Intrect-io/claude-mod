import { describe, expect, test } from 'claude-code/testing'

import { isHigher, newerModel, parseClaudeModel, validLearned } from './latest'

describe('parseClaudeModel', () => {
  test('reads the family and version, a flag or date aside', () => {
    expect(parseClaudeModel('claude-opus-5-5')).toEqual({ tier: 'opus', version: [5, 5] })
    expect(parseClaudeModel('claude-opus-5-5[1m]')).toEqual({ tier: 'opus', version: [5, 5] })
    expect(parseClaudeModel('claude-sonnet-4-5-20250929')).toEqual({ tier: 'sonnet', version: [4, 5] })
    expect(parseClaudeModel('claude-3-5-haiku-20241022')).toEqual({ tier: 'haiku', version: [3, 5] })
    expect(parseClaudeModel('claude-fable-5-1')).toEqual({ tier: 'fable', version: [5, 1] })
  })

  test('anything else is no Claude id', () => {
    expect(parseClaudeModel('sonnet')).toBeUndefined()
    expect(parseClaudeModel('codex')).toBeUndefined()
    expect(parseClaudeModel('gpt-6.1-sol')).toBeUndefined()
    expect(parseClaudeModel('claude-opus')).toBeUndefined()
  })
})

describe('isHigher', () => {
  test('compares part by part', () => {
    expect(isHigher([5, 6], [5, 5])).toBe(true)
    expect(isHigher([6], [5, 9])).toBe(true)
    expect(isHigher([5, 5], [5])).toBe(true)
    expect(isHigher([5, 5], [5, 5])).toBe(false)
    expect(isHigher([4, 9], [5, 0])).toBe(false)
  })
})

describe('newerModel', () => {
  test('adopts a newer version of the same family, without its flag', () => {
    expect(newerModel('claude-sonnet-5-5', 'claude-sonnet-5-6')).toBe('claude-sonnet-5-6')
    expect(newerModel('claude-opus-5-5', 'claude-opus-6[1m]')).toBe('claude-opus-6')
  })

  test('keeps the id for the same version, an older one, another family or a date stamp', () => {
    expect(newerModel('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBeUndefined()
    expect(newerModel('claude-sonnet-5-5', 'claude-sonnet-5-5-20261101')).toBeUndefined()
    expect(newerModel('claude-sonnet-5-5', 'claude-sonnet-4-5')).toBeUndefined()
    expect(newerModel('claude-sonnet-5-5', 'claude-opus-6')).toBeUndefined()
    expect(newerModel('claude-sonnet-5-5', 'codex')).toBeUndefined()
  })
})

describe('validLearned', () => {
  test('keeps Claude ids of their own tier only', () => {
    expect(validLearned({ opus: 'claude-opus-5-6[1m]', sonnet: 'claude-opus-5-6', haiku: 'codex', fable: 7 })).toEqual({ opus: 'claude-opus-5-6' })
    expect(validLearned(undefined)).toEqual({})
    expect(validLearned('x')).toEqual({})
  })
})
