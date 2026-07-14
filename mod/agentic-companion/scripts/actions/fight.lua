-- fight: anchored area combat. Walks into gun range, re-sets shooting_state
-- every tick (one-shot writes, like walking_state), moves to the next enemy
-- until the radius is clear, retreats toward a player at low health.
local companion = require("scripts.companion")
local equipment = require("scripts.equipment")
local walk = require("scripts.actions.walk")

local M = {}

local ENEMY_TYPES = { "unit", "unit-spawner", "turret" }
local DEFAULT_RADIUS = 20
local MAX_RADIUS = 40
local DEFAULT_FLEE_BELOW = 0.3

local function stop_shooting(c)
  pcall(function()
    c.shooting_state = { state = defines.shooting.not_shooting }
  end)
end

local function gun_range(c)
  local range = 15
  local name = equipment.current_gun(c)
  if name then
    pcall(function()
      local ap = prototypes.item[name].attack_parameters
      if ap and type(ap.range) == "number" then range = ap.range end
    end)
  end
  return range
end

local function total_ammo(c)
  local n = 0
  pcall(function()
    local inv = c.get_inventory(defines.inventory.character_ammo)
    if inv then
      for i = 1, #inv do
        if inv[i].valid_for_read then n = n + inv[i].count end
      end
    end
  end)
  return n
end

local function kills_phrase(n)
  return string.format("%d kill%s", n, n == 1 and "" or "s")
end

function M.start(task)
  local c = companion.require_companion()
  local gun = equipment.current_gun(c)
  if not gun then
    error("equip a gun first — I have none. Give me e.g. a pistol and use equip")
  end
  if total_ammo(c) == 0 then
    error("no ammo for my " .. gun .. " — hand me some and equip it")
  end
  task.radius = math.min(tonumber(task.radius) or DEFAULT_RADIUS, MAX_RADIUS)
  task.flee_below = tonumber(task.flee_below) or DEFAULT_FLEE_BELOW
  local anchor = (task.target and type(task.target.x) == "number") and task.target or c.position
  task._fight = {
    anchor = { x = anchor.x, y = anchor.y },
    kills = 0,
    range = gun_range(c),
    engaged = false,
  }
end

local function pick_target(c, f, radius)
  local best, best_d
  for _, e in ipairs(c.surface.find_entities_filtered({
    type = ENEMY_TYPES,
    force = game.forces.enemy,
    position = f.anchor,
    radius = radius,
  })) do
    if e.valid then
      local dx, dy = e.position.x - c.position.x, e.position.y - c.position.y
      local d = dx * dx + dy * dy
      if not best or d < best_d then
        best, best_d = e, d
      end
    end
  end
  return best
end

function M.tick(task)
  local c = companion.get()
  if not c then
    return { status = "failed", detail = "the companion character is gone" }
  end
  local f = task._fight

  -- Low health → break off and retreat toward a player (or the spawn point).
  local max_health = 250
  pcall(function() max_health = c.max_health end)
  if (c.health or 0) / max_health < task.flee_below then
    stop_shooting(c)
    if not f.retreat then
      local dest
      local p = game.connected_players[1]
      if p and p.character then
        dest = { x = p.position.x, y = p.position.y }
      else
        local sp = c.force.get_spawn_position(c.surface)
        dest = { x = sp.x, y = sp.y }
      end
      f.retreat = {}
      walk.begin(f.retreat, c, dest, 3)
    end
    local r = walk.step(f.retreat, c, task.id)
    if r == "arrived" or type(r) == "table" then
      return {
        status = "done",
        detail = string.format("retreated at low health after %s — patch me up before the next fight",
          kills_phrase(f.kills)),
      }
    end
    return nil
  end

  -- Current target (re-acquire when dead/invalid; count the kill if we were on it).
  local target = f.target
  if not (target and target.valid) then
    if f.engaged then
      f.kills = f.kills + 1
      f.engaged = false
    end
    target = pick_target(c, f, task.radius)
    f.target = target
    f.walk = nil
    if not target then
      stop_shooting(c)
      return { status = "done", detail = string.format("area cleared — %s", kills_phrase(f.kills)) }
    end
  end

  if total_ammo(c) == 0 then
    stop_shooting(c)
    return {
      status = "failed",
      detail = string.format("out of ammo after %s — enemies remain, bring me more ammo", kills_phrase(f.kills)),
    }
  end

  local dx, dy = target.position.x - c.position.x, target.position.y - c.position.y
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist > f.range - 1 then
    stop_shooting(c)
    -- Walk toward the target; re-plan when it has drifted from the walk goal.
    if not f.walk or not f.walk_goal
      or math.abs(f.walk_goal.x - target.position.x) + math.abs(f.walk_goal.y - target.position.y) > 3 then
      f.walk = {}
      f.walk_goal = { x = target.position.x, y = target.position.y }
      walk.begin(f.walk, c, f.walk_goal, math.max(f.range - 2, 2))
    end
    local r = walk.step(f.walk, c, task.id)
    if type(r) == "table" then
      -- Unreachable (water in between?) — drop this target and look for another.
      f.target = nil
      f.walk = nil
    elseif r == "arrived" then
      f.walk = nil
    end
    return nil
  end

  c.walking_state = { walking = false }
  f.engaged = true
  c.shooting_state = {
    state = defines.shooting.shooting_enemies,
    position = { x = target.position.x, y = target.position.y },
  }
  return nil
end

return M
