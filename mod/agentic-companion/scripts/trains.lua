-- Train management: list_trains (fleet overview) and set_train_schedule.
-- Building rails/stops/locomotives goes through the normal build tools;
-- these methods handle what placement can't — schedules and dispatch.
local companion = require("scripts.companion")

local M = {}

local MAX_TRAINS = 20

local function surface_of()
  local c = companion.get()
  if c then return c.surface end
  local p = game.connected_players[1]
  if p then return p.surface end
  return game.surfaces[1]
end

local function train_state_name(state)
  for name, value in pairs(defines.train_state) do
    if value == state then return name end
  end
  return tostring(state)
end

local function find_train(surface, id)
  for _, t in ipairs(game.train_manager.get_trains({ surface = surface })) do
    if t.id == id then return t end
  end
  return nil
end

local function station_names(surface)
  local names, seen = {}, {}
  for _, stop in ipairs(surface.find_entities_filtered({ type = "train-stop" })) do
    if stop.valid and not seen[stop.backer_name] then
      seen[stop.backer_name] = true
      names[#names + 1] = stop.backer_name
    end
  end
  table.sort(names)
  return names, seen
end

function M.list_trains(_)
  local surface = surface_of()
  local out = {}
  for _, t in ipairs(game.train_manager.get_trains({ surface = surface })) do
    if #out >= MAX_TRAINS then break end
    local entry = {
      id = t.id,
      state = train_state_name(t.state),
      manual = t.manual_mode,
    }
    pcall(function()
      local locos, wagons = 0, 0
      for _, carriage in ipairs(t.carriages) do
        if carriage.type == "locomotive" then locos = locos + 1 else wagons = wagons + 1 end
      end
      entry.locomotives, entry.wagons = locos, wagons
      local front = t.carriages[1]
      if front then
        entry.position = {
          x = math.floor(front.position.x * 2 + 0.5) / 2,
          y = math.floor(front.position.y * 2 + 0.5) / 2,
        }
      end
    end)
    pcall(function()
      if t.station then entry.at_station = t.station.backer_name end
    end)
    pcall(function()
      local sched = t.schedule
      if sched and sched.records and #sched.records > 0 then
        local stops = {}
        for _, rec in ipairs(sched.records) do
          stops[#stops + 1] = rec.station or "(coordinates)"
        end
        entry.schedule = stops
        entry.next_stop = sched.records[sched.current] and sched.records[sched.current].station or nil
      end
    end)
    pcall(function()
      local cargo = {}
      for _, item in ipairs(t.get_contents()) do
        cargo[item.name] = (cargo[item.name] or 0) + item.count
      end
      if next(cargo) ~= nil then entry.cargo = cargo end
    end)
    out[#out + 1] = entry
  end
  local names = station_names(surface)
  return { trains = out, stations = names }
end

function M.set_train_schedule(params)
  local id = tonumber(params.train_id)
  if not id then
    error("set_train_schedule needs train_id — call list_trains first")
  end
  local stops = params.stops
  if type(stops) ~= "table" or #stops == 0 then
    error('set_train_schedule needs stops = [{"station":"Name","wait":"full"|"empty"|<seconds>}]')
  end

  local surface = surface_of()
  local train = find_train(surface, id)
  if not train then
    error("no train with id " .. id .. " here — check list_trains")
  end
  local _, known = station_names(surface)

  local records = {}
  for i, s in ipairs(stops) do
    if type(s) ~= "table" or type(s.station) ~= "string" then
      error("stop " .. i .. " is malformed — each stop needs a station name")
    end
    if not known[s.station] then
      error('no train stop called "' .. s.station
        .. '" on this surface — build one first or check the exact name (case matters)')
    end
    local wait = s.wait
    local conditions
    if wait == "full" then
      conditions = { { type = "full", compare_type = "or" } }
    elseif wait == "empty" then
      conditions = { { type = "empty", compare_type = "or" } }
    elseif type(wait) == "number" and wait > 0 then
      conditions = { { type = "time", compare_type = "or", ticks = math.floor(wait * 60) } }
    elseif wait == nil then
      conditions = { { type = "time", compare_type = "or", ticks = 5 * 60 } }
    else
      error('stop ' .. i .. ' wait must be "full", "empty" or a number of seconds')
    end
    records[#records + 1] = { station = s.station, wait_conditions = conditions }
  end

  train.schedule = { current = 1, records = records }
  train.manual_mode = false

  -- Warn about the classic gotcha: a schedule without fuel goes nowhere.
  local fueled = false
  pcall(function()
    for _, carriage in ipairs(train.carriages) do
      if carriage.type == "locomotive" then
        local burner = carriage.burner
        if burner and (burner.currently_burning ~= nil or burner.inventory.get_item_count() > 0) then
          fueled = true
        end
      end
    end
  end)

  return {
    train_id = id,
    stops = #records,
    running = not train.manual_mode,
    fueled = fueled,
  }
end

return M
