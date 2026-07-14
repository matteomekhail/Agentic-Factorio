// Guided first-run setup: find Factorio, wire up RCON, install the mod,
// pick an AI brain, save config, and print the golden path.
import crypto from "node:crypto";
import fs from "node:fs";
import * as p from "@clack/prompts";
import { distCliPath, loadConfig, saveConfig, configPath, type AppConfig } from "../config.js";
import { patchRconConfig } from "./configini.js";
import { installMod } from "./installMod.js";
import { factorioConfigPath, factorioUserDir, modsDir } from "./locate.js";

function bail(message: string): never {
  p.cancel(message);
  process.exit(0);
}

function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) bail("Setup cancelled — nothing else was changed.");
  return value as T;
}

export async function runWizard(): Promise<void> {
  p.intro("agentic-factorio setup");

  // 1. Locate the Factorio user-data directory.
  let userDir = factorioUserDir();
  if (userDir) {
    p.log.success(`Found Factorio data at ${userDir}`);
  } else {
    userDir = unwrap(
      await p.text({
        message: "Couldn't find your Factorio user-data folder. Where is it? (contains config/ and mods/)",
        placeholder: "~/Library/Application Support/factorio",
        validate: (v) => {
          if (!v) return "Please enter a path";
          try {
            if (!fs.statSync(v.replace(/^~/, process.env.HOME ?? "~")).isDirectory()) return "Not a directory";
          } catch {
            return "That directory does not exist";
          }
          return undefined;
        },
      }),
    ).replace(/^~/, process.env.HOME ?? "~");
  }

  // 2. Enable local RCON in config.ini (reuse an existing password if we have one).
  const existing = loadConfig();
  const port = existing?.rcon?.port ?? 27015;
  const password = existing?.rcon?.password ?? crypto.randomBytes(12).toString("hex");
  try {
    const { changed } = patchRconConfig(factorioConfigPath(userDir), { port, password });
    p.log.success(
      changed
        ? `Enabled RCON in config.ini (port ${port}, password ${password}) — original backed up as config.ini.agentic-bak`
        : `RCON already configured in config.ini (port ${port})`,
    );
  } catch (err) {
    bail(err instanceof Error ? err.message : String(err));
  }

  // 3. Install the mod.
  try {
    const { dest, copied } = installMod(modsDir(userDir));
    p.log.success(copied ? `Installed the agentic-companion mod to ${dest}` : `Mod is symlinked at ${dest} (dev setup) — left it alone`);
  } catch (err) {
    bail(err instanceof Error ? err.message : String(err));
  }

  // 4. Pick a brain.
  const brain = unwrap(
    await p.select({
      message: "Which AI brain should the companion use?",
      options: [
        { value: "claude-code", label: "Claude Code subscription", hint: "no API key — talk to it from Claude Code via MCP" },
        { value: "codex", label: "Codex (ChatGPT) subscription", hint: "no API key — talk to it from Codex via MCP" },
        { value: "openrouter", label: "OpenRouter API key", hint: "one key, hundreds of models — recommended for `play`" },
        { value: "anthropic", label: "Anthropic API key" },
        { value: "openai", label: "OpenAI API key" },
        { value: "ollama", label: "Ollama", hint: "local models, free, no key" },
      ],
    }),
  );

  const config: AppConfig = {
    ...existing,
    rcon: { host: existing?.rcon?.host ?? "127.0.0.1", port, password },
  };
  let playReady = true;

  switch (brain) {
    case "claude-code":
    case "codex": {
      playReady = false;
      const cli = brain === "claude-code" ? "claude" : "codex";
      p.note(
        [
          "Your subscription drives the companion through MCP — no API key needed.",
          "Register the game as an MCP server (one-time):",
          "",
          `  ${cli} mcp add factorio -- node ${distCliPath()} mcp`,
          "",
          `Then, with Factorio hosting your save, open ${cli === "claude" ? "Claude Code" : "Codex"} and just ask it to`,
          'play — e.g. "look around in Factorio and go mine some iron". Its tools',
          "connect to the game and control the companion character directly.",
        ].join("\n"),
        brain === "claude-code" ? "Connect Claude Code" : "Connect Codex",
      );
      break;
    }
    case "openrouter":
    case "anthropic":
    case "openai": {
      const keyUrl =
        brain === "openrouter"
          ? "https://openrouter.ai/settings/keys"
          : brain === "anthropic"
            ? "https://console.anthropic.com/settings/keys"
            : "https://platform.openai.com/api-keys";
      const apiKey = unwrap(
        await p.password({
          message: `Paste your ${brain} API key (from ${keyUrl})`,
          validate: (v) => (v && v.length > 8 ? undefined : "That doesn't look like an API key"),
        }),
      );
      config.provider = brain;
      config.apiKey = apiKey;
      break;
    }
    case "ollama": {
      config.provider = "ollama";
      config.model = unwrap(
        await p.text({
          message: "Which Ollama model? (must support tool calling)",
          placeholder: "qwen3",
          validate: (v) => (v ? undefined : "Model name is required for Ollama"),
        }),
      );
      const baseUrl = unwrap(
        await p.text({
          message: "Ollama base URL",
          defaultValue: "http://localhost:11434/v1",
          placeholder: "http://localhost:11434/v1",
        }),
      );
      config.ollamaBaseUrl = baseUrl;
      break;
    }
  }

  saveConfig(config);
  p.log.success(`Saved settings to ${configPath()}`);

  p.note(
    [
      "1. (Re)start Factorio — if the mod was just installed, check it's",
      "   enabled under Mods, then restart when prompted.",
      "2. Multiplayer → Host saved game (any save; a new one works too).",
      ...(playReady
        ? ["3. In a terminal: npx agentic-factorio play", "4. Talk to the companion in the game chat!"]
        : ["3. Ask your assistant (Claude Code / Codex) to play — its factorio", "   MCP tools drive the companion.", "4. Talk back through the game chat!"]),
      "",
      "Heads-up: the companion uses Lua console commands, so achievements",
      "are disabled on any save it plays on.",
    ].join("\n"),
    "You're set — the golden path",
  );

  p.outro("Have fun on the factory floor!");
}
