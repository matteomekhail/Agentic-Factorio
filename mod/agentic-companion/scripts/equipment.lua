-- Gun/ammo/armor slots: the instant "equip" method plus read helpers for
-- perceive (companion.equipment) and the fight task. Guns and armor swap the
-- old item back into the main inventory; ammo tops up the slot paired with
-- the equipped gun (gun slot i shoots from ammo slot i).
local companion = require("scripts.companion")

local M = {}

local TYPE_PHRASE = { gun = "a gun", ammo = "ammo", armor = "armor" }

-- Return leftovers to the main inventory; anything that doesn't fit spills.
local function give_back(c, main, name, count)
  local inserted = main.insert({ name = name, count = count })
  if inserted < count then
    pcall(c.surface.spill_item_stack, {
      position = c.position,
      stack = { name = name, count = count - inserted },
      force = c.force,
    })
  end
end

local function checked_item(name, wanted_type)
  if type(name) ~= "string" then
    error("equip: " .. wanted_type .. " must be an item name string")
  end
  local proto = prototypes.item[name]
  if not proto then
    error("no item called '" .. name .. "'")
  end
  if proto.type ~= wanted_type then
    error(string.format("%s isn't %s — it can't go in the %s slot",
      name, TYPE_PHRASE[wanted_type], wanted_type))
  end
  return proto
end

-- Puts one `name` into a gun slot and returns the slot index. Prefers a slot
-- that already holds this gun, then an empty slot, then swaps the selected one.
local function equip_gun(c, main, name)
  local gun_inv = c.get_inventory(defines.inventory.character_guns)
  if not gun_inv or #gun_inv == 0 then
    error("I have no gun slots — that shouldn't happen for a character")
  end
  for i = 1, #gun_inv do
    local s = gun_inv[i]
    if s.valid_for_read and s.name == name then return i end
  end
  if main.get_item_count(name) == 0 then
    error("I don't have a " .. name .. " in my inventory — craft or pick one up first")
  end
  local target
  for i = 1, #gun_inv do
    if not gun_inv[i].valid_for_read then
      target = i
      break
    end
  end
  local old
  if not target then
    target = 1
    pcall(function()
      local idx = c.selected_gun_index
      if type(idx) == "number" and idx >= 1 and idx <= #gun_inv then target = idx end
    end)
    local s = gun_inv[target]
    old = { name = s.name, count = s.count }
  end
  main.remove({ name = name, count = 1 })
  local placed = false
  pcall(function() placed = gun_inv[target].set_stack({ name = name, count = 1 }) end)
  if not placed then
    main.insert({ name = name, count = 1 })
    error("couldn't put the " .. name .. " into a gun slot — the slot refused it")
  end
  if old then give_back(c, main, old.name, old.count) end
  return target
end

