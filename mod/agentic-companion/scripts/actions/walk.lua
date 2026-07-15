-- walk_to + reusable pathfinder walker. Other actions embed the walker via
-- M.begin/M.step (plain-data state, storage-safe). Pathfinder results arrive
-- through on_script_path_request_finished → M.on_path_finished (wired in
-- control.lua); storage.path_requests maps request id → task id.
local companion = require("scripts.companion")

local M = {}

local WAYPOINT_RADIUS_SQ = 0.25 -- advance to the next waypoint within 0.5 tiles
local STUCK_CHECK_TICKS = 60
local STUCK_EPSILON_SQ = 0.01 -- moved less than 0.1 tiles in a check window = stuck
local PATH_WAIT_TICKS = 300 -- ~5s without a pathfinder answer → straight-line fallback
local RETRY_DELAY_TICKS = 30
local MAX_RETRIES = 3

-- tan(22.5 deg): boundary between cardinal and diagonal octants
local OCTANT_RATIO = 0.41421356

-- Map coordinates: +x east, +y south.
local function direction_toward(from, to)
  local dx, dy = to.x - from.x, to.y - from.y
  local adx, ady = math.abs(dx), math.abs(dy)
  if adx < OCTANT_RATIO * ady then
    return dy >= 0 and defines.direction.south or defines.direction.north
  end
  if ady < OCTANT_RATIO * adx then
    return dx >= 0 and defines.direction.east or defines.direction.west
  end
  if dx >= 0 then
    return dy >= 0 and defines.direction.southeast or defines.direction.northeast
  end
  return dy >= 0 and defines.direction.southwest or defines.direction.northwest
end
M.direction_toward = direction_toward

