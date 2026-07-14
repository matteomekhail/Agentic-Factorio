// Idempotently enables local RCON in Factorio's config.ini so that hosting
// any game (including "Host saved game") opens an RCON port on localhost.
import fs from "node:fs";
import path from "node:path";

export interface RconIniSettings {
  port: number;
  password: string;
}

const SOCKET_RE = /^\s*;?\s*local-rcon-socket\s*=/;
const PASSWORD_RE = /^\s*;?\s*local-rcon-password\s*=/;

export function patchRconConfig(configIniPath: string, settings: RconIniSettings): { changed: boolean } {
  let original: string;
  try {
    original = fs.readFileSync(configIniPath, "utf8");
  } catch {
    throw new Error(
      `config.ini not found at ${configIniPath} — start Factorio once so it creates its config, then re-run setup`,
    );
  }

  const socketLine = `local-rcon-socket=127.0.0.1:${settings.port}`;
  const passwordLine = `local-rcon-password=${settings.password}`;

  const lines = original.split(/\r?\n/);
  const out: string[] = [];
  let socketDone = false;
  let passwordDone = false;
  for (const line of lines) {
    if (SOCKET_RE.test(line)) {
      if (!socketDone) out.push(socketLine);
      socketDone = true; // duplicates (commented or not) are dropped
    } else if (PASSWORD_RE.test(line)) {
      if (!passwordDone) out.push(passwordLine);
      passwordDone = true;
    } else {
      out.push(line);
    }
  }

  // Not present anywhere: put them under [other] (created if missing).
  if (!socketDone || !passwordDone) {
    const missing = [...(!socketDone ? [socketLine] : []), ...(!passwordDone ? [passwordLine] : [])];
    const otherIdx = out.findIndex((l) => l.trim() === "[other]");
    if (otherIdx >= 0) {
      out.splice(otherIdx + 1, 0, ...missing);
    } else {
      while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
      out.push("[other]", ...missing, "");
    }
  }

  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const updated = out.join(eol);
  if (updated === original) return { changed: false };

  const backupPath = path.join(path.dirname(configIniPath), "config.ini.agentic-bak");
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configIniPath, backupPath); // keep the pristine original only
  }
  fs.writeFileSync(configIniPath, updated, "utf8");
  return { changed: true };
}
