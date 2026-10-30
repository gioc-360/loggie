#!/usr/bin/env bash
# Puts a static arm64 ffmpeg at dist-native/bin/ffmpeg (the app ships dist-native/bin as Resources/bin). A normal Mac has
# no ffmpeg, and the transcriber needs it to turn the recording into 16 kHz wav files. call.py uses it when the app sets
# HIKYAKU_FFMPEG. The build is eugeneware/ffmpeg-static b6.1.1 (GPL-licensed ffmpeg 6.0 build, with its license text kept
# beside it). Both the download and the unpacked binary are checked against the sha256 values below.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CACHE="$ROOT_DIR/build-cache/downloads"
OUT_DIR="$ROOT_DIR/dist-native/bin"

BASE="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1"
GZ_SHA256="8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa"
BIN_SHA256="a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584"
LICENSE_SHA256="cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2"

sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
fetch() {   # fetch <asset> <sha256>
  local file="$CACHE/ffmpeg-b6.1.1-$1"
  if [ ! -f "$file" ]; then curl -fL --retry 3 -o "$file.part" "$BASE/$1" && mv "$file.part" "$file"; fi
  if [ "$(sum "$file")" != "$2" ]; then rm -f "$file"; echo "The download of $1 did not match its sha256 and was deleted. Run this again." >&2; exit 1; fi
}

mkdir -p "$CACHE" "$OUT_DIR"
echo "==> Fetching ffmpeg..."
fetch ffmpeg-darwin-arm64.gz "$GZ_SHA256"
fetch darwin-arm64.LICENSE "$LICENSE_SHA256"
gunzip -c "$CACHE/ffmpeg-b6.1.1-ffmpeg-darwin-arm64.gz" > "$OUT_DIR/ffmpeg"
if [ "$(sum "$OUT_DIR/ffmpeg")" != "$BIN_SHA256" ]; then rm -f "$OUT_DIR/ffmpeg"; echo "The unpacked ffmpeg did not match its sha256 and was deleted." >&2; exit 1; fi
chmod +x "$OUT_DIR/ffmpeg"
cp "$CACHE/ffmpeg-b6.1.1-darwin-arm64.LICENSE" "$OUT_DIR/ffmpeg.LICENSE"
"$OUT_DIR/ffmpeg" -version | head -1
ls -lh "$OUT_DIR/ffmpeg"
