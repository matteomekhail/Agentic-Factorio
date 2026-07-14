// Subscription brain: instead of an LLM API loop, each batch of chat messages
// spawns `codex exec` (first turn) / `codex exec resume <id>` (later turns) —
// the user's ChatGPT subscription pays, and nobody polls: the ChatPoller wakes
// this brain only when a player actually says something.
import { spawn, type ChildProcess } from "node:child_process";
import { Bridge } from "../bridge.js";
import { log } from "../log.js";
import type { ChatMessage } from "../types.js";

const TURN_TIMEOUT_MS = 20 * 60 * 1000;

const FIRST_TURN_INSTRUCTIONS = `Sei il cervello di un personaggio "companion" dentro Factorio, guidato dai tool MCP "factorio".
Regole, in ordine di importanza:
1. Questo processo ti invoca UNA volta per ogni messaggio del giocatore: fai quello che chiede usando i tool factorio, poi TERMINA il turno. NON chiamare MAI wait_for_chat o read_chat — all'ascolto della chat pensa l'app che ti invoca.
2. Parli col giocatore SOLO tramite il tool say (1-2 frasi, in italiano, tono da compagno di squadra). Il testo fuori dai tool non viene visto da nessuno.
3. Conferma con say prima dei task lunghi, e riassumi con say quando hai finito o se qualcosa fallisce.
4. Usa solo i tool factorio: niente shell, niente file, niente altro.
5. Se la richiesta è ambigua, chiedi chiarimenti via say e termina il turno.

Messaggi dal gioco:`;

export interface CodexBrainOptions {
  cwd?: string;
  model?: string;
}

export class CodexBrain {
  private sessionId: string | null = null;
  private inbox: ChatMessage[] = [];
  private running = false;
  private proc: ChildProcess | null = null;
  private disposed = false;

  constructor(
    private readonly bridge: Bridge,
    private readonly opts: CodexBrainOptions = {},
  ) {}

  onChat(msg: ChatMessage): void {
    log.chat(msg.player, msg.text);
    if (msg.text.trim() === "!stop") {
      void this.emergencyStop();
      return;
    }
    this.inbox.push(msg);
    void this.drain();
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

  private async runTurn(batch: ChatMessage[]): Promise<void> {
    const chatLines = batch.map((m) => `<${m.player}> ${m.text}`).join("\n");
    const prompt = this.sessionId
      ? `Nuovi messaggi dal gioco:\n${chatLines}`
      : `${FIRST_TURN_INSTRUCTIONS}\n${chatLines}`;

    const args = this.sessionId
      ? ["exec", "resume", this.sessionId, "--json", prompt]
      : ["exec", "--json", prompt];
    if (this.opts.model) args.splice(1, 0, "-m", this.opts.model);

    log.info(`codex turn starting (${this.sessionId ? "resume" : "new session"})`);
    await new Promise<void>((resolve) => {
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
        if (code !== 0 && !this.disposed) {
          log.warn(`codex exited with code ${code}`);
          void this.bridge
            .call("say", { text: "Ho avuto un problema con il mio cervello (Codex) — riprova tra poco." })
            .catch(() => {});
        } else {
          log.info("codex turn finished");
        }
        resolve();
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        this.proc = null;
        log.error(`cannot launch codex: ${err.message} — is Codex CLI installed and signed in?`);
        resolve();
      });
    });
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
