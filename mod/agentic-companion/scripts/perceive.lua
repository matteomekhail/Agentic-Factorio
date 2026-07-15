-- get_state v2: compact, token-friendly world snapshot (see docs/PROTOCOL.md).
-- Resources are clustered into patches via grid flood-fill; player-force
-- structures are grouped by name with an entity_status histogram. All scans
-- are centered on the companion, on the companion's own surface.
local companion = require("scripts.companion")
local equipment = require("scripts.equipment")
local tasks = require("scripts.tasks")

local M = {}

local DEFAULT_RADIUS = 40
local MAX_RADIUS = 80
local MAX_PATCHES = 12
local MAX_STRUCTURE_GROUPS = 30
local MAX_PRODUCTION_ITEMS = 8
local PATCH_CELL = 8 -- flood-fill grid cell size in tiles; 8-neighbor cells merge

-- Round positions to the nearest half tile: entity centers sit on multiples
-- of 0.5, which is exactly representable in binary — 0.1 steps are not, and
-- serialize as 26.6999999… noise that wastes the model's tokens.
local function round1(v)
  return math.floor(v * 2 + 0.5) / 2
end

local function round2(v)
  return math.floor(v * 100 + 0.5) / 100
end

-- Distances are for orientation only — whole tiles are plenty.
local function round_dist(v)
  return math.floor(v + 0.5)
end

