# Agentic-Factorio

An AI companion character inside your own Factorio world. You talk to it in game chat
("go mine 20 iron", "follow me", "what's wrong with my assembler?") and it walks, mines,
builds, crafts and operates machines alongside you — with human-ish constraints: a real
body, a real inventory, limited reach. No god mode — and it demolishes your structures
only when you explicitly ask it to (mining stays limited to resources, trees and rocks;
deconstruction is a separate, consent-gated action).

🇮🇹 **Guida completa in italiano: [GUIDA.md](GUIDA.md)**

## How it works

```
Factorio (mod "agentic-companion")  ⇄  RCON  ⇄  companion app (Node ≥ 22)  ⇄  LLM
```

Factorio mods can't access the network (by design), so a small companion process bridges
the game and the model. The mod does the in-game work (perception, multi-tick tasks); the
companion exposes tools to the LLM — either through its built-in agent loop or as an MCP
server for Claude Code / Codex.

## Quickstart

Requirements: Factorio 2.x, Node ≥ 22, and a dedicated save (script commands disable
achievements on any save the companion touches).

1. **Setup** (finds Factorio, configures RCON in `config.ini` with a backup, installs
   the mod, helps you pick a brain):

   ```sh
   node companion/dist/cli.js setup   # (npx agentic-factorio once published to npm)
   ```

   Then restart Factorio — `config.ini` is only read at startup.

2. **Host your save**: in Factorio, *Multiplayer → Host saved game*. RCON only works on
   hosted games; playing solo-hosted is fine.

3. **Play** — pick one of the three brain modes below.

Something off? `node companion/dist/cli.js doctor` checks config, protocol, mod,
connection and the selected brain. Add `--json` for a redacted machine-readable report.

Multi-agent gameplay (Codex/Claude native subagents, ready-made prompt):

```sh
npm run play:codex-agents
npm run play:claude-agents
```

See [docs/MULTI-AGENT.md](docs/MULTI-AGENT.md). These launchers deliberately use
the clients' unrestricted-permission modes; run them only in a trusted checkout.
Type `!stop` in game chat at any time to instantly cancel everything the companion is doing.

The physical walking multiplier can be changed while a save is running under
*Settings → Mod settings → Map → Companion movement speed* (1×–4×). It affects
companion bodies only, never human players or vehicles.

## The three brain modes

**1. Claude Code (Claude subscription)** — register the companion as an MCP server:

```sh
claude mcp add factorio -- node <repo>/companion/dist/cli.js mcp
```

Then in a Claude Code session: *"connect to my Factorio game and help me"*. Claude uses
`connect_status` / `wait_for_chat` / `say` / `mine` / `place_entity` / … and from there you
command it from game chat.

**2. Codex (ChatGPT subscription)** — log in once (`codex` → *Sign in with ChatGPT*), then:

```sh
codex mcp add factorio -- node <repo>/companion/dist/cli.js mcp
```

Same flow: tell the codex session to connect to your game, then talk in game chat.

(Both MCP modes need the repo built once: `npm install && npm run build`.)

**3. API key (built-in loop)**:

```sh
export OPENROUTER_API_KEY=...          # recommended: one key, 300+ models
export AGENTIC_RCON_PASSWORD=...       # must match local-rcon-password in config.ini
node companion/dist/cli.js play
```

Also supported: `ANTHROPIC_API_KEY`, OpenAI, or Ollama locally for free. Use
`--model` / `--provider` to pick, `--proactive N` for periodic factory reports.

## What it can do

Look around · inspect machines (status, recipe, contents) · walk anywhere (real
pathfinding, 1.6× companion-only speed by default) · follow you · mine ore / trees / rocks in bulk · place buildings ·
craft items · load & unload machines · change recipes · rotate entities · start
research · respawn after death · view a real rendered screenshot of the base when
spatial context matters. Every positional action auto-walks into reach first.

New in M7: one-call factory diagnosis (analyze_factory: stuck machines grouped
with missing ingredients + electric grid summary) · per-minute production rates
and power stats in its perception · item delivery to a (moving) player · car
driving with self-fueling and honest stuck handling · persistent duties:
keep_fueled (tops up burners in an area) and defend_area (fights intruders,
refills turrets, repairs structures) · train management (fleet overview,
schedules, dispatch).

New in M8: a crew — up to 4 named companions with per-companion task queues
working in parallel, all driven by ONE brain (tools take companion:"Name") ·
push events: the brain is woken when a companion is attacked or dies, research
completes, or a duty runs out of supplies — no polling, no asking.

It also builds free-form layouts from a plain description — spatial tools (ASCII
area scan, exact machine footprints, placement dry-runs, batched build plans) let
the model compute the coordinates itself · imports blueprint strings and builds
them · deconstructs your buildings, but only on your explicit request
(consent-gated) · fights: equips gun/ammo/armor, clears nearby nests, and retreats
on its own when badly hurt.

Screenshot vision requires a non-headless Factorio host on the same machine as the
companion app. `setup` remembers Factorio's user-data directory; custom/portable
installs can also set `AGENTIC_FACTORIO_USER_DIR` to the folder containing
`script-output`. A vision-capable model is required to interpret the returned image.

## Repo layout

- `mod/agentic-companion/` — the Factorio mod (Lua): perception, task queue, chat bridge.
- `companion/` — the companion app (TypeScript): RCON client, tool registry, agent loop, MCP server.
- `docs/PROTOCOL.md` — the JSON contract between the two. Source of truth.
- `docs/FACTORIO-NOTES.md` — empirically verified Factorio behavior.
- `scripts/` — `dev-link.sh` (symlink the mod for development), `package-mod.sh` (build the mod zip).

## Development

```sh
npm install
npm run build          # build the companion CLI
npm test               # unit tests
npm run typecheck
bash scripts/dev-link.sh    # symlink the mod into your local mods folder
npm run package:mod         # dist/agentic-companion_<version>.zip
```

Live integration test (needs a running headless server — see `docs/FACTORIO-NOTES.md`):

```sh
cd companion && npx tsx test/integration-live.ts   # defaults: 127.0.0.1:27099
```

## License

MIT
