local M = {}

local COMPANION_COLOR = { r = 0.30, g = 0.79, b = 0.69, a = 1 }
local LABEL_OFFSET = { 0, -2.9 }
local MAP_TAG_MOVE_SQ = 9 -- re-pin the map marker after moving 3+ tiles

-- Floating "AI" name tag that follows the character. The render object
-- persists in the save; re-attached on respawn and self-healed periodically.
local function attach_label(ent)
  pcall(function()
    local old = storage.companion.label
    if old and old.valid then old.destroy() end
  end)
  storage.companion.label = nil
  local args = {
    text = "AI",
    surface = ent.surface,
    color = COMPANION_COLOR,
    scale = 1.4,
    alignment = "center",
    scale_with_zoom = true,
  }
  -- 2.0 target form first, 1.1-style fallback (signature drifted across versions).
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
  if ok and obj then storage.companion.label = obj end
end

-- Map/minimap marker; chart tags can't move, so re-pin when the companion
-- has wandered. Runs on_nth_tick (wired in control.lua) — must never raise.
function M.update_map_tag()
  local c = M.get()
  local tag = storage.companion.map_tag
  local tag_valid = false
  pcall(function() tag_valid = tag and tag.valid end)

  if not c then
    if tag_valid then pcall(function() tag.destroy() end) end
    storage.companion.map_tag = nil
    return
  end

  local label = storage.companion.label
  local label_valid = false
  pcall(function() label_valid = label and label.valid end)
  if not label_valid then attach_label(c) end

  if tag_valid then
    local p = tag.position
    local dx, dy = p.x - c.position.x, p.y - c.position.y
    if dx * dx + dy * dy < MAP_TAG_MOVE_SQ then return end
    pcall(function() tag.destroy() end)
  end
  storage.companion.map_tag = nil
  pcall(function()
    storage.companion.map_tag = c.force.add_chart_tag(c.surface, {
      position = c.position,
      text = "AI",
      icon = { type = "virtual", name = "signal-A" },
    })
  end)
end

-- Returns the companion character entity, or nil if it doesn't exist / died.
function M.get()
  local ent = storage.companion.entity
  if ent and ent.valid then return ent end
  return nil
end

function M.require_companion()
  local ent = M.get()
  if not ent then
    error("the companion character does not exist — call spawn_companion first")
  end
  return ent
end

function M.spawn(params)
  local existing = M.get()
  if existing then
    return {
      position = { x = existing.position.x, y = existing.position.y },
      unit_number = existing.unit_number,
      already_existed = true,
    }
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
  ent.color = COMPANION_COLOR
  storage.companion.entity = ent
  storage.companion.unit_number = ent.unit_number
  attach_label(ent)
  M.update_map_tag()

  return {
    position = { x = pos.x, y = pos.y },
    unit_number = ent.unit_number,
    already_existed = false,
  }
end

return M
