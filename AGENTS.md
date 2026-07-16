# Agentic-Factorio agent guidance

## Multi-agent Factorio gameplay

Apply this section only when the user asks to play/control Factorio and the `factorio` MCP tools are available. It does not apply to ordinary repository development.

- For a single short job, play directly; delegation overhead is not justified.
- For two or more genuinely independent gameplay jobs, act as coordinator: use `register_factorio_agent` with role `coordinator`, submit a dependency graph with `coordinate_submit_jobs`, then delegate jobs to native client subagents using the project `factorio-worker` agent.
- Only the coordinator reads player chat or calls `say`. Workers claim one job, lease one in-game companion, reserve spatial write areas, pass `agent_id` and `companion` to actions, report completion, and release everything.
- Use `wait_for_agent_events` in coordinated mode. Do not have multiple agents call legacy `wait_for_chat`.
- Keep dependent actions on one worker/companion. Parallelize only independent jobs.
- The in-game companion crew and native client subagents are different layers: every worker controls at most one leased companion at a time.
- For broad goals, do one shared reconnaissance pass, then submit waves of at most three jobs. Every job must be a 2-5 minute closed milestone with an exact area, inputs, output, and observable definition of done.
- Match the nearest companion to each site and never plan a 128+ tile walk. Stop persistent duties before assigning project work.
- A construction job is not complete after crafting, placing, or hand-feeding one machine. It must verify a closed loop producing or buffering output.
- `wait_for_agent_events` wakes on broker job transitions. Replan immediately after `job_done`/`job_failed`; wait only when no decision or ready work remains.
- If a native subagent fails to start, retry once, then use `coordinate_takeover_job` and execute the ready job in the coordinator instead of leaving it idle.
