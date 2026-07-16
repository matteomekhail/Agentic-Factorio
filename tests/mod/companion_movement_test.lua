-- Offline tests for per-companion movement speed configuration.
local here = (arg and arg[0] or "."):match("^(.*)/[^/]+$") or "."
package.path = here .. "/../../mod/agentic-companion/?.lua;" .. package.path

local failures = 0
local function check(cond, what)
  if cond then print("ok   " .. what) else failures = failures + 1 print("FAIL " .. what) end
end
local function near(a, b)
  return math.abs(a - b) < 0.000001
end

package.loaded["scripts.starter"] = { ensure = function() end }
_G.storage = { companions = {} }
_G.settings = nil

local companion = require("scripts.companion")

check(companion.movement_speed_multiplier() == 1.6,
  "movement: default multiplier is 1.6x")

settings = { global = { ["agentic-companion-movement-speed"] = { value = 2.25 } } }
check(companion.movement_speed_multiplier() == 2.25,
  "movement: runtime-global setting is read")

local ai = { valid = true }
local scout = { valid = true }
storage.companions = {
  AI = { entity = ai },
  Scout = { entity = scout },
  Gone = { entity = { valid = false } },
}
companion.apply_movement_speed()
check(ai.character_running_speed_modifier == 1.25
    and scout.character_running_speed_modifier == 1.25,
  "movement: bonus is applied independently to every live companion")

settings.global["agentic-companion-movement-speed"].value = 1.4
companion.on_runtime_setting_changed({ setting = "unrelated-setting" })
check(ai.character_running_speed_modifier == 1.25,
  "movement: unrelated setting changes are ignored")
companion.on_runtime_setting_changed({ setting = "agentic-companion-movement-speed" })
check(near(ai.character_running_speed_modifier, 0.4)
    and near(scout.character_running_speed_modifier, 0.4),
  "movement: live setting changes update existing companions")

print(failures == 0 and "\nALL TESTS PASSED" or ("\n" .. failures .. " FAILURES"))
os.exit(failures == 0 and 0 or 1)
