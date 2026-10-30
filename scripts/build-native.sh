#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT_DIR/dist-native/bin"

mkdir -p "$OUT_DIR"
echo "==> Building native Swift helpers into $OUT_DIR..."

swiftc -O "$ROOT_DIR/src/hikyaku/native/calendar.swift" -o "$OUT_DIR/hikyaku-calendar"
swiftc -O "$ROOT_DIR/src/hikyaku/native/extract.swift" -o "$OUT_DIR/hikyaku-extract"
swiftc -O "$ROOT_DIR/src/hikyaku/native/chats.swift" -o "$OUT_DIR/hikyaku-chats"
swiftc -O "$ROOT_DIR/src/hikyaku/native/outlook.swift" -o "$OUT_DIR/hikyaku-outlook"
swiftc -O "$ROOT_DIR/src/hikyaku/native/outlook-event.swift" -o "$OUT_DIR/hikyaku-outlook-event"
swiftc -O "$ROOT_DIR/src/hikyaku/native/mic.swift" -o "$OUT_DIR/hikyaku-mic"
swiftc -O "$ROOT_DIR/src/hikyaku/native/outlook-move.swift" -o "$OUT_DIR/hikyaku-outlook-move"

chmod +x "$OUT_DIR"/hikyaku-*
echo "==> Native helpers built successfully:"
ls -lh "$OUT_DIR"/hikyaku-*

bash "$ROOT_DIR/scripts/build-voice.sh"
