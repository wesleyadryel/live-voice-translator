# Privacy Policy

Last updated: July 21, 2026

Live Voice Translator provides real-time voice translation, transcription, and
meeting notes. It does not operate its own backend, use analytics, sell data, or
serve advertising.

## Data the extension handles

- Microphone and selected meeting-tab audio while the user has an active session.
- Speech transcripts and generated meeting notes when the selected mode requires them.
- An OpenAI API key supplied by the user.
- Extension settings, local usage counters, and locally saved meeting history.
- The URL of the active tab only to determine whether it is a supported meeting site.

## How data is used and shared

Meeting audio, transcript content required for processing, and the user's API key
are sent directly to OpenAI over encrypted HTTPS or WSS connections solely to
provide translation, transcription, speaker identification, or meeting notes.
The developer does not receive or have access to this data. No data is sold,
used for advertising, or shared with any other party.

OpenAI processes data according to its own terms and privacy policies. Users
should create a dedicated OpenAI project key and configure a spending limit.

## Local storage and deletion

The API key, preferences, counters, meeting summaries, and saved transcripts are
stored in `chrome.storage.local` in the user's Chrome profile. Translation-only
transcripts are temporary. Saved history is retained according to the extension
settings and can be deleted from the History screen. Removing the extension also
removes its local Chrome storage.

## Permissions

The extension accesses the microphone and meeting-tab audio only after the user
starts a session. Access to supported meeting sites is used only to route the
translated outgoing audio. Storage is used for settings and local meeting
history. The extension does not collect general browsing history.

## Limited Use

The use of information received from Chrome APIs adheres to the Chrome Web Store
User Data Policy, including the Limited Use requirements. Data is used only to
provide or improve the extension's user-facing translation and meeting-note
features.

Before recording or transcribing other people, the user must obtain any notice
or consent required by the laws and policies that apply to the meeting.

Questions about this policy may be sent to
[dimitrii.maksimenko@gmail.com](mailto:dimitrii.maksimenko@gmail.com).
