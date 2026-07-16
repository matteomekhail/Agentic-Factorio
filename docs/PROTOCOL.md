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

### `take_screenshot` — `{ request_id, center?: {x,y}, radius?: 45 }` →
`{ path, center:{x,y}, radius, resolution:{w,h} }`

Schedules a 1024×1024 JPEG render on the addressed companion's surface, centered on the
companion unless `center` is supplied. `radius` is clamped to 10..100 tiles. The mod writes
the image below Factorio's `script-output/agentic-factorio/` directory and returns only its
relative path; Factorio completes the file at the end of the update. `request_id` must be a
random 8..64-character alphanumeric/hyphen token so an old file can never satisfy a fresh
request. Factorio's renderer does nothing on a headless server.

The TS `view_area` tool waits for the file (size-stable across two polls — the renderer
writes asynchronously), reads it as base64, deletes the temporary JPEG, and returns text +
image content to both AI-SDK and MCP clients. It requires Factorio and the companion app on
the same machine. The user-data directory comes from setup, the standard OS location, or
`AGENTIC_FACTORIO_USER_DIR`.

MCP clients that don't render image content (Codex CLI) would keep ~500 KB of base64 as
TEXT in their context per screenshot — measured to blow a session up to compaction. For
clients whose `clientInfo.name` matches `codex` the server instead writes the JPEG under
`$TMPDIR/agentic-factorio-views/` and returns its path with an instruction to open it with
the client's native image viewer. Override with `AGENTIC_VIEW_IMAGE_MODE=inline|file`.

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

### `inspect` — `{ position: {x,y} }`, `{ unit_number: 42 }`, or batched `{ targets: [{x,y}, ...] }` →

Batched form (max 16 targets) returns `{ entities: [<single-result or {error, position}>, ...] }`
in input order — one RPC instead of one model round-trip per machine.

Single form:
Details of ONE entity (searched within 1.5 tiles of position):
```jsonc
{
  "name":"stone-furnace","type":"furnace","position":{x,y},"direction":4,
  "health":200,"status":"working",           // status name from defines.entity_status (omit if n/a)
  "recipe":"iron-plate",                     // crafting machines/furnaces (omit if none)
  "crafting_progress":0.5,                   // omit if n/a
  "energy":2000,                             // omit if 0/n-a
  "inventories": {"input":{"iron-ore":5},"output":{"iron-plate":3},"fuel":{"coal":10}},
  "amount": 4400,                            // resources only
  "belt_contents": {"iron-plate": 4},        // belts/splitters/undergrounds/loaders: items on the lines
  "fluids": {"water": 812.5},                // pipes/tanks/machines with fluid boxes
  "no_fluids": true                          // set instead of fluids when the fluid system is dry
}
```

### `start_research` — `{ technology }` →
`{ queued: true, technology }` — errors if the tech is unknown/already researched.

