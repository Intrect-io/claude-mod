import { describe, expect, test } from 'claude-code/testing'

import { addedViolations, auditRepo, cycles, draftArchitecture, globToRegExp, layerOf, parseArchitecture, resolveImport, violationsIn } from './arch'
import { findSmell, renderCatalog, slug, SMELLS, smellUrl, TECHNIQUES, techniqueUrl } from './catalog'
import { expandUseTree, extractImports, langOf } from './imports'
import { applyEdit } from './register'
import { duplicateRuns, functionsIn, smellNote, smellsIn } from './smells'

const LIMITS = parseArchitecture('{}').smells

const TS_ARCH = parseArchitecture(
  JSON.stringify({
    layers: [
      { name: 'domain', paths: ['src/domain/**'] },
      { name: 'app', paths: ['src/app/**'] },
      { name: 'api', paths: ['src/api/**'] },
    ],
    allow: { api: ['app', 'domain'], app: ['domain'], domain: [] },
    packages: { '@/': 'src/', intrect: 'pkg/intrect' },
    forbidImports: [{ layer: 'domain', pattern: '^(fastapi|express)' }],
  }),
)

describe('catalog', () => {
  test('every technique a smell names exists, and URLs follow the site', () => {
    const names = new Set(TECHNIQUES.map(t => t.name))
    for (const smell of SMELLS) for (const name of smell.techniques) expect(names.has(name)).toBe(true)
    expect(SMELLS).toHaveLength(23)
    expect(TECHNIQUES.length).toBeGreaterThan(60)
    expect(techniqueUrl('Replace Type Code with State/Strategy')).toBe('https://refactoring.guru/replace-type-code-with-state-strategy')
    expect(smellUrl('Long Method')).toBe('https://refactoring.guru/smells/long-method')
    expect(slug("Feature Envy")).toBe('feature-envy')
  })

  test('lookup by smell or technique, and the whole list', () => {
    expect(findSmell('long param')?.name).toBe('Long Parameter List')
    expect(renderCatalog('feature envy')).toContain('Move Method')
    expect(renderCatalog('extract interface')).toContain('Cures:')
    expect(renderCatalog('')).toContain('## Couplers')
    expect(renderCatalog('nonsense-xyz')).toContain('No smell')
  })
})

describe('imports', () => {
  test('language by extension', () => {
    expect(langOf('a/b.tsx')).toBe('ts')
    expect(langOf('x.py')).toBe('python')
    expect(langOf('src/lib.rs')).toBe('rust')
    expect(langOf('README.md')).toBeUndefined()
  })

  test('TypeScript: import, export from, require, dynamic import; comments ignored', () => {
    const text = [
      "import a from './a'",
      "import { b, c } from '../b'",
      "import type { T } from '@/domain/t'",
      "export * from './re'",
      "import './side'",
      "const x = require('lodash')",
      "const y = await import('./lazy')",
      "// import nope from './commented'",
      "/* import nope2 from './block' */",
      'import {',
      '  multi,',
      "} from './multi'",
    ].join('\n')
    expect(extractImports('ts', text).map(r => r.spec)).toEqual(['./a', '../b', '@/domain/t', './re', './side', 'lodash', './lazy', './multi'])
  })

  test('Python: from, relative, parenthesized lists, plain import, docstrings skipped', () => {
    const text = ['"""', 'import fake', '"""', 'import os, sys as system', 'from . import models, views', 'from ..core.x import (', '    A,', '    B,  # comment', ')', 'from pkg.mod import thing as t'].join('\n')
    const refs = extractImports('python', text)
    expect(refs.map(r => r.spec)).toEqual(['os', 'sys', '.', '..core.x', 'pkg.mod'])
    expect(refs[2]?.names).toEqual(['models', 'views'])
    expect(refs[3]?.names).toEqual(['A', 'B'])
  })

  test('Rust: use trees expand', () => {
    expect(expandUseTree('crate::a::{b,c::{d,e},self}')).toEqual(['crate::a::b', 'crate::a::c::d', 'crate::a::c::e', 'crate::a'])
    const refs = extractImports('rust', 'use std::io;\npub(crate) use crate::domain::Order as O;\nuse super::{x, y::*};')
    expect(refs.map(r => r.spec)).toEqual(['std::io', 'crate::domain::Order', 'super::x', 'super::y'])
  })
})

