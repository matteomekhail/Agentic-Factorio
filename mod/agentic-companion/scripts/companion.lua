-- Companion registry: up to MAX_COMPANIONS named characters ("AI" is the
-- default). A transient per-call context selects which companion the current
-- RPC/task acts on: rpc.lua sets it from params.companion, tasks.lua sets it
-- per lane before each tick. Existing single-companion code keeps calling
-- get()/require_companion() unchanged.
local M = {}

M.DEFAULT = "AI"
local MAX_COMPANIONS = 4

local PALETTE = {
  { r = 0.30, g = 0.79, b = 0.69, a = 1 }, -- teal
  { r = 0.90, g = 0.62, b = 0.20, a = 1 }, -- amber
  { r = 0.66, g = 0.55, b = 0.96, a = 1 }, -- violet
  { r = 0.86, g = 0.42, b = 0.55, a = 1 }, -- rose
}

local LABEL_OFFSET = { 0, -2.9 }
local MAP_TAG_MOVE_SQ = 9

-- Transient (NOT storage-safe, deliberately): valid only within one call/tick.
local current_name = nil

function M.set_context(name)
  current_name = (type(name) == "string" and name ~= "") and name or nil
end

function M.context()
  return current_name or M.DEFAULT
end

local function records()
  storage.companions = storage.companions or {}
  return storage.companions
end

function M.names()
  local out = {}
  for name in pairs(records()) do
    out[#out + 1] = name
  end
  table.sort(out)
  return out
end

function M.get(name)
  local rec = records()[name or M.context()]
  local ent = rec and rec.entity
  if ent and ent.valid then return ent end
  return nil
end

function M.record(name)
  return records()[name or M.context()]
end

function M.require_companion(name)
  local ent = M.get(name)
  if not ent then
    local who = name or M.context()
    error("companion '" .. who .. "' does not exist — call spawn_companion"
      .. (who ~= M.DEFAULT and ' with {"name":"' .. who .. '"}' or "") .. " first")
  end
  return ent
end

local function count_companions()
  local n = 0
  for _ in pairs(records()) do n = n + 1 end
  return n
end

local function color_for(name)
  local idx = 1
  local sorted = M.names()
  for i, n in ipairs(sorted) do
    if n == name then idx = i break end
  end
  return PALETTE[(idx - 1) % #PALETTE + 1]
end

-- Floating name tag that follows the character; self-healed periodically.
local function attach_label(rec, name, ent)
  pcall(function()
    if rec.label and rec.label.valid then rec.label.destroy() end
  end)
  rec.label = nil
  local args = {
    text = name,
    surface = ent.surface,
    color = color_for(name),
    scale = 1.4,
    alignment = "center",
    scale_with_zoom = true,
  }
  local ok, obj = pcall(function()
    args.target = { entity = ent, offset = LABEL_OFFSET }
    return rendering.draw_text(args)
  end)
  if not ok or not obj then
    ok, obj = pcall(function()
      args.target = ent
      args.target_offset = LABEL_OFFSET
      return rendering.draw_text(args)
    end)
  end
  if ok and obj then rec.label = obj end
end

-- Map/minimap markers for every companion; chart tags can't move, so re-pin
-- after drifting. Runs on_nth_tick (wired in control.lua) — must never raise.
function M.update_map_tag()
  for name, rec in pairs(records()) do
    local ent = rec.entity
    local alive = ent and ent.valid
    local tag = rec.map_tag
    local tag_valid = false
    pcall(function() tag_valid = tag and tag.valid end)

    if not alive then
      if tag_valid then pcall(function() tag.destroy() end) end
      rec.map_tag = nil
    else
      local label_valid = false
      pcall(function() label_valid = rec.label and rec.label.valid end)
      if not label_valid then attach_label(rec, name, ent) end

      local keep = false
      if tag_valid then
        local p = tag.position
        local dx, dy = p.x - ent.position.x, p.y - ent.position.y
        keep = dx * dx + dy * dy < MAP_TAG_MOVE_SQ
        if not keep then pcall(function() tag.destroy() end) end
      end
      if not keep then
        rec.map_tag = nil
        pcall(function()
          rec.map_tag = ent.force.add_chart_tag(ent.surface, {
            position = ent.position,
            text = name,
            icon = { type = "virtual", name = "signal-A" },
          })
        end)
      end
    end
  end
end

function M.spawn(params)
  local name = (type(params.name) == "string" and params.name ~= "") and params.name or M.context()
  if #name > 20 then error("companion names must be 20 characters or fewer") end

  local existing = M.get(name)
  if existing then
    return {
      name = name,
      position = { x = existing.position.x, y = existing.position.y },
      unit_number = existing.unit_number,
      already_existed = true,
    }
  end
  if not records()[name] and count_companions() >= MAX_COMPANIONS then
    error("max " .. MAX_COMPANIONS .. " companions — currently: " .. table.concat(M.names(), ", "))
  end

  local surface, anchor, force
  local player
  if params.near_player then
    player = game.get_player(params.near_player)
    if not player then error("no such player: " .. tostring(params.near_player)) end
  else
    player = game.connected_players[1]
  end
  if player then
    surface, anchor, force = player.surface, player.position, player.force
  else
    -- No one online (headless/CI): spawn at the force spawn point.
    force = game.forces.player
    surface = game.surfaces[1]
    anchor = force.get_spawn_position(surface)
  end

  local pos = surface.find_non_colliding_position("character", anchor, 16, 0.5)
  if not pos then error("no free spot to spawn the companion") end

  local ent = surface.create_entity({
    name = "character",
    position = pos,
    force = force,
    raise_built = true,
  })
  if not ent then error("failed to create companion character") end

  local rec = records()[name] or {}
  records()[name] = rec
  rec.entity = ent
  rec.unit_number = ent.unit_number
  ent.color = color_for(name)
  attach_label(rec, name, ent)
  M.update_map_tag()

  return {
    name = name,
    position = { x = pos.x, y = pos.y },
    unit_number = ent.unit_number,
    already_existed = false,
  }
end

return M
