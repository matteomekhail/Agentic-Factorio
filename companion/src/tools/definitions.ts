// The single tool registry, shared by the built-in agent loop and the MCP
// server. Tool results are short natural-language strings; errors are returned
// as "Error: ..." strings too, so the model can react instead of crashing.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Bridge } from "../bridge.js";
import {
  asArray,
  type GetStateResult,
  type InspectResult,
  type SpawnResult,
  type StartResearchResult,
  type Task,
} from "../types.js";

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  execute(bridge: Bridge, args: Record<string, unknown>): Promise<string>;
}

export interface ToolHooks {
  onTool?: (name: string, detail: string) => void;
}

const err = (e: unknown): string => {
  if (e instanceof z.ZodError) {
    const issues = e.issues
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    return `Error: invalid arguments — ${issues}`;
  }
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
};

const num = (n: number): string => n.toLocaleString("en-US");

const DIR_NAMES: Record<number, string> = {
  0: "north",
  2: "northeast",
  4: "east",
  6: "southeast",
  8: "south",
  10: "southwest",
  12: "west",
  14: "northwest",
};
const dirName = (d: number): string => DIR_NAMES[d] ?? `direction ${d}`;

export function formatState(state: GetStateResult): string {
  const lines: string[] = [];

  if (state.companion) {
    const c = state.companion;
    lines.push(`You are at (${c.position.x}, ${c.position.y}), health ${c.health}.`);
    const inv = Object.entries(c.inventory ?? {});
    lines.push(
      inv.length === 0
        ? "Your inventory is empty."
        : `Inventory: ${inv.map(([n, q]) => `${n} x${q}`).join(", ")}.`,
    );
    if (c.active_task) {
      const queued = c.queue_length > 0 ? `, ${c.queue_length} more task(s) queued` : "";
      lines.push(`Currently busy with task #${c.active_task.id} (${c.active_task.type})${queued}.`);
    } else if (c.queue_length > 0) {
      lines.push(`${c.queue_length} task(s) queued.`);
    }
  } else {
    lines.push("You have no body yet (companion character missing — use respawn).");
  }

  const players = asArray(state.players);
  if (players.length > 0) {
    lines.push(
      "Players: " +
        players
          .map((p) => `${p.name} at (${p.position.x}, ${p.position.y}), ${p.distance} tiles away`)
          .join("; ") +
        ".",
    );
  }

  const patches = asArray(state.resource_patches);
  lines.push(
    patches.length === 0
      ? "No ore patches visible nearby."
      : "Resource patches: " +
          patches
            .map(
              (p) =>
                `${p.name} — ${num(p.total_amount)} total in ${p.entity_count} tiles, ` +
                `center (${p.center.x}, ${p.center.y}), ${Math.round(p.distance)} tiles away`,
            )
            .join("; ") +
          ".",
  );

  lines.push(`Trees within view: ${state.trees_nearby}.`);

  const structures = asArray(state.structures);
  if (structures.length > 0) {
    lines.push(
      "Structures: " +
        structures
          .map((s) => {
            const status = s.status
              ? " — " +
                Object.entries(s.status)
                  .map(([name, n]) => `${n} ${name.replace(/_/g, " ")}`)
                  .join(", ")
              : "";
            return `${s.name} x${s.count} (nearest at (${s.nearest.x}, ${s.nearest.y})${status})`;
          })
          .join("; ") +
        ".",
    );
  }

  if (state.enemies) {
    const e = state.enemies;
    if (e.nearest_distance === undefined && e.spawners === 0) {
      lines.push("No enemies in view.");
    } else {
      const bits: string[] = [];
      if (e.nearest_distance !== undefined) {
        bits.push(`nearest ${Math.round(e.nearest_distance)} tiles away`);
      }
      bits.push(`${e.spawners} spawner(s) in view`);
      lines.push(`Enemies: ${bits.join(", ")}.`);
    }
  }

  if (state.research) {
    lines.push(
      `Researching ${state.research.current} (${Math.round(state.research.progress * 100)}%).`,
    );
  }

  if (state.production_top) {
    const prod = Object.entries(state.production_top);
    if (prod.length > 0) {
      lines.push(
        "Top production (all-time): " +
          prod.map(([n, p]) => `${n} ${num(p.produced)} made / ${num(p.consumed)} used`).join("; ") +
          ".",
      );
    }
  }

  return lines.join("\n");
}

