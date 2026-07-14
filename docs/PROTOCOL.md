# Mod ↔ Companion protocol (v2 — full feature set)

This file is the **single source of truth** for the JSON contract between the Factorio mod
(`mod/agentic-companion`) and the companion app (`companion/`). Both sides must conform to it.

## Transport

Every call goes through one RCON command:

```
/silent-command remote.call("agentic","rpc","<method>","<params as escaped JSON string>")
```

- `params` is always a JSON **string** (double-quoted Lua string; the companion escapes `\` and `"`).
- The mod replies on the same RCON response via `rcon.print(json)`.

### Envelope

```jsonc
{ "ok": true, "data": { ... } }                       // success
{ "ok": false, "error": "human-readable message" }    // failure
```

### Chunking

If a serialized response exceeds **3400 bytes**, the mod stores it in `storage.rpc_outbox`
and replies:

```jsonc
{ "ok": true, "chunked": true, "id": 3, "parts": 4, "data": "<part 1 of the raw JSON>" }
```

The companion then calls `get_chunk` for parts 2..N and concatenates all parts into the
full `{ok, data}` JSON before parsing. Outbox entries are pruned after 5 minutes.

## Methods

### `ping` — `{}` →
`{ mod_version, factorio_version, tick, companion_exists }`

### `echo` — `{ "size": 5000 }` →
`{ "data": "xxxx…" }` (size capped at 200000). Debug/chunk-test helper.

### `spawn_companion` — `{ near_player?: string }` →
`{ position: {x,y}, unit_number, already_existed }`
Spawns (or returns) the companion character. Falls back to the force spawn point when no
player is connected. Also used to respawn after death.

### `get_chat` — `{ since_id: 0 }` →
`{ messages: [{id, tick, player, text}], last_id }` (ring buffer, max 200; the mod's own
`say` output is never included).

### `say` — `{ text }` → `{}` — prints `[AI] <text>` (teal) to all players.

### `get_state` — `{ radius?: 40 }` (max 80) →
```jsonc
{
  "tick": 123,
  "companion": {
    "position": {x,y}, "health": 250,
    "inventory": {"iron-plate": 50},
    "active_task": {"id":7,"type":"walk_to","status":"running"} /*or null*/,
    "queue_length": 0
  },
  "players": [{"name","position":{x,y},"distance"}],
  "resource_patches": [
    {"name":"iron-ore","entity_count":184,"total_amount":412000,"center":{x,y},"distance":51.2}
  ],                                    // clustered (grid flood-fill), max 12, sorted by distance
  "trees_nearby": 87,
  "structures": [                       // player-force entities, grouped by name, max 30
    {"name":"assembling-machine-2","count":6,
     "status":{"working":4,"no_ingredients":2},   // histogram of entity_status names (omit if none)
     "nearest":{x,y}}
  ],
  "enemies": {"nearest_distance": 210, "spawners": 0},   // within radius; nearest_distance omitted if none
  "research": {"current":"logistics","progress":0.41},   // omitted when nothing queued
  "production_top": {"iron-plate":{"produced":480,"consumed":455}}  // top 8 by produced, all-time
}
```

### `inspect` — `{ position: {x,y} }` or `{ unit_number: 42 }` →
Details of ONE entity (searched within 1.5 tiles of position):
```jsonc
{
  "name":"stone-furnace","type":"furnace","position":{x,y},"direction":4,
  "health":200,"status":"working",           // status name from defines.entity_status (omit if n/a)
  "recipe":"iron-plate",                     // crafting machines/furnaces (omit if none)
  "crafting_progress":0.5,                   // omit if n/a
  "energy":2000,                             // omit if 0/n-a
  "inventories": {"input":{"iron-ore":5},"output":{"iron-plate":3},"fuel":{"coal":10}},
  "amount": 4400                             // resources only
}
```

### `start_research` — `{ technology }` →
`{ queued: true, technology }` — errors if the tech is unknown/already researched.

### `enqueue` — `{ task: <Task>, replace?: false }` → `{ task_id }`
`replace: true` cancels the queue and active task first.

### `get_task` — `{ task_id }` → `{ status: "queued"|"running"|"done"|"failed"|"cancelled", detail }`

### `cancel` — `{ task_id }` or `{ all: true }` → `{ cancelled: n }`

### `get_chunk` — `{ id, part }` → `{ data: "<raw part>" }`

## Tasks

Tasks run over many ticks in `on_tick`, one at a time (FIFO queue). **Every task that
operates on a map position automatically walks within reach first** (the "approach" phase)
using the game pathfinder — the agent never needs to pre-walk (walking there explicitly
still works and is sometimes clearer).

Reach used per action: build → `build_distance`; mine → `resource_reach_distance`;
everything else → `reach_distance`.

```jsonc
{ "type":"walk_to", "target":{x,y}, "arrive_within":1.0? }
{ "type":"follow_player", "player":"name"?, "distance":3? }   // PERSISTENT: runs until cancelled/replaced
{ "type":"mine", "target":{x,y} }                             // one mining op on nearest minable within 2 tiles
{ "type":"mine", "resource":"iron-ore", "count":10? }         // composite: resource name | "tree" | "rock";
                                                              // count = mining ops (default 1, max 200);
                                                              // auto-finds nearest matches within 80 tiles,
                                                              // walks, mines, moves to next entity when exhausted
{ "type":"place", "item":"burner-mining-drill", "position":{x,y}, "direction":0? }  // 16-way 0..15
{ "type":"craft", "recipe":"iron-gear-wheel", "count":1? }    // max 100; uses the character crafting queue
{ "type":"insert", "target":{x,y}, "items":{"coal":10} }      // companion inventory → entity (partial ok)
{ "type":"extract", "target":{x,y}, "items":{"iron-plate":50}? , "all":true? }  // entity → companion
{ "type":"set_recipe", "target":{x,y}, "recipe":"copper-cable" }
{ "type":"rotate", "target":{x,y}, "direction":4? }           // direction omitted = rotate one step
```

Task `detail` strings are natural language, written for an LLM to read
("mined iron-ore (+10 items, carrying 17 total)", "placed burner-mining-drill at (12, -4)").
Failures explain *why* and what to try ("out of reach", "no iron-ore within 80 tiles",
"missing ingredients: 2x iron-plate").

### Walking implementation notes (mod-internal, binding)

- `surface.request_path{bounding_box={{-0.2,-0.2},{0.2,0.2}}, collision_mask=prototypes.entity["character"].collision_mask, start, goal, force, radius, can_open_gates=true, entity_to_ignore=<companion>, path_resolution_modifier=0, pathfind_flags={cache=false, prefer_straight_paths=true}}`
  → result via `on_script_path_request_finished` (`event.id`, `event.path` waypoints, `event.try_again_later`).
- Waypoint following re-sets `walking_state` **every tick** (one-shot writes last one tick);
  8-way direction quantization; waypoint advance within 0.5 tiles.
- `try_again_later` → retry request after 30 ticks (max 3); no path → straight-line fallback.
- Stuck (moved <0.1 tiles over 60 ticks) → re-path once, then fail with a friendly reason.
- ALL per-tick state lives in **plain tables on the task** (storage cannot hold functions).
- Use `companion.surface` everywhere, never `game.surfaces[1]`.

## Companion tool layer (TS)

One neutral registry (`companion/src/tools/definitions.ts`) drives both the built-in
AI-SDK loop and the MCP server:

```ts
interface ToolSpec { name; description; schema: z.ZodObject; execute(bridge, args): Promise<string> }
```

Agent-facing tools: `say`, `look_around`, `inspect_entity`, `walk_to`, `follow_player`,
`mine`, `place_entity`, `craft_items`, `insert_items`, `extract_items`, `set_recipe`,
`rotate_entity`, `start_research`, `respawn`, `stop`.
MCP-only extras: `connect_status`, `read_chat`, `wait_for_chat` (long-poll ≤55 s).

`follow_player` enqueues with `replace:true` and returns immediately (persistent task —
never awaited). Every other task tool uses `enqueueAndWait` with per-action timeouts.
Tool errors are returned as `"Error: …"` strings, never thrown.

## Conventions

- Positions are map coordinates (tiles), y grows southward. Directions are 16-way (0=N, 4=E, 8=S, 12=W).
- Methods raise (`ok:false`) if the companion is required but missing/dead — except
  `ping`, `spawn_companion`, `get_chat`, `say`, `echo`, `get_chunk`.
- The mod never blocks; long actions are tasks; the companion polls `get_task` (500 ms).
- The mod only ever mines resources/trees/rocks (enforced by type filter) — player
  structures can be *operated* (insert/extract/rotate/set_recipe) but never destroyed.
