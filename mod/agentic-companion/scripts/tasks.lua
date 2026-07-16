-- Task queue + per-tick dispatcher. RCON calls enqueue; execution happens in
-- on_tick (always registered, early-exit when idle); the companion app polls
-- get_task for completion.
local companion = require("scripts.companion")
local events = require("scripts.events")
local walk = require("scripts.actions.walk")
local follow = require("scripts.actions.follow")
local mine = require("scripts.actions.mine")
local build = require("scripts.actions.build")
local craft = require("scripts.actions.craft")
local transfer = require("scripts.actions.transfer")
local refuel = require("scripts.actions.refuel")
local drive = require("scripts.actions.drive")
local build_plan = require("scripts.actions.build_plan")
local deconstruct = require("scripts.actions.deconstruct")
local fight = require("scripts.actions.fight")

local M = {}

local RECORD_TTL_TICKS = 5 * 60 * 60 -- keep finished-task records for 5 minutes
local PRUNE_INTERVAL_TICKS = 3600

local runners = {
  walk_to = walk,
  follow_player = follow,
  mine = mine,
  place = build.place,
  rotate = build.rotate,
  set_recipe = build.set_recipe,
  craft = craft,
  insert = transfer.insert,
  extract = transfer.extract,
  deliver = transfer.deliver,
  keep_fueled = refuel,
  drive_to = drive,
  defend_area = require("scripts.actions.defend"),
  build_plan = build_plan,
  deconstruct = deconstruct,
  fight = fight,
}

-- One lane (queue + active) per companion; tasks in different lanes run in
-- the same tick, so companions genuinely work in parallel.
local function lane(name)
  local lanes = storage.tasks.by_companion
  local l = lanes[name]
  if not l then
    l = { queue = {}, active = nil }
    lanes[name] = l
  end
  return l
end

local function stop_body()
  local c = companion.get()
  if c then
    c.walking_state = { walking = false }
    c.mining_state = { mining = false }
    pcall(function()
      c.shooting_state = { state = defines.shooting.not_shooting }
    end)
  end
end

