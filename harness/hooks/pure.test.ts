import { describe, expect, test } from 'claude-code/testing'

import {
  checkAttribution,
  checkDelete,
  checkEnterWorktree,
  checkForcePush,
  checkLlmPort,
  checkOpenswarm,
  checkWorktree,
  messageFiles,
  venvRewrite,
} from './guards'
import { checkAgentWorktree, checkMemorySecret, checkSystemPython, checkTradingOrder, DEFAULT_ORDER_TOOLS, isVersionBump, leftoverWorktrees } from './extra-guards'
import { kstNow, statusCounts } from './commands'
import { splitPorcelain } from './commit'
import { fireTag, holdReason, parseInterval } from './heartbeat'
import { grantAllowsLinear, grantVerdict, senderName } from './grant'
import { gcSignature, gcSummary } from './memory-gc'
import { checkListIssues, checkSaveComment, checkSaveIssue, isLinearRequest, withoutReminders } from './linear-guard'
import { isEnglishLine, lintReport } from './report-lint'
import { isCodeqlAnalyze, isDoneState, isPrList, isReleaseCommand, issueIds, mergedPr } from './ship-gate'

const ENV = { home: '/Users/u', tmpdir: '/var/folders/xx/T/', venv: '/Users/u/dev/mlx_env/bin/activate' }
const ROOT = '/Users/u/dev/repo'

function table(name: string, check: (input: string) => boolean, cases: Array<[string, boolean]>) {
  describe(name, () => {
    for (const [input, expected] of cases) {
      test(`${expected ? 'yes' : 'no '}: ${input.slice(0, 70)}`, async () => {
        expect(check(input)).toBe(expected)
      })
    }
  })
}

table('attribution refused', command => checkAttribution(command) !== undefined, [
  ['git commit -m "fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', true],
  [`git commit -F - <<'EOF'\nfeat: y\n\n🤖 Generated with Claude Code\nEOF`, true],
  ['gh pr create --title t --body "Generated with [Claude Code](https://claude.com)"', true],
  ['git commit -m "fix: plain message"', false],
  ['echo "Co-Authored-By: someone"', false],
])

test('attribution in a -F message file is refused', async () => {
  expect(messageFiles('git commit -F /tmp/msg.txt && git push')).toEqual(['/tmp/msg.txt'])
  expect(checkAttribution('git commit -F /tmp/msg.txt', ['fix\n\nCo-authored-by: AI'])).toBeDefined()
})

table('worktree refused', command => checkWorktree(command, ENV, ROOT) !== undefined, [
  ['git worktree add worktrees/feat -b feat', false],
  ['git worktree add -b feat worktrees/feat', false],
  [`git worktree add ${ROOT}/worktrees/feat -b feat`, false],
  ['git worktree add /tmp/feat -b feat', true],
  ['git worktree add ../repo-feat -b feat', true],
  ['git worktree add .claude/worktrees/feat', true],
  ['git worktree add ~/.codex/worktrees/x', true],
  ['git worktree add /Users/u/dev/other/worktrees/x', true],
  ['git worktree add feat-dir', true],
  ['git worktree list', false],
  ['git commit -m "never git worktree add /tmp/x"', false],
])

test('EnterWorktree: only an existing worktrees/ path', async () => {
  expect(checkEnterWorktree({ name: 'feat' })).toContain('.claude/worktrees')
  expect(checkEnterWorktree({ path: `${ROOT}/worktrees/feat` })).toBeUndefined()
  expect(checkEnterWorktree({ path: `${ROOT}/.claude/worktrees/feat` })).toBeDefined()
})

