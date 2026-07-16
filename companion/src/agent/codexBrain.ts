// Subscription brain: instead of an LLM API loop, each batch of chat messages
// spawns `codex exec` (first turn) / `codex exec resume <id>` (later turns) —
// the user's ChatGPT subscription pays, and nobody polls: the ChatPoller wakes
// this brain only when a player actually says something.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge } from "../bridge.js";
import { log } from "../log.js";
import type { ChatMessage } from "../types.js";
import { CODEX_BRAIN_INSTRUCTIONS } from "./policy.js";
import { formatState } from "../tools/definitions.js";
import type { GetStateResult } from "../types.js";

const TURN_TIMEOUT_MS = 20 * 60 * 1000;

const FIRST_TURN_INSTRUCTIONS = `${CODEX_BRAIN_INSTRUCTIONS}\n\nMessages from the game:`;

export interface CodexBrainOptions {
  cwd?: string;
  model?: string;
  /** Persist the Codex conversation id under this key so restarts keep memory. */
  sessionKey?: string;
}

function sessionFile(key: string): string {
  return path.join(os.homedir(), ".config", "agentic-factorio", "sessions", `codex-${key}.json`);
}

export class CodexBrain {
  private sessionId: string | null = null;
  private inbox: ChatMessage[] = [];
  private running = false;
  private drainScheduled = false;
  private proc: ChildProcess | null = null;
  private disposed = false;

  constructor(
    private readonly bridge: Bridge,
    private readonly opts: CodexBrainOptions = {},
  ) {
    if (opts.sessionKey) {
      try {
        const data = JSON.parse(readFileSync(sessionFile(opts.sessionKey), "utf8"));
        if (typeof data.sessionId === "string" && data.sessionId.length >= 8) {
          this.sessionId = data.sessionId;
          log.info(`resuming saved codex session ${this.sessionId}`);
        }
      } catch {
        // no saved session — start fresh
      }
    }
  }

  private persistSession(): void {
    if (!this.opts.sessionKey) return;
    const file = sessionFile(this.opts.sessionKey);
    try {
      if (this.sessionId) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ sessionId: this.sessionId }));
      } else {
        rmSync(file, { force: true });
      }
    } catch (err) {
      log.warn(`couldn't persist codex session: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Push events from the game (attacked, died, research done, supply warnings). */
  onEvent(event: { tick: number; text: string }): void {
    log.info(`game event: ${event.text}`);
    this.inbox.push({ id: 0, tick: event.tick, player: "[event]", text: event.text });
    this.scheduleDrain();
  }

  onChat(msg: ChatMessage): void {
    log.chat(msg.player, msg.text);
    if (msg.text.trim() === "!stop") {
      void this.emergencyStop();
      return;
    }
    this.inbox.push(msg);
    this.scheduleDrain();
  }

  dispose(): void {
    this.disposed = true;
    this.proc?.kill("SIGTERM");
  }

  private async emergencyStop(): Promise<void> {
    this.inbox = [];
    this.proc?.kill("SIGTERM");
    try {
      await this.bridge.call("cancel", { all: true });
      await this.bridge.call("say", { text: "Stopped everything." });
      log.info("!stop — tasks cancelled, codex turn aborted");
    } catch (err) {
      log.error(`!stop failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.inbox.length > 0 && !this.disposed) {
        const batch = this.inbox.splice(0);
        await this.runTurn(batch);
      }
    } finally {
      this.running = false;
    }
  }

  private async runTurn(batch: ChatMessage[], isRetry = false): Promise<void> {
    const chatLines = batch.map((m) => `<${m.player}> ${m.text}`).join("\n");
    const state = await this.bridge.call<GetStateResult>("get_state", {}).catch(() => null);
    const context = state ? `Current game state (already fresh; do not re-read it without a reason):\n${formatState(state)}\n\n` : "";
    const prompt = this.sessionId
      ? `${context}New messages from the game:\n${chatLines}`
      : `${FIRST_TURN_INSTRUCTIONS}\n${context}${chatLines}`;

    const wasResume = this.sessionId !== null;
    const args = this.sessionId
      ? ["exec", "resume", this.sessionId, "--json", prompt]
      : ["exec", "--json", prompt];
    if (this.opts.model) args.splice(1, 0, "-m", this.opts.model);

    log.info(`codex turn starting (${wasResume ? "resume" : "new session"})`);
    const exitCode = await new Promise<number | null>((resolve) => {
      const proc = spawn("codex", args, {
        cwd: this.opts.cwd ?? process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.proc = proc;
      const timer = setTimeout(() => {
        log.warn("codex turn exceeded 20 minutes — killing it");
        proc.kill("SIGTERM");
      }, TURN_TIMEOUT_MS);

      let stdoutBuf = "";
      proc.stdout.on("data", (d: Buffer) => {
        stdoutBuf += d.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line) this.handleEventLine(line);
        }
      });
      proc.stderr.on("data", (d: Buffer) => {
        const text = d.toString().trim();
        if (text) log.info(`codex: ${text.split("\n")[0]}`);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        this.proc = null;
        resolve(code);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        this.proc = null;
        log.error(`cannot launch codex: ${err.message} — is Codex CLI installed and signed in?`);
        resolve(null);
      });
    });

    if (exitCode === 0 || this.disposed || exitCode === null) {
      if (exitCode === 0) log.info("codex turn finished");
      return;
    }
    if (wasResume && !isRetry) {
      // Saved conversation likely expired/rotated: drop it and replay fresh.
      log.warn(`codex resume failed (exit ${exitCode}) — starting a fresh session`);
      this.sessionId = null;
      this.persistSession();
      await this.runTurn(batch, true);
      return;
    }
    log.warn(`codex exited with code ${exitCode}`);
    void this.bridge
      .call("say", { text: "Ho avuto un problema con il mio cervello (Codex) — riprova tra poco." })
      .catch(() => {});
  }

  private handleEventLine(line: string): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!this.sessionId) {
      const id =
        event.thread_id ?? event.session_id ?? event.thread?.id ?? event.session?.id ?? null;
      if (typeof id === "string" && id.length >= 8) {
        this.sessionId = id;
        this.persistSession();
        log.info(`codex session ${id}`);
      }
    }
    const item = event.item ?? event;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      log.ai(item.text.split("\n")[0]?.slice(0, 160) ?? "");
    } else if (typeof item?.type === "string" && /tool|command/.test(item.type) && item.status !== "in_progress") {
      const name = item.name ?? item.tool_name ?? item.title ?? item.type;
      log.tool(String(name), item.status ?? "");
    }
  }
}
