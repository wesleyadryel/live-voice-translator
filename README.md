<p align="center">
  <img src="assets/icon-128.png" width="112" alt="Live Voice Translator icon">
</p>

<h1 align="center">Live Voice Translator</h1>

<p align="center">
  Open-source, two-way live voice translation for browser conferences.
</p>

<p align="center">
  <a href="https://github.com/mkdmit/live-voice-translator/stargazers"><img src="https://img.shields.io/github/stars/mkdmit/live-voice-translator?style=for-the-badge" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/mkdmit/live-voice-translator?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Chrome-116%2B-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome 116+">
  <img src="https://img.shields.io/badge/OpenAI-Realtime_API-000000?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI Realtime API">
</p>

> If live multilingual meetings should be easier, please consider starring the repository. It helps other people discover the project.

You speak Russian and the other participant hears English. They speak English
and you hear Russian. Translation runs through the user's own OpenAI API key.

The extension also supports meeting notes. Choose one of four modes before a
call: **Translation**, **Notes**, **Translation + Notes**, or **Transcript**.

## Highlights

- **Two-way voice translation** during live browser meetings
- **Translated outgoing microphone** for supported WebRTC conferences
- **Live speaker-labelled transcript** in a persistent Chrome side panel
- **Structured meeting notes** with decisions, tasks, deadlines, and open questions
- **Five interface languages**: English, Russian, Spanish, German, and French
- **Local-first history** with configurable retention and Markdown export
- **No project backend or analytics** — connect directly with your own OpenAI API key
- **Open source under MIT**

Clicking the extension icon opens a persistent Chrome side panel. Translation
and note capture continue when the panel is closed or the user switches tabs.
The extension badge shows `ON` while a session is active and `!` after an error.

In supported browser conferences, the extension replaces the outgoing WebRTC
microphone track with translated speech. The original microphone is restored
when the session stops. Google Meet, Zoom Web, and Yandex Telemost are the
current browser targets; native desktop conference applications are out of
scope.

## Status

Version 0.9.2 is a browser-only release candidate for Chrome. It captures the conference tab, replaces the meeting's outgoing WebRTC microphone track with translated speech, restores the original microphone on stop, tracks session duration locally, retries a dropped incoming Realtime connection, and limits long-running sessions. The side panel shows a live, speaker-labelled transcript while the meeting runs. Translation-only transcripts remain in memory and disappear when the next session starts; note, combined, and text modes save the transcript with the meeting. Meeting notes can be customized by section; final transcripts can identify remote speakers when the selected transcription model returns diarized segments.

## Requirements

- Chrome 116 or newer
- An OpenAI API account with Realtime API access
- Headphones

## macOS installer

Create a distributable DMG on a Mac:

```bash
bash scripts/build-macos-installer.sh
```

The result appears in `dist/macos/`. The installer copies a self-contained extension folder into `~/Library/Application Support/Live Voice Translator/extension`, opens Chrome and Finder, then explains the one required Chrome confirmation.

Chrome does not allow a local DMG or CRX to silently install an extension on macOS or Windows. For a one-click public installation and automatic updates, publish the extension in the Chrome Web Store; until then, use the installer below or the source steps.

## Install from source

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository directory.
4. Open the extension settings and enter your own OpenAI API key.
5. Open a supported browser conference, click the extension icon, then click
   **Start translation**.

When a notes mode is selected, stopping the session opens the meeting history.
The extension can create a Russian Markdown summary with decisions, tasks,
deadlines, and open questions. History is kept locally and can be searched,
copied, downloaded, or deleted.

Use headphones. Without them the conference audio can feed back into the
microphone and be translated repeatedly.

## Security

The key is stored in `chrome.storage.local`; it is not committed, synced, or
sent anywhere except directly to OpenAI. For a public extension, a local
companion or a small token-minting service is recommended so long-lived API
keys are never available to extension code. Create a dedicated key and set a
project spending limit.

## Known limitations

- Outgoing WebRTC microphone replacement works only in the supported browser
  versions of Meet, Zoom, and Telemost; it does not control native desktop apps.
- This build sends a user-provided long-lived API key directly to the Realtime endpoint. Do not use an unrestricted production key. See [SECURITY.md](SECURITY.md).
- Browser permission prompts and audio device labels vary by operating system.
- Meet is the first target. Telemost and browser Zoom need live compatibility
  verification.
- OpenAI API usage is billed to the key owner; the extension itself is free.
- Identifying individual remote participants depends on the transcription model
  returning diarized segments and is only performed after a notes session ends.

Read [PRIVACY.md](PRIVACY.md) and complete [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) before publishing a packaged build.

## License

MIT
