// TypeScript mirror of docs/PROTOCOL.md (v2). Keep in sync with the mod.

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
  production_top?: Record<string, { produced: number; consumed: number }>;
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
}

export interface StartResearchResult {
  queued: boolean;
  technology: string;
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
  | { type: "set_recipe"; target: Position; recipe: string }
  | { type: "rotate"; target: Position; direction?: number };

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
