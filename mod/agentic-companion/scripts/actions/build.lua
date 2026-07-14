-- Building actions: place, rotate, set_recipe. Each approaches its target
-- first (build_distance for place, reach_distance otherwise).
local companion = require("scripts.companion")
local approach = require("scripts.actions.approach")

local M = {}

local direction_names = {}
for name, value in pairs(defines.direction) do
  direction_names[value] = name
end

local function dir_name(d)
  return direction_names[d] or tostring(d)
end

local function validate_position(pos, action)
  if type(pos) ~= "table" or type(pos.x) ~= "number" or type(pos.y) ~= "number" then
    error(action .. " requires target = {x, y}")
  end
end

local function gone()
  return { status = "failed", detail = "the companion character is gone" }
end

-- ------------------------------------------------------------------ place

-- Why can_place_entity said no: name the blocker if we can find one.
local function blocked_reason(c, pos)
  for _, e in ipairs(c.surface.find_entities_filtered({ position = pos, radius = 1.0 })) do
    if e.valid and e ~= c and e.type ~= "resource" then
      return string.format("%s is in the way — pick a clear spot or remove it first", e.name)
    end
  end
  local water = false
  pcall(function()
    water = c.surface.get_tile(math.floor(pos.x), math.floor(pos.y)).collides_with("player")
  end)
  if water then
    return "the ground there is water or otherwise unbuildable"
  end
  local dx, dy = c.position.x - pos.x, c.position.y - pos.y
  if dx * dx + dy * dy < 9 then
    return "I might be standing in the way — walk a couple of tiles away and try again"
  end
  return "the spot is blocked — try a nearby position"
end

M.place = {}

function M.place.start(task)
  local c = companion.require_companion()
  if type(task.item) ~= "string" then
    error("place requires item = <item name>")
  end
  if type(task.position) ~= "table" or type(task.position.x) ~= "number" or type(task.position.y) ~= "number" then
    error("place requires position = {x, y}")
  end
  local proto = prototypes.item[task.item]
  if not proto then
    error("no item called '" .. task.item .. "'")
  end
  local result = proto.place_result
  if not result then
    error(task.item .. " is not a placeable item")
  end
  if c.get_item_count(task.item) == 0 then
    error("I don't have any " .. task.item .. " in my inventory — craft or collect one first")
  end
  task.direction = math.floor(tonumber(task.direction) or 0) % 16
  task._entity_name = result.name
end

function M.place.tick(task)
  local c = companion.get()
  if not c then return gone() end

  local reached = approach.ensure(task, c, task.position, c.build_distance)
  if type(reached) == "table" then return reached end
  if reached ~= "ok" then return nil end

  if c.get_item_count(task.item) == 0 then
    return { status = "failed", detail = "I no longer have any " .. task.item .. " in my inventory" }
  end

  local can_place = c.surface.can_place_entity({
    name = task._entity_name,
    position = task.position,
    direction = task.direction,
    force = c.force,
    build_check_type = defines.build_check_type.manual,
  })
  if not can_place then
    return {
      status = "failed",
      detail = string.format("can't place %s at (%.1f, %.1f) — %s",
        task.item, task.position.x, task.position.y, blocked_reason(c, task.position)),
    }
  end

  local built = c.surface.create_entity({
    name = task._entity_name,
    position = task.position,
    direction = task.direction,
    force = c.force,
    raise_built = true,
  })
  if not built then
    return {
      status = "failed",
      detail = string.format("placing %s at (%.1f, %.1f) failed unexpectedly — try a slightly different spot",
        task.item, task.position.x, task.position.y),
    }
  end
  c.remove_item({ name = task.item, count = 1 })
  return {
    status = "done",
    detail = string.format("placed %s at (%.1f, %.1f)%s",
      task.item, built.position.x, built.position.y,
      task.direction ~= 0 and (" facing " .. dir_name(task.direction)) or ""),
  }
end

-- ----------------------------------------------------------------- rotate

M.rotate = {}

function M.rotate.start(task)
  companion.require_companion()
  validate_position(task.target, "rotate")
  if task.direction ~= nil then
    task.direction = math.floor(tonumber(task.direction) or 0) % 16
  end
end

function M.rotate.tick(task)
  local c = companion.get()
  if not c then return gone() end

  local reached = approach.ensure(task, c, task.target, c.reach_distance)
  if type(reached) == "table" then return reached end
  if reached ~= "ok" then return nil end

  local e = approach.find_entity_near(c, task.target)
  if not e then
    return {
      status = "failed",
      detail = string.format("nothing to rotate at (%.1f, %.1f)", task.target.x, task.target.y),
    }
  end

  if task.direction then
    local ok = pcall(function() e.direction = task.direction end)
    if not ok or e.direction ~= task.direction then
      return { status = "failed", detail = "the " .. e.name .. " can't face that way" }
    end
    return { status = "done", detail = string.format("turned %s to face %s", e.name, dir_name(task.direction)) }
  end

  if not e.rotate() then
    return { status = "failed", detail = "the " .. e.name .. " can't be rotated" }
  end
  return { status = "done", detail = string.format("rotated %s — it now faces %s", e.name, dir_name(e.direction)) }
end

-- ------------------------------------------------------------- set_recipe

M.set_recipe = {}

function M.set_recipe.start(task)
  local c = companion.require_companion()
  validate_position(task.target, "set_recipe")
  if type(task.recipe) ~= "string" then
    error("set_recipe requires recipe = <recipe name>")
  end
  local r = c.force.recipes[task.recipe]
  if not r then
    error("unknown recipe: '" .. task.recipe .. "'")
  end
  if not r.enabled then
    error("recipe " .. task.recipe .. " isn't unlocked yet — research it first")
  end
end

function M.set_recipe.tick(task)
  local c = companion.get()
  if not c then return gone() end

  local reached = approach.ensure(task, c, task.target, c.reach_distance)
  if type(reached) == "table" then return reached end
  if reached ~= "ok" then return nil end

  local e = approach.find_entity_near(c, task.target)
  if not e then
    return {
      status = "failed",
      detail = string.format("nothing at (%.1f, %.1f) to set a recipe on", task.target.x, task.target.y),
    }
  end
  if e.type ~= "assembling-machine" then
    if e.type == "furnace" then
      return {
        status = "failed",
        detail = "the " .. e.name .. " is a furnace — it picks its recipe automatically from what you insert",
      }
    end
    return { status = "failed", detail = "the " .. e.name .. " can't have a recipe set — only crafting machines can" }
  end

  local ok, removed = pcall(e.set_recipe, task.recipe)
  if not ok then
    return {
      status = "failed",
      detail = string.format("couldn't set %s on the %s — that machine probably can't craft it",
        task.recipe, e.name),
    }
  end

  -- Ingredients of the previous recipe come back to us; overflow spills.
  local taken = 0
  if type(removed) == "table" then
    for _, stack in ipairs(removed) do
      if stack.name and (stack.count or 0) > 0 then
        local inserted = c.insert({ name = stack.name, count = stack.count })
        taken = taken + inserted
        if inserted < stack.count then
          pcall(c.surface.spill_item_stack, {
            position = c.position,
            stack = { name = stack.name, count = stack.count - inserted },
            force = c.force,
          })
        end
      end
    end
  end
  return {
    status = "done",
    detail = string.format("set %s's recipe to %s%s", e.name, task.recipe,
      taken > 0 and string.format(" (took %d leftover items into my inventory)", taken) or ""),
  }
end

return M
