#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const client = process.argv[2];
if (client !== "codex" && client !== "claude") {
  console.error("usage: node scripts/launch-factorio-agents.mjs codex|claude");
  process.exit(2);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = client;
const mcp = spawnSync(executable, ["mcp", "get", "factorio"], {
  cwd: repo,
  encoding: "utf8",
});
if (mcp.status !== 0) {
  console.error(`The factorio MCP server is not registered in ${client}. Run:`);
  console.error(`  ${client} mcp add factorio -- node ${path.join(repo, "companion", "dist", "cli.js")} mcp`);
  process.exit(1);
}

const prompt = `Gioca a Factorio con me usando il server MCP factorio in modalità multi-agent.

Segui il workflow play_multi_agent. Sei il coordinator e l'unico agente che legge la chat di gioco o usa say. Connettiti con connect_status, azzera lo stato con reset_coordination solo all'inizio, registrati come coordinator e salutami brevemente in italiano. Agisci entro i primi due tool call utili: niente lunghi preamboli.

Per richieste grandi fai una sola ricognizione condivisa e lavora a ondate di massimo tre job. Ogni job deve durare circa 2-5 minuti e specificare coordinate/area, input, output e una definition of done osservabile. Usa subagent NATIVI del client di tipo factorio-worker. Assegna il companion più vicino; mai oltre 128 tile a piedi. Se un subagent non parte, riprova una volta, poi prendi il job con coordinate_takeover_job ed eseguilo direttamente.

Il primo impianto realmente automatico deve funzionare entro circa cinque minuti. Un job di costruzione è concluso solo quando una linea chiusa produce e accumula output: craftare una macchina o alimentarla a mano non basta. Dopo ogni evento job_done/job_failed controlla lo stato, correggi e lancia subito l'ondata successiva; usa wait_for_agent_events solo quando non c'è una decisione pronta.

Usa build_plan (auto-craft incluso), run_plan, letture batch e blueprint. Ferma prima eventuali duty persistenti sul companion assegnato. Non usare shell o RCON diretto per giocare. Non duplicare job, non far controllare lo stesso companion a due worker e non terminare la sessione mentre il giocatore potrebbe scrivere in chat.`;

const args = client === "codex"
  ? ["--yolo", "--cd", repo, prompt]
  : ["--dangerously-skip-permissions", "--name", "Factorio Multi-Agent", prompt];

if (process.env.LAUNCH_FACTORIO_DRY_RUN === "1") {
  console.log(JSON.stringify({ executable, args, cwd: repo }, null, 2));
  process.exit(0);
}

console.error(`Starting ${client} with unrestricted permissions in ${repo}.`);
console.error("Only use this command because you explicitly trust this repository and its MCP server.\n");
const child = spawn(executable, args, { cwd: repo, stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Could not launch ${client}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