local function distance(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return math.sqrt(dx * dx + dy * dy)
end

-- get_contents() returns an array of {name, count, quality} in 2.x; sum by name.
local function inventory_map(inv)
  local out = {}
  for _, item in ipairs(inv.get_contents()) do
    out[item.name] = (out[item.name] or 0) + item.count
  end
  return out
end

-- Cluster resource entities into per-name patches: bucket into PATCH_CELL
-- grid cells, then flood-fill cells that touch (8-neighbor) into one patch.
local function cluster_resources(entities, origin)
  local grids = {} -- resource name -> { ["cx,cy"] = cell }
  for _, e in ipairs(entities) do
    if e.valid then
      local grid = grids[e.name]
      if not grid then
        grid = {}
        grids[e.name] = grid
      end
      local cx = math.floor(e.position.x / PATCH_CELL)
      local cy = math.floor(e.position.y / PATCH_CELL)
      local key = cx .. "," .. cy
      local cell = grid[key]
      if not cell then
        cell = { cx = cx, cy = cy, count = 0, amount = 0, sx = 0, sy = 0 }
        grid[key] = cell
      end
      cell.count = cell.count + 1
      cell.amount = cell.amount + (e.amount or 0)
      cell.sx = cell.sx + e.position.x
      cell.sy = cell.sy + e.position.y
    end
  end

  local patches = {}
  for name, grid in pairs(grids) do
    local visited = {}
    for start_key in pairs(grid) do
      if not visited[start_key] then
        visited[start_key] = true
        local stack = { start_key }
        local count, amount, sx, sy = 0, 0, 0, 0
        while #stack > 0 do
          local cell = grid[table.remove(stack)]
          count = count + cell.count
          amount = amount + cell.amount
          sx = sx + cell.sx
          sy = sy + cell.sy
          for dx = -1, 1 do
            for dy = -1, 1 do
              if dx ~= 0 or dy ~= 0 then
                local nk = (cell.cx + dx) .. "," .. (cell.cy + dy)
                if grid[nk] and not visited[nk] then
                  visited[nk] = true
                  stack[#stack + 1] = nk
                end
              end
            end
          end
        end
        local center = { x = round1(sx / count), y = round1(sy / count) }
        patches[#patches + 1] = {
          name = name,
          entity_count = count,
          total_amount = amount,
          center = center,
          distance = round_dist(distance(center, origin)),
        }
      end
    end
  end
  table.sort(patches, function(a, b) return a.distance < b.distance end)
  while #patches > MAX_PATCHES do table.remove(patches) end
  return patches
end

-- Group same-force entities by prototype name with count, nearest position
-- and a histogram of entity_status names (omitted when no entity reports one).
local function structure_groups(entities, origin, status_names)
  local groups = {}
  for _, e in ipairs(entities) do
    if e.valid and e.type ~= "character" then
      local g = groups[e.name]
      if not g then
        g = { name = e.name, count = 0, _distance = math.huge, _statuses = {}, _seen_status = false }
        groups[e.name] = g
      end
      g.count = g.count + 1
      local d = distance(e.position, origin)
      if d < g._distance then
        g._distance = d
        g.nearest = { x = round1(e.position.x), y = round1(e.position.y) }
      end
      -- entity.status can throw on some types
      local ok, st = pcall(function() return e.status end)
      if ok and st ~= nil then
        local sname = status_names[st] or tostring(st)
        g._statuses[sname] = (g._statuses[sname] or 0) + 1
        g._seen_status = true
      end
    end
  end

  local list = {}
  for _, g in pairs(groups) do
    list[#list + 1] = g
  end
  table.sort(list, function(a, b) return a._distance < b._distance end)
  while #list > MAX_STRUCTURE_GROUPS do table.remove(list) end
  for _, g in ipairs(list) do
    if g._seen_status then g.status = g._statuses end
    g._statuses, g._seen_status, g._distance = nil, nil, nil
  end
  return list
end

-- Electric network summary. Factorio's electric statistics are INVERTED vs
-- item statistics (verified live): input_counts = consumers, output_counts =
-- producers. Rates read via get_flow_count over the last minute, in joules.
local MAX_POWER_NAMES = 50

local function collect_power(surface, force, origin, radius, structures)
  local poles = surface.find_entities_filtered({
    position = origin,
    radius = radius,
    type = "electric-pole",
    force = force,
  })
  if #poles == 0 then return nil end

  -- Pick the network with the most poles in view.
  local by_net, best_id, best_n = {}, nil, 0
  for _, pole in ipairs(poles) do
    local ok, id = pcall(function() return pole.electric_network_id end)
    if ok and id then
      by_net[id] = by_net[id] or { n = 0, pole = pole }
      by_net[id].n = by_net[id].n + 1
      if by_net[id].n > best_n then
        best_id, best_n = id, by_net[id].n
      end
    end
  end
  if not best_id then return nil end
  local networks = 0
  for _ in pairs(by_net) do networks = networks + 1 end

  local out = { networks = networks }
  pcall(function()
    local st = by_net[best_id].pole.electric_network_statistics
    local function joules_per_min(counts, category)
      local total, seen = 0, 0
      local per_name = {}
      for name in pairs(counts) do
        seen = seen + 1
        if seen > MAX_POWER_NAMES then break end
        local j = st.get_flow_count({
          name = name,
          category = category,
          precision_index = defines.flow_precision_index.one_minute,
          count = false,
        })
        per_name[name] = j
        total = total + j
      end
      return total, per_name
    end
    local cons_j, cons_by = joules_per_min(st.input_counts, "input")
    local prod_j, _ = joules_per_min(st.output_counts, "output")
    -- get_flow_count returns average J/tick over the window (verified live:
    -- a 60 kW solar panel reads 1000). kW = J/tick * 60 ticks/s / 1000.
    local to_kw = function(j_per_tick) return math.floor(j_per_tick * 60 / 1000 + 0.5) end
    out.production_kw = to_kw(prod_j)
    out.consumption_kw = to_kw(cons_j)
    local names = {}
    for name in pairs(cons_by) do names[#names + 1] = name end
    table.sort(names, function(a, b) return cons_by[a] > cons_by[b] end)
    local top = {}
    for i = 1, math.min(#names, 3) do
      top[names[i]] = to_kw(cons_by[names[i]])
    end
    out.top_consumers_kw = top
  end)

  -- Machines starving for power right now (from the status histograms).
  local starving = 0
  for _, g in ipairs(structures or {}) do
    if g.status then
      starving = starving + (g.status.no_power or 0) + (g.status.low_power or 0)
    end
  end
  if starving > 0 then out.starving_machines = starving end

  return out
end

-- Shared with scripts/analyze.lua.
function M.power_summary(surface, force, origin, radius, structures)
  return collect_power(surface, force, origin, radius, structures)
end

-- Lightweight inventory peek: the addressed companion (default) or a player.
function M.check_inventory(params)
  if type(params.player) == "string" and params.player ~= "" then
    local p = game.get_player(params.player)
    if not (p and p.connected) then
      error("player " .. params.player .. " isn't online")
    end
    if not (p.character and p.character.valid) then
      error(params.player .. " has no body right now")
    end
    return {
      owner = "player " .. params.player,
      inventory = inventory_map(p.character.get_main_inventory()),
    }
  end
  local c = companion.require_companion()
  return {
    owner = "companion " .. companion.context(),
    inventory = inventory_map(c.get_main_inventory()),
    equipment = equipment.summary(c),
  }
end

function M.get_state(params)
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

  local out = { tick = game.tick }

  if c then
    out.companion = {
      name = companion.context(),
      position = { x = round1(origin.x), y = round1(origin.y) },
      health = math.floor(c.health or 0),
      inventory = inventory_map(c.get_main_inventory()),
      active_task = tasks.active_summary(),
      queue_length = tasks.queue_length(),
      equipment = equipment.summary(c),
    }
    pcall(function()
      if c.vehicle then out.companion.vehicle = c.vehicle.name end
    end)
  end

  -- The rest of the crew, so the mother brain can dispatch by name.
  local others = {}
  for _, name in ipairs(companion.names()) do
    if name ~= companion.context() then
      local ent = companion.get(name)
      if ent then
        local summary = {
          name = name,
          position = { x = round1(ent.position.x), y = round1(ent.position.y) },
          health = math.floor(ent.health or 0),
          active_task = tasks.active_summary(name),
          queue_length = tasks.queue_length(name),
        }
        pcall(function()
          if ent.vehicle then summary.vehicle = ent.vehicle.name end
        end)
        others[#others + 1] = summary
      else
        others[#others + 1] = { name = name, dead = true }
      end
    end
  end
  if #others > 0 then out.other_companions = others end

  local players = {}
  for _, p in ipairs(game.connected_players) do
    if p.surface == surface then
      players[#players + 1] = {
        name = p.name,
        position = { x = round1(p.position.x), y = round1(p.position.y) },
        distance = round_dist(distance(p.position, origin)),
      }
    end
  end
  if #players > 0 then out.players = players end

  local patches = cluster_resources(
    surface.find_entities_filtered({ position = origin, radius = radius, type = "resource" }),
    origin)
  if #patches > 0 then out.resource_patches = patches end

  out.trees_nearby = surface.count_entities_filtered({
    position = origin,
    radius = radius,
    type = "tree",
  })

  local status_names = {}
  for name, value in pairs(defines.entity_status) do
    status_names[value] = name
  end
  local structures = structure_groups(
    surface.find_entities_filtered({ position = origin, radius = radius, force = force }),
    origin, status_names)
  if #structures > 0 then out.structures = structures end

  local power = collect_power(surface, force, origin, radius, structures)
  if power then out.power = power end

  local enemies = {
    spawners = surface.count_entities_filtered({
      position = origin,
      radius = radius,
      type = "unit-spawner",
      force = game.forces.enemy,
    }),
  }
  local nearest = surface.find_nearest_enemy({
    position = origin,
    max_distance = radius,
    force = force,
  })
  if nearest then
    enemies.nearest_distance = round_dist(distance(nearest.position, origin))
  end
  out.enemies = enemies

  local current = force.current_research
  if current then
    out.research = { current = current.name, progress = round2(force.research_progress) }
  end

  -- Trends beat lifetime totals: rank by last-minute production rate, fall
  -- back to all-time totals for saves where nothing moved this minute.
  local stats = force.get_item_production_statistics(surface)
  local produced, consumed = stats.input_counts, stats.output_counts
  local function rate(name, category)
    local n = 0
    pcall(function()
      n = stats.get_flow_count({
        name = name,
        category = category,
        precision_index = defines.flow_precision_index.one_minute,
        count = true,
      })
    end)
    return math.floor(n + 0.5)
  end
  local names = {}
  for name in pairs(produced) do
    names[#names + 1] = name
  end
  local per_min = {}
  for _, name in ipairs(names) do
    per_min[name] = rate(name, "input")
  end
  table.sort(names, function(a, b)
    if per_min[a] ~= per_min[b] then return per_min[a] > per_min[b] end
    return produced[a] > produced[b]
  end)
  if #names > 0 then
    local top = {}
    for i = 1, math.min(#names, MAX_PRODUCTION_ITEMS) do
      local name = names[i]
      top[name] = {
        produced_per_min = per_min[name],
        consumed_per_min = rate(name, "output"),
        produced_total = produced[name],
        consumed_total = consumed[name] or 0,
      }
    end
    out.production_top = top
  end

  return out
end

return M
