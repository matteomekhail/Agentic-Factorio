-- drive_to: drive a car to a map position. Boards the nearest free car first
-- (fueling it from the companion's inventory if needed), then steers tick by
-- tick: continuous orientation control, braking near the goal, one reverse
-- attempt when stuck. Cars can't path around lakes — honest failure instead.
local companion = require("scripts.companion")
local approach = require("scripts.actions.approach")

local M = {}

local BOARD_SEARCH_RADIUS = 30
local ARRIVE_DEFAULT = 3
local STUCK_CHECK_TICKS = 90
local STUCK_EPSILON_SQ = 0.25
local REVERSE_TICKS = 45

local function dist_sq(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return dx * dx + dy * dy
end

-- Map orientation: 0 = north, clockwise, 0..1.
local function desired_orientation(from, to)
  local o = math.atan2(to.x - from.x, -(to.y - from.y)) / (2 * math.pi)
  return o % 1
end

local function fuel_car(c, car)
  local has = false
  pcall(function()
    has = car.burner.currently_burning ~= nil or car.burner.inventory.get_item_count() > 0
  end)
  if has then return true end
  for _, item in ipairs(c.get_main_inventory().get_contents()) do
    local inserted = 0
    pcall(function()
      local proto = prototypes.item[item.name]
      if proto.fuel_value and proto.fuel_value > 0
        and proto.fuel_category and car.burner.fuel_categories[proto.fuel_category] then
        inserted = car.burner.inventory.insert({ name = item.name, count = math.min(item.count, 10) })
      end
    end)
    if inserted > 0 then
      c.remove_item({ name = item.name, count = inserted })
      return true
    end
  end
  return false
end

function M.start(task)
  local c = companion.require_companion()
  local t = task.target
  if type(t) ~= "table" or type(t.x) ~= "number" or type(t.y) ~= "number" then
    error("drive_to requires target = {x, y}")
  end
  task.arrive_within = math.max(tonumber(task.arrive_within) or ARRIVE_DEFAULT, 2)

  local d = { phase = "drive" }
  if not c.vehicle then
    local best, best_d
    for _, e in ipairs(c.surface.find_entities_filtered({
      type = "car",
      position = c.position,
      radius = BOARD_SEARCH_RADIUS,
    })) do
      if e.valid and not e.get_driver() then
        local dd = dist_sq(e.position, c.position)
        if not best or dd < best_d then best, best_d = e, dd end
      end
    end
    if not best then
      error(string.format(
        "no free car within %d tiles — craft/place one first, or just ask me to walk", BOARD_SEARCH_RADIUS))
    end
    d.phase = "board"
    d.car = best
  end
  task._drv = d
end

function M.tick(task)
  local c = companion.get()
  if not c then
    return { status = "failed", detail = "the companion character is gone" }
  end
  local d = task._drv
  local acc = defines.riding.acceleration
  local rdir = defines.riding.direction

  if d.phase == "board" then
    local car = d.car
    if not (car and car.valid) then
      return { status = "failed", detail = "the car disappeared before I could get in" }
    end
    local reached = approach.ensure(task, c, car.position, 3)
    if type(reached) == "table" then return reached end
    if reached ~= "ok" then return nil end
    if not fuel_car(c, car) then
      return {
        status = "failed",
        detail = "the car has no fuel and I carry none — hand me some coal (or wood) and ask again",
      }
    end
    car.set_driver(c)
    if c.vehicle ~= car then
      return { status = "failed", detail = "couldn't get into the car — is someone else driving it?" }
    end
    d.phase = "drive"
    return nil
  end

  local car = c.vehicle
  if not car then
    return { status = "failed", detail = "I'm not in a vehicle anymore" }
  end
  local pos = car.position
  local dist = math.sqrt(dist_sq(pos, task.target))
  local speed_tps = math.abs(car.speed) * 60 -- tiles per second

  if dist <= task.arrive_within then
    if math.abs(car.speed) < 0.01 then
      c.riding_state = { acceleration = acc.nothing, direction = rdir.straight }
      return {
        status = "done",
        detail = string.format(
          "parked at (%.1f, %.1f) — still at the wheel; exit_vehicle when you want me out",
          pos.x, pos.y),
      }
    end
    c.riding_state = { acceleration = acc.braking, direction = rdir.straight }
    return nil
  end

  -- Steering: shortest signed turn toward the goal.
  local diff = (desired_orientation(pos, task.target) - car.orientation + 0.5) % 1 - 0.5
  local steer = rdir.straight
  if diff > 0.01 then
    steer = rdir.right
  elseif diff < -0.01 then
    steer = rdir.left
  end

  -- Reverse maneuver in progress?
  if d.reverse_until then
    if game.tick < d.reverse_until then
      c.riding_state = { acceleration = acc.reversing, direction = steer }
      return nil
    end
    d.reverse_until = nil
  end

  -- Stuck detection (accelerating but not moving = wall, water edge, or no fuel).
  if not d.last_tick then
    d.last_tick = game.tick
    d.last_pos = { x = pos.x, y = pos.y }
  elseif game.tick - d.last_tick >= STUCK_CHECK_TICKS then
    if dist_sq(pos, d.last_pos) < STUCK_EPSILON_SQ then
      local fuel_left = 1
      pcall(function()
        fuel_left = car.burner.inventory.get_item_count()
          + (car.burner.currently_burning and 1 or 0)
      end)
      if fuel_left == 0 then
        c.riding_state = { acceleration = acc.nothing, direction = rdir.straight }
        return { status = "failed", detail = "the car ran out of fuel on the way — bring fuel and ask again" }
      end
      d.reversals = (d.reversals or 0) + 1
      if d.reversals <= 2 then
        d.reverse_until = game.tick + REVERSE_TICKS
      else
        c.riding_state = { acceleration = acc.nothing, direction = rdir.straight }
        return {
          status = "failed",
          detail = string.format(
            "the car is stuck at (%.1f, %.1f), %.0f tiles from the goal — something big is in the way; I can walk instead",
            pos.x, pos.y, dist),
        }
      end
    elseif dist_sq(pos, d.last_pos) > 25 then
      d.reversals = 0 -- real progress: forgive earlier bumps
    end
    d.last_tick = game.tick
    d.last_pos = { x = pos.x, y = pos.y }
  end

  -- Throttle: brake for sharp turns at speed and when ~1s from the goal.
  local a = acc.accelerating
  if dist < math.max(task.arrive_within + 1, speed_tps) then
    a = acc.braking
  elseif math.abs(diff) > 0.15 and speed_tps > 8 then
    a = acc.braking
  end
  c.riding_state = { acceleration = a, direction = steer }
  return nil
end

-- rpc: exit_vehicle (instant)
function M.exit(_)
  local c = companion.require_companion()
  if not c.vehicle then
    error("I'm not in a vehicle")
  end
  local name = c.vehicle.name
  c.driving = false
  return { exited = name, position = { x = c.position.x, y = c.position.y } }
end

return M
