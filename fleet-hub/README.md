# fleet-hub

A local hub for the person's Claude Code sessions. It is a Bun daemon, not a mod. It provides:

- **Channel bus and session registry**: SQLite in WAL mode at `~/.claude/fleet/fleet.db`, append-only messages kept for 90 days. A session that sends nothing for 90 s is marked offline.
- **Doors**:
  - `~/.claude/fleet/hub.sock` (mode 0600) serves the [fleet](../fleet/) mod in each session. Through it a session speaks only as itself.
  - `127.0.0.1:4848` serves the dashboard. Every `/api` call carries the dashboard token in an `x-fleet-token` header; cookies are not used.
  - `<tailnet IPv4>:4848` serves the same dashboard, reachable only from the tailnet (for example `http://100.64.0.10:4848`). A device that `tailscale whois` reports as belonging to this node's own user gets in without a token. This node's own tailnet IP is never trusted that way, because a local process could dial it. Every other device needs the token.
  - Requests with any other Host header are refused (DNS rebinding). It never listens on `0.0.0.0` or the LAN. `FLEET_TAILSCALE=0` keeps only the loopback door.
  - Only the dashboard doors can post as the person, talk to the orchestrator or write the grant.
- **Every open session, mod or not**: the hub reads the engine's session registry (`~/.claude/sessions/*.json`, read only) every 15 s. Each live session shows on the dashboard as `native`, and as `fleet` when its mod reports for it.
  - The orchestrator reaches `native` sessions with native `SendMessage`, under the name `fleet-hub`. They answer the same way, so the harness §6.5 check (`from-name == grant.orchestrator`) applies unchanged.
  - The orchestrator's SDK child runs with `crossSessionInbound: accept`. Without it, `settingSources: []` would leave replies from sessions held unread.
- **Orchestrator**: one long-lived Agent SDK session (`@anthropic-ai/claude-agent-sdk`, streaming input), not a Claude Code terminal session.
  - It is isolated with `settingSources: []`, so no plugins, hooks or CLAUDE.md are loaded, and with `tools: []`, so it has no built-in tools.
  - Its tools are the hub tools (`list_sessions`, `read_channel`, `send_to_session`, `post`, `request_grant`, `grant_status`, `slack_post`) plus native `ListAgents`/`SendMessage`. It has no shell, files or web.
  - A grant is its mandate. When the person issues or approves one, or when the hub starts under a live one, the orchestrator is handed the goal and the allowed/forbidden lists and starts on idle sessions. Busy sessions and sessions waiting on the person are left alone. Without a grant it messages sessions only when the person asks.
  - It receives input from three sources: the dashboard chat, allowed Slack users, and a digest of the fleet (sessions waiting on the person or going offline, DMs to `@fleet-hub`).
  - It stops at a daily USD budget.
- **Grant (CLAUDE.md §6.5)**: the file format is the harness one, with `orchestrator: "fleet-hub"`.
  - A grant is written only by a person's action: a dashboard button, or an allowed Slack user's button. The agent can only file a request.
  - Grants last at most 24 h. The previous file is kept as `.prev`. Revoking sets `expires_at` to now.
- **Slack (intrect, the vega app)**: Socket Mode. See the setup section below.

## Run

```sh
cd fleet-hub
bun install
bun src/main.ts        # prints the dashboard URL: http://127.0.0.1:4848/#token=…
bun test
```

The token is in the URL fragment, so it never reaches a server log. It is also kept in `~/.claude/fleet/dashboard-token` (mode 0600).

| env | default |
| --- | --- |
| `FLEET_HOME` | `~/.claude/fleet` |
| `FLEET_SOCKET` | `$FLEET_HOME/hub.sock` |
| `FLEET_PORT` | `4848` |
| `FLEET_GRANT_PATH` | `~/.claude/orchestration-grant.json` |
| `FLEET_ORCHESTRATOR` | `1` (`0` turns the agent off) |
| `FLEET_MODEL` | `claude-opus-5-5` |
| `FLEET_DAILY_USD` | `20` (a runaway guard on the SDK's list-price usage estimate; through cc-router nothing is billed per token) |
| `FLEET_ANTHROPIC_BASE_URL` / `FLEET_ANTHROPIC_AUTH_TOKEN` | unset (the hub's env, then settings.json) |
| `FLEET_TAILSCALE` | `1` (`0`: loopback only) |
| `FLEET_DIGEST_MS` | `300000` |
| `FLEET_SLACK_BOT_SERVICE` / `FLEET_SLACK_APP_SERVICE` | `vega-slack-bot` / `vega-slack-app` (keychain service names) |
| `FLEET_SLACK_ALLOWED_USERS` | empty (Slack stays off until set) |
| `FLEET_SLACK_CHANNEL` | empty (DM to the first allowed user) |

**Model traffic goes through cc-router.** The orchestrator runs with `settingSources: []`, so the bundled `claude` would never read the `env` block of `~/.claude/settings.json`. The hub therefore resolves the router itself and passes it on. It checks three sources in order and uses the first that sets a base URL:

1. `FLEET_ANTHROPIC_BASE_URL` / `FLEET_ANTHROPIC_AUTH_TOKEN`
2. the hub's own `ANTHROPIC_*` environment
3. the `env` block of `~/.claude/settings.json` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`)

The route appears in the hub log (`model traffic via …`) and in the dashboard's orchestrator status. It holds however the hub is started, from a terminal or from launchd.

## Slack setup (once, by the person)

1. At api.slack.com → the vega app:
   - Add a **Bot User**.
   - Enable **Socket Mode**.
   - Create an **App-Level Token** with `connections:write`.
   - Add these bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:write`, `channels:history`.
   - Subscribe to the bot events `app_mention` and `message.im`.
   - Turn on **Interactivity**, which the grant approval buttons need.
   - Reinstall the app to intrect.
2. Put both tokens in the keychain. They never go into files, logs or git.
   ```sh
   security add-generic-password -U -s vega-slack-bot -a fleet -w   # xoxb-… (prompted)
   security add-generic-password -U -s vega-slack-app -a fleet -w   # xapp-… (prompted)
   ```
3. Start the hub with `FLEET_SLACK_ALLOWED_USERS=<your user id>`. Only those user ids reach the orchestrator. Anyone else's mention is dropped and logged.

The hub sends Slack alerts in three cases: a session that has been waiting on the person for 5 minutes, a grant that expires within 30 minutes, and grant requests (with approve and deny buttons).
