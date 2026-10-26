import type { Bus } from './bus'
import type { GrantRequests } from './grant'
import type { SlackPort } from './http'
import type { From } from './schema'

// Slack (intrect workspace) through the vega app's bot, Socket Mode: no public
// endpoint. Tokens come from the macOS keychain only and are never logged or
// written. Only the allowed user ids reach the orchestrator; anyone else's
// mention is dropped with a log line.

export type SlackConfig = {
  botService: string
  appService: string
  allowedUsers: string[]
  channel?: string
}

export function parseAllowed(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => /^[UW][A-Z0-9]{2,}$/.test(s))
}

export function isAllowed(user: unknown, allowed: readonly string[]): user is string {
  return typeof user === 'string' && allowed.includes(user)
}

// "<@U123> do this" → "do this"
export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim()
}

export async function keychainSecret(service: string): Promise<string | undefined> {
  const proc = Bun.spawn(['security', 'find-generic-password', '-s', service, '-w'], { stdout: 'pipe', stderr: 'ignore' })
  const out = (await new Response(proc.stdout).text()).trim()
  return (await proc.exited) === 0 && out !== '' ? out : undefined
}

type SendTo = { send(text: string, from: From): void }

export class Slack implements SlackPort {
  private state = 'off'
  private detail: string | undefined
  private app: import('@slack/bolt').App | undefined
  private target: string | undefined

  constructor(
    private config: SlackConfig,
    private bus: Bus,
    private log: (line: string) => void,
  ) {}

  status() {
    return { state: this.state, detail: this.detail }
  }

  async start(orchestrator: SendTo | undefined, requests: GrantRequests, settle: (id: string, status: 'approved' | 'denied', by: string) => Promise<Response>) {
    const [botToken, appToken] = await Promise.all([keychainSecret(this.config.botService), keychainSecret(this.config.appService)])
    if (botToken === undefined || appToken === undefined) {
      this.state = 'off'
      this.detail = `no token in keychain (${this.config.botService}, ${this.config.appService})`
      return
    }
    if (this.config.allowedUsers.length === 0) {
      this.state = 'off'
      this.detail = 'FLEET_SLACK_ALLOWED_USERS is empty: nobody could instruct the orchestrator'
      return
    }
    const { App, LogLevel } = await import('@slack/bolt')
    const app = new App({ token: botToken, appToken, socketMode: true, logLevel: LogLevel.WARN })
    this.app = app

    const inbound = async (user: unknown, raw: string) => {
      if (!isAllowed(user, this.config.allowedUsers)) {
        this.log(`slack: ignored a message from ${String(user)} (not in FLEET_SLACK_ALLOWED_USERS)`)
        return
      }
      const said = stripMention(raw)
      if (said === '') return
      const from: From = { kind: 'slack', id: user, name: user }
      this.bus.post('#slack', from, said)
      if (orchestrator === undefined) await this.notify('fleet-hub orchestrator가 꺼져 있습니다.')
      else orchestrator.send(said, from)
    }

    app.event('app_mention', async ({ event }) => inbound(event.user, event.text))
    app.message(async ({ message }) => {
      const m = message as { channel_type?: string; user?: string; text?: string; subtype?: string; bot_id?: string }
      if (m.channel_type !== 'im' || m.subtype !== undefined || m.bot_id !== undefined) return
      await inbound(m.user, m.text ?? '')
    })
    for (const [action, status] of [
      ['fleet_grant_approve', 'approved'],
      ['fleet_grant_deny', 'denied'],
    ] as const) {
      app.action(action, async ({ ack, body, action: a }) => {
        await ack()
        const user = (body as { user?: { id?: string } }).user?.id
        if (!isAllowed(user, this.config.allowedUsers)) return
        const id = (a as { value?: string }).value
        if (id === undefined || requests.get(id) === undefined) return
        const res = await settle(id, status, `Slack user ${user}`)
        await this.notify(res.ok ? `grant 요청 ${id}: ${status === 'approved' ? '승인됨' : '거절됨'}` : `grant 요청 ${id}: 처리 실패`)
      })
    }

    try {
      await app.start()
      this.target = this.config.channel ?? (await app.client.conversations.open({ users: this.config.allowedUsers[0]! })).channel?.id
      this.state = 'connected'
      this.detail = this.target
    } catch (error) {
      this.state = 'error'
      this.detail = String(error).slice(0, 200)
    }
  }

  async notify(text: string): Promise<void> {
    if (this.app === undefined || this.target === undefined) return
    await this.app.client.chat.postMessage({ channel: this.target, text })
  }

  // A grant request with approve/deny buttons; only allowed users' presses count.
  async askGrant(id: string, summary: string): Promise<void> {
    if (this.app === undefined || this.target === undefined) return
    await this.app.client.chat.postMessage({
      channel: this.target,
      text: `fleet-hub grant 요청 ${id}: ${summary}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*fleet-hub grant 요청* \`${id}\`\n${summary}` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '승인' }, style: 'primary', action_id: 'fleet_grant_approve', value: id },
            { type: 'button', text: { type: 'plain_text', text: '거절' }, style: 'danger', action_id: 'fleet_grant_deny', value: id },
          ],
        },
      ],
    })
  }

  async stop() {
    await this.app?.stop()
  }
}