function formatInspect(e: InspectResult): string {
  const parts: string[] = [];
  const facing = e.direction !== undefined ? `, facing ${dirName(e.direction)}` : "";
  parts.push(`${e.name} (${e.type}) at (${e.position.x}, ${e.position.y})${facing}.`);
  if (e.health !== undefined) parts.push(`Health ${e.health}.`);
  if (e.status) parts.push(`Status: ${e.status.replace(/_/g, " ")}.`);
  if (e.recipe) {
    const progress =
      e.crafting_progress !== undefined ? ` (${Math.round(e.crafting_progress * 100)}% done)` : "";
    parts.push(`Recipe: ${e.recipe}${progress}.`);
  }
  if (e.energy) parts.push(`Energy: ${num(Math.round(e.energy))}.`);
  if (e.amount !== undefined) parts.push(`Resource amount left: ${num(e.amount)}.`);
  if (e.inventories) {
    for (const [invName, contents] of Object.entries(e.inventories)) {
      const items = Object.entries(contents);
      parts.push(
        items.length === 0
          ? `${invName} inventory: empty.`
          : `${invName} inventory: ${items.map(([n, q]) => `${n} x${q}`).join(", ")}.`,
      );
    }
  }
  return parts.join(" ");
}

/** Wraps a typed run function into a ToolSpec: re-validates args with the
 *  schema and converts any failure into an "Error: ..." string. */
function spec<S extends z.ZodObject<z.ZodRawShape>>(
  name: string,
  description: string,
  schema: S,
  run: (bridge: Bridge, args: z.infer<S>) => Promise<string>,
): ToolSpec {
  return {
    name,
    description,
    schema,
    execute: async (bridge, args) => {
      try {
        return await run(bridge, schema.parse(args) as z.infer<S>);
      } catch (e) {
        return err(e);
      }
    },
  };
}

const directionField = z
  .number()
  .int()
  .min(0)
  .max(15)
  .optional()
  .describe("16-way direction: 0=north, 4=east, 8=south, 12=west");

const itemsField = z
  .record(z.string(), z.number().int().min(1))
  .describe('item name to count, e.g. {"coal": 10}');

/** Agent-facing tools, pure data — consumed by both the ai-sdk loop
 *  (buildTools) and the MCP server. */
