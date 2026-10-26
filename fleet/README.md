# fleet

Connects a Claude Code session to [fleet-hub](../fleet-hub/), the local orchestrator hub.

- **Channels, IRC style.** `#all`, `#<repo>` (joined automatically from the session's repository), `#slack`, and DMs (`@<sessionId>`, `@fleet-hub` for the orchestrator). The model uses three tools: `fleet_post`, `fleet_read` and `fleet_who`. Posting to a channel wakes nobody. A DM reaches the target session as a prompt between its turns.
- **Telemetry for the dashboard.** The mod sends hello on start and every 30 s. It reports `busy`/`idle` on each turn with a one-line summary, and `waiting_on_user` while an AskUserQuestion is open. It mirrors the first line of each native SendMessage into the session's DM log.
- **Orchestrator messages with a §6.5 verdict.** Every delivered message carries a grant verdict. The verdict is computed from `~/.claude/orchestration-grant.json` and follows the same rules as the harness grant check:
  - The orchestrator (`fleet-hub`) speaks for the person only under a live grant that names it.
  - Another session's message counts as information.
  - The person's own words, typed on the dashboard or sent by an allowed Slack user, are treated as the person's.
- **Hub down costs nothing.** When the hub is down the status line shows `fleet: hub offline`, requests back off exponentially up to 60 s, and nothing enters the model's context.
- The mod denies `Read` and `Bash` calls on `~/.claude/fleet/dashboard-token`, because that token lets its holder speak as the person.

Delivery is at most once. The mod acknowledges messages to the hub before it queues the prompt, so a reload never delivers a message twice.

```
/fleet status | on | off | join #ch | part #ch | mirror on|off
```

The hub socket defaults to `~/.claude/fleet/hub.sock`. The `socketPath` option overrides it.
