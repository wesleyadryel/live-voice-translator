LIVE VOICE TRANSLATOR FOR MAC

1. Double-click “Live Voice Translator Installer.app”.
2. Chrome opens on chrome://extensions and Finder opens the extension folder.
3. In Chrome, enable Developer mode.
4. Click Load unpacked and select the opened “extension” folder.
5. Open the extension settings, add your own OpenAI API key, then choose audio outputs.

Why is one Chrome action required?
Chrome blocks local .dmg and .crx files from installing extensions silently on macOS.
The confirmation protects users from unwanted extensions. A future Chrome Web Store
release can install with Chrome’s normal “Add to Chrome” button instead.

The installer copies the extension to:
~/Library/Application Support/Live Voice Translator/extension

To remove it, remove the extension from chrome://extensions and delete that folder.
