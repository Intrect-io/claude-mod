import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { HookStream, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import { LOG_FALLBACK_MAX_LINES, LOG_ROTATE_BYTES } from './log'
import type { LogLine } from './log'
import { summarizeLog } from './stats'

type On = Parameters<TestBody>[1]
const LOG = '/h/.claude/model-tier.log'
const NOW = Date.parse('2026-11-04T12:00:00Z')
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }

async function drain(stream: HookStream<TurnStepChunk, TurnStepResult>) {
  for (;;) {
    const r = await stream.next()
    if (r.done) return r.value
  }
}

const answered = (e: TurnStepInput, model: string, tokens: number): TurnStepResult => ({
  turnId: e.turnId,
  index: e.index,
  answer: 'ok',
  toolUses: [],
  stopReason: 'end_turn',
  usage: { model, input_tokens: 10, output_tokens: 7, cache_read_input_tokens: tokens - 10 - 100, cache_creation_input_tokens: 100 },
})

/** A started session whose files live in a map; `shell` makes process.run append the way `sh` would. */
async function world($: Parameters<TestBody>[0], on: On, o: { shell: boolean; files?: Map<string, string> }) {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/h' })
  on('ui.status', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('tool.register', () => ({ value: { tool: 'mcp__model-tier__set_tier' } }))
  on('command.register', () => ({ value: { command: 'tier' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const files = o.files ?? new Map<string, string>()
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  const rewrites: string[] = []
  on('fs.write', (_, e) => {
    if (e.path === LOG) rewrites.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  const runs: Array<{ argv: readonly string[]; stdin?: string }> = []
  on('process.run', (_, e) => {
    if (!o.shell) return { deny: 'no shell here' }
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const path = e.argv[4]!
    files.set(path, (files.get(path) ?? '') + (e.init?.stdin ?? ''))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const lines = () =>
    (files.get(LOG) ?? '')
      .split('\n')
      .filter(l => l !== '')
      .map(l => JSON.parse(l) as LogLine)
  // Log lines go out after the hook returned.
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1))
  }
  return { files, runs, rewrites, lines, settle }
}

const at = (iso: string) => `2026-11-04T${iso}Z`
const FIXTURE: LogLine[] = [
  // Older than the window: ignored.
  { ts: '2026-10-01T00:00:00Z', event: 'prompt', tier: 'haiku', effort: 'low', from: { tier: 'opus', effort: 'high' }, verdict: { tier: 'haiku', effort: 'low' }, wantTier: true, waited: true, timedOut: false, ms: 99, tokens: 0 },
  { ts: at('10:00:00'), event: 'prompt', tier: 'opus', effort: 'high', from: { tier: 'opus', effort: 'high' }, verdict: { tier: null, effort: 'high' }, wantTier: false, waited: true, timedOut: false, ms: 1000, tokens: 400000 },
  { ts: at('10:05:00'), event: 'prompt', tier: 'sonnet', effort: 'medium', from: { tier: 'opus', effort: 'high' }, verdict: { tier: 'sonnet', effort: 'medium' }, wantTier: true, waited: true, timedOut: false, ms: 2000, tokens: 50000 },
  { ts: at('10:10:00'), event: 'prompt', tier: 'sonnet', effort: null, from: { tier: 'sonnet', effort: null }, verdict: { tier: null, effort: null }, wantTier: true, waited: true, timedOut: true, ms: null, tokens: 60000 },
  { ts: at('10:10:04'), event: 'classifier-late', ms: 4000, applied: true, waited: true, wantTier: true },
  { ts: at('10:10:01'), event: 'classifier-timeout', classifier: 'tier', ranMs: 3000, kept: { tier: 'sonnet', effort: null } },
  { ts: at('10:06:00'), event: 'switch', from: 'claude-opus-5-5', to: 'claude-sonnet-5-5', tokens: 50000 },
  { ts: at('10:07:00'), event: 'spawn', agent: 'general-purpose', tier: 'haiku', timedOut: false, ms: 3000 },
  { ts: at('10:08:00'), event: 'spawn', agent: 'general-purpose', tier: null, timedOut: true, ms: null },
  { ts: at('10:09:00'), event: 'turn', models: { 'claude-opus-5-5': { requests: 2, promptTokens: 800000, cacheWriteTokens: 1000, outputTokens: 300 } } },
  { ts: at('10:11:00'), event: 'turn', models: { 'claude-opus-5-5': { requests: 1, promptTokens: 400000, cacheWriteTokens: 0, outputTokens: 50 }, 'claude-sonnet-5-5': { requests: 3, promptTokens: 150000, cacheWriteTokens: 50000, outputTokens: 900 } } },
]

describe('/tier stats', () => {
  test('tier stats: summarizeLog counts prompts, picks, skipped tier classifications, switches, latency, spawns and tokens per model', () => {
    const s = summarizeLog(FIXTURE, Date.parse('2026-11-04T00:00:00Z'))
    expect(s.prompts).toBe(3)
    expect(s.tierSkipped).toBe(1)
    expect(s.tiers).toEqual({ opus: 1, sonnet: 2 })
    expect(s.efforts).toEqual({ high: 1, medium: 1, session: 1 })
    expect(s.tierChanges).toBe(1)
    expect({ switches: s.switches, switchTokens: s.switchTokens }).toEqual({ switches: 1, switchTokens: 50000 })
    // In-time prompts 1000 and 2000, the in-time spawn 3000, the late label 4000.
    expect(s.latency).toEqual({ answers: 4, p50: 2000, p90: 4000 })
    expect({ late: s.late, timedOut: s.timedOut }).toEqual({ late: 1, timedOut: 2 })
    expect(s.spawns).toEqual({ haiku: 1, kept: 1 })
    expect(s.models).toEqual({
      'claude-opus-5-5': { requests: 3, promptTokens: 1200000, cacheWriteTokens: 1000, outputTokens: 350 },
      'claude-sonnet-5-5': { requests: 3, promptTokens: 150000, cacheWriteTokens: 50000, outputTokens: 900 },
    })
  })

  test('tier stats: /tier stats reads the rotated and the live log and keeps only the last days', async ($, on) => {
    const files = new Map<string, string>([
      [`${LOG}.1`, `${FIXTURE.slice(0, 5).map(l => JSON.stringify(l)).join('\n')}\n`],
      [LOG, `${FIXTURE.slice(5).map(l => JSON.stringify(l)).join('\n')}\nnot json\n`],
    ])
    await world($, on, { shell: true, files })

    const week = await $.command.run({ command: 'tier', args: 'stats', ...RUN })
    expect(week.text).toContain('last 7 days')
    expect(week.text).toContain('prompts classified: 3; tier classification skipped on 1 (33%)')
    expect(week.text).toContain('picks: tier sonnet 2, opus 1')
    expect(week.text).toContain('1 model switch on the main loop, 50k prompt tokens written again')
    expect(week.text).toContain('p50 2000 ms, p90 4000 ms; late 1, timed out 2')
    expect(week.text).toContain('subagent spawns routed: haiku 1, kept 1')
    expect(week.text).toContain('claude-opus-5-5: 3 requests (50%), 1.2M prompt tokens')

    // A window that holds only the oldest line's day is empty; 60 days takes it in.
    expect((await $.command.run({ command: 'tier', args: 'stats 0.01', ...RUN })).text).toContain('no log lines in the last 0.01 days')
    expect((await $.command.run({ command: 'tier', args: 'stats 60', ...RUN })).text).toContain('prompts classified: 4;')
    expect((await $.command.run({ command: 'tier', args: 'stats soon', ...RUN })).text).toBe('Usage: /tier stats [days]  (default 7)')
  })

  test('tier stats: a classified prompt, a routed spawn, a model switch and a finished turn each append one line through the shell; /tier eval appends none', async ($, on) => {
    on('model.classify', (_, e) => ({ value: (e.labels as readonly string[]).includes('complex') ? 'standard' : 'routine-reasoning' }))
    on('agent.spawn', (_, e) => ({ model: e.model ?? e.parentModel }))
    let answer = 'claude-opus-5-5'
    on('turn.step', async function* (_, e) {
      return answered(e, answer, 1000)
    })
    on('turn.complete', (_, e) => ({ text: e.answer }))
    const w = await world($, on, { shell: true })

    await $.prompt.submit({ text: 'Add a retry to the uploader', wait: false, origin: { kind: 'composer' } })
    await drain($.turn.step({ ...STEP }))
    answer = 'claude-sonnet-5-5'
    await drain($.turn.step({ ...STEP, index: 1 }))
    await $.agent.spawn({
      tool_use_id: 'toolu_1',
      prompt: 'find the config file',
      description: 'find config',
      subagentType: 'general-purpose',
      provider: { plugin: 'core', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
    await w.settle()

    expect(w.rewrites).toEqual([])
    expect(w.runs.every(r => r.argv[0] === 'sh' && r.argv[4] === LOG && r.argv[5] === String(LOG_ROTATE_BYTES))).toBe(true)
    expect(w.runs.every(r => r.stdin?.endsWith('\n') && r.stdin.split('\n').length === 2)).toBe(true)
    const lines = w.lines()
    expect(lines.map(l => l.event)).toEqual(['prompt', 'switch', 'spawn', 'turn'])
    expect(lines[0]).toMatchObject({ tier: 'sonnet', effort: 'medium', from: { tier: 'opus', effort: null }, verdict: { tier: 'sonnet', effort: 'medium' }, wantTier: true, timedOut: false })
    expect(typeof (lines[0] as { ms: unknown }).ms).toBe('number')
    expect(lines[1]).toMatchObject({ from: 'claude-opus-5-5', to: 'claude-sonnet-5-5', tokens: 1000 })
    expect(lines[2]).toMatchObject({ agent: 'general-purpose', tier: 'sonnet', timedOut: false })
    expect(lines[3]).toMatchObject({
      models: {
        'claude-opus-5-5': { requests: 1, promptTokens: 1000, cacheWriteTokens: 100, outputTokens: 7 },
        'claude-sonnet-5-5': { requests: 1, promptTokens: 1000, cacheWriteTokens: 100, outputTokens: 7 },
      },
    })

    // The eval labels through the same labelPrompt, but logs nothing.
    w.files.set('/e/p.jsonl', JSON.stringify({ prompt: 'x', tier: 'sonnet', effort: 'medium', why: '' }))
    const ran = await $.command.run({ command: 'tier', args: 'eval /e/p.jsonl', ...RUN })
    await w.settle()
    expect(ran.text).toContain('tier accuracy 1')
    expect(w.lines()).toHaveLength(4)
  })

  test('tier stats: without a shell the log is rewritten, keeping the last 5000 lines', async ($, on) => {
    on('model.classify', () => ({ value: 'trivial' }))
    const old = Array.from({ length: LOG_FALLBACK_MAX_LINES }, (_, i) => JSON.stringify({ ts: at('09:00:00'), event: 'classifier-late', ms: i, applied: true, waited: true, wantTier: true }))
    const files = new Map<string, string>([[LOG, `${old.join('\n')}\n`]])
    const w = await world($, on, { shell: false, files })

    await $.prompt.submit({ text: 'what time is it', wait: false, origin: { kind: 'composer' } })
    await w.settle()

    const lines = w.lines()
    expect(LOG_FALLBACK_MAX_LINES).toBeGreaterThanOrEqual(5000)
    expect(lines).toHaveLength(LOG_FALLBACK_MAX_LINES)
    expect(lines.at(-1)?.event).toBe('prompt')
    expect(lines[0]).toMatchObject({ ms: 1 })
  })
})