export function toolSpecs(): ToolSpec[] {
  return [
    spec(
      "say",
      "Say something in the game chat. This is the ONLY way players can hear you — your normal text output is never shown to them. Keep it to one or two short, friendly sentences.",
      z.object({ text: z.string().min(1).max(400) }),
      async (bridge, { text }) => {
        await bridge.call("say", { text });
        return "Said it.";
      },
    ),

    spec(
      "look_around",
      "Look at your surroundings: your position, inventory, current task, nearby players, ore patches (with total amounts), trees, built structures (with working/blocked status), enemies, current research and top production. Returns a plain-text report. Use this before acting on stale information.",
      z.object({
        radius: z.number().min(5).max(80).optional().describe("view radius in tiles, default 40"),
      }),
      async (bridge, { radius }) =>
        formatState(await bridge.call<GetStateResult>("get_state", { radius })),
    ),

    spec(
      "inspect_entity",
      "Inspect ONE entity near a map position (searched within 1.5 tiles): type, status, recipe, crafting progress and inventory contents. Use it to check what a machine or chest holds before inserting/extracting, or how much ore a resource tile has left. Returns a plain-text report.",
      z.object({ x: z.number(), y: z.number() }),
      async (bridge, { x, y }) =>
        formatInspect(await bridge.call<InspectResult>("inspect", { position: { x, y } })),
    ),

    spec(
      "walk_to",
      "Walk to a map position using the game pathfinder (goes around water, cliffs and buildings). Takes real time and replaces whatever you were doing, including following a player. Rarely needed before other actions — every action tool auto-walks to its target first. Returns a plain sentence saying where you ended up, or an error explaining what blocked you.",
      z.object({
        x: z.number(),
        y: z.number(),
        arrive_within: z
          .number()
          .min(0.5)
          .max(10)
          .optional()
          .describe("how close is close enough, in tiles (default 1)"),
      }),
      async (bridge, { x, y, arrive_within }) =>
        bridge.enqueueAndWait(
          { type: "walk_to", target: { x, y }, arrive_within },
          { replace: true, timeoutMs: 180_000 },
        ),
    ),

    spec(
      "follow_player",
      "Start following a player, keeping a small distance. Replaces whatever you were doing and keeps running UNTIL you call stop or start a new walk — so remember to stop before doing other work. Returns immediately; you stay responsive while following.",
      z.object({
        player: z.string().optional().describe("player name; defaults to the nearest player"),
        distance: z.number().min(1).max(10).optional().describe("tiles to keep behind, default 3"),
      }),
      async (bridge, { player, distance }) => {
        // Persistent task: never awaited, always replaces the queue.
        await bridge.call<{ task_id: number }>("enqueue", {
          task: { type: "follow_player", player, distance } satisfies Task,
          replace: true,
        });
        return `Now following ${player ?? "the nearest player"}. Call stop (or walk somewhere) to break off.`;
      },
    ),

    spec(
      "mine",
      'Mine resources, trees or rocks. Two modes: give x+y to mine whatever sits at that exact spot, OR give a resource name ("iron-ore", "coal", "stone", "tree", "rock", ...) with an optional count to mine that many, auto-finding the nearest matches within 80 tiles. Either way you auto-walk within reach first. Takes real time; the result is a plain sentence like "mined iron-ore (+10 items, carrying 17 total)".',
      z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        resource: z
          .string()
          .optional()
          .describe('resource name like "iron-ore", or "tree" or "rock"'),
        count: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("mining operations to perform (default 1) — only used with resource"),
      }),
      async (bridge, { x, y, resource, count }) => {
        const hasPos = x !== undefined && y !== undefined;
        if (resource !== undefined && hasPos) {
          return "Error: give either a position (x and y) or a resource name, not both.";
        }
        if (resource === undefined && !hasPos) {
          return "Error: tell me what to mine — either a position (x and y) or a resource name like \"iron-ore\".";
        }
        const task: Task = resource !== undefined
          ? { type: "mine", resource, count }
          : { type: "mine", target: { x: x as number, y: y as number } };
        return bridge.enqueueAndWait(task, { timeoutMs: 60_000 + (count ?? 1) * 15_000 });
      },
    ),

    spec(
      "place_entity",
      'Place an item from your inventory as a building on the map (e.g. "burner-mining-drill", "stone-furnace", "transport-belt"). You auto-walk within build range first. Fails with a clear reason if you lack the item or the spot is blocked.',
      z.object({
        item: z.string().describe('item name, e.g. "stone-furnace"'),
        x: z.number(),
        y: z.number(),
        direction: directionField,
      }),
      async (bridge, { item, x, y, direction }) =>
        bridge.enqueueAndWait(
          { type: "place", item, position: { x, y }, direction },
          { timeoutMs: 60_000 },
        ),
    ),

    spec(
      "craft_items",
      'Hand-craft items using your character crafting queue (e.g. recipe "iron-gear-wheel"). Missing intermediates are crafted automatically when possible; otherwise the error lists exactly which ingredients you are short of. Takes real time.',
      z.object({
        recipe: z.string().describe('recipe name, usually the item name, e.g. "iron-gear-wheel"'),
        count: z.number().int().min(1).max(100).optional().describe("how many to craft, default 1"),
      }),
      async (bridge, { recipe, count }) =>
        bridge.enqueueAndWait(
          { type: "craft", recipe, count },
          { timeoutMs: 60_000 + (count ?? 1) * 10_000 },
        ),
    ),

    spec(
      "insert_items",
      "Move items from your inventory INTO a machine, chest or furnace at the given position (fuel lands in the fuel slot, ingredients in the input). You auto-walk within reach first. Partial inserts are reported in the result sentence.",
      z.object({ x: z.number(), y: z.number(), items: itemsField }),
      async (bridge, { x, y, items }) =>
        bridge.enqueueAndWait(
          { type: "insert", target: { x, y }, items },
          { timeoutMs: 60_000 },
        ),
    ),

    spec(
      "extract_items",
      "Take items OUT of a machine, chest or furnace at the given position into your inventory. Pass items for specific counts, or all: true to empty it. You auto-walk within reach first.",
      z.object({
        x: z.number(),
        y: z.number(),
        items: itemsField.optional(),
        all: z.boolean().optional().describe("take everything the entity holds"),
      }),
      async (bridge, { x, y, items, all }) => {
        if (items === undefined && !all) {
          return "Error: say what to take — pass items with counts, or all: true to empty the entity.";
        }
        return bridge.enqueueAndWait(
          { type: "extract", target: { x, y }, items, all },
          { timeoutMs: 60_000 },
        );
      },
    ),

    spec(
      "set_recipe",
      'Set the recipe of an assembling machine at the given position (e.g. "copper-cable"). You auto-walk within reach first.',
      z.object({
        x: z.number(),
        y: z.number(),
        recipe: z.string().describe('recipe name, e.g. "iron-gear-wheel"'),
      }),
      async (bridge, { x, y, recipe }) =>
        bridge.enqueueAndWait(
          { type: "set_recipe", target: { x, y }, recipe },
          { timeoutMs: 60_000 },
        ),
    ),

    spec(
      "rotate_entity",
      "Rotate an entity at the given position. Omit direction to rotate one step, or give a 16-way direction (0=north, 4=east, 8=south, 12=west). You auto-walk within reach first.",
      z.object({ x: z.number(), y: z.number(), direction: directionField }),
      async (bridge, { x, y, direction }) =>
        bridge.enqueueAndWait(
          { type: "rotate", target: { x, y }, direction },
          { timeoutMs: 60_000 },
        ),
    ),

    spec(
      "start_research",
      'Queue a technology for research (e.g. "automation", "logistics"). Instant to queue — the labs still need science packs to make progress. Errors if the technology is unknown or already researched.',
      z.object({ technology: z.string().describe('technology name, e.g. "automation"') }),
      async (bridge, { technology }) => {
        const res = await bridge.call<StartResearchResult>("start_research", { technology });
        return `Research queued: ${res.technology}.`;
      },
    ),

    spec(
      "respawn",
      "Spawn your companion character (or locate the existing one) — use this when look_around says you have no body, e.g. after dying. Spawns near a connected player.",
      z.object({}),
      async (bridge) => {
        const res = await bridge.call<SpawnResult>("spawn_companion", {});
        const at = `(${res.position.x}, ${res.position.y})`;
        return res.already_existed
          ? `You already have a body — it is at ${at}.`
          : `Respawned at ${at}.`;
      },
    ),

    spec(
      "stop",
      "Immediately cancel everything you are doing: walking, following, mining, and the whole task queue.",
      z.object({}),
      async (bridge) => {
        const res = await bridge.call<{ cancelled: number }>("cancel", { all: true });
        return `Stopped. ${res.cancelled} task(s) cancelled.`;
      },
    ),
  ];
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(" ");
}

/** ai-sdk ToolSet over the shared specs, for the built-in agent loop. */
export function buildTools(bridge: Bridge, hooks: ToolHooks = {}): ToolSet {
  const tools: ToolSet = {};
  for (const s of toolSpecs()) {
    tools[s.name] = tool({
      description: s.description,
      inputSchema: s.schema,
      execute: async (args) => {
        const record = args as Record<string, unknown>;
        hooks.onTool?.(s.name, summarizeArgs(record));
        return s.execute(bridge, record);
      },
    });
  }
  return tools;
}
