import { z } from "zod";
import { Bridge } from "../bridge.js";
import type { ToolOutput, ToolSpec } from "./adapter.js";

const companionField = z.string().max(20).optional().describe(
  'which companion performs this (default "AI"); other_companions in look_around lists the crew',
);
const backgroundField = z.boolean().optional().describe(
  "action tasks only: true = return after enqueue and report the outcome later as an [event]",
);

function errorResult(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) =>
      `${issue.path.join(".") || "input"}: ${issue.message}`,
    ).join("; ");
    return `Error: invalid arguments — ${issues}`;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(
  name: string,
  description: string,
  schema: S,
  run: (bridge: Bridge, args: z.infer<S>) => Promise<ToolOutput>,
): ToolSpec {
  const fullSchema = schema.extend({ companion: companionField, background: backgroundField });
  return {
    name,
    description,
    schema: fullSchema,
    execute: async (bridge, args) => {
      try {
        const parsed = fullSchema.parse(args);
        const { companion, background } = parsed as { companion?: string; background?: boolean };
        let scoped = companion ? bridge.scoped(companion) : bridge;
        if (background) {
          const base = scoped;
          scoped = Object.create(base) as Bridge;
          scoped.enqueueAndWait = async (task, options) => {
            const result = await base.call<{ task_id: number; companion: string }>("enqueue", {
              task,
              replace: options?.replace ?? false,
              background: true,
            });
            return `Queued in background as task #${result.task_id} for ${result.companion} — the outcome will arrive as an [event].`;
          };
        }
        return await run(scoped, parsed as z.infer<S>);
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export const directionField = z.number().int().min(0).max(15).optional().describe(
  "16-way direction: 0=north, 4=east, 8=south, 12=west",
);
export const itemsField = z.record(z.string(), z.number().int().min(1)).describe(
  'item name to count, e.g. {"coal": 10}',
);
