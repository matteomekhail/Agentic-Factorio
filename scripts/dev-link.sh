#!/usr/bin/env bash
# Symlinks the mod into the local Factorio mods directory for development.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOD_SRC="$REPO_DIR/mod/agentic-companion"

case "$(uname -s)" in
  Darwin) MODS_DIR="$HOME/Library/Application Support/factorio/mods" ;;
  Linux)  MODS_DIR="$HOME/.factorio/mods" ;;
  *)      MODS_DIR="$APPDATA/Factorio/mods" ;;
esac

if [ ! -d "$MODS_DIR" ]; then
  echo "Factorio mods directory not found at: $MODS_DIR" >&2
  exit 1
fi

TARGET="$MODS_DIR/agentic-companion"
if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  echo "Refusing to overwrite existing non-symlink: $TARGET" >&2
  exit 1
fi

ln -sfn "$MOD_SRC" "$TARGET"
echo "Linked $MOD_SRC -> $TARGET"
echo "Remember to enable 'agentic-companion' in Factorio's Mods menu (or mod-list.json)."
