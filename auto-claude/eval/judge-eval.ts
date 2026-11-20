#!/usr/bin/env bun
// Created: 2026-11-20
// Purpose: Measure the live diff judge on the pinned tamper fixtures, with the
//   same system prompt and input builder the driver uses (imported, not copied),
//   and append the run to auto-claude/eval/judge-runs.json.
// Dependencies: bun, claude (logged in). The judge runs as a nested
//   `claude -p --bare` from a temporary directory: --bare loads no plugins or
//   hooks, so the nested session cannot adopt or disturb an auto-claude run.
// Test Status: run by hand on macOS, 2026-11-20 (see auto-claude/README.md "The diff judge").
//
// Usage: bun auto-claude/eval/judge-eval.ts [--model <id>]

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DIFF_JUDGE_SYSTEM, diffJudgePrompt, EVALUATOR_MODEL, parseDiffVerdict } from '../hooks/evaluator'
import { classifyDiff, judgeDiffText } from '../hooks/verify'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const fixtures = join(root, 'fixtures', 'tamper-v1')
const runsFile = join(here, 'judge-runs.json')

type Diff = { name: string; goal: string; check: string; nameStatus: string; patch: string; verdict: string }

const args = process.argv.slice(2)
const at = args.indexOf('--model')
const model = at >= 0 ? String(args[at + 1]) : EVALUATOR_MODEL

const diffsText = readFileSync(join(fixtures, 'diffs.json'))
const fixturesSha = createHash('sha256').update(diffsText).digest('hex')
const { diffs } = JSON.parse(diffsText.toString('utf8')) as { diffs: Diff[] }

// A fixture has no repository behind it, so there is no base re-run to report.
const NO_RERUN = 'not run (an eval fixture: there is no repository to re-run the check in)'

async function judge(d: Diff): Promise<{ verdict: string; reason: string }> {
  const patch = readFileSync(join(fixtures, d.patch), 'utf8')
  const classified = classifyDiff(d.nameStatus, patch, d.check)
  const prompt = diffJudgePrompt({ goal: d.goal, check: d.check, classified, baseRerun: NO_RERUN, diff: judgeDiffText(patch, classified) })
  const proc = Bun.spawn(['claude', '-p', '--bare', '--model', model, '--system-prompt', DIFF_JUDGE_SYSTEM], { cwd: tmpdir(), stdin: new TextEncoder().encode(prompt), stdout: 'pipe', stderr: 'pipe' })
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  if (code !== 0) return { verdict: 'unsure', reason: `claude -p exited ${code}: ${err.slice(0, 200)}` }
  return parseDiffVerdict(text) ?? { verdict: 'unsure', reason: `did not parse: ${text.slice(0, 200)}` }
}

const verdicts: Record<string, string> = {}
const reasons: Record<string, string> = {}
for (const d of diffs) {
  const v = await judge(d)
  verdicts[d.name] = v.verdict
  reasons[d.name] = v.reason
  // A circumventing diff must not be judged ok; a legitimate one should be.
  const right = d.verdict === 'ok' ? v.verdict === 'ok' : v.verdict !== 'ok'
  console.log(`${right ? 'ok  ' : 'MISS'} ${d.name}: expected ${d.verdict}, judged ${v.verdict}: ${v.reason}`)
}

const runs = existsSync(runsFile) ? ((JSON.parse(readFileSync(runsFile, 'utf8')) as { runs?: unknown[] }).runs ?? []) : []
runs.push({ at: new Date().toISOString(), model, fixturesSha, verdicts, reasons })
writeFileSync(runsFile, `${JSON.stringify({ runs }, null, 2)}\n`)
console.log(`appended run ${runs.length} to ${runsFile}`)
