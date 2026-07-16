import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, RPC_METHODS, parseRpcEnvelope } from "../src/protocol/contract.js";
import { toolSpecs } from "../src/tools/definitions.js";

describe("executable protocol contract", () => {
  it("matches every RPC method registered by the Lua mod", () => {
    const repo = path.resolve(import.meta.dirname, "../..");
    const lua = ["mod/agentic-companion/control.lua", "mod/agentic-companion/scripts/rpc.lua"]
      .map((file) => fs.readFileSync(path.join(repo, file), "utf8"))
      .join("\n");
    const registered = [...lua.matchAll(/(?:rpc|M)\.register\("([^"]+)"/g)].map((match) => match[1]);
    expect([...new Set(registered)].sort()).toEqual([...RPC_METHODS].sort());
    expect(lua).toContain(`protocol_version = ${PROTOCOL_VERSION}`);
  });

  it("validates transport envelopes", () => {
    expect(() => parseRpcEnvelope('{"ok":true}')).not.toThrow();
    expect(() => parseRpcEnvelope('{"ok":false}')).toThrow();
    expect(() => parseRpcEnvelope('{"ok":"yes","data":{}}')).toThrow();
  });
});

describe("tool registry", () => {
  it("has unique, documented tools", () => {
    const specs = toolSpecs();
    expect(new Set(specs.map((spec) => spec.name)).size).toBe(specs.length);
    for (const spec of specs) expect(spec.description.length).toBeGreaterThan(20);
  });
});
