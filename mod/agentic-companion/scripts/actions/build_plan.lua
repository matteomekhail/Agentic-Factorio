-- build_plan: place many entities in one task (docs/PROTOCOL.md "Building at
-- scale"). Walks within build reach of each step, places the item, then
-- optionally sets a recipe and inserts starter items — mirroring the exact
-- validation rules of the single-step place/set_recipe/insert actions
-- (scripts/actions/build.lua, scripts/actions/transfer.lua). A failed step is
-- recorded and skipped unless stop_on_error. Each step completes within a
-- single tick once in reach, so cancelling mid-plan never leaves a step
-- half-done.
local companion = require("scripts.companion")
local approach = require("scripts.actions.approach")

local M = {}

local MAX_STEPS = 100
local MAX_FAILURES_LISTED = 5

-- ------------------------------------------------------------- validation

-- Returns nil when the step is well-formed, else a human-readable reason.
local function malformed(step)
  if type(step) ~= "table" then
    return 'each step must be an object like {"item":"transport-belt","position":{"x":1,"y":2}}'
  end
  if type(step.item) ~= "string" then
    return "item must be an item name string"
  end
  local p = step.position
  if type(p) ~= "table" or type(p.x) ~= "number" or type(p.y) ~= "number" then
    return "position must be {x, y} with numeric coordinates"
  end
  if step.direction ~= nil and type(step.direction) ~= "number" then
    return "direction must be a number (16-way: 0=N, 4=E, 8=S, 12=W)"
  end
  if step.entity ~= nil and type(step.entity) ~= "string" then
    return "entity must be an entity name string"
  end
  if step.recipe ~= nil and type(step.recipe) ~= "string" then
    return "recipe must be a recipe name string"
  end
  if step.insert ~= nil then
    if type(step.insert) ~= "table" then
      return 'insert must map item names to counts, e.g. {"coal":5}'
    end
    for name, count in pairs(step.insert) do
      if type(name) ~= "string" or type(count) ~= "number" or count < 1 then
        return "insert must map item names to positive counts"
      end
    end
  end
  return nil
end

function M.start(task)
  companion.require_companion()
  if type(task.steps) ~= "table" or #task.steps == 0 then
    error('build_plan requires steps = a non-empty array like [{"item":"transport-belt","position":{"x":1,"y":2}}]')
  end
  if #task.steps > MAX_STEPS then
    error(string.format("build_plan takes at most %d steps (you sent %d) — split the plan into smaller batches",
      MAX_STEPS, #task.steps))
  end
  for i, step in ipairs(task.steps) do
    local why = malformed(step)
    if why then
      error(string.format("step %d is malformed: %s", i, why))
    end
  end

  for _, step in ipairs(task.steps) do
    step.direction = math.floor(tonumber(step.direction) or 0) % 16
    if step.insert ~= nil then
      -- {"coal":10} → sorted {name, count} list for deterministic messages.
      local list = {}
      for name, count in pairs(step.insert) do
        list[#list + 1] = { name = name, count = math.floor(count) }
      end
      table.sort(list, function(a, b) return a.name < b.name end)
      if #list > 0 then step._insert = list end
    end
  end

  task.stop_on_error = task.stop_on_error == true
  task._index = 1
  task._placed = 0
  task._results = {}
  task._failures = {}
end

-- ------------------------------------------------------------ step pieces

-- Why can_place_entity said no — mirrors build.lua's blocked_reason exactly.
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

-- Same rules as build.lua's set_recipe, applied to the freshly placed entity.
-- Returns nil on success, else a reason string.
local function apply_recipe(c, e, recipe_name)
  local r = c.force.recipes[recipe_name]
  if not r then
    return "unknown recipe: '" .. recipe_name .. "'"
  end
  if not r.enabled then
    return "recipe " .. recipe_name .. " isn't unlocked yet — research it first"
  end
  if e.type ~= "assembling-machine" then
    if e.type == "furnace" then
      return "the " .. e.name .. " is a furnace — it picks its recipe automatically from what you insert"
    end
    return "the " .. e.name .. " can't have a recipe set — only crafting machines can"
  end
  local ok, removed = pcall(e.set_recipe, recipe_name)
  if not ok then
    return string.format("couldn't set recipe %s on the %s — that machine probably can't craft it",
      recipe_name, e.name)
  end
  -- Anything the recipe change hands back goes to us; overflow spills.
  if type(removed) == "table" then
    for _, stack in ipairs(removed) do
      if stack.name and (stack.count or 0) > 0 then
        local kept = c.insert({ name = stack.name, count = stack.count })
        if kept < stack.count then
          pcall(c.surface.spill_item_stack, {
            position = c.position,
            stack = { name = stack.name, count = stack.count - kept },
            force = c.force,
          })
        end
      end
    end
  end
  return nil
end

-- Same rules as transfer.insert: move each requested item from the companion
-- into the placed entity, removing exactly what was accepted. Returns a list
-- of problem strings (empty = everything went in).
local function insert_items(c, e, list)
  local problems = {}
  for _, it in ipairs(list) do
    if not prototypes.item[it.name] then
      problems[#problems + 1] = "no item called '" .. it.name .. "'"
    else
      local have = c.get_item_count(it.name)
      local n = math.min(it.count, have)
      local inserted = 0
      if n > 0 then
        inserted = e.insert({ name = it.name, count = n })
        if inserted > 0 then
          c.remove_item({ name = it.name, count = inserted })
        end
      end
      if inserted < it.count then
        if have == 0 then
          problems[#problems + 1] = "I have no " .. it.name .. " to insert"
        elseif inserted == 0 then
          problems[#problems + 1] = "the " .. e.name .. " wouldn't accept " .. it.name
        elseif inserted < n then
          problems[#problems + 1] = string.format("the %s only took %d of %d %s",
            e.name, inserted, it.count, it.name)
        else
          problems[#problems + 1] = string.format("only inserted %d of %d %s (that's all I had)",
            inserted, it.count, it.name)
        end
      end
    end
  end
  return problems
end

-- --------------------------------------------------------------- progress

local function summary(task)
  local s = string.format("placed %d/%d", task._placed, #task.steps)
  local f = task._failures
  if #f > 0 then
    local parts = {}
    for i = 1, math.min(#f, MAX_FAILURES_LISTED) do
      parts[#parts + 1] = string.format("step %d failed: %s", f[i].index, f[i].why)
    end
    s = s .. " — " .. table.concat(parts, "; ")
    if #f > MAX_FAILURES_LISTED then
      s = s .. string.format("; … and %d more failures", #f - MAX_FAILURES_LISTED)
    end
  end
  return s
end

local function finished(task)
  if task._placed == 0 then
    return { status = "failed", detail = summary(task) }
  end
  return { status = "done", detail = summary(task) }
end

-- Record the current step's outcome and move to the next. Returns the task
-- result when the plan is over (or stop_on_error tripped), else nil.
local function advance(task, ok, why)
  local i = task._index
  task._results[i] = ok and { ok = true } or { ok = false, why = why }
  if not ok then
    task._failures[#task._failures + 1] = { index = i, why = why }
  end
  task._index = i + 1
  if not ok and task.stop_on_error then
    return { status = "failed", detail = summary(task) .. " — stopped at the first failure (stop_on_error)" }
  end
  if task._index > #task.steps then
    return finished(task)
  end
  return nil
end

-- ------------------------------------------------------------------- tick

function M.tick(task)
  local c = companion.get()
  if not c then
    return { status = "failed", detail = summary(task) .. " — the companion character is gone" }
  end

  local step = task.steps[task._index]
  if not step then return finished(task) end

  -- Checks that walking can never fix (mirrors place.start, which also runs
  -- before any walking): unknown item, unplaceable item, none in inventory.
  local proto = prototypes.item[step.item]
  if not proto then
    return advance(task, false, "no item called '" .. step.item .. "'")
  end
  local place_result = proto.place_result
  if not place_result then
    return advance(task, false, step.item .. " is not a placeable item")
  end
  if c.get_item_count(step.item) == 0 then
    return advance(task, false, "I don't have any " .. step.item .. " left in my inventory")
  end

  local reached = approach.ensure(task, c, step.position, c.build_distance)
  if type(reached) == "table" then
    return advance(task, false, reached.detail)
  end
  if reached ~= "ok" then return nil end

  -- step.entity overrides the item's place_result: one item can place several
  -- entities (the rail item also places curved segments — blueprint builds
  -- must create the exact entity the print recorded).
  local entity_name = step.entity or place_result.name
  if step.entity and not prototypes.entity[step.entity] then
    return advance(task, false, "no entity called '" .. step.entity .. "'")
  end

  local can_place = c.surface.can_place_entity({
    name = entity_name,
    position = step.position,
    direction = step.direction,
    force = c.force,
    build_check_type = defines.build_check_type.manual,
  })
  if not can_place then
    return advance(task, false, string.format("can't place %s at (%.1f, %.1f) — %s",
      step.item, step.position.x, step.position.y, blocked_reason(c, step.position)))
  end

  local built = c.surface.create_entity({
    name = entity_name,
    position = step.position,
    direction = step.direction,
    force = c.force,
    raise_built = true,
  })
  if not built then
    return advance(task, false, string.format(
      "placing %s at (%.1f, %.1f) failed unexpectedly — try a slightly different spot",
      step.item, step.position.x, step.position.y))
  end
  c.remove_item({ name = step.item, count = 1 })
  task._placed = task._placed + 1

  -- Optional follow-ups on the entity we just placed.
  local issues = {}
  if not built.valid then
    issues[#issues + 1] = "the placed entity vanished immediately (another mod removed it?)"
  else
    if step.recipe then
      local why = apply_recipe(c, built, step.recipe)
      if why then issues[#issues + 1] = why end
    end
    if step._insert then
      local problems = insert_items(c, built, step._insert)
      for _, p in ipairs(problems) do issues[#issues + 1] = p end
    end
  end
  if #issues > 0 then
    return advance(task, false, string.format("placed the %s, but %s",
      step.item, table.concat(issues, "; ")))
  end
  return advance(task, true)
end

return M
