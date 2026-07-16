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

Segui il workflow play_multi_agent. Sei il coordinator e l'unico agente che legge la chat di gioco o usa say. Connettiti con connect_status, azzera lo stato con reset_coordination solo all'inizio, registrati come coordinator e salutami brevemente in italiano.

Resta poi sempre in ascolto con wait_for_agent_events. Per richieste semplici agisci direttamente. Quando una richiesta contiene almeno due lavori realmente indipendenti, crea un DAG con coordinate_submit_jobs e usa subagent NATIVI del client di tipo factorio-worker. Ogni worker deve registrarsi, claimare un solo job, prendere il lease esclusivo di un companion, riservare le zone di costruzione, passare agent_id e companion a ogni action tool, verificare il risultato, completare o fallire il job e rilasciare tutte le risorse.

Usa run_plan, build_plan, letture batch e blueprint per ridurre la latenza. Automatizza il lavoro ripetuto. Non usare shell o RCON diretto per giocare. Non duplicare job, non far controllare lo stesso companion a due worker e non terminare la sessione mentre il giocatore potrebbe scrivere in chat.`;

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
