-- Inventory transfer actions: insert (companion → entity) and extract
-- (entity → companion). Both approach within reach_distance first and report
-- per-item results including shortfalls.
local companion = require("scripts.companion")
local approach = require("scripts.actions.approach")

local M = {}

local function gone()
  return { status = "failed", detail = "the companion character is gone" }
end

local function validate_target(task, action)
  local t = task.target
  if type(t) ~= "table" or type(t.x) ~= "number" or type(t.y) ~= "number" then
    error(action .. " requires target = {x, y}")
  end
end

-- {"coal":10} → sorted list of {name, count} for deterministic messages.
local function validate_items(items, action)
  if type(items) ~= "table" then
    error(action .. " requires items = {\"item-name\": count}")
  end
  local list = {}
  for name, count in pairs(items) do
    if type(name) ~= "string" or type(count) ~= "number" or count < 1 then
      error(action .. " items must map item names to positive counts")
    end
    if not prototypes.item[name] then
      error("no item called '" .. name .. "'")
    end
    list[#list + 1] = { name = name, count = math.floor(count) }
  end
  if #list == 0 then
    error(action .. " needs at least one item")
  end
  table.sort(list, function(a, b) return a.name < b.name end)
  return list
end

local function no_entity(task, action)
  return {
    status = "failed",
    detail = string.format("nothing at (%.1f, %.1f) to %s — check the position with inspect",
      task.target.x, task.target.y, action),
  }
end

-- ----------------------------------------------------------------- insert

M.insert = {}

function M.insert.start(task)
  companion.require_companion()
  validate_target(task, "insert")
  task._items = validate_items(task.items, "insert")
end

function M.insert.tick(task)
  local c = companion.get()
  if not c then return gone() end

  local reached = approach.ensure(task, c, task.target, c.reach_distance)
  if type(reached) == "table" then return reached end
  if reached ~= "ok" then return nil end

  local e = approach.find_entity_near(c, task.target)
  if not e then return no_entity(task, "insert into") end

  local moved, problems, total = {}, {}, 0
  for _, it in ipairs(task._items) do
    local have = c.get_item_count(it.name)
    local n = math.min(it.count, have)
    local inserted = 0
    if n > 0 then
      inserted = e.insert({ name = it.name, count = n })
      if inserted > 0 then
        c.remove_item({ name = it.name, count = inserted })
      end
    end
    total = total + inserted
    if inserted >= it.count then
      moved[#moved + 1] = string.format("%d %s", inserted, it.name)
    elseif inserted > 0 then
      local why = inserted < n and ("the " .. e.name .. " wouldn't take more")
        or string.format("I only had %d", have)
      moved[#moved + 1] = string.format("%d of %d %s (%s)", inserted, it.count, it.name, why)
    elseif have == 0 then
      problems[#problems + 1] = "I have no " .. it.name
    else
      problems[#problems + 1] = "the " .. e.name .. " wouldn't accept " .. it.name
    end
  end

  if total == 0 then
    return {
      status = "failed",
      detail = string.format("couldn't insert anything into the %s — %s",
        e.name, table.concat(problems, "; ")),
    }
  end
  local extra = #problems > 0 and ("; " .. table.concat(problems, "; ")) or ""
  return {
    status = "done",
    detail = string.format("inserted %s into the %s%s", table.concat(moved, ", "), e.name, extra),
  }
end

-- ---------------------------------------------------------------- extract

M.extract = {}

function M.extract.start(task)
  companion.require_companion()
  validate_target(task, "extract")
  if task.all then
    task._all = true
  else
    task._items = validate_items(task.items, "extract")
  end
end

-- Move `count` of `name` from an entity/inventory into the companion;
-- overflow that doesn't fit goes straight back. Returns kept, removed.
-- (LuaObjects error on unknown members, so the source kind is explicit.)
local function pull(c, source, is_inventory, name, count)
  local removed
  if is_inventory then
    removed = source.remove({ name = name, count = count })
  else
    removed = source.remove_item({ name = name, count = count })
  end
  if removed == 0 then return 0, 0 end
  local kept = c.insert({ name = name, count = removed })
  if kept < removed then
    source.insert({ name = name, count = removed - kept })
  end
  return kept, removed
end

local function extract_all(task, c, e)
  local inv = e.get_output_inventory() or e.get_inventory(defines.inventory.chest)
  if not inv then
    return {
      status = "failed",
      detail = "the " .. e.name .. " has no output inventory I can empty",
    }
  end
  local sums = {}
  for _, s in ipairs(inv.get_contents()) do
    sums[s.name] = (sums[s.name] or 0) + s.count
  end
  if next(sums) == nil then
    return { status = "failed", detail = "the " .. e.name .. " is empty — nothing to take" }
  end

  local taken, total = {}, 0
  for name, count in pairs(sums) do
    local kept = pull(c, inv, true, name, count)
    if kept > 0 then
      taken[#taken + 1] = string.format("%d %s", kept, name)
      total = total + kept
    end
  end
  if total == 0 then
    return { status = "failed", detail = "couldn't take anything from the " .. e.name .. " — my inventory is full" }
  end
  table.sort(taken)
  return {
    status = "done",
    detail = string.format("took %s from the %s", table.concat(taken, ", "), e.name),
  }
end

local function extract_items(task, c, e)
  local taken, problems, total = {}, {}, 0
  for _, it in ipairs(task._items) do
    local kept, removed = pull(c, e, false, it.name, it.count)
    total = total + kept
    if kept >= it.count then
      taken[#taken + 1] = string.format("%d %s", kept, it.name)
    elseif kept > 0 then
      local why = kept < removed and "my inventory is full" or "that's all it had"
      taken[#taken + 1] = string.format("%d of %d %s (%s)", kept, it.count, it.name, why)
    else
      problems[#problems + 1] = "it has no " .. it.name
    end
  end
  if total == 0 then
    return {
      status = "failed",
      detail = string.format("couldn't take anything from the %s — %s", e.name, table.concat(problems, "; ")),
    }
  end
  local extra = #problems > 0 and ("; " .. table.concat(problems, "; ")) or ""
  return {
    status = "done",
    detail = string.format("took %s from the %s%s", table.concat(taken, ", "), e.name, extra),
  }
end

function M.extract.tick(task)
  local c = companion.get()
  if not c then return gone() end

  local reached = approach.ensure(task, c, task.target, c.reach_distance)
  if type(reached) == "table" then return reached end
  if reached ~= "ok" then return nil end

  local e = approach.find_entity_near(c, task.target)
  if not e then return no_entity(task, "extract from") end

  if task._all then
    return extract_all(task, c, e)
  end
  return extract_items(task, c, e)
end

-- ---------------------------------------------------------------- deliver
-- Walk to a (moving) player and hand items over into their inventory.

local walk = require("scripts.actions.walk")

M.deliver = {}

function M.deliver.start(task)
  local c = companion.require_companion()
  if task.all ~= true then
    local list = validate_items(task.items, "deliver")
    for _, entry in ipairs(list) do
      if c.get_item_count(entry.name) == 0 then
        error("I don't have any " .. entry.name .. " to deliver — check my inventory with look_around")
      end
    end
  end
  task._dl = {}
end

local function deliver_target(task)
  if task.player then
    local p = game.get_player(task.player)
    if p and p.connected then return p end
    return nil
  end
  return game.connected_players[1]
end

function M.deliver.tick(task)
  local c = companion.get()
  if not c then return gone() end
  local p = deliver_target(task)
  if not (p and p.character and p.character.valid) then
    return {
      status = "failed",
      detail = task.player
        and ("player " .. task.player .. " isn't online (or has no body)")
        or "no player to deliver to — nobody with a body is online",
    }
  end
  local char = p.character

  local dx, dy = char.position.x - c.position.x, char.position.y - c.position.y
  if dx * dx + dy * dy > 4 then
    -- Chase the (possibly moving) player; re-plan when they drift.
    local d = task._dl
    if not d.walk or not d.goal
      or math.abs(d.goal.x - char.position.x) + math.abs(d.goal.y - char.position.y) > 4 then
      d.walk = {}
      d.goal = { x = char.position.x, y = char.position.y }
      walk.begin(d.walk, c, d.goal, 2)
    end
    local r = walk.step(d.walk, c, task.id)
    if type(r) == "table" then
      return { status = "failed", detail = "couldn't reach " .. p.name .. ": " .. r.failed }
    elseif r == "arrived" then
      d.walk = nil
    end
    return nil
  end
  c.walking_state = { walking = false }

  local inv = c.get_main_inventory()
  local wanted = {}
  if task.all == true then
    for _, item in ipairs(inv.get_contents()) do
      wanted[item.name] = (wanted[item.name] or 0) + item.count
    end
    if next(wanted) == nil then
      return { status = "failed", detail = "my inventory is empty — nothing to deliver" }
    end
  else
    for name, count in pairs(task.items) do
      wanted[name] = math.floor(tonumber(count) or 0)
    end
  end

  local delivered, kept, total = {}, {}, 0
  for name, count in pairs(wanted) do
    local n = math.min(inv.get_item_count(name), count)
    if n > 0 then
      local given = char.insert({ name = name, count = n })
      if given > 0 then
        inv.remove({ name = name, count = given })
        delivered[#delivered + 1] = string.format("%d %s", given, name)
        total = total + given
      end
      if given < n then kept[#kept + 1] = name end
    end
  end

  if total == 0 then
    return {
      status = "failed",
      detail = "couldn't hand anything over — is " .. p.name .. "'s inventory full?",
    }
  end
  table.sort(delivered)
  return {
    status = "done",
    detail = string.format("delivered %s to %s%s",
      table.concat(delivered, ", "), p.name,
      #kept > 0 and (" — their inventory filled up, I kept the rest of: " .. table.concat(kept, ", ")) or ""),
  }
end

return M
