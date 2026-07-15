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
local equipment = require("scripts.equipment")
local spatial = require("scripts.spatial")
local blueprint = require("scripts.blueprint")

rpc.register("ping", function()
  return {
    mod_version = script.active_mods["agentic-companion"],
    factorio_version = script.active_mods["base"],
    tick = game.tick,
    companion_exists = companion.get() ~= nil,
  }
end)
rpc.register("spawn_companion", companion.spawn)
rpc.register("get_chat", chat.get)
rpc.register("say", chat.say)
rpc.register("get_state", perceive.get_state)
rpc.register("inspect", inspect.inspect)
rpc.register("analyze_factory", analyze.analyze_factory)
rpc.register("start_research", research.start_research)
rpc.register("equip", equipment.equip)
rpc.register("scan_area", spatial.scan_area)
rpc.register("can_place", spatial.can_place)
rpc.register("find_buildable_area", spatial.find_buildable_area)
rpc.register("describe_prototype", spatial.describe_prototype)
rpc.register("import_blueprint", blueprint.import)
rpc.register("enqueue", tasks.enqueue)
rpc.register("get_task", tasks.get)
rpc.register("cancel", tasks.cancel)
-- get_chunk and echo are registered inside rpc.lua itself.

remote.add_interface("agentic", {
  rpc = function(method, params_json)
    rpc.dispatch(method, params_json)
  end,
})

script.on_init(state.init)
script.on_configuration_changed(state.init)
script.on_event(defines.events.on_console_chat, chat.on_console_chat)
script.on_nth_tick(120, companion.update_map_tag)
script.on_event(defines.events.on_tick, tasks.on_tick)
script.on_event(defines.events.on_script_path_request_finished, walk.on_path_finished)
