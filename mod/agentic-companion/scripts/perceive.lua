-- get_state v2: compact, token-friendly world snapshot (see docs/PROTOCOL.md).
-- Resources are clustered into patches via grid flood-fill; player-force
-- structures are grouped by name with an entity_status histogram. All scans
-- are centered on the companion, on the companion's own surface.
local companion = require("scripts.companion")
local equipment = require("scripts.equipment")

local M = {}

local DEFAULT_RADIUS = 40
local MAX_RADIUS = 80
local MAX_PATCHES = 12
local MAX_STRUCTURE_GROUPS = 30
local MAX_PRODUCTION_ITEMS = 8
local PATCH_CELL = 8 -- flood-fill grid cell size in tiles; 8-neighbor cells merge

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
          distance = round1(distance(center, origin)),
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
    local active = storage.tasks.active
    out.companion = {
      position = { x = round1(origin.x), y = round1(origin.y) },
      health = math.floor(c.health or 0),
      inventory = inventory_map(c.get_main_inventory()),
      active_task = active and { id = active.id, type = active.type, status = "running" } or nil,
      queue_length = #storage.tasks.queue,
      equipment = equipment.summary(c),
    }
  end

  local players = {}
  for _, p in ipairs(game.connected_players) do
    if p.surface == surface then
      players[#players + 1] = {
        name = p.name,
        position = { x = round1(p.position.x), y = round1(p.position.y) },
        distance = round1(distance(p.position, origin)),
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
    enemies.nearest_distance = round1(distance(nearest.position, origin))
  end
  out.enemies = enemies

  local current = force.current_research
  if current then
    out.research = { current = current.name, progress = round2(force.research_progress) }
  end

  local stats = force.get_item_production_statistics(surface)
  local produced, consumed = stats.input_counts, stats.output_counts
  local names = {}
  for name in pairs(produced) do
    names[#names + 1] = name
  end
  table.sort(names, function(a, b) return produced[a] > produced[b] end)
  if #names > 0 then
    local top = {}
    for i = 1, math.min(#names, MAX_PRODUCTION_ITEMS) do
      local name = names[i]
      top[name] = { produced = produced[name], consumed = consumed[name] or 0 }
    end
    out.production_top = top
  end

  return out
end

return M
