import type { RpcMethod } from "./protocol/contract.js";

interface MethodMetrics {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

const startedAt = Date.now();
const methods = new Map<RpcMethod, MethodMetrics>();

export function recordRpc(method: RpcMethod, durationMs: number, ok: boolean): void {
  const current = methods.get(method) ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
  current.calls++;
  if (!ok) current.errors++;
  current.totalMs += durationMs;
  current.maxMs = Math.max(current.maxMs, durationMs);
  methods.set(method, current);
}

/** Safe to print or attach to a diagnostic report: contains no arguments or secrets. */
export function telemetrySnapshot() {
  return {
    uptime_ms: Date.now() - startedAt,
    rpc: Object.fromEntries(
      [...methods.entries()].map(([name, value]) => [
        name,
        {
          calls: value.calls,
          errors: value.errors,
          avg_ms: Math.round(value.totalMs / value.calls),
          max_ms: Math.round(value.maxMs),
        },
      ]),
    ),
  };
}
