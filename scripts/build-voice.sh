#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT_DIR/dist-native/bin"
swiftc -O -target "$(uname -m)-apple-macosx13.0" -module-cache-path "$ROOT_DIR/build-cache/swift" "$ROOT_DIR/src/hikyaku/native/voice.swift" -o "$ROOT_DIR/dist-native/bin/loggie-voice" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$ROOT_DIR/desktop/voice-info.plist"
codesign --force --sign - "$ROOT_DIR/dist-native/bin/loggie-voice"
