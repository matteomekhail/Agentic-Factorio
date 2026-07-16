// MCP server over stdio, exposing the shared tool registry plus a few
// MCP-only conveniences (connect_status, read_chat, wait_for_chat).
// CRITICAL: stdout carries the JSON-RPC stream — never write to it.
// All diagnostics go to stderr via console.error (do not import log.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "../bridge.js";
import { MCP_GAMEPLAY_INSTRUCTIONS } from "../agent/policy.js";
import { RconClient } from "../rcon.js";
import { assertProtocolCompatibility } from "../protocol/contract.js";
import { CoordinationBroker } from "../coordination/broker.js";
import { registerCoordinationTools } from "../coordination/mcp.js";
import {
  formatState,
  toolSpecs,
} from "../tools/definitions.js";
import { isImageToolOutput, type ToolOutput } from "../tools/adapter.js";
import {
  asArray,
  type ChatMessage,
  type GetChatResult,
  type GetEventsResult,
  type GetStateResult,
  type PingResult,
  type SpawnResult,
} from "../types.js";

export interface McpServerOptions {
  host: string;
  port: number;
  password: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errText = (e: unknown): string =>
  `Error: ${e instanceof Error ? e.message : String(e)}`;

function toResult(output: ToolOutput) {
  if (isImageToolOutput(output)) {
    return {
      content: [
        { type: "text" as const, text: output.text },
        {
          type: "image" as const,
          data: output.image.data,
          mimeType: output.image.mimeType,
        },
      ],
      isError: false,
    };
  }
  return {
    content: [{ type: "text" as const, text: output }],
    isError: output.startsWith("Error:"),
  };
}

/** Clients that don't render MCP image content (Codex CLI) would keep half a
 *  megabyte of base64 as TEXT in their context — measured to blow a session
 *  up to compaction. For those clients, write the image to a temp file and
 *  hand back its path so the model opens it with its native image viewer.
 *  Override with AGENTIC_VIEW_IMAGE_MODE=inline|file. */
function externalizeImageIfNeeded(output: ToolOutput, clientName: string): ToolOutput {
  if (!isImageToolOutput(output)) return output;
  const mode = process.env.AGENTIC_VIEW_IMAGE_MODE ?? (/codex/i.test(clientName) ? "file" : "inline");
  if (mode !== "file") return output;
  try {
    const dir = path.join(os.tmpdir(), "agentic-factorio-views");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(output.image.filename));
    fs.writeFileSync(file, Buffer.from(output.image.data, "base64"));
    return (
      `${output.text}\nThe screenshot is saved at ${file} — VIEW IT NOW with your ` +
      "image viewer tool (view_image) to actually see the base; do not read it as text or base64."
    );
  } catch (e) {
    console.error(`[agentic-factorio] couldn't externalize screenshot: ${errText(e)}`);
    return output; // fall back to inline rather than losing the image
  }
}

function formatChatLines(messages: ChatMessage[]): string {
  return messages.map((m) => `[#${m.id}] <${m.player}> ${m.text}`).join("\n");
}

const READ_ONLY_GAME_TOOLS = new Set([
  "look_around", "view_area", "check_inventory", "inspect_entity", "scan_area",
  "describe_prototype", "analyze_factory", "can_place", "find_buildable_area",
  "list_blueprints", "read_blueprint", "list_trains",
]);