-- finish() runs with the companion context already set to the task's owner.
local function finish(task, status, detail)
  storage.tasks.records[task.id] = {
    status = status,
    detail = detail or "",
    finished_tick = game.tick,
  }
  local l = lane(task.companion or companion.DEFAULT)
  if l.active and l.active.id == task.id then
    l.active = nil
  end
  stop_body()

  -- A failed step of a plan takes its dependent siblings down with it: later
  -- steps of the same chain are cancelled so the brain gets ONE failure event
  -- instead of a cascade ("insert the plates" can't work if the craft failed).
  if status == "failed" and task.chain then
    local l2 = lane(task.companion or companion.DEFAULT)
    local kept = {}
    for _, q in ipairs(l2.queue) do
      if q.chain == task.chain then
        storage.tasks.records[q.id] = {
          status = "cancelled",
          detail = "skipped: an earlier step of the same plan failed",
          finished_tick = game.tick,
        }
      else
        kept[#kept + 1] = q
      end
    end
    l2.queue = kept
  end

  -- Background tasks aren't awaited by anyone — report their outcome as a
  -- push event so the brain hears about it. (Awaited tasks already report
  -- through get_task polling; cancellations stay silent.) `quiet` suppresses
  -- the success event — run_plan marks every step but the last quiet, so a
  -- whole plan wakes the brain once. Failures always report.
  if task.background then
    pcall(function()
      local who = task.companion or companion.DEFAULT
      if status == "done" and not task.quiet then
        events.push("task_done", who .. " finished: " .. (detail or "done"),
          { companion = who, task_id = task.id })
      elseif status == "failed" then
        events.push("task_failed", who .. "'s task FAILED: " .. (detail or "no detail"),
          { companion = who, task_id = task.id })
      end
    end)
  end
end

local function cancel_lane(name)
  local l = lane(name)
  local n = 0
  for _, q in ipairs(l.queue) do
    storage.tasks.records[q.id] = { status = "cancelled", detail = "", finished_tick = game.tick }
    n = n + 1
  end
  l.queue = {}
  if l.active then
    companion.set_context(name)
    finish(l.active, "cancelled", "")
    n = n + 1
  end
  return n
end

function M.enqueue(params)
  local task = params.task
  if type(task) ~= "table" or not runners[task.type] then
    error("unknown task type: " .. tostring(type(task) == "table" and task.type or task))
  end
  local name = companion.context()
  companion.require_companion(name)
  if params.replace then
    cancel_lane(name)
    companion.set_context(name)
  end
  local t = storage.tasks
  task.id = t.next_id
  t.next_id = t.next_id + 1
  task.status = "queued"
  task.companion = name
  task.background = params.background == true
  task.quiet = params.quiet == true
  if params.chain ~= nil then task.chain = tostring(params.chain) end
  local l = lane(name)
  l.queue[#l.queue + 1] = task
  return { task_id = task.id, companion = name }
end

function M.get(params)
  local id = tonumber(params.task_id)
  if not id then error("get_task requires task_id") end
  for _, l in pairs(storage.tasks.by_companion) do
    if l.active and l.active.id == id then
      return { status = "running", detail = "" }
    end
    for _, q in ipairs(l.queue) do
      if q.id == id then return { status = "queued", detail = "" } end
    end
  end
  local rec = storage.tasks.records[id]
  if rec then return { status = rec.status, detail = rec.detail } end
  error("unknown task_id: " .. id)
end

function M.cancel(params)
  local n = 0
  if params.all then
    -- cancel {all=true, companion="X"} clears X's lane; without an explicit
    -- companion it clears EVERY lane (the !stop kill switch).
    if type(params.companion) == "string" and params.companion ~= "" then
      n = cancel_lane(params.companion)
    else
      for name in pairs(storage.tasks.by_companion) do
        n = n + cancel_lane(name)
      end
    end
  else
    local id = tonumber(params.task_id)
    if not id then error("cancel requires task_id or all=true") end
    for name, l in pairs(storage.tasks.by_companion) do
      if l.active and l.active.id == id then
        companion.set_context(name)
        finish(l.active, "cancelled", "")
        n = 1
        break
      end
      for i, q in ipairs(l.queue) do
        if q.id == id then
          table.remove(l.queue, i)
          storage.tasks.records[id] = { status = "cancelled", detail = "", finished_tick = game.tick }
          n = 1
          break
        end
      end
      if n > 0 then break end
    end
  end
  return { cancelled = n }
end

-- Serializable summary of a companion's active task for get_state.
function M.active_summary(name)
  local a = lane(name or companion.context()).active
  if not a then return nil end
  return { id = a.id, type = a.type, status = "running" }
end

function M.queue_length(name)
  return #lane(name or companion.context()).queue
end

local function prune_records()
  local t = storage.tasks
  for id, rec in pairs(t.records) do
    if game.tick - rec.finished_tick > RECORD_TTL_TICKS then
      t.records[id] = nil
    end
  end
end

local function step_lane(name, l)
  local task = l.active
  if not task then
    if #l.queue == 0 then return end
    task = table.remove(l.queue, 1)
    task.status = "running"
    l.active = task
    local ok, err = pcall(runners[task.type].start, task)
    if not ok then
      finish(task, "failed", tostring(err))
      return
    end
  end

  local ok, result = pcall(runners[task.type].tick, task)
  if not ok then
    finish(task, "failed", tostring(result))
  elseif result then
    finish(task, result.status, result.detail)
  end
end

function M.on_tick()
  if game.tick % PRUNE_INTERVAL_TICKS == 0 then
    prune_records()
  end
  for name, l in pairs(storage.tasks.by_companion) do
    if l.active or #l.queue > 0 then
      companion.set_context(name)
      step_lane(name, l)
    end
  end
  companion.set_context(nil)
end

return M