describe('arch', () => {
  test('globs: dir/** matches the dir and below, * stays in a segment', () => {
    expect(globToRegExp('src/app/**').test('src/app')).toBe(true)
    expect(globToRegExp('src/app/**').test('src/app/x/y.ts')).toBe(true)
    expect(globToRegExp('src/app/**').test('src/application/x.ts')).toBe(false)
    expect(globToRegExp('**/models/*.py').test('a/b/models/m.py')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false)
  })

  test('a malformed file drops the broken parts and names them', () => {
    const arch = parseArchitecture(JSON.stringify({ layers: [{ name: 'a', paths: ['a/**'] }, { name: 'b' }], allow: { a: ['zzz'] }, forbidImports: [{ layer: 'a', pattern: '(' }] }))
    expect(arch.layers.map(l => l.name)).toEqual(['a'])
    expect(arch.allow.a).toBeUndefined()
    expect(arch.problems.length).toBe(3)
    expect(parseArchitecture('{not json').problems[0]).toContain('not valid JSON')
  })

  test('TypeScript: relative and declared aliases resolve, packages do not', () => {
    expect(layerOf(TS_ARCH, 'src/app/service.ts')).toBe('app')
    expect(resolveImport(TS_ARCH, 'ts', 'src/app/service.ts', { spec: '../api/routes', line: 1 })?.[0]).toBe('src/api/routes')
    expect(resolveImport(TS_ARCH, 'ts', 'src/app/service.ts', { spec: '@/domain/order', line: 1 })?.[0]).toBe('src/domain/order')
    expect(resolveImport(TS_ARCH, 'ts', 'src/app/service.ts', { spec: 'react', line: 1 })).toBeUndefined()
    expect(resolveImport(TS_ARCH, 'ts', 'src/app/service.ts', { spec: '~/x', line: 1 })).toBeUndefined()
  })

  test('direction violations, same-layer imports, forbidden packages', () => {
    const app = "import { r } from '../api/routes'\nimport { o } from '@/domain/order'\nimport { h } from './helper'\nimport x from 'react'"
    const found = violationsIn(TS_ARCH, 'src/app/service.ts', app)
    expect(found.map(v => [v.spec, v.toLayer])).toEqual([['../api/routes', 'api']])
    const domain = violationsIn(TS_ARCH, 'src/domain/order.ts', "import express from 'express'\nimport { s } from '../app/s'")
    expect(domain.map(v => v.kind)).toEqual(['forbidden', 'direction'])
    // A file in no layer is not judged.
    expect(violationsIn(TS_ARCH, 'scripts/x.ts', "import { r } from '../src/api/routes'")).toEqual([])
  })

  test('an edit is judged on the violations it adds', () => {
    const before = "import { r } from '../api/routes'\nexport const a = 1\n"
    expect(addedViolations(TS_ARCH, 'src/app/s.ts', before, `${before}export const b = 2\n`)).toEqual([])
    expect(addedViolations(TS_ARCH, 'src/app/s.ts', before, `${before}import { q } from '../api/other'\n`).map(v => v.spec)).toEqual(['../api/other'])
  })

  test('Python: relative imports and declared packages', () => {
    const arch = parseArchitecture(
      JSON.stringify({
        layers: [
          { name: 'domain', paths: ['svc/domain/**'] },
          { name: 'api', paths: ['svc/api/**'] },
        ],
        allow: { domain: [], api: ['domain'] },
        packages: { svc: 'svc' },
        forbidImports: [{ layer: 'domain', pattern: '^fastapi' }],
      }),
    )
    const text = 'from ..api import routes\nfrom svc.api.deps import get\nfrom . import entity\nimport fastapi\nimport numpy'
    const found = violationsIn(arch, 'svc/domain/order.py', text)
    expect(found.map(v => `${v.kind}:${v.spec}`)).toEqual(['direction:..api', 'direction:svc.api.deps', 'forbidden:fastapi'])
    expect(violationsIn(arch, 'svc/api/routes.py', 'from ..domain import order')).toEqual([])
  })

  test('Rust: crate, super and self within the crate; external crates unjudged', () => {
    const arch = parseArchitecture(
      JSON.stringify({
        layers: [
          { name: 'dsp', paths: ['plugin/src/dsp/**', 'plugin/src/dsp.rs'] },
          { name: 'ui', paths: ['plugin/src/ui/**'] },
        ],
        allow: { dsp: [], ui: ['dsp'] },
      }),
    )
    expect(violationsIn(arch, 'plugin/src/dsp/filter.rs', 'use crate::ui::Editor;\nuse nih_plug::prelude::*;\nuse super::buffer::Buf;').map(v => v.spec)).toEqual(['crate::ui::Editor'])
    expect(violationsIn(arch, 'plugin/src/dsp/mod.rs', 'use super::ui::Knob;').map(v => v.spec)).toEqual(['super::ui::Knob'])
    expect(violationsIn(arch, 'plugin/src/ui/knob.rs', 'use crate::dsp::filter::Svf;')).toEqual([])
  })

  test('audit: violations, layer cycles and file cycles', () => {
    const files = new Map([
      ['src/app/a.ts', "import { b } from './b'\nimport { r } from '../api/r'"],
      ['src/app/b.ts', "import { a } from './a'"],
      ['src/api/r.ts', "import { a } from '../app/a'"],
      ['src/domain/d.ts', ''],
    ])
    const audit = auditRepo(TS_ARCH, files)
    expect(audit.violations).toHaveLength(1)
    expect(audit.layerCycles).toEqual([['api', 'app']])
    expect(audit.fileCycles.map(c => c.length).sort()).toEqual([3])
    expect(cycles(new Map([['x', new Set(['y'])]]))).toEqual([])
  })

  test('init drafts layers from directory names', () => {
    const draft = JSON.parse(draftArchitecture(['src/domain/order.ts', 'src/services/pay.ts', 'src/api/routes.ts', 'src/db/repo.ts', 'README.md']))
    expect(draft.layers.map((l: { name: string }) => l.name)).toEqual(['domain', 'app', 'infra', 'interface'])
    expect(draft.allow.domain).toEqual([])
    expect(draft.allow.interface).toEqual(['domain', 'app', 'infra'])
    expect(draft.allow.infra).toEqual(['domain', 'app'])
  })
})

