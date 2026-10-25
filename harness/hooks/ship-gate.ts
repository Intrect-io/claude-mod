import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PendingIssue } from '../types'
import { mergedWorktreeNote } from './extra-guards'
import { grantAllowsLinear, readGrant } from './grant'
import { heartbeatOn } from './heartbeat'
import { checkListIssues, checkSaveComment, checkSaveIssue, isLinearRequest, repoTeam, withoutReminders } from './linear-guard'
import type { LinearFacts } from './linear-guard'
import { commandWords, programOf, segments, stripProse } from './shell'
import { DEFAULT_TOGGLES, INITIAL_LINT, INITIAL_SHIP } from './state'
import type { PromptHook, StopHook } from './state'

const shipAtom = atom({ plugin: 'harness', key: 'ship' } as const, INITIAL_SHIP, { shape: 'ship-2' })
const togglesAtom = atom({ plugin: 'harness', key: 'toggles' } as const, DEFAULT_TOGGLES, { shape: 'toggles-1' })
const lintAtom = atom({ plugin: 'harness', key: 'lint' } as const, INITIAL_LINT, { shape: 'lint-1' })
const envAtom = atom({ plugin: 'harness', key: 'env' } as const, {}, { shape: 'env-1' })

// Merge and release gate (rules/linear-grooming.md §5, CLAUDE.md §5):
// - after `gh pr merge`, every issue the user handed over in this session and
//   named by that PR must get a Done transition and an evidence comment before
//   the turn may stop (2026-07-08: three misses in a row);
// - an irreversible release or deploy needs `gh pr list` (open PRs) and a
//   CodeQL run first (2026-07-09 release without a PR; 2026-08-14 CodeQL found
//   four real defects), unless the user waived CodeQL for this session.

type On = Parameters<Register>[0]

const MAX_STOP_BLOCKS = 2
const ISSUE_ID = /\b[A-Z][A-Z0-9]{1,5}-\d+\b/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function issueIds(text: string): string[] {
  return [...new Set(text.match(ISSUE_ID) ?? [])]
}

// `gh pr merge [n]` in a command: the PR's number or branch, or '' for the
// current branch's PR; undefined when the command merges nothing.
export function mergedPr(command: string): string | undefined {
  for (const segment of segments(stripProse(command))) {
    const words = commandWords(segment)
    if (programOf(words) === 'gh' && words[1] === 'pr' && words[2] === 'merge') {
      return words.slice(3).find(word => !word.startsWith('-')) ?? ''
    }
  }

  return undefined
}

export function isReleaseCommand(command: string): boolean {
  for (const segment of segments(stripProse(command))) {
    const words = commandWords(segment)
    const program = programOf(words)
    const sub = words.slice(1).join(' ')
    if (program === 'gh' && /^release create\b/.test(sub)) return true
    if (program === 'git' && words[1] === 'push' && (words.includes('--tags') || words.slice(2).some(word => /^(refs\/tags\/)?v\d/.test(word)))) {
      return true
    }
    if ((program === 'npm' || program === 'pnpm' || program === 'yarn') && words[1] === 'publish') return true
    if (program === 'cargo' && words[1] === 'publish') return true
    if ((program === 'fly' || program === 'flyctl') && words[1] === 'deploy') return true
    if (program === 'vercel' && words.includes('--prod')) return true
    if (program === 'gcloud' && words.includes('deploy')) return true
  }

  return false
}

export function isPrList(command: string): boolean {
  return segments(stripProse(command)).some(segment => {
    const words = commandWords(segment)

    return programOf(words) === 'gh' && words[1] === 'pr' && words[2] === 'list' && !words.some(word => /^--state(=|$)/.test(word) && !/open/.test(words.join(' ')))
  })
}

export function isCodeqlAnalyze(command: string): boolean {
  return segments(stripProse(command)).some(segment => {
    const words = commandWords(segment)

    return programOf(words) === 'codeql' && words[1] === 'database' && words[2] === 'analyze'
  })
}

export function isDoneState(state: unknown): boolean {
  if (typeof state !== 'string') return false

  // A state ID cannot be read here: any state change counts, with the comment.
  return /^(done|completed|closed)$/i.test(state.trim()) || /\bdone\b/i.test(state) || UUID.test(state.trim())
}

export function unresolved(pending: readonly PendingIssue[]): PendingIssue[] {
  return pending.filter(issue => !issue.done || !issue.commented)
}

export async function shipPrompt($: EngineInterface, e: Parameters<PromptHook>[1], next: Parameters<PromptHook>[2]) {
    if (e.agent_id === undefined) {
      const text = withoutReminders(e.prompt)
      const ids = issueIds(text)
      await update($, shipAtom, ship => ({
        ...ship,
        stopBlocks: 0,
        mentioned: [...new Set([...ship.mentioned, ...ids])],
        linearRequested: ship.linearRequested || isLinearRequest(text),
      }))
    }

    return next(e)
}

