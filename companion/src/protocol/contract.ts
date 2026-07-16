import { z } from "zod";

export const PROTOCOL_VERSION = 4;

/** Executable manifest shared by runtime validation and conformance tests. */
export const RPC_METHODS = [
  "ping",
  "echo",
  "spawn_companion",
  "get_chat",
  "say",
  "get_state",
  "check_inventory",
  "inspect",
  "analyze_factory",
  "start_research",
  "equip",
  "scan_area",
  "can_place",
  "find_buildable_area",
  "describe_prototype",
  "import_blueprint",
  "list_blueprints",
  "read_blueprint",
  "take_screenshot",
  "exit_vehicle",
  "list_trains",
  "set_train_schedule",
  "get_events",
  "enqueue",
  "get_task",
  "cancel",
  "get_chunk",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export function assertProtocolCompatibility(value: { protocol_version?: number }): void {
  if (value.protocol_version !== PROTOCOL_VERSION) {
    throw new Error(
      `protocol mismatch: mod v${value.protocol_version ?? "unknown"}, companion v${PROTOCOL_VERSION} — reinstall the matching mod and restart Factorio`,
    );
  }
}

const successEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.unknown().optional(),
  chunked: z.literal(false).optional(),
});

export const chunkedEnvelopeSchema = z.object({
  ok: z.literal(true),
  chunked: z.literal(true),
  id: z.number().int().nonnegative(),
  parts: z.number().int().min(1),
  data: z.string(),
});

const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
});

export const rpcEnvelopeSchema = z.union([
  chunkedEnvelopeSchema,
  successEnvelopeSchema,
  errorEnvelopeSchema,
]);

export type RpcEnvelope = z.infer<typeof rpcEnvelopeSchema>;

export function parseRpcEnvelope(raw: string): RpcEnvelope {
  const json: unknown = JSON.parse(raw);
  return rpcEnvelopeSchema.parse(json);
}
