-- start_research: queue a technology on the companion's force.
local companion = require("scripts.companion")

local M = {}

function M.start_research(params)
  local name = params.technology
  if type(name) ~= "string" or name == "" then
    error('start_research needs a technology name, e.g. {"technology": "logistics"}')
  end

  local c = companion.get()
  local force = c and c.force or game.forces.player

  local ok, tech = pcall(function() return force.technologies[name] end)
  if not ok or not tech then
    error("unknown technology: " .. name)
  end
  if tech.researched then
    error("already researched: " .. name)
  end
  for _, queued in ipairs(force.research_queue) do
    if queued.name == name then
      error(name .. " is already in the research queue")
    end
  end
  if not force.add_research(name) then
    -- Most common cause: an unresearched trigger-tech prerequisite (2.0 early
    -- techs unlock by doing things in the world, not in a lab).
    local missing = {}
    for prereq_name, prereq in pairs(tech.prerequisites) do
      if not prereq.researched then
        local is_trigger = prereq.prototype.research_trigger ~= nil
        missing[#missing + 1] = prereq_name
          .. (is_trigger and " (unlocks via an in-game action, not lab research)" or "")
      end
    end
    if #missing > 0 then
      error("can't queue " .. name .. " yet — missing prerequisites: " .. table.concat(missing, ", "))
    end
    error("could not queue " .. name .. " — the game refused it")
  end

  return { queued = true, technology = name }
end

return M
