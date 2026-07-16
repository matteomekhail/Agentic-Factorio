import { spawnSync } from "node:child_process";
import net from "node:net";
import pc from "picocolors";
import { resolveModel } from "./agent/providers.js";
import { Bridge } from "./bridge.js";
import { companionVersion, configPath, loadConfig, type BrainKind, type Settings } from "./config.js";
import { PROTOCOL_VERSION } from "./protocol/contract.js";
import { RconClient } from "./rcon.js";
import { telemetrySnapshot } from "./telemetry.js";
import type { PingResult } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  generated_at: string;
  app_version: string;
  brain_kind: BrainKind;
  rcon: { host: string; port: number; password_configured: boolean };
  checks: DoctorCheck[];
  telemetry: ReturnType<typeof telemetrySnapshot>;
}

function probeTcp(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let finished = false;
    const done = (ok: boolean) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function cliAvailable(command: "codex" | "claude"): { ok: boolean; detail: string } {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) return { ok: false, detail: result.stderr.trim() || `exit ${result.status}` };
  return { ok: true, detail: result.stdout.trim() || `${command} found` };
}

export async function collectDoctorReport(settings: Settings): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck): boolean => {
    checks.push(check);
    return check.ok;
  };
  const brainKind = settings.brainKind ?? "api";
  const { host, port, password } = settings.rcon;

  const cfg = loadConfig();
  if (!add(cfg || password
    ? { name: "config", ok: true, detail: cfg ? `readable at ${configPath()}` : "supplied via flags/environment" }
    : { name: "config", ok: false, detail: "no usable config or RCON password", fix: "run `npx agentic-factorio setup`" })) {
    return finish();
  }

  if (!add((await probeTcp(host, port))
    ? { name: "tcp", ok: true, detail: `game reachable at ${host}:${port}` }
    : { name: "tcp", ok: false, detail: `nothing listening at ${host}:${port}`, fix: "host a Factorio save after running setup" })) {
    return finish();
  }

  const rcon = new RconClient({ host, port, password });
  try {
    await rcon.connect();
    add({ name: "rcon", ok: true, detail: "authentication ok" });
  } catch (error) {
    add({ name: "rcon", ok: false, detail: error instanceof Error ? error.message : String(error), fix: "synchronize local-rcon-password with the companion config" });
    return finish();
  }

  try {
    const bridge = new Bridge(rcon);
    await bridge.unlock();
    const ping = await bridge.call<PingResult>("ping");
    add(ping.protocol_version === PROTOCOL_VERSION
      ? { name: "protocol", ok: true, detail: `v${ping.protocol_version}` }
      : { name: "protocol", ok: false, detail: `mod v${ping.protocol_version ?? "unknown"}, app v${PROTOCOL_VERSION}`, fix: "reinstall the matching mod and restart Factorio" });
    add(ping.mod_version === companionVersion()
      ? { name: "mod", ok: true, detail: `v${ping.mod_version}, Factorio ${ping.factorio_version}` }
      : { name: "mod", ok: false, detail: `mod v${ping.mod_version}, app v${companionVersion()}`, fix: "re-run setup to reinstall the matching mod" });
    add({ name: "companion", ok: true, detail: ping.companion_exists ? "present" : "will spawn when play starts" });
  } catch (error) {
    add({ name: "mod", ok: false, detail: error instanceof Error ? error.message : String(error), fix: "install/enable the mod, restart Factorio and re-host" });
  } finally {
    rcon.close();
  }

  if (brainKind === "api") {
    try {
      const resolved = resolveModel({ provider: settings.provider, model: settings.model, apiKey: settings.apiKey, ollamaBaseUrl: settings.ollamaBaseUrl });
      add({ name: "brain", ok: true, detail: resolved.label });
    } catch (error) {
      add({ name: "brain", ok: false, detail: error instanceof Error ? error.message : String(error), fix: "configure an API provider/Ollama or re-run setup" });
    }
  } else {
    const command = brainKind.startsWith("claude") ? "claude" : "codex";
    const available = cliAvailable(command);
    add({ name: "brain", ok: available.ok, detail: `${command}: ${available.detail}`, fix: available.ok ? undefined : `install and sign in to ${command}` });
  }
  return finish();

  function finish(): DoctorReport {
    return {
      ok: checks.every((check) => check.ok),
      generated_at: new Date().toISOString(),
      app_version: companionVersion(),
      brain_kind: brainKind,
      rcon: { host, port, password_configured: password.length > 0 },
      checks,
      telemetry: telemetrySnapshot(),
    };
  }
}

export async function runDoctor(settings: Settings, options: { json?: boolean } = {}): Promise<void> {
  const report = await collectDoctorReport(settings);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const check of report.checks) {
      console.log(`${check.ok ? pc.green("✓") : pc.red("✗")} ${check.name}: ${check.detail}`);
      if (check.fix) console.log(`  ${pc.yellow("fix:")} ${check.fix}`);
    }
    if (report.ok) console.log(pc.green("\nAll checks passed — you're ready to play."));
  }
  if (!report.ok) process.exitCode = 1;
}
