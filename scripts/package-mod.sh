#!/usr/bin/env bash
# Packages the mod as dist/agentic-companion_<version>.zip.
# Factorio requires the zip's top-level folder to be named <name>_<version>.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOD_SRC="$REPO_DIR/mod/agentic-companion"
INFO_JSON="$MOD_SRC/info.json"

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INFO_JSON")"
if [ -z "$VERSION" ]; then
  echo "Could not read \"version\" from $INFO_JSON" >&2
  exit 1
fi

NAME="agentic-companion_$VERSION"
DIST_DIR="$REPO_DIR/dist"
ZIP_PATH="$DIST_DIR/$NAME.zip"

# The generated starter blueprint data must match BlueprintBooks/*.txt —
# regenerate before packaging so the zip can never ship stale books.
node "$REPO_DIR/scripts/build-starter-blueprints.mjs"

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

cp -R "$MOD_SRC" "$STAGE_DIR/$NAME"
find "$STAGE_DIR" -name '.DS_Store' -delete

mkdir -p "$DIST_DIR"
rm -f "$ZIP_PATH"
(cd "$STAGE_DIR" && zip -qr "$ZIP_PATH" "$NAME")

echo "Packaged $ZIP_PATH"
