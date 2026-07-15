-- defend_area: persistent garrison duty around an anchor. Priorities:
-- 1) shoot enemies that enter the area, 2) refill ammo turrets, 3) repair
-- damaged structures (consumes repair packs). Runs until cancelled/replaced.
local companion = require("scripts.companion")
local equipment = require("scripts.equipment")
local approach = require("scripts.actions.approach")
local walk = require("scripts.actions.walk")
local chat = require("scripts.chat")
local events = require("scripts.events")

local M = {}

local DEFAULT_RADIUS = 16
local MAX_RADIUS = 32
local SCAN_INTERVAL_TICKS = 120
local ENEMY_TYPES = { "unit", "unit-spawner", "turret" }
local TURRET_LOW_AMMO = 5
local TURRET_TOP_UP = 10
local HEAL_PER_TICK = 3
local HP_PER_REPAIR_PACK = 150

local function dist_sq(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return dx * dx + dy * dy
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

local function stop_shooting(c)
  pcall(function()
    c.shooting_state = { state = defines.shooting.not_shooting }
  end)
end

-- First ammo item carried in the MAIN inventory (turret refills come from
-- there, not from the character's own ammo slots).
local function carried_ammo_item(c)
  for _, item in ipairs(c.get_main_inventory().get_contents()) do
    local is_ammo = false
    pcall(function() is_ammo = prototypes.item[item.name].type == "ammo" end)
    if is_ammo then return item.name end
  end
  return nil
end

local function say_once(def, key, text)
  if not def[key] then
    def[key] = true
    pcall(chat.say, { text = text })
    pcall(events.push, "supply_warning", text)
  end
end

function M.start(task)
  local c = companion.require_companion()
  if not equipment.current_gun(c) then
    error("defending needs a gun — equip one (and ammo) first")
  end
  local anchor = (task.center and type(task.center.x) == "number") and task.center or c.position
  task.radius = math.max(8, math.min(tonumber(task.radius) or DEFAULT_RADIUS, MAX_RADIUS))
  task._def = {
    anchor = { x = anchor.x, y = anchor.y },
    range = gun_range(c),
    kills = 0,
    next_scan = 0,
  }
end

local function engage(task, c, def)
  local enemy = def.enemy
  if total_ammo(c) == 0 then
    stop_shooting(c)
    def.enemy = nil
    say_once(def, "warned_ammo",
      "I'm out of personal ammo — I'll keep servicing turrets, but bring me magazines!")
    return
  end
  def.warned_ammo = nil

  local dx, dy = enemy.position.x - c.position.x, enemy.position.y - c.position.y
  local dist = math.sqrt(dx * dx + dy * dy)
  if dist > def.range - 1 then
    stop_shooting(c)
    if not def.walk or not def.walk_goal
      or math.abs(def.walk_goal.x - enemy.position.x) + math.abs(def.walk_goal.y - enemy.position.y) > 3 then
      def.walk = {}
      def.walk_goal = { x = enemy.position.x, y = enemy.position.y }
      walk.begin(def.walk, c, def.walk_goal, math.max(def.range - 2, 2))
    end
    local r = walk.step(def.walk, c, task.id)
    if type(r) == "table" then
      def.enemy = nil -- unreachable; next scan picks another
      def.walk = nil
    elseif r == "arrived" then
      def.walk = nil
    end
    return
  end
  c.walking_state = { walking = false }
  def.engaged = true
  c.shooting_state = {
    state = defines.shooting.shooting_enemies,
    position = { x = enemy.position.x, y = enemy.position.y },
  }
end

local function service(task, c, def)
  local target = def.service
  if not (target and target.valid) then
    def.service = nil
    return false
  end
  local reached = approach.ensure(task, c, target.position, c.reach_distance)
  if type(reached) == "table" then
    def.service = nil
    task._approach = nil
    return false
  end
  if reached ~= "ok" then return true end

  if def.service_kind == "turret" then
    local ammo_name = carried_ammo_item(c)
    if ammo_name then
      local n = math.min(c.get_main_inventory().get_item_count(ammo_name), TURRET_TOP_UP)
      local inserted = 0
      pcall(function() inserted = target.insert({ name = ammo_name, count = n }) end)
      if inserted > 0 then
        c.remove_item({ name = ammo_name, count = inserted })
        def.refills = (def.refills or 0) + 1
        def.warned_turret_ammo = nil
      end
    else
      say_once(def, "warned_turret_ammo",
        "the turrets need ammo but I carry none — bring me magazines to hand out")
    end
    def.service = nil
    return false
  end

  -- repair
  if c.get_item_count("repair-pack") == 0 then
    say_once(def, "warned_repair", "structures are damaged but I have no repair packs left")
    def.service = nil
    return false
  end
  def.warned_repair = nil
  local max_health = nil
  pcall(function() max_health = target.max_health end)
  if not max_health or (target.health or 0) >= max_health then
    def.service = nil
    return false
  end
  target.health = math.min(max_health, target.health + HEAL_PER_TICK)
  def.heal_debt = (def.heal_debt or 0) + HEAL_PER_TICK
  if def.heal_debt >= HP_PER_REPAIR_PACK then
    def.heal_debt = def.heal_debt - HP_PER_REPAIR_PACK
    c.remove_item({ name = "repair-pack", count = 1 })
  end
  if target.health >= max_health then
    def.repairs = (def.repairs or 0) + 1
    def.service = nil
  end
  return true
end

function M.tick(task)
  local c = companion.get()
  if not c then
    return { status = "failed", detail = "the companion character is gone" }
  end
  local def = task._def

  -- Priority 1: an enemy we're on.
  if def.enemy and def.enemy.valid then
    engage(task, c, def)
    return nil
  end
  if def.engaged then
    def.kills = def.kills + 1
    def.engaged = false
  end
  def.enemy = nil
  stop_shooting(c)

  -- Priority 2: current service job (turret refill / repair).
  if def.service then
    service(task, c, def)
    return nil
  end

  -- Periodic scan for new work.
  if game.tick < def.next_scan then
    c.walking_state = { walking = false }
    return nil
  end
  def.next_scan = game.tick + SCAN_INTERVAL_TICKS

  -- Enemies first.
  local best, best_d
  for _, e in ipairs(c.surface.find_entities_filtered({
    type = ENEMY_TYPES,
    force = game.forces.enemy,
    position = def.anchor,
    radius = task.radius + 8,
  })) do
    if e.valid then
      local d = dist_sq(e.position, c.position)
      if not best or d < best_d then best, best_d = e, d end
    end
  end
  if best then
    def.enemy = best
    def.walk = nil
    return nil
  end

  -- Turrets low on ammo.
  for _, t in ipairs(c.surface.find_entities_filtered({
    type = "ammo-turret",
    force = c.force,
    position = def.anchor,
    radius = task.radius,
  })) do
    if t.valid then
      local count = 0
      pcall(function()
        local inv = t.get_inventory(defines.inventory.turret_ammo)
        if inv then count = inv.get_item_count() end
      end)
      if count < TURRET_LOW_AMMO then
        def.service = t
        def.service_kind = "turret"
        task._approach = nil
        return nil
      end
    end
  end

  -- Damaged structures.
  for _, e in ipairs(c.surface.find_entities_filtered({
    force = c.force,
    position = def.anchor,
    radius = task.radius,
  })) do
    if e.valid and e.type ~= "character" then
      local hp, max = nil, nil
      pcall(function()
        hp = e.health
        max = e.max_health
      end)
      if hp and max and hp < max then
        def.service = e
        def.service_kind = "repair"
        task._approach = nil
        return nil
      end
    end
  end

  return nil -- persistent: only cancel/replace ends this duty
end

return M
