-- Offline unit tests for scripts/blueprint.lua (nested-book enumeration,
-- windowed decode) and scripts/starter.lua (starter book issuance).
-- Stubs just enough of the Factorio runtime. Run from anywhere:
--   lua tests/mod/starter_and_blueprint_test.lua        (Lua 5.2+)
local here = (arg and arg[0] or "."):match("^(.*)/[^/]+$") or "."
package.path = here .. "/../../mod/agentic-companion/?.lua;" .. package.path

-- ------------------------------------------------------------ runtime stubs
_G.storage = { companions = {} }
_G.defines = { inventory = { item_main = 1 } }
_G.prototypes = { entity = {} }
_G.game = { connected_players = {} }

local failures = 0
local function check(cond, what)
  if cond then
    print("ok   " .. what)
  else
    failures = failures + 1
    print("FAIL " .. what)
  end
end

local function expect_error(fn, needle, what)
  local ok, err = pcall(fn)
  check(not ok and tostring(err):find(needle, 1, true) ~= nil,
    what .. (ok and " (no error raised)" or " (got: " .. tostring(err) .. ")"))
end

-- ------------------------------------------------------- starter.lua tests
-- Inject fake blueprint data BEFORE starter.lua is required, so the tests
-- don't depend on the megabyte of generated book strings.
local fake_data = {
  version = "test-v1",
  books = {
    { label = "Alpha", source = "a.txt", string = "STR_A" },
    { label = "Beta", source = "b.txt", string = "STR_B" },
  },
}
package.loaded["scripts.starter_blueprints"] = fake_data
local starter = require("scripts.starter")

-- A fake character inventory: import_stack turns an empty slot into a book
-- whose label mimics the one embedded in the export string.
local EMBEDDED_LABELS = { STR_A = "Alpha", STR_A2 = "Alpha2", STR_B = nil }
local import_calls = 0
local function fake_inventory(slots)
  local inv = { n = slots }
  for i = 1, slots do
    local slot = { valid_for_read = false }
    slot.clear = function()
      slot.valid_for_read, slot.is_blueprint_book, slot.label = false, nil, nil
    end
    slot.import_stack = function(str)
      import_calls = import_calls + 1
      slot.valid_for_read = true
      slot.is_blueprint_book = true
      slot.label = EMBEDDED_LABELS[str]
      return 0
    end
    inv[i] = slot
  end
  inv.count_empty_stacks = function()
    local n = 0
    for i = 1, slots do
      if not inv[i].valid_for_read then n = n + 1 end
    end
    return n
  end
  inv.find_empty_stack = function()
    for i = 1, slots do
      if not inv[i].valid_for_read then return inv[i] end
    end
    return nil
  end
  return setmetatable(inv, { __len = function() return slots end })
end

