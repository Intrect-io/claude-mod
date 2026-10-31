import { atom, read, update } from 'claude-code'
import type { EngineInterface, EventResult, Register, Timer } from 'claude-code'

import type { Toggles } from '../types'
import { registerAskDefault } from './ask-default'
import { commitPreflight, PREFLIGHT_TOOL } from './commit'
import { repoStatus, trackToolCall, writeSlim } from './commands'
import { DEFAULT_ORDER_TOOLS } from './extra-guards'
import { grantVerdict, readGrant, senderName } from './grant'
import { guardsToolCall, loadGuardEnv } from './guards'
import { heartbeatCommand, heartbeatPrompt, heartbeatTurnComplete, heartbeatTurnStart, TICK_MS, tick } from './heartbeat'
import { seedFromTranscript } from './linear-guard'
import { gcSignature, gcSummary, parseGcReport } from './memory-gc'
import { cachedReport, devRepoRoot, formatKb, measureRepo, repoSizeCommand, shrinksRepo, sizeSignature, sizeSummary, statusText } from './repo-size'
import type { SizeReport } from './repo-size'
import { lintPrompt, lintStop, lintToolCall } from './report-lint'
import { segment } from './segment'
import { issueIds, registerShipGate, shipPrompt, shipStop } from './ship-gate'
import { DEFAULT_TOGGLES, INITIAL_SHIP } from './state'

const envAtom = atom({ plugin: 'harness', key: 'env' } as const, {}, { shape: 'env-1' })
const shipAtom = atom({ plugin: 'harness', key: 'ship' } as const, INITIAL_SHIP, { shape: 'ship-2' })
const togglesAtom = atom({ plugin: 'harness', key: 'toggles' } as const, DEFAULT_TOGGLES, { shape: 'toggles-2' })

// harness: the user's CLAUDE.md and ~/.claude/rules enforced at the tool
// call (guards, ship-gate, report-lint: each switchable, all on by default),
// plus session tooling (§6.5 grant check, memory-gc banner, /repo-status,
// /slim) and workflow automation (commit_preflight, the heartbeat timer).

// One ticker per loaded module; a reload starts the module over.
let ticker: Timer | undefined
// The repo-size status piece, set once the background measurement is in.
let repoPiece: string | undefined
// repo-size: the pending measurement (one at a time, a later request moves it)
// and the periodic one that catches a long session's growth and cleanup.
let measureTimer: Timer | undefined
let measureTicker: Timer | undefined

const COMMAND = 'harness'
const EXTRA_COMMANDS = [
  { name: 'repo-status', description: 'Branch, changes, last commit and my open PRs, gathered without a model turn' },
  { name: 'slim', description: "Save this session's context to ~/.claude/context/slim-context.md" },
  { name: 'repo-size', description: 'Measure this repo against its size budget and list cleanup candidates (lists only, deletes nothing)' },
]
const GC_SEEN_KEY = 'memoryGcSeen'
const SIZE_SEEN_KEY = 'repoSizeSeen'

type SessionStartResult = EventResult<'classic.SessionStart'>
// Long enough that the session's first prompt is not competing with du.
const MEASURE_DELAY_MS = 3_000
// After a command that may have freed space: soon, but after a burst of them.
const REMEASURE_DELAY_MS = 5_000
const MEASURE_EVERY_MS = 30 * 60_000
const STORE_KEY = 'toggles'
const FEATURES: Record<string, keyof Toggles> = {
  guards: 'guards',
  'ship-gate': 'shipGate',
  'report-lint': 'reportLint',
  'repo-size': 'repoSize',
}

function showStatus($: EngineInterface, toggles: Toggles) {
  const off = (Object.keys(FEATURES) as Array<keyof typeof FEATURES>).filter(name => !toggles[FEATURES[name] as keyof Toggles])
  // All rules on is the normal state: no row. A rule switched off is worth one.
  // The engine prefixes the plugin's name.
  const parts = [off.length === 0 ? undefined : `${off.join(', ')} off`, toggles.repoSize ? repoPiece : undefined].filter((part): part is string => part !== undefined)
  $.ui.status(parts.length === 0 ? undefined : parts.join(' · '))
}

// The weekly memory scan: a toast every session; the model reads the counts
// only when they changed since it last did.
async function memoryGcStart($: EngineInterface, below: SessionStartResult): Promise<SessionStartResult> {
  const home = (await read($, envAtom)).home ?? (await $.env.get('HOME'))
  if (home === undefined) return below
  let report
  try {
    report = parseGcReport(await $.fs.read(`${home}/.claude/memory-gc-report.json`))
  } catch {
    return below
  }
  const summary = report === undefined ? undefined : gcSummary(report)
  if (report === undefined || summary === undefined) return below
  $.ui.toast(summary)
  const signature = gcSignature(report)
  if ((await $.store.get(GC_SEEN_KEY)) === signature) return below
  await $.store.set(GC_SEEN_KEY, signature)

  return { ...below, additionalContext: [...(below.additionalContext ?? []), `${summary}\n상세: ${home}/.claude/memory-gc-report.md`] }
}