table('delete refused', command => checkDelete(command, ENV) !== undefined, [
  ['rm -rf build', true],
  ['rm notes.txt', true],
  ['rm -rf ~/dev/testing/old_run', true],
  ['rmdir empty', true],
  ['unlink a.lock', true],
  ['rm -rf trash/old', false],
  ['rm -rf ./trash/2026', false],
  ['rm -rf ~/dev/trash/x', false],
  ['rm -f /tmp/x.log', false],
  ['rm -rf /private/tmp/claude-501/scratch', false],
  ['rm /var/folders/xx/T/tmp.123', false],
  ['rm -rf /tmp/../etc', true],
  ['git rm --cached secrets.env', false],
  ['find . -name "*.pyc" -delete', true],
  ['find /tmp/cache -delete', false],
  ['git clean -fd', true],
  ['git commit -m "do not rm -rf build here"', false],
  ['mkdir -p trash && mv build trash/', false],
])

table('force push refused', command => checkForcePush(command) !== undefined, [
  ['git push --force origin feat', true],
  ['git push -f', true],
  ['git push origin +feat', true],
  ['git push --force-with-lease origin feat', false],
  ['git push -u origin feat', false],
  ['git commit -m "no git push --force please"', false],
])

describe('venv', () => {
  const cases: Array<[string, string | undefined]> = [
    ['pytest -q', 'source /Users/u/dev/mlx_env/bin/activate && pytest -q'],
    ['cd x && python a.py', 'source /Users/u/dev/mlx_env/bin/activate && cd x && python a.py'],
    ['python3.12 -m venv v', 'source /Users/u/dev/mlx_env/bin/activate && python3.12 -m venv v'],
    ['pip install requests', 'source /Users/u/dev/mlx_env/bin/activate && pip install requests'],
    ['source ~/dev/mlx_env/bin/activate && pytest', undefined],
    ['/usr/bin/python3 -c "print(1)"', undefined],
    ['~/dev/mlx_env/bin/python x.py', undefined],
    ['uv run python x.py', undefined],
    ['echo python is fun', undefined],
    ['git commit -m "run pytest later"', undefined],
  ]
  for (const [command, expected] of cases) {
    test(command, async () => {
      const out = venvRewrite(command, ENV)
      expect(out === undefined ? undefined : 'command' in out ? out.command : `deny ${out.deny}`).toBe(expected)
    })
  }

  test('a missing venv is refused, not run on the system Python', async () => {
    const out = venvRewrite('pytest -q', { home: '/Users/u', venvMissing: '/Users/u/dev/mlx_env' })
    expect(out !== undefined && 'deny' in out ? out.deny : '').toContain('/Users/u/dev/mlx_env')
  })
})

test('port 1234 and openswarm review', async () => {
  expect(checkLlmPort('curl http://localhost:1234/v1/models')).toBeDefined()
  expect(checkLlmPort('base_url = "http://127.0.0.1:1237/v1"')).toBeUndefined()
  expect(checkLlmPort('timeout = 12345')).toBeUndefined()
  expect(checkOpenswarm('openswarm pr review 12 --fresh')).toBeDefined()
  expect(checkOpenswarm('openswarm status')).toBeUndefined()
})

describe('ship-gate parsing', () => {
  test('issue ids, merges, PR lists, CodeQL, Done states', async () => {
    expect(issueIds('feat: x (INT-12)\nfixes STO-1737 and INT-12')).toEqual(['INT-12', 'STO-1737'])
    expect(mergedPr('gh pr merge 42 --squash')).toBe('42')
    expect(mergedPr('cd repo && gh pr merge --squash --delete-branch')).toBe('')
    expect(mergedPr('gh pr view 42')).toBeUndefined()
    expect(isPrList('gh pr list --author @me')).toBe(true)
    expect(isPrList('gh pr list --state open')).toBe(true)
    expect(isPrList('gh pr list --state closed')).toBe(false)
    expect(isCodeqlAnalyze('codeql database analyze /tmp/db codeql/python-queries --format=sarif-latest')).toBe(true)
    expect(isDoneState('Done')).toBe(true)
    expect(isDoneState('completed')).toBe(true)
    expect(isDoneState('In Progress')).toBe(false)
    expect(isDoneState('5b7c1a2e-0d1f-4c3b-9a8e-123456789abc')).toBe(true)
  })
})