### `enqueue` — `{ task: <Task>, replace?: false, background?: false, quiet?: false, chain?: string }` → `{ task_id }`
`replace: true` cancels the queue and active task first. `background: true` makes the task
report its outcome as a `task_done`/`task_failed` push event when it finishes. `quiet: true`
suppresses the success event (failures always report) — the `run_plan` tool marks every step
but the last quiet so a whole plan wakes the brain once. `chain: "<id>"`: when a task of a
chain fails, the remaining queued tasks with the same chain id are cancelled (detail
"skipped: an earlier step of the same plan failed"), so a broken plan produces exactly one
failure event instead of a cascade. Failed chain ids are remembered (~5 min): a fast failure
can beat the remaining enqueue RPCs, so late enqueues of a failed chain are cancelled at
enqueue time — the response then carries `cancelled: true` and the task never runs.

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
{ "type":"build_blueprint", "label":"...", "book":"..."?, "anchor":{x,y}, "stop_on_error":false? }
                                                              // builds a whole REACHABLE print (starter
                                                              // books, inventories, cursor) at the anchor:
                                                              // resolution/normalization in blueprint.lua,
                                                              // then build_plan's tick machinery; max 1000
                                                              // entities; step.entity overrides the item's
                                                              // place_result (rail item -> curved segments)
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
type ToolOutput = string | { text: string; image: { data: string; mimeType: "image/jpeg" } }
interface ToolSpec { name; description; schema: z.ZodObject; execute(bridge, args): Promise<ToolOutput> }
```

Agent-facing tools include `say`, `look_around`, `view_area`, `inspect_entity`, `walk_to`, `follow_player`,
`mine`, `place_entity`, `craft_items`, `insert_items`, `extract_items`, `set_recipe`,
`rotate_entity`, `start_research`, `respawn`, `stop`.
MCP-only extras: `connect_status`, `read_chat`, `wait_for_chat` (long-poll ≤55 s).

`follow_player` enqueues with `replace:true` and returns immediately (persistent task —
never awaited). Every other task tool uses `enqueueAndWait` with per-action timeouts.
Tool errors are returned as `"Error: …"` strings, never thrown.

`view_area` is deliberately opt-in: its description and all three system-prompt surfaces
(built-in loop, Codex brain and MCP server) direct the model to use it for explicit visual
requests, ambiguous complex layouts and substantial-build QA — not for routine checks or
facts better served by structured tools. AI-SDK history replaces the base64 image with a
short note after the active turn so stale screenshots are neither persisted nor resent.

## v3 — general building & combat toolkit

Design rule: **no scenario logic in the mod**. These are general primitives; the LLM plans
("build me an iron farm" = the model scans, reads prototype geometry, computes coordinates,
validates, then builds). Nothing here knows what a "farm" is.

### Spatial perception (instant methods)

`scan_area` — `{ center?: {x,y} (default companion), radius?: 15 (5..30) }` →
```jsonc
{
  "origin": {"x":-15,"y":-15},           // map coords of grid cell [row 0][col 0]
  "width": 31, "height": 31,
  "grid": ["...~~TT...", "..@....a..", ...],  // rows north→south, cols west→east; 1 char = 1 tile
  "legend": {".":"buildable land","~":"water","c":"cliff","T":"tree","R":"rock",
             "@":"you","P":"player","E":"enemy",
             "I":"iron-ore","O":"coal", "a":"stone-furnace", ...},  // letters assigned per distinct thing found
  "note": "tile at grid[row][col] = map (origin.x+col, origin.y+row); entity symbols mark their center tile"
}
```
Resource letters uppercase, building letters lowercase, assigned dynamically and defined in the legend.

`describe_prototype` — `{ names: ["burner-mining-drill", "inserter", "iron-gear-wheel"] }` →
per name (item, entity or recipe — resolve in that order, follow item→place_result):
```jsonc
{ "burner-mining-drill": {
    "kind":"entity", "entity":"burner-mining-drill", "placed_by_item":"burner-mining-drill",
    "tile_width":2, "tile_height":2,
    "drop_offset":{"x":-0.5,"y":-1.5},       // vector_to_place_result at direction 0 (north); rotate with the entity
    "energy":"burner", "fuel_categories":["chemical"],
    "mining_speed":0.25,
    "crafting_categories":null, "range":null,
    "inserter_pickup_offset":null, "inserter_drop_offset":null,   // set for inserters
    "belt_speed":null                                              // set for belts
  },
  "iron-gear-wheel": { "kind":"recipe", "ingredients":{"iron-plate":2}, "products":{"iron-gear-wheel":1},
                       "energy":0.5, "category":"crafting", "enabled":true } }
```
Include only non-null keys. Unknown names → `{"kind":"unknown"}`.

`can_place` — `{ item, position:{x,y}, direction?: 0 }` → `{ can_place: bool, reason?: "blocked by tree at (12,4)" }`
Batched: `{ item?, placements: [{item?, position:{x,y}, direction?}, ...] }` (max 24; per-placement
item falls back to the top-level one) → `{ results: [{can_place, reason?, position}, ...] }` in
input order.
Dry run with `build_check_type.manual`, no side effects. Best-effort blocker naming.

`find_buildable_area` — `{ width, height, near:{x,y}, max_distance?: 50 }` →
`{ center:{x,y}, top_left:{x,y}, trees_in_area: n }` — nearest rectangle of land tiles free of
water/cliffs/entities (trees allowed but counted so the model can clear them first). Errors when none found.

### Building at scale (task)

```jsonc
{ "type":"build_plan", "stop_on_error?": false,
  "steps": [
    { "item":"burner-mining-drill", "position":{x,y}, "direction?":4,
      "recipe?":"iron-gear-wheel",              // for crafting machines, applied after placing
      "insert?": {"coal": 5} }                  // items moved from companion into the placed entity
  ] }
```
Max 100 steps. Executes sequentially with auto-approach per step (build reach). A failed step is
recorded and skipped (unless `stop_on_error`). Detail: `"placed 8/10 — step 5 failed: blocked by
tree at (12,4); step 9 failed: no transport-belt left"`. Steps reuse place/set_recipe/insert logic.

### Demolition (task, consent-gated)

```jsonc
{ "type":"deconstruct", "confirm": true,
  "target": {x,y} }            // or "area": { "center":{x,y}, "radius": <=10 }  (max 50 entities)
```
Mines player-force entities back into the companion inventory (timed ops, auto-approach).
`confirm` MUST be true or the task fails with an instruction to ask the player first — the tool
layer only sets it after the player explicitly asked for demolition. Characters are never targets.
Trees/rocks don't need deconstruct (plain `mine` handles them).

### Combat

`equip` (instant method) — `{ gun?: "pistol", ammo?: "firearm-magazine", armor?: "light-armor" }`
Moves items from the main inventory into the gun/ammo/armor slots
(defines.inventory.character_guns / character_ammo / character_armor). Returns what got equipped
plus current ammo count. Errors name what's missing from the inventory.

