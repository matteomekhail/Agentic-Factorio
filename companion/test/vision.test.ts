import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { compactVisualToolResults } from "../src/agent/loop.js";
import { readScreenshot, screenshotFilePath } from "../src/vision.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempUserDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-factorio-vision-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "script-output", "agentic-factorio"), { recursive: true });
  return dir;
}

describe("screenshotFilePath", () => {
  it("resolves paths inside script-output", async () => {
    const userDir = await tempUserDir();
    expect(screenshotFilePath("agentic-factorio/view-123.jpg", userDir)).toBe(
      path.join(userDir, "script-output", "agentic-factorio", "view-123.jpg"),
    );
  });

  it("rejects traversal outside script-output", async () => {
    const userDir = await tempUserDir();
    expect(() => screenshotFilePath("../secrets.txt", userDir)).toThrow(/invalid screenshot path/);
  });
});

describe("readScreenshot", () => {
  it("waits for the end-of-tick file, reads it, then removes it", async () => {
    const userDir = await tempUserDir();
    const relative = "agentic-factorio/view-delayed.jpg";
    const file = screenshotFilePath(relative, userDir);
    setTimeout(() => void fs.writeFile(file, Buffer.from("jpeg bytes")), 25);

    await expect(readScreenshot(relative, { userDir, timeoutMs: 1_000 })).resolves.toEqual(
      Buffer.from("jpeg bytes"),
    );
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("explains the local non-headless requirement when no image appears", async () => {
    const userDir = await tempUserDir();
    await expect(
      readScreenshot("agentic-factorio/missing.jpg", { userDir, timeoutMs: 20 }),
    ).rejects.toThrow(/non-headless Factorio host on the same machine/);
  });
});

describe("compactVisualToolResults", () => {
  it("keeps the current-turn observation but drops stale base64 from saved history", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "view_area",
            output: {
              type: "content",
              value: [
                { type: "text", text: "fresh view" },
                { type: "file-data", data: "very-large-base64", mediaType: "image/jpeg" },
              ],
            },
          },
        ],
      },
    ] as ModelMessage[];

    const compacted = compactVisualToolResults(messages);
    expect(JSON.stringify(compacted)).not.toContain("very-large-base64");
    expect(JSON.stringify(compacted)).toContain("call view_area again");
  });
});