-- Loads as much `name` as fits (up to one stack) into the ammo slot paired
-- with `gun_slot` (or the selected gun's slot). Different ammo already in the
-- slot is swapped back to the main inventory.
local function equip_ammo(c, main, name, stack_size, gun_slot)
  local ammo_inv = c.get_inventory(defines.inventory.character_ammo)
  if not ammo_inv or #ammo_inv == 0 then
    error("I have no ammo slots — that shouldn't happen for a character")
  end
  local slot = gun_slot
  if not slot then
    pcall(function()
      local idx = c.selected_gun_index
      if type(idx) == "number" then slot = idx end
    end)
  end
  if type(slot) ~= "number" or slot < 1 or slot > #ammo_inv then slot = 1 end

  local stack = ammo_inv[slot]
  local current = (stack.valid_for_read and stack.name == name) and stack.count or 0
  local have = main.get_item_count(name)
  if have == 0 then
    if current > 0 then return end -- nothing to add, but it's already loaded
    error("I don't have any " .. name .. " in my inventory — craft some first")
  end

  local old
  if stack.valid_for_read and stack.name ~= name then
    old = { name = stack.name, count = stack.count }
  end

  local n = math.min(have, stack_size - current)
  if n <= 0 then return end -- already holding a full stack of this ammo
  main.remove({ name = name, count = n })
  local placed = false
  pcall(function()
    if current > 0 then
      stack.count = current + n
      placed = true
    else
      placed = stack.set_stack({ name = name, count = n })
    end
  end)
  if not placed then
    main.insert({ name = name, count = n })
    error("the " .. name .. " wouldn't go into the ammo slot — is it the right ammo for your gun?")
  end
  if old then give_back(c, main, old.name, old.count) end
end

local function equip_armor(c, main, name)
  local armor_inv = c.get_inventory(defines.inventory.character_armor)
  if not armor_inv or #armor_inv == 0 then
    error("I have no armor slot — that shouldn't happen for a character")
  end
  local stack = armor_inv[1]
  if stack.valid_for_read and stack.name == name then return end -- already wearing it
  if main.get_item_count(name) == 0 then
    error("I don't have a " .. name .. " in my inventory — craft or pick one up first")
  end
  local old
  if stack.valid_for_read then
    old = { name = stack.name, count = stack.count }
  end
  main.remove({ name = name, count = 1 })
  local placed = false
  pcall(function() placed = stack.set_stack({ name = name, count = 1 }) end)
  if not placed then
    main.insert({ name = name, count = 1 })
    error("couldn't put the " .. name .. " into the armor slot — the slot refused it")
  end
  -- Swapping armor can shrink the main inventory; overflow spills next to me.
  if old then give_back(c, main, old.name, old.count) end
end

-- ------------------------------------------------------------ read helpers

-- Currently usable gun: name, slot index — or nil when no gun is equipped.
-- Prefers the selected slot, falls back to the first slot holding a gun.
-- pcall-guarded so callers can trust it in any character state.
function M.current_gun(c)
  local name, slot
  pcall(function()
    local gun_inv = c.get_inventory(defines.inventory.character_guns)
    if not gun_inv then return end
    local idx = c.selected_gun_index
    if type(idx) == "number" and idx >= 1 and idx <= #gun_inv then
      local s = gun_inv[idx]
      if s.valid_for_read then
        name, slot = s.name, idx
        return
      end
    end
    for i = 1, #gun_inv do
      local s = gun_inv[i]
      if s.valid_for_read then
        name, slot = s.name, i
        return
      end
    end
  end)
  return name, slot
end

-- Ammo loaded for gun slot `slot` (guns shoot from the same-index ammo slot).
-- Returns name, count — or nil, 0 when the slot is empty.
function M.slot_ammo(c, slot)
  local name, count = nil, 0
  pcall(function()
    local ammo_inv = c.get_inventory(defines.inventory.character_ammo)
    if not ammo_inv or type(slot) ~= "number" or slot < 1 or slot > #ammo_inv then return end
    local s = ammo_inv[slot]
    if s.valid_for_read then
      name, count = s.name, s.count
    end
  end)
  return name, count
end

-- Equipment snapshot for perceive's companion block:
-- { gun = <name|nil>, ammo = {name: count}, armor = <name|nil> }.
-- Nil-safe and pcall-guarded — never raises.
function M.summary(c)
  local out = { ammo = {} }
  if not (c and c.valid) then return out end
  out.gun = M.current_gun(c)
  pcall(function()
    local ammo_inv = c.get_inventory(defines.inventory.character_ammo)
    if ammo_inv then
      for i = 1, #ammo_inv do
        local s = ammo_inv[i]
        if s.valid_for_read then
          out.ammo[s.name] = (out.ammo[s.name] or 0) + s.count
        end
      end
    end
    local armor_inv = c.get_inventory(defines.inventory.character_armor)
    if armor_inv and #armor_inv >= 1 and armor_inv[1].valid_for_read then
      out.armor = armor_inv[1].name
    end
  end)
  return out
end

-- --------------------------------------------------------------- rpc: equip

function M.equip(params)
  local c = companion.require_companion()
  if params.gun == nil and params.ammo == nil and params.armor == nil then
    error("equip needs at least one of gun, ammo, armor — item names from my inventory,"
      .. " e.g. gun=\"pistol\", ammo=\"firearm-magazine\"")
  end
  local main = c.get_main_inventory()

  local gun_slot
  if params.gun ~= nil then
    checked_item(params.gun, "gun")
    gun_slot = equip_gun(c, main, params.gun)
    pcall(function() c.selected_gun_index = gun_slot end)
  end
  if params.ammo ~= nil then
    local proto = checked_item(params.ammo, "ammo")
    equip_ammo(c, main, params.ammo, proto.stack_size or 1, gun_slot)
  end
  if params.armor ~= nil then
    checked_item(params.armor, "armor")
    equip_armor(c, main, params.armor)
  end
  -- Selecting a gun slot can fail while its ammo slot is empty — retry now
  -- that ammo may have been loaded.
  if gun_slot then
    pcall(function() c.selected_gun_index = gun_slot end)
  end
  return M.summary(c)
end

return M