table('release commands', isReleaseCommand, [
  ['gh release create v1.2.0 --generate-notes', true],
  ['git push origin v1.2.0', true],
  ['git push --tags', true],
  ['git tag v1.2.0', false],
  ['git push -u origin feat/x', false],
  ['npm publish', true],
  ['cargo publish', true],
  ['fly deploy', true],
  ['vercel --prod', true],
  ['vercel', false],
  ['gcloud run deploy api --source .', true],
  ['git commit -m "prepare gh release create"', false],
])

describe('report lint', () => {
  const base = { codeEdited: false, askUsed: false, planMode: false }

  test('Self-Audit is required only for code-change completion reports', async () => {
    expect(lintReport('완료했습니다.', { ...base, codeEdited: true })).toHaveLength(1)
    const audit = '[SELF-AUDIT]\n- 실행/테스트 확인: ok\n- 호출처/영향 범위 확인: ok\n- 요구사항 충족 확인: ok\n- 동시성/경합: N/A'
    expect(lintReport(`완료했습니다.\n${audit}`, { ...base, codeEdited: true })).toEqual([])
    expect(lintReport('완료했습니다.\n[SELF-AUDIT]\n- 실행: ok', { ...base, codeEdited: true })[0]).toContain('missing')
    expect(lintReport('[CONFIDENCE HALT] confidence: 50%', { ...base, codeEdited: true })).toEqual([])
    expect(lintReport('선택이 필요합니다.', { ...base, codeEdited: true, askUsed: true })).toEqual([])
    expect(lintReport('설명입니다.', base)).toEqual([])
  })

  test('a trailing plain-text question is flagged unless asked by tool or in plan mode', async () => {
    expect(lintReport('이렇게 바꿨습니다.\n진행해도 될까요?', base)[0]).toContain('AskUserQuestion')
    expect(lintReport('진행해도 될까요?', { ...base, askUsed: true })).toEqual([])
    expect(lintReport('진행해도 될까요?', { ...base, planMode: true })).toEqual([])
    expect(lintReport('결론입니다.\n```\nwhat?\n```', base)).toEqual([])
  })

  test('the question endings CLAUDE.md names are flagged near the end; FALLBACK exempts', async () => {
    expect(lintReport('A안과 B안이 있습니다.\n어떻게 할까요\n참고: 둘 다 가능합니다.', base)[0]).toContain('AskUserQuestion')
    expect(lintReport('바로 반영해 드릴까요', base)[0]).toContain('AskUserQuestion')
    expect(lintReport('[FALLBACK: AskUserQuestion unavailable]\n진행해도 될까요?', base)).toEqual([])
    expect(lintReport('어떻게 할까요라는 질문은 금지입니다.\n1\n2\n3\n끝.', base)).toEqual([])
  })

  test('English-only prose lines are flagged; term-heavy Korean is not', async () => {
    expect(isEnglishLine('This change fixes the evaluator timeout.')).toBe(true)
    expect(isEnglishLine('evaluator가 Stop에서 sonnet으로 판정합니다')).toBe(false)
    expect(isEnglishLine('| --- | :---: |')).toBe(false)
    expect(isEnglishLine('`git push -u origin goal/01-fix`')).toBe(false)
    expect(isEnglishLine('~/dev/testing/goal_loop_e2e_261024/.claude/goals.md')).toBe(false)
    expect(isEnglishLine('- SessionStart hook error')).toBe(false)
    expect(lintReport('수정했습니다.\n> quoted English text from the log here', base)).toEqual([])
    expect(lintReport('Done. All tests pass now.', base)[0]).toContain('Korean')
  })
})

