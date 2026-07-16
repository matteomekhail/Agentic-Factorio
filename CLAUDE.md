# Agentic-Factorio

For normal code work, follow the repository documentation and tests.

When playing Factorio through the `factorio` MCP server, use native subagents only for two or more independent jobs. The main session is the coordinator and is the only agent allowed to read player chat or use `say`. Create jobs with `coordinate_submit_jobs` and delegate them to `factorio-worker` subagents. Workers must claim one job, lease a companion, reserve build areas, pass their `agent_id` to action tools, and release resources when done. Use `wait_for_agent_events` rather than multiple `wait_for_chat` consumers.
