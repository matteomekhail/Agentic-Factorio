local M = {}

-- Initializes/migrates the storage schema. Safe to call repeatedly.
-- All fields any module needs MUST be declared here (single owner of the schema).
function M.init()
  storage.chat = storage.chat or { messages = {}, next_id = 1 }
  storage.tasks = storage.tasks or { queue = {}, active = nil, next_id = 1, records = {} }
  storage.companion = storage.companion or {}
  -- pathfinder bookkeeping: request id -> task id (see actions/walk.lua)
  storage.path_requests = storage.path_requests or {}
  -- chunked RPC responses: { next_id, by_id = { [id] = { parts = {...}, created_tick } } }
  storage.rpc_outbox = storage.rpc_outbox or { next_id = 1, by_id = {} }
  -- push events for the brain (see scripts/events.lua): ring buffer like chat
  storage.events = storage.events or { list = {}, next_id = 1 }
end

return M
