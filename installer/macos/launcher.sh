#!/bin/zsh
set -euo pipefail

APP_RESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"
INSTALL_ROOT="$HOME/Library/Application Support/Live Voice Translator"
EXTENSION_DIR="$INSTALL_ROOT/extension"
SOURCE_DIR="$APP_RESOURCES/extension"

mkdir -p "$INSTALL_ROOT"
ditto "$SOURCE_DIR" "$EXTENSION_DIR"

MESSAGE="Live Voice Translator is ready to add to Chrome.\n\n1. Chrome will open at chrome://extensions.\n2. Turn on Developer mode.\n3. Click Load unpacked.\n4. Select the folder that will open in Finder.\n\nChrome requires this confirmation for extensions not yet published in the Chrome Web Store."

if [[ -d "/Applications/Google Chrome.app" ]] || [[ -d "$HOME/Applications/Google Chrome.app" ]]; then
  open -a "Google Chrome" "chrome://extensions"
else
  open "https://www.google.com/chrome/"
fi

open "$EXTENSION_DIR"
osascript -e "display dialog \"$MESSAGE\" with title \"Live Voice Translator\" buttons {\"OK\"} default button \"OK\""
