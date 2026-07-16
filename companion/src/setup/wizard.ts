// Guided first-run setup. All questions are answered before filesystem changes;
// the mutation phase rolls back as a unit if any step fails.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import {
  configPath,
  distCliPath,
  loadConfig,
  saveConfig,
  type AppConfig,
  type BrainKind,
} from "../config.js";
import { patchRconConfig } from "./configini.js";
import { installMod } from "./installMod.js";
import { factorioConfigPath, factorioUserDir, modsDir } from "./locate.js";
import { setupTransaction } from "./transaction.js";

function bail(message: string, code = 0): never {
  p.cancel(message);
  process.exit(code);
}

function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) bail("Setup cancelled — no changes were made.");
  return value as T;
}

type BrainChoice = "claude-mcp" | "codex" | "codex-mcp" | "openrouter" | "anthropic" | "openai" | "ollama";

export async function runWizard(): Promise<void> {
  p.intro("agentic-factorio setup");

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

  // Collect every choice before touching Factorio or app configuration.
  const existing = loadConfig();
  const port = existing?.rcon?.port ?? 27015;
  const password = existing?.rcon?.password ?? crypto.randomBytes(12).toString("hex");
  const brain = unwrap(
    await p.select<BrainChoice>({
      message: "Which AI brain should the companion use?",
      options: [
        { value: "codex", label: "Codex automatic brain", hint: "recommended for ChatGPT subscriptions — wakes on game chat" },
        { value: "claude-mcp", label: "Claude Code via MCP", hint: "control it from an open Claude Code session" },
        { value: "codex-mcp", label: "Codex interactive via MCP", hint: "control it from an open Codex session" },
        { value: "openrouter", label: "OpenRouter API key", hint: "one key, hundreds of models" },
        { value: "anthropic", label: "Anthropic API key" },
        { value: "openai", label: "OpenAI API key" },
        { value: "ollama", label: "Ollama", hint: "local models, free, no key" },
      ],
    }),
  );

  const config: AppConfig = {
    ...existing,
    factorioUserDir: userDir,
    rcon: { host: existing?.rcon?.host ?? "127.0.0.1", port, password },
  };
  let brainKind: BrainKind = "api";
  let finalCommand = "npx agentic-factorio play";

  if (brain === "openrouter" || brain === "anthropic" || brain === "openai") {
    const keyUrl =
      brain === "openrouter"
        ? "https://openrouter.ai/settings/keys"
        : brain === "anthropic"
          ? "https://console.anthropic.com/settings/keys"
          : "https://platform.openai.com/api-keys";
    config.provider = brain;
    config.apiKey = unwrap(
      await p.password({
        message: `Paste your ${brain} API key (from ${keyUrl})`,
        validate: (v) => (v && v.length > 8 ? undefined : "That doesn't look like an API key"),
      }),
    );
  } else if (brain === "ollama") {
    config.provider = "ollama";
    config.model = unwrap(
      await p.text({
        message: "Which Ollama model? (must support tool calling)",
        placeholder: "qwen3",
        validate: (v) => (v ? undefined : "Model name is required for Ollama"),
      }),
    );
    config.ollamaBaseUrl = unwrap(
      await p.text({
        message: "Ollama base URL",
        defaultValue: "http://localhost:11434/v1",
        placeholder: "http://localhost:11434/v1",
      }),
    );
  } else if (brain === "codex") {
    brainKind = "codex";
    finalCommand = "npx agentic-factorio play --brain codex";
  } else {
    brainKind = brain;
    const cli = brain === "claude-mcp" ? "claude" : "codex";
    finalCommand = `${cli} mcp add factorio -- node ${distCliPath()} mcp`;
  }
  config.brainKind = brainKind;

  const ini = factorioConfigPath(userDir);
  const mods = modsDir(userDir);
  const modDest = path.join(mods, "agentic-companion");
  try {
    setupTransaction([ini, `${ini}.agentic-bak`, path.join(mods, "mod-list.json"), modDest, configPath()], () => {
      patchRconConfig(ini, { port, password });
      installMod(mods);
      saveConfig(config);
    });
  } catch (error) {
    bail(
      `Setup failed; previous files were restored. ${error instanceof Error ? error.message : error}`,
      1,
    );
  }

  p.log.success(`RCON configured on localhost:${port}; mod installed and enabled.`);
  p.log.success(`Saved settings to ${configPath()}`);
  p.note(
    [
      "1. (Re)start Factorio and accept any mod restart prompt.",
      "2. Multiplayer → Host saved game.",
      `3. Run: ${finalCommand}`,
      brainKind.endsWith("-mcp")
        ? "4. Open that assistant and ask it to play Factorio."
        : "4. Talk to the companion in game chat.",
      "",
      "The companion uses Lua console commands, so achievements are disabled on that save.",
    ].join("\n"),
    "You're set — the golden path",
  );
  p.outro("Have fun on the factory floor!");
}