describe('linear guard', () => {
  const none = { requested: false, mentioned: [] as string[], askUsed: false }
  const asked = { ...none, requested: true }

  test('creating an issue needs a Linear request in this session', async () => {
    expect(checkSaveIssue({ title: 'x', team: 'T' }, none)).toContain('§1.5')
    expect(checkSaveIssue({ title: 'x', team: 'T' }, asked)).toBeUndefined()
    expect(checkSaveIssue({ id: 'QQQ-1', state: 'Done' }, none)).toBeUndefined()
  })

  test('cancel and split need an AskUserQuestion in the turn', async () => {
    expect(checkSaveIssue({ id: 'QQQ-1', state: 'Canceled' }, asked)).toContain('cancelling')
    expect(checkSaveIssue({ id: 'QQQ-1', state: 'Duplicate' }, asked)).toContain('cancelling')
    expect(checkSaveIssue({ title: 'sub', parentId: 'QQQ-1' }, asked)).toContain('sub-issue')
    expect(checkSaveIssue({ id: 'QQQ-1', state: 'Canceled' }, { ...asked, askUsed: true })).toBeUndefined()
  })

  test('comments need a request or a mentioned issue', async () => {
    expect(checkSaveComment({ issueId: 'QQQ-1', body: 'x' }, none)).toContain('§1.5')
    expect(checkSaveComment({ issueId: 'QQQ-1', body: 'x' }, { ...none, mentioned: ['QQQ-1'] })).toBeUndefined()
  })

  test('an unscoped list_issues is refused, with the mapped team as a hint', async () => {
    expect(checkListIssues({ state: 'started' }, 'STONKS')).toContain('STONKS')
    expect(checkListIssues({ project: 'Intrect-platform' })).toBeUndefined()
    expect(checkListIssues({ assignee: 'me' })).toBeUndefined()
    expect(checkListIssues({ team: '' })).toContain('list_issues')
  })

  test('request words, issue IDs and reminders', async () => {
    expect(isLinearRequest('리니어에 이슈로 남겨줘')).toBe(true)
    expect(isLinearRequest('QQQ-12 마무리해줘')).toBe(true)
    expect(isLinearRequest('테스트 고쳐줘')).toBe(false)
    expect(isLinearRequest('[harness heartbeat] Run one fire of the heartbeat-loop skill now')).toBe(false)
    expect(isLinearRequest(withoutReminders('고쳐줘 <system-reminder>Linear 이슈는 요청 시에만</system-reminder>'))).toBe(false)
  })
})

describe('extra guards', () => {
  test('memory files never take secrets', async () => {
    const mem = '/Users/u/.claude/projects/-x/memory/note.md'
    expect(checkMemorySecret(mem, 'key: sk-ant-' + 'a'.repeat(30), '/Users/u')).toContain('§7.5')
    expect(checkMemorySecret(mem, 'token ghp_' + 'b'.repeat(36), '/Users/u')).toContain('§7.5')
    expect(checkMemorySecret(mem, 'the API key lives in 1Password', '/Users/u')).toBeUndefined()
    expect(checkMemorySecret('/repo/.env.example', 'password=hunter2hunter2', '/Users/u')).toBeUndefined()
  })

  test('system Python by absolute path is refused', async () => {
    expect(checkSystemPython('/usr/bin/python3 -V')).toContain('system Python')
    expect(checkSystemPython('cd x && /opt/homebrew/bin/python3.12 run.py')).toContain('system Python')
    expect(checkSystemPython('python3 -V')).toBeUndefined()
    expect(checkSystemPython('/Users/u/dev/mlx_env/bin/python -V')).toBeUndefined()
  })

  test('agent worktree isolation and trading orders', async () => {
    expect(checkAgentWorktree({ isolation: 'worktree' })).toContain('worktrees/')
    expect(checkAgentWorktree({ isolation: 'remote' })).toBeUndefined()
    expect(checkTradingOrder('mcp__pykis-local__place_order', DEFAULT_ORDER_TOOLS, false)).toContain('approves')
    expect(checkTradingOrder('mcp__pykis-local__place_order', DEFAULT_ORDER_TOOLS, true)).toBeUndefined()
    expect(checkTradingOrder('mcp__pykis-local__get_quote', DEFAULT_ORDER_TOOLS, false)).toBeUndefined()
    expect(checkTradingOrder('mcp__x__order', '([', false)).toBeUndefined()
  })

  test('version bumps and leftover worktrees', async () => {
    expect(isVersionBump('npm version patch')).toBe(true)
    expect(isVersionBump('git commit -m "chore: bump version to 1.2.0"')).toBe(true)
    expect(isVersionBump('git commit -m "fix: parser"')).toBe(false)
    const porcelain = 'worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /r/worktrees/feat\nHEAD b\nbranch refs/heads/feat'
    expect(leftoverWorktrees(porcelain, 'feat')).toEqual(['/r/worktrees/feat'])
    expect(leftoverWorktrees(porcelain, 'other')).toEqual([])
  })
})

