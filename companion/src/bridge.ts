// Typed wrapper over RCON → remote.call("agentic","rpc",...) (see docs/PROTOCOL.md).
import { RconClient } from "./rcon.js";
import type { ChunkedEnvelope, GetTaskResult, Task } from "./types.js";
import { parseRpcEnvelope, type RpcMethod } from "./protocol/contract.js";
import { recordRpc } from "./telemetry.js";

export class ModError extends Error {}

/** Escapes a string for inclusion in a double-quoted Lua string literal.
 *  JSON.stringify output never contains raw control characters, so escaping
 *  backslash and double-quote is sufficient. */
export function escapeLuaString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface EnqueueOptions {
  replace?: boolean;
  timeoutMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Bridge {
  constructor(private readonly rcon: RconClient) {}

  async call<T>(method: RpcMethod, params?: unknown): Promise<T> {
    const started = performance.now();
    let succeeded = false;
    try {
      const result = await this.callUnchecked<T>(method, params);
      succeeded = true;
      return result;
    } finally {
      recordRpc(method, performance.now() - started, succeeded);
    }
  }

  private async callUnchecked<T>(method: RpcMethod, params?: unknown): Promise<T> {
    const json = escapeLuaString(JSON.stringify(params ?? {}));
    const cmd = `/silent-command remote.call("agentic","rpc","${method}","${json}")`;
    const raw = (await this.rcon.exec(cmd)).trim();
    if (!raw) {
      throw new ModError(
        "empty response from the game — is the agentic-companion mod installed and enabled on this save?",
      );
    }
    let envelope: ReturnType<typeof parseRpcEnvelope>;
    try {
      envelope = parseRpcEnvelope(raw);
    } catch (error) {
      throw new ModError(
        `invalid protocol response from the game: ${raw.slice(0, 200)} (${error instanceof Error ? error.message : error})`,
      );
    }
    if (envelope.ok && envelope.chunked) {
      // Oversized response: part 1 came inline, fetch parts 2..N and reparse.
      const head = envelope as unknown as ChunkedEnvelope;
      let assembled = head.data;
      for (let part = 2; part <= head.parts; part++) {
        const chunk = await this.call<{ data: string }>("get_chunk", { id: head.id, part });
        assembled += chunk.data;
      }
      try {
        envelope = parseRpcEnvelope(assembled);
      } catch {
        throw new ModError(
          `unparseable chunked response from the game (${head.parts} parts, ${assembled.length} bytes)`,
        );
      }
    }
    if (!envelope.ok) {
      throw new ModError(envelope.error ?? "unknown mod error");
    }
    return envelope.data as T;
  }

  /** A view of this bridge that acts as the named companion: every call gets
   *  `companion` merged into its params (the mod routes on it). Prototype
   *  chain keeps enqueueAndWait/unlock working through the overridden call. */
  scoped(companion: string): Bridge {
    const parent = this;
    const child = Object.create(parent) as Bridge;
    child.call = <T>(method: RpcMethod, params?: unknown): Promise<T> =>
      parent.call<T>(method, { ...((params as Record<string, unknown>) ?? {}), companion });
    return child;
  }

  /** Factorio requires the first Lua command of a session to be repeated as an
   *  "this disables achievements" confirmation, and returns nothing until then.
   *  Send a harmless ping up to twice to get past it. Call once after connect. */
  async unlock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.call("ping");
        return;
      } catch (err) {
        if (!(err instanceof ModError) || !/empty response/.test(err.message)) throw err;
      }
    }
    throw new ModError(
      "the game did not accept Lua commands — is the agentic-companion mod installed and enabled on this save?",
    );
  }

  /** Enqueues a task and polls until it reaches a terminal state.
   *  Resolves with the human-readable detail; rejects (ModError) on failure. */
  async enqueueAndWait(task: Task, opts: EnqueueOptions = {}): Promise<string> {
    const { task_id } = await this.call<{ task_id: number }>("enqueue", {
      task,
      replace: opts.replace ?? false,
    });
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const pollMs = opts.pollMs ?? 500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(pollMs);
      const st = await this.call<GetTaskResult>("get_task", { task_id });
      switch (st.status) {
        case "done":
          return st.detail || "done";
        case "failed":
          throw new ModError(st.detail || "task failed");
        case "cancelled":
          throw new ModError("the task was cancelled");
        default:
          break; // queued / running
      }
    }
    await this.call("cancel", { task_id }).catch(() => {});
    throw new ModError(`gave up after ${Math.round(timeoutMs / 1000)}s — task cancelled`);
  }
}
