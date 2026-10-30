#!/usr/bin/env bash
# Stages the transcriber for the app at build-cache/transcriber (shipped as Resources/transcriber): its Python code and
# prompts, and the recorder compiled from recorder.swift. No audio, fixtures, tests, evals or caches go in.
# HIKYAKU_TRANSCRIBER picks the source folder (default: transcriber/spike in this repo), STAGE_DIR the output.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SRC="${HIKYAKU_TRANSCRIBER:-$ROOT_DIR/transcriber/spike}"
OUT="${STAGE_DIR:-$ROOT_DIR/build-cache/transcriber}"

[ -f "$SRC/call.py" ] || { echo "No transcriber at $SRC (set HIKYAKU_TRANSCRIBER)." >&2; exit 1; }
echo "==> Staging the transcriber from $SRC into $OUT..."
rm -rf "$OUT"
mkdir -p "$OUT"

for file in "$SRC"/*.py; do
  case "$(basename "$file")" in
    test_*.py|*_eval.py|fixtures.py) continue ;;
  esac
  cp "$file" "$OUT/"
done
[ -d "$SRC/prompts" ] && cp -R "$SRC/prompts" "$OUT/prompts"

swiftc -O -parse-as-library -target "$(uname -m)-apple-macosx15.0" -module-cache-path "$ROOT_DIR/build-cache/swift" "$SRC/recorder.swift" -o "$OUT/recorder"
chmod +x "$OUT/recorder"
echo "==> Transcriber staged:"
ls "$OUT"
