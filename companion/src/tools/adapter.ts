import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Bridge } from "../bridge.js";
import type { ImageToolOutput } from "../vision.js";
import { toolSpecs } from "./definitions.js";

export type ToolOutput = string | ImageToolOutput;

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  execute(bridge: Bridge, args: Record<string, unknown>): Promise<ToolOutput>;
}

export interface ToolHooks {
  onTool?: (name: string, detail: string) => void;
}

export function isImageToolOutput(output: ToolOutput): output is ImageToolOutput {
  return typeof output !== "string";
}

export function toModelOutput(output: ToolOutput) {
  if (!isImageToolOutput(output)) return { type: "text" as const, value: output };
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: output.text },
      {
        type: "file" as const,
        data: { type: "data" as const, data: output.image.data },
        mediaType: output.image.mimeType,
        filename: output.image.filename,
      },
    ],
  };
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      `${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`,
    )
    .join(" ");
}

/** AI SDK adapter over the neutral registry. MCP consumes the same ToolSpec[]. */
export function buildTools(bridge: Bridge, hooks: ToolHooks = {}): ToolSet {
  const tools: ToolSet = {};
  for (const spec of toolSpecs()) {
    tools[spec.name] = tool<Record<string, unknown>, ToolOutput, {}>({
      description: spec.description,
      inputSchema: spec.schema,
      execute: async (args) => {
        const record = args as Record<string, unknown>;
        hooks.onTool?.(spec.name, summarizeArgs(record));
        return spec.execute(bridge, record);
      },
      toModelOutput: ({ output }) => toModelOutput(output as ToolOutput),
    });
  }
  return tools;
}
