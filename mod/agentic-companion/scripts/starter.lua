-- Issues the starter blueprint books (BlueprintBooks/*.txt → generated
-- scripts/starter_blueprints.lua) to the default companion. Idempotent per
-- data version: regenerating the data (npm run blueprints:build) changes the
-- content-hash version and the next ensure() swaps the old set for the new.
--
-- Failure handling: the new set is imported into a SCRATCH inventory first,
-- so the companion's current books are only touched once every new book has
-- decoded cleanly. A failed attempt is retried every RETRY_TICKS (transient
-- causes like a full inventory heal themselves) and reported once per data
-- version through M.notify (wired to events.push by control.lua — starter
-- can't require scripts.events itself: require cycle via companion.lua).
local data = require("scripts.starter_blueprints")

local M = {}

-- Label of the pre-book-import starter book, cleaned up on upgrade.
local LEGACY_LABEL = "Progetti AI"
local RETRY_TICKS = 60 * 120 -- 2 minutes between attempts of a failing version

-- Failure sink: function(kind, text) — injected by control.lua.
M.notify = nil

local function try(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

-- Ensure `ent` (a companion character) carries the current starter books.
-- `rec` is the companion's storage record. Safe to call repeatedly (it runs
-- on a periodic tick). `force` (spawn path, where the body is brand new and
-- its inventory is empty) bypasses the version check and the retry backoff.
-- Returns true when the books are present/issued.
function M.ensure(rec, ent, force)
  if not force then
    if rec.starter_book_version == data.version then return true end
    local att = rec.starter_book_attempt
    if type(att) == "table" and att.version == data.version
      and game.tick - att.tick < RETRY_TICKS then
      return false
    end
  end
  rec.starter_book_attempt = { version = data.version, tick = game.tick }

  if #data.books == 0 then
    rec.starter_book_version = data.version
    return true
  end

  local scratch
  local ok, err = pcall(function()
    local inv = ent.get_main_inventory()
    if not inv then error("the companion has no main inventory", 0) end

    -- Decode the whole new set into a scratch inventory FIRST; the
    -- companion's current books are only touched after this succeeds.
    scratch = game.create_inventory(#data.books)
    for i, book in ipairs(data.books) do
      -- import_stack: 0 = ok, -1 = ok with errors (e.g. content from mods
      -- not present here — the book still imports), 1 = failed outright.
      if scratch[i].import_stack(book.string) == 1 then
        error("import failed for starter book '" .. book.label
          .. "' (" .. book.source .. ")", 0)
      end
      if not scratch[i].valid_for_read then
        error("import produced nothing for starter book '" .. book.label .. "'", 0)
      end
    end

    -- Remove every book we issued before (tracked labels + current labels,
    -- so a re-run never duplicates), plus the legacy single starter book.
    local stale = { [LEGACY_LABEL] = true }
    for _, label in ipairs(rec.starter_book_labels or {}) do stale[label] = true end
    for _, book in ipairs(data.books) do stale[book.label] = true end
    for i = 1, #inv do
      local stack = inv[i]
      if stack.valid_for_read and stack.is_blueprint_book then
        local label = try(function() return stack.label end)
        if label and stale[label] then stack.clear() end
      end
    end

    if inv.count_empty_stacks() < #data.books then
      error("not enough free inventory slots for " .. #data.books
        .. " starter books", 0)
    end

    local issued = {}
    for i, book in ipairs(data.books) do
      local slot = inv.find_empty_stack()
      if not slot then
        error("no free slot for starter book '" .. book.label .. "'", 0)
      end
      slot.set_stack(scratch[i])
      -- The export string carries its own label; enforce ours as a fallback
      -- so the book stays identifiable for the next version swap.
      local label = try(function() return slot.label end)
      if not label or label == "" then
        slot.label = book.label
        label = book.label
      end
      issued[#issued + 1] = label
    end
    rec.starter_book_labels = issued
  end)

  if scratch then pcall(function() scratch.destroy() end) end

  if ok then
    rec.starter_book_version = data.version
    rec.starter_book_attempt = nil
    return true
  end

  -- Say it once per data version; the periodic caller keeps retrying quietly.
  if rec.starter_book_warned ~= data.version then
    rec.starter_book_warned = data.version
    local text = "Couldn't hand the starter blueprint books to the companion ("
      .. tostring(err) .. ") — retrying every couple of minutes. "
      .. "Freeing inventory space usually fixes this."
    if M.notify then pcall(M.notify, "starter_books", text) end
    pcall(function() log("[agentic-companion] " .. text) end)
  end
  return false, err
end

return M
