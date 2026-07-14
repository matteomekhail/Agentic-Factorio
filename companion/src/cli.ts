#!/usr/bin/env node
import { parseArgs } from "node:util";
import { AgentLoop } from "./agent/loop.js";
import { resolveModel } from "./agent/providers.js";
import { sessionKey } from "./agent/session.js";
import { Bridge } from "./bridge.js";
import { resolveSettings, type Settings, type SettingsFlags } from "./config.js";
import { runDoctor } from "./doctor.js";
import { log } from "./log.js";
import { runMcpServer } from "./mcp/server.js";
import { ChatPoller } from "./poller.js";
import { RconClient } from "./rcon.js";
import { runWizard } from "./setup/wizard.js";
import { buildTools } from "./tools/definitions.js";
import type { PingResult, SpawnResult } from "./types.js";

const HELP = `agentic-factorio — an AI companion for your Factorio world

Usage:
  agentic-factorio setup              guided first-run setup (RCON, mod install, AI brain)
  agentic-factorio play [options]     connect to your hosted game and start the companion
  agentic-factorio mcp [options]      run as an MCP server (for Claude Code / Codex subscriptions)
  agentic-factorio doctor [options]   check every link in the chain and say what to fix

Options:
  --rcon-host <host>       RCON host (default 127.0.0.1, env AGENTIC_RCON_HOST)
  --rcon-port <port>       RCON port (default 27015, env AGENTIC_RCON_PORT)
  --rcon-password <pw>     RCON password (env AGENTIC_RCON_PASSWORD)
  --provider <name>        openrouter | anthropic | openai | ollama (default: auto from keys)
  --model <id>             model id for your provider (default: Claude Sonnet)
  --proactive <min>        check in on the factory every N minutes, speak only when needed
  --fresh                  start with a blank memory (ignore the saved session)

Provider keys: OPENROUTER_API_KEY (recommended), ANTHROPIC_API_KEY or OPENAI_API_KEY.
No key? Use your Claude Code / Codex subscription: run \`agentic-factorio setup\` and
pick the subscription option. \`agentic-factorio setup\` walks you through everything.
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function play(settings: Settings, fresh: boolean): Promise<void> {
  // Fail fast on a missing brain before waiting for the game.
  const { model, label } = resolveModel({
    provider: settings.provider,
    model: settings.model,
    apiKey: settings.apiKey,
    ollamaBaseUrl: settings.ollamaBaseUrl,
  });

  if (!settings.rcon.password) {
    log.error(
      "no RCON password. Run `npx agentic-factorio setup`, or set AGENTIC_RCON_PASSWORD (must match local-rcon-password in Factorio's config.ini).",
    );
    process.exit(1);
  }

  const rcon = new RconClient({
    host: settings.rcon.host,
    port: settings.rcon.port,
    password: settings.rcon.password,
  });
  let shuttingDown = false;

  const connectWithRetry = async (first: boolean): Promise<void> => {
    let warned = false;
    for (;;) {
      if (shuttingDown) return;
      try {
        await rcon.connect();
        if (!first) log.info("reconnected to the game");
        return;
      } catch (err) {
        if (!warned) {
          log.warn(err instanceof Error ? err.message : String(err));
          log.info(
            "waiting for the game… start Factorio → Multiplayer → Host saved game (RCON must be configured — `npx agentic-factorio setup`)",
          );
          warned = true;
        }
        await sleep(5000);
      }
    }
  };

  await connectWithRetry(true);
  rcon.on("close", () => {
    if (shuttingDown) return;
    log.warn("lost the RCON connection");
    void connectWithRetry(false);
  });

  const bridge = new Bridge(rcon);
  await bridge.unlock();
  const ping = await bridge.call<PingResult>("ping");
  log.info(`connected — Factorio ${ping.factorio_version}, mod v${ping.mod_version}, brain ${label}`);

  const spawned = await bridge.call<SpawnResult>("spawn_companion", {});
  log.info(
    `${spawned.already_existed ? "companion found" : "companion spawned"} at (${spawned.position.x}, ${spawned.position.y})`,
  );

  const tools = buildTools(bridge, { onTool: (name, detail) => log.tool(name, detail) });
  const loop = new AgentLoop(bridge, model, tools, {
    sessionKey: fresh ? undefined : sessionKey(settings.rcon.host, settings.rcon.port),
    budgetWarnTokens: settings.budgetWarnTokens,
  });
  if (settings.proactiveMinutes && settings.proactiveMinutes > 0) {
    loop.startProactive(settings.proactiveMinutes);
  }

  const poller = new ChatPoller(bridge);
  let pollErrorLogged = false;
  poller.on("chat", (msg) => {
    pollErrorLogged = false;
    loop.onChat(msg);
  });
  poller.on("error", (err) => {
    if (!pollErrorLogged) {
      log.warn(`chat polling: ${err.message}`);
      pollErrorLogged = true;
    }
  });
  poller.start();

  await bridge.call("say", { text: "I'm online! Talk to me in chat — try 'come here'. Type !stop to halt me." });
  log.info("companion is live — press Ctrl+C to stop");

  process.on("SIGINT", () => {
    shuttingDown = true;
    poller.stop();
    loop.dispose(); // stops timers, saves the session memory
    void (async () => {
      await bridge.call("say", { text: "Going offline — bye!" }).catch(() => {});
      await bridge.call("cancel", { all: true }).catch(() => {});
      rcon.close();
      process.exit(0);
    })();
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      "rcon-host": { type: "string" },
      "rcon-port": { type: "string" },
      "rcon-password": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      proactive: { type: "string" },
      fresh: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const command = positionals[0] ?? "play";
  if (values.help || command === "help") {
    console.log(HELP);
    return;
  }

  const flags: SettingsFlags = {
    rconHost: values["rcon-host"],
    rconPort: values["rcon-port"] !== undefined ? Number(values["rcon-port"]) : undefined,
    rconPassword: values["rcon-password"],
    provider: values.provider,
    model: values.model,
    proactiveMinutes: values.proactive !== undefined ? Number(values.proactive) : undefined,
  };

  switch (command) {
    case "setup":
      await runWizard();
      return;
    case "play":
      await play(resolveSettings(flags), values.fresh ?? false);
      return;
    case "mcp": {
      // MCP talks JSON-RPC over stdio: nothing may write to stdout here.
      const settings = resolveSettings(flags);
      if (!settings.rcon.password) {
        console.error(
          "agentic-factorio mcp: no RCON password — run `npx agentic-factorio setup` or set AGENTIC_RCON_PASSWORD.",
        );
        process.exit(1);
      }
      await runMcpServer({
        host: settings.rcon.host,
        port: settings.rcon.port,
        password: settings.rcon.password,
      });
      return;
    }
    case "doctor":
      await runDoctor(resolveSettings(flags));
      return;
    default:
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
