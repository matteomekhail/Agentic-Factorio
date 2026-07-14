-- import_blueprint: decode a blueprint export string into a normalized entity
-- list the model can offset and feed to build_plan. Does NOT build anything.
local M = {}

local MAX_ENTITIES = 200

local function try(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

local function round1(v)
  return math.floor(v * 10 + 0.5) / 10
end

function M.import(params)
  if type(params.string) ~= "string" or #params.string < 10 then
    error("import_blueprint needs string = <blueprint export string> (starts with 0eNq...)")
  end

  local inv = game.create_inventory(1)
  local ok, result = pcall(function()
    local stack = inv[1]
    local import_result = stack.import_stack(params.string)
    if import_result == -1 then
      error("that string isn't a valid blueprint export — copy it again from the blueprint's Export button")
    end
    if stack.is_blueprint_book then
      error("that's a blueprint BOOK — open it and send me a single blueprint from inside")
    end
    if not stack.is_blueprint then
      error("that string decodes to '" .. (try(function() return stack.name end) or "?")
        .. "', not a blueprint")
    end
    local ents = stack.get_blueprint_entities()
    if not ents or #ents == 0 then
      error("the blueprint is empty — no entities to build")
    end
    if #ents > MAX_ENTITIES then
      error(string.format("blueprint too big — max %d entities, this one has %d", MAX_ENTITIES, #ents))
    end

    -- Normalize positions so the top-left known entity sits at (0,0).
    local min_x, min_y = math.huge, math.huge
    for _, e in ipairs(ents) do
      if prototypes.entity[e.name] then
        min_x = math.min(min_x, e.position.x)
        min_y = math.min(min_y, e.position.y)
      end
    end
    if min_x == math.huge then
      error("none of the blueprint's entities exist in this game (modded blueprint?)")
    end

    local list, needed, skipped_set = {}, {}, {}
    local max_x, max_y = 0, 0
    for _, e in ipairs(ents) do
      local proto = prototypes.entity[e.name]
      if not proto then
        skipped_set[e.name] = true
      else
        local pos = { x = round1(e.position.x - min_x), y = round1(e.position.y - min_y) }
        list[#list + 1] = {
          name = e.name,
          position = pos,
          direction = e.direction or 0,
          recipe = e.recipe,
        }
        max_x = math.max(max_x, pos.x)
        max_y = math.max(max_y, pos.y)
        local place_items = try(function() return proto.items_to_place_this end)
        local item_name = (place_items and place_items[1] and place_items[1].name) or e.name
        needed[item_name] = (needed[item_name] or 0) + 1
      end
    end

    local skipped = {}
    for name in pairs(skipped_set) do
      skipped[#skipped + 1] = name
    end

    return {
      label = try(function() return stack.label end),
      size = { w = math.ceil(max_x) + 1, h = math.ceil(max_y) + 1 },
      entities = list,
      items_needed = needed,
      skipped = (#skipped > 0) and skipped or nil,
    }
  end)

  pcall(function() inv.destroy() end)
  if not ok then
    error(result, 0)
  end
  return result
end

return M