describe('grant check', () => {
  const NOW = Date.parse('2026-10-25T12:00:00Z')
  const grant = JSON.stringify({ orchestrator: 'boss', expires_at: '2026-10-26T10:00:00+09:00', allowed: ['merge PRs', 'Linear Done 전이'], forbidden: ['change CLAUDE.md'] })
  const msg = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="boss" from-mode="bypass">\ndo it'

  test('reads the sender from the envelope', async () => {
    expect(senderName(msg)).toBe('boss')
    expect(senderName('plain text')).toBeUndefined()
  })

  test('valid only for the orchestrator before expiry', async () => {
    expect(grantVerdict(grant, 'boss', NOW)).toContain('VALID until')
    expect(grantVerdict(grant, 'boss', NOW)).toContain('forbidden: change CLAUDE.md')
    expect(grantVerdict(grant, 'other', NOW)).toContain('INVALID: sender "other"')
    expect(grantVerdict(grant, 'boss', Date.parse('2026-10-27T00:00:00Z'))).toContain('expired')
    expect(grantVerdict(undefined, 'boss', NOW)).toContain('no ~/.claude/orchestration-grant.json')
    expect(grantVerdict('{', 'boss', NOW)).toContain('does not parse')
  })

  test('a live grant that allows Linear work counts as a Linear request', async () => {
    expect(grantAllowsLinear(grant, NOW)).toBe(true)
    expect(grantAllowsLinear(grant, Date.parse('2026-10-27T00:00:00Z'))).toBe(false)
  })
})

describe('session tooling', () => {
  test('memory-gc summary and signature', async () => {
    expect(gcSummary({ generated_at: 'g', broken_links: 3, oversized_files: 0 })).toBe('[Memory GC] g — 깨진 링크 3')
    expect(gcSummary({ broken_links: 0 })).toBeUndefined()
    expect(gcSignature({ broken_links: 3 })).not.toBe(gcSignature({ broken_links: 4 }))
  })

  test('status counts and KST time', async () => {
    expect(statusCounts('M  a.ts\n M b.ts\nMM c.ts\n?? d.ts\n')).toEqual({ staged: 2, modified: 2, untracked: 1 })
    expect(kstNow(Date.parse('2026-10-25T12:30:00Z'))).toBe('2026-10-25 21:30 KST')
  })
})

describe('workflow', () => {
  test('porcelain split for commit_preflight', async () => {
    expect(splitPorcelain('M  a.ts\n M b.ts\n?? c.ts\n')).toEqual({ staged: ['a.ts'], unstaged: ['b.ts'], untracked: ['c.ts'] })
  })

  test('heartbeat interval, hold reasons and fire tags', async () => {
    expect(parseInterval('5m')).toBe(300_000)
    expect(parseInterval('90s')).toBe(90_000)
    expect(parseInterval('30s')).toBeUndefined()
    expect(parseInterval('soon')).toBeUndefined()
    const s = { on: true, intervalMs: 60_000, lastUserAt: 0, lastFireAt: 0, busy: false, firing: false }
    expect(holdReason(s, 120_000, false)).toBeUndefined()
    expect(holdReason({ ...s, busy: true }, 120_000, false)).toContain('turn')
    expect(holdReason(s, 120_000, true)).toContain('goal-mode')
    expect(holdReason({ ...s, lastUserAt: 100_000 }, 120_000, false)).toContain('user')
    expect(holdReason({ ...s, on: false }, 120_000, false)).toBe('off')
    expect(fireTag('[fire focus: STO-3 step 2/4]\n작업')).toBe('[fire focus: STO-3 step 2/4]')
    expect(fireTag('그냥 답변')).toBeUndefined()
  })
})
