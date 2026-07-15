-- Task queue + per-tick dispatcher. RCON calls enqueue; execution happens in
-- on_tick (always registered, early-exit when idle); the companion app polls
-- get_task for completion.
local companion = require("scripts.companion")
local walk = require("scripts.actions.walk")
local follow = require("scripts.actions.follow")
local mine = require("scripts.actions.mine")
local build = require("scripts.actions.build")
local craft = require("scripts.actions.craft")
local transfer = require("scripts.actions.transfer")
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
  build_plan = build_plan,
  deconstruct = deconstruct,
  fight = fight,
}

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

local function finish(task, status, detail)
  storage.tasks.records[task.id] = {
    status = status,
    detail = detail or "",
    finished_tick = game.tick,
  }
  if storage.tasks.active and storage.tasks.active.id == task.id then
    storage.tasks.active = nil
  end
  stop_body()
end

function M.enqueue(params)
  local task = params.task
  if type(task) ~= "table" or not runners[task.type] then
    error("unknown task type: " .. tostring(type(task) == "table" and task.type or task))
  end
  if params.replace then
    M.cancel({ all = true })
  end
  local t = storage.tasks
  task.id = t.next_id
  t.next_id = t.next_id + 1
  task.status = "queued"
  t.queue[#t.queue + 1] = task
  return { task_id = task.id }
end

function M.get(params)
  local id = tonumber(params.task_id)
  if not id then error("get_task requires task_id") end
  local t = storage.tasks
  if t.active and t.active.id == id then
    return { status = "running", detail = "" }
  end
  for _, q in ipairs(t.queue) do
    if q.id == id then return { status = "queued", detail = "" } end
  end
  local rec = t.records[id]
  if rec then return { status = rec.status, detail = rec.detail } end
  error("unknown task_id: " .. id)
end

function M.cancel(params)
  local t = storage.tasks
  local n = 0
  if params.all then
    for _, q in ipairs(t.queue) do
      t.records[q.id] = { status = "cancelled", detail = "", finished_tick = game.tick }
      n = n + 1
    end
    t.queue = {}
    if t.active then
      finish(t.active, "cancelled", "")
      n = n + 1
    end
  else
    local id = tonumber(params.task_id)
    if not id then error("cancel requires task_id or all=true") end
    if t.active and t.active.id == id then
      finish(t.active, "cancelled", "")
      n = 1
    else
      for i, q in ipairs(t.queue) do
        if q.id == id then
          table.remove(t.queue, i)
          t.records[id] = { status = "cancelled", detail = "", finished_tick = game.tick }
          n = 1
          break
        end
      end
    end
  end
  return { cancelled = n }
end

-- Serializable summary of the active task for get_state.
function M.active_summary()
  local a = storage.tasks.active
  if not a then return nil end
  return { id = a.id, type = a.type, status = "running" }
end

local function prune_records()
  local t = storage.tasks
  for id, rec in pairs(t.records) do
    if game.tick - rec.finished_tick > RECORD_TTL_TICKS then
      t.records[id] = nil
    end
  end
end

function M.on_tick()
  if game.tick % PRUNE_INTERVAL_TICKS == 0 then
    prune_records()
  end

  local t = storage.tasks
  local task = t.active
  if not task then
    if #t.queue == 0 then return end
    task = table.remove(t.queue, 1)
    task.status = "running"
    t.active = task
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

return M
