-- Shared "walk within reach first" phase for every action task with a map
-- target (see docs/PROTOCOL.md "Tasks"). Sub-state lives under task._approach.
local walk = require("scripts.actions.walk")

local M = {}

local function dist_sq(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return dx * dx + dy * dy
end

-- Call every tick before acting on target_pos. Returns "ok" once within
-- `reach` tiles, nil while still walking, or {status="failed", detail=...}.
function M.ensure(task, c, target_pos, reach)
  if dist_sq(c.position, target_pos) <= reach * reach then
    if task._approach then
      task._approach = nil
      c.walking_state = { walking = false }
    end
    return "ok"
  end

  local a = task._approach
  if not a or a.target.x ~= target_pos.x or a.target.y ~= target_pos.y then
    a = { target = { x = target_pos.x, y = target_pos.y }, walk = {} }
    task._approach = a
    walk.begin(a.walk, c, a.target, math.max(reach - 0.5, 0.5))
  end

  local r = walk.step(a.walk, c, task.id)
  if r == "arrived" then
    task._approach = nil
    return "ok"
  elseif type(r) == "table" then
    task._approach = nil
    return { status = "failed", detail = "couldn't get in range: " .. r.failed }
  end
  return nil
end

-- Nearest operable entity around a target position (for insert/extract/
-- rotate/set_recipe). Skips the companion itself and things those actions
-- never apply to.
local SKIP_TYPES = { character = true, resource = true, tree = true, ["item-entity"] = true }

function M.find_entity_near(c, pos, radius)
  local candidates = c.surface.find_entities_filtered({ position = pos, radius = radius or 1.5 })
  local best, best_d
  for _, e in ipairs(candidates) do
    if e.valid and e ~= c and not SKIP_TYPES[e.type] then
      local d = dist_sq(e.position, pos)
      if not best or d < best_d then
        best, best_d = e, d
      end
    end
  end
  return best
end

return M
