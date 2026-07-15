// TypeScript mirror of docs/PROTOCOL.md (v2 + v3 toolkit). Keep in sync with the mod.

export interface Position {
  x: number;
  y: number;
}

export interface PingResult {
  mod_version: string;
  factorio_version: string;
  tick: number;
  companion_exists: boolean;
}

export interface SpawnResult {
  position: Position;
  unit_number: number;
  already_existed: boolean;
}

export interface ChatMessage {
  id: number;
  tick: number;
  player: string;
  text: string;
}

export interface GetChatResult {
  messages: ChatMessage[] | Record<string, never>;
  last_id: number;
}

export interface ActiveTaskSummary {
  id: number;
  type: string;
  status: string;
}

/** One clustered ore field (grid flood-fill on the mod side). */
export interface ResourcePatch {
  name: string;
  entity_count: number;
  total_amount: number;
  center: Position;
  distance: number;
}

/** Player-force entities grouped by prototype name. */
export interface StructureGroup {
  name: string;
  count: number;
  /** Histogram of defines.entity_status names, e.g. {working: 4, no_ingredients: 2}. Omitted when no entity reports a status. */
  status?: Record<string, number>;
  nearest: Position;
}

export interface GetStateResult {
  tick: number;
  companion?: {
    position: Position;
    health: number;
    inventory: Record<string, number> | Record<string, never>;
    active_task?: ActiveTaskSummary | null;
    queue_length: number;
    /** Gun/ammo/armor slots (v3). Lua may omit empty slots or send null. */
    equipment?: {
      gun?: string | null;
      ammo?: Record<string, number> | Record<string, never> | null;
      armor?: string | null;
    };
  };
  players: Array<{ name: string; position: Position; distance: number }> | Record<string, never>;
  resource_patches: ResourcePatch[] | Record<string, never>;
  trees_nearby: number;
  structures: StructureGroup[] | Record<string, never>;
  /** Within radius; nearest_distance omitted when no enemy unit is in view. */
  enemies?: { nearest_distance?: number; spawners: number };
  /** Omitted when nothing is queued. */
  research?: { current: string; progress: number };
  /** Top 8 items by amount produced, all-time. */
  /** Electric network summary; omitted when no poles are in view. */
  power?: {
    networks: number;
    production_kw?: number;
    consumption_kw?: number;
    top_consumers_kw?: Record<string, number> | Record<string, never>;
    starving_machines?: number;
  };
  production_top?: Record<
    string,
    {
      produced_per_min: number;
      consumed_per_min: number;
      produced_total: number;
      consumed_total: number;
    }
  >;
}

/** Details of ONE entity, from the `inspect` method. */
export interface InspectResult {
  name: string;
  type: string;
  position: Position;
  direction?: number;
  health?: number;
  /** Status name from defines.entity_status; omitted when not applicable. */
  status?: string;
  recipe?: string;
  crafting_progress?: number;
  energy?: number;
  inventories?:
    | Record<string, Record<string, number> | Record<string, never>>
    | Record<string, never>;
  /** Resources only. */
  amount?: number;
  /** Belts/splitters/undergrounds/loaders: items on the transport lines, summed. */
  belt_contents?: Record<string, number> | Record<string, never>;
  /** Pipes/tanks/machines with fluid boxes: fluid name -> amount. */
  fluids?: Record<string, number> | Record<string, never>;
  /** Set when the entity has a fluid system but it's completely dry. */
  no_fluids?: boolean;
}

export interface StartResearchResult {
  queued: boolean;
  technology: string;
}

/** Result of the `scan_area` method — an ASCII map of the surroundings. */
export interface ScanAreaResult {
  /** Map coordinates of grid cell [row 0][col 0] (the north-west corner). */
  origin: Position;
  width: number;
  height: number;
  /** Rows north→south, cols west→east; 1 char = 1 tile; grid[row][col] = map (origin.x+col, origin.y+row). */
  grid: string[] | Record<string, never>;
  /** Symbol → meaning, e.g. {".": "buildable land", "@": "you"}. Assigned per scan. */
  legend: Record<string, string> | Record<string, never>;
  note: string;
}

