import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ToolCallHook } from './state'

// Code commands for what ~/.claude/commands/status.md and slim.md ran as prose:
// /repo-status gathers git and gh facts with no model turn; /slim writes the
// session context file from tracked facts plus a short haiku summary.

const activityAtom = atom({ plugin: 'harness', key: 'activity' } as const, { files: [] as string[] }, { shape: 'activity-1' })

const MAX_FILES = 50
const SUMMARY_MESSAGES = 30
const SUMMARY_CHARS = 12_000

// Records the files Edit and Write touched this session, for /slim.
export async function trackToolCall($: EngineInterface, e: Parameters<ToolCallHook>[1], next: Parameters<ToolCallHook>[2]) {
  const ran = await next(e)
  const path = (e as unknown as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as unknown as { notebook_path?: unknown }).notebook_path
  if (ran.deny === undefined && ran.isError !== true && typeof path === 'string' && /^(Edit|Write|NotebookEdit)$/.test(e.tool)) {
    await update($, activityAtom, a => ({ files: [path, ...a.files.filter(file => file !== path)].slice(0, MAX_FILES) }))
  }

  return ran
}

async function run($: EngineInterface, argv: string[]): Promise<string> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: 20_000 })
    return ran.exitCode === 0 ? ran.stdout.trim() : ''
  } catch {
    return ''
  }
}

export function kstNow(now: number): string {
  const kst = new Date(now + 9 * 3_600_000)
  return `${kst.toISOString().slice(0, 16).replace('T', ' ')} KST`
}

// Counts of `git status --porcelain` lines by kind.
export function statusCounts(porcelain: string): { staged: number; modified: number; untracked: number } {
  let staged = 0
  let modified = 0
  let untracked = 0
  for (const line of porcelain.split('\n')) {
    if (line.length < 2) continue
    if (line.startsWith('??')) {
      untracked++
      continue
    }
    if (line[0] !== ' ') staged++
    if (line[1] !== ' ') modified++
  }

  return { staged, modified, untracked }
}

export async function repoStatus($: EngineInterface, now: number): Promise<string> {
  const root = await run($, ['git', 'rev-parse', '--show-toplevel'])
  if (root === '') return `${kstNow(now)}\nNot inside a git repository.`
  const [branch, last, porcelain, ahead, prs] = await Promise.all([
    run($, ['git', 'branch', '--show-current']),
    run($, ['git', 'log', '-1', '--format=%h %s (%cr)']),
    run($, ['git', 'status', '--porcelain']),
    run($, ['git', 'rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    run($, ['gh', 'pr', 'list', '--state', 'open', '--author', '@me', '--json', 'number,title,headRefName', '-q', '.[] | "#\\(.number) \\(.title) [\\(.headRefName)]"']),
  ])
  const counts = statusCounts(porcelain)
  const [behind = '0', aheadBy = '0'] = ahead.split(/\s+/)

  return [
    `${kstNow(now)} · ${root.split('/').at(-1)}`,
    `branch ${branch || '(detached)'}${ahead === '' ? ' (no upstream)' : ` · ahead ${aheadBy} / behind ${behind}`}`,
    `last commit ${last || '(none)'}`,
    `changes: staged ${counts.staged} · modified ${counts.modified} · untracked ${counts.untracked}`,
    `open PRs (mine): ${prs === '' ? 'none' : `\n${prs}`}`,
  ].join('\n')
}

// A few lines on what the session did, from its recent messages, by a cheap
// model; undefined when that fails, so /slim still writes the facts.
async function summarize($: EngineInterface): Promise<string | undefined> {
  try {
    const rows = await $.session.messages()
    const recent = rows
      .slice(-SUMMARY_MESSAGES)
      .map(row => `${row.role}: ${row.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()}`)
      .filter(line => !/^\w+:\s*$/.test(line))
      .join('\n')
      .slice(-SUMMARY_CHARS)
    if (recent === '') return undefined
    const r = await $.model.complete({
      model: 'haiku',
      prompt: `${recent}\n\n위 세션을 한국어로 정리해. 세 개의 소제목만 쓴다: "## 작업 요약"(3-5줄), "## 핵심 결정사항", "## TODO / 다음 작업". 없는 항목은 "없음".`,
    })

    return r.isAnswered && r.text.trim() !== '' ? r.text.trim() : undefined
  } catch {
    return undefined
  }
}

export async function writeSlim($: EngineInterface, home: string | undefined, now: number, mentioned: readonly string[]): Promise<string> {
  if (home === undefined) return 'HOME is unknown; nothing written.'
  const [cwd, branch, diffStat] = await Promise.all([
    $.session.root(),
    run($, ['git', 'branch', '--show-current']),
    run($, ['git', 'diff', '--stat', 'HEAD']),
  ])
  const { files } = await read($, activityAtom)
  const summary = await summarize($)
  const path = `${home}/.claude/context/slim-context.md`
  const text = [
    '# Session Context',
    `> Generated: ${kstNow(now)}`,
    '',
    '## 프로젝트',
    `- **경로**: ${cwd}`,
    `- **브랜치**: ${branch || '(none)'}`,
    '',
    summary ?? '## 작업 요약\n(요약 생성 실패: 아래 사실만 기록)',
    '',
    '## 변경된 파일',
    ...(files.length === 0 ? ['(이 세션에서 Edit/Write 없음)'] : files.map(file => `- ${file}`)),
    ...(diffStat === '' ? [] : ['', '```', diffStat, '```']),
    '',
    '## 관련 이슈',
    mentioned.length === 0 ? '없음' : mentioned.join(', '),
    '',
  ].join('\n')
  await $.fs.write(path, text)

  return `컨텍스트 저장 완료: ${path}${summary === undefined ? ' (요약 없이 사실만)' : ''}`
}