```jsonc
{ "type":"fight", "radius?": 20,          // max 40, anchored at the START position (no infinite chasing)
  "target?": {x,y},                        // optional: clear around a specific point instead
  "flee_below?": 0.3 }                     // health fraction; retreat toward the nearest player and end
```
Tick machine: nearest enemy (unit / spawner / worm) in radius → walk into gun range →
`shooting_state = {state=defines.shooting.shooting_enemies, position=<enemy>}` re-set every tick →
next enemy until none left → done "cleared, N kills". Fails cleanly when no gun/ammo ("equip a gun
first"), reports "out of ammo" mid-fight, flees + reports when health drops below the threshold.
get_state's companion block gains `"equipment": {"gun":"pistol","ammo":{"firearm-magazine":57},"armor":null}`.

### Blueprints (instant methods)

Three ways in, one normalized shape out:

`import_blueprint` — `{ "string": "0eNq...", "offset?": 0, "limit?": 100 }`
`list_blueprints` — `{ "player?": "name" }`
`read_blueprint` — `{ "label?": "...", "book?": "...", "offset?": 0, "limit?": 100, "player?": "name" }`

The decoded shape (import/read):
```jsonc
{ "label": "Mining outpost", "size": {"w": 12, "h": 8},   // footprint of the WHOLE print
  "total_entities": 350, "offset": 0,                       // window bookkeeping
  "entities": [ {"name":"burner-mining-drill","position":{"x":0,"y":0},"direction":4,"recipe":null}, ... ],
  "next_offset": 100,                                       // absent on the last window
  "items_needed": {"burner-mining-drill":6,"wooden-chest":6}, // whole print, not the window
  "skipped": ["some-modded-entity"],                        // unknown here, dropped
  "tiles": {"count": 128, "kinds": ["concrete"]} }          // flooring; no tool places tiles
```
Decodes via `import_stack` + `get_blueprint_entities` (a scratch inventory for pasted strings);
positions normalized so the whole print's top-left entity sits at (0,0) — the origin never moves
with the window, so every batch shares one anchor. **Does not build** — the model offsets the
coordinates and feeds them to `build_plan`. Huge prints are read in `offset`/`limit` windows
(default 100 = one `build_plan` batch, max 200).

`list_blueprints` enumerates every reachable print: the player's cursor (item or 2.0 library
record), main inventories, and blueprint books — recursing into nested books (depth ≤ 4) — for
the player and every companion. Returns `{ blueprints: [{label, where, book?, entity_count}],
total, note }` (capped at 200 entries). The game's blueprint LIBRARY window is client-side and
invisible to mods. `read_blueprint` picks by label (exact, then substring, case-insensitive);
`book` filters to matching book paths first — that's how duplicate labels across books are
disambiguated.

**Starter books**: the default companion spawns carrying the blueprint books generated from
`BlueprintBooks/*.txt` (see `scripts/build-starter-blueprints.mjs` → generated
`mod/scripts/starter_blueprints.lua`, issued by `mod/scripts/starter.lua`). The data carries a
content-hash `version`; a 120-tick handler re-issues the set to a running save whenever the
version changes (old starter books are removed by label — companion-renamed books are left
alone). The new set is imported into a scratch inventory first, so a bad import never
destroys the books already carried; failures are retried every ~2 minutes (transient causes
like a full inventory heal themselves) and reported once per version as a `starter_books`
push event. `import_stack` contract: 0 = ok, -1 = imported WITH errors (still usable —
accepted), 1 = failed outright (rejected).

## v4 — events & multi-companion

### Push events

`get_events` — `{ since_id: 0 }` → `{ events: [{id, tick, kind, text, companion?}], last_id }`
Ring buffer (max 100) of things that happened unprompted: `attacked` (throttled 5s per
companion), `died`, `research_finished`, `supply_warning` (defend/refuel duties out of
ammo/fuel/repair packs). The companion app polls it alongside chat and wakes the brain
with `[event]` messages; MCP's `wait_for_chat` returns both streams.

### Multi-companion

Up to **4 named companions** (default `"AI"`), each with its own color, floating label,
map tag and **task lane** — lanes tick in parallel, so companions genuinely work at the
same time.

- Every method/enqueue accepts an optional `companion: "Name"` param; the mod routes the
  call to that companion (rpc sets a per-call context; handlers are companion-agnostic).
- `spawn_companion {name?}` creates/locates a named companion (a NEW name = a NEW body).
- `cancel {all:true}` clears EVERY lane (the !stop kill switch);
  `cancel {all:true, companion:"X"}` clears only X's lane.
- `get_state` centers on the addressed companion (`companion.name` in the result) and
  lists the rest of the crew in `other_companions: [{name, position, health, active_task,
  queue_length, vehicle?, dead?}]`.
- On the TS side the tool registry injects `companion` automatically: every tool schema
  gains the optional field and a scoped Bridge merges it into all mod calls.

## Conventions

- Positions are map coordinates (tiles), y grows southward. Directions are 16-way (0=N, 4=E, 8=S, 12=W).
- Methods raise (`ok:false`) if the companion is required but missing/dead — except
  `ping`, `spawn_companion`, `get_chat`, `say`, `echo`, `get_chunk`.
- The mod never blocks; long actions are tasks; the companion polls `get_task` (500 ms).
- The mod only ever mines resources/trees/rocks (enforced by type filter) — player
  structures can be *operated* (insert/extract/rotate/set_recipe) but never destroyed.
