// Polls the mod's chat ring buffer and emits typed events.
import { EventEmitter } from "node:events";
import { Bridge } from "./bridge.js";
import { asArray, type ChatMessage, type GetChatResult } from "./types.js";

export interface ChatPollerEvents {
  chat: [ChatMessage];
  error: [Error];
}

export class ChatPoller extends EventEmitter<ChatPollerEvents> {
  private lastId: number | null = null; // null until the backlog is skipped
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly bridge: Bridge,
    private readonly intervalMs = 500,
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await this.bridge.call<GetChatResult>("get_chat", {
        since_id: this.lastId ?? 0,
      });
      if (this.lastId === null) {
        // First poll: skip anything said before the companion started.
        this.lastId = res.last_id;
        return;
      }
      for (const msg of asArray(res.messages)) {
        this.lastId = Math.max(this.lastId, msg.id);
        this.emit("chat", msg);
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.polling = false;
    }
  }
}
