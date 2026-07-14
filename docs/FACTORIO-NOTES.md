# Empirical Factorio findings (verified against 2.0.77, mac-arm64)

Hard-won facts from live integration testing. Trust these over intuition.

## RCON

- **Zero-length commands get NO response at all.** A single-space command (`" "`)
  gets an empty response. Our multi-packet sentinel therefore sends `" "`, never `""`
  (`companion/src/rcon.ts`).
- **The first Lua command of a session is swallowed** with a log warning:
  *"Using Lua console commands will disable achievements. Please repeat the command
  to proceed."* The RCON response is empty. `Bridge.unlock()` sends a harmless
  `ping` twice on connect to get past it. This also means achievements are
  disabled on any save the companion touches — disclosed in the README.
- Raw console commands (`/silent-command`) run in the **`__level__` Lua state**,
  not the mod's: the mod's `storage` is NOT visible there. All state access must
  go through `remote.call("agentic", ...)`.

## Headless server

- With no players connected the server **auto-pauses** (`game.tick` freezes), so
  on_tick tasks never progress. For CI/integration runs set `"auto_pause": false`
  in server-settings.json. Irrelevant in real use (a player is always connected).
- The retail macOS Steam binary works fine as a server:
  `factorio.app/Contents/MacOS/factorio --config <ini> --mod-directory <dir>
  --start-server <save.zip> --server-settings <json> --rcon-port N --rcon-password X`,
  with a custom `config.ini` (`[path] read-data / write-data`) for full isolation
  from the user's real config/saves/mods.
- `game.print` output does NOT appear in the headless server log; verify chat
  output in a real client.

## Player-less ("detached") characters — all verified working

- `surface.create_entity{name="character", force=...}` works; the entity walks
  (`walking_state` re-set every tick), mines, and crafts with no attached player.
- `begin_crafting{count, recipe}` **does progress** on a detached character
  (2 iron-gear-wheels crafted in ~1s game time). No simulation fallback needed.
- `LuaEntity.mine{inventory=...}` on a resource: extracts ONE unit per call into
  the inventory, decrements `entity.amount`, and returns **true only when the
  deposit is exhausted** (entity becomes invalid). Success must be measured by
  items gained, not the return value (`mod/.../actions/mine.lua`).

## Integration test recipe

```sh
# one-time: create the isolated env + save (see scripts in git history / plan)
# start server, then:
cd companion && npx tsx test/integration-live.ts   # defaults: 127.0.0.1:27099
```
