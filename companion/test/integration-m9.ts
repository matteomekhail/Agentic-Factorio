// Live integration test for the M9 batch: starter blueprint books, windowed
// read_blueprint on the real books, run_plan (quiet/chain), batched
// inspect/can_place, and build_blueprint (whole-print build incl. the rail
// item -> curved entity mapping). Run against the isolated test server:
//   npx tsx test/integration-m9.ts [host] [port] [password]
import { Bridge } from "../src/bridge.js";
import { RconClient } from "../src/rcon.js";
import { asArray, type GetStateResult, type SpawnResult, type Task } from "../src/types.js";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 27099);
const password = process.argv[4] ?? "agentic-it-pass";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Windowed {
  label?: string;
  size: { w: number; h: number };
  total_entities: number;
  offset: number;
  entities: Array<{ name: string; position: { x: number; y: number } }>;
  next_offset?: number;
  items_needed: Record<string, number>;
}

async function main(): Promise<void> {
  const rcon = new RconClient({ host, port, password, timeoutMs: 15_000 });
  await rcon.connect();
  const bridge = new Bridge(rcon);
  await bridge.unlock();
  const lua = async (code: string): Promise<string> =>
    (await rcon.exec(`/silent-command ${code}`)).trim();
  const state = () => bridge.call<GetStateResult>("get_state", {});
  const findChar = `game.surfaces[1].find_entities_filtered{name="character", limit=1}[1]`;

  // Clean slate: previous structures away, fresh companion (books re-issued).
  await bridge.call("cancel", { all: true }).catch(() => {});
  await lua(`local s = game.surfaces[1]
    for _, e in pairs(s.find_entities_filtered{force = "player"}) do e.destroy() end
    for _, e in pairs(s.find_entities_filtered{type = "corpse"}) do e.destroy() end
    for _, e in pairs(s.find_entities_filtered{type = "item-entity"}) do e.destroy() end
    rcon.print("arena reset")`);
  const spawn = await bridge.call<SpawnResult>("spawn_companion", {});
  check("spawn fresh companion", spawn.already_existed === false,
    `at (${spawn.position.x}, ${spawn.position.y})`);

  // ---------- starter books ----------
  const inv0 = await bridge.call<{ owner: string; inventory: Record<string, number> }>(
    "check_inventory", {});
  check("starter books issued on spawn", (inv0.inventory["blueprint-book"] ?? 0) === 4,
    `blueprint-book x${inv0.inventory["blueprint-book"] ?? 0}`);

  const list = await bridge.call<{ blueprints: unknown; total: number }>("list_blueprints", {});
  check("list_blueprints sees the library (nested books incl.)", list.total >= 140,
    `total=${list.total}`);

  // ---------- windowed read on a real (huge) print ----------
  const w0 = await bridge.call<Windowed>("read_blueprint", { label: "main bus", limit: 5 });
  check("read window: 5 entities of a bigger print",
    asArray(w0.entities).length === 5 && w0.next_offset === 5 && w0.total_entities > 5,
    `"${w0.label}" total=${w0.total_entities} next=${w0.next_offset}`);
  const w1 = await bridge.call<Windowed>("read_blueprint", { label: "main bus", offset: 5, limit: 5 });
  check("read window: whole-print bill on every window",
    JSON.stringify(w1.items_needed) === JSON.stringify(w0.items_needed) && w1.offset === 5,
    `bill keys=${Object.keys(w0.items_needed).length}`);
  const poles = await bridge.call<Windowed>("read_blueprint", { label: "poles", book: "power" });
  check("read with book filter", (poles.label ?? "").toLowerCase().includes("poles"),
    `"${poles.label}" ${poles.total_entities} entities, ${poles.size.w}x${poles.size.h}`);

  // ---------- run_plan: quiet chain -> ONE completion event ----------
  const s0 = await state();
  const cx = s0.companion!.position.x;
  const cy = s0.companion!.position.y;
  await lua(`local s = game.surfaces[1]
    s.create_entity{name="wooden-chest", position={${cx + 3}, ${cy}}, force="player"}
    local c = ${findChar}
    c.get_main_inventory().insert{name="coal", count=6}
    rcon.print("ok")`);
  const evBase = await bridge.call<{ last_id: number }>("get_events", { since_id: 0 });

  const chainTask = (task: Task, quiet: boolean, chain: string) =>
    bridge.call<{ task_id: number }>("enqueue", { task, background: true, quiet, chain });
  const chest = { x: cx + 3, y: cy };
  const t1 = await chainTask({ type: "insert", target: chest, items: { coal: 2 } }, true, "it-ok");
  const t2 = await chainTask({ type: "insert", target: chest, items: { coal: 2 } }, true, "it-ok");
  const t3 = await chainTask({ type: "extract", target: chest, all: true }, false, "it-ok");
  for (let i = 0; i < 40; i++) {
    const st = await bridge.call<{ status: string }>("get_task", { task_id: t3.task_id });
    if (st.status === "done" || st.status === "failed") break;
    await sleep(500);
  }
  const ev1 = await bridge.call<{ events: Array<{ kind: string; text: string }> }>(
    "get_events", { since_id: evBase.last_id });
  const doneEvents = asArray(ev1.events).filter((e) => e.kind === "task_done");
  const failEvents = asArray(ev1.events).filter((e) => e.kind === "task_failed");
  check("run_plan chain: ONE completion event, quiet steps silent",
    doneEvents.length === 1 && failEvents.length === 0,
    `task_done=${doneEvents.length} task_failed=${failEvents.length} (tasks #${t1.task_id}-#${t3.task_id})`);

  // ---------- run_plan: fail-fast cancels the rest of the chain ----------
  const evBase2 = await bridge.call<{ last_id: number }>("get_events", { since_id: 0 });
  const f1 = await chainTask({ type: "insert", target: chest, items: { coal: 1 } }, true, "it-fail");
  const f2 = await chainTask({ type: "place", item: "steel-chest", position: { x: cx + 5, y: cy } }, true, "it-fail");
  const f3 = await chainTask({ type: "insert", target: chest, items: { coal: 1 } }, false, "it-fail");
  for (let i = 0; i < 40; i++) {
    const st = await bridge.call<{ status: string }>("get_task", { task_id: f3.task_id });
    if (st.status !== "queued" && st.status !== "running") break;
    await sleep(500);
  }
  const f3state = await bridge.call<{ status: string; detail: string }>("get_task", { task_id: f3.task_id });
  const ev2 = await bridge.call<{ events: Array<{ kind: string }> }>(
    "get_events", { since_id: evBase2.last_id });
  const fails2 = asArray(ev2.events).filter((e) => e.kind === "task_failed");
  check("run_plan chain: failed step cancels the rest (one failure event)",
    f3state.status === "cancelled" && fails2.length === 1,
    `#${f2.task_id} failed, #${f3.task_id}=${f3state.status} "${f3state.detail}"`);

  // ---------- batched inspect ----------
  const insp = await bridge.call<{ entities: Array<Record<string, unknown>> }>("inspect", {
    targets: [chest, { x: 1000, y: 1000 }],
  });
  const ie = asArray(insp.entities);
  check("batched inspect: hit + inline miss",
    ie.length === 2 && ie[0]?.name === "wooden-chest" && typeof ie[1]?.error === "string",
    `[0]=${ie[0]?.name} [1].error=${String(ie[1]?.error).slice(0, 40)}`);

  // ---------- batched can_place ----------
  const cp = await bridge.call<{ results: Array<{ can_place: boolean; reason?: string }> }>(
    "can_place", {
      item: "stone-furnace",
      placements: [
        { position: { x: cx + 10, y: cy + 10 } },
        { position: chest },
      ],
    });
  const cpr = asArray(cp.results);
  check("batched can_place: clear yes, occupied no",
    cpr.length === 2 && cpr[0]?.can_place === true && cpr[1]?.can_place === false,
    `[1] ${cpr[1]?.reason ?? ""}`);

  // ---------- build_blueprint: synthetic print incl. curved rail ----------
  // A blueprint ITEM in the companion inventory with entities set via the API:
  // the curved segment consumes the rail ITEM but must place the exact entity.
  await lua(`local c = ${findChar}
    local inv = c.get_main_inventory()
    inv.insert{name="blueprint", count=1}
    for i = 1, #inv do
      local st = inv[i]
      if st.valid_for_read and st.is_blueprint and not st.is_blueprint_setup() then
        st.set_blueprint_entities({
          { entity_number = 1, name = "curved-rail-a", position = { x = 0, y = 0 } },
          { entity_number = 2, name = "wooden-chest", position = { x = 6, y = 0 } },
        })
        st.label = "IT Curve Test"
        break
      end
    end
    inv.insert{name="rail", count=4}
    inv.insert{name="wooden-chest", count=1}
    rcon.print("ok")`);

  const bill = await bridge.call<Windowed>("read_blueprint", { label: "IT Curve Test", limit: 1 });
  check("synthetic print readable, bill uses the rail ITEM",
    bill.total_entities === 2 && (bill.items_needed["rail"] ?? 0) >= 1,
    `bill=${JSON.stringify(bill.items_needed)}`);

  const anchor = { x: cx + 14, y: cy + 8 };
  const detail = await bridge.enqueueAndWait(
    { type: "build_blueprint", label: "IT Curve Test", anchor } as Task,
    { timeoutMs: 180_000 },
  );
  const placed = await lua(`local s = game.surfaces[1]
    local curved = #s.find_entities_filtered{name="curved-rail-a"}
    local chests = #s.find_entities_filtered{name="wooden-chest",
      area={{${anchor.x + 3}, ${anchor.y - 3}}, {${anchor.x + 9}, ${anchor.y + 3}}}}
    rcon.print(curved .. "," .. chests)`);
  const [curvedCount, chestCount] = placed.split(",").map(Number);
  check("build_blueprint places the whole print (curved rail from rail item)",
    /placed 2\/2/.test(detail) && curvedCount >= 1 && chestCount >= 1,
    `${detail}; curved=${curvedCount} chest=${chestCount}`);

  // ---------- build_blueprint: unknown label errors cleanly ----------
  const err = await bridge
    .enqueueAndWait({ type: "build_blueprint", label: "does-not-exist-xyz", anchor } as Task, {
      timeoutMs: 30_000,
    })
    .then(() => "no-error")
    .catch((e: Error) => e.message);
  check("build_blueprint: unknown label -> clear error", /no blueprint matching/.test(err),
    err.slice(0, 80));

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  rcon.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
