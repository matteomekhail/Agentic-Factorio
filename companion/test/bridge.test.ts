import { describe, expect, it, vi } from "vitest";
import { Bridge, escapeLuaString, ModError } from "../src/bridge.js";
import type { RconClient } from "../src/rcon.js";

function fakeRcon(execImpl: (cmd: string) => Promise<string>): {
  rcon: RconClient;
  exec: ReturnType<typeof vi.fn>;
} {
  const exec = vi.fn(execImpl);
  return { rcon: { exec } as unknown as RconClient, exec };
}

const ok = (data: unknown) => Promise.resolve(JSON.stringify({ ok: true, data }));

describe("escapeLuaString", () => {
  it("escapes backslashes and quotes", () => {
    expect(escapeLuaString('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it("survives a JSON round trip with nasty content", () => {
    const params = { text: 'he said "ciao" \\ done\nnewline' };
    const escaped = escapeLuaString(JSON.stringify(params));
    // Simulate Lua unescaping of the double-quoted string literal:
    const unescaped = escaped.replace(/\\(["\\])/g, "$1");
    expect(JSON.parse(unescaped)).toEqual(params);
  });
});

describe("Bridge.call", () => {
  it("builds the remote.call command and parses the envelope", async () => {
    const { rcon, exec } = fakeRcon(() => ok({ tick: 42 }));
    const bridge = new Bridge(rcon);
    const res = await bridge.call<{ tick: number }>("ping", {});
    expect(res.tick).toBe(42);
    expect(exec).toHaveBeenCalledWith(
      '/silent-command remote.call("agentic","rpc","ping","{}")',
    );
  });

  it("throws ModError on ok:false", async () => {
    const { rcon } = fakeRcon(() =>
      Promise.resolve(JSON.stringify({ ok: false, error: "boom" })),
    );
    await expect(new Bridge(rcon).call("x")).rejects.toThrow("boom");
  });

  it("throws ModError on empty response (mod missing)", async () => {
    const { rcon } = fakeRcon(() => Promise.resolve("\n"));
    await expect(new Bridge(rcon).call("x")).rejects.toThrow(/mod installed/);
  });

  it("throws ModError on garbage response", async () => {
    const { rcon } = fakeRcon(() => Promise.resolve("Unknown command"));
    await expect(new Bridge(rcon).call("x")).rejects.toThrow(ModError);
  });
});

describe("Bridge.enqueueAndWait", () => {
  it("resolves with the detail when the task finishes", async () => {
    let polls = 0;
    const { rcon } = fakeRcon((cmd) => {
      if (cmd.includes('"enqueue"')) return ok({ task_id: 7 });
      polls++;
      return polls < 3
        ? ok({ status: "running", detail: "" })
        : ok({ status: "done", detail: "arrived at (1.0, 2.0)" });
    });
    const bridge = new Bridge(rcon);
    await expect(
      bridge.enqueueAndWait({ type: "walk_to", target: { x: 1, y: 2 } }, { pollMs: 1 }),
    ).resolves.toBe("arrived at (1.0, 2.0)");
  });

  it("rejects when the task fails", async () => {
    const { rcon } = fakeRcon((cmd) =>
      cmd.includes('"enqueue"')
        ? ok({ task_id: 8 })
        : ok({ status: "failed", detail: "got stuck" }),
    );
    await expect(
      new Bridge(rcon).enqueueAndWait({ type: "mine", target: { x: 0, y: 0 } }, { pollMs: 1 }),
    ).rejects.toThrow("got stuck");
  });

  it("cancels and rejects on timeout", async () => {
    const cancelled: string[] = [];
    const { rcon } = fakeRcon((cmd) => {
      if (cmd.includes('"enqueue"')) return ok({ task_id: 9 });
      if (cmd.includes('"cancel"')) {
        cancelled.push(cmd);
        return ok({ cancelled: 1 });
      }
      return ok({ status: "running", detail: "" });
    });
    await expect(
      new Bridge(rcon).enqueueAndWait(
        { type: "walk_to", target: { x: 1, y: 2 } },
        { pollMs: 1, timeoutMs: 30 },
      ),
    ).rejects.toThrow(/gave up/);
    expect(cancelled).toHaveLength(1);
  });
});
