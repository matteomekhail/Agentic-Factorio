-- keep_fueled: persistent area caretaker. Scans burner machines around an
-- anchor, walks to any running low and tops them up from the companion's own
-- inventory. Never finishes on its own — cancel/replace ends it.
local companion = require("scripts.companion")
local approach = require("scripts.actions.approach")
local chat = require("scripts.chat")
local events = require("scripts.events")

local M = {}

local DEFAULT_RADIUS = 24
local MAX_RADIUS = 40
local SCAN_INTERVAL_TICKS = 180
local LOW_FUEL_THRESHOLD = 3 -- items left in the fuel slot
local TOP_UP_COUNT = 10

local function dist_sq(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return dx * dx + dy * dy
end

-- Best fuel item the companion carries that this burner accepts.
local function pick_fuel(c, burner, preferred)
  local categories = {}
  pcall(function()
    for cat in pairs(burner.fuel_categories) do categories[cat] = true end
  end)
  local best, best_value = nil, 0
  for _, item in ipairs(c.get_main_inventory().get_contents()) do
    if not preferred or item.name == preferred then
      local ok = pcall(function()
        local proto = prototypes.item[item.name]
        local value = proto.fuel_value or 0
        local cat = proto.fuel_category
        if value > 0 and cat and categories[cat] and value > best_value then
          best, best_value = item.name, value
        end
      end)
      if not ok then end
    end
  end
  return best
end

local function burner_fuel_count(e)
  local n = nil
  pcall(function()
    local burner = e.burner
    if not burner then return end
    local inv = burner.inventory
    if not inv then return end
    n = inv.get_item_count()
  end)
  return n -- nil = not a (fueled) burner
end

function M.start(task)
  local c = companion.require_companion()
  local anchor = (task.center and type(task.center.x) == "number") and task.center or c.position
  task.radius = math.max(5, math.min(tonumber(task.radius) or DEFAULT_RADIUS, MAX_RADIUS))
  if task.fuel and not prototypes.item[task.fuel] then
    error("no item called '" .. task.fuel .. "'")
  end
  task._rf = {
    anchor = { x = anchor.x, y = anchor.y },
    next_scan = 0,
    warned_empty = false,
    topped_up = 0,
  }
end

function M.tick(task)
  local c = companion.get()
  if not c then
    return { status = "failed", detail = "the companion character is gone" }
  end
  local rf = task._rf

  -- Serve the current customer.
  local target = rf.target
  if target and target.valid then
    local fuel_left = burner_fuel_count(target)
    if fuel_left == nil or fuel_left >= LOW_FUEL_THRESHOLD then
      rf.target = nil
      task._approach = nil
      return nil
    end
    local reached = approach.ensure(task, c, target.position, c.reach_distance)
    if type(reached) == "table" then
      -- Can't get there; skip it this round rather than killing the caretaker.
      rf.target = nil
      task._approach = nil
      return nil
    end
    if reached ~= "ok" then return nil end

    local fuel = pick_fuel(c, target.burner, task.fuel)
    if not fuel then
      if not rf.warned_empty then
        rf.warned_empty = true
        local text = "I'm out of fuel to hand out — bring me coal (or tell me to mine some) and I'll keep going."
        pcall(chat.say, { text = text })
        pcall(events.push, "supply_warning", text)
      end
      rf.target = nil
      return nil
    end
    rf.warned_empty = false
    local n = math.min(c.get_item_count(fuel), TOP_UP_COUNT)
    local inserted = 0
    pcall(function() inserted = target.burner.inventory.insert({ name = fuel, count = n }) end)
    if inserted > 0 then
      c.remove_item({ name = fuel, count = inserted })
      rf.topped_up = rf.topped_up + 1
    end
    rf.target = nil
    task._approach = nil
    return nil
  end
  rf.target = nil

  -- Look for the next machine running low.
  if game.tick < rf.next_scan then
    c.walking_state = { walking = false }
    return nil
  end
  rf.next_scan = game.tick + SCAN_INTERVAL_TICKS

  local best, best_d
  for _, e in ipairs(c.surface.find_entities_filtered({
    position = rf.anchor,
    radius = task.radius,
    force = c.force,
  })) do
    if e.valid and e.type ~= "character" then
      local fuel_left = burner_fuel_count(e)
      if fuel_left ~= nil and fuel_left < LOW_FUEL_THRESHOLD then
        local d = dist_sq(e.position, c.position)
        if not best or d < best_d then
          best, best_d = e, d
        end
      end
    end
  end
  rf.target = best
  return nil -- persistent: only cancel/replace ends this task
end

return M
