#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT_DIR/manifest.json').version")"
OUTPUT_DIR="$ROOT_DIR/dist/macos"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/live-voice-translator.XXXXXX")"
APP_NAME="Live Voice Translator Installer.app"
APP_DIR="$STAGE_DIR/$APP_NAME"
RESOURCES_DIR="$APP_DIR/Contents/Resources"
EXTENSION_DIR="$RESOURCES_DIR/extension"
DMG_PATH="$OUTPUT_DIR/Live-Voice-Translator-$VERSION-macOS.dmg"
CHECKSUM_PATH="$DMG_PATH.sha256"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

mkdir -p "$APP_DIR/Contents/MacOS" "$RESOURCES_DIR" "$EXTENSION_DIR" "$OUTPUT_DIR"

sed "s/@VERSION@/$VERSION/g" "$ROOT_DIR/installer/macos/Info.plist" > "$APP_DIR/Contents/Info.plist"
ditto "$ROOT_DIR/installer/macos/launcher.sh" "$APP_DIR/Contents/MacOS/Live Voice Translator Installer"
chmod 755 "$APP_DIR/Contents/MacOS/Live Voice Translator Installer"

rsync -a "$ROOT_DIR/src" "$EXTENSION_DIR/"
rsync -a "$ROOT_DIR/assets" "$EXTENSION_DIR/"
ditto "$ROOT_DIR/manifest.json" "$EXTENSION_DIR/manifest.json"
ditto "$ROOT_DIR/LICENSE" "$EXTENSION_DIR/LICENSE"
ditto "$ROOT_DIR/PRIVACY.md" "$EXTENSION_DIR/PRIVACY.md"
ditto "$ROOT_DIR/SECURITY.md" "$EXTENSION_DIR/SECURITY.md"

ditto "$ROOT_DIR/installer/macos/README.txt" "$STAGE_DIR/README.txt"
ln -s /Applications "$STAGE_DIR/Applications"

rm -f "$DMG_PATH"
hdiutil create -volname "Live Voice Translator" -srcfolder "$STAGE_DIR" -format UDZO -ov "$DMG_PATH" >/dev/null
shasum -a 256 "$DMG_PATH" > "$CHECKSUM_PATH"

echo "Created: $DMG_PATH"
echo "SHA-256: $CHECKSUM_PATH"
