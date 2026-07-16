-- Offline tests for build_plan's automatic preparation of placeable items.
local here = (arg and arg[0] or "."):match("^(.*)/[^/]+$") or "."
package.path = here .. "/../../mod/agentic-companion/?.lua;" .. package.path

local failures = 0
local function check(cond, what)
  if cond then print("ok   " .. what) else failures = failures + 1 print("FAIL " .. what) end
end

local crafted = {}
local inventory = { ["transport-belt"] = 1 }
local character
character = {
  crafting_queue_size = 0,
  force = { recipes = {
    ["transport-belt"] = { name = "transport-belt", enabled = true },
    ["burner-mining-drill"] = { name = "burner-mining-drill", enabled = true },
  } },
  get_item_count = function(name) return inventory[name] or 0 end,
  begin_crafting = function(args)
    crafted[args.recipe] = args.count
    character.crafting_queue_size = character.crafting_queue_size + args.count
    return args.count
  end,
}

package.loaded["scripts.companion"] = {
  require_companion = function() return character end,
  get = function() return character end,
}
package.loaded["scripts.actions.approach"] = { ensure = function() return nil end }
_G.prototypes = { item = {} }

local build_plan = require("scripts.actions.build_plan")
local task = { steps = {
  { item = "transport-belt", position = { x = 0, y = 0 } },
  { item = "transport-belt", position = { x = 1, y = 0 } },
  { item = "transport-belt", position = { x = 2, y = 0 } },
  { item = "burner-mining-drill", position = { x = 3, y = 0 } },
} }
build_plan.start(task)
check(crafted["transport-belt"] == 2 and crafted["burner-mining-drill"] == 1,
  "build_plan: crafts exactly the missing placeable items")
check(task._waiting_for_crafts == true and task._auto_crafted == 3,
  "build_plan: construction waits for its preparation queue")

crafted = {}
character.crafting_queue_size = 0
build_plan.start({ auto_craft = false, steps = {
  { item = "transport-belt", position = { x = 0, y = 0 } },
  { item = "transport-belt", position = { x = 1, y = 0 } },
} })
check(next(crafted) == nil, "build_plan: auto-crafting can be disabled")

print(failures == 0 and "\nALL TESTS PASSED" or ("\n" .. failures .. " FAILURES"))
os.exit(failures == 0 and 0 or 1)
