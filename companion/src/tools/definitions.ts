// The single tool registry, shared by the built-in agent loop and the MCP
// server. Tool results are short natural-language strings; errors are returned
// as "Error: ..." strings too, so the model can react instead of crashing.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Bridge } from "../bridge.js";
import {
  type AnalyzeFactoryResult,
  asArray,
  type BuildableArea,
  type CanPlaceResult,
  type DescribePrototypesResult,
  type EquipResult,
  type GetStateResult,
  type ImportedBlueprint,
  type InspectResult,
  type PrototypeInfo,
  type ScanAreaResult,
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
    lines.push(
      `You are ${c.name ?? "AI"} at (${c.position.x}, ${c.position.y}), health ${c.health}${c.vehicle ? `, driving a ${c.vehicle}` : ""}.`,
    );
    const inv = Object.entries(c.inventory ?? {});
    lines.push(
      inv.length === 0
        ? "Your inventory is empty."
        : `Inventory: ${inv.map(([n, q]) => `${n} x${q}`).join(", ")}.`,
    );
    if (c.equipment) {
      const eq = c.equipment;
      const ammo = Object.entries(eq.ammo ?? {});
      lines.push(
        `Equipment — gun: ${eq.gun ?? "none"}; ammo: ${
          ammo.length > 0 ? ammo.map(([n, q]) => `${n} x${q}`).join(", ") : "none"
        }; armor: ${eq.armor ?? "none"}.`,
      );
    }
    if (c.active_task) {
      const queued = c.queue_length > 0 ? `, ${c.queue_length} more task(s) queued` : "";
      lines.push(`Currently busy with task #${c.active_task.id} (${c.active_task.type})${queued}.`);
    } else if (c.queue_length > 0) {
      lines.push(`${c.queue_length} task(s) queued.`);
    }
  } else {
    lines.push("You have no body yet (companion character missing — use respawn).");
  }

  const crew = asArray(state.other_companions);
  if (crew.length > 0) {
    lines.push(
      "Your crew: " +
        crew
          .map((m) => {
            if (m.dead) return `${m.name} is DEAD (respawn with name "${m.name}")`;
            const task = m.active_task ? `doing ${m.active_task.type}` : "IDLE";
            return `${m.name} at (${m.position?.x}, ${m.position?.y}), hp ${m.health}, ${task}${m.vehicle ? `, in a ${m.vehicle}` : ""}`;
          })
          .join("; ") +
        ".",
    );
  } else if (state.companion) {
    lines.push(
      'Crew: just you — up to 3 more companions can work in parallel (respawn {name:"Anna"} to add one, then pass companion:"Anna" + background:true on action tools).',
    );
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

  if (state.power) {
    const p = state.power;
    const bits: string[] = [];
    if (p.production_kw !== undefined) {
      bits.push(`producing ${num(p.production_kw)} kW, using ${num(p.consumption_kw ?? 0)} kW`);
    }
    const top = Object.entries(p.top_consumers_kw ?? {});
    if (top.length > 0) {
      bits.push(`top consumers: ${top.map(([n, kw]) => `${n} ${num(kw)} kW`).join(", ")}`);
    }
    if (p.starving_machines) {
      bits.push(`${p.starving_machines} machine(s) starving for power`);
    }
    lines.push(
      `Power (${p.networks} network${p.networks === 1 ? "" : "s"}): ${bits.join("; ") || "no flow data"}.`,
    );
  }

  if (state.production_top) {
    const prod = Object.entries(state.production_top);
    if (prod.length > 0) {
      lines.push(
        "Top production (last minute): " +
          prod
            .map(([n, p]) =>
              `${n} ${num(p.produced_per_min)}/min made, ${num(p.consumed_per_min)}/min used` +
              ` (${num(p.produced_total)} all-time)`)
            .join("; ") +
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
  if (e.belt_contents) {
    const items = Object.entries(e.belt_contents);
    parts.push(
      items.length === 0
        ? "Nothing on the belt."
        : `On the belt: ${items.map(([n, q]) => `${n} x${q}`).join(", ")}.`,
    );
  }
  if (e.fluids) {
    const fluids = Object.entries(e.fluids);
    if (fluids.length > 0) {
      parts.push(`Fluids: ${fluids.map(([n, q]) => `${n} ${num(q)}`).join(", ")}.`);
    }
  }
  if (e.no_fluids) parts.push("Fluid system: completely empty.");
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

function formatScan(res: ScanAreaResult): string {
  const lines: string[] = [];
  lines.push(
    `Scanned ${res.width}x${res.height} tiles. Grid origin (top-left corner) is map ` +
      `(${res.origin.x}, ${res.origin.y}); the tile at grid[row][col] is map ` +
      `(${res.origin.x} + col, ${res.origin.y} + row). Rows run north to south, columns west to east.`,
  );
  lines.push("```");
  lines.push(...asArray(res.grid));
  lines.push("```");
  const legend = Object.entries(res.legend ?? {});
  if (legend.length > 0) {
    lines.push("Legend:");
    for (const [symbol, meaning] of legend) lines.push(`${symbol} = ${meaning}`);
  }
  if (res.note) lines.push(res.note);
  return lines.join("\n");
}

const offsetStr = (o: { x: number; y: number }): string => `(${o.x}, ${o.y})`;

function formatPrototype(name: string, p: PrototypeInfo): string {
  if (p.kind === "recipe") {
    const fmt = (r: Record<string, number> | Record<string, never> | undefined): string =>
      Object.entries(r ?? {})
        .map(([n, q]) => `${q}x ${n}`)
        .join(" + ") || "nothing";
    const bits = [`recipe ${fmt(p.ingredients)} -> ${fmt(p.products)}`];
    if (typeof p.energy === "number") bits.push(`${p.energy}s craft time`);
    if (p.category) bits.push(`category ${p.category}`);
    if (p.enabled === false) bits.push("NOT unlocked yet (needs research)");
    return `${name}: ${bits.join(", ")}`;
  }
  if (p.kind !== "entity") {
    return `${name}: unknown — no item, entity or recipe by this name; check the exact internal name (lowercase-with-dashes)`;
  }
  const bits: string[] = [`entity ${p.tile_width ?? "?"}x${p.tile_height ?? "?"}`];
  if (p.entity && p.entity !== name) bits.push(`places entity "${p.entity}"`);
  if (p.placed_by_item && p.placed_by_item !== name) {
    bits.push(`place with item "${p.placed_by_item}"`);
  }
  if (p.energy === "burner") {
    const fuels = asArray(p.fuel_categories);
    bits.push(`burner (${fuels.length > 0 ? fuels.join("/") : "chemical"} fuel)`);
  } else if (typeof p.energy === "string") {
    bits.push(`${p.energy} powered`);
  }
  if (p.mining_speed !== undefined) bits.push(`mining speed ${p.mining_speed}`);
  if (p.drop_offset) {
    bits.push(
      `drops output at offset ${offsetStr(p.drop_offset)} when facing north — rotate the offset with the direction`,
    );
  }
  if (p.inserter_pickup_offset && p.inserter_drop_offset) {
    bits.push(
      `picks up at offset ${offsetStr(p.inserter_pickup_offset)} and drops at ` +
        `${offsetStr(p.inserter_drop_offset)} when facing north — both rotate with the direction`,
    );
  }
  const crafts = asArray(p.crafting_categories);
  if (crafts.length > 0) bits.push(`crafts categories: ${crafts.join(", ")}`);
  if (p.range !== undefined) bits.push(`range ${p.range}`);
  if (p.belt_speed !== undefined) bits.push(`belt speed ${p.belt_speed}`);
  return `${name}: ${bits.join(", ")}`;
}


/** Wraps a typed run function into a ToolSpec: re-validates args with the
 *  schema and converts any failure into an "Error: ..." string. */
function formatImported(bp: ImportedBlueprint): string {
  const entities = asArray(bp.entities);
  // Print the WHOLE window: build_plan needs every position, and the window
  // size is already capped mod-side (default 100, max 200).
  const lines = entities.map(
    (e) =>
      `  ${e.name} at +(${e.position.x}, ${e.position.y})${e.direction ? ` dir ${e.direction}` : ""}${e.recipe ? ` recipe ${e.recipe}` : ""}`,
  );
  const needed = Object.entries(bp.items_needed ?? {})
    .map(([n, c]) => `${n} x${c}`)
    .join(", ");
  const skipped = asArray((bp.skipped as string[] | undefined) ?? []);
  const total = bp.total_entities ?? entities.length;
  const offset = bp.offset ?? 0;
  const windowNote =
    total > entities.length
      ? ` Showing entities ${offset + 1}–${offset + entities.length} of ${total}.`
      : "";
  return [
    `Blueprint${bp.label ? ` "${bp.label}"` : ""}: ${total} entities, ${bp.size.w}x${bp.size.h} tiles footprint. Positions are RELATIVE — add your anchor before building.${windowNote}`,
    ...lines,
    bp.next_offset !== undefined
      ? `… more entities follow — build this batch, then read again with offset=${bp.next_offset} and the SAME anchor.`
      : "",
    `Items needed (whole print): ${needed || "none"}.`,
    skipped.length > 0 ? `Skipped (unknown here): ${skipped.join(", ")}.` : "",
    bp.tiles
      ? `Also ${bp.tiles.count} floor tiles (${asArray(bp.tiles.kinds).join(", ")}) — no tool places tiles, so the ground must already be walkable/buildable.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const companionField = z
  .string()
  .max(20)
  .optional()
  .describe(
    'which companion performs this (default "AI"); other_companions in look_around lists the crew',
  );

const backgroundField = z
  .boolean()
  .optional()
  .describe(
    "action tasks only: true = don't wait — returns 'queued as task #N' immediately and the " +
      "outcome arrives later as an [event]. USE THIS to run several companions in parallel",
  );

function spec<S extends z.ZodObject<z.ZodRawShape>>(
  name: string,
  description: string,
  schema: S,
  run: (bridge: Bridge, args: z.infer<S>) => Promise<string>,
): ToolSpec {
  // Every tool accepts optional `companion` and `background`; a scoped bridge
  // injects/handles them, so individual tools stay agnostic of both.
  const fullSchema = schema.extend({ companion: companionField, background: backgroundField });
  return {
    name,
    description,
    schema: fullSchema,
    execute: async (bridge, args) => {
      try {
        const parsed = fullSchema.parse(args);
        const { companion: companionName, background } = parsed as {
          companion?: string;
          background?: boolean;
        };
        let scoped = companionName ? bridge.scoped(companionName) : bridge;
        if (background) {
          // Fire-and-forget: swap enqueueAndWait for a plain enqueue; the mod
          // pushes a task_done/task_failed event when the task finishes.
          const base = scoped;
          scoped = Object.create(base) as Bridge;
          scoped.enqueueAndWait = async (task, opts) => {
            const res = await base.call<{ task_id: number; companion: string }>("enqueue", {
              task,
              replace: opts?.replace ?? false,
              background: true,
            });
            return `Queued in background as task #${res.task_id} for ${res.companion} — the outcome will arrive as an [event]. You can issue more orders right away.`;
          };
        }
        return await run(scoped, parsed as z.infer<S>);
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
      "check_inventory",
      'Quick inventory peek, much lighter than look_around: your own by default, another companion\'s via companion:"Anna", or A PLAYER\'s via player:"name" — use the player option to see what the player already carries before crafting or delivering for them.',
      z.object({
        player: z
          .string()
          .optional()
          .describe("player name — read THEIR inventory instead of a companion's"),
      }),
      async (bridge, { player }) => {
        const res = await bridge.call<{
          owner: string;
          inventory: Record<string, number> | Record<string, never>;
          equipment?: EquipResult;
        }>("check_inventory", { player });
        const inv = Object.entries(res.inventory ?? {});
        const parts = [
          `${res.owner}: ${inv.length > 0 ? inv.map(([n, q]) => `${n} x${q}`).join(", ") : "empty inventory"}.`,
        ];
        if (res.equipment) {
          const ammo = Object.entries(res.equipment.ammo ?? {});
          parts.push(
            `Equipped — gun: ${res.equipment.gun ?? "none"}; ammo: ${
              ammo.length > 0 ? ammo.map(([n, q]) => `${n} x${q}`).join(", ") : "none"
            }; armor: ${res.equipment.armor ?? "none"}.`,
          );
        }
        return parts.join(" ");
      },
    ),

    spec(
      "inspect_entity",
      "Inspect ONE entity near a map position (searched within 1.5 tiles): type, status, recipe, crafting progress, inventory contents, items sitting ON a belt (transport lines), and fluids inside pipes/tanks/machines (or that the fluid system is dry). Use it to check machines, chests, belts and pipes — never run raw console commands for this. Returns a plain-text report.",
      z.object({ x: z.number(), y: z.number() }),
      async (bridge, { x, y }) =>
        formatInspect(await bridge.call<InspectResult>("inspect", { position: { x, y } })),
    ),

    spec(
      "scan_area",
      "Scan a square of the map into a tile-by-tile ASCII grid — this is your main spatial sense. Use it BEFORE building (to find free ground, water, trees, ore, existing machines) and AFTER building (to verify what actually got placed). One character = one tile; rows run north to south, columns west to east; the tile at grid[row][col] is map coordinate (origin.x + col, origin.y + row), with the origin given in the result. The legend explains every symbol (uppercase letters = resources, lowercase = buildings, @ = you). Defaults to a 15-tile radius around you.",
      z.object({
        x: z.number().optional().describe("scan center x; defaults to your position"),
        y: z.number().optional().describe("scan center y; defaults to your position"),
        radius: z
          .number()
          .int()
          .min(5)
          .max(30)
          .optional()
          .describe("half-width of the scan square in tiles, default 15"),
      }),
      async (bridge, { x, y, radius }) => {
        if ((x === undefined) !== (y === undefined)) {
          return "Error: give both x and y for the scan center, or neither to scan around yourself.";
        }
        const center = x !== undefined && y !== undefined ? { x, y } : undefined;
        return formatScan(await bridge.call<ScanAreaResult>("scan_area", { center, radius }));
      },
    ),

    spec(
      "describe_prototype",
      "Look up the exact geometry and stats of up to 10 item/entity/recipe names: footprint in tiles, where a mining drill drops its output (offset given for facing north — rotate it with the direction), inserter pickup/drop arm offsets, power/fuel type, and recipe ingredients/products/craft time. ALWAYS check every entity type before placing it — guessed sizes and offsets produce misaligned builds. Returns one compact line per name.",
      z.object({
        names: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe('internal names, e.g. ["burner-mining-drill", "inserter", "iron-gear-wheel"]'),
      }),
      async (bridge, { names }) => {
        const res = await bridge.call<DescribePrototypesResult>("describe_prototype", { names });
        return names
          .map((n) => {
            const info = res[n];
            return info
              ? formatPrototype(n, info)
              : `${n}: unknown — no item, entity or recipe by this name; check the exact internal name (lowercase-with-dashes)`;
          })
          .join("\n");
      },
    ),

    spec(
      "analyze_factory",
      "Diagnose everything that's stuck in an area in ONE call: machines grouped by problem (no power, low power, no fuel, missing ingredients — with WHICH ingredient when detectable, output full, drill on depleted ore, idle labs) plus a power-grid summary. ALWAYS prefer this over inspecting machines one by one when the player asks what's wrong with the factory.",
      z.object({
        radius: z.number().min(5).max(80).optional().describe("area radius in tiles, default 40"),
      }),
      async (bridge, { radius }) => {
        const r = await bridge.call<AnalyzeFactoryResult>("analyze_factory", { radius });
        const lines: string[] = [];
        lines.push(
          `Checked ${r.machines_checked} machine(s) within ${r.radius} tiles: ${r.working} working.`,
        );
        for (const p of asArray(r.problems)) {
          const missing = p.missing ? ` — missing: ${p.missing}` : "";
          lines.push(
            `${p.count}x ${p.name}: ${p.problem.replace(/_/g, " ")}${missing} (e.g. at (${p.sample.x}, ${p.sample.y}))`,
          );
        }
        if (asArray(r.problems).length === 0) lines.push("No stuck machines found.");
        if (r.power) {
          const pw = r.power;
          lines.push(
            `Power: ${num(pw.production_kw ?? 0)} kW produced, ${num(pw.consumption_kw ?? 0)} kW consumed across ${pw.networks} network(s).`,
          );
        }
        return lines.join("\n");
      },
    ),

    spec(
      "can_place",
      "Dry-run check whether an item could be placed at a position, with no side effects. Answers yes, or no with the blocker when it can be identified. Use it to spot-check the tricky positions of a build (next to water, trees, ore borders, existing machines) before committing a build_plan.",
      z.object({
        item: z.string().describe('item name, e.g. "stone-furnace"'),
        x: z.number(),
        y: z.number(),
        direction: directionField,
      }),
      async (bridge, { item, x, y, direction }) => {
        const res = await bridge.call<CanPlaceResult>("can_place", {
          item,
          position: { x, y },
          direction,
        });
        if (res.can_place) return `Yes — ${item} can be placed at (${x}, ${y}).`;
        const reason = res.reason ?? "the spot is blocked";
        return `No — ${reason}. Try a nearby tile, or clear the blocker first.`;
      },
    ),

    spec(
      "find_buildable_area",
      "Find the nearest width x height rectangle of open buildable land (no water, cliffs or entities) near a point. Trees are allowed inside but counted, so you can mine them before building. Returns the rectangle's center and top-left map coordinates. Errors when no such rectangle exists within max_distance.",
      z.object({
        width: z.number().int().min(1).max(50),
        height: z.number().int().min(1).max(50),
        x: z.number().describe("search around this x"),
        y: z.number().describe("search around this y"),
        max_distance: z
          .number()
          .min(5)
          .max(100)
          .optional()
          .describe("how far from (x, y) to search, in tiles (default 50)"),
      }),
      async (bridge, { width, height, x, y, max_distance }) => {
        const res = await bridge.call<BuildableArea>("find_buildable_area", {
          width,
          height,
          near: { x, y },
          max_distance,
        });
        const trees =
          res.trees_in_area > 0
            ? ` ${res.trees_in_area} tree(s) stand inside — mine them before building there.`
            : " No trees inside.";
        return (
          `Found a ${width}x${height} buildable area: top-left (${res.top_left.x}, ${res.top_left.y}), ` +
          `center (${res.center.x}, ${res.center.y}).${trees}`
        );
      },
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
      "drive_to",
      "Drive a car to a map position — MUCH faster than walking for long distances. Boards the nearest free car first (fueling it from your inventory if needed). Cars can't cross water and don't path around big obstacles: on a stuck report, walk instead or pick a clearer route. You stay in the car on arrival.",
      z.object({
        x: z.number(),
        y: z.number(),
        arrive_within: z.number().min(2).max(15).optional().describe("parking tolerance in tiles, default 3"),
      }),
      async (bridge, { x, y, arrive_within }) =>
        bridge.enqueueAndWait(
          { type: "drive_to", target: { x, y }, arrive_within },
          { replace: true, timeoutMs: 240_000 },
        ),
    ),

    spec(
      "exit_vehicle",
      "Get out of the vehicle you're currently driving. (Walking tasks also hop out automatically.)",
      z.object({}),
      async (bridge) => {
        const res = await bridge.call<{ exited: string; position: { x: number; y: number } }>(
          "exit_vehicle", {});
        return `Out of the ${res.exited} at (${res.position.x.toFixed(1)}, ${res.position.y.toFixed(1)}).`;
      },
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
      'Hand-craft items using your character crafting queue (e.g. recipe "iron-gear-wheel"). FOR BOOTSTRAP AND ONE-OFFS ONLY: anything you need repeatedly should come from an assembling machine with set_recipe plus inserters — build the line instead of crafting the same thing again. Missing intermediates are crafted automatically when possible; otherwise the error lists exactly which ingredients you are short of. Takes real time.',
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
      "Move items from your inventory INTO a machine, chest or furnace at the given position (fuel lands in the fuel slot, ingredients in the input). You auto-walk within reach first. Partial inserts are reported. NOTE: hand-feeding the same machine repeatedly is a treadmill — build a drill/inserter/belt to feed it automatically (or keep_fueled duty for fuel) after the first top-up.",
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
      "keep_fueled",
      "Start a PERSISTENT caretaker duty: watch the burner machines (furnaces, drills, boilers...) around a point and top them up with fuel from your inventory whenever they run low. Keeps running until stop — like follow_player, it replaces what you were doing, and you should carry plenty of coal first. You'll announce in chat if you run out of fuel to hand out.",
      z.object({
        x: z.number().optional().describe("anchor x (default: where you stand now)"),
        y: z.number().optional().describe("anchor y (default: where you stand now)"),
        radius: z.number().min(5).max(40).optional().describe("area radius, default 24"),
        fuel: z.string().optional().describe('only hand out this fuel item, e.g. "coal"'),
      }),
      async (bridge, { x, y, radius, fuel }) => {
        const center = x !== undefined && y !== undefined ? { x, y } : undefined;
        await bridge.call<{ task_id: number }>("enqueue", {
          task: { type: "keep_fueled", center, radius, fuel } satisfies Task,
          replace: true,
        });
        return `On fuel duty${center ? ` around (${x}, ${y})` : " here"} (radius ${radius ?? 24}). Call stop to end it.`;
      },
    ),

    spec(
      "deliver_items",
      'Bring items from your inventory TO A PLAYER and hand them over (e.g. after mining or crafting for them). You chase the player even if they move. Pass items for specific counts, or all: true to hand over everything you carry. This is how "portami X / bring me X" requests end.',
      z.object({
        items: itemsField.optional(),
        all: z.boolean().optional().describe("hand over your entire inventory"),
        player: z.string().optional().describe("player name; defaults to the first connected player"),
      }),
      async (bridge, { items, all, player }) => {
        if (!items && !all) {
          return "Error: say what to deliver — items with counts, or all: true.";
        }
        return bridge.enqueueAndWait(
          { type: "deliver", items, all, player },
          { timeoutMs: 240_000 },
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
      "build_plan",
      "Build MANY entities in one go — the main way to construct anything multi-entity (mining setups, smelting rows, belt runs...). YOU compute the coordinates: scan_area for the ground truth, describe_prototype for every entity type's footprint and offsets, then list the steps in build order. Steps run sequentially with auto-walking; a failed step is reported and skipped (set stop_on_error to abort instead). Each step can also set a recipe and insert items (e.g. fuel) into what it just placed. The result says how many were placed and exactly which steps failed and why.",
      z.object({
        steps: z
          .array(
            z.object({
              item: z.string().describe('item to place, e.g. "burner-mining-drill"'),
              x: z.number(),
              y: z.number(),
              direction: directionField,
              recipe: z.string().optional().describe("recipe to set on the placed machine"),
              insert: itemsField.optional().describe("items to load into the placed entity (fuel, ingredients)"),
            }),
          )
          .min(1)
          .max(100),
        stop_on_error: z.boolean().optional().describe("abort at the first failed step (default: skip and continue)"),
      }),
      async (bridge, { steps, stop_on_error }) => {
        const task: Task = {
          type: "build_plan",
          stop_on_error,
          steps: steps.map((s) => ({
            item: s.item,
            position: { x: s.x, y: s.y },
            direction: s.direction,
            recipe: s.recipe,
            insert: s.insert,
          })),
        };
        return bridge.enqueueAndWait(task, { timeoutMs: 60_000 + steps.length * 20_000 });
      },
    ),

    spec(
      "deconstruct",
      "Demolish OUR OWN buildings, recovering them (and their contents) into your inventory. CONSENT RULE: only set confirm=true when the player explicitly asked for demolition in their recent messages — never demolish on your own initiative; if in doubt, ask via say first. Give x+y for the single nearest building, or area_radius to clear everything around that point (max 50 buildings). Trees/rocks/ore are mined with the mine tool instead.",
      z.object({
        x: z.number(),
        y: z.number(),
        area_radius: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .describe("demolish every building within this radius instead of just the nearest one"),
        confirm: z
          .boolean()
          .describe("must be true, and only after the player explicitly asked for demolition"),
      }),
      async (bridge, { x, y, area_radius, confirm }) => {
        const task: Task =
          area_radius !== undefined
            ? { type: "deconstruct", confirm, area: { center: { x, y }, radius: area_radius } }
            : { type: "deconstruct", confirm, target: { x, y } };
        return bridge.enqueueAndWait(task, { timeoutMs: 90_000 + (area_radius !== undefined ? 500_000 : 0) });
      },
    ),

    spec(
      "equip",
      'Equip a gun, ammo and/or armor from your main inventory into your equipment slots (e.g. gun "pistol", ammo "firearm-magazine", armor "light-armor"). Required before fight. Craft or ask for the items first if you have none. Returns what you now have equipped.',
      z.object({
        gun: z.string().optional(),
        ammo: z.string().optional(),
        armor: z.string().optional(),
      }),
      async (bridge, { gun, ammo, armor }) => {
        const res = await bridge.call<EquipResult>("equip", { gun, ammo, armor });
        const ammoText = res.ammo && Object.keys(res.ammo).length > 0
          ? Object.entries(res.ammo).map(([n, c]) => `${n} x${c}`).join(", ")
          : "no ammo";
        return `Equipped — gun: ${res.gun ?? "none"}, ammo: ${ammoText}, armor: ${res.armor ?? "none"}.`;
      },
    ),

    spec(
      "fight",
      "Fight enemies (biters, spawners, worms) around a point: you walk into gun range, shoot, and move target to target until the area is clear. Anchored — you won't chase beyond the radius. You retreat automatically toward the player when badly hurt. Requires a gun and ammo equipped (use equip first). Only fight when the player asks or enemies threaten the factory. Takes real time; !stop aborts.",
      z.object({
        x: z.number().optional().describe("anchor x (default: your position)"),
        y: z.number().optional().describe("anchor y (default: your position)"),
        radius: z.number().min(5).max(40).optional().describe("how far around the anchor to clear, default 20"),
        flee_below: z
          .number()
          .min(0.05)
          .max(0.9)
          .optional()
          .describe("retreat when health fraction drops below this (default 0.3)"),
      }),
      async (bridge, { x, y, radius, flee_below }) => {
        const target = x !== undefined && y !== undefined ? { x, y } : undefined;
        return bridge.enqueueAndWait(
          { type: "fight", target, radius, flee_below },
          { timeoutMs: 300_000 },
        );
      },
    ),

    spec(
      "defend_area",
      "Start PERSISTENT garrison duty around a point: shoot enemies that come near, refill ammo turrets from your main inventory, and repair damaged structures (consumes repair packs). Needs a gun equipped. Runs until stop; replaces what you were doing. Stock up on magazines and repair packs first — you'll announce in chat when supplies run out.",
      z.object({
        x: z.number().optional().describe("anchor x (default: where you stand now)"),
        y: z.number().optional().describe("anchor y (default: where you stand now)"),
        radius: z.number().min(8).max(32).optional().describe("area radius, default 16"),
      }),
      async (bridge, { x, y, radius }) => {
        const center = x !== undefined && y !== undefined ? { x, y } : undefined;
        await bridge.call<{ task_id: number }>("enqueue", {
          task: { type: "defend_area", center, radius } satisfies Task,
          replace: true,
        });
        return `On guard duty${center ? ` around (${x}, ${y})` : " here"} (radius ${radius ?? 16}). Call stop to end it.`;
      },
    ),

    spec(
      "import_blueprint",
      "Decode a Factorio blueprint export string (the 0eNq… text) into its entity list: names, RELATIVE positions (top-left entity at 0,0), directions, recipes, plus the total items needed. It does NOT build — pick an anchor spot (find_buildable_area helps), ADD the anchor coordinates to every relative position, and feed the result to build_plan once you have the items. Big prints come in windows: repeat with the returned next offset and the SAME anchor.",
      z.object({
        string: z.string().min(10).describe("the blueprint export string"),
        offset: z.number().int().min(0).optional().describe("skip this many entities (0-based; default 0)"),
        limit: z.number().int().min(1).max(200).optional().describe("window size (default 100 — one build_plan batch)"),
      }),
      async (bridge, { string, offset, limit }) =>
        formatImported(
          await bridge.call<ImportedBlueprint>("import_blueprint", { string, offset, limit }),
        ),
    ),

    spec(
      "list_blueprints",
      "List every blueprint the AI can reach WITHOUT the player pasting anything: the STARTER BOOKS in the default companion's inventory (a curated library of power/smelting/bus/rail designs — check here before designing from scratch), whatever the player holds on the cursor or carries, and every blueprint book (nested books included). Returns labels + where each print lives. The library WINDOW itself is invisible to mods — the player shares prints by holding or carrying them.",
      z.object({
        player: z.string().optional().describe("player name; defaults to the first connected player"),
      }),
      async (bridge, { player }) => {
        const res = await bridge.call<{
          blueprints:
            | Array<{ label?: string; where: string; book?: string; entity_count: number }>
            | Record<string, never>;
          total?: number;
          note: string;
        }>("list_blueprints", { player });
        const bps = asArray(res.blueprints);
        if (bps.length === 0) {
          return "No blueprints reachable. Ask the player to hold one on the cursor (from the library) or keep some in their inventory/a book — or paste an export string (import_blueprint).";
        }
        // Group by container (inventory/book path) so 100+ prints stay readable.
        const groups = new Map<string, typeof bps>();
        for (const b of bps) {
          const group = groups.get(b.where);
          if (group) group.push(b);
          else groups.set(b.where, [b]);
        }
        const lines: string[] = [];
        for (const [where, group] of groups) {
          const only = group.length === 1 ? group[0] : undefined;
          if (only) {
            lines.push(`"${only.label ?? "(unnamed)"}" (${only.entity_count} entities) — ${where}`);
          } else {
            lines.push(`${where} — ${group.length} prints:`);
            lines.push(
              "  " + group.map((b) => `"${b.label ?? "(unnamed)"}" (${b.entity_count})`).join(", "),
            );
          }
        }
        const total = res.total ?? bps.length;
        if (total > bps.length) lines.push(`… and ${total - bps.length} more not shown.`);
        lines.push("Read one with read_blueprint {label} (add book to disambiguate duplicates).");
        return lines.join("\n");
      },
    ),

    spec(
      "read_blueprint",
      'Decode one reachable blueprint by label (see list_blueprints — the starter books count), or whatever the player is HOLDING on the cursor when label is omitted — the natural flow for "costruisci questa qui". Same output as import_blueprint: RELATIVE positions to anchor and feed to build_plan, plus the whole print\'s item bill. Big prints come in windows of 100: build the batch, then call again with the returned next offset and the SAME anchor.',
      z.object({
        label: z.string().optional().describe("blueprint label (case-insensitive, partial ok); omit = the held one"),
        book: z
          .string()
          .optional()
          .describe("only look inside books whose name matches this (case-insensitive, partial ok)"),
        offset: z.number().int().min(0).optional().describe("skip this many entities (0-based; default 0)"),
        limit: z.number().int().min(1).max(200).optional().describe("window size (default 100 — one build_plan batch)"),
        player: z.string().optional().describe("player name; defaults to the first connected player"),
      }),
      async (bridge, { label, book, offset, limit, player }) => {
        const bp = await bridge.call<ImportedBlueprint & { where?: string }>("read_blueprint", {
          label,
          book,
          offset,
          limit,
          player,
        });
        return (bp.where ? `Source: ${bp.where}.\n` : "") + formatImported(bp);
      },
    ),

    spec(
      "list_trains",
      "Overview of every train on the surface (id, state, manual/automatic, locomotives+wagons, position, current station, schedule, cargo) plus the list of existing train stop names. Use it before set_train_schedule. Rails, stops and locomotives are BUILT with the normal build tools (build_plan/place_entity); this manages what's on the rails.",
      z.object({}),
      async (bridge) => {
        const res = await bridge.call<{
          trains: Array<Record<string, unknown>>;
          stations: string[] | Record<string, never>;
        }>("list_trains", {});
        const trains = asArray(res.trains as never[]) as Array<any>;
        const stations = asArray(res.stations);
        const lines: string[] = [];
        if (trains.length === 0) lines.push("No trains on this surface.");
        for (const t of trains) {
          const bits = [
            `train #${t.id}: ${t.locomotives ?? "?"} loco + ${t.wagons ?? 0} wagon(s)`,
            t.manual ? "MANUAL mode" : "automatic",
            `state ${String(t.state).replace(/_/g, " ")}`,
          ];
          if (t.position) bits.push(`at (${t.position.x}, ${t.position.y})`);
          if (t.at_station) bits.push(`stopped at "${t.at_station}"`);
          if (t.schedule) bits.push(`route: ${(t.schedule as string[]).join(" → ")}`);
          if (t.cargo) {
            bits.push(
              `cargo: ${Object.entries(t.cargo as Record<string, number>)
                .map(([n, c]) => `${n} x${c}`)
                .join(", ")}`,
            );
          }
          lines.push(bits.join("; "));
        }
        lines.push(
          stations.length > 0
            ? `Train stops: ${stations.map((s) => `"${s}"`).join(", ")}.`
            : "No train stops built yet.",
        );
        return lines.join("\n");
      },
    ),

    spec(
      "set_train_schedule",
      'Set a train\'s route and switch it to automatic. Each stop is an existing train-stop NAME (see list_trains) with a wait condition: "full" (until loaded), "empty" (until unloaded), or a number of seconds (default 5). Locomotives need fuel — the result warns when the train has none.',
      z.object({
        train_id: z.number().int().describe("train id from list_trains"),
        stops: z
          .array(
            z.object({
              station: z.string().describe("exact train stop name (case matters)"),
              wait: z
                .union([z.literal("full"), z.literal("empty"), z.number().positive()])
                .optional()
                .describe('"full" | "empty" | seconds (default 5s)'),
            }),
          )
          .min(1)
          .max(10),
      }),
      async (bridge, { train_id, stops }) => {
        const res = await bridge.call<{
          train_id: number;
          stops: number;
          running: boolean;
          fueled: boolean;
        }>("set_train_schedule", { train_id, stops });
        const fuel = res.fueled ? "" : " WARNING: no fuel in its locomotives — load some or it won't move.";
        return `Train #${res.train_id} set to automatic with ${res.stops} stop(s).${fuel}`;
      },
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
      'Spawn a companion character (or locate an existing one). Use after dying, AND to create ADDITIONAL companions: pass a new name (e.g. "Anna") to add one to the crew — up to 4, each with its own color, label and task queue. Every action tool then takes companion:"Anna" to direct that body. Spawns near a connected player.',
      z.object({
        name: z
          .string()
          .max(20)
          .optional()
          .describe('companion name; default "AI". A NEW name creates a NEW companion'),
      }),
      async (bridge, { name }) => {
        const res = await bridge.call<SpawnResult>("spawn_companion", { name });
        const at = `(${res.position.x}, ${res.position.y})`;
        const who = res.name ?? name ?? "AI";
        return res.already_existed
          ? `${who} already has a body — it is at ${at}.`
          : `${who} spawned at ${at}.`;
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
