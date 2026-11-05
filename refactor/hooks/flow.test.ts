import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const PRESENTATION = { isFullscreen: false, columns: 80 }
const STOP = { stop_hook_active: false, last_assistant_message: 'done', transcript_path: '/tmp/s.jsonl' }

const ARCH = JSON.stringify({
  layers: [
    { name: 'domain', paths: ['src/domain/**'] },
    { name: 'app', paths: ['src/app/**'] },
    { name: 'api', paths: ['src/api/**'] },
  ],
  allow: { api: ['app', 'domain'], app: ['domain'], domain: [] },
  forbidImports: [{ layer: 'domain', pattern: '^fastapi' }],
})

type World = { files: Map<string, string>; ran: string[]; diff: string; untracked: string; completions: string[]; reply: string }

// A repo at /repo: tools answer 'ok' and record that they ran.
function world(on: On, withArch = true): World {
  const w: World = { files: new Map(), ran: [], diff: '', untracked: '', completions: [], reply: 'none' }
  if (withArch) w.files.set('/repo/.claude/architecture.json', ARCH)
  mock.store(on, {})
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', (_, e) => {
    const argv = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv.includes('rev-parse')) return out('/repo\n')
    if (argv.includes('diff') && argv.includes('--name-only')) return out(w.diff)
    if (argv.includes('diff')) return out(w.diff === '' ? '' : `diff --git a/${w.diff.trim()}\n+added`)
    if (argv.includes('--others')) return out(w.untracked)
    if (argv.includes('ls-files')) return out([...w.files.keys()].map(path => path.replace('/repo/', '')).join('\n'))
    return out('', 1)
  })
  on('model.complete', (_, e) => {
    w.completions.push(e.prompt as string)
    return { value: { isAnswered: true as const, text: w.reply, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('tool.call', (_, e) => {
    w.ran.push(e.tool)
    return { result: 'ok' }
  })

  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const arch = ($: Engine, args: string) => $.command.run({ command: 'arch', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

describe('edit-time enforcement', () => {
  test('an Edit that adds an import across layers is refused; a same-layer one passes', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/src/app/service.ts', "import { o } from '../domain/order'\nexport const run = () => o\n")
    await start($)

    const bad = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app/service.ts', old_string: 'export const run', new_string: "import { r } from '../api/routes'\nexport const run" })
    expect(bad.deny).toContain('layer app')
    expect(bad.deny).toContain('layer api')
    expect(bad.deny).toContain('https://refactoring.guru/move-method')
    expect(w.ran).toEqual([])

    const good = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app/service.ts', old_string: 'export const run', new_string: "import { h } from './helper'\nexport const run" })
    expect(good.deny).toBeUndefined()
    expect(w.ran).toEqual(['Edit'])
  })

  test('a Write of a new domain file importing fastapi is refused (Python, forbidImports)', async ($, on) => {
    world(on)
    await start($)
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/src/domain/order.py', content: 'import fastapi\n' })
    expect(result.deny).toContain('forbidImports')
  })

  test('an existing violation does not block an unrelated edit', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/src/app/legacy.ts', "import { r } from '../api/routes'\nexport const x = 1\n")
    await start($)
    const result = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app/legacy.ts', old_string: 'x = 1', new_string: 'x = 2' })
    expect(result.deny).toBeUndefined()
    expect(w.ran).toEqual(['Edit'])
  })

  test('an undeclared alias passes with a note; no architecture file enforces nothing', async ($, on) => {
    world(on)
    await start($)
    const alias = await $.tool.call({ tool: 'Write', file_path: '/repo/src/app/a.ts', content: "import { r } from '@/api/routes'\n" })
    expect(alias.deny).toBeUndefined()
    expect(alias.context?.join('\n')).toContain('declare the alias under "packages"')
  })

  test('without an architecture file nothing is refused', async ($, on) => {
    world(on, false)
    await start($)
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/src/app/a.ts', content: "import { r } from '../api/routes'\n" })
    expect(result.deny).toBeUndefined()
  })

  test('a long function with many parameters passes with a smell note', async ($, on) => {
    world(on)
    await start($)
    const body = Array.from({ length: 80 }, (_, i) => `    v${i} = ${i}`).join('\n')
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/src/app/big.py', content: `def big(a, b, c, d, e, f, g):\n${body}\n    return a\n` })
    expect(result.deny).toBeUndefined()
    const note = result.context?.join('\n') ?? ''
    expect(note).toContain('Long Method')
    expect(note).toContain('Long Parameter List')
    expect(note).toContain('https://refactoring.guru/smells/long-method')
  })

  test('/arch off arch stops refusals and is kept across sessions', async ($, on) => {
    world(on)
    await start($)
    expect((await arch($, 'off arch')).text).toContain('arch off')
    await start($)
    const result = await $.tool.call({ tool: 'Write', file_path: '/repo/src/domain/x.ts', content: "import { s } from '../app/s'\n" })
    expect(result.deny).toBeUndefined()
  })
})

describe('session start and stop', () => {
  test('the rules are told to the model at session start', async ($, on) => {
    world(on)
    await start($)
    const result = await $.classic.SessionStart({ source: 'startup' } as never)
    expect(result.additionalContext?.join('\n')).toContain('app (src/app/**) → may import domain')
  })

  test('a violation written by Bash is noted once at stop', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/src/domain/d.ts', "import { s } from '../app/s'\n")
    w.diff = 'src/domain/d.ts\n'
    await start($)
    const first = await $.classic.Stop(STOP)
    expect(first.block).toBeUndefined()
    expect(first.additionalContext?.join('\n')).toContain('src/domain/d.ts:1')
    const second = await $.classic.Stop(STOP)
    expect(second.additionalContext).toBeUndefined()
  })

  test('the model review is off by default and runs once per diff when on', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/src/app/ok.ts', 'export const ok = 1\n')
    w.diff = 'src/app/ok.ts\n'
    w.reply = 'src/app/ok.ts:1 — Dead Code — Remove it'
    await start($)
    await $.classic.Stop(STOP)
    expect(w.completions).toHaveLength(0)
    await arch($, 'on llm-review')
    const stop = await $.classic.Stop(STOP)
    expect(stop.additionalContext?.join('\n')).toContain('Dead Code')
    await $.classic.Stop(STOP)
    expect(w.completions).toHaveLength(1)
  })
})

describe('/arch', () => {
  test('status, catalog, audit and init', async ($, on) => {
    const w = world(on)
    w.files.set('/repo/src/app/a.ts', "import { b } from './b'\nimport { r } from '../api/r'\n")
    w.files.set('/repo/src/app/b.ts', "import { a } from './a'\n")
    w.files.set('/repo/src/api/r.ts', "import { a } from '../app/a'\n")
    await start($)
    expect((await arch($, '')).text).toContain('arch on · smells on')
    expect((await arch($, 'catalog long method')).text).toContain('Extract Method')
    const audit = (await arch($, 'audit')).text
    expect(audit).toContain('Layer violations (1)')
    expect(audit).toContain('api ⇄ app')
    expect(audit).toContain('File import cycles (1)')
    const init = (await arch($, 'init')).text
    expect(init).toContain('"name": "app"')
    expect(init).toContain('already exists')
  })

  test('audit ranks files worst first and leaves tests out; fix hands the worst file to the model', async ($, on) => {
    const w = world(on, false)
    const body = (n: number) => Array.from({ length: n }, (_, i) => `    x${i} = ${i}`).join('\n')
    w.files.set('/repo/pkg/small.py', `def a():\n${body(70)}\n`)
    w.files.set('/repo/pkg/big.py', `def b():\n${body(300)}\n`)
    w.files.set('/repo/tests/test_big.py', `def t():\n${body(400)}\n`)
    const clock = mock.clock(on, { now: 0 })
    const submitted: string[] = []
    on('prompt.submit', (_, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })
    await start($)
    const audit = (await arch($, 'audit')).text
    expect(audit).toContain('1. pkg/big.py')
    expect(audit).toContain('2. pkg/small.py')
    expect(audit).not.toContain('tests/test_big.py')
    expect(audit).toContain('/arch fix')
    expect((await arch($, 'fix')).text).toContain('handed pkg/big.py')
    await clock.advance(100)
    expect(submitted[0]).toContain('Refactor pkg/big.py')
    expect(submitted[0]).toContain('refactor-catalog')
    expect((await arch($, 'fix pkg/small.py')).text).toContain('handed pkg/small.py')
  })
})
