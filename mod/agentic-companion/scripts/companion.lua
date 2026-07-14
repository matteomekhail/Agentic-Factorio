local M = {}

local COMPANION_COLOR = { r = 0.30, g = 0.79, b = 0.69, a = 1 }

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

  return {
    position = { x = pos.x, y = pos.y },
    unit_number = ent.unit_number,
    already_existed = false,
  }
end

return M
