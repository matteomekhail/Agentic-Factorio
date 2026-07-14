-- inspect: detailed view of ONE entity, located by map position (1.5-tile
-- search, non-characters preferred) or by unit_number (see docs/PROTOCOL.md).
local companion = require("scripts.companion")

local M = {}

local SEARCH_RADIUS = 1.5

local function round1(v)
  return math.floor(v * 10 + 0.5) / 10
end

local function round2(v)
  return math.floor(v * 100 + 0.5) / 100
end

local function distance(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return math.sqrt(dx * dx + dy * dy)
end

-- Probe order matters: several defines.inventory values share the same numeric
-- index across entity types (e.g. fuel and chest), so each index is probed
-- once. The fuel slot is relabeled "main" when the entity has no burner.
local INVENTORY_PROBES = {
  { "fuel", "fuel" },
  { "chest", "main" },
  { "furnace_source", "input" },
  { "furnace_result", "output" },
  { "assembling_machine_input", "input" },
  { "assembling_machine_output", "output" },
}

local function collect_inventories(entity)
  local ok_burner, burner = pcall(function() return entity.burner end)
  local has_burner = ok_burner and burner ~= nil

  local result = {}
  local seen = {}
  local found = false
  for _, probe in ipairs(INVENTORY_PROBES) do
    local index = defines.inventory[probe[1]]
    if index and not seen[index] then
      seen[index] = true
      local ok, inv = pcall(entity.get_inventory, index)
      if ok and inv and not inv.is_empty() then
        local label = probe[2]
        if probe[1] == "fuel" and not has_burner then label = "main" end
        local bucket = result[label] or {}
        result[label] = bucket
        for _, item in ipairs(inv.get_contents()) do
          bucket[item.name] = (bucket[item.name] or 0) + item.count
        end
        found = true
      end
    end
  end
  if found then return result end
  return nil
end

local function locate(params)
  if params.unit_number ~= nil then
    local n = tonumber(params.unit_number)
    local e = n and game.get_entity_by_unit_number(n)
    if not (e and e.valid) then
      error("no entity with unit_number " .. tostring(params.unit_number)
        .. " — it may have been removed or mined")
    end
    return e
  end

  local pos = params.position
  if type(pos) ~= "table" or tonumber(pos.x) == nil or tonumber(pos.y) == nil then
    error("inspect needs either a position {x, y} or a unit_number")
  end
  local target = { x = tonumber(pos.x), y = tonumber(pos.y) }

  local c = companion.get()
  local surface
  if c then
    surface = c.surface
  else
    local player = game.connected_players[1]
    if not player then
      error("no companion and no connected players — call spawn_companion first")
    end
    surface = player.surface
  end

  local best, best_d = nil, math.huge
  local best_char, best_char_d = nil, math.huge
  for _, e in ipairs(surface.find_entities_filtered({ position = target, radius = SEARCH_RADIUS })) do
    if e.valid then
      local d = distance(e.position, target)
      if e.type == "character" then
        if d < best_char_d then best_char, best_char_d = e, d end
      elseif d < best_d then
        best, best_d = e, d
      end
    end
  end
  local entity = best or best_char
  if not entity then
    error(string.format(
      "nothing to inspect within %.1f tiles of (%.1f, %.1f) — check the position or look_around first",
      SEARCH_RADIUS, target.x, target.y))
  end
  return entity
end

function M.inspect(params)
  local e = locate(params)

  local out = {
    name = e.name,
    type = e.type,
    position = { x = round1(e.position.x), y = round1(e.position.y) },
    direction = e.direction,
  }

  local ok, health = pcall(function() return e.health end)
  if ok and health then out.health = round1(health) end

  -- entity.status can throw or be nil on some types
  local ok_status, status = pcall(function() return e.status end)
  if ok_status and status ~= nil then
    for name, value in pairs(defines.entity_status) do
      if value == status then
        out.status = name
        break
      end
    end
  end

  local ok_recipe, recipe = pcall(e.get_recipe)
  if ok_recipe and recipe then out.recipe = recipe.name end

  local ok_progress, progress = pcall(function() return e.crafting_progress end)
  if ok_progress and type(progress) == "number" then
    out.crafting_progress = round2(progress)
  end

  local ok_energy, energy = pcall(function() return e.energy end)
  if ok_energy and type(energy) == "number" and energy > 0 then
    out.energy = math.floor(energy)
  end

  if e.type == "resource" then out.amount = e.amount end

  local inventories = collect_inventories(e)
  if inventories then out.inventories = inventories end

  return out
end

return M
