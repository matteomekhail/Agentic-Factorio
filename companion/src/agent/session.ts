// Conversation persistence: the companion remembers what happened across
// restarts. One session file per game (keyed by RCON host:port).
import fs from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { configDir } from "../config.js";

const MAX_SAVED_MESSAGES = 60;

export function sessionKey(host: string, port: number): string {
  return `${host.replace(/[^a-zA-Z0-9.-]/g, "_")}-${port}`;
}

function sessionsDir(): string {
  return path.join(configDir(), "sessions");
}

function sessionPath(key: string): string {
  return path.join(sessionsDir(), `${key}.json`);
}

/** Returns the saved history, or null when missing/corrupt (fresh start). */
export function loadSession(key: string): ModelMessage[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionPath(key), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as ModelMessage[];
  } catch {
    return null;
  }
}

/** Persists the last messages, cutting at a user boundary so a resumed
 *  history never starts mid tool-call/tool-result pair. */
export function saveSession(key: string, messages: ModelMessage[]): void {
  let toSave = messages;
  if (toSave.length > MAX_SAVED_MESSAGES) {
    let cut = toSave.length - MAX_SAVED_MESSAGES;
    while (cut < toSave.length && toSave[cut]?.role !== "user") cut++;
    toSave = toSave.slice(cut);
  }
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(sessionPath(key), JSON.stringify(toSave), "utf8");
}