export function registerShipGate(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const toggles = await read($, togglesAtom)
    if (!toggles.shipGate) return next(e)
    const command = e.command

    if (isReleaseCommand(command)) {
      const ship = await read($, shipAtom)
      const missing = [
        ship.prListed ? undefined : 'check open PRs first: gh pr list --author @me',
        ship.codeqlRan || ship.skipCodeql ? undefined : 'run the CodeQL audit first (~/.claude/rules/codeql-audit.md); only the user can waive it with /harness skip-codeql',
      ].filter((line): line is string => line !== undefined)
      if (missing.length > 0) {
        return { deny: `Ship gate: this release/deploy is irreversible. Before it: ${missing.join('; ')}.` }
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    if (isPrList(command)) await update($, shipAtom, ship => ({ ...ship, prListed: true }))
    if (isCodeqlAnalyze(command)) await update($, shipAtom, ship => ({ ...ship, codeqlRan: true }))
    const pr = mergedPr(command)
    if (pr !== undefined) {
      await trackMerge($, pr, command)
      const note = toggles.guards ? await mergedWorktreeNote($, pr) : undefined
      if (note !== undefined) return { ...ran, context: [...(ran.context ?? []), note] }
    }

    return ran
  })

  on('tool.call', { tool: 'mcp__linear-server__save_issue' }, async ($, e, next) => {
    const refusal = await linearRefusal($, facts => checkSaveIssue(e as unknown as Record<string, unknown>, facts))
    if (refusal !== undefined) return { deny: refusal }
    const ran = await next(e)
    const input = e as unknown as { id?: unknown; state?: unknown }
    if (ran.deny === undefined && ran.isError !== true && typeof input.id === 'string' && isDoneState(input.state)) {
      const id = input.id
      await update($, shipAtom, ship => ({
        ...ship,
        pending: ship.pending.map(issue => (issue.id === id ? { ...issue, done: true } : issue)),
      }))
    }

    return ran
  })

  on('tool.call', { tool: 'mcp__linear-server__save_comment' }, async ($, e, next) => {
    const refusal = await linearRefusal($, facts => checkSaveComment(e as unknown as Record<string, unknown>, facts))
    if (refusal !== undefined) return { deny: refusal }
    const ran = await next(e)
    const input = e as unknown as { issueId?: unknown }
    if (ran.deny === undefined && ran.isError !== true && typeof input.issueId === 'string') {
      const id = input.issueId
      await update($, shipAtom, ship => ({
        ...ship,
        pending: ship.pending.map(issue => (issue.id === id ? { ...issue, commented: true } : issue)),
      }))
    }

    return ran
  })

  on('tool.call', { tool: 'mcp__linear-server__list_issues' }, async ($, e, next) => {
    if (!(await read($, togglesAtom)).guards) return next(e)
    const input = e as unknown as Record<string, unknown>
    if (checkListIssues(input) === undefined) return next(e)
    const env = await read($, envAtom)

    return { deny: checkListIssues(input, await repoTeam($, env.home)) ?? '' }
  })
}

// The Linear guards run under the guards toggle, before the ship gate's own
// bookkeeping of the same calls.
async function linearRefusal($: EngineInterface, check: (facts: LinearFacts) => string | undefined): Promise<string | undefined> {
  if (!(await read($, togglesAtom)).guards) return undefined
  const ship = await read($, shipAtom)
  const lint = await read($, lintAtom)
  const requested =
    ship.linearRequested || (await heartbeatOn($)) || grantAllowsLinear(await readGrant($, (await read($, envAtom)).home), Date.now())

  return check({ requested, mentioned: ship.mentioned, askUsed: lint.askUsed })
}

export async function shipStop($: EngineInterface, e: Parameters<StopHook>[1], next: Parameters<StopHook>[2]) {
    const below = await next(e)
    const toggles = await read($, togglesAtom)
    if (!toggles.shipGate || e.agent_id !== undefined || below.block !== undefined || below.preventContinuation === true) {
      return below
    }
    const ship = await read($, shipAtom)
    const open = unresolved(ship.pending)
    if (open.length === 0) {
      if (ship.pending.length > 0) await update($, shipAtom, s => ({ ...s, pending: [] }))

      return below
    }
    if (ship.stopBlocks >= MAX_STOP_BLOCKS) {
      $.ui.toast(`Ship gate: still not closed in Linear: ${open.map(issue => issue.id).join(', ')}`)

      return below
    }
    await update($, shipAtom, s => ({ ...s, stopBlocks: s.stopBlocks + 1 }))

    return {
      ...below,
      block: [
        'Ship gate (rules/linear-grooming.md §5): a merged PR closes its issues in the same turn.',
        ...open.map(
          issue =>
            `- ${issue.id} (PR ${issue.pr}): ${[issue.done ? undefined : 'move to Done (save_issue state)', issue.commented ? undefined : 'add an evidence comment with the commit hash (save_comment)'].filter(Boolean).join(' and ')}`,
        ),
      ].join('\n'),
    }
}

async function trackMerge($: EngineInterface, pr: string, command: string): Promise<void> {
  const cwd = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/)?.[1]?.replace(/^['"]|['"]$/g, '')
  let text = ''
  try {
    const argv = ['gh', 'pr', 'view', ...(pr === '' ? [] : [pr]), '--json', 'title,body,commits']
    const ran = await $.process.run(argv, { timeoutMs: 20_000, ...(cwd ? { cwd } : {}) })
    if (ran.exitCode === 0) text = ran.stdout
  } catch {
    // gh unavailable: nothing to track.
  }
  const ids = issueIds(text)
  if (ids.length === 0) return
  const ship = await read($, shipAtom)
  const handed = ids.filter(id => ship.mentioned.includes(id))
  const other = ids.filter(id => !ship.mentioned.includes(id))
  if (other.length > 0) $.ui.toast(`Merged PR ${pr} also names ${other.join(', ')}; close them in Linear if they were yours.`)
  if (handed.length === 0) return
  await update($, shipAtom, s => ({
    ...s,
    pending: [
      ...s.pending.filter(issue => !handed.includes(issue.id)),
      ...handed.map(id => ({ id, pr: pr === '' ? '(current branch)' : pr, done: false, commented: false })),
    ],
  }))
}
