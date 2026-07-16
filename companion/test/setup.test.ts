import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchRconConfig } from "../src/setup/configini.js";
import { setupTransaction } from "../src/setup/transaction.js";

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factorio-setup-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("setup transaction", () => {
  it("rolls files and directories back when a later step fails", () => {
    const root = tempDir();
    const file = path.join(root, "config.ini");
    const mod = path.join(root, "mods", "agentic-companion");
    fs.mkdirSync(mod, { recursive: true });
    fs.writeFileSync(file, "original\n");
    fs.writeFileSync(path.join(mod, "old.lua"), "old");

    expect(() => setupTransaction([file, mod], () => {
      fs.writeFileSync(file, "changed\n");
      fs.rmSync(mod, { recursive: true });
      fs.mkdirSync(mod, { recursive: true });
      fs.writeFileSync(path.join(mod, "new.lua"), "new");
      throw new Error("late failure");
    })).toThrow("late failure");

    expect(fs.readFileSync(file, "utf8")).toBe("original\n");
    expect(fs.readFileSync(path.join(mod, "old.lua"), "utf8")).toBe("old");
    expect(fs.existsSync(path.join(mod, "new.lua"))).toBe(false);
  });

  it("commits all changes after success", () => {
    const file = path.join(tempDir(), "new.txt");
    setupTransaction([file], () => fs.writeFileSync(file, "committed"));
    expect(fs.readFileSync(file, "utf8")).toBe("committed");
  });
});

describe("patchRconConfig", () => {
  it("is idempotent and preserves CRLF", () => {
    const file = path.join(tempDir(), "config.ini");
    fs.writeFileSync(file, "[other]\r\n; local-rcon-socket=old\r\n");
    expect(patchRconConfig(file, { port: 27015, password: "secret" }).changed).toBe(true);
    const once = fs.readFileSync(file, "utf8");
    expect(once).toContain("local-rcon-password=secret\r\n");
    expect(patchRconConfig(file, { port: 27015, password: "secret" }).changed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(once);
  });
});
