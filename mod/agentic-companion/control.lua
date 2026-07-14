local state = require("scripts.state")
local rpc = require("scripts.rpc")
local chat = require("scripts.chat")
local companion = require("scripts.companion")
local tasks = require("scripts.tasks")
local perceive = require("scripts.perceive")
local inspect = require("scripts.inspect")
local research = require("scripts.research")
local walk = require("scripts.actions.walk")

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
rpc.register("start_research", research.start_research)
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
script.on_event(defines.events.on_tick, tasks.on_tick)
script.on_event(defines.events.on_script_path_request_finished, walk.on_path_finished)
