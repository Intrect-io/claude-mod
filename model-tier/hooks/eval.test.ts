import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { EvalRun } from './eval'

type On = Parameters<TestBody>[1]
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

/** A started session with a prompt set at /e/p.jsonl; returns the files map. */
async function started($: Parameters<TestBody>[0], on: On, lines: string[]): Promise<Map<string, string>> {
  on('ui.status', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
  on('command.register', () => ({ value: { command: 'tier' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const files = new Map<string, string>([['/e/p.jsonl', lines.join('\n')]])
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return files
}

const line = (prompt: string) => JSON.stringify({ prompt, tier: 'haiku', effort: 'low', why: '' })
const lastRun = (files: Map<string, string>) => JSON.parse(files.get('/e/last-run.json') ?? '{}') as EvalRun

describe('labelPrompt, through /tier eval', () => {
  test('an unknown label or a failed call scores as no label, not a timeout', async ($, on) => {
    mock.clock(on, { now: 0 })
    on('model.classify', (_, e) => {
      if ((e.labels as readonly string[]).includes('complex')) return { value: 'enormous' }
      throw new Error('classifier down')
    })
    const files = await started($, on, [line('x')])
    await $.command.run({ command: 'tier', args: 'eval /e/p.jsonl', ...RUN })
    expect(lastRun(files).results[0]).toMatchObject({ got: { tier: null, effort: null }, tierTimedOut: false, effortTimedOut: false })
  })

  test('a classifier that never answers times out at the eval bound and the run goes on', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    on('model.classify', (_, e) => ((e.labels as readonly string[]).includes('complex') ? new Promise(() => {}) : { value: 'recall-or-lookup' }))
    const files = await started($, on, [line('x')])
    const ran = $.command.run({ command: 'tier', args: 'eval /e/p.jsonl', ...RUN })
    await clock.advance(30_000)
    expect((await ran).text).toContain('timeouts tier 1, effort 0')
    expect(lastRun(files).results[0]).toMatchObject({ got: { tier: null, effort: 'low' }, tierOk: false, effortOk: true, tierTimedOut: true })
  })
})

describe('/tier eval', () => {
  test('labels every prompt, scores tier and effort, and writes last-run.json beside the set', async ($, on) => {
    let now = 1_000
    on('clock.now', () => ({ value: now }))
    on('clock.sleep', () => new Promise(() => {}))
    on('ui.status', () => ({ value: undefined }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/repo' }))
    mock.env(on, { HOME: '/h' })
    const files = new Map<string, string>([
      [
        '/repo/Evals/prompts.jsonl',
        [
          '{"prompt":"rename x","tier":"haiku","effort":"low","why":"mechanical"}',
          '',
          '{"prompt":"design y","tier":"opus","effort":"high","why":"design"}',
          '{"prompt":"prove z","tier":"fable","effort":"xhigh","why":"research"}',
          '{"prompt":"add w","tier":"sonnet","effort":"high","why":"routine"}',
        ].join('\n'),
      ],
    ])
    on('fs.read', (_, e) => {
      const text = files.get(e.path)
      return text === undefined ? { deny: 'ENOENT' } : { value: text }
    })
    on('fs.write', (_, e) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })
    const verdicts: Record<string, [string, string]> = {
      'rename x': ['trivial', 'recall-or-lookup'],
      'design y': ['complex', 'routine-reasoning'],
      'prove z': ['exceptionally-hard', 'hard-open-problem'],
      'add w': ['standard', 'tricky-problem'],
    }
    on('model.classify', (_, e) => {
      now += 4000
      const [tier, effort] = verdicts[e.text]!
      return { value: (e.labels as readonly string[]).includes('complex') ? tier : effort }
    })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const r = await $.command.run({ command: 'tier', args: 'eval Evals/prompts.jsonl', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const run = JSON.parse(files.get('/repo/Evals/last-run.json') ?? '{}') as EvalRun

    expect(run.cases).toBe(4)
    expect(run.tierAccuracy).toBe(1)
    expect(run.effortAccuracy).toBe(0.75)
    expect(run.results.map(x => x.got)).toEqual([
      { tier: 'haiku', effort: 'low' },
      { tier: 'opus', effort: 'medium' },
      { tier: 'fable', effort: 'xhigh' },
      { tier: 'sonnet', effort: 'high' },
    ])
    expect(run.timeouts).toEqual({ tier: 0, effort: 0 })
    expect(run.latencyMs).toEqual({ p50: 8000, p90: 8000, max: 8000 })
    expect(run.overProductionTimeout).toEqual({ timeoutMs: 3000, count: 4 })
    expect(r.text).toContain('tier accuracy 1, effort accuracy 0.75')
    expect(r.text).toContain('miss: design y: tier opus (want opus), effort medium (want high)')
  })

  test('a malformed line is reported, not run', async ($, on) => {
    on('ui.status', () => ({ value: undefined }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
    on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
    on('command.register', () => ({ value: { command: 'tier' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.read', () => ({ value: '{"prompt":"x","tier":"ultra","effort":"low"}' }))
    let classified = 0
    on('model.classify', () => {
      classified += 1
      return { value: 'trivial' }
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const r = await $.command.run({ command: 'tier', args: 'eval /e/p.jsonl', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    expect(r.text).toContain('cannot read /e/p.jsonl: line 1')
    expect(classified).toBe(0)
  })
})
