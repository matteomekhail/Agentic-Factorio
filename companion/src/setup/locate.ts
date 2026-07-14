// Finds the Factorio user-data directory (config + mods live under it).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Standard per-OS Factorio user-data dir, or null if it doesn't exist
 *  (custom install location, or Factorio never started). */
export function factorioUserDir(): string | null {
  let candidate: string;
  switch (process.platform) {
    case "darwin":
      candidate = path.join(os.homedir(), "Library", "Application Support", "factorio");
      break;
    case "win32":
      candidate = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Factorio");
      break;
    default:
      candidate = path.join(os.homedir(), ".factorio");
      break;
  }
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

export function factorioConfigPath(userDir: string): string {
  return path.join(userDir, "config", "config.ini");
}

export function modsDir(userDir: string): string {
  return path.join(userDir, "mods");
}