// repo-size: the last measurement's breakdown reaches the model only when it
// changed since it last did (the fresh one runs in the background).
async function repoSizeStart($: EngineInterface, below: SessionStartResult): Promise<SessionStartResult> {
  if (!(await read($, togglesAtom)).repoSize) return below
  const root = await devRepoRoot($, (await read($, envAtom)).home ?? (await $.env.get('HOME')))
  const report = root === undefined ? undefined : await cachedReport($, root)
  if (report === undefined || !report.over) return below
  const seen = (await $.store.get(SIZE_SEEN_KEY)) as Record<string, string> | undefined
  const signature = sizeSignature(report)
  if (seen?.[report.root] === signature) return below
  await $.store.set(SIZE_SEEN_KEY, { ...(seen ?? {}), [report.root]: signature })

  return { ...below, additionalContext: [...(below.additionalContext ?? []), sizeSummary(report)] }
}

// Measures the session's repo off the session's path, then shows the verdict.
function scheduleMeasure($: EngineInterface, delayMs = MEASURE_DELAY_MS) {
  measureTimer?.cancel()
  measureTimer = $.clock.after(delayMs, () => {
    measureTimer = undefined
    void (async () => {
      if (!(await read($, togglesAtom)).repoSize) return
      const home = (await read($, envAtom)).home ?? (await $.env.get('HOME'))
      const root = await devRepoRoot($, home)
      if (root === undefined) return
      const before = await cachedReport($, root)
      const report = await measureRepo($, root, Date.now())
      if (report !== undefined) showMeasured($, before, report)
    })().catch(error => $.ui.log(`harness: repo-size measure failed: ${String(error).slice(0, 200)}`, { to: 'debug' }))
  })
}

// The status follows every measurement; a toast only when the verdict or the
// size moved, including the way back under budget after a cleanup.
function showMeasured($: EngineInterface, before: SizeReport | undefined, report: SizeReport) {
  repoPiece = statusText(report)
  void read($, togglesAtom).then(toggles => showStatus($, toggles))
  if (before !== undefined && sizeSignature(before) === sizeSignature(report)) return
  if (report.over) $.ui.toast(`repo-size: ${report.root} ${statusText(report) ?? ''} — /repo-size lists cleanup candidates`)
  else if (before?.over === true) $.ui.toast(`repo-size: ${report.root} is back under budget (${formatKb(report.totalKb)}/${formatKb(report.budgetKb)})`)
}

