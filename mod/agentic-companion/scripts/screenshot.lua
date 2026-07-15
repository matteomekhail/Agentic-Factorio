-- Visual perception: ask Factorio's renderer for a map screenshot. The image
-- itself is written under script-output; the companion app waits for it and
-- returns it to the model as multimodal tool content.
local companion = require("scripts.companion")

local M = {}

local MIN_RADIUS = 10
local MAX_RADIUS = 100
local RESOLUTION = 1024

local function finite_number(value, label)
  local n = tonumber(value)
  if not n or n ~= n or n == math.huge or n == -math.huge then
    error(label .. " must be a finite number")
  end
  return n
end

function M.take(params)
  local ent = companion.require_companion()
  local radius = math.max(MIN_RADIUS, math.min(MAX_RADIUS,
    finite_number(params.radius or 45, "radius")))

  local center = ent.position
  if params.center ~= nil then
    if type(params.center) ~= "table" then error("center must be an {x,y} object") end
    center = {
      x = finite_number(params.center.x, "center.x"),
      y = finite_number(params.center.y, "center.y"),
    }
  end

  -- The app supplies a random id, preventing a restored save at the same tick
  -- from accidentally returning an old file before the new render completes.
  local request_id = tostring(params.request_id or "")
  if #request_id < 8 or #request_id > 64 or not request_id:match("^[%w%-]+$") then
    error("request_id must be 8-64 letters, digits or hyphens")
  end
  local path = "agentic-factorio/view-" .. request_id .. ".jpg"
  local zoom = RESOLUTION / (radius * 2 * 32)

  game.take_screenshot({
    surface = ent.surface,
    position = center,
    resolution = { x = RESOLUTION, y = RESOLUTION },
    zoom = zoom,
    path = path,
    quality = 85,
    show_gui = false,
    show_entity_info = true,
    hide_clouds = true,
    force_render = true,
  })

  return {
    path = path,
    center = { x = center.x, y = center.y },
    radius = radius,
    resolution = { w = RESOLUTION, h = RESOLUTION },
  }
end

return M
