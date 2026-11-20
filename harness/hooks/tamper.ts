// Test tampering: text written into a test file that makes a failing test
// report success, or that quietly weakens it. Pure, so it also runs under plain
// bun (fixtures/tamper-v1/run.ts) with no engine.
//
// The patterns come from published reward hacks by coding agents: METR's
// "Recent reward hacking" (2025-06), Anthropic's "Natural emergent misalignment
// from reward hacking" (a conftest.py that patches TestReport, an object whose
// __eq__ is always True, sys.exit(0) before the asserts) and ImpossibleBench
// (arXiv 2510.20270). A prompt telling the model not to cheat barely changes the
// rate, so the check is made at the tool call instead.
//
// deny: deterministic, and a legitimate test never needs it.
// note: a legitimate change can do it too (a skip with a reason, a test made
// smaller on purpose), so the model is told and nothing is refused.

import { isTestPath, writesTestFile } from './doc-guards'

type Pattern = { name: string; pattern: RegExp }

const DENY: Pattern[] = [
  { name: 'a pytest_runtest_makereport hook that sets the report outcome', pattern: /def\s+pytest_runtest_makereport\b[\s\S]*?\.outcome\s*=/ },
  { name: 'a patch of TestReport.from_item_and_call', pattern: /\bTestReport\.from_item_and_call\s*=/ },
  { name: 'an __eq__ that always returns True', pattern: /def\s+__eq__\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*(?:#[^\n]*)?\n\s*return\s+True\s*(?:#[^\n]*)?(?=\n|$)/ },
  { name: 'an __ne__ that always returns False', pattern: /def\s+__ne__\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*(?:#[^\n]*)?\n\s*return\s+False\s*(?:#[^\n]*)?(?=\n|$)/ },
  { name: 'sys.exit(0), which ends the run before the asserts', pattern: /\bsys\.exit\(\s*0?\s*\)/ },
  { name: 'os._exit, which ends the run before the asserts', pattern: /\bos\._exit\s*\(/ },
  { name: 'process.exit(0), which ends the run before the asserts', pattern: /\bprocess\.exit\(\s*0?\s*\)/ },
]

const NOTE: Pattern[] = [
  { name: 'a skip or xfail marker', pattern: /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\(|@unittest\.skip/ },
  { name: 'a .skip or .only test', pattern: /\b(?:it|test|describe)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|fit|fdescribe)\s*\(/ },
  { name: 'assert True', pattern: /^\s*assert\s+True\s*(?:#[^\n]*)?$/m },
  { name: 'expect(true)', pattern: /\bexpect\(\s*true\s*\)/ },
]

// One assertion per matching line, as fixtures/tamper-v1/README.md counts them.
const ASSERTION = /^\s*assert\b|\bself\.assert[A-Z]\w*\(|\bexpect\(|\bassert\.\w+\(|\bpytest\.raises\(/

function assertions(texts: readonly string[]): number {
  return texts.join('\n').split('\n').filter(line => ASSERTION.test(line)).length
}

export type TamperVerdict = { deny?: string; note?: string }

function denyText(where: string, found: string): string {
  return `Harness rule (test tampering): ${where} holds ${found}. That makes a failing test report success, so the check it feeds proves nothing. Make the code meet the test; if the test or the spec is wrong, say so (in an auto-claude run, defer the milestone) instead of changing how it is judged.`
}

function noteText(where: string, found: string[]): string {
  return `harness note (test tampering): ${where} now has ${found.join(' and ')}. Nothing was refused. If this weakens a test so a check passes, undo it and fix the code; if it is intended, say why in the commit message.`
}

// An Edit/Write of a test file. `texts` is the new text, `oldTexts` the text it
// replaces when known (an Edit's old_string).
export function checkTestTamper(path: string, texts: readonly string[], oldTexts?: readonly string[]): TamperVerdict {
  if (!isTestPath(path)) return {}
  const text = texts.join('\n')
  const deny = DENY.find(entry => entry.pattern.test(text))
  if (deny !== undefined) return { deny: denyText(path, deny.name) }
  const notes = NOTE.filter(entry => entry.pattern.test(text)).map(entry => entry.name)
  if (oldTexts !== undefined && oldTexts.length > 0) {
    const before = assertions(oldTexts)
    const after = assertions(texts)
    if (after < before) notes.push(`fewer assertions (${before} → ${after})`)
  }

  return notes.length === 0 ? {} : { note: noteText(path, notes) }
}

// A shell command that writes a test file is judged on its whole text.
export function checkTestTamperBash(command: string): TamperVerdict {
  if (!writesTestFile(command)) return {}
  const deny = DENY.find(entry => entry.pattern.test(command))
  if (deny !== undefined) return { deny: denyText('this command writes a test file that', deny.name) }
  const notes = NOTE.filter(entry => entry.pattern.test(command)).map(entry => entry.name)

  return notes.length === 0 ? {} : { note: noteText('a test file this command writes', notes) }
}

// The old text an Edit/MultiEdit replaces.
export function replacedTexts(input: Record<string, unknown>): string[] {
  const texts: string[] = []
  if (typeof input.old_string === 'string') texts.push(input.old_string)
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      const value = (edit as Record<string, unknown> | null)?.old_string
      if (typeof value === 'string') texts.push(value)
    }
  }

  return texts
}
