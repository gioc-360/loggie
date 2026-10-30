#!/usr/bin/env bash
# Builds build-cache/python: a relocatable CPython for Apple Silicon (python-build-standalone) with only what the
# transcriber imports installed (scripts/python-requirements.txt). The app ships it as Resources/python. Nothing here
# is committed: build-cache/ is gitignored, and the tarball is checked against the sha256 below before it is unpacked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CACHE="$ROOT_DIR/build-cache"
OUT="$CACHE/python"

# python-build-standalone release 20261003, CPython 3.12.15, arm64 macOS, "install_only" (a plain python/ tree)
RELEASE="20261003"
VERSION="3.12.15"
SHA256="316a463172740e71d8dca1f2730784e325f3f720941137b5d674d5801a632213"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/cpython-${VERSION}%2B${RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
TARBALL="$CACHE/downloads/cpython-${VERSION}-${RELEASE}.tar.gz"

mkdir -p "$CACHE/downloads"
if [ ! -f "$TARBALL" ]; then
  echo "==> Downloading Python $VERSION..."
  curl -fL --retry 3 -o "$TARBALL.part" "$URL"
  mv "$TARBALL.part" "$TARBALL"
fi
if [ "$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)" != "$SHA256" ]; then
  rm -f "$TARBALL"
  echo "The Python download did not match its sha256 and was deleted. Run this again." >&2
  exit 1
fi

echo "==> Unpacking into $OUT..."
rm -rf "$OUT" "$CACHE/python-unpack"
mkdir -p "$CACHE/python-unpack"
tar xzf "$TARBALL" -C "$CACHE/python-unpack"
mv "$CACHE/python-unpack/python" "$OUT"
rmdir "$CACHE/python-unpack"

echo "==> Installing the transcriber's packages (hash-pinned wheels only)..."
"$OUT/bin/python3" -m pip install --no-cache-dir --disable-pip-version-check --only-binary=:all: --require-hashes -r "$SCRIPT_DIR/python-requirements.txt"

# The app never installs anything and never runs a test suite, a GUI or an editor: drop them (and pip) to keep the
# bundle small and the signed app unchangeable. __pycache__ stays, so imports start fast without writing.
echo "==> Trimming..."
PYLIB="$OUT/lib/python3.12"
rm -rf "$PYLIB/test" "$PYLIB/idlelib" "$PYLIB/tkinter" "$PYLIB/turtledemo" "$PYLIB/turtle.py" "$PYLIB/ensurepip" "$OUT/share" "$OUT/bin/idle3"* "$OUT/bin/pip"* "$OUT/bin/2to3"* "$OUT/bin/pydoc3"*
rm -rf "$PYLIB/site-packages/pip" "$PYLIB/site-packages"/pip-*.dist-info "$PYLIB/site-packages/numpy/tests" "$PYLIB/site-packages/numpy/"*/tests
find "$OUT" -name 'test' -type d -path '*site-packages*' -prune -exec rm -rf {} +
find "$OUT" -name '*.a' -delete

"$OUT/bin/python3" -I -c "import numpy; print('numpy', numpy.__version__)"
echo "==> Python ready:"
du -sh "$OUT"
