-- Push events for the brain: things that happen while nobody asked (companion
-- under attack, deaths, research finished, duty supply warnings). Buffered
-- like chat; the companion app polls get_events and wakes the brain.
local companion = require("scripts.companion")

local M = {}

local MAX_EVENTS = 100
local ATTACK_THROTTLE_TICKS = 300 -- one "attacked" event per 5s

-- Lazy init guard: handlers can fire before a version-bump migration runs.
local function buffer()
  storage.events = storage.events or { list = {}, next_id = 1 }
  return storage.events
end

function M.push(kind, text, extra)
  local ev = buffer()
  local e = { id = ev.next_id, tick = game.tick, kind = kind, text = text }
  if extra then
    for k, v in pairs(extra) do e[k] = v end
  end
  ev.next_id = ev.next_id + 1
  ev.list[#ev.list + 1] = e
  if #ev.list > MAX_EVENTS then
    table.remove(ev.list, 1)
  end
end

function M.get(params)
  local since = tonumber(params.since_id) or 0
  local ev = buffer()
  local out = {}
  for _, e in ipairs(ev.list) do
    if e.id > since then
      out[#out + 1] = e
    end
  end
  return { events = out, last_id = ev.next_id - 1 }
end

-- Wired with an event filter on type "character" in control.lua.
function M.on_entity_damaged(event)
  local entity = event.entity
  if not (entity and entity.valid) then return end
  local c = companion.get()
  if not c or entity ~= c then return end
  local now = game.tick
  local ev = buffer()
  if ev.last_attack_tick and now - ev.last_attack_tick < ATTACK_THROTTLE_TICKS then
    return
  end
  ev.last_attack_tick = now
  M.push("attacked", string.format(
    "I'm being attacked! Health %d/%s at (%.1f, %.1f) — decide: fight back, flee, or call for help.",
    math.floor(entity.health or 0),
    tostring(math.floor(entity.max_health or 250)),
    c.position.x, c.position.y))
end

function M.on_entity_died(event)
  local entity = event.entity
  if not (entity and entity.valid) then return end
  local rec = storage.companion
  if not (rec and rec.entity and rec.entity.valid and entity == rec.entity) then
    -- compare by stored unit_number too: the ref may already be detached
    if not (rec and rec.unit_number and entity.unit_number == rec.unit_number) then return end
  end
  M.push("died", string.format(
    "I died at (%.1f, %.1f)! My items dropped there. Use respawn, then decide whether to recover them.",
    entity.position.x, entity.position.y))
end

function M.on_research_finished(event)
  local tech = event.research
  if not tech then return end
  local queue_len = 0
  pcall(function() queue_len = #tech.force.research_queue end)
  M.push("research_finished", string.format(
    "Research completed: %s. %s", tech.name,
    queue_len > 0 and "The queue continues." or "The research queue is now EMPTY — consider picking the next technology."))
end

return M
