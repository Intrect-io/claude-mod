import { describe, expect, test } from 'claude-code/testing'
import { baselineSeen, lineIssues, MAX_FOLLOW_UPS, planSync } from './linear'

import { countSarif, parseDeploy, scriptsOf, specOfPlan } from './deploy'
import { parseVerdict, transcriptTail } from './evaluator'
import { checkBash, checkPath, deploysSomething, uncommitted, waitsLong } from './guard'
import { guardRefusal, maxBranchSeq } from './loop'
import type { ShipState } from '../types'
import { deployFixLine, deployOf, finalCheckOf, fixLine, kickoffText, POLICY, validatePlan } from './plan'
import { markItem, nextPending, parseQueue, slugify, summarize } from './queue'
import { capReached, causeOf, ciAction, httpsOf, idleDue, inFlight, isWaiting, mergeable, noRequired, onlyCancelled, parseChecks, prNumber, progressSig, readLog, repoSlug, shipRemedy, startBase, unfinished, MAX_AHEAD, wakeDue } from './ship'

const PLAN = '## Goal\nadd and sub work\n\nFinal check: `python3 -m unittest -q`\nDeploy: `bash scripts/deploy.sh`\nSmoke check: `curl -fsS http://localhost:8080/health`\nCodeQL: python\n\n## Milestones\n1. add\n2. sub\n\n## Decisions\n'
const QUEUE = '- [ ] add() returns a+b :: check: python3 -m unittest -q test_add\n- [ ] sub() returns a-b :: check: python3 -m unittest -q test_sub\n'
const MIN = 60_000