/** One entry from `describe_prototype`. The mod includes only non-null keys. */
export interface PrototypeInfo {
  kind: "entity" | "recipe" | "unknown";
  // -- entity fields --
  entity?: string;
  placed_by_item?: string;
  tile_width?: number;
  tile_height?: number;
  /** vector_to_place_result at direction 0 (north); rotate with the entity. */
  drop_offset?: Position;
  /** Entity: "burner" | "electric" | ... — Recipe: craft time in seconds. */
  energy?: string | number;
  fuel_categories?: string[] | Record<string, never>;
  mining_speed?: number;
  crafting_categories?: string[] | Record<string, never>;
  range?: number;
  /** Inserters only; at direction 0 (north), rotate with the entity. */
  inserter_pickup_offset?: Position;
  inserter_drop_offset?: Position;
  /** Belts only. */
  belt_speed?: number;
  // -- recipe fields --
  ingredients?: Record<string, number> | Record<string, never>;
  products?: Record<string, number> | Record<string, never>;
  category?: string;
  enabled?: boolean;
}

/** Result of the `describe_prototype` method, keyed by the requested names. */
export type DescribePrototypesResult = Record<string, PrototypeInfo>;

/** Result of the `can_place` dry-run method. */
export interface CanPlaceResult {
  can_place: boolean;
  /** Best-effort blocker naming, e.g. "blocked by tree at (12,4)". */
  reason?: string;
}

/** Result of the `find_buildable_area` method. */
export interface BuildableArea {
  center: Position;
  top_left: Position;
  /** Trees are allowed inside the rectangle but counted so they can be cleared first. */
  trees_in_area: number;
}

/** Result of the `equip` method: the equipment slots after the call. */
export interface EquipResult {
  gun?: string | null;
  ammo?: string | null;
  armor?: string | null;
  ammo_count?: number;
}

/** One entity of a decoded blueprint (`import_blueprint`). */
export interface BlueprintEntity {
  name: string;
  /** RELATIVE position — the blueprint's top-left entity sits at (0,0). */
  position: Position;
  direction?: number;
  recipe?: string | null;
}

/** Result of the `import_blueprint` method. Decodes only — never builds. */
export interface ImportedBlueprint {
  label?: string;
  size: { w: number; h: number };
  entities: BlueprintEntity[] | Record<string, never>;
  items_needed: Record<string, number> | Record<string, never>;
  /** Unknown/modded entity names that were dropped from the list. */
  skipped?: string[] | Record<string, never>;
}

/** One step of a `build_plan` task. */
export interface BuildPlanStep {
  item: string;
  position: Position;
  direction?: number;
  /** Applied to the entity after placing (crafting machines). */
  recipe?: string;
  /** Items moved from the companion inventory into the placed entity. */
  insert?: Record<string, number>;
}

export interface AnalyzeFactoryResult {
  radius: number;
  machines_checked: number;
  working: number;
  problems?: Array<{
    name: string;
    problem: string;
    count: number;
    sample: Position;
    missing?: string;
  }>;
  power?: GetStateResult["power"];
}

export type Task =
  | { type: "walk_to"; target: Position; arrive_within?: number }
  // Persistent: runs until cancelled/replaced.
  | { type: "follow_player"; player?: string; distance?: number }
  // One mining op on the nearest minable within 2 tiles of target.
  | { type: "mine"; target: Position }
  // Composite: resource name | "tree" | "rock"; count = mining ops (default 1, max 200).
  | { type: "mine"; resource: string; count?: number }
  | { type: "place"; item: string; position: Position; direction?: number }
  | { type: "craft"; recipe: string; count?: number }
  | { type: "insert"; target: Position; items: Record<string, number> }
  | { type: "extract"; target: Position; items?: Record<string, number>; all?: boolean }
  | { type: "deliver"; items?: Record<string, number>; all?: boolean; player?: string }
  // Persistent caretaker: tops up burner machines around the anchor until cancelled.
  | { type: "keep_fueled"; center?: Position; radius?: number; fuel?: string }
  | { type: "set_recipe"; target: Position; recipe: string }
  | { type: "rotate"; target: Position; direction?: number }
  // Sequential multi-entity build; max 100 steps, failed steps skipped unless stop_on_error.
  | { type: "build_plan"; steps: BuildPlanStep[]; stop_on_error?: boolean }
  // Consent-gated: the mod fails the task unless confirm is true.
  | {
      type: "deconstruct";
      confirm: boolean;
      target?: Position;
      area?: { center: Position; radius: number };
    }
  // Anchored area combat; flee_below = health fraction to retreat at.
  | { type: "fight"; target?: Position; radius?: number; flee_below?: number };

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface GetTaskResult {
  status: TaskStatus;
  detail: string;
}

/** Responses over ~3400 bytes arrive as part 1 plus a part count; the rest is
 *  fetched via `get_chunk` and the concatenation parsed as the real envelope. */
export interface ChunkedEnvelope {
  ok: true;
  chunked: true;
  id: number;
  parts: number;
  data: string;
}

// Lua's table_to_json serializes empty arrays as {} — normalize.
export function asArray<T>(value: T[] | Record<string, never> | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}
