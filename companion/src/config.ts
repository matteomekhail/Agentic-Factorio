// Persistent app config (~/.config/agentic-factorio/config.json) and the
// flags > env > config file > defaults merge used by every CLI command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RconSettings {
  host: string;
  port: number;
  password: string;
}

export interface AppConfig {
  rcon?: Partial<RconSettings>;
  provider?: string;
  model?: string;
  apiKey?: string;
  ollamaBaseUrl?: string;
  proactiveMinutes?: number;
  budgetWarnTokens?: number;
}

/** Fully merged runtime settings for one invocation. */
export interface Settings {
  rcon: RconSettings;
  provider?: string;
  model?: string;
  apiKey?: string;
  ollamaBaseUrl?: string;
  proactiveMinutes?: number;
  budgetWarnTokens?: number;
}

export interface SettingsFlags {
  rconHost?: string;
  rconPort?: number;
  rconPassword?: string;
  provider?: string;
  model?: string;
  proactiveMinutes?: number;
}

export function configDir(): string {
  return path.join(os.homedir(), ".config", "agentic-factorio");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/** Reads the config file. Returns null when missing or unparseable —
 *  callers must work without it (env/flags can supply everything). */
export function loadConfig(): AppConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as AppConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const file = configPath();
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.chmodSync(file, 0o600); // contains API keys and the RCON password
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Merge priority: CLI flags > environment > config file > defaults. */
export function resolveSettings(flags: SettingsFlags = {}): Settings {
  const cfg = loadConfig() ?? {};
  return {
    rcon: {
      host: flags.rconHost ?? process.env.AGENTIC_RCON_HOST ?? cfg.rcon?.host ?? "127.0.0.1",
      port: flags.rconPort ?? envInt("AGENTIC_RCON_PORT") ?? cfg.rcon?.port ?? 27015,
      password: flags.rconPassword ?? process.env.AGENTIC_RCON_PASSWORD ?? cfg.rcon?.password ?? "",
    },
    provider: flags.provider ?? process.env.AGENTIC_PROVIDER ?? cfg.provider,
    model: flags.model ?? process.env.AGENTIC_MODEL ?? cfg.model,
    // Provider API keys from env (OPENROUTER_API_KEY, ANTHROPIC_API_KEY,
    // OPENAI_API_KEY) are read by resolveModel; the config key is a fallback.
    apiKey: cfg.apiKey,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? cfg.ollamaBaseUrl,
    proactiveMinutes: flags.proactiveMinutes ?? cfg.proactiveMinutes,
    budgetWarnTokens: cfg.budgetWarnTokens,
  };
}

/** Walks up from this module to the companion package root (works both from
 *  src/ under tsx and from the bundled dist/cli.js). */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (parsed.name === "agentic-factorio") return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume dist/ layout (dist/cli.js → package root is its parent).
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** Absolute path to the runnable CLI entrypoint, for "mcp add" commands. */
export function distCliPath(): string {
  return path.join(packageRoot(), "dist", "cli.js");
}

/** Version of this companion package (compared against the mod's version). */
export function companionVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