describe('plan', () => {
  test('the queue grammar (generated from shared/queue.ts), :: base: and notes included', () => {
    expect(parseQueue('- [ ] a :: check: x :: base: goal/01-a\n- [x] b <!-- done -->\n- [!] c :: check: y')).toEqual([
      { line: 0, mark: ' ', condition: 'a', check: 'x', base: 'goal/01-a' },
      { line: 1, mark: 'x', condition: 'b', check: undefined, note: 'done' },
      { line: 2, mark: '!', condition: 'c', check: 'y' },
    ])
  })

  test('a plan needs a final check and checked milestones', () => {
    expect(finalCheckOf(PLAN)).toBe('python3 -m unittest -q')
    expect(finalCheckOf('- **Final check**: make test')).toBe('make test')
    expect(validatePlan(PLAN, QUEUE, true)).toMatchObject({ ok: true, finalCheck: 'python3 -m unittest -q' })
    const bad = validatePlan('## Goal\nx', '- [ ] only one\n', true)
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.errors.join(' ')).toContain('no "Final check')
    expect(!bad.ok && bad.errors.join(' ')).toContain('at least 2')
    expect(!bad.ok && bad.errors.join(' ')).toContain('without a check')
    expect(validatePlan(PLAN, `${QUEUE}- [ ] add() returns a+b :: check: z\n`, true).ok).toBe(false)
    // A later round needs only one new milestone.
    expect(validatePlan(PLAN, '- [x] a :: check: x\n- [ ] b :: check: y\n', false).ok).toBe(true)
    expect(validatePlan(PLAN, '- [ ] a :: check: x :: base: main\n- [ ] b :: check: y\n', true).ok).toBe(false)
    // Shipping and deploying are not a milestone's end state.
    const shipped = validatePlan(PLAN, '- [ ] add works, merged to main :: check: x\n- [ ] b :: check: y\n', true)
    expect(!shipped.ok && shipped.errors.join(' ')).toContain('merging, pushing, PRs and deploying happen after')
    expect(validatePlan(PLAN, '- [ ] the API is deployed to fly :: check: x\n- [ ] b :: check: y\n', true).ok).toBe(false)
    // Writing the deploy script is a milestone; being deployed is not.
    expect(validatePlan(PLAN, '- [ ] scripts/deploy.sh deploys the API to fly :: check: x\n- [ ] b :: check: y\n', true).ok).toBe(true)
  })

  test('a plan says how the run deploys (P6): command, smoke check and CodeQL, or none with a reason', () => {
    expect(deployOf(PLAN)).toEqual({ deploy: { kind: 'command', command: 'bash scripts/deploy.sh', smoke: 'curl -fsS http://localhost:8080/health', codeql: ['python'] }, errors: [] })
    const noDeploy = PLAN.replace(/Deploy:.*\n/, '')
    expect(validatePlan(noDeploy, QUEUE, true)).toMatchObject({ ok: false })
    expect((validatePlan(noDeploy, QUEUE, true) as { errors: string[] }).errors.join(' ')).toContain('no "Deploy:')
    // .claude/auto-deploy.json decides instead: no Deploy line needed.
    expect(validatePlan(noDeploy, QUEUE, true, true).ok).toBe(true)
    // None needs its reason.
    const none = (d: string) => PLAN.replace(/Deploy:.*\n/, `Deploy: ${d}\n`).replace(/Smoke check:.*\n/, '').replace(/CodeQL:.*\n/, '')
    expect(validatePlan(none('none'), QUEUE, true).ok).toBe(false)
    expect(validatePlan(none('none (a library; nothing runs anywhere)'), QUEUE, true)).toMatchObject({ ok: true, deploy: { kind: 'none', reason: 'a library; nothing runs anywhere' } })
    // A command needs its smoke check and its CodeQL line.
    const noSmoke = deployOf(PLAN.replace(/Smoke check:.*\n/, ''))
    expect(noSmoke.errors.join(' ')).toContain('Smoke check')
    const noCodeql = deployOf(PLAN.replace(/CodeQL:.*\n/, ''))
    expect(noCodeql.errors.join(' ')).toContain('CodeQL')
    expect(deployOf(PLAN.replace('CodeQL: python', 'CodeQL: none (no code)')).deploy).toMatchObject({ codeql: [] })
    expect(deployOf(PLAN.replace('CodeQL: python', 'CodeQL: none')).errors.join(' ')).toContain('needs its reason')
    expect(deployOf(PLAN.replace('CodeQL: python', 'CodeQL: python, javascript')).deploy).toMatchObject({ codeql: ['python', 'javascript'] })
  })

  test('the kickoff aims at the end state, live, and asks nobody (P6)', () => {
    const k = kickoffText('finish the CLI', 'origin/main')
    expect(k).toContain('Their aim: finish the CLI')
    expect(k).toContain('long-term end state')
    expect(k).toContain('from origin/main')
    expect(k).toContain('decide every choice yourself')
    expect(k).toContain('merged, deployed and smoke-checked')
    expect(k).toContain('Never plan "the person deploys')
    expect(k).toContain('Deploy: <one shell command>')
    expect(k).not.toContain('Plan no deploy')
    // A committed deploy file decides instead.
    const fixed = kickoffText('', 'origin/main', false, 'make ship')
    expect(fixed).toContain('auto-deploy.json is committed')
    expect(fixed).not.toContain('Deploy: <one shell command>')
  })

  test('the policy keeps the model from handing the run back to the person (P4, P5)', () => {
    expect(POLICY).toContain('never ask the person to run /auto-claude')
    expect(POLICY).toContain('just end the turn')
    expect(POLICY).toContain('never call ProposeGoal or /goal')
    expect(POLICY).toContain('mcp__auto-claude__defer_goal')
    expect(POLICY).not.toContain('goal-mode')
  })

  test('a fix line builds on the failing branch with the milestone\'s check; a deploy fix on the default branch', () => {
    const line = fixLine('add() returns a+b', 7, 'CI failed', 'pytest -q', 'goal/01-add')
    expect(parseQueue(line)[0]).toMatchObject({ check: 'pytest -q', base: 'goal/01-add' })
    expect(line).toContain('PR #7')
    // What is true on its own branch, judged by the evaluator: the final check passes only once the whole goal is met.
    const d = parseQueue(deployFixLine('bash deploy.sh', 'curl -f x', 'the smoke check exited 7', 'origin/main'))[0]
    expect(d).toMatchObject({ check: undefined, base: 'origin/main' })
    expect(d?.condition).toContain('cause of the failed deploy is found and fixed on this branch')
    expect(d?.condition).toContain('runs `bash deploy.sh` and its smoke check `curl -f x` again after the merge')
    expect(d?.condition).toContain('the smoke check exited 7')
    expect(validatePlan(PLAN, '- [ ] a :: check: x\n- [ ] b :: check: y\n', false).ok).toBe(true)
  })
})

