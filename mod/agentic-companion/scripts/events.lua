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

-- Which of our companions (if any) is this character entity?
local function companion_name_of(entity)
  for name, rec in pairs(storage.companions or {}) do
    if rec.entity and rec.entity.valid and rec.entity == entity then
      return name
    end
    if rec.unit_number and entity.unit_number == rec.unit_number then
      return name
    end
  end
  return nil
end

-- Wired with an event filter on type "character" in control.lua.
function M.on_entity_damaged(event)
  local entity = event.entity
  if not (entity and entity.valid) then return end
  local name = companion_name_of(entity)
  if not name then return end
  local now = game.tick
  local ev = buffer()
  ev.last_attack_tick_by = ev.last_attack_tick_by or {}
  local last = ev.last_attack_tick_by[name]
  if last and now - last < ATTACK_THROTTLE_TICKS then
    return
  end
  ev.last_attack_tick_by[name] = now
  M.push("attacked", string.format(
    "%s is being attacked! Health %d/%s at (%.1f, %.1f) — decide: fight back, flee, or send help.",
    name,
    math.floor(entity.health or 0),
    tostring(math.floor(entity.max_health or 250)),
    entity.position.x, entity.position.y), { companion = name })
end

function M.on_entity_died(event)
  local entity = event.entity
  if not (entity and entity.valid) then return end
  local name = companion_name_of(entity)
  if not name then return end
  M.push("died", string.format(
    '%s died at (%.1f, %.1f)! Their items dropped there. Respawn with {"name":"%s"}, then decide whether to recover them.',
    name, entity.position.x, entity.position.y, name), { companion = name })
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
