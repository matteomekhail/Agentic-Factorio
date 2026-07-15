// Live integration test against a real Factorio server with the mod loaded.
// Covers the full PROTOCOL.md v2 surface (M1+M2): transport (incl. chunking),
// perception, pathfinder walking, composite mining, building, crafting,
// transfers, recipes, rotation, research, death+respawn, task bookkeeping.
// Not picked up by vitest (no .test suffix) — run with:
//   npx tsx test/integration-live.ts [host] [port] [password]
// Requires a server with auto_pause=false (see docs/FACTORIO-NOTES.md).
import { Bridge } from "../src/bridge.js";
import { RconClient } from "../src/rcon.js";
import {
  asArray,
  type GetStateResult,
  type PingResult,
  type SpawnResult,
} from "../src/types.js";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 27099);
const password = process.argv[4] ?? "agentic-it-pass";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const rcon = new RconClient({ host, port, password, timeoutMs: 15_000 });
  await rcon.connect();
  const bridge = new Bridge(rcon);
  await bridge.unlock();
  // Raw console Lua runs in the __level__ state (mod storage NOT visible).
  const lua = async (code: string): Promise<string> =>
    (await rcon.exec(`/silent-command ${code}`)).trim();

  const state = () => bridge.call<GetStateResult>("get_state", {});
  const inventory = async (): Promise<Record<string, number>> =>
    (await state()).companion?.inventory ?? {};
  const findChar = `game.surfaces[1].find_entities_filtered{name="character", limit=1}[1]`;

  // The server saves on graceful shutdown, so state accumulates across runs —
  // wipe previous test artifacts (built structures, planted ore) up front.
  await bridge.call("cancel", { all: true }).catch(() => {});
  await lua(`local s = game.surfaces[1]
    for _, e in pairs(s.find_entities_filtered{force = "player"}) do e.destroy() end
    for _, e in pairs(s.find_entities_filtered{name = "copper-ore"}) do e.destroy() end
    local f = game.forces.player
    f.research_queue = {}
    f.technologies["automation"].researched = false
    f.technologies["automation-science-pack"].researched = false
    rcon.print("arena reset")`);

  // ---------- transport ----------
  const ping = await bridge.call<PingResult>("ping");
  check("ping", /^\d+\.\d+\.\d+$/.test(ping.mod_version),
    `factorio ${ping.factorio_version}, mod ${ping.mod_version}, tick ${ping.tick}`);

  const echo = await bridge.call<{ data: string }>("echo", { size: 12_000 });
  check("chunked echo 12kB", echo.data.length === 12_000 && /^x+$/.test(echo.data.slice(0, 50)),
    `${echo.data.length} bytes reassembled`);

  // ---------- companion lifecycle ----------
  const spawn = await bridge.call<SpawnResult>("spawn_companion", {});
  check("spawn_companion", typeof spawn.unit_number === "number",
    `at (${spawn.position.x}, ${spawn.position.y}) existed=${spawn.already_existed}`);

  await bridge.call("say", { text: "integration v2 online" });

  // ---------- perception v2 ----------
  const s1 = await state();
  check("get_state v2 shape",
    !!s1.companion && Array.isArray(asArray(s1.resource_patches)) && typeof s1.trees_nearby === "number",
    `patches=${asArray(s1.resource_patches).length} structures=${asArray(s1.structures).length} trees=${s1.trees_nearby}`);

  const cx = s1.companion!.position.x;
  const cy = s1.companion!.position.y;

  // ---------- pathfinder walk ----------
  const walkDetail = await bridge.enqueueAndWait(
    { type: "walk_to", target: { x: cx + 25, y: cy + 15 } },
    { timeoutMs: 120_000 },
  );
  const s2 = await state();
  const p2 = s2.companion!.position;
  check("walk_to (pathfinder, 29 tiles)",
    Math.hypot(p2.x - (cx + 25), p2.y - (cy + 15)) <= 1.6, walkDetail);

  // ---------- composite mine (auto-walk + multiple entities) ----------
  await lua(`local s = game.surfaces[1]
    for i = 0, 2 do s.create_entity{name="copper-ore", amount=3, position={${p2.x + 8} + i, ${p2.y}}} end
    rcon.print("ok")`);
  const invBefore = await inventory();
  const mineDetail = await bridge.enqueueAndWait(
    { type: "mine", resource: "copper-ore", count: 6 },
    { timeoutMs: 180_000 },
  );
  const invAfterMine = await inventory();
  const copperGained = (invAfterMine["copper-ore"] ?? 0) - (invBefore["copper-ore"] ?? 0);
  check("mine composite 6x copper-ore (auto-walk, 3 deposits)", copperGained >= 6,
    `gained ${copperGained} — ${mineDetail}`);

  // ---------- place (auto-walk + item accounting) ----------
  await lua(`local c = ${findChar}
    c.get_main_inventory().insert{name="stone-furnace", count=1}
    c.get_main_inventory().insert{name="transport-belt", count=1}
    c.get_main_inventory().insert{name="assembling-machine-1", count=1}
    c.get_main_inventory().insert{name="coal", count=10}
    c.get_main_inventory().insert{name="iron-plate", count=10}
    rcon.print("ok")`);
  // Let the engine pick free, buildable spots (dodges trees, water, leftovers).
  const spotsRaw = await lua(`local s = game.surfaces[1]
    local c = ${findChar}
    for _, e in pairs(s.find_entities_filtered{position = c.position, radius = 14, type = {"tree", "simple-entity"}}) do e.destroy() end
    local f = s.find_non_colliding_position("stone-furnace", {c.position.x + 6, c.position.y}, 24, 0.5)
    local a = s.find_non_colliding_position("assembling-machine-1", {c.position.x + 10, c.position.y + 5}, 24, 0.5)
    local b = s.find_non_colliding_position("transport-belt", {c.position.x + 4, c.position.y - 5}, 24, 0.5)
    rcon.print(helpers.table_to_json({f = {x = f.x, y = f.y}, a = {x = a.x, y = a.y}, b = {x = b.x, y = b.y}}))`);
  const spots = JSON.parse(spotsRaw) as Record<"f" | "a" | "b", { x: number; y: number }>;
  const fx = spots.f.x;
  const fy = spots.f.y;
  const placeDetail = await bridge.enqueueAndWait(
    { type: "place", item: "stone-furnace", position: { x: fx, y: fy } },
    { timeoutMs: 60_000 },
  );
  const placed = await lua(
    `local e = game.surfaces[1].find_entities_filtered{name="stone-furnace", position={${fx},${fy}}, radius=1}[1]
     rcon.print(e and "placed" or "missing")`);
  const invAfterPlace = await inventory();
  check("place stone-furnace", placed === "placed" && !("stone-furnace" in invAfterPlace),
    `${placeDetail}; item consumed=${!("stone-furnace" in invAfterPlace)}`);

  // ---------- insert / extract ----------
  const insertDetail = await bridge.enqueueAndWait(
    { type: "insert", target: { x: fx, y: fy }, items: { coal: 5 } },
    { timeoutMs: 60_000 },
  );
  const inspFurnace = await bridge.call<any>("inspect", { position: { x: fx, y: fy } });
  const fuelCoal = inspFurnace?.inventories?.fuel?.coal ?? 0;
  check("insert 5 coal into furnace", fuelCoal === 5, `${insertDetail}; fuel=${JSON.stringify(inspFurnace?.inventories?.fuel)}`);

  const extractDetail = await bridge.enqueueAndWait(
    { type: "extract", target: { x: fx, y: fy }, items: { coal: 2 } },
    { timeoutMs: 60_000 },
  );
  const inspFurnace2 = await bridge.call<any>("inspect", { position: { x: fx, y: fy } });
  check("extract 2 coal back", (inspFurnace2?.inventories?.fuel?.coal ?? 0) === 3, extractDetail);

  // ---------- inspect ----------
  check("inspect furnace fields",
    inspFurnace?.name === "stone-furnace" && inspFurnace?.type === "furnace",
    `name=${inspFurnace?.name} status=${inspFurnace?.status}`);

  // ---------- place assembler + set_recipe + rotate belt ----------
  const ax = spots.a.x;
  const ay = spots.a.y;
  await bridge.enqueueAndWait(
    { type: "place", item: "assembling-machine-1", position: { x: ax, y: ay } },
    { timeoutMs: 60_000 },
  );
  const recipeDetail = await bridge.enqueueAndWait(
    { type: "set_recipe", target: { x: ax, y: ay }, recipe: "iron-gear-wheel" },
    { timeoutMs: 60_000 },
  );
  const inspAsm = await bridge.call<any>("inspect", { position: { x: ax, y: ay } });
  check("set_recipe iron-gear-wheel", inspAsm?.recipe === "iron-gear-wheel", recipeDetail);

  const bx = spots.b.x;
  const by = spots.b.y;
  await bridge.enqueueAndWait(
    { type: "place", item: "transport-belt", position: { x: bx, y: by }, direction: 0 },
    { timeoutMs: 60_000 },
  );
  await bridge.enqueueAndWait(
    { type: "rotate", target: { x: bx, y: by }, direction: 4 },
    { timeoutMs: 60_000 },
  );
  const beltDir = await lua(
    `local e = game.surfaces[1].find_entities_filtered{name="transport-belt", position={${bx},${by}}, radius=1}[1]
     rcon.print(e and e.direction or "missing")`);
  check("rotate belt to east", beltDir === "4", `direction=${beltDir}`);

  // ---------- craft ----------
  const gearsBefore = (await inventory())["iron-gear-wheel"] ?? 0;
  const craftDetail = await bridge.enqueueAndWait(
    { type: "craft", recipe: "iron-gear-wheel", count: 3 },
    { timeoutMs: 90_000 },
  );
  const gearsAfter = (await inventory())["iron-gear-wheel"] ?? 0;
  check("craft 3 iron-gear-wheel", gearsAfter - gearsBefore >= 3,
    `${gearsBefore}->${gearsAfter} — ${craftDetail}`);

  // ---------- research ----------
  // Fresh 2.0 saves gate everything behind trigger techs (unlocked by in-game
  // actions) — first check the helpful failure, then unlock the trigger and queue.
  try {
    await bridge.call("start_research", { technology: "automation" });
    check("start_research blocked by trigger prereq", false, "expected failure on fresh save");
  } catch (err) {
    check("start_research blocked by trigger prereq",
      /missing prerequisites: automation-science-pack/.test(String(err)), String(err).slice(0, 120));
  }
  await lua(`game.forces.player.technologies["automation-science-pack"].researched = true rcon.print("ok")`);
  const research = await bridge.call<{ queued: boolean; technology: string }>(
    "start_research", { technology: "automation" });
  const s4 = await state();
  check("start_research automation",
    research.queued === true && s4.research?.current === "automation",
    `current=${s4.research?.current}`);

  // ---------- death + respawn ----------
  await lua(`local c = ${findChar}; c.die(); rcon.print("died")`);
  await sleep(300);
  const pingDead = await bridge.call<PingResult>("ping");
  const respawn = await bridge.call<SpawnResult>("spawn_companion", {});
  check("death detected + respawn",
    pingDead.companion_exists === false && respawn.already_existed === false,
    `new unit ${respawn.unit_number}`);

  // ---------- queue bookkeeping ----------
  const { task_id } = await bridge.call<{ task_id: number }>("enqueue", {
    task: { type: "walk_to", target: { x: cx + 60, y: cy + 60 } },
  });
  await bridge.call<{ task_id: number }>("enqueue", {
    task: { type: "walk_to", target: { x: cx, y: cy } },
  });
  const cancelled = await bridge.call<{ cancelled: number }>("cancel", { all: true });
  const rec = await bridge.call<{ status: string }>("get_task", { task_id });
  check("cancel all (active + queued)", cancelled.cancelled >= 2 && rec.status === "cancelled",
    `cancelled=${cancelled.cancelled}`);

  // ---------- error envelopes ----------
  const badCases: Array<[string, () => Promise<unknown>, RegExp]> = [
    ["unknown method", () => bridge.call("no_such_method"), /unknown method/],
    ["unknown recipe", () => bridge.enqueueAndWait({ type: "craft", recipe: "not-a-recipe", count: 1 } as any, { timeoutMs: 20_000 }), /./],
    ["unknown technology", () => bridge.call("start_research", { technology: "warp-drive" }), /unknown technology/],
    ["mine nothing there", () => bridge.enqueueAndWait({ type: "mine", target: { x: cx + 500, y: cy } } as any, { timeoutMs: 20_000 }), /./],
  ];
  for (const [name, fn, re] of badCases) {
    try {
      await fn();
      check(`error: ${name}`, false, "no error raised");
    } catch (err) {
      check(`error: ${name}`, re.test(String(err)), String(err).slice(0, 100));
    }
  }

  rcon.close();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
