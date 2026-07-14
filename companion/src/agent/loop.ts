// Event-driven agent loop: wakes when players speak, runs a bounded tool loop,
// keeps a compacted conversation history across wakes (persisted per game).
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { Bridge, ModError } from "../bridge.js";
import { log } from "../log.js";
import { formatState } from "../tools/definitions.js";
import type { ChatMessage, GetStateResult } from "../types.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { loadSession, saveSession } from "./session.js";

const MAX_STEPS_PER_WAKE = 15;
const MAX_HISTORY_MESSAGES = 40;
const DEFAULT_BUDGET_WARN_TOKENS = 1_000_000;

export interface AgentLoopOptions {
  /** Persist/restore history under this key (omit for an in-memory session). */
  sessionKey?: string;
  /** Warn once when cumulative in+out tokens cross this (default 1M). */
  budgetWarnTokens?: number;
}

export class AgentLoop {
  private history: ModelMessage[] = [];
  private inbox: ChatMessage[] = [];
  private running = false;
  private abort: AbortController | null = null;
  private readonly sessionKey: string | undefined;
  private readonly budgetWarnTokens: number;
  private totalTokens = 0;
  private budgetWarned = false;
  private proactiveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bridge: Bridge,
    private readonly model: LanguageModel,
    private readonly tools: ToolSet,
    opts: AgentLoopOptions = {},
  ) {
    this.sessionKey = opts.sessionKey;
    this.budgetWarnTokens = opts.budgetWarnTokens ?? DEFAULT_BUDGET_WARN_TOKENS;
    if (this.sessionKey) {
      const saved = loadSession(this.sessionKey);
      if (saved && saved.length > 0) {
        this.history = saved;
        log.info(`restored session memory (${saved.length} messages)`);
      }
    }
  }

  onChat(msg: ChatMessage): void {
    log.chat(msg.player, msg.text);
    if (msg.text.trim() === "!stop") {
      void this.emergencyStop();
      return;
    }
    this.inbox.push(msg);
    void this.drain();
  }

  /** Every `minutes`, nudge the agent to look around and report only if
   *  something needs attention. Skipped while a wake is already running. */
  startProactive(minutes: number): void {
    this.stopProactive();
    if (!(minutes > 0)) return;
    this.proactiveTimer = setInterval(() => {
      if (this.running || this.inbox.length > 0) return;
      this.inbox.push({
        id: -1,
        tick: 0,
        player: "[routine]",
        text: "Periodic check-in: look around and, ONLY if something needs attention (idle machines, low resources, enemies close), say a one-sentence heads-up. Otherwise stay silent.",
      });
      void this.drain();
    }, minutes * 60_000);
    log.info(`proactive check-ins every ${minutes} min`);
  }

  stopProactive(): void {
    if (this.proactiveTimer) clearInterval(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  /** Stop timers and persist memory. Call on shutdown. */
  dispose(): void {
    this.stopProactive();
    this.persist();
  }

  /** Kill switch: bypasses the LLM entirely. */
  private async emergencyStop(): Promise<void> {
    this.abort?.abort();
    this.inbox = [];
    try {
      const res = await this.bridge.call<{ cancelled: number }>("cancel", { all: true });
      await this.bridge.call("say", { text: "Stopped everything." });
      log.info(`!stop — cancelled ${res.cancelled} task(s)`);
    } catch (err) {
      log.error(`!stop failed: ${err instanceof Error ? err.message : err}`);
    }
    this.history.push({
      role: "user",
      content: "[system note] The player typed !stop: everything you were doing was force-cancelled.",
    });
    this.persist();
  }

  private async drain(): Promise<void> {
    if (this.running) return; // current wake will pick the inbox up on its next lap
    this.running = true;
    try {
      while (this.inbox.length > 0) {
        const batch = this.inbox.splice(0);
        await this.wake(batch);
      }
    } finally {
      this.running = false;
    }
  }

  private async wake(batch: ChatMessage[]): Promise<void> {
    const state = await this.bridge
      .call<GetStateResult>("get_state", {})
      .catch(() => null);

    const parts = [
      state ? `Current game state:\n${formatState(state)}` : "(could not read the game state)",
      "New chat:",
      ...batch.map((m) => `<${m.player}> ${m.text}`),
    ];
    this.history.push({ role: "user", content: parts.join("\n") });

    this.abort = new AbortController();
    try {
      const result = await generateText({
        model: this.model,
        system: SYSTEM_PROMPT,
        messages: this.history,
        tools: this.tools,
        stopWhen: stepCountIs(MAX_STEPS_PER_WAKE),
        abortSignal: this.abort.signal,
      });
      this.history.push(...result.response.messages);
      const usage = result.totalUsage;
      this.trackUsage(usage.inputTokens, usage.outputTokens);
      log.info(
        `wake done — ${result.steps.length} step(s), tokens in/out: ${usage.inputTokens ?? "?"}/${usage.outputTokens ?? "?"}`,
      );
    } catch (err) {
      if (this.abort.signal.aborted) {
        log.info("generation aborted by !stop");
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`agent error: ${msg}`);
      await this.bridge
        .call("say", { text: "Something went wrong on my end, give me a moment." })
        .catch(() => {});
      // Drop the failed user turn so a provider hiccup doesn't poison history.
      this.history.pop();
    } finally {
      this.abort = null;
      this.trimHistory();
      this.persist();
    }
  }

  private trackUsage(inputTokens: number | undefined, outputTokens: number | undefined): void {
    this.totalTokens += (inputTokens ?? 0) + (outputTokens ?? 0);
    if (!this.budgetWarned && this.totalTokens >= this.budgetWarnTokens) {
      this.budgetWarned = true;
      log.warn(
        `token budget: ${this.totalTokens.toLocaleString()} tokens used this run (warn threshold ${this.budgetWarnTokens.toLocaleString()}) — keep an eye on provider costs`,
      );
    }
  }

  private persist(): void {
    if (!this.sessionKey) return;
    try {
      saveSession(this.sessionKey, this.history);
    } catch (err) {
      log.warn(`could not save session memory: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Naive M1 compaction: cap message count, always cutting at a user boundary
   *  so tool-call/tool-result pairs are never split. */
  private trimHistory(): void {
    if (this.history.length <= MAX_HISTORY_MESSAGES) return;
    let cut = this.history.length - MAX_HISTORY_MESSAGES;
    while (cut < this.history.length && this.history[cut]?.role !== "user") {
      cut++;
    }
    this.history = this.history.slice(cut);
  }
}
