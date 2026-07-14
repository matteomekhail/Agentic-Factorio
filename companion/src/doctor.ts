// `agentic-factorio doctor` — ordered health checks from config to brain,
// each with one actionable fix. Stops (exit 1) at the first failure.
import net from "node:net";
import pc from "picocolors";
import { resolveModel } from "./agent/providers.js";
import { Bridge } from "./bridge.js";
import { companionVersion, configPath, distCliPath, loadConfig, type Settings } from "./config.js";
import { RconClient } from "./rcon.js";
import type { PingResult } from "./types.js";

function pass(msg: string): void {
  console.log(`${pc.green("✓")} ${msg}`);
}

function fail(msg: string, fix: string): never {
  console.log(`${pc.red("✗")} ${msg}`);
  console.log(`  ${pc.yellow("fix:")} ${fix}`);
  process.exit(1);
}

function probeTcp(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function runDoctor(settings: Settings): Promise<void> {
  // 1. Config readable.
  const cfg = loadConfig();
  if (cfg) {
    pass(`config readable at ${configPath()}`);
  } else if (settings.rcon.password) {
    pass("no config file, but RCON settings supplied via flags/env");
  } else {
    fail(
      `no usable config at ${configPath()} and no RCON password in flags/env`,
      "run `npx agentic-factorio setup` (or set AGENTIC_RCON_PASSWORD to match local-rcon-password in Factorio's config.ini)",
    );
  }

  // 2. TCP reachable.
  const { host, port, password } = settings.rcon;
  if (await probeTcp(host, port)) {
    pass(`game reachable at ${host}:${port}`);
  } else {
    fail(
      `nothing is listening on ${host}:${port}`,
      "start Factorio → Multiplayer → Host saved game (local RCON only opens while hosting; `npx agentic-factorio setup` configures it)",
    );
  }

  // 3. RCON auth.
  const rcon = new RconClient({ host, port, password });
  try {
    await rcon.connect();
    pass("RCON authentication ok");
  } catch (err) {
    fail(
      `RCON auth failed: ${err instanceof Error ? err.message : err}`,
      "the password must match local-rcon-password in Factorio's config.ini — re-run `npx agentic-factorio setup` to sync them",
    );
  }

  // 4. Mod present + version match.
  const bridge = new Bridge(rcon);
  let ping: PingResult;
  try {
    await bridge.unlock();
    ping = await bridge.call<PingResult>("ping");
  } catch (err) {
    rcon.close();
    fail(
      `the game answered but the mod did not: ${err instanceof Error ? err.message : err}`,
      "install/enable the agentic-companion mod (run `npx agentic-factorio setup`), then restart Factorio and re-host the save",
    );
  }
  const appVersion = companionVersion();
  if (ping.mod_version === appVersion) {
    pass(`mod v${ping.mod_version} responding (Factorio ${ping.factorio_version})`);
  } else {
    rcon.close();
    fail(
      `mod version mismatch: mod v${ping.mod_version} vs companion app v${appVersion}`,
      "re-run `npx agentic-factorio setup` to reinstall the matching mod, then restart Factorio",
    );
  }

  // 5. Companion character.
  if (ping.companion_exists) {
    pass("companion character is in the world");
  } else {
    pass("companion character not spawned yet — `npx agentic-factorio play` spawns it automatically");
  }
  rcon.close();

  // 6. Brain configured.
  try {
    const { label } = resolveModel({
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
      ollamaBaseUrl: settings.ollamaBaseUrl,
    });
    pass(`brain configured: ${label}`);
  } catch {
    fail(
      "no AI brain configured",
      [
        "either set an API key (OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY, or `npx agentic-factorio setup`),",
        "  or use your Claude Code / Codex subscription via MCP:",
        `    claude mcp add factorio -- node ${distCliPath()} mcp`,
        `    codex mcp add factorio -- node ${distCliPath()} mcp`,
      ].join("\n"),
    );
  }

  console.log(pc.green("\nAll checks passed — you're ready to play."));
}