describe('ship', () => {
  test('log tail reads from the offset and survives a trimmed log', () => {
    const log = '{"event":"start","branch":"goal/01-a"}\n{"event":"met","goal":"a","branch":"goal/01-a"}\nnot json\n'
    expect(readLog(log, 0).entries.map(e => e.event)).toEqual(['start', 'met'])
    // A last line that does not parse may be torn: the cursor stays before it.
    expect(readLog(log, 2)).toEqual({ entries: [], offset: 2, last: '{"event":"met","goal":"a","branch":"goal/01-a"}' })
    expect(readLog(log, 99).entries).toHaveLength(2)
  })

  test('the log is followed by its last line read, so a trimmed log neither stalls nor replays', () => {
    const line = (i: number) => JSON.stringify({ ts: `t${i}`, event: 'start', branch: `b${i}` })
    const text = (from: number, to: number) => `${Array.from({ length: to - from }, (_, k) => line(from + k)).join('\n')}\n`
    const first = readLog(text(0, 5), 0)
    expect(first.last).toBe(line(4))
    expect(readLog(text(2, 7), first.offset, first.last).entries.map(e => e.branch)).toEqual(['b5', 'b6'])
    expect(readLog(text(0, 5), 5, line(4)).entries).toEqual([])
    expect(readLog(text(10, 15), 5, line(4)).entries).toHaveLength(5)
  })

  test('a log read while the loop rewrites it (a prefix, a torn last line) replays nothing and loses nothing', () => {
    const line = (i: number) => JSON.stringify({ ts: `t${i}`, event: 'start', branch: `b${i}` })
    const text = (from: number, to: number) => `${Array.from({ length: to - from }, (_, k) => line(from + k)).join('\n')}\n`
    const prefix = readLog(text(0, 3), 5, line(4))
    expect(prefix.entries).toEqual([])
    expect(prefix.last).toBe(line(4))
    const full = text(0, 6)
    const torn = readLog(full.slice(0, full.length - 10), 5, line(4))
    expect(torn.entries).toEqual([])
    expect(torn.last).toBe(line(4))
    expect(readLog(full, torn.offset, torn.last).entries.map(e => e.branch)).toEqual(['b5'])
  })

  test('checks, mergeability and PR numbers; gh without required checks (P1)', () => {
    expect(parseChecks('[{"bucket":"pass"},{"bucket":"skipping"}]')).toBe('green')
    expect(parseChecks('[{"bucket":"pass"},{"bucket":"pending"}]')).toBe('pending')
    expect(parseChecks('[{"bucket":"fail"}]')).toBe('red')
    expect(parseChecks('')).toBe('none')
    expect(noRequired({ exitCode: 1, stdout: '', stderr: "no required checks reported on the 'goal/01-a' branch" })).toBe(true)
    expect(noRequired({ exitCode: 1, stdout: '', stderr: 'HTTP 502' })).toBe(false)
    expect(noRequired({ exitCode: 0, stdout: '[]', stderr: '' })).toBe(false)
    expect(mergeable('{"state":"OPEN","mergeable":"CONFLICTING"}')).toEqual({ open: true, merged: false, conflict: true, unknown: false })
    expect(mergeable('{"state":"MERGED","mergeable":"UNKNOWN"}')).toEqual({ open: false, merged: true, conflict: false, unknown: false })
    expect(prNumber('https://github.com/o/r/pull/42\n')).toBe(42)
  })

  test('gh is aimed at the pushed remote\'s repository, whatever the URL form', () => {
    expect(repoSlug('git@github.com:o/r.git\n')).toBe('o/r')
    expect(repoSlug('https://github.com/o/r.git')).toBe('o/r')
    expect(repoSlug('https://github.com/o/r')).toBe('o/r')
    expect(repoSlug('ssh://git@github.com/o/r.git')).toBe('o/r')
    expect(repoSlug('https://example.com/o/r.git')).toBeUndefined()
    expect(httpsOf('o/r')).toBe('https://github.com/o/r.git')
  })

  test('one milestone ships at a time; caps stop the run', () => {
    const s = (state: 'push' | 'ci' | 'merged' | 'held', headRef: string) => ({ goal: headRef, headRef, branch: headRef, state, red: 0, since: 0 })
    expect(inFlight([s('merged', 'a'), s('ci', 'b'), s('push', 'c')])?.headRef).toBe('b')
    expect(inFlight([s('merged', 'a'), s('held', 'b')])).toBeUndefined()
    expect(capReached({ merges: 20, startedAt: 0 }, { maxRounds: 3, maxMerges: 20, maxHours: 24 }, 1)).toContain('merge cap')
    expect(capReached({ merges: 0, startedAt: 0 }, { maxRounds: 3, maxMerges: 20, maxHours: 1 }, 3600_001)).toContain('time cap')
  })

  test('a shipping error that repeats: https once for a refused SSH key, the model at 5, hold at 10 checks and 15 min (P2)', () => {
    const note = 'push failed: git@github.com: Permission denied (publickey).'
    expect(shipRemedy({ note, repeats: 0 }, 0)).toBe('https-push')
    expect(shipRemedy({ note, repeats: 1, tried: ['https-push'] }, 0)).toBeUndefined()
    const gh = "gh pr create failed: Head sha can't be blank"
    expect(shipRemedy({ note: gh, repeats: 4 }, 0)).toBeUndefined()
    expect(shipRemedy({ note: gh, repeats: 5 }, 0)).toBe('diagnose')
    expect(shipRemedy({ note: 'x', repeats: 7, tried: ['diagnose'] }, 0)).toBeUndefined()
    // Ten fast CI looks are under two minutes: a short outage is not held.
    expect(shipRemedy({ note: 'x', repeats: 10, tried: ['diagnose'], noteSince: 0 }, 2 * MIN)).toBeUndefined()
    expect(shipRemedy({ note: 'x', repeats: 10, tried: ['diagnose'], noteSince: 0 }, 15 * MIN)).toBe('hold')
    // Never held before the model was asked (it was busy building): asked first, then given 10 min; held unasked only after an hour.
    expect(shipRemedy({ note: 'x', repeats: 40, noteSince: 0 }, 30 * MIN)).toBe('diagnose')
    expect(shipRemedy({ note: 'x', repeats: 40, noteSince: 0, askedAt: 30 * MIN }, 35 * MIN)).toBeUndefined()
    expect(shipRemedy({ note: 'x', repeats: 40, noteSince: 0, askedAt: 30 * MIN }, 40 * MIN)).toBe('hold')
    expect(shipRemedy({ note: 'x', repeats: 120, noteSince: 0 }, 60 * MIN)).toBe('hold')
    expect(shipRemedy({ repeats: 30 }, 0)).toBeUndefined()
    // The runs the driver cancelled to re-run them are not a red CI.
    expect(onlyCancelled('[{"bucket":"cancel"},{"bucket":"pass"}]')).toBe(true)
    expect(onlyCancelled('[{"bucket":"cancel"},{"bucket":"fail"}]')).toBe(false)
  })

  test('a CI that does not finish is re-run once after 90 min (30 min when every run is still queued), then held', () => {
    const item = { state: 'ci' as const, since: 0 }
    expect(ciAction(item, 89 * MIN, false)).toBeUndefined()
    expect(ciAction(item, 90 * MIN, false)).toBe('rerun')
    expect(ciAction(item, 31 * MIN, true)).toBe('rerun')
    expect(ciAction({ ...item, rerunAt: 90 * MIN }, 150 * MIN, false)).toBeUndefined()
    expect(ciAction({ ...item, rerunAt: 90 * MIN }, 180 * MIN, false)).toBe('hold')
    expect(ciAction({ ...item, note: 'push failed' }, 500 * MIN, true)).toBeUndefined()
  })

  test('hold causes are classed, so one cause holding two milestones in a row stops the run', () => {
    expect(causeOf('CI did not finish: waited 180 min, re-run once')).toBe('ci-stuck')
    expect(causeOf('stuck at push for 10 checks: push failed: Permission denied (publickey)')).toBe('auth')
    expect(causeOf("gh pr create failed: Head sha can't be blank")).toBe('gh-repo')
    expect(causeOf('after 3 failures: CI failed (gh pr checks --required)')).toBe('ci-red')
    expect(causeOf('its worktree /x and branch goal/01 are gone')).toBe('worktree')
  })

  test('a milestone open in a quiet session is woken at 1, 3 and 6 min of quiet, blocked at 12; quiet is not waiting (P4, P5)', () => {
    expect(wakeDue(MIN - 1, 0)).toBe(false)
    expect(wakeDue(MIN, 0)).toBe(true)
    expect(wakeDue(2 * MIN, 1)).toBe(false)
    expect(wakeDue(3 * MIN, 1)).toBe(true)
    expect(wakeDue(6 * MIN, 2)).toBe(true)
    expect(wakeDue(11 * MIN, 3)).toBe(false)
    expect(wakeDue(12 * MIN, 3)).toBe(true)
    const building = { started: 1, finished: 0, ships: [] }
    expect(isWaiting(building, 0)).toBe(true)
    expect(isWaiting(building, 0, 30_000)).toBe(true)
    expect(isWaiting(building, 0, MIN)).toBe(false)
  })

  test('the next milestone starts on the default branch, a fix on its own base, else stacked on the last one shipping, at most MAX_AHEAD deep', () => {
    const ship = (headRef: string, state: ShipState) => ({ goal: headRef, headRef, branch: headRef, state, red: 0, since: 0 })
    expect(startBase({ ships: [] }, {}, 'origin/main')).toEqual({ base: 'origin/main', stacked: false })
    expect(startBase({ ships: [ship('a', 'merged'), ship('b', 'held')] }, {}, 'origin/main')).toEqual({ base: 'origin/main', stacked: false })
    expect(startBase({ ships: [ship('a', 'ci')] }, { base: 'goal/01-a' }, 'origin/main')).toEqual({ base: 'goal/01-a', stacked: false })
    expect(startBase({ ships: [ship('a', 'ci')] }, {}, 'origin/main')).toEqual({ base: 'a', stacked: true })
    expect(startBase({ ships: [ship('a', 'ci'), ship('b', 'stacked')] }, {}, 'origin/main')).toEqual({ base: 'b', stacked: true })
    expect(MAX_AHEAD).toBe(2)
    expect(startBase({ ships: [ship('a', 'ci'), ship('b', 'stacked'), ship('c', 'stacked')] }, {}, 'origin/main')).toBeUndefined()
    // A deploy under repair: the repair goes first, nothing piles on.
    expect(startBase({ ships: [ship('a', 'stacked')], repair: 'repair it' }, {}, 'origin/main')).toBeUndefined()
    expect(startBase({ ships: [ship('a', 'stacked')], repair: 'repair it' }, { base: 'origin/main' }, 'origin/main')).toEqual({ base: 'origin/main', stacked: false })
    expect(unfinished([ship('a', 'merged'), ship('b', 'fixing'), ship('c', 'stacked')]).map(s => s.headRef)).toEqual(['b', 'c'])
    expect(inFlight([ship('c', 'stacked')])).toBeUndefined()
  })

  test('progressSig ignores an error note; idleDue is 15 min, then 30 min apart, at most 3', () => {
    const ship = { goal: 'g', headRef: 'a', branch: 'a', state: 'push' as const, red: 0, since: 0 }
    const base = { started: 1, finished: 1, merges: 0, held: 0 }
    expect(progressSig({ ...base, ships: [ship] })).toBe(progressSig({ ...base, ships: [{ ...ship, note: 'push failed' }] }))
    expect(progressSig({ ...base, ships: [ship] })).not.toBe(progressSig({ ...base, ships: [{ ...ship, state: 'ci' as const }] }))
    const r = { on: true, phase: 'run' as const, movedAt: 0 }
    expect(idleDue({ ...r }, 14 * MIN)).toBeUndefined()
    expect(idleDue({ ...r }, 15 * MIN)).toBe(1)
    expect(idleDue({ ...r, idleNudges: 1, idleNudgedAt: 15 * MIN }, 44 * MIN)).toBeUndefined()
    expect(idleDue({ ...r, idleNudges: 1, idleNudgedAt: 15 * MIN }, 45 * MIN)).toBe(2)
    expect(idleDue({ ...r, idleNudges: 3, idleNudgedAt: 75 * MIN }, 500 * MIN)).toBeUndefined()
    expect(idleDue({ ...r, phase: 'plan' }, 500 * MIN)).toBeUndefined()
  })
})

