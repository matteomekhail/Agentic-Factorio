# Agentic-Factorio agent guidance

## Multi-agent Factorio gameplay

Apply this section only when the user asks to play/control Factorio and the `factorio` MCP tools are available. It does not apply to ordinary repository development.

- For a single short job, play directly; delegation overhead is not justified.
- For two or more genuinely independent gameplay jobs, act as coordinator: use `register_factorio_agent` with role `coordinator`, submit a dependency graph with `coordinate_submit_jobs`, then delegate jobs to native client subagents using the project `factorio-worker` agent.
- Only the coordinator reads player chat or calls `say`. Workers claim one job, lease one in-game companion, reserve spatial write areas, pass `agent_id` and `companion` to actions, report completion, and release everything.
- Use `wait_for_agent_events` in coordinated mode. Do not have multiple agents call legacy `wait_for_chat`.
- Keep dependent actions on one worker/companion. Parallelize only independent jobs.
- The in-game companion crew and native client subagents are different layers: every worker controls at most one leased companion at a time.
