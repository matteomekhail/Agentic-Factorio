# Starter blueprint books

Every `.txt` file in this folder is one Factorio **export string** (the `0eNr…`
text from the in-game Export button) — a whole blueprint book or a single
blueprint. These are the books the default companion ("AI") carries from the
moment it spawns.

## Workflow

1. In Factorio: right-click the book → **Export to string** → copy.
2. Save it here as `<order>-<name>.txt` (one string per file, nothing else).
   Files are issued in lexical order, so the number prefix controls the order
   the books appear in the companion's inventory.
3. Regenerate the mod data:

   ```sh
   npm run blueprints:build
   ```

   This validates every string, extracts the in-game labels, and rewrites
   `mod/agentic-companion/scripts/starter_blueprints.lua` (+ the
   `starter_blueprints/book_*.lua` data files) with a content-hash version.
4. Reload the save. The mod notices the version change within a couple of
   seconds and swaps the companion's old starter books for the new set —
   no respawn needed.

Deleting a file here and rebuilding removes that book from the set the same
way. The generated Lua files are committed so the mod works from a clean
checkout without running the generator.
