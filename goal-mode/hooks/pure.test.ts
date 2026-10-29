import { describe, expect, test } from 'claude-code/testing'

import { checkBash, checkPath, uncommitted } from './guard'
import { markItem, nextPending, parseQueue, slugify, summarize } from './queue'

const QUEUE = `# goals

- [x] old goal <!-- done 2026-10-24T10:00Z goal/01-old, 0 failed checks -->
- [ ] add()가 a + b를 반환한다 :: check: pytest -q tests/test_a.py
- [!] blocked one <!-- blocked: no creds -->
- [ ] plain goal without check
not a goal line
`

describe('queue', () => {
  test('parses marks, conditions, checks and notes', async () => {
    const items = parseQueue(QUEUE)
    expect(items.map(item => item.mark)).toEqual(['x', ' ', '!', ' '])
    expect(items[1]?.condition).toBe('add()가 a + b를 반환한다')
    expect(items[1]?.check).toBe('pytest -q tests/test_a.py')
    expect(items[0]?.note).toContain('goal/01-old')
    expect(items[3]?.check).toBeUndefined()
    expect(nextPending(items)?.condition).toBe('add()가 a + b를 반환한다')
    expect(summarize(items)).toEqual({ done: 1, blocked: 1, pending: 2, total: 4 })
  })

  test('marks the pending line by its condition and keeps the check', async () => {
    const marked = markItem(QUEUE, 'add()가 a + b를 반환한다', 'x', 'done --> now')
    const items = parseQueue(marked)
    expect(items[1]?.mark).toBe('x')
    expect(items[1]?.check).toBe('pytest -q tests/test_a.py')
    expect(items[1]?.note).toBe('done - -> now')
    expect(nextPending(items)?.condition).toBe('plain goal without check')
    // A fix line built on a shipped branch goes before later milestones.
    expect(nextPending(parseQueue('- [ ] milestone 3 :: check: x\n- [ ] fix PR #2 :: check: y :: base: goal/02-b\n'))?.condition).toBe('fix PR #2')
    // An unknown condition leaves the file alone.
    expect(markItem(QUEUE, 'nope', '!', 'x')).toBe(QUEUE)
  })

  test('slugify keeps ascii words and falls back to "goal"', async () => {
    expect(slugify('Fix add() in counter.py')).toBe('fix-add-in-counter-py')
    expect(slugify('한글만 있는 목표')).toBe('goal')
  })
})

const CTX = { repoRoot: '/repo', worktree: '/repo/worktrees/goal-01-x', extraDeny: ['\\bplace_order\\b'] }

describe('guard', () => {
  const cases: Array<[string, boolean]> = [
    ['git push origin main', false],
    ['git push origin HEAD:master', false],
    ['git push --force origin goal/01-x', false],
    ['git push -f origin goal/01-x', false],
    ['git push origin +goal/01-x', false],
    ['git push', false],
    ['git push -u origin goal/01-x', true],
    ['cd /repo/worktrees/goal-01-x && git push -u origin goal/01-main-fix', true],
    ['git reset --hard HEAD~1', false],
    ['sudo rm x', false],
    ['kubectl apply -f x.yaml', false],
    ['rm -rf build', true],
    ['rm -rf /repo/worktrees/goal-01-x/build', true],
    ['rm -rf /repo/src', false],
    ['rm -rf ../other', false],
    ['rm -fr ~/x', false],
    ['rm -r -f $HOME/x', false],
    ['rm -r build', true],
    ['python place_order.py', false],
    ['pytest -q && git commit -am "fix"', true],
    // Seen live: a commit message explaining why main was not pushed.
    [`git add counter.py && git commit -q -m "Fix mul()\n\nAssumption: the goal asked to 'git push origin main', but the loop rules\nforbid it." && pytest -q`, true],
    [`git commit -F - <<'EOF'\ndo not run git push --force here\nEOF\n`, true],
    ['gh pr create --title "x" --body "never sudo rm here"', true],
    ['bash -c "git push origin main"', false],
    [`git commit -m "ok" && git push origin main`, false],
  ]
  for (const [command, allowed] of cases) {
    test(`${allowed ? 'allows' : 'refuses'}: ${command}`, async () => {
      expect(checkBash(command, CTX) === undefined).toBe(allowed)
    })
  }

  test('uncommitted ignores cache artifacts but not tracked changes or new sources', async () => {
    expect(uncommitted('?? __pycache__/\n?? .pytest_cache/\n?? src/a.pyc\n?? node_modules/\n')).toEqual([])
    expect(uncommitted(' M counter.py\n?? __pycache__/\n')).toEqual([' M counter.py'])
    expect(uncommitted('?? new_module.py\n')).toEqual(['?? new_module.py'])
    expect(uncommitted(' M build/config.py\n')).toEqual([' M build/config.py'])
  })

  test('edits stay in the worktree; outside the repository is free', async () => {
    expect(checkPath('/repo/worktrees/goal-01-x/a.py', CTX)).toBeUndefined()
    expect(checkPath('/repo/a.py', CTX)).toBeDefined()
    expect(checkPath('/repo/.claude/goals.md', CTX)).toBeDefined()
    expect(checkPath('/repo/worktrees/goal-02-y/a.py', CTX)).toBeDefined()
    expect(checkPath('/tmp/scratch.txt', CTX)).toBeUndefined()
  })
})