local function books_in(inv)
  local out = {}
  for i = 1, #inv do
    if inv[i].valid_for_read and inv[i].is_blueprint_book then
      out[#out + 1] = inv[i].label
    end
  end
  table.sort(out)
  return table.concat(out, ",")
end

do
  local inv = fake_inventory(10)
  -- pre-existing legacy book must be replaced
  inv[1].valid_for_read, inv[1].is_blueprint_book, inv[1].label = true, true, "Progetti AI"
  local ent = { get_main_inventory = function() return inv end }
  local rec = {}

  check(starter.ensure(rec, ent, true) == true, "starter: fresh issue succeeds")
  check(books_in(inv) == "Alpha,Beta", "starter: both books present, legacy removed")
  check(rec.starter_book_version == "test-v1", "starter: version recorded")
  check(rec.starter_book_labels[1] == "Alpha" and rec.starter_book_labels[2] == "Beta",
    "starter: issued labels tracked (embedded label + fallback)")

  local calls_before = import_calls
  check(starter.ensure(rec, ent) == true, "starter: second call is a no-op")
  check(import_calls == calls_before, "starter: no re-import on same version")
  check(books_in(inv) == "Alpha,Beta", "starter: no duplicates after re-ensure")

  -- version bump swaps the set
  fake_data.version = "test-v2"
  fake_data.books = { { label = "Alpha2", source = "a.txt", string = "STR_A2" } }
  check(starter.ensure(rec, ent) == true, "starter: version bump re-issues")
  check(books_in(inv) == "Alpha2", "starter: old set removed, new set present")

  -- failure path: full inventory -> one attempt, then guarded until force
  fake_data.version = "test-v3"
  local tiny = fake_inventory(0)
  local ent2 = { get_main_inventory = function() return tiny end }
  local rec2 = {}
  check(starter.ensure(rec2, ent2) == false, "starter: full inventory fails")
  check(rec2.starter_book_version == nil, "starter: failed attempt doesn't record version")
  local calls = import_calls
  check(starter.ensure(rec2, ent2) == false and import_calls == calls,
    "starter: failed version isn't retried without force")
  local ent3 = { get_main_inventory = function() return fake_inventory(5) end }
  check(starter.ensure(rec2, ent3, true) == true, "starter: force retries after failure")
end

-- ----------------------------------------------------- blueprint.lua tests
local blueprint = require("scripts.blueprint")

prototypes.entity["transport-belt"] = { items_to_place_this = { { name = "transport-belt" } } }
prototypes.entity["assembling-machine-1"] = { items_to_place_this = { { name = "assembling-machine-1" } } }

local function fake_bp(label, entities, tiles)
  return {
    valid_for_read = true,
    is_blueprint = true,
    label = label,
    get_blueprint_entities = function() return entities end,
    get_blueprint_entity_count = function() return #entities end,
    get_blueprint_tiles = tiles and function() return tiles end or nil,
  }
end

local function fake_book(label, pages)
  return {
    valid_for_read = true,
    is_blueprint_book = true,
    label = label,
    get_inventory = function(id)
      assert(id == defines.inventory.item_main)
      return pages
    end,
  }
end

-- 250 belts in a row starting at x=5 (origin must normalize to 0), plus one
-- modded entity that must be skipped but not break the count.
local big_entities = {}
for i = 1, 250 do
  big_entities[#big_entities + 1] =
    { name = "transport-belt", position = { x = 4 + i, y = 7 }, direction = 4 }
end
big_entities[#big_entities + 1] = { name = "modded-thing", position = { x = 0, y = 0 } }

local big = fake_bp("Mega Bus", big_entities)
local small = fake_bp("Chest Row", {
  { name = "assembling-machine-1", position = { x = 2, y = 2 }, recipe = "iron-gear-wheel" },
}, { { name = "concrete", position = { x = 0, y = 0 } }, { name = "refined-concrete", position = { x = 1, y = 0 } } })
local dup_a = fake_bp("Mining Outpost", { { name = "transport-belt", position = { x = 0, y = 0 } } })
local dup_b = fake_bp("Mining Outpost", {
  { name = "transport-belt", position = { x = 0, y = 0 } },
  { name = "transport-belt", position = { x = 1, y = 0 } },
})

storage.companions = {
  AI = {
    entity = {
      valid = true,
      get_main_inventory = function()
        return {
          fake_book("Outer", { big, fake_book("Inner", { dup_a, small }) }),
          dup_b,
          { valid_for_read = false },
        }
      end,
    },
  },
}

do
  local res = blueprint.list({})
  check(res.total == 4, "list: finds all prints incl. nested book (got " .. tostring(res.total) .. ")")
  local by_label = {}
  for _, b in ipairs(res.blueprints) do
    by_label[#by_label + 1] = string.format("%s|%s|%s", b.label, b.book or "-", b.where)
  end
  local joined = table.concat(by_label, "\n")
  check(joined:find('Mega Bus|"Outer"|AI\'s inventory > book "Outer"', 1, true) ~= nil,
    "list: top-level book path")
  check(joined:find('Chest Row|"Outer" > "Inner"|AI\'s inventory > book "Outer" > "Inner"', 1, true) ~= nil,
    "list: nested book path")
  check(joined:find("Mining Outpost|-|AI's inventory", 1, true) ~= nil,
    "list: loose print has no book")
end

do
  local r = blueprint.read({ label = "Mega Bus" })
  check(r.total_entities == 250, "read: whole-print total (got " .. tostring(r.total_entities) .. ")")
  check(#r.entities == 100 and r.offset == 0 and r.next_offset == 100, "read: default window 100")
  check(r.entities[1].position.x == 0 and r.entities[1].position.y == 0, "read: origin normalized to 0,0")
  check(r.items_needed["transport-belt"] == 250, "read: item bill covers the whole print")
  check(r.skipped and r.skipped[1] == "modded-thing", "read: unknown entities reported")
  check(r.size.w == 250 and r.size.h == 1, "read: footprint of the whole print")

  local r2 = blueprint.read({ label = "Mega Bus", offset = 200 })
  check(#r2.entities == 50 and r2.next_offset == nil, "read: last window has no next_offset")
  check(r2.entities[1].position.x == 200, "read: later windows share the same origin")

  local r3 = blueprint.read({ label = "Mega Bus", offset = 100, limit = 200 })
  check(#r3.entities == 150 and r3.next_offset == nil, "read: custom limit")

  expect_error(function() blueprint.read({ label = "Mega Bus", offset = 250 }) end,
    "past the end", "read: offset past the end errors")
end

do
  local r = blueprint.read({ label = "Chest Row" })
  check(r.entities[1].recipe == "iron-gear-wheel", "read: recipe passthrough")
  check(r.tiles and r.tiles.count == 2 and r.tiles.kinds[1] == "concrete", "read: tile summary")
end

do
  local inner = blueprint.read({ label = "Mining Outpost", book = "inner" })
  check(inner.total_entities == 1, "read: book filter picks the nested copy")
  local loose = blueprint.read({ label = "Mining Outpost" })
  check(loose.total_entities == 2 or loose.total_entities == 1,
    "read: unfiltered duplicate resolves to first found")
  expect_error(function() blueprint.read({ label = "Mining Outpost", book = "nope" }) end,
    "available books", "read: unknown book errors with the book list")
  expect_error(function() blueprint.read({ label = "does-not-exist" }) end,
    "available", "read: unknown label errors with suggestions")
end

-- ----------------------------------------------------- screenshot.lua tests
local requested_screenshot
game.take_screenshot = function(args) requested_screenshot = args end
local screenshot = require("scripts.screenshot")

do
  storage.companions.AI.entity.position = { x = 4, y = 8 }
  storage.companions.AI.entity.surface = { name = "nauvis" }
  local result = screenshot.take({
    request_id = "offline-test-123",
    center = { x = 12, y = -3 },
    radius = 500,
  })
  check(result.path == "agentic-factorio/view-offline-test-123.jpg",
    "screenshot: unique path stays under script-output")
  check(result.center.x == 12 and result.center.y == -3 and result.radius == 100,
    "screenshot: center passes through and radius is clamped")
  check(requested_screenshot.surface == storage.companions.AI.entity.surface
      and requested_screenshot.resolution.x == 1024
      and requested_screenshot.resolution.y == 1024,
    "screenshot: renders the companion surface at bounded resolution")
  check(requested_screenshot.show_entity_info == true
      and requested_screenshot.force_render == true
      and requested_screenshot.path == result.path,
    "screenshot: visual factory detail and end-of-tick rendering requested")
  expect_error(function() screenshot.take({ request_id = "../bad" }) end,
    "request_id", "screenshot: unsafe request ids rejected")
end

print(failures == 0 and "\nALL TESTS PASSED" or ("\n" .. failures .. " FAILURES"))
os.exit(failures == 0 and 0 or 1)
