local state = require("scripts.state")
local rpc = require("scripts.rpc")
local chat = require("scripts.chat")
local companion = require("scripts.companion")
local tasks = require("scripts.tasks")
local perceive = require("scripts.perceive")
local inspect = require("scripts.inspect")
local analyze = require("scripts.analyze")
local research = require("scripts.research")
local walk = require("scripts.actions.walk")
local drive = require("scripts.actions.drive")
local equipment = require("scripts.equipment")
local spatial = require("scripts.spatial")
local blueprint = require("scripts.blueprint")
local screenshot = require("scripts.screenshot")

rpc.register("ping", function()
  return {
    protocol_version = 3,
    mod_version = script.active_mods["agentic-companion"],
    factorio_version = script.active_mods["base"],
    tick = game.tick,
    companion_exists = companion.get() ~= nil,
    companion_movement_speed = companion.movement_speed_multiplier(),
  }
end)
rpc.register("spawn_companion", companion.spawn)
rpc.register("get_chat", chat.get)
rpc.register("say", chat.say)
rpc.register("get_state", perceive.get_state)
rpc.register("check_inventory", perceive.check_inventory)
rpc.register("inspect", inspect.inspect)
rpc.register("analyze_factory", analyze.analyze_factory)
rpc.register("start_research", research.start_research)
rpc.register("equip", equipment.equip)
rpc.register("scan_area", spatial.scan_area)
rpc.register("can_place", spatial.can_place)
rpc.register("find_buildable_area", spatial.find_buildable_area)
rpc.register("describe_prototype", spatial.describe_prototype)
rpc.register("import_blueprint", blueprint.import)
rpc.register("list_blueprints", blueprint.list)
rpc.register("read_blueprint", blueprint.read)
rpc.register("take_screenshot", screenshot.take)
rpc.register("exit_vehicle", drive.exit)
local trains = require("scripts.trains")
rpc.register("list_trains", trains.list_trains)
rpc.register("set_train_schedule", trains.set_train_schedule)
local events = require("scripts.events")
rpc.register("get_events", events.get)
-- starter.lua can't require scripts.events itself (require cycle via
-- companion.lua), so its failure reporting is injected here.
local starter = require("scripts.starter")
starter.notify = events.push
rpc.register("enqueue", tasks.enqueue)
rpc.register("get_task", tasks.get)
rpc.register("cancel", tasks.cancel)
-- get_chunk and echo are registered inside rpc.lua itself.

remote.add_interface("agentic", {
  rpc = function(method, params_json)
    rpc.dispatch(method, params_json)
  end,
})

local function initialize()
  state.init()
  companion.apply_movement_speed()
end

script.on_init(initialize)
script.on_configuration_changed(initialize)
script.on_event(defines.events.on_runtime_mod_setting_changed, companion.on_runtime_setting_changed)
script.on_event(defines.events.on_console_chat, chat.on_console_chat)
script.on_nth_tick(120, function()
  companion.update_map_tag()
  companion.ensure_starter_books()
end)
script.on_event(defines.events.on_tick, tasks.on_tick)
script.on_event(defines.events.on_script_path_request_finished, walk.on_path_finished)
script.on_event(defines.events.on_entity_damaged, events.on_entity_damaged,
  { { filter = "type", type = "character" } })
script.on_event(defines.events.on_entity_died, events.on_entity_died,
  { { filter = "type", type = "character" } })
script.on_event(defines.events.on_research_finished, events.on_research_finished)
