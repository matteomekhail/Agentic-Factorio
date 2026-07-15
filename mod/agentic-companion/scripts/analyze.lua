-- analyze_factory: one-call diagnosis of everything that's stuck in an area,
-- grouped by (machine, problem) with a sample position and — where we can
-- tell — the missing ingredient. Saves the model a dozen inspect calls.
local companion = require("scripts.companion")
local perceive = require("scripts.perceive")

local M = {}

local DEFAULT_RADIUS = 40
local MAX_RADIUS = 80
local MAX_PROBLEM_GROUPS = 15

-- Statuses worth reporting. Inserter wait-states are excluded on purpose:
-- an idle inserter is usually a symptom, not the cause.
local PROBLEM_STATUSES = {
  no_power = true,
  low_power = true,
  no_fuel = true,
  no_ingredients = true,
  no_input_fluid = true,
  no_recipe = true,
  no_research_in_progress = true,
  missing_required_fluid = true,
  no_minable_resources = true,
  output_full = true,
  full_output = true,
  item_ingredient_shortage = true,
  fluid_ingredient_shortage = true,
  low_input_fluid = true,
  networks_disconnected = true,
}

local function round_half(v)
  return math.floor(v * 2 + 0.5) / 2
end

local function dist_sq(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return dx * dx + dy * dy
end

-- Which ingredients a stalled crafting machine is short of (best effort).
local function missing_ingredients(e)
  local result = nil
  pcall(function()
    local recipe = e.get_recipe()
    if not recipe then return end
    local missing = {}
    local inv = e.get_inventory(defines.inventory.assembling_machine_input)
      or e.get_inventory(defines.inventory.furnace_source)
    for _, ing in ipairs(recipe.ingredients) do
      local have = 0
      if ing.type == "item" then
        have = inv and inv.get_item_count(ing.name) or 0
      else
        pcall(function() have = e.get_fluid_count(ing.name) end)
      end
      if have < (ing.amount or 1) then
        missing[#missing + 1] = ing.name
      end
    end
    if #missing > 0 then
      result = table.concat(missing, ", ")
    end
  end)
  return result
end

function M.analyze_factory(params)
  local radius = math.max(1, math.min(tonumber(params.radius) or DEFAULT_RADIUS, MAX_RADIUS))
  local c = companion.get()

  local origin, surface, force
  if c then
    origin, surface, force = c.position, c.surface, c.force
  else
    local player = game.connected_players[1]
    if not player then
      error("no companion and no connected players — call spawn_companion first")
    end
    origin, surface, force = player.position, player.surface, player.force
  end

  local status_names = {}
  for name, value in pairs(defines.entity_status) do
    status_names[value] = name
  end

  local groups = {}
  local working, checked = 0, 0
  for _, e in ipairs(surface.find_entities_filtered({
    position = origin, radius = radius, force = force,
  })) do
    if e.valid and e.type ~= "character" then
      local ok, st = pcall(function() return e.status end)
      if ok and st ~= nil then
        checked = checked + 1
        local sname = status_names[st] or tostring(st)
        if sname == "working" or sname == "normal" then
          working = working + 1
        elseif PROBLEM_STATUSES[sname] then
          local key = e.name .. "|" .. sname
          local g = groups[key]
          if not g then
            g = {
              name = e.name,
              problem = sname,
              count = 0,
              _d = math.huge,
              _sample_entity = nil,
            }
            groups[key] = g
          end
          g.count = g.count + 1
          local d = dist_sq(e.position, origin)
          if d < g._d then
            g._d = d
            g.sample = { x = round_half(e.position.x), y = round_half(e.position.y) }
            g._sample_entity = e
          end
        end
      end
    end
  end

  local problems = {}
  for _, g in pairs(groups) do
    problems[#problems + 1] = g
  end
  table.sort(problems, function(a, b)
    if a.count ~= b.count then return a.count > b.count end
    return a._d < b._d
  end)
  while #problems > MAX_PROBLEM_GROUPS do table.remove(problems) end
  for _, g in ipairs(problems) do
    if (g.problem == "no_ingredients" or g.problem == "item_ingredient_shortage"
        or g.problem == "fluid_ingredient_shortage" or g.problem == "no_input_fluid")
      and g._sample_entity and g._sample_entity.valid then
      g.missing = missing_ingredients(g._sample_entity)
    end
    g._sample_entity, g._d = nil, nil
  end

  local out = {
    radius = radius,
    machines_checked = checked,
    working = working,
  }
  if #problems > 0 then out.problems = problems end

  local power = perceive.power_summary(surface, force, origin, radius, nil)
  if power then out.power = power end

  return out
end

return M
