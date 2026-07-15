// Polls the mod's chat ring buffer AND the push-event buffer, emitting typed
// events. Both backlogs are skipped on the first poll so only genuinely new
// activity wakes the brain.
import { EventEmitter } from "node:events";
import { Bridge } from "./bridge.js";
import {
  asArray,
  type ChatMessage,
  type GameEvent,
  type GetChatResult,
  type GetEventsResult,
} from "./types.js";

export interface ChatPollerEvents {
  chat: [ChatMessage];
  gameEvent: [GameEvent];
  error: [Error];
}

export class ChatPoller extends EventEmitter<ChatPollerEvents> {
  private lastId: number | null = null;
  private lastEventId: number | null = null;
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
        this.lastId = res.last_id; // skip pre-existing backlog
      } else {
        for (const msg of asArray(res.messages)) {
          this.lastId = Math.max(this.lastId, msg.id);
          this.emit("chat", msg);
        }
      }

      const ev = await this.bridge.call<GetEventsResult>("get_events", {
        since_id: this.lastEventId ?? 0,
      });
      if (this.lastEventId === null) {
        this.lastEventId = ev.last_id;
      } else {
        for (const event of asArray(ev.events)) {
          this.lastEventId = Math.max(this.lastEventId, event.id);
          this.emit("gameEvent", event);
        }
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.polling = false;
    }
  }
}
