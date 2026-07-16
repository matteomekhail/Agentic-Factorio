-- Offline unit tests for scripts/tasks.lua quiet/chain semantics (run_plan's
-- foundations). Stubs every runner module. Run: lua tests/mod/tasks_chain_test.lua
local here = (arg and arg[0] or "."):match("^(.*)/[^/]+$") or "."
package.path = here .. "/../../mod/agentic-companion/?.lua;" .. package.path

local failures = 0
local function check(cond, what)
  if cond then print("ok   " .. what) else failures = failures + 1 print("FAIL " .. what) end
end

-- ------------------------------------------------------------ module stubs
package.loaded["scripts.companion"] = {
  DEFAULT = "AI",
  set_context = function() end,
  context = function() return "AI" end,
  require_companion = function() return {} end,
  get = function() return nil end,
}
local pushed = {}
package.loaded["scripts.events"] = {
  push = function(kind, text) pushed[#pushed + 1] = kind end,
}
-- Every runner: start errors when task.boom, tick finishes with task.outcome.
local runner = {
  start = function(t) if t.boom then error("boom") end end,
  tick = function(t) return { status = t.outcome or "done", detail = "x" } end,
}
runner.place, runner.rotate, runner.set_recipe = runner, runner, runner
runner.insert, runner.extract, runner.deliver = runner, runner, runner
for _, m in ipairs({ "walk", "follow", "mine", "build", "craft", "transfer", "refuel",
  "drive", "build_plan", "deconstruct", "fight", "defend", "build_blueprint" }) do
  package.loaded["scripts.actions." .. m] = runner
end

_G.storage = { tasks = { next_id = 1, records = {}, by_companion = {}, failed_chains = {} } }
_G.game = { tick = 100 }
_G.defines = { shooting = { not_shooting = 0 } }

local tasks = require("scripts.tasks")
local function status_of(id)
  local rec = storage.tasks.records[id]
  return rec and rec.status or "pending"
end

do -- quiet chain: only the last (loud) success emits an event
  local a = tasks.enqueue({ task = { type = "walk_to" }, background = true, quiet = true, chain = "ok1" })
  local b = tasks.enqueue({ task = { type = "walk_to" } , background = true, chain = "ok1" })
  tasks.on_tick() -- a
  tasks.on_tick() -- b
  check(status_of(a.task_id) == "done" and status_of(b.task_id) == "done", "chain: both steps ran")
  check(#pushed == 1 and pushed[1] == "task_done", "chain: exactly ONE task_done (quiet steps silent)")
end

do -- failure cancels queued chain-mates, one task_failed event
  pushed = {}
  package.loaded["scripts.events"].push = function(kind) pushed[#pushed + 1] = kind end
  local a = tasks.enqueue({ task = { type = "walk_to", boom = true }, background = true, quiet = true, chain = "f1" })
  local b = tasks.enqueue({ task = { type = "walk_to" }, background = true, chain = "f1" })
  tasks.on_tick() -- a starts, fails at start -> b cancelled in the queue
  check(status_of(a.task_id) == "failed", "fail-fast: first step failed")
  check(status_of(b.task_id) == "cancelled", "fail-fast: queued chain-mate cancelled")
  check(#pushed == 1 and pushed[1] == "task_failed", "fail-fast: exactly ONE failure event")
end

do -- race: the failure beats the remaining enqueues -> cancel at enqueue time
  local late = tasks.enqueue({ task = { type = "walk_to" }, background = true, chain = "f1" })
  check(late.cancelled == true and status_of(late.task_id) == "cancelled",
    "fail-fast race: late enqueue of a failed chain cancels instantly")
end

do -- unrelated chains are untouched
  local c = tasks.enqueue({ task = { type = "walk_to" }, background = true, chain = "other" })
  tasks.on_tick()
  check(status_of(c.task_id) == "done", "independent chain unaffected")
end

print(failures == 0 and "\nALL TESTS PASSED" or ("\n" .. failures .. " FAILURES"))
os.exit(failures == 0 and 0 or 1)
