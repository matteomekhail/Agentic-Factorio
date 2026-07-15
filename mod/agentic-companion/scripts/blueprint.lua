-- Blueprint access. Three ways in, one normalized format out:
--   import_blueprint  — decode a pasted export string
--   list_blueprints   — enumerate what the player holds/carries (cursor, main
--                       inventory, blueprint books — nested books included)
--                       or what a companion carries (the default companion
--                       spawns with the starter books, see scripts/starter.lua)
--   read_blueprint    — decode one of those by label (or the held one)
-- Huge prints are read in windows (offset/limit) sized for build_plan batches;
-- the item bill and footprint always cover the whole print.
-- The game's blueprint LIBRARY window is client-side and invisible to mods:
-- prints must be in hand, in an inventory, in a book, or pasted as a string.
local companion = require("scripts.companion")

local M = {}

local DEFAULT_WINDOW = 100 -- one build_plan batch
local MAX_WINDOW = 200
local MAX_LISTED = 200
local MAX_BOOK_DEPTH = 4
local MAX_LABELS_IN_ERROR = 40

local function try(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

local function round1(v)
  return math.floor(v * 10 + 0.5) / 10
end

-- Normalize any holder exposing get_blueprint_entities() (LuaItemStack or
-- LuaRecord) into the shared shape: positions RELATIVE to the whole print's
-- top-left entity, the whole print's item bill, size and skipped names, plus
-- ONE window of entities (offset/limit) so huge prints are read in batches.
-- The origin never moves with the window, so every batch shares one anchor.
local function decode(holder, label, offset, limit)
  local ents = holder.get_blueprint_entities()
  if not ents or #ents == 0 then
    error("the blueprint is empty — no entities to build")
  end

  offset = math.max(math.floor(tonumber(offset) or 0), 0)
  limit = math.floor(tonumber(limit) or DEFAULT_WINDOW)
  limit = math.max(1, math.min(limit, MAX_WINDOW))

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

  local window, needed, skipped_set = {}, {}, {}
  local max_x, max_y = 0, 0
  local total = 0
  for _, e in ipairs(ents) do
    local proto = prototypes.entity[e.name]
    if not proto then
      skipped_set[e.name] = true
    else
      total = total + 1
      local pos = { x = round1(e.position.x - min_x), y = round1(e.position.y - min_y) }
      max_x = math.max(max_x, pos.x)
      max_y = math.max(max_y, pos.y)
      local place_items = try(function() return proto.items_to_place_this end)
      local item_name = (place_items and place_items[1] and place_items[1].name) or e.name
      needed[item_name] = (needed[item_name] or 0) + 1
      if total > offset and #window < limit then
        window[#window + 1] = {
          name = e.name,
          position = pos,
          direction = e.direction or 0,
          recipe = e.recipe,
        }
      end
    end
  end

  if offset >= total then
    error(string.format("offset %d is past the end — the blueprint has %d entities", offset, total))
  end

  local skipped = {}
  for name in pairs(skipped_set) do
    skipped[#skipped + 1] = name
  end

  -- Flooring (concrete/landfill) the companion has no tool to place — report
  -- it so the brain knows the print expects prepared ground.
  local tiles
  local bp_tiles = try(function() return holder.get_blueprint_tiles() end)
  if bp_tiles and #bp_tiles > 0 then
    local kinds_set, kinds = {}, {}
    for _, t in ipairs(bp_tiles) do kinds_set[t.name] = true end
    for name in pairs(kinds_set) do kinds[#kinds + 1] = name end
    table.sort(kinds)
    tiles = { count = #bp_tiles, kinds = kinds }
  end

  local next_offset = offset + #window
  return {
    label = label,
    size = { w = math.ceil(max_x) + 1, h = math.ceil(max_y) + 1 },
    total_entities = total,
    offset = offset,
    entities = window,
    next_offset = (next_offset < total) and next_offset or nil,
    items_needed = needed, -- whole print, not just this window
    skipped = (#skipped > 0) and skipped or nil,
    tiles = tiles,
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
    return decode(stack, try(function() return stack.label end), params.offset, params.limit)
  end)

  pcall(function() inv.destroy() end)
  if not ok then
    error(result, 0)
  end
  return result
end

-- ------------------------------------------------------------ enumeration

-- Every blueprint holder reachable for a player (or a companion): cursor
-- first, then main inventories, recursing into blueprint books (books nest —
-- a page can be another book, so track the full path).
local function collect_holders(params)
  local holders = {}
  local function add(holder, where, book, label)
    holders[#holders + 1] = { holder = holder, where = where, book = book, label = label }
  end

  local function scan_book(stack, where_prefix, path, depth)
    if depth > MAX_BOOK_DEPTH then return end
    local book_label = try(function() return stack.label end) or "unnamed book"
    local book_path = path and (path .. ' > "' .. book_label .. '"') or ('"' .. book_label .. '"')
    local book_inv = try(function() return stack.get_inventory(defines.inventory.item_main) end)
    if not book_inv then return end
    for j = 1, #book_inv do
      local page = book_inv[j]
      if page and page.valid_for_read then
        if page.is_blueprint then
          add(page, where_prefix .. " > book " .. book_path, book_path,
            try(function() return page.label end))
        elseif page.is_blueprint_book then
          scan_book(page, where_prefix, book_path, depth + 1)
        end
      end
    end
  end

  local function scan_inventory(inv, where_prefix)
    if not inv then return end
    for i = 1, #inv do
      local stack = inv[i]
      if stack and stack.valid_for_read then
        if stack.is_blueprint then
          add(stack, where_prefix, nil, try(function() return stack.label end))
        elseif stack.is_blueprint_book then
          scan_book(stack, where_prefix, nil, 1)
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
      add(cur, "in " .. player.name .. "'s hand", nil, try(function() return cur.label end))
    end
    local rec = try(function() return player.cursor_record end)
    if rec and try(function() return rec.valid and rec.type == "blueprint" end) then
      add(rec, "in " .. player.name .. "'s hand (library)", nil, try(function() return rec.label end))
    end
    scan_inventory(try(function() return player.get_main_inventory() end),
      player.name .. "'s inventory")
  end

  -- Every companion's inventory (the default one carries the starter books).
  for _, name in ipairs(companion.names()) do
    local c = companion.get(name)
    if c then
      scan_inventory(c.get_main_inventory(), name .. "'s inventory")
    end
  end

  return holders
end

-- Cheap entity count: prefer the dedicated counter over decoding the print.
local function entity_count_of(holder)
  local n = try(function() return holder.get_blueprint_entity_count() end)
  if n then return n end
  return try(function()
    local ents = holder.get_blueprint_entities()
    return ents and #ents or 0
  end) or 0
end

-- Bounded label list for error messages.
local function label_list(holders)
  local names = {}
  for i, h in ipairs(holders) do
    if i > MAX_LABELS_IN_ERROR then
      names[#names + 1] = string.format("… and %d more", #holders - MAX_LABELS_IN_ERROR)
      break
    end
    names[#names + 1] = h.label or "(unnamed)"
  end
  return table.concat(names, ", ")
end

function M.list(params)
  local holders = collect_holders(params)
  local out = {}
  for i, h in ipairs(holders) do
    if i > MAX_LISTED then break end
    out[#out + 1] = {
      label = h.label,
      where = h.where,
      book = h.book,
      entity_count = entity_count_of(h.holder),
    }
  end
  return {
    blueprints = out,
    total = #holders,
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

  -- Optional book filter first: disambiguates duplicate labels across books.
  if type(params.book) == "string" and params.book ~= "" then
    local wanted_book = params.book:lower()
    local filtered = {}
    for _, h in ipairs(holders) do
      if h.book and h.book:lower():find(wanted_book, 1, true) then
        filtered[#filtered + 1] = h
      end
    end
    if #filtered == 0 then
      local seen, books = {}, {}
      for _, h in ipairs(holders) do
        if h.book and not seen[h.book] then
          seen[h.book] = true
          books[#books + 1] = h.book
        end
      end
      error('no book matching "' .. params.book .. '" — available books: '
        .. (#books > 0 and table.concat(books, ", ") or "(none)"))
    end
    holders = filtered
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
      error('no blueprint matching "' .. params.label .. '" — available: ' .. label_list(holders))
    end
  else
    chosen = holders[1] -- cursor first, by collection order
  end

  local result = decode(chosen.holder, chosen.label, params.offset, params.limit)
  result.where = chosen.where
  result.book = chosen.book
  return result
end

return M
