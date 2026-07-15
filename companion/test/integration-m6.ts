// M6 live integration: spatial toolkit, build_plan, deconstruct, combat, blueprints.
// The build_plan section deliberately mimics HOW THE LLM WORKS: it reads machine
// geometry from describe_prototype, computes the chest spot from drop_offset, and
// builds via the general build_plan — no scenario logic anywhere.
//   npx tsx test/integration-m6.ts [host] [port] [password]
import { Bridge } from "../src/bridge.js";
import { RconClient } from "../src/rcon.js";
import { asArray, type GetStateResult, type SpawnResult } from "../src/types.js";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 27099);
const password = process.argv[4] ?? "agentic-it-pass";

let failures = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const rcon = new RconClient({ host, port, password, timeoutMs: 15_000 });
  await rcon.connect();
  const bridge = new Bridge(rcon);
  await bridge.unlock();
  const lua = async (code: string): Promise<string> =>
    (await rcon.exec(`/silent-command ${code}`)).trim();
  const state = () => bridge.call<GetStateResult>("get_state", {});
  const inventory = async () => (await state()).companion?.inventory ?? {};
  const findChar = `game.surfaces[1].find_entities_filtered{name="character", limit=1}[1]`;

  // ---------- arena reset ----------
  await bridge.call("cancel", { all: true }).catch(() => {});
  await lua(`local s = game.surfaces[1]
    for _, e in pairs(s.find_entities_filtered{force = "player"}) do e.destroy() end
    for _, e in pairs(s.find_entities_filtered{force = "enemy"}) do e.destroy() end
    for _, name in pairs({"iron-ore", "copper-ore"}) do
      for _, e in pairs(s.find_entities_filtered{name = name}) do e.destroy() end
    end
    rcon.print("arena reset")`);
  const spawn = await bridge.call<SpawnResult>("spawn_companion", {});
  const home = spawn.position;

  // ---------- describe_prototype ----------
  const protos = await bridge.call<Record<string, any>>("describe_prototype", {
    names: ["burner-mining-drill", "inserter", "iron-gear-wheel", "not-a-thing"],
  });
  const drill = protos["burner-mining-drill"];
  check("describe drill geometry",
    drill?.tile_width === 2 && drill?.tile_height === 2 &&
    typeof drill?.drop_offset?.x === "number" && drill?.energy === "burner",
    `2x2 burner, drop_offset=(${drill?.drop_offset?.x}, ${drill?.drop_offset?.y})`);
  check("describe inserter arms",
    !!protos["inserter"]?.inserter_pickup_offset && !!protos["inserter"]?.inserter_drop_offset,
    JSON.stringify(protos["inserter"]?.inserter_drop_offset));
  check("describe recipe",
    protos["iron-gear-wheel"]?.kind === "recipe" &&
    protos["iron-gear-wheel"]?.ingredients?.["iron-plate"] === 2,
    JSON.stringify(protos["iron-gear-wheel"]?.ingredients));
  check("describe unknown", protos["not-a-thing"]?.kind === "unknown");

  // ---------- scan_area ----------
  const scan = await bridge.call<any>("scan_area", { radius: 10 });
  const gridOk = Array.isArray(scan.grid) && scan.grid.length === 21 &&
    scan.grid.some((row: string) => row.includes("@"));
  check("scan_area grid + legend", gridOk && scan.legend?.["@"] !== undefined,
    `${scan.width}x${scan.height}, origin (${scan.origin?.x}, ${scan.origin?.y})`);

  // ---------- find_buildable_area / can_place ----------
  const area = await bridge.call<any>("find_buildable_area", {
    width: 6, height: 6, near: { x: home.x + 8, y: home.y }, max_distance: 40,
  });
  check("find_buildable_area", typeof area.top_left?.x === "number",
    `top_left (${area.top_left?.x}, ${area.top_left?.y}), trees=${area.trees_in_area}`);

  const ax = Math.floor(area.top_left.x);
  const ay = Math.floor(area.top_left.y);
  const cpFree = await bridge.call<any>("can_place", {
    item: "stone-furnace", position: { x: ax + 1, y: ay + 1 },
  });
  check("can_place free spot", cpFree.can_place === true);

  // ---------- build_plan: the "AI-style" automatic mini-farm ----------
  // 1. plant a small iron patch on the free area; 2. give materials; 3. compute
  // the chest tile from the drill's drop_offset (exactly what the model does);
  // 4. one build_plan with fuel in the step; 5. the farm must produce on its own.
  const dx = ax + 2;
  const dy = ay + 2;
  await lua(`local s = game.surfaces[1]
    for tx = ${dx - 1}, ${dx} do for ty = ${dy - 1}, ${dy} do
      s.create_entity{name = "iron-ore", amount = 600, position = {tx + 0.5, ty + 0.5}}
    end end
    local c = ${findChar}
    local inv = c.get_main_inventory()
    inv.insert{name = "burner-mining-drill", count = 1}
    inv.insert{name = "wooden-chest", count = 1}
    inv.insert{name = "coal", count = 10}
    inv.insert{name = "stone-furnace", count = 1}
    inv.insert{name = "pistol", count = 1}
    inv.insert{name = "firearm-magazine", count = 3}
    rcon.print("materials ready")`);

  // direction 8 = south; rotate the direction-0 drop_offset by 180°: (x,y) -> (-x,-y)
  const off = drill.drop_offset as { x: number; y: number };
  const chestX = Math.floor(dx - off.x) + 0.5;
  const chestY = Math.floor(dy - off.y) + 0.5;
  const planDetail = await bridge.enqueueAndWait(
    {
      type: "build_plan",
      steps: [
        { item: "burner-mining-drill", position: { x: dx, y: dy }, direction: 8, insert: { coal: 5 } },
        { item: "wooden-chest", position: { x: chestX, y: chestY } },
      ],
    } as any,
    { timeoutMs: 120_000 },
  );
  check("build_plan drill+chest", /2\/2/.test(planDetail), planDetail);

  await sleep(15_000); // let the drill mine a few ore into the chest
  const chest = await bridge.call<any>("inspect", { position: { x: chestX, y: chestY } });
  const oreInChest = chest?.inventories?.main?.["iron-ore"] ?? 0;
  check("automatic farm produces (ore lands in chest)", oreInChest > 0,
    `chest contains ${oreInChest} iron-ore after 15s`);

  // ---------- deconstruct (consent gate + actual demolition) ----------
  try {
    await bridge.enqueueAndWait(
      { type: "deconstruct", target: { x: chestX, y: chestY } } as any,
      { timeoutMs: 20_000 },
    );
    check("deconstruct without confirm is refused", false, "it went through!");
  } catch (err) {
    check("deconstruct without confirm is refused", /consent|confirm/i.test(String(err)),
      String(err).slice(0, 90));
  }
  const deconDetail = await bridge.enqueueAndWait(
    { type: "deconstruct", area: { center: { x: dx, y: dy }, radius: 4 }, confirm: true } as any,
    { timeoutMs: 90_000 },
  );
  const invAfterDecon = await inventory();
  check("deconstruct area with confirm",
    /demolished/i.test(deconDetail) && (invAfterDecon["burner-mining-drill"] ?? 0) >= 1 &&
    (invAfterDecon["wooden-chest"] ?? 0) >= 1,
    deconDetail);

  // ---------- equip + fight ----------
  const equip = await bridge.call<any>("equip", { gun: "pistol", ammo: "firearm-magazine" });
  check("equip pistol", equip.gun === "pistol" && Object.keys(equip.ammo ?? {}).length > 0,
    JSON.stringify(equip));
  const s2 = await state();
  check("equipment visible in get_state", (s2.companion as any)?.equipment?.gun === "pistol");

  const p = s2.companion!.position;
  await lua(`local s = game.surfaces[1]
    s.create_entity{name = "small-biter", position = {${p.x + 10}, ${p.y}}, force = "enemy"}
    s.create_entity{name = "small-biter", position = {${p.x + 12}, ${p.y + 2}}, force = "enemy"}
    rcon.print("biters spawned")`);
  const fightDetail = await bridge.enqueueAndWait(
    { type: "fight", radius: 25 } as any,
    { timeoutMs: 120_000 },
  );
  const biters = await lua(
    `rcon.print(#game.surfaces[1].find_entities_filtered{force = "enemy", type = "unit"})`);
  check("fight clears biters", /cleared/i.test(fightDetail) && biters === "0", fightDetail);

  // ---------- import_blueprint ----------
  const bpString = await lua(`local inv = game.create_inventory(1)
    local stack = inv[1]
    stack.set_stack{name = "blueprint"}
    stack.set_blueprint_entities({
      {entity_number = 1, name = "stone-furnace", position = {x = 0, y = 0}},
      {entity_number = 2, name = "iron-chest", position = {x = 3, y = 0}},
    })
    local str = stack.export_stack()
    inv.destroy()
    rcon.print(str)`);
  const imported = await bridge.call<any>("import_blueprint", { string: bpString });
  const names = asArray<any>(imported.entities).map((e) => e.name).sort();
  check("import_blueprint",
    names.join(",") === "iron-chest,stone-furnace" &&
    imported.items_needed?.["stone-furnace"] === 1,
    `entities=${names.join("+")}, needed=${JSON.stringify(imported.items_needed)}`);

  // ---------- cleanup ----------
  await lua(`local s = game.surfaces[1]
    for _, e in pairs(s.find_entities_filtered{name = "iron-ore"}) do e.destroy() end
    rcon.print("cleaned")`);

  rcon.close();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
