# Live Voice Translator

Open-source, two-way live voice translation for browser conferences.

You speak Russian and the other participant hears English. They speak English
and you hear Russian. Translation runs through the user's own OpenAI API key.

The extension also supports meeting notes. Choose one of four modes before a
call: **Translation**, **Notes**, **Translation + Notes**, or **Transcript**.

Clicking the extension icon opens a persistent Chrome side panel. Translation
and note capture continue when the panel is closed or the user switches tabs.
The extension badge shows `ON` while a session is active and `!` after an error.

For voice modes choose an audio scenario:

- **Solo test** plays the outgoing translation through the normal speakers so
  the local user can verify it without another participant.
- **Conference** requires a virtual audio cable and sends the outgoing
  translation there. The local user can monitor it at zero, low, or full volume.

## Status

Version 0.5 is a release-candidate source build for macOS/Chrome. It captures the conference tab and microphone, creates two OpenAI Realtime sessions, routes translated audio to selected outputs, tracks session duration locally, retries a dropped Realtime connection, limits long-running sessions, and retains notes for a user-selected period.

## Requirements

- Chrome 116 or newer
- An OpenAI API account with Realtime API access
- Headphones
- A virtual audio device for translated microphone output
  - macOS: [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole)
  - Windows: VB-CABLE or an equivalent virtual cable

## Install from source

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository directory.
4. Open the extension settings and enter your own OpenAI API key.
5. Select the virtual cable as **Translation for the other participant**.
6. In Meet/Telemost/Zoom select that same virtual cable as the microphone.
7. Open the conference tab, click the extension, then **Start translation**.

When a notes mode is selected, stopping the session opens the meeting history.
The extension can create a Russian Markdown summary with decisions, tasks,
deadlines, and open questions. History is kept locally for the chosen retention period and can be copied, downloaded, or deleted.

Use headphones. Without them the conference audio can feed back into the
microphone and be translated repeatedly.

## Security

The key is stored in `chrome.storage.local`; it is not committed, synced, or
sent anywhere except directly to OpenAI. For a public extension, a local
companion or a small token-minting service is recommended so long-lived API
keys are never available to extension code. Create a dedicated key and set a
project spending limit.

## Known limitations

- Chrome extensions cannot expose a new microphone device. A virtual audio
  cable is required for outgoing translated speech.
- This build sends a user-provided long-lived API key directly to the Realtime endpoint. Do not use an unrestricted production key. See [SECURITY.md](SECURITY.md).
- Browser permission prompts and audio device labels vary by operating system.
- Meet is the first target. Telemost and browser Zoom need live compatibility
  verification.
- OpenAI API usage is billed to the key owner; the extension itself is free.
- Speaker labels currently distinguish the local microphone from the conference
  tab; identifying individual remote participants is not implemented yet.

Read [PRIVACY.md](PRIVACY.md) and complete [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) before publishing a packaged build.

## License

MIT
