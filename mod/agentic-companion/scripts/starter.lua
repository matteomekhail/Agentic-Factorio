-- Issues the starter blueprint books (BlueprintBooks/*.txt → generated
-- scripts/starter_blueprints.lua) to the default companion. Idempotent per
-- data version: regenerating the data (npm run blueprints:build) changes the
-- content-hash version and the next ensure() swaps the old set for the new.
local data = require("scripts.starter_blueprints")

local M = {}

-- Label of the pre-book-import starter book, cleaned up on upgrade.
local LEGACY_LABEL = "Progetti AI"

local function try(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

-- Ensure `ent` (a companion character) carries the current starter books.
-- `rec` is the companion's storage record. Safe to call repeatedly (it runs
-- on a periodic tick): a failed attempt is recorded in storage and not
-- retried until the data version changes or `force` is passed (spawn path,
-- where the entity is brand new and its inventory is empty).
-- Returns true when the books are present/issued.
function M.ensure(rec, ent, force)
  if not force then
    if rec.starter_book_version == data.version then return true end
    if rec.starter_book_attempt == data.version then return false end
  end
  rec.starter_book_attempt = data.version

  if #data.books == 0 then
    rec.starter_book_version = data.version
    return true
  end

  local ok, err = pcall(function()
    local inv = ent.get_main_inventory()
    if not inv then error("the companion has no main inventory") end

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
      error("not enough free inventory slots for " .. #data.books .. " starter books")
    end

    local issued = {}
    for _, book in ipairs(data.books) do
      local slot = inv.find_empty_stack()
      if not slot then error("no free slot for starter book '" .. book.label .. "'") end
      if slot.import_stack(book.string) == -1 then
        error("import failed for starter book '" .. book.label .. "' (" .. book.source .. ")")
      end
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

  if ok then
    rec.starter_book_version = data.version
    return true
  end
  return false, err
end

return M
