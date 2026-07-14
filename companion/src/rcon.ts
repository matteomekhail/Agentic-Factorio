// Hand-rolled Source RCON client. Factorio splits responses larger than ~4 kB
// into multiple packets sharing the request id, with no terminator — so every
// command is followed by a "sentinel" command; when the sentinel's response
// arrives, everything buffered for the real id is the full response.
// The sentinel body is a single space: Factorio sends NO response at all to a
// zero-length command (verified against 2.0.77), but replies to " ".
import net from "node:net";
import { EventEmitter } from "node:events";

const AUTH = 3;
const EXEC_COMMAND = 2;
const AUTH_RESPONSE = 2;

export class RconError extends Error {}

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  /** Per-command timeout (default 10s). */
  timeoutMs?: number;
}

interface PendingExec {
  id: number;
  sentinelId: number;
  chunks: string[];
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingAuth {
  id: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + bodyBuf.length);
  buf.writeInt32LE(10 + bodyBuf.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  return buf; // trailing two null bytes are already zero
}

export class RconClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private recvBuf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pendingExec: PendingExec | null = null;
  private pendingAuth: PendingAuth | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private authed = false;

  constructor(private readonly opts: RconOptions) {
    super();
  }

  get connected(): boolean {
    return this.authed && this.socket !== null;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.close();

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
      const onError = (err: Error) => {
        socket.destroy();
        reject(new RconError(`cannot connect to RCON at ${this.opts.host}:${this.opts.port}: ${err.message}`));
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        this.socket = socket;
        socket.on("data", (data: Buffer) => this.onData(data));
        socket.on("error", (err) => this.teardown(new RconError(`RCON socket error: ${err.message}`)));
        socket.on("close", () => this.teardown(new RconError("RCON connection closed")));
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      const id = this.allocId();
      this.pendingAuth = { id, resolve, reject };
      this.socket!.write(encodePacket(id, AUTH, this.opts.password));
      setTimeout(() => {
        if (this.pendingAuth?.id === id) {
          this.pendingAuth = null;
          reject(new RconError("RCON auth timed out"));
        }
      }, this.opts.timeoutMs ?? 10_000).unref();
    });
  }

  /** Executes a console command. Commands are serialized (one in flight). */
  exec(command: string): Promise<string> {
    const run = this.chain.then(() => this.execNow(command));
    this.chain = run.catch(() => {});
    return run;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.authed = false;
    socket?.removeAllListeners();
    socket?.destroy();
  }

  private execNow(command: string): Promise<string> {
    if (!this.connected) {
      return Promise.reject(new RconError("not connected — call connect() first"));
    }
    const id = this.allocId();
    const sentinelId = this.allocId();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingExec;
        this.pendingExec = null;
        if (pending && pending.chunks.length > 0) {
          // Sentinel response never arrived but data did (server variant quirk).
          resolve(pending.chunks.join(""));
        } else {
          reject(new RconError(`RCON command timed out after ${this.opts.timeoutMs ?? 10_000}ms`));
        }
      }, this.opts.timeoutMs ?? 10_000);
      this.pendingExec = { id, sentinelId, chunks: [], resolve, reject, timer };
      this.socket!.write(encodePacket(id, EXEC_COMMAND, command));
      this.socket!.write(encodePacket(sentinelId, EXEC_COMMAND, " "));
    });
  }

  private allocId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7ffffffe ? 1 : this.nextId + 1;
    return id;
  }

  private onData(data: Buffer): void {
    this.recvBuf = this.recvBuf.length === 0 ? data : Buffer.concat([this.recvBuf, data]);
    while (this.recvBuf.length >= 4) {
      const size = this.recvBuf.readInt32LE(0);
      if (size < 10 || size > 8 * 1024 * 1024) {
        this.teardown(new RconError(`malformed RCON packet (size=${size})`));
        return;
      }
      if (this.recvBuf.length < 4 + size) break;
      const id = this.recvBuf.readInt32LE(4);
      const type = this.recvBuf.readInt32LE(8);
      const body = this.recvBuf.toString("utf8", 12, 4 + size - 2);
      this.recvBuf = this.recvBuf.subarray(4 + size);
      this.handlePacket(id, type, body);
    }
  }

  private handlePacket(id: number, type: number, body: string): void {
    if (this.pendingAuth) {
      if (type !== AUTH_RESPONSE) return; // some servers send an empty RESPONSE_VALUE first
      const auth = this.pendingAuth;
      this.pendingAuth = null;
      if (id === -1) {
        auth.reject(new RconError("RCON auth failed — wrong password?"));
        this.close();
      } else {
        this.authed = true;
        auth.resolve();
      }
      return;
    }

    const pending = this.pendingExec;
    if (!pending) return;
    if (id === pending.id) {
      pending.chunks.push(body);
    } else if (id === pending.sentinelId) {
      clearTimeout(pending.timer);
      this.pendingExec = null;
      pending.resolve(pending.chunks.join(""));
    }
  }

  private teardown(err: Error): void {
    this.close();
    if (this.pendingAuth) {
      this.pendingAuth.reject(err);
      this.pendingAuth = null;
    }
    if (this.pendingExec) {
      clearTimeout(this.pendingExec.timer);
      this.pendingExec.reject(err);
      this.pendingExec = null;
    }
    this.emit("close", err);
  }
}
