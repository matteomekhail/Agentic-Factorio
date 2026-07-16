// MCP stdio smoke test: spawns the companion's MCP server exactly like Claude
// Code / Codex CLI would, then drives it over newline-delimited JSON-RPC.
//   npx tsx test/mcp-smoke.ts [host] [port] [password]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const host = process.argv[2] ?? "127.0.0.1";
const port = process.argv[3] ?? "27099";
const password = process.argv[4] ?? "agentic-it-pass";
const offline = process.env.MCP_SMOKE_OFFLINE === "1";

const repoCompanion = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main(): Promise<void> {
  const entry = process.env.MCP_ENTRY ?? "src/cli.ts"; // set MCP_ENTRY=dist/cli.js to test the build
  const child = spawn(
    "npx",
    ["tsx", entry, "mcp",
      "--rcon-host", host, "--rcon-port", port, "--rcon-password", password],
    { cwd: repoCompanion, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.on("data", (d: Buffer) => process.stderr.write(`[mcp stderr] ${d}`));

  const pending = new Map<number, (msg: any) => void>();
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        console.error(`[mcp stdout noise] ${line.slice(0, 120)}`);
        failures++;
      }
    }
  });

  let nextId = 1;
  const request = (method: string, params?: unknown, timeoutMs = 30_000): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const notify = (method: string, params?: unknown) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  check("initialize", !!init.result?.serverInfo, `server=${init.result?.serverInfo?.name}`);
  notify("notifications/initialized");

  const list = await request("tools/list");
  const tools: Array<{ name: string }> = list.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  const expected = ["say", "look_around", "walk_to", "mine", "place_entity", "craft_items",
    "insert_items", "extract_items", "set_recipe", "rotate_entity", "inspect_entity",
    "start_research", "follow_player", "respawn", "stop", "connect_status", "read_chat", "wait_for_chat",
    "register_factorio_agent", "coordinate_submit_jobs", "coordinate_claim_job", "coordinate_takeover_job", "lease_companion",
    "reserve_build_area", "wait_for_agent_events", "coordination_status"];
  const missing = expected.filter((n) => !names.includes(n));
  check("tools/list", missing.length === 0, missing.length ? `missing: ${missing.join(",")}` : `${names.length} tools`);

  if (offline) {
    await request("tools/call", { name: "reset_coordination", arguments: { confirm: true } });
    const registered = await request("tools/call", {
      name: "register_factorio_agent",
      arguments: { name: "Smoke coordinator", role: "coordinator" },
    });
    const registrationText = registered.result?.content?.[0]?.text ?? "";
    const coordinatorId = registrationText.match(/agent_id=(\S+)/)?.[1];
    check("register coordinator", !!coordinatorId, registrationText);
    const submitted = await request("tools/call", {
      name: "coordinate_submit_jobs",
      arguments: { coordinator_id: coordinatorId, jobs: [{ key: "scan", title: "Scan", instructions: "Inspect the base" }] },
    });
    check("submit coordinated job", !submitted.result?.isError, submitted.result?.content?.[0]?.text?.slice(0, 100));
    const workerRegistration = await request("tools/call", {
      name: "register_factorio_agent",
      arguments: { name: "Smoke worker", role: "worker" },
    });
    const workerText = workerRegistration.result?.content?.[0]?.text ?? "";
    const workerId = workerText.match(/agent_id=(\S+)/)?.[1];
    const claimed = await request("tools/call", {
      name: "coordinate_claim_job",
      arguments: { agent_id: workerId },
    });
    const claimedText = claimed.result?.content?.[0]?.text ?? "";
    const jobId = JSON.parse(claimedText).job.id;
    await request("tools/call", {
      name: "coordinate_complete_job",
      arguments: { agent_id: workerId, job_id: jobId, result: "closed loop verified" },
    });
    const wake = await request("tools/call", {
      name: "wait_for_agent_events",
      arguments: { agent_id: coordinatorId, timeout_s: 1 },
    });
    const wakeText = wake.result?.content?.[0]?.text ?? "";
    check("job completion wakes coordinator", /coordination:job_done/.test(wakeText), wakeText);
    child.kill();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  }

  const status = await request("tools/call", { name: "connect_status", arguments: {} }, 60_000);
  const text = status.result?.content?.map((c: any) => c.text).join(" ") ?? JSON.stringify(status);
  check("connect_status", !status.result?.isError && /2\.0\.77|companion/i.test(text), text.slice(0, 140));

  await request("tools/call", { name: "reset_coordination", arguments: { confirm: true } });
  const workerRegistration = await request("tools/call", {
    name: "register_factorio_agent",
    arguments: { name: "Live smoke worker", role: "worker", capabilities: ["smoke"] },
  });
  const workerText = workerRegistration.result?.content?.[0]?.text ?? "";
  const workerId = workerText.match(/agent_id=(\S+)/)?.[1];
  check("register live worker", !!workerId, workerText);
  const denied = await request("tools/call", {
    name: "respawn",
    arguments: { name: "AI", companion: "AI", agent_id: workerId },
  });
  check("action denied without lease", denied.result?.isError === true, denied.result?.content?.[0]?.text?.slice(0, 100));
  const lease = await request("tools/call", {
    name: "lease_companion",
    arguments: { agent_id: workerId, companion: "AI", ttl_s: 60 },
  });
  check("lease companion", !lease.result?.isError, lease.result?.content?.[0]?.text?.slice(0, 100));
  const allowed = await request("tools/call", {
    name: "respawn",
    arguments: { name: "AI", companion: "AI", agent_id: workerId },
  });
  check("action allowed with lease", !allowed.result?.isError, allowed.result?.content?.[0]?.text?.slice(0, 100));
  await request("tools/call", { name: "release_companion", arguments: { agent_id: workerId, companion: "AI" } });

  const say = await request("tools/call", { name: "say", arguments: { text: "MCP smoke test says hi" } }, 30_000);
  check("say via MCP", !say.result?.isError, JSON.stringify(say.result?.content)?.slice(0, 100));

  const chat = await request("tools/call", { name: "wait_for_chat", arguments: { timeout_s: 2 } }, 30_000);
  check("wait_for_chat (empty timeout)", !chat.result?.isError,
    chat.result?.content?.[0]?.text?.slice(0, 80) ?? "");

  child.kill();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
