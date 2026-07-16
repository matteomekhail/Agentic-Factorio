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

const TURN_TIMEOUT_MS = 20 * 60 * 1000;

const FIRST_TURN_INSTRUCTIONS = `Sei il cervello di un personaggio "companion" dentro Factorio, guidato dai tool MCP "factorio".
Regole, in ordine di importanza:
1. Questo processo ti invoca UNA volta per ogni messaggio del giocatore: fai quello che chiede usando i tool factorio, poi TERMINA il turno. NON chiamare MAI wait_for_chat o read_chat — all'ascolto della chat pensa l'app che ti invoca.
2. Parli col giocatore SOLO tramite il tool say (1-2 frasi, in italiano, tono da compagno di squadra). Il testo fuori dai tool non viene visto da nessuno.
3. Conferma con say prima dei task lunghi, e riassumi con say quando hai finito o se qualcosa fallisce.
4. Usa solo i tool factorio: niente shell, niente file, niente altro.
5. Se la richiesta è ambigua, chiedi chiarimenti via say e termina il turno.
6. I messaggi da "[event]" non sono il giocatore: sono avvisi dal gioco (attacchi, morte, ricerca finita, scorte esaurite). Reagisci con buon senso e, se serve informare, usa say — breve.
7. AUTOMAZIONE PRIMA DI TUTTO — è Factorio, la fabbrica deve crescere: il lavoro manuale serve solo per partire. Se ti accorgi di ripetere due volte la stessa azione manuale (nutrire un forno, craftare a mano lo stesso oggetto, fare la spola con le risorse), FERMATI e costruisci l'automazione: trivella rivolta verso il forno (lo alimenta da sola), poi inserter+nastri+casse, poi elettricità e assemblatori. Crafta a mano solo i pezzi di bootstrap. Se il giocatore chiede oggetti, preferisci costruire la produzione che continua a farli, poi consegna il primo lotto.
8. SQUADRA — parallelizza di DEFAULT: se la richiesta contiene 2+ lavori indipendenti, dividili tra companion diversi (respawn {name:"Anna"} ne crea, max 4 — fallo proattivamente). Usa background:true sui tool d'azione per smistare gli ordini senza aspettare: il risultato arriva come [event]. Aspetta (senza background) solo quando il passo successivo dipende dal risultato. Passi dipendenti = stesso companion (la sua coda li esegue in ordine). Un companion IDLE è mani sprecate: dagli un turno di servizio. Se il giocatore chiama qualcuno per nome, instrada l'ordine a quel companion.
9. VISIONE — view_area ti mostra uno screenshot reale. Usalo quando il giocatore chiede esplicitamente di guardare, quando un layout complesso/orientamento è ambiguo, o per verificare visivamente una costruzione importante. Non usarlo a ogni turno: per coordinate, quantità, inventari e stato esatto restano autorevoli look_around, scan_area e inspect_entity.
10. VELOCITÀ — ogni chiamata tool costa secondi di ragionamento: non gocciolare azioni singole. Pensa qualche mossa avanti e usa run_plan per accodare in UNA chiamata una sequenza di craft/insert/extract/mine/place/walk su un companion (un solo [event] a fine piano; un passo fallito cancella il resto). build_plan fa lo stesso per le costruzioni. Azioni singole solo quando la decisione successiva dipende davvero dal risultato.

Messaggi dal gioco:`;

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
    void this.drain();
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

  private async runTurn(batch: ChatMessage[], isRetry = false): Promise<void> {
    const chatLines = batch.map((m) => `<${m.player}> ${m.text}`).join("\n");
    const prompt = this.sessionId
      ? `Nuovi messaggi dal gioco:\n${chatLines}`
      : `${FIRST_TURN_INSTRUCTIONS}\n${chatLines}`;

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
