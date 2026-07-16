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

Codex uses the main session's strong model for coordination and the project
worker profile's lower-latency `gpt-5.6-terra`/low-reasoning configuration for
bounded execution. `.codex/config.toml` caps the session at one coordinator and
three workers, matching the useful gameplay fan-out without recursive agents.

For a parallel request it does one shared reconnaissance pass, calls
`coordinate_submit_jobs` with a wave of at most three bounded 2–5 minute
milestones, then asks native subagents to claim them. Each job names its exact
area, inputs, output and observable definition of done. Dependencies can
reference job `key` values from the same submission.

`wait_for_agent_events` includes broker transitions (`job_done`, `job_failed`,
`job_requeued`, `job_expired`), so the coordinator wakes as soon as a worker
finishes and launches the next wave. If a native subagent cannot start after
one retry, the coordinator uses `coordinate_takeover_job` instead of leaving
the queued milestone idle.

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

Workers are deliberately short-horizon: they stop any persistent duty on the
leased body, avoid 128+ tile walks, use no more than two reconnaissance batches,
and build a complete closed loop primarily with one `build_plan`. Missing
placeable items are hand-crafted automatically by that plan when possible.
Crafting or manually filling a machine is progress, not job completion; the
worker verifies flowing inputs and produced or buffered output.

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