describe('deploy', () => {
  test('the deploy file names a command, optional CodeQL languages, a smoke check and a bounded timeout', () => {
    expect(parseDeploy('{"command": "bash scripts/deploy.sh"}')).toEqual({ command: 'bash scripts/deploy.sh', codeql: [], timeoutMs: 600_000, source: 'file' })
    expect(parseDeploy('{"command": "make ship", "codeql": "python", "timeoutSec": 60, "smoke": "curl -f x"}')).toEqual({ command: 'make ship', codeql: ['python'], timeoutMs: 60_000, smoke: 'curl -f x', source: 'file' })
    expect(parseDeploy('{"command": "x", "codeql": ["python", "javascript"], "timeoutSec": 9999}')).toMatchObject({ codeql: ['python', 'javascript'], timeoutMs: 600_000 })
    expect(parseDeploy('{"codeql": "python"}')).toHaveProperty('error')
    expect(parseDeploy('{"command": "x", "codeql": "py thon"}')).toHaveProperty('error')
    expect(parseDeploy('{"command": "x", "smoke": 3}')).toHaveProperty('error')
    expect(parseDeploy('not json')).toHaveProperty('error')
    expect(specOfPlan({ kind: 'command', command: 'bash d.sh', smoke: 's', codeql: [] })).toEqual({ command: 'bash d.sh', codeql: [], timeoutMs: 600_000, smoke: 's', source: 'plan' })
  })

  test('the files a deploy command names, which must be on the default branch before it runs', () => {
    expect(scriptsOf('bash scripts/deploy.sh')).toEqual(['scripts/deploy.sh'])
    expect(scriptsOf('./deploy && python3 ops/smoke.py --x')).toEqual(['./deploy', 'ops/smoke.py'])
    expect(scriptsOf('fly deploy --remote-only')).toEqual([])
    expect(scriptsOf('bash /opt/global.sh')).toEqual([])
  })

  test('SARIF errors are counted by their own level, else their rule\'s default', () => {
    const sarif = JSON.stringify({
      runs: [
        {
          tool: { driver: { rules: [{ id: 'py/clear-text-logging-sensitive-data', defaultConfiguration: { level: 'error' } }, { id: 'py/log-injection' }] } },
          results: [
            { ruleId: 'py/clear-text-logging-sensitive-data', locations: [{ physicalLocation: { artifactLocation: { uri: 'broker.py' }, region: { startLine: 12 } } }] },
            { ruleId: 'py/log-injection' },
            { ruleId: 'py/log-injection', level: 'note' },
          ],
        },
      ],
    })
    expect(countSarif(sarif)).toEqual({ errors: 1, warnings: 1, top: ['py/clear-text-logging-sensitive-data broker.py:12'] })
    expect(countSarif('{')).toBeUndefined()
  })
})

