#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT_DIR/manifest.json")
OUTPUT_DIR="$ROOT_DIR/dist/chrome-web-store"
STAGING_DIR=$(mktemp -d)
trap 'rm -rf "$STAGING_DIR"' EXIT

mkdir -p "$OUTPUT_DIR" "$STAGING_DIR/assets/backgrounds" "$STAGING_DIR/src"
cp "$ROOT_DIR/manifest.json" "$STAGING_DIR/"
cp "$ROOT_DIR/assets/icon-16.png" "$STAGING_DIR/assets/"
cp "$ROOT_DIR/assets/icon-32.png" "$STAGING_DIR/assets/"
cp "$ROOT_DIR/assets/icon-48.png" "$STAGING_DIR/assets/"
cp "$ROOT_DIR/assets/icon-128.png" "$STAGING_DIR/assets/"
cp "$ROOT_DIR/assets/backgrounds/voice-waves-light.png" "$STAGING_DIR/assets/backgrounds/"
cp "$ROOT_DIR"/src/* "$STAGING_DIR/src/"

ARCHIVE="$OUTPUT_DIR/live-voice-translator-$VERSION.zip"
rm -f "$ARCHIVE"
(cd "$STAGING_DIR" && zip -qr "$ARCHIVE" manifest.json assets src)
printf '%s\n' "$ARCHIVE"
