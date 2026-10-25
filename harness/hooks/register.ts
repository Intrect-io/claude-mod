import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

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
import { lintPrompt, lintStop, lintToolCall } from './report-lint'
import { issueIds, registerShipGate, shipPrompt, shipStop } from './ship-gate'
import { DEFAULT_TOGGLES, INITIAL_SHIP } from './state'

const envAtom = atom({ plugin: 'harness', key: 'env' } as const, {}, { shape: 'env-1' })
const shipAtom = atom({ plugin: 'harness', key: 'ship' } as const, INITIAL_SHIP, { shape: 'ship-2' })
const togglesAtom = atom({ plugin: 'harness', key: 'toggles' } as const, DEFAULT_TOGGLES, { shape: 'toggles-1' })

// harness: the user's CLAUDE.md and ~/.claude/rules enforced at the tool
// call (guards, ship-gate, report-lint: each switchable, all on by default),
// plus session tooling (§6.5 grant check, memory-gc banner, /repo-status,
// /slim) and workflow automation (commit_preflight, the heartbeat timer).

// One ticker per loaded module; a reload starts the module over.
let ticker: Timer | undefined

const COMMAND = 'harness'
const EXTRA_COMMANDS = [
  { name: 'repo-status', description: 'Branch, changes, last commit and my open PRs, gathered without a model turn' },
  { name: 'slim', description: "Save this session's context to ~/.claude/context/slim-context.md" },
]
const GC_SEEN_KEY = 'memoryGcSeen'
const STORE_KEY = 'toggles'
const FEATURES: Record<string, keyof Toggles> = {
  guards: 'guards',
  'ship-gate': 'shipGate',
  'report-lint': 'reportLint',
}

function showStatus($: EngineInterface, toggles: Toggles) {
  const off = (Object.keys(FEATURES) as Array<keyof typeof FEATURES>).filter(name => !toggles[FEATURES[name] as keyof Toggles])
  // The engine prefixes the plugin's name.
  $.ui.status(off.length === 0 ? 'all rules on' : `${off.join(', ')} off`)
}

export const register: Register = (on, options) => {
  const guardOptions = { orderTools: typeof options.orderTools === 'string' && options.orderTools !== '' ? options.orderTools : DEFAULT_ORDER_TOOLS }

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
    showStatus($, toggles)
    await $.command.register({
      name: COMMAND,
      description: 'Harness: /harness [status | on|off guards|ship-gate|report-lint | skip-codeql | heartbeat start [5m]|stop|status]',
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
  on('tool.call', ($, e, next) =>
    guardsToolCall($, e, Object.assign((ev: typeof e) => lintToolCall($, ev, Object.assign((ev2: typeof e) => trackToolCall($, ev2, next), next)), next), guardOptions),
  )
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

  // The weekly memory scan: a toast every session; the model reads the counts
  // only when they changed since it last did.
  on('classic.SessionStart', async ($, e, next) => {
    const below = await next(e)
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
  })

  // The branch name is the user's own naming of the work: its issue IDs count as
  // mentioned, so /commit's Linear step may comment on them.
  on('tool.call', { tool: 'mcp__harness__commit_preflight' }, async $ => {
    const report = await commitPreflight($)
    const ids = issueIds(report.match(/^issue IDs in branch: (.*)$/m)?.[1] ?? '')
    if (ids.length > 0) await update($, shipAtom, ship => ({ ...ship, mentioned: [...new Set([...ship.mentioned, ...ids])] }))

    return { result: report }
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
        `guards ${toggles.guards ? 'on' : 'off'} · ship-gate ${toggles.shipGate ? 'on' : 'off'} · report-lint ${toggles.reportLint ? 'on' : 'off'}`,
        `venv: ${env.venv ?? `missing (${env.venvMissing ?? 'unknown platform'})`}`,
        `ship-gate this session: open-PR check ${ship.prListed ? 'done' : 'not yet'}, CodeQL ${ship.codeqlRan ? 'ran' : ship.skipCodeql ? 'waived' : 'not yet'}, issues awaiting Done: ${ship.pending.filter(issue => !issue.done || !issue.commented).map(issue => issue.id).join(', ') || 'none'}`,
      ].join('\n'),
    }
  })
}

