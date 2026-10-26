import { homedir } from 'node:os'
import { join } from 'node:path'

// Where the hub's model traffic goes and where its dashboard listens.
//
// Router: the orchestrator runs with `settingSources: []`, so the bundled
// `claude` never reads ~/.claude/settings.json and its `env` block (where
// cc-router's ANTHROPIC_BASE_URL and token live). The hub reads that block
// itself and hands the router's variables to the SDK, so the orchestrator
// bills through cc-router however the hub was started (terminal, launchd).
//
// Tailscale: besides 127.0.0.1 the dashboard listens on this node's tailnet
// IPv4, reachable only from the person's tailnet; the token still gates /api.

export const ROUTER_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS'] as const

export type RouterEnv = { env: Record<string, string>; source: 'FLEET_*' | 'environment' | 'settings.json' | 'none'; baseUrl?: string }

// FLEET_ANTHROPIC_* overrides; then the hub's own environment; then the env
// block of ~/.claude/settings.json. The first source holding a base URL wins whole.
export function routerEnv(processEnv: Record<string, string | undefined>, settingsText: string | undefined): RouterEnv {
  const pick = (get: (key: string) => unknown) => {
    const env: Record<string, string> = {}
    for (const key of ROUTER_KEYS) {
      const value = get(key)
      if (typeof value === 'string' && value !== '') env[key] = value
    }
    return env
  }
  const fleet = pick(key => processEnv[`FLEET_${key}`])
  if (fleet.ANTHROPIC_BASE_URL !== undefined) return { env: fleet, source: 'FLEET_*', baseUrl: fleet.ANTHROPIC_BASE_URL }
  const own = pick(key => processEnv[key])
  if (own.ANTHROPIC_BASE_URL !== undefined) return { env: own, source: 'environment', baseUrl: own.ANTHROPIC_BASE_URL }
  if (settingsText !== undefined) {
    try {
      const block = (JSON.parse(settingsText) as { env?: Record<string, unknown> }).env ?? {}
      const fromSettings = pick(key => block[key])
      if (fromSettings.ANTHROPIC_BASE_URL !== undefined) return { env: fromSettings, source: 'settings.json', baseUrl: fromSettings.ANTHROPIC_BASE_URL }
    } catch {
      // An unreadable settings file means no router.
    }
  }
  return { env: {}, source: 'none' }
}

export async function readSettings(): Promise<string | undefined> {
  const file = Bun.file(join(homedir(), '.claude', 'settings.json'))
  return (await file.exists()) ? file.text() : undefined
}

export type Tailnet = { ip: string; dnsName?: string; userId?: number }

// This node's tailnet IPv4 and MagicDNS name, or undefined without Tailscale.
export async function tailnet(): Promise<Tailnet | undefined> {
  try {
    const proc = Bun.spawn(['tailscale', 'status', '--json'], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return undefined
    const self = (JSON.parse(text) as { Self?: { TailscaleIPs?: string[]; DNSName?: string; UserID?: number } }).Self
    const ip = self?.TailscaleIPs?.find(a => /^100\.\d+\.\d+\.\d+$/.test(a))
    if (ip === undefined) return undefined
    return { ip, dnsName: self?.DNSName?.replace(/\.$/, '') || undefined, userId: typeof self?.UserID === 'number' ? self.UserID : undefined }
  } catch {
    return undefined
  }
}

// The Host headers the dashboard answers: loopback, and the tailnet names
// when it listens there. Anything else (a rebinding page) is refused.
export function allowedHosts(port: number, net: Tailnet | undefined): Set<string> {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (net !== undefined) {
    hosts.push(`${net.ip}:${port}`)
    if (net.dnsName !== undefined) hosts.push(`${net.dnsName}:${port}`, `${net.dnsName.split('.')[0]}:${port}`)
  }
  return new Set(hosts)
}

// A tailnet peer counts as the person when Tailscale says the device belongs
// to the same user as this node. This node's own tailnet IP never does: a
// local process (a session) could otherwise dial it and pass as the person.
export function isOwnerPeer(ip: string, net: Tailnet | undefined, peerUserId: number | undefined): boolean {
  if (net === undefined || net.userId === undefined || peerUserId === undefined) return false
  if (ip === net.ip || !/^100\.\d+\.\d+\.\d+$/.test(ip)) return false
  return peerUserId === net.userId
}

// `tailscale whois` of a peer IP: its user id, cached for a minute.
export function tailnetAuth(net: Tailnet | undefined, whois: (ip: string) => Promise<number | undefined> = whoisUserId, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; ok: boolean }>()
  return async (ip: string): Promise<boolean> => {
    if (net === undefined || ip === net.ip || !/^100\.\d+\.\d+\.\d+$/.test(ip)) return false
    const hit = cache.get(ip)
    if (hit !== undefined && now() - hit.at < 60_000) return hit.ok
    const ok = isOwnerPeer(ip, net, await whois(ip))
    cache.set(ip, { at: now(), ok })
    return ok
  }
}

export async function whoisUserId(ip: string): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(['tailscale', 'whois', '--json', ip], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return undefined
    const id = (JSON.parse(text) as { UserProfile?: { ID?: number } }).UserProfile?.ID
    return typeof id === 'number' ? id : undefined
  } catch {
    return undefined
  }
}
