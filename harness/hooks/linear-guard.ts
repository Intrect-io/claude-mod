import type { EngineInterface } from 'claude-code'

import { issueIds } from './ship-gate'

// Linear only on request (CLAUDE.md §1.5): creating issues and commenting
// happen only when the user asked for Linear work in this session. Cancelling
// or splitting an issue needs an AskUserQuestion approval in the same turn.
// An unscoped list_issues is refused (2026-08-20: a sweep read every team's
// backlog instead of the repo's project).

// The heartbeat counts through heartbeatOn(), not through its own fire prompt.
const LINEAR_WORDS = /linear|리니어|이슈|\/linear-manage|\/heartbeat-loop/i
const CANCEL_STATE = /cancel|duplicate/i
const SCOPE_KEYS = ['project', 'team', 'assignee', 'query', 'parentId', 'cycle', 'label'] as const

export type LinearFacts = {
  // The user asked for Linear work in this session (prompt words or issue IDs).
  requested: boolean
  // Issue IDs the user named in this session.
  mentioned: readonly string[]
  // AskUserQuestion was answered earlier in this turn.
  askUsed: boolean
}

export function withoutReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
}

export function isLinearRequest(text: string): boolean {
  return LINEAR_WORDS.test(text) || issueIds(text).length > 0
}

const refusal = (why: string) =>
  `Harness rule (CLAUDE.md §1.5): ${why} Ask the user with AskUserQuestion first; if they agree, run it again.`

export function checkSaveIssue(input: Record<string, unknown>, facts: LinearFacts): string | undefined {
  const id = typeof input.id === 'string' ? input.id : undefined
  if (id === undefined && !facts.requested) {
    return refusal('Linear issues are created only when the user asks for Linear work in this session.')
  }
  if (facts.askUsed) return undefined
  if (typeof input.state === 'string' && CANCEL_STATE.test(input.state)) {
    return refusal(`cancelling an issue (state "${input.state}") needs the user's approval in this turn.`)
  }
  if (typeof input.parentId === 'string' && input.parentId !== '') {
    return refusal('splitting work into a sub-issue (parentId) needs the user\'s approval in this turn.')
  }

  return undefined
}

export function checkSaveComment(input: Record<string, unknown>, facts: LinearFacts): string | undefined {
  if (facts.requested) return undefined
  const issue = typeof input.issueId === 'string' ? input.issueId : ''
  if (facts.mentioned.includes(issue)) return undefined

  return refusal('Linear comments are written only when the user asks for Linear work in this session.')
}

export function checkListIssues(input: Record<string, unknown>, team?: string): string | undefined {
  const scoped = SCOPE_KEYS.some(key => {
    const value = input[key]
    return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null
  })
  if (scoped) return undefined
  const hint = team === undefined ? '' : ` This repo maps to team "${team}" in ~/.claude/linear.json; narrow it to that team's project.`

  return `Harness rule (rules/linear-grooming.md): list_issues without project, team or assignee reads every team's backlog.${hint}`
}

// The team ~/.claude/linear.json maps the current repo to, by the repo
// folder's name. Only `repo_mapping` is read; the file's api_key never leaves.
export async function repoTeam($: EngineInterface, home: string | undefined): Promise<string | undefined> {
  if (home === undefined) return undefined
  try {
    const mapping = (JSON.parse(await $.fs.read(`${home}/.claude/linear.json`)) as { repo_mapping?: Record<string, { team?: unknown }> }).repo_mapping
    const root = (await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5_000 })).stdout.trim()
    const name = root.split('/').at(-1) ?? ''
    const team = mapping?.[name]?.team

    return typeof team === 'string' ? team : undefined
  } catch {
    return undefined
  }
}

// Linear requests and issue IDs from the user's earlier prompts, for a plugin
// loaded into a running session (its state starts empty on reload).
export async function seedFromTranscript($: EngineInterface): Promise<{ requested: boolean; mentioned: string[] }> {
  try {
    const rows = await $.session.messages()
    // Injected reminders quote CLAUDE.md, which itself talks about Linear.
    const prompts = rows
      .filter(row => row.role === 'user' && row.toolResults === undefined)
      .map(row => withoutReminders(row.text))
      .filter(text => text.trim() !== '')

    return {
      requested: prompts.some(isLinearRequest),
      mentioned: [...new Set(prompts.flatMap(issueIds))],
    }
  } catch {
    return { requested: false, mentioned: [] }
  }
}
