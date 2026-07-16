# Multi-agent gameplay through MCP

The Factorio MCP server supports native client subagents from Codex, Claude Code and other MCP clients. Coordination is client-neutral: every MCP stdio process shares a small broker under `~/.config/agentic-factorio/coordination/`.

## Roles

- **Coordinator:** listens to player chat, decomposes requests, submits jobs, monitors results and is the only agent that calls `say`.
- **Worker:** claims one ready job, leases one in-game companion, performs the job and returns a compact result.
- **Companion:** the physical Factorio character controlled by a worker. A lease prevents two workers from controlling the same body.

## Start a session

The MCP server must already be registered as `factorio`.

The fastest launchers build the current branch, start an unrestricted client session and send the complete coordinator prompt automatically:

```sh
npm run play:codex-agents
npm run play:claude-agents
```

The first uses `codex --yolo`; the second uses Claude Code's
`--dangerously-skip-permissions`. Both modes disable normal permission safety,
so use them only in this trusted repository. The launcher verifies that the
`factorio` MCP server is registered before starting.

- Codex: ask `Play Factorio using native subagents and the play_multi_agent MCP prompt.` Project agent configuration is in `.codex/agents/factorio-worker.toml`.
- Claude Code: invoke the `play_multi_agent` MCP prompt or ask Claude to use `factorio-worker` subagents. Its project agent is in `.claude/agents/factorio-worker.md` and references the configured `factorio` MCP server.

The coordinator begins with:

1. `connect_status`
2. `reset_coordination {confirm:true}` only for a genuinely new session
3. `register_factorio_agent {role:"coordinator", ...}`
4. `wait_for_agent_events`

For a parallel request it calls `coordinate_submit_jobs`, then asks native subagents to claim jobs. Dependencies can reference job `key` values from the same submission.

## Worker lifecycle

```text
register_factorio_agent(role=worker)
  → coordinate_claim_job
  → lease_companion
  → reserve_build_area (for spatial writes)
  → Factorio reads/actions with agent_id + companion
  → coordinate_complete_job | coordinate_fail_job
  → release_build_area
  → release_companion
```

Workers see game events only for companions they currently lease. They never receive player chat. The coordinator sees chat and all events.

## Safety and recovery

- Job claims, companion leases and area reservations are protected by an inter-process lock.
- `idempotency_key` prevents the coordinator from creating the same logical job twice.
- Leases and reservations expire automatically; workers should renew with `lease_companion` during long jobs.
- A claimed job returns to the queue if its worker sends no heartbeat for ten minutes.
- `coordination_status` exposes current jobs and ownership.
- `reset_coordination` clears stale state, but must not be called while workers are active.

## Verification

```sh
npm run test:unit
npm run test:mcp
```

The MCP smoke test runs without Factorio and verifies tool discovery plus coordinator registration/job submission. Live action testing still requires a hosted Factorio save.