describe('smells', () => {
  const long = (lines: number) => Array.from({ length: lines }, (_, i) => `  const v${i} = ${i}`).join('\n')

  test('TypeScript functions: declarations, arrows and methods with params and nesting', () => {
    const text = [
      'export function alpha(a: number, b: string) {',
      '  if (a) {',
      '    for (const x of b) {',
      '      if (x) { return 1 }',
      '    }',
      '  }',
      '}',
      'const beta = async (x: number) => {',
      "  const s = '{'",
      '  return x',
      '}',
      'class K {',
      '  gamma(a: A, b: B, c: C) {',
      '    return a',
      '  }',
      '}',
    ].join('\n')
    const fns = functionsIn('ts', text)
    expect(fns.map(f => [f.name, f.params, f.start, f.end])).toEqual([
      ['alpha', 2, 1, 7],
      ['beta', 1, 8, 11],
      ['gamma', 3, 13, 15],
    ])
    expect(fns[0]?.nesting).toBe(3)
  })

  test('a call whose last argument is a function is not a method named after the callee', () => {
    const text = ["on('x', { a: 1 }, async ($, e) => {", '  return 1', '})', "on('y', async function* ($, e, next) {", '  yield 1', '})'].join('\n')
    expect(functionsIn('ts', text).map(f => f.name)).not.toContain('on')
  })

  test('Python functions by indentation; self and cls do not count', () => {
    const text = ['class A:', '    def m(self, a, b,', '          c):', '        if a:', '            for x in b:', '                pass', '        return 1', '', 'def top(x):', '    return x'].join('\n')
    const fns = functionsIn('python', text)
    expect(fns.map(f => [f.name, f.params, f.start, f.end, f.nesting])).toEqual([
      ['m', 3, 2, 7, 2],
      ['top', 1, 9, 10, 0],
    ])
  })

  test('Rust functions; self does not count; trait declarations skipped', () => {
    const text = ['trait T { fn decl(&self, a: u8); }', 'impl X {', '    fn run(&mut self, a: u8, b: Vec<(u8, u8)>) -> u8 {', '        a', '    }', '}'].join('\n')
    expect(functionsIn('rust', text).map(f => [f.name, f.params])).toEqual([['run', 2]])
  })

  test('limits produce findings with the catalog advice; only touched functions count', () => {
    const text = `function big(a, b, c, d, e, f, g) {\n${long(70)}\n}\nfunction small() {\n  return 1\n}`
    const all = smellsIn('ts', text, LIMITS)
    expect(all.map(f => f.smell)).toEqual(['Long Method', 'Long Parameter List'])
    expect(smellsIn('ts', text, LIMITS, { from: 74, to: 75 })).toEqual([])
    const note = smellNote('src/x.ts', all) as string
    expect(note).toContain('https://refactoring.guru/smells/long-method')
    expect(note).toContain('Introduce Parameter Object')
    expect(note).toContain('nothing was refused')
  })

  test('duplicate runs of non-trivial lines', () => {
    const block = ['const a = load(x)', 'const b = parse(a)', 'const c = check(b)', 'save(c, target)', 'log(c.id)', 'notify(c.owner)']
    const text = [...block, 'other()', ...block].join('\n')
    expect(duplicateRuns(text, 6)).toEqual([{ first: 1, second: 8 }])
    expect(duplicateRuns(block.join('\n'), 6)).toEqual([])
  })
})

describe('applyEdit', () => {
  test('Edit, replace_all, an edits array and Write; a non-matching edit is undefined', () => {
    const before = 'a\nb\nc\nb\n'
    expect(applyEdit('Edit', { old_string: 'c', new_string: 'C\nD' }, before)).toEqual({ after: 'a\nb\nC\nD\nb\n', touched: { from: 3, to: 4 } })
    expect(applyEdit('Edit', { old_string: 'b', new_string: 'B', replace_all: true }, before)?.after).toBe('a\nB\nc\nB\n')
    expect(applyEdit('Edit', { edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'Z' }] }, before)?.after).toBe('A\nb\nZ\nb\n')
    expect(applyEdit('Write', { content: 'x\ny' }, before)).toEqual({ after: 'x\ny', touched: { from: 1, to: 2 } })
    expect(applyEdit('Edit', { old_string: 'zzz', new_string: 'q' }, before)).toBeUndefined()
  })
})
