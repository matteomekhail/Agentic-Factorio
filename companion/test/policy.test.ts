import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/agent/prompt.js";
import { CODEX_BRAIN_INSTRUCTIONS, CORE_GAMEPLAY_POLICY, MCP_GAMEPLAY_INSTRUCTIONS } from "../src/agent/policy.js";

describe("shared brain policy", () => {
  it("is embedded in every brain surface", () => {
    expect(SYSTEM_PROMPT).toContain(CORE_GAMEPLAY_POLICY);
    expect(CODEX_BRAIN_INSTRUCTIONS).toContain(CORE_GAMEPLAY_POLICY);
    expect(MCP_GAMEPLAY_INSTRUCTIONS).toContain(CORE_GAMEPLAY_POLICY);
  });
});
