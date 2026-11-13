import { commandWords, programOf, segments, stripProse } from './shell'

// Linear flow (user decision 2026-11-13, replaces CLAUDE.md §1.5's "only on
// request"): an agent that changes things must work under a Linear issue, and
// the issue must end Done.
// - Before the first change (Edit/Write/NotebookEdit, git commit/push, gh pr
//   create) the session needs an issue: one it opened (save_issue without id)
//   or one it claimed (save_issue on an existing id, e.g. In Progress).
// - A turn may not stop while such an issue is not Done.

export type FlowFacts = {
  // Issues this session created.
  opened: readonly string[]
  // Existing issues the session picked up with save_issue.
  claimed: readonly string[]
}

export function hasIssue(facts: FlowFacts): boolean {
  return facts.opened.length + facts.claimed.length > 0
}

// Paths whose edits are not project work: the user's own config and memory,
// scratch space and the trash folder.
export function isExemptPath(path: string, home: string | undefined, tmpdir: string | undefined): boolean {
  if (/(^|\/)trash\//.test(path) || /^\/(private\/)?tmp\//.test(path) || /^\/private\/var\/folders\//.test(path)) return true
  if (tmpdir !== undefined && tmpdir !== '' && path.startsWith(tmpdir)) return true
  if (home !== undefined && path.startsWith(`${home}/.claude/`)) return true

  return false
}

// A Bash command that publishes work: the commit, the push, the PR.
export function isWorkCommand(command: string): boolean {
  return segments(stripProse(command)).some(segment => {
    const words = commandWords(segment)
    const program = programOf(words)
    if (program === 'git') return words[1] === 'commit' || words[1] === 'push'

    return program === 'gh' && words[1] === 'pr' && words[2] === 'create'
  })
}

export function missingIssueMessage(tool: string, team: string | undefined): string {
  const where = team === undefined ? '' : ` This repo maps to team "${team}" in ~/.claude/linear.json.`

  return [
    `Harness Linear flow: ${tool} changes the project, and this session has no Linear issue for it.`,
    '1) Search first so you do not duplicate: list_issues with a project/team and a query.',
    '2) Open one with save_issue (no id; title, team, a short description), or pick an existing one up with save_issue (id, state In Progress).',
    `3) Then repeat this call. When the work is finished, move that issue to Done (save_issue id + state Done) before ending the turn.${where}`,
  ].join('\n')
}

export function openIssuesMessage(ids: readonly string[]): string {
  return [
    'Linear flow: finished work is moved to Done in the same turn.',
    ...ids.map(id => `- ${id}: save_issue id=${id} state=Done (add an evidence comment with the commit/PR via save_comment)`),
    'If the work is really unfinished, say so to the user with AskUserQuestion instead of leaving the issue open silently.',
  ].join('\n')
}

// The issue identifier a save_issue result carries. Measured live 2026-11-13:
// the Linear MCP answers `[{"type":"text","text":"{\"id\":\"AX-2212\",\"uuid\":...}"}]`, so the
// identifier is in "id" (an "identifier" key is accepted too). It wins over any
// other ID-shaped text, such as one in the description.
export function createdIssueId(result: unknown, patterns: readonly string[] | undefined): string | undefined {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  const labelled = text.match(/\\?"(?:identifier|id)\\?"\s*:\s*\\?"([A-Z][A-Z0-9]{1,5}-\d+)\\?"/)?.[1]
  if (labelled !== undefined) return labelled
  const any = text.match(/\b[A-Z][A-Z0-9]{1,5}-\d+\b/g) ?? []
  const tests = (patterns ?? []).flatMap(pattern => {
    try {
      return [new RegExp(`^(?:${pattern})$`)]
    } catch {
      return []
    }
  })

  return tests.length === 0 ? any[0] : any.find(id => tests.some(test => test.test(id)))
}

// A save_issue state that means the agent took the issue up (In Progress, In
// Review, started). A label or priority edit, or a state given as an ID, is not.
export function isStartedState(state: unknown): boolean {
  return typeof state === 'string' && /\b(progress|started|review|doing|active)\b/i.test(state)
}

export function isDroppedState(state: unknown): boolean {
  return typeof state === 'string' && /cancel|duplicate/i.test(state)
}

// auto-claude's signal file (<repo>/.claude/auto-claude.on), written on each
// tick of a run: a run that is on and ticked within RUN_FRESH_MS owns the repo.
export const RUN_FRESH_MS = 15 * 60_000

export function runOwnsRepo(text: string | undefined, now: number): boolean {
  if (text === undefined) return false
  try {
    const v = JSON.parse(text) as { on?: unknown; at?: unknown }
    return v.on === true && typeof v.at === 'number' && now - v.at < RUN_FRESH_MS
  } catch {
    return false
  }
}
