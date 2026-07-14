-- mine: two forms (see docs/PROTOCOL.md).
--   {target={x,y}}            one mining op on the nearest minable within 2 tiles
--   {resource=name, count=n}  composite: auto-find within 80 tiles, walk, mine,
--                             hop to the next entity when one is exhausted
-- Real mining is a timer + LuaEntity.mine() so it takes human-comparable time;
-- mining_state is only set for the animation. mine() on a resource extracts one
-- unit per call and returns true only on exhaustion — success is measured by
-- inventory delta, not the return value.
local companion = require("scripts.companion")
local approach = require("scripts.actions.approach")

local M = {}

local TARGET_SEARCH_RADIUS = 2.0
local COMPOSITE_SEARCH_RADIUS = 80
local MAX_OPS = 200
local MINABLE_TYPES = { "resource", "tree", "simple-entity" }

local function dist_sq(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return dx * dx + dy * dy
end

local function op_ticks(c, e)
  local mining_time = e.prototype.mineable_properties.mining_time or 1
  local speed = 1 + c.force.manual_mining_speed_modifier
  return math.max(10, math.ceil(mining_time * 60 / speed))
end

local function product_names(e)
  local names = {}
  for _, p in ipairs(e.prototype.mineable_properties.products or {}) do
    if p.type == "item" then names[#names + 1] = p.name end
  end
  return names
end

-- One timed mining op on task._entity. Returns nil while the timer runs, or
-- {gained_total=, exhausted=} once mine() was executed. Sets result.full=true
-- when nothing fit in the inventory.
local function run_mining_op(task, c, m)
  local e = task._entity
  if not m.remaining then
    m.remaining = op_ticks(c, e)
    m.op_products = product_names(e)
  end

  c.mining_state = { mining = true, position = e.position }
  m.remaining = m.remaining - 1
  if m.remaining > 0 then return nil end
  m.remaining = nil
  c.mining_state = { mining = false }

  local inv = c.get_main_inventory()
  local before_total = inv.get_item_count()
  local before = {}
  for _, name in ipairs(m.op_products) do
    before[name] = inv.get_item_count(name)
  end
  local exhausted = e.mine({ inventory = inv, raise_destroyed = true })
  local gained_total = inv.get_item_count() - before_total
  for _, name in ipairs(m.op_products) do
    local g = inv.get_item_count(name) - before[name]
    if g > 0 then
      m.gained[name] = (m.gained[name] or 0) + g
    end
  end
  return {
    gained_total = gained_total,
    exhausted = exhausted or not e.valid,
    full = gained_total <= 0,
  }
end

local function gained_list(m)
  local parts = {}
  for name, n in pairs(m.gained) do
    parts[#parts + 1] = string.format("+%d %s", n, name)
  end
  table.sort(parts)
  return table.concat(parts, ", ")
end

-- ---------------------------------------------------------------- single

local function start_single(task, c)
  local target = task.target
  if type(target.x) ~= "number" or type(target.y) ~= "number" then
    error("mine requires target = {x, y}")
  end

  local candidates = c.surface.find_entities_filtered({
    position = target,
    radius = TARGET_SEARCH_RADIUS,
    type = MINABLE_TYPES,
  })
  local best, best_d
  for _, e in ipairs(candidates) do
    if e.valid and e.prototype.mineable_properties.minable then
      local d = dist_sq(e.position, target)
      if not best or d < best_d then
        best, best_d = e, d
      end
    end
  end
  if not best then
    error(string.format(
      "nothing minable within %.0f tiles of (%.1f, %.1f) — I can only mine ore, trees and rocks",
      TARGET_SEARCH_RADIUS, target.x, target.y))
  end

  task._entity = best
  task._entity_name = best.name
  task._mine = { gained = {} }
end

local function tick_single(task, c)
  local e = task._entity
  if not (e and e.valid) then
    return { status = "failed", detail = "the target was mined or destroyed by someone else" }
  end

  local reached = approach.ensure(task, c, e.position, c.resource_reach_distance)
  if type(reached) == "table" then return reached end
  if reached ~= "ok" then return nil end

  local result = run_mining_op(task, c, task._mine)
  if not result then return nil end
  if result.full then
    return {
      status = "failed",
      detail = string.format("could not mine %s — inventory full?", task._entity_name),
    }
  end
  return {
    status = "done",
    detail = string.format("mined %s (+%d items, carrying %d total)%s",
      task._entity_name, result.gained_total, c.get_main_inventory().get_item_count(),
      result.exhausted and " — that spot is used up now" or ""),
  }
end

-- ------------------------------------------------------------- composite

local function find_nearest_match(c, matcher)
  local filter = { position = c.position, radius = COMPOSITE_SEARCH_RADIUS }
  if matcher.name then
    filter.name = matcher.name
  else
    filter.type = matcher.type
  end
  local candidates = c.surface.find_entities_filtered(filter)
  local best, best_d
  for _, e in ipairs(candidates) do
    if e.valid and e.prototype.mineable_properties.minable then
      local d = dist_sq(e.position, c.position)
      if not best or d < best_d then
        best, best_d = e, d
      end
    end
  end
  return best
end

local function start_composite(task, c)
  local resource = task.resource
  local matcher
  if resource == "tree" then
    matcher = { type = "tree" }
  elseif resource == "rock" then
    matcher = { type = "simple-entity" }
  else
    local proto = prototypes.entity[resource]
    if not proto then
      error(string.format(
        "no entity called '%s' — use a resource name like iron-ore, or \"tree\"/\"rock\"", resource))
    end
    if not proto.mineable_properties.minable then
      error(resource .. " can't be mined by hand")
    end
    matcher = { name = resource }
  end

  local count = math.floor(tonumber(task.count) or 1)
  if count < 1 then count = 1 end
  if count > MAX_OPS then count = MAX_OPS end
  task.count = count
  task._mine = { matcher = matcher, ops = 0, gained = {} }
end

local function composite_summary(task, m)
  local items = gained_list(m)
  return string.format("mined %s %d time%s%s",
    task.resource, m.ops, m.ops == 1 and "" or "s",
    items ~= "" and (" (" .. items .. ")") or "")
end

local function tick_composite(task, c)
  local m = task._mine
  local e = task._entity
  if not (e and e.valid) then
    e = find_nearest_match(c, m.matcher)
    task._entity = e
    task._approach = nil
    m.remaining = nil
    if not e then
      if m.ops > 0 then
        return {
          status = "done",
          detail = composite_summary(task, m) .. string.format(
            " — no more %s within %d tiles", task.resource, COMPOSITE_SEARCH_RADIUS),
        }
      end
      return {
        status = "failed",
        detail = string.format(
          "no %s within %d tiles of me — explore further or pick another resource",
          task.resource, COMPOSITE_SEARCH_RADIUS),
      }
    end
  end

  local reached = approach.ensure(task, c, e.position, c.resource_reach_distance)
  if type(reached) == "table" then return reached end
  if reached ~= "ok" then return nil end

  local result = run_mining_op(task, c, m)
  if not result then return nil end
  if result.full then
    if m.ops > 0 then
      return { status = "done", detail = composite_summary(task, m) .. " — stopped early, my inventory is full" }
    end
    return { status = "failed", detail = "could not mine " .. task.resource .. " — my inventory is full" }
  end

  m.ops = m.ops + 1
  if result.exhausted then
    task._entity = nil -- find the next matching entity
  end
  if m.ops >= task.count then
    return { status = "done", detail = composite_summary(task, m) }
  end
  return nil
end

-- ------------------------------------------------------------------ api

function M.start(task)
  local c = companion.require_companion()
  if type(task.target) == "table" then
    task._mode = "single"
    start_single(task, c)
  elseif type(task.resource) == "string" then
    task._mode = "composite"
    start_composite(task, c)
  else
    error("mine requires target = {x, y} or resource = <name | \"tree\" | \"rock\">")
  end
end

function M.tick(task)
  local c = companion.get()
  if not c then
    return { status = "failed", detail = "the companion character is gone" }
  end
  if task._mode == "composite" then
    return tick_composite(task, c)
  end
  return tick_single(task, c)
end

return M