const QUEUE_DOC = `# goals

- [x] old goal <!-- done 2026-10-24T10:00Z goal/01-old, 0 failed checks -->
- [ ] add()가 a + b를 반환한다 :: check: pytest -q tests/test_a.py
- [!] blocked one <!-- blocked: no creds -->
- [ ] plain goal without check
not a goal line
`

describe('queue', () => {
  test('parses marks, conditions, checks and notes', async () => {
    const items = parseQueue(QUEUE_DOC)
    expect(items.map(item => item.mark)).toEqual(['x', ' ', '!', ' '])
    expect(items[1]?.condition).toBe('add()가 a + b를 반환한다')
    expect(items[1]?.check).toBe('pytest -q tests/test_a.py')
    expect(items[0]?.note).toContain('goal/01-old')
    expect(items[3]?.check).toBeUndefined()
    expect(nextPending(items)?.condition).toBe('add()가 a + b를 반환한다')
    expect(summarize(items)).toEqual({ done: 1, blocked: 1, pending: 2, total: 4 })
  })

  test('marks the pending line by its condition and keeps the check', async () => {
    const marked = markItem(QUEUE_DOC, 'add()가 a + b를 반환한다', 'x', 'done --> now')
    const items = parseQueue(marked)
    expect(items[1]?.mark).toBe('x')
    expect(items[1]?.check).toBe('pytest -q tests/test_a.py')
    expect(items[1]?.note).toBe('done - -> now')
    expect(nextPending(items)?.condition).toBe('plain goal without check')
    expect(nextPending(parseQueue('- [ ] milestone 3 :: check: x\n- [ ] fix PR #2 :: check: y :: base: goal/02-b\n'))?.condition).toBe('fix PR #2')
    expect(markItem(QUEUE_DOC, 'nope', '!', 'x')).toBe(QUEUE_DOC)
  })

  test('slugify keeps ascii words and falls back to "goal"; seq starts above the branches there are', async () => {
    expect(slugify('Fix add() in counter.py')).toBe('fix-add-in-counter-py')
    expect(slugify('한글만 있는 목표')).toBe('goal')
    expect(maxBranchSeq('goal/03-a\ngoal/17-b\nfeature/x\ngoal/x\n')).toBe(17)
    expect(maxBranchSeq('')).toBe(0)
  })
})

