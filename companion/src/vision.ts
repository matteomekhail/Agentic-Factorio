import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Bridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { factorioUserDir } from "./setup/locate.js";

const SCREENSHOT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

export interface ViewAreaArgs {
  center?: { x: number; y: number };
  radius?: number;
}

interface ScreenshotRequestResult {
  path: string;
  center: { x: number; y: number };
  radius: number;
  resolution: { w: number; h: number };
}

export interface ImageToolOutput {
  text: string;
  image: {
    data: string;
    mimeType: "image/jpeg";
    filename: string;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function configuredUserDir(): string | null {
  const fromEnv = process.env.AGENTIC_FACTORIO_USER_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const fromConfig = loadConfig()?.factorioUserDir?.trim();
  if (fromConfig) return path.resolve(fromConfig);
  return factorioUserDir();
}

/** Resolve a mod-returned script-output path without permitting traversal. */
export function screenshotFilePath(relativePath: string, userDir?: string): string {
  const resolvedUserDir = userDir ? path.resolve(userDir) : configuredUserDir();
  if (!resolvedUserDir) {
    throw new Error(
      "cannot find Factorio's user-data directory; set AGENTIC_FACTORIO_USER_DIR to the folder containing script-output",
    );
  }
  const root = path.resolve(resolvedUserDir, "script-output");
  const file = path.resolve(root, relativePath);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new Error("Factorio returned an invalid screenshot path");
  }
  return file;
}

/** Wait for the end-of-tick renderer, then read and remove the temporary file. */
export async function readScreenshot(
  relativePath: string,
  options: { userDir?: string; timeoutMs?: number } = {},
): Promise<Buffer> {
  const file = screenshotFilePath(relativePath, options.userDir);
  const deadline = Date.now() + (options.timeoutMs ?? SCREENSHOT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    try {
      const data = await fs.readFile(file);
      if (data.length > 0) {
        await fs.unlink(file).catch(() => {});
        return data;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    "Factorio did not render the screenshot; screenshots require the companion app and a non-headless Factorio host on the same machine",
  );
}

export async function captureView(bridge: Bridge, args: ViewAreaArgs): Promise<ImageToolOutput> {
  const result = await bridge.call<ScreenshotRequestResult>("take_screenshot", {
    ...args,
    request_id: crypto.randomUUID(),
  });
  const data = await readScreenshot(result.path);
  return {
    text:
      `Visual view centered at (${result.center.x}, ${result.center.y}), ` +
      `covering roughly ${result.radius} tiles in every direction. ` +
      "Use structured tools for exact coordinates, counts and machine state.",
    image: {
      data: data.toString("base64"),
      mimeType: "image/jpeg",
      filename: path.basename(result.path),
    },
  };
}
