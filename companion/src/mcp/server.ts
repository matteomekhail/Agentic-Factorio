// MCP server over stdio, exposing the shared tool registry plus a few
// MCP-only conveniences (connect_status, read_chat, wait_for_chat).
// CRITICAL: stdout carries the JSON-RPC stream — never write to it.
// All diagnostics go to stderr via console.error (do not import log.ts).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "../bridge.js";
import { RconClient } from "../rcon.js";
import { formatState, toolSpecs } from "../tools/definitions.js";
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

function toResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: text.startsWith("Error:"),
  };
}

function formatChatLines(messages: ChatMessage[]): string {
  return messages.map((m) => `[#${m.id}] <${m.player}> ${m.text}`).join("\n");
}

export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  const server = new McpServer(
    { name: "agentic-factorio", version: "0.1.0" },
    {
      instructions:
        "You drive a CREW of up to 4 AI companion characters inside the player's running " +
        "Factorio game. When asked to play (even just 'gioca a factorio'), do this:\n" +
        "1. connect_status first; greet the player in game chat with say (mirror their " +
        "language), then LISTEN: call wait_for_chat with timeout_s 600 in a loop, writing NO " +
        "text between empty waits — just call it again. React to chat and to [event] lines " +
        "(attacks, deaths, research done, background task outcomes, supply warnings).\n" +
        "2. CREW: the 'subagents' here are in-game companions, NOT client-native agents. " +
        'Create them with respawn {name:"Anna"} (max 4) and address each via the companion ' +
        'parameter every tool accepts. Parallelize by default: 2+ independent jobs → different ' +
        "companions, dispatched with background:true (returns instantly; the outcome arrives " +
        "as an [event]). Await a tool only when your next step depends on its result; keep " +
        "dependent steps on ONE companion so its queue runs them in order. An idle companion " +
        "is wasted hands — give it a duty (defend_area, keep_fueled, follow_player).\n" +
        "3. DISCIPLINE: use ONLY these factorio tools — never shell/exec/raw RCON (raw /c " +
        "commands spam every player's chat; inspect_entity reads belts and pipes, " +
        "analyze_factory diagnoses the whole factory in one call). Speak to the player ONLY " +
        "via say, 1-2 short sentences; announce long jobs before starting and summarize " +
        "outcomes. If a tool fails, say so honestly and try ONE alternative. '!stop' from the " +
        "player force-cancels everything.",
    },
  );

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
        return toResult(await spec.execute(bridge, (args ?? {}) as Record<string, unknown>));
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
        "something new happens, or reports silence once timeout_s elapses. To listen " +
        "continuously: call this in a loop with a LONG timeout (600) and do not write any text " +
        "between calls when nothing happened — just call it again. " +
        "NOTE: timeouts above ~55s require raising the MCP client's tool timeout (Codex: " +
        "tool_timeout_sec in [mcp_servers.factorio]; Claude Code: MCP_TOOL_TIMEOUT env, ms).",
      inputSchema: z.object({
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe("seconds to wait, default 30; use 600 for continuous listening (see tool description)"),
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
            "call wait_for_chat again RIGHT NOW (timeout_s 600) — do not end your turn and do " +
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
              "connect_status, saluto in chat via say (in italiano), poi loop di wait_for_chat " +
              "con timeout_s 600 senza scrivere nulla tra un'attesa vuota e l'altra. " +
              "I subagent sono i COMPANION nel gioco (respawn {name:...}, parametro companion, " +
              "max 4) — mai agent nativi del client, mai shell o RCON diretto. Parallelizza di " +
              "default con background:true e reagisci agli [event]. Passi dipendenti sullo " +
              "stesso companion. Parla col giocatore solo via say, 1-2 frasi.",
          },
        },
      ],
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