const CTX = { repoRoot: '/repo', worktree: '/repo/worktrees/goal-01-x', extraDeny: ['\\bplace_order\\b'] }

describe('guard', () => {
  test('a run never waits inside a turn: long sleeps, CI watches, cron and wake-ups are refused; short sleeps pass', () => {
    for (const c of ['sleep 300', 'sleep 1m', 'sleep 30 30', 'make test && sleep 120', 'gh run watch 123', 'gh pr checks 7 --watch', 'X=1 sleep 90', 'sleep $((60*5))', 'echo $(sleep 600)']) expect(waitsLong(c)).toBe(true)
    for (const c of ['sleep 5', 'sleep 0.5', 'npm test', 'gh pr checks 7', 'git commit -m "sleep 600 then gh run watch"', 'echo sleep 600']) expect(waitsLong(c)).toBe(false)
    for (const tool of ['CronCreate', 'ScheduleWakeup', 'Monitor']) {
      expect(guardRefusal({ tool }, null, true)).toContain('do not wait or schedule a wake-up')
      expect(guardRefusal({ tool }, null, false)).toBeUndefined()
    }
    expect(guardRefusal({ tool: 'Bash', command: 'sleep 900' }, null, true)).toContain('auto-claude watches CI')
    expect(guardRefusal({ tool: 'Bash', command: 'sleep 3' }, null, true)).toBeUndefined()
  })

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
    ['helm upgrade api ./chart', false],
    ['wrangler deploy', false],
    ['fly deploy', false],
    // Read-only looks at what is deployed, to debug a smoke check.
    ['kubectl get pods -n api', true],
    ['kubectl -n api logs deploy/api --tail 50 | grep ERROR', true],
    ['fly status && fly logs', true],
    ['wrangler tail', true],
    ['kubectl get pods && kubectl apply -f x.yaml', false],
    // A read-only look cannot carry a write: a single &, a substitution, backticks.
    ['kubectl get pods & kubectl delete ns x', false],
    ['kubectl get $(kubectl delete ns x)', false],
    ['kubectl get `kubectl delete ns x`', false],
    ['kubectl get pods --output yaml; helm rollback api 3', false],
    ['KUBECONFIG=/tmp/k kubectl -n api describe pod api-1', true],
    ['kubectl get deploy/api -o yaml | kubectl apply -f -', false],
    // Long inputs are judged in linear time (CodeQL js/redos on the regex this replaced).
    [`kubectl ${'-a b '.repeat(5000)}get pods`, true],
    ['rm -rf build', true],
    ['rm -rf /repo/worktrees/goal-01-x/build', true],
    ['rm -rf /repo/src', false],
    ['rm -rf ../other', false],
    ['rm -fr ~/x', false],
    ['rm -r -f $HOME/x', false],
    ['rm -r build', true],
    ['python place_order.py', false],
    ['pytest -q && git commit -am "fix"', true],
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

  test('deploysSomething looks at each segment', () => {
    expect(deploysSomething('kubectl get pods')).toBe(false)
    expect(deploysSomething('echo hi; kubectl delete pod x')).toBe(true)
  })

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

describe('evaluator', () => {
  test('parseVerdict reads the JSON line and rejects anything else', async () => {
    expect(parseVerdict('{"met": true, "reason": "2 passed"}')).toEqual({ kind: 'met', reason: '2 passed' })
    expect(parseVerdict('noise {"met": false, "reason": "x"} noise')).toEqual({ kind: 'unmet', reason: 'x' })
    expect(parseVerdict('no json')).toMatchObject({ kind: 'unparsable' })
    expect(parseVerdict('{"met": "yes"}')).toMatchObject({ kind: 'unparsable' })
  })

  test('transcriptTail keeps tool calls and their outputs', async () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix add' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest -q' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: '2 passed' }] }] } }),
      'garbage',
    ].join('\n')
    const tail = transcriptTail(jsonl)
    expect(tail).toContain('[user] fix add')
    expect(tail).toContain('[tool_use Bash] {"command":"pytest -q"}')
    expect(tail).toContain('[tool_result] 2 passed')
  })
})

