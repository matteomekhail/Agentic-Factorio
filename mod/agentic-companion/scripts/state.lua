local M = {}

-- Initializes/migrates the storage schema. Safe to call repeatedly.
-- All fields any module needs MUST be declared here (single owner of the schema).
function M.init()
  storage.chat = storage.chat or { messages = {}, next_id = 1 }

  -- Tasks: one lane (queue + active) per companion.
  storage.tasks = storage.tasks or {}
  storage.tasks.next_id = storage.tasks.next_id or 1
  storage.tasks.records = storage.tasks.records or {}
  storage.tasks.by_companion = storage.tasks.by_companion or {}
  -- chain id -> failure tick: late enqueues of a failed plan cancel instantly
  storage.tasks.failed_chains = storage.tasks.failed_chains or {}
  if storage.tasks.queue or storage.tasks.active then
    -- migrate the pre-multi-companion single lane
    storage.tasks.by_companion["AI"] = {
      queue = storage.tasks.queue or {},
      active = storage.tasks.active,
    }
    storage.tasks.queue, storage.tasks.active = nil, nil
  end

  -- Companions: named registry; migrate the old single-companion record.
  storage.companions = storage.companions or {}
  if storage.companion then
    if storage.companion.entity then
      storage.companions["AI"] = storage.companion
    end
    storage.companion = nil
  end

  -- pathfinder bookkeeping: request id -> {name, task_id} (see actions/walk.lua)
  storage.path_requests = {}
  -- chunked RPC responses: { next_id, by_id = { [id] = { parts = {...}, created_tick } } }
  storage.rpc_outbox = storage.rpc_outbox or { next_id = 1, by_id = {} }
  -- push events for the brain (see scripts/events.lua): ring buffer like chat
  storage.events = storage.events or { list = {}, next_id = 1 }
end

return M
