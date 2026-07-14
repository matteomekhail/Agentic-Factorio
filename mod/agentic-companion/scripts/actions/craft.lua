-- craft: hand-crafting via the character crafting queue. begin_crafting
-- returns how many it actually started; the queue progresses on a detached
-- character and is polled via crafting_queue_size.
local companion = require("scripts.companion")

local M = {}

local POLL_TICKS = 30
local MAX_COUNT = 100

-- What's short for `count` crafts, e.g. "2x iron-plate, 1x iron-gear-wheel".
-- Must run BEFORE begin_crafting consumes the ingredients.
local function missing_ingredients(c, recipe, count)
  local parts = {}
  for _, ing in ipairs(recipe.ingredients or {}) do
    if ing.type == "item" then
      local have = c.get_item_count(ing.name)
      local need = ing.amount * count
      if have < need then
        parts[#parts + 1] = string.format("%dx %s", need - have, ing.name)
      end
    end
  end
  return table.concat(parts, ", ")
end

function M.start(task)
  local c = companion.require_companion()
  if type(task.recipe) ~= "string" then
    error("craft requires recipe = <recipe name>")
  end
  local count = math.floor(tonumber(task.count) or 1)
  if count < 1 then count = 1 end
  if count > MAX_COUNT then count = MAX_COUNT end
  task.count = count

  local r = c.force.recipes[task.recipe]
  if not r then
    error("unknown recipe: '" .. task.recipe .. "'")
  end
  if not r.enabled then
    error("recipe " .. task.recipe .. " isn't unlocked yet — research it first")
  end

  local product_names, before = {}, {}
  for _, p in ipairs(r.products or {}) do
    if p.type == "item" then
      product_names[#product_names + 1] = p.name
      before[p.name] = c.get_item_count(p.name)
    end
  end

  local missing = missing_ingredients(c, r, count)
  local started = c.begin_crafting({ count = count, recipe = task.recipe })
  if started == 0 then
    if missing ~= "" then
      error("can't craft " .. task.recipe .. " — missing ingredients: " .. missing)
    end
    error("can't craft " .. task.recipe .. " — this recipe can't be crafted by hand")
  end

  local note = ""
  if started < count then
    note = string.format(" (only started %d of %d — missing ingredients: %s)",
      started, count, missing ~= "" and missing or "not enough materials")
  end
  task._craft = {
    started = started,
    note = note,
    product_names = product_names,
    products_before = before,
    next_poll = game.tick + POLL_TICKS,
  }
end

function M.tick(task)
  local c = companion.get()
  if not c then
    return { status = "failed", detail = "the companion character is gone" }
  end
  local s = task._craft
  if game.tick < s.next_poll then return nil end
  s.next_poll = game.tick + POLL_TICKS
  if c.crafting_queue_size > 0 then return nil end

  local parts = {}
  for _, name in ipairs(s.product_names) do
    local gained = c.get_item_count(name) - s.products_before[name]
    if gained > 0 then
      parts[#parts + 1] = string.format("+%d %s", gained, name)
    end
  end
  return {
    status = "done",
    detail = string.format("crafted %dx %s%s%s", s.started, task.recipe,
      #parts > 0 and (" (" .. table.concat(parts, ", ") .. ")") or "", s.note),
  }
end

return M