describe('Linear sync rules', () => {
  test('issue IDs come from the start of a condition only', async () => {
    expect(lineIssues('[AX-1][AX-2] two at once')).toEqual(['AX-1', 'AX-2'])
    expect(lineIssues('fix AX-1 later')).toEqual([])
  })

  test('changes on issues in flight wait for the merge; pending lines absorb them; follow-ups are capped', async () => {
    const issue = (id: string, updatedAt: string) => ({ id, title: id, updatedAt, statusType: 'unstarted' })
    const issues = [issue('A-1', 't2'), issue('A-2', 't2'), issue('A-3', 't2'), issue('A-4', 't2'), { ...issue('A-5', 't2'), statusType: 'completed' }]
    const seen = { 'A-1': 't1', 'A-2': 't1', 'A-3': 't1', 'A-4': 't1' }
    const got = planSync(issues, {}, seen, new Set(['A-2']), new Set(['A-1']), { 'A-4': MAX_FOLLOW_UPS })
    expect(got.append.map(i => i.id)).toEqual(['A-3'])
    expect(got.seen['A-1']).toBe('t1')
    expect(got.seen['A-2']).toBe('t2')
    expect(got.seen['A-4']).toBe('t2')
    expect(got.seen['A-5']).toBeUndefined()
  })
})

test('a comment written before the run started is not a change, whichever issues a scan reads', () => {
  const now = Date.parse('2026-11-13T15:00:00Z')
  const issues = Array.from({ length: 30 }, (_, n) => ({ id: `A-${n}`, title: 't', updatedAt: '2026-11-01T00:00:00Z', statusType: 'backlog' }))
  const seen = baselineSeen(issues, now)
  const old = Object.fromEntries(issues.map(i => [i.id, [{ body: 'old note', createdAt: '2026-11-10T00:00:00Z' }]]))
  expect(planSync(issues, old, seen, new Set(), new Set()).append).toEqual([])
  const fresh = { 'A-29': [{ body: 'new ask', createdAt: '2026-11-13T15:05:00Z' }] }
  expect(planSync(issues, fresh, seen, new Set(), new Set()).append.map(i => i.id)).toEqual(['A-29'])
})
