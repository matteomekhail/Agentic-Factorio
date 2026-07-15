-- Blueprint access. Three ways in, one normalized format out:
--   import_blueprint  — decode a pasted export string
--   list_blueprints   — enumerate what the player holds/carries (cursor, main
--                       inventory, blueprint books) or the companion carries
--   read_blueprint    — decode one of those by label (or the held one)
-- The game's blueprint LIBRARY window is client-side and invisible to mods:
-- prints must be in hand, in an inventory, in a book, or pasted as a string.
local companion = require("scripts.companion")

local M = {}

local MAX_ENTITIES = 200
local MAX_LISTED = 40

local function try(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

local function round1(v)
  return math.floor(v * 10 + 0.5) / 10
end

-- Normalize any holder exposing get_blueprint_entities() (LuaItemStack or
-- LuaRecord) into the shared shape: relative positions, item bill, skipped.
local function decode(holder, label)
  local ents = holder.get_blueprint_entities()
  if not ents or #ents == 0 then
    error("the blueprint is empty — no entities to build")
  end
  if #ents > MAX_ENTITIES then
    error(string.format("blueprint too big — max %d entities, this one has %d", MAX_ENTITIES, #ents))
  end

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
    label = label,
    size = { w = math.ceil(max_x) + 1, h = math.ceil(max_y) + 1 },
    entities = list,
    items_needed = needed,
    skipped = (#skipped > 0) and skipped or nil,
  }
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
    return decode(stack, try(function() return stack.label end))
  end)

  pcall(function() inv.destroy() end)
  if not ok then
    error(result, 0)
  end
  return result
end

-- ------------------------------------------------------------ enumeration

-- Every blueprint holder reachable for a player (or the companion):
-- cursor first, then main inventory, recursing one level into books.
local function collect_holders(params)
  local holders = {}
  local function add(holder, where, label)
    holders[#holders + 1] = { holder = holder, where = where, label = label }
  end

  local function scan_inventory(inv, where_prefix)
    if not inv then return end
    for i = 1, #inv do
      local stack = inv[i]
      if stack and stack.valid_for_read then
        if stack.is_blueprint then
          add(stack, where_prefix, try(function() return stack.label end))
        elseif stack.is_blueprint_book then
          local book_label = try(function() return stack.label end) or "unnamed book"
          local book_inv = try(function() return stack.get_inventory(defines.inventory.item_main) end)
          if book_inv then
            for j = 1, #book_inv do
              local page = book_inv[j]
              if page and page.valid_for_read and page.is_blueprint then
                add(page, where_prefix .. ' > book "' .. book_label .. '"',
                  try(function() return page.label end))
              end
            end
          end
        end
      end
    end
  end

  local player
  if type(params.player) == "string" and params.player ~= "" then
    player = game.get_player(params.player)
    if not (player and player.connected) then
      error("player " .. params.player .. " isn't online")
    end
  else
    player = game.connected_players[1]
  end

  if player then
    -- Held blueprint: a real item on the cursor, or a library record (2.0).
    local cur = try(function() return player.cursor_stack end)
    if cur and try(function() return cur.valid_for_read and cur.is_blueprint end) then
      add(cur, "in " .. player.name .. "'s hand", try(function() return cur.label end))
    end
    local rec = try(function() return player.cursor_record end)
    if rec and try(function() return rec.valid and rec.type == "blueprint" end) then
      add(rec, "in " .. player.name .. "'s hand (library)", try(function() return rec.label end))
    end
    scan_inventory(try(function() return player.get_main_inventory() end),
      player.name .. "'s inventory")
  end

  local c = companion.get()
  if c then
    scan_inventory(c.get_main_inventory(), companion.context() .. "'s inventory")
  end

  return holders
end

function M.list(params)
  local holders = collect_holders(params)
  local out = {}
  for i, h in ipairs(holders) do
    if i > MAX_LISTED then break end
    local count = 0
    pcall(function()
      local ents = h.holder.get_blueprint_entities()
      count = ents and #ents or 0
    end)
    out[#out + 1] = {
      label = h.label,
      where = h.where,
      entity_count = count,
    }
  end
  return {
    blueprints = out,
    note = "the game's blueprint LIBRARY window is invisible to mods — "
      .. "prints must be held on the cursor, in an inventory or in a book",
  }
end

function M.read(params)
  local holders = collect_holders(params)
  if #holders == 0 then
    error("no blueprints found — hold one on the cursor, or keep them in an inventory/book "
      .. "(the library window itself is invisible to mods); a pasted string works too (import_blueprint)")
  end

  local wanted = type(params.label) == "string" and params.label:lower() or nil
  local chosen
  if wanted then
    for _, h in ipairs(holders) do
      if h.label and h.label:lower() == wanted then chosen = h break end
    end
    if not chosen then
      for _, h in ipairs(holders) do
        if h.label and h.label:lower():find(wanted, 1, true) then chosen = h break end
      end
    end
    if not chosen then
      local names = {}
      for _, h in ipairs(holders) do names[#names + 1] = h.label or "(unnamed)" end
      error('no blueprint matching "' .. params.label .. '" — available: ' .. table.concat(names, ", "))
    end
  else
    chosen = holders[1] -- cursor first, by collection order
  end

  local result = decode(chosen.holder, chosen.label)
  result.where = chosen.where
  return result
end

return M