local function dist_sq(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return dx * dx + dy * dy
end

local function request_path(state, c, task_id)
  local id = c.surface.request_path({
    bounding_box = { { -0.2, -0.2 }, { 0.2, 0.2 } },
    collision_mask = prototypes.entity["character"].collision_mask,
    start = c.position,
    goal = state.target,
    force = c.force,
    radius = math.max(state.arrive_within, 0.5),
    can_open_gates = true,
    entity_to_ignore = c,
    path_resolution_modifier = 0,
    pathfind_flags = { cache = false, prefer_straight_paths = true },
  })
  storage.path_requests[id] = { name = companion.context(), task_id = task_id }
  state.request_id = id
  state.request_tick = game.tick
  state.phase = "waiting"
  state.last_check_tick = nil
  state.last_pos = nil
end

-- Pop the pathfinder result on_path_finished stashed on the active task of
-- the current companion, but only if it answers THIS walker's request.
local function take_path_result(state, task_id)
  local l = storage.tasks.by_companion[companion.context()]
  local task = l and l.active
  if not task or task.id ~= task_id then return nil end
  local result = task._path_result
  if not result or result.id ~= state.request_id then return nil end
  task._path_result = nil
  return result
end

-- (Re)initialize a walker. `state` must be a plain table stored on the task;
-- all fields are plain data. The first step() issues the pathfinder request.
function M.begin(state, c, target, arrive_within)
  -- Walking tasks take over from driving: hop out first.
  pcall(function()
    if c.driving then c.driving = false end
  end)
  for k in pairs(state) do
    state[k] = nil
  end
  state.target = { x = target.x, y = target.y }
  state.arrive_within = math.max(tonumber(arrive_within) or 1.0, 0.1)
  state.phase = "request"
  state.retries = 0
  state.repathed = false
end

-- Advance the walker one tick. Returns nil while moving, "arrived" once within
-- arrive_within of the target, or {failed = "reason"} when it gives up.
function M.step(state, c, task_id)
  local pos = c.position

  if dist_sq(pos, state.target) <= state.arrive_within * state.arrive_within then
    c.walking_state = { walking = false }
    return "arrived"
  end

  if state.phase == "request" then
    request_path(state, c, task_id)
  end

  if state.phase == "waiting" then
    local result = take_path_result(state, task_id)
    if result then
      if result.try_again_later then
        state.retries = state.retries + 1
        if state.retries > MAX_RETRIES then
          state.phase = "straight" -- pathfinder too busy; just head there
        else
          state.phase = "retry_wait"
          state.retry_at = game.tick + RETRY_DELAY_TICKS
        end
      elseif not result.path or #result.path == 0 then
        state.phase = "straight" -- no path found: straight-line fallback
      else
        state.path = result.path
        state.waypoint = 1
        state.phase = "following"
      end
    elseif game.tick - state.request_tick > PATH_WAIT_TICKS then
      storage.path_requests[state.request_id] = nil
      state.phase = "straight"
    else
      c.walking_state = { walking = false }
      return nil
    end
  end

  if state.phase == "retry_wait" then
    if game.tick >= state.retry_at then
      request_path(state, c, task_id)
    end
    c.walking_state = { walking = false }
    return nil
  end

  -- following/straight: pick this tick's goal
  local goal
  if state.phase == "following" then
    local path = state.path
    while state.waypoint <= #path and dist_sq(pos, path[state.waypoint]) <= WAYPOINT_RADIUS_SQ do
      state.waypoint = state.waypoint + 1
    end
    if state.waypoint > #path then
      state.phase = "straight" -- path spent; close the last stretch directly
      goal = state.target
    else
      goal = path[state.waypoint]
    end
  else
    goal = state.target
  end

  if not state.last_check_tick then
    state.last_check_tick = game.tick
    state.last_pos = { x = pos.x, y = pos.y }
  elseif game.tick - state.last_check_tick >= STUCK_CHECK_TICKS then
    if dist_sq(pos, state.last_pos) < STUCK_EPSILON_SQ then
      if not state.repathed then
        state.repathed = true
        state.path = nil
        request_path(state, c, task_id)
        c.walking_state = { walking = false }
        return nil
      end
      c.walking_state = { walking = false }
      return {
        failed = string.format(
          "got stuck at (%.1f, %.1f), still %.1f tiles from the target — water, cliffs or buildings may be in the way",
          pos.x, pos.y, math.sqrt(dist_sq(pos, state.target))),
      }
    end
    state.last_check_tick = game.tick
    state.last_pos = { x = pos.x, y = pos.y }
  end

  -- walking_state only lasts one tick, so it must be re-set every tick
  c.walking_state = { walking = true, direction = direction_toward(pos, goal) }
  return nil
end

-- Wired in control.lua to defines.events.on_script_path_request_finished.
function M.on_path_finished(event)
  local entry = storage.path_requests[event.id]
  if not entry then return end
  storage.path_requests[event.id] = nil
  local l = storage.tasks.by_companion[entry.name]
  local task = l and l.active
  if not task or task.id ~= entry.task_id then return end
  local waypoints
  if event.path then
    waypoints = {}
    for i, wp in ipairs(event.path) do
      waypoints[i] = { x = wp.position.x, y = wp.position.y }
    end
  end
  task._path_result = {
    id = event.id,
    path = waypoints,
    try_again_later = event.try_again_later or false,
  }
end

-- walk_to task runner
function M.start(task)
  local c = companion.require_companion()
  local t = task.target
  if type(t) ~= "table" or type(t.x) ~= "number" or type(t.y) ~= "number" then
    error("walk_to requires target = {x, y}")
  end
  task.arrive_within = tonumber(task.arrive_within) or 1.0
  task._walk = {}
  M.begin(task._walk, c, t, task.arrive_within)
end

function M.tick(task)
  local c = companion.get()
  if not c then
    return { status = "failed", detail = "the companion character is gone" }
  end
  local r = M.step(task._walk, c, task.id)
  if r == "arrived" then
    return { status = "done", detail = string.format("arrived at (%.1f, %.1f)", c.position.x, c.position.y) }
  elseif type(r) == "table" then
    return { status = "failed", detail = r.failed }
  end
  return nil
end

return M