export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  const server = new McpServer(
    { name: "agentic-factorio", version: "0.5.0" },
    {
      instructions: MCP_GAMEPLAY_INSTRUCTIONS,
    },
  );
  const broker = new CoordinationBroker(`${opts.host}-${opts.port}`);

  // Lazy game connection: nothing is contacted until a tool actually needs it,
  // so the MCP server starts fine before Factorio does.
  let conn: { rcon: RconClient; bridge: Bridge } | null = null;
  let lastChatId = 0;
  let lastEventId = 0;

  // Listening watchdog: when the model isn't inside a wait_for_chat and the
  // player speaks anyway, tell them in game chat instead of leaving silence.
  let activeWaits = 0;
  let everListened = false;
  let lastListenEnd = 0;
  let watchdogChatId: number | null = null;
  let warnedIdle = false;

  function closeConn(): void {
    conn?.rcon.close();
    conn = null;
  }

  async function getBridge(): Promise<Bridge> {
    if (conn?.rcon.connected) return conn.bridge;
    conn = null;
    const rcon = new RconClient({ host: opts.host, port: opts.port, password: opts.password });
    try {
      await rcon.connect();
    } catch (e) {
      throw new Error(
        `cannot reach the game at ${opts.host}:${opts.port} — start Factorio, then Multiplayer → ` +
          `Host saved game (with the agentic-companion mod enabled and RCON on), and try again. ` +
          `(${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const bridge = new Bridge(rcon);
    try {
      await bridge.unlock();
      assertProtocolCompatibility(await bridge.call<PingResult>("ping"));
    } catch (e) {
      rcon.close();
      throw e instanceof Error ? e : new Error(String(e));
    }
    rcon.on("close", () => {
      if (conn?.rcon === rcon) conn = null;
      console.error("[agentic-factorio] game connection lost — will reconnect on the next tool call");
    });
    conn = { rcon, bridge };
    console.error(`[agentic-factorio] connected to Factorio RCON at ${opts.host}:${opts.port}`);
    return bridge;
  }

  registerCoordinationTools(server, broker, getBridge);

  // All shared agent tools. The SDK converts the zod schemas to JSON Schema
  // for tools/list and validates tools/call arguments against them; the spec
  // itself re-parses and returns "Error: ..." strings instead of throwing.
  for (const spec of toolSpecs()) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.schema },
      async (args) => {
        let bridge: Bridge;
        try {
          bridge = await getBridge();
        } catch (e) {
          return toResult(errText(e));
        }
        const record = (args ?? {}) as Record<string, unknown>;
        const agentId = typeof record.agent_id === "string" ? record.agent_id : undefined;
        const companion = typeof record.companion === "string" ? record.companion : "AI";
        if (agentId && !READ_ONLY_GAME_TOOLS.has(spec.name)) {
          try {
            await broker.assertMayAct(agentId, companion);
          } catch (e) {
            return toResult(errText(e));
          }
        }
        const output = await spec.execute(bridge, record);
        const clientName = server.server.getClientVersion()?.name ?? "";
        return toResult(externalizeImageIfNeeded(output, clientName));
      },
    );
  }

  server.registerTool(
    "connect_status",
    {
      description:
        "Connect to the running Factorio game (if not already connected) and report status: " +
        "Factorio and mod versions, current tick, and a summary of the companion character's " +
        "surroundings. Spawns the companion if it does not exist yet. Call this first.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const bridge = await getBridge();
        const ping = await bridge.call<PingResult>("ping");
        let spawnNote = "";
        if (!ping.companion_exists) {
          const spawned = await bridge.call<SpawnResult>("spawn_companion", {});
          spawnNote = ` The companion was missing — spawned it at (${spawned.position.x}, ${spawned.position.y}).`;
        }
        const state = await bridge.call<GetStateResult>("get_state", {});
        return toResult(
          `Connected. Factorio ${ping.factorio_version}, mod ${ping.mod_version}, tick ${ping.tick}.` +
            `${spawnNote}\n${formatState(state)}`,
        );
      } catch (e) {
        return toResult(errText(e));
      }
    },
  );

  server.registerTool(
    "read_chat",
    {
      description:
        "Read recent player chat messages. Without since_id it continues from where the last " +
        "read/wait left off (the first call returns the recent backlog). The companion's own " +
        "[AI] lines are never included. Each line is prefixed with its message id.",
      inputSchema: z.object({
        since_id: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("only return messages with an id greater than this"),
      }),
    },
    async ({ since_id }) => {
      try {
        const bridge = await getBridge();
        const res = await bridge.call<GetChatResult>("get_chat", {
          since_id: since_id ?? lastChatId,
        });
        lastChatId = Math.max(lastChatId, res.last_id);
        const messages = asArray(res.messages);
        if (messages.length === 0) {
          return toResult(`No new chat messages (last id ${res.last_id}).`);
        }
        const shown = messages.slice(-30);
        const omitted = messages.length - shown.length;
        return toResult(
          (omitted > 0 ? `(${omitted} older message(s) omitted)\n` : "") + formatChatLines(shown),
        );
      } catch (e) {
        return toResult(errText(e));
      }
    },
  );

  server.registerTool(
    "wait_for_chat",
    {
      description:
        "Wait for the next player chat message OR game event (companion attacked/died, research " +
        "finished, duty supply warnings), polling about once per second. Returns as soon as " +
        "something new happens, or reports silence once timeout_s elapses. To be ALWAYS reachable, " +
        "park yourself here with timeout_s 21600 (6 hours): waiting costs nothing while idle and " +
        "you wake instantly when the player speaks. On return, act, then park again — write no " +
        "text between empty waits. NOTE: long timeouts require the MCP client's tool timeout to " +
        "be raised (Codex: tool_timeout_sec in [mcp_servers.factorio]; Claude Code: " +
        "MCP_TOOL_TIMEOUT env, ms).",
      inputSchema: z.object({
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(21600)
          .optional()
          .describe("seconds to wait, default 30; use 21600 (6h) to stay parked and always reachable"),
      }),
    },
    async ({ timeout_s }) => {
      const timeout = timeout_s ?? 30;
      activeWaits++;
      everListened = true;
      warnedIdle = false;
      watchdogChatId = null; // re-sync the watchdog cursor after this wait
      try {
        const bridge = await getBridge();
        if (lastChatId === 0) {
          // Never read before: skip the backlogs so we only wake on genuinely new activity.
          const cur = await bridge.call<GetChatResult>("get_chat", { since_id: 0 });
          lastChatId = cur.last_id;
          const ev = await bridge.call<GetEventsResult>("get_events", { since_id: 0 });
          lastEventId = ev.last_id;
        }
        const deadline = Date.now() + timeout * 1000;
        while (Date.now() < deadline) {
          const lines: string[] = [];
          const res = await bridge.call<GetChatResult>("get_chat", { since_id: lastChatId });
          const messages = asArray(res.messages);
          if (messages.length > 0) {
            lastChatId = Math.max(lastChatId, res.last_id);
            lines.push(formatChatLines(messages));
          }
          const ev = await bridge.call<GetEventsResult>("get_events", { since_id: lastEventId });
          const events = asArray(ev.events);
          if (events.length > 0) {
            lastEventId = Math.max(lastEventId, ev.last_id);
            lines.push(events.map((e) => `[event] ${e.text}`).join("\n"));
          }
          if (lines.length > 0) return toResult(lines.join("\n"));
          await sleep(500);
        }
        return toResult(
          `Nothing happened in the last ${timeout}s. The player expects you to stay online: ` +
            "call wait_for_chat again RIGHT NOW (timeout_s 21600) — do not end your turn and do " +
            "not write any text first.",
        );
      } catch (e) {
        return toResult(errText(e));
      } finally {
        activeWaits--;
        lastListenEnd = Date.now();
      }
    },
  );

  // Invocable kickoff prompt (Claude Code: /mcp__factorio__play; Codex: /prompts):
  // the full onboarding, so the user never has to paste a wall of text.
  server.registerPrompt(
    "play",
    {
      title: "Gioca a Factorio",
      description:
        "Kickoff completo: connettiti alla partita, gestisci la squadra di companion e resta in ascolto della chat di gioco",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Gioca a Factorio con me. Segui le instructions del server MCP factorio: " +
              "connect_status, saluto in chat via say (in italiano), poi parcheggiati in wait_for_chat " +
              "con timeout_s 21600 (6 ore: non costa nulla da fermo e ti sveglia all'istante) senza scrivere nulla tra un'attesa vuota e l'altra. " +
              "Per questa sessione usa un solo agent client: parallelizza con i COMPANION nel " +
              "gioco (respawn {name:...}, parametro companion, max 4), background:true e reagisci agli [event]. Passi dipendenti sullo " +
              "stesso companion. Parla col giocatore solo via say, 1-2 frasi.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "play_multi_agent",
    {
      title: "Gioca a Factorio con subagent",
      description: "Avvia un coordinator e worker nativi Codex/Claude che condividono job, companion ed eventi tramite MCP",
    },
    () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "Gioca a Factorio in modalità multi-agent. Tu sei il coordinator: chiama connect_status, " +
            "reset_coordination {confirm:true}, register_factorio_agent con role=coordinator, poi saluta via say. " +
            "Quando il giocatore chiede 2+ lavori indipendenti, fai una sola ricognizione condivisa e crea ondate di " +
            "massimo tre job da 2-5 minuti, ognuno con area/input/output e definition of done verificabile. Spawna " +
            "subagent NATIVI del client di tipo factorio-worker. Assegna il companion più vicino e non mandarlo oltre " +
            "128 tile a piedi. Ogni worker ferma duty persistenti, riserva l'area, usa soprattutto build_plan/run_plan " +
            "senza micro-azioni background, verifica una linea realmente automatica, completa/fallisce e rilascia tutto. " +
            "Solo tu leggi la chat e usi say. wait_for_agent_events restituisce anche job_done/job_failed: reagisci e " +
            "lancia l'ondata successiva prima di aspettare ancora. Se un worker non parte, riprova una volta, poi usa " +
            "coordinate_takeover_job. Il primo risultato automatico visibile deve arrivare entro circa cinque minuti.",
        },
      }],
    }),
  );

  // The TUI model can't be woken from outside (MCP is pull-only): when the
  // player speaks while nobody is listening, at least tell them in game chat.
  const watchdog = setInterval(() => {
    void (async () => {
      if (!everListened || activeWaits > 0) return;
      if (Date.now() - lastListenEnd < 15_000) return; // grace between waits
      if (!conn?.rcon.connected) return; // never dial the game just to check
      try {
        const bridge = conn.bridge;
        if (watchdogChatId === null) watchdogChatId = lastChatId;
        const res = await bridge.call<GetChatResult>("get_chat", { since_id: watchdogChatId });
        watchdogChatId = Math.max(watchdogChatId, res.last_id);
        const messages = asArray(res.messages).filter((m) => !m.text.startsWith("!"));
        if (messages.length > 0 && !warnedIdle) {
          warnedIdle = true;
          await bridge.call("say", {
            text:
              "Il mio cervello non sta ascoltando in questo momento — leggerò i tuoi messaggi appena riprende. " +
              "(Per la modalità sempre-sveglia: play --brain codex)",
          });
          console.error(
            "[agentic-factorio] player spoke while the model wasn't listening — warned them in game chat",
          );
        }
      } catch {
        // game unreachable or mid-reconnect: stay quiet
      }
    })();
  }, 10_000);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[agentic-factorio] MCP server ready on stdio (game expected at ${opts.host}:${opts.port})`,
  );

  // Stay alive until the client disconnects (stdin closes).
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  clearInterval(watchdog);
  closeConn();
  console.error("[agentic-factorio] MCP client disconnected, shutting down");
}
