// Copies the agentic-companion mod into the player's mods dir and enables it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "../config.js";
import { atomicWriteFile } from "./atomic.js";

const MOD_NAME = "agentic-companion";

interface ModListEntry {
  name: string;
  enabled: boolean;
}

/** Where the mod source lives: (a) bundled npm assets, (b) monorepo layout
 *  relative to the compiled dist/cli.js, (c) monorepo layout when running
 *  from src/ via tsx. */
function findModSource(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(packageRoot(), "assets", MOD_NAME),
    path.resolve(moduleDir, "../../mod", MOD_NAME),
    path.resolve(moduleDir, "../../../mod", MOD_NAME),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, "info.json")).isFile()) return c;
    } catch {
      // try next
    }
  }
  throw new Error(
    `cannot find the ${MOD_NAME} mod files (looked in: ${candidates.join(", ")}) — is the package installed correctly?`,
  );
}

export interface InstallModResult {
  dest: string;
  /** false when the destination is a symlink we left alone (dev setup). */
  copied: boolean;
}

export function installMod(modsDirPath: string): InstallModResult {
  const source = findModSource();
  const dest = path.join(modsDirPath, MOD_NAME);
  fs.mkdirSync(modsDirPath, { recursive: true });

  let copied = true;
  let destStat: fs.Stats | null = null;
  try {
    destStat = fs.lstatSync(dest);
  } catch {
    destStat = null;
  }
  if (destStat?.isSymbolicLink()) {
    copied = false; // dev setup: the mods dir links straight into the repo
  } else {
    const stage = path.join(modsDirPath, `.${MOD_NAME}.agentic-stage-${process.pid}`);
    const old = path.join(modsDirPath, `.${MOD_NAME}.agentic-old-${process.pid}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    try {
      fs.cpSync(source, stage, { recursive: true });
      if (destStat) fs.renameSync(dest, old);
      fs.renameSync(stage, dest);
      fs.rmSync(old, { recursive: true, force: true });
    } catch (error) {
      fs.rmSync(stage, { recursive: true, force: true });
      if (!fs.existsSync(dest) && fs.existsSync(old)) fs.renameSync(old, dest);
      throw error;
    }
  }

  enableInModList(modsDirPath);
  return { dest, copied };
}

function enableInModList(modsDirPath: string): void {
  const modListPath = path.join(modsDirPath, "mod-list.json");
  let mods: ModListEntry[] = [{ name: "base", enabled: true }];
  try {
    const parsed = JSON.parse(fs.readFileSync(modListPath, "utf8")) as { mods?: ModListEntry[] };
    if (Array.isArray(parsed.mods)) mods = parsed.mods;
  } catch (error) {
    if (fs.existsSync(modListPath)) {
      throw new Error(
        `cannot safely update ${modListPath}: ${error instanceof Error ? error.message : error}`,
      );
    }
    // Missing is fine: create the initial list.
  }
  const entry = mods.find((m) => m.name === MOD_NAME);
  if (entry) {
    entry.enabled = true;
  } else {
    mods.push({ name: MOD_NAME, enabled: true });
  }
  atomicWriteFile(modListPath, `${JSON.stringify({ mods }, null, 2)}\n`);
}
