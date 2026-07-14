local M = {}

local MAX_MESSAGES = 200

function M.on_console_chat(event)
  if not event.player_index then return end
  local player = game.get_player(event.player_index)
  if not player then return end
  local chat = storage.chat
  chat.messages[#chat.messages + 1] = {
    id = chat.next_id,
    tick = event.tick,
    player = player.name,
    text = event.message,
  }
  chat.next_id = chat.next_id + 1
  if #chat.messages > MAX_MESSAGES then
    table.remove(chat.messages, 1)
  end
end

function M.get(params)
  local since = tonumber(params.since_id) or 0
  local out = {}
  for _, m in ipairs(storage.chat.messages) do
    if m.id > since then
      out[#out + 1] = m
    end
  end
  return { messages = out, last_id = storage.chat.next_id - 1 }
end

function M.say(params)
  if type(params.text) ~= "string" or params.text == "" then
    error("say requires text")
  end
  game.print("[color=#4EC9B0][AI][/color] " .. params.text)
  return {}
end

return M
