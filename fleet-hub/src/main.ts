import { chmod, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { Bus } from './bus'
import { GrantRequests, grantStatus, readGrantFile } from './grant'
import { createApp } from './http'
import { Orchestrator } from './orchestrator'
import { allowedHosts, readSettings, routerEnv, tailnet, tailnetAuth } from './net'
import { readRegistry, REGISTRY_POLL_MS, syncRegistry } from './registry'
import { parseAllowed, Slack } from './slack'

// fleet-hub: `bun src/main.ts`. Everything is configured by environment:
//   FLEET_HOME (~/.claude/fleet)   FLEET_SOCKET ($FLEET_HOME/hub.sock)   FLEET_PORT (4848)
//   FLEET_GRANT_PATH (~/.claude/orchestration-grant.json)
//   FLEET_ORCHESTRATOR (1; 0 turns the agent off)   FLEET_MODEL (claude-opus-5-5)
//   FLEET_DAILY_USD (20)   FLEET_DIGEST_MS (300000)
//   FLEET_ANTHROPIC_BASE_URL / FLEET_ANTHROPIC_AUTH_TOKEN (the router; else the hub's env, else ~/.claude/settings.json env)
//   FLEET_TAILSCALE (1; 0 keeps the dashboard on 127.0.0.1 only)
//   FLEET_SLACK_BOT_SERVICE (vega-slack-bot)   FLEET_SLACK_APP_SERVICE (vega-slack-app)
//   FLEET_SLACK_ALLOWED_USERS (comma-separated user ids)   FLEET_SLACK_CHANNEL (channel id; DM when unset)

const env = process.env
const home = env.FLEET_HOME ?? join(homedir(), '.claude', 'fleet')
const socketPath = env.FLEET_SOCKET ?? join(home, 'hub.sock')
const port = Number(env.FLEET_PORT ?? 4848)
const grantPath = env.FLEET_GRANT_PATH ?? join(homedir(), '.claude', 'orchestration-grant.json')
const WAITING_ALERT_MS = 5 * 60_000

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

async function dashboardToken(): Promise<string> {
  const path = join(home, 'dashboard-token')
  const file = Bun.file(path)
  if (await file.exists()) {
    const token = (await file.text()).trim()
    if (token.length >= 32) return token
  }
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex')
  await Bun.write(path, `${token}\n`)
  await chmod(path, 0o600)
  return token
}

await mkdir(home, { recursive: true, mode: 0o700 })
await chmod(home, 0o700)
const bus = new Bus(join(home, 'fleet.db'))
const requests = new GrantRequests()
const token = await dashboardToken()

const slack = new Slack(
  {
    botService: env.FLEET_SLACK_BOT_SERVICE ?? 'vega-slack-bot',
    appService: env.FLEET_SLACK_APP_SERVICE ?? 'vega-slack-app',
    allowedUsers: parseAllowed(env.FLEET_SLACK_ALLOWED_USERS),
    channel: env.FLEET_SLACK_CHANNEL || undefined,
  },
  bus,
  log,
)

const router = routerEnv(env, await readSettings())
const net = env.FLEET_TAILSCALE === '0' ? undefined : await tailnet()

const orchestrator =
  env.FLEET_ORCHESTRATOR === '0'
    ? undefined
    : new Orchestrator({
        bus,
        requests,
        grantPath,
        slack,
        model: env.FLEET_MODEL ?? 'claude-opus-5-5',
        dailyUsd: Number(env.FLEET_DAILY_USD ?? 20),
        digestMs: Number(env.FLEET_DIGEST_MS ?? 300_000),
        cwd: home,
        log,
        routerEnv: router.env,
        route: router.baseUrl === undefined ? 'direct (no router)' : `via ${router.baseUrl} (${router.source})`,
      })

const app = createApp({ bus, grantPath, requests, token, webDir: resolve(import.meta.dir, '../web'), orchestrator, slack, allowedHosts: allowedHosts(port, net), tailnetOwner: tailnetAuth(net) })

// A socket file left by a hub that died is removed before listening.
await rm(socketPath, { force: true })
const udsServer = Bun.serve({ unix: socketPath, fetch: req => app.uds(req) })
await chmod(socketPath, 0o600)
const tcpServer = Bun.serve({ hostname: '127.0.0.1', port, fetch: (req, server) => app.tcp(req, server), websocket: app.websocket })
// The tailnet door: the same app on this node's Tailscale IPv4 only, never 0.0.0.0.
let tailServer: ReturnType<typeof Bun.serve> | undefined
if (net !== undefined) {
  try {
    tailServer = Bun.serve({ hostname: net.ip, port, fetch: (req, server) => app.tcp(req, server), websocket: app.websocket })
  } catch (error) {
    log(`fleet-hub: tailnet listener on ${net.ip}:${port} failed: ${String(error).slice(0, 200)}`)
  }
}

const pollRegistry = () => readRegistry().then(natives => syncRegistry(bus, natives)).catch(error => log(`registry: ${String(error).slice(0, 200)}`))
await pollRegistry()
const registryTimer = setInterval(pollRegistry, REGISTRY_POLL_MS)
orchestrator?.start()
{
  const status = grantStatus(await readGrantFile(grantPath), Date.now())
  if (orchestrator !== undefined && status.state === 'valid') orchestrator.granted(status.grant, 'restart')
}
void slack.start(orchestrator, requests, app.settleRequest).then(() => log(`slack: ${JSON.stringify(slack.status())}`))

// Offline sweep, and one Slack alert per stretch a session waits on the person.
const waitingSince = new Map<string, number>()
const alerted = new Set<string>()
bus.subscribe(event => {
  if (event.type !== 'session') return
  const { id, state } = event.session
  if (state === 'waiting_on_user') {
    if (!waitingSince.has(id)) waitingSince.set(id, Date.now())
  } else {
    waitingSince.delete(id)
    alerted.delete(id)
  }
})
let grantAlerted = ''
const sweeper = setInterval(async () => {
  bus.sweep()
  for (const [id, since] of waitingSince) {
    if (alerted.has(id) || Date.now() - since < WAITING_ALERT_MS) continue
    const s = bus.session(id)
    if (s === undefined) continue
    alerted.add(id)
    await slack.notify(`세션 *${s.name}* (${s.repo ?? s.cwd})이 5분째 사용자 응답을 기다립니다.${s.summary ? `\n> ${s.summary}` : ''}`).catch(() => {})
  }
  const status = grantStatus(await readGrantFile(grantPath), Date.now())
  if (status.state === 'valid' && Date.parse(status.grant.expires_at) - Date.now() < 30 * 60_000 && grantAlerted !== status.grant.expires_at) {
    grantAlerted = status.grant.expires_at
    await slack.notify(`fleet grant가 ${status.grant.expires_at}에 만료됩니다.`).catch(() => {})
  }
}, 30_000)

log(`fleet-hub: socket ${socketPath}`)
log(`fleet-hub: dashboard http://127.0.0.1:${tcpServer.port}/#token=${token}`)
if (tailServer !== undefined) log(`fleet-hub: tailnet  http://${net!.ip}:${port}  (your own tailnet devices need no token; also http://${net!.dnsName ?? net!.ip}:${port})`)
log(`fleet-hub: model traffic ${router.baseUrl === undefined ? 'direct (no router found)' : `via ${router.baseUrl} (${router.source})`}`)
log(`fleet-hub: orchestrator ${orchestrator === undefined ? 'off' : 'on'}; grant file ${grantPath}`)

const shutdown = async () => {
  clearInterval(sweeper)
  clearInterval(registryTimer)
  orchestrator?.stop()
  await slack.stop().catch(() => {})
  udsServer.stop(true)
  tcpServer.stop(true)
  tailServer?.stop(true)
  bus.close()
  await rm(socketPath, { force: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