export const register: Register = (on, options) => {
  const guardOptions = { orderTools: typeof options.orderTools === 'string' && options.orderTools !== '' ? options.orderTools : DEFAULT_ORDER_TOOLS }

  // A piece never outlives its session: cleared at its end, by the ending id.
  on('session.end', async ($, e, next) => {
    await segment($, '', e.sessionId)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    const toggles = { ...DEFAULT_TOGGLES, ...(typeof stored === 'object' && stored !== null ? (stored as Partial<Toggles>) : {}) }
    await update($, togglesAtom, () => toggles)
    await loadGuardEnv($)
    // Loaded into a running session: earlier prompts still count as requests.
    const seen = await seedFromTranscript($)
    await update($, shipAtom, ship => ({
      ...ship,
      linearRequested: ship.linearRequested || seen.requested,
      mentioned: [...new Set([...ship.mentioned, ...seen.mentioned])],
    }))
    repoPiece = undefined
    showStatus($, toggles)
    if (toggles.repoSize) scheduleMeasure($)
    measureTicker?.cancel()
    measureTicker = $.clock.every(MEASURE_EVERY_MS, () => scheduleMeasure($, 0))
    await $.command.register({
      name: COMMAND,
      description: 'Harness: /harness [status | on|off guards|ship-gate|report-lint|repo-size | skip-codeql | heartbeat start [5m]|stop|status]',
    })
    // A user command of the same name keeps its name; the rest still register.
    for (const spec of EXTRA_COMMANDS) {
      try {
        await $.command.register(spec)
      } catch {
        $.ui.log(`harness: /${spec.name} not registered (a command of that name exists)`, { to: 'debug' })
      }
    }

    try {
      await $.tool.register(PREFLIGHT_TOOL)
    } catch {
      $.ui.log('harness: commit_preflight not registered', { to: 'debug' })
    }
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      void tick($).catch(error => $.ui.log(`harness: heartbeat tick failed: ${String(error).slice(0, 200)}`, { to: 'debug' }))
    })

    return next(e)
  })

  // The engine takes one matcher-less hook per event from a plugin, so the
  // features' handlers for the same event run as one chain.
  on('tool.call', async ($, e, next) => {
    const result = await guardsToolCall($, e, Object.assign((ev: typeof e) => lintToolCall($, ev, Object.assign((ev2: typeof e) => trackToolCall($, ev2, next), next)), next), guardOptions)
    // repo-size: a command that may have freed space is measured again.
    const command = (e as unknown as { command?: unknown }).command
    if (e.tool === 'Bash' && typeof command === 'string' && result.deny === undefined && shrinksRepo(command) && (await read($, togglesAtom)).repoSize) {
      scheduleMeasure($, REMEASURE_DELAY_MS)
    }

    return result
  })
  on('classic.UserPromptSubmit', ($, e, next) =>
    shipPrompt($, e, Object.assign((ev: typeof e) => lintPrompt($, ev, Object.assign((ev2: typeof e) => heartbeatPrompt($, ev2, next), next)), next)),
  )
  on('turn.start', heartbeatTurnStart)
  on('turn.complete', heartbeatTurnComplete)
  on('classic.Stop', ($, e, next) => shipStop($, e, Object.assign((ev: typeof e) => lintStop($, ev, next), next)))
  registerShipGate(on)

  // CLAUDE.md §6.5, checked in code: the verdict rides on top of the message.
  on('session.receive', async ($, e, next) => {
    if ((e.origin.kind !== 'peer' && e.origin.kind !== 'peer-send-message') || e.agentId !== undefined) return next(e)
    const sender = senderName(e.text)
    if (sender === undefined && !/<cross-session-message\b/.test(e.text)) return next(e)
    const home = (await read($, envAtom)).home ?? (await $.env.get('HOME'))
    const verdict = grantVerdict(await readGrant($, home), sender, Date.now())

    return next({ ...e, text: `${verdict}\n\n${e.text}` })
  })

  // One matcher-less hook per event: the memory scan and repo-size as one chain.
  on('classic.SessionStart', async ($, e, next) => memoryGcStart($, await repoSizeStart($, await next(e))))

  // The branch name is the user's own naming of the work: its issue IDs count as
  // mentioned, so /commit's Linear step may comment on them.
  on('tool.call', { tool: 'mcp__harness__commit_preflight' }, async $ => {
    const report = await commitPreflight($)
    const ids = issueIds(report.match(/^issue IDs in branch: (.*)$/m)?.[1] ?? '')
    if (ids.length > 0) await update($, shipAtom, ship => ({ ...ship, mentioned: [...new Set([...ship.mentioned, ...ids])] }))

    return { result: report }
  })

  on('command.run', { command: 'repo-size' }, async $ => {
    const home = (await read($, envAtom)).home ?? (await $.env.get('HOME'))
    const root = await devRepoRoot($, home)
    const before = root === undefined ? undefined : await cachedReport($, root)
    const text = await repoSizeCommand($, home, Date.now())
    const after = root === undefined ? undefined : await cachedReport($, root)
    if (after !== undefined && after.at !== before?.at) showMeasured($, before, after)

    return { text }
  })

  on('command.run', { command: 'repo-status' }, async $ => ({ text: await repoStatus($, Date.now()) }))

  on('command.run', { command: 'slim' }, async $ => {
    const env = await read($, envAtom)
    const ship = await read($, shipAtom)

    return { text: await writeSlim($, env.home, Date.now(), ship.mentioned) }
  })
  registerAskDefault(on)

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    const [action = 'status', name = ''] = words
    const toggles = await read($, togglesAtom)

    if (action === 'heartbeat') {
      const text = await heartbeatCommand($, words.slice(1))
      if (words[1] === 'stop') showStatus($, toggles)

      return { text }
    }

    if (action === 'skip-codeql') {
      await update($, shipAtom, ship => ({ ...ship, skipCodeql: true }))

      return { text: 'Ship gate: CodeQL waived for releases in this session only.' }
    }
    if (action === 'on' || action === 'off') {
      const key = FEATURES[name]
      if (key === undefined) return { text: `Unknown feature "${name}". One of: ${Object.keys(FEATURES).join(', ')}.` }
      const changed = { ...toggles, [key]: action === 'on' }
      await update($, togglesAtom, () => changed)
      await $.store.set(STORE_KEY, changed)
      showStatus($, changed)

      return { text: `harness: ${name} ${action} (kept for later sessions).` }
    }

    const env = await read($, envAtom)
    const ship = await read($, shipAtom)

    return {
      text: [
        `guards ${toggles.guards ? 'on' : 'off'} · ship-gate ${toggles.shipGate ? 'on' : 'off'} · report-lint ${toggles.reportLint ? 'on' : 'off'} · repo-size ${toggles.repoSize ? 'on' : 'off'}`,
        `venv: ${env.venv ?? `missing (${env.venvMissing ?? 'unknown platform'})`}`,
        `ship-gate this session: open-PR check ${ship.prListed ? 'done' : 'not yet'}, CodeQL ${ship.codeqlRan ? 'ran' : ship.skipCodeql ? 'waived' : 'not yet'}, issues awaiting Done: ${ship.pending.filter(issue => !issue.done || !issue.commented).map(issue => issue.id).join(', ') || 'none'}`,
      ].join('\n'),
    }
  })
}

