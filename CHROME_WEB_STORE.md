# Chrome Web Store listing

## Name

Live Voice Translator

## Summary

Real-time, two-way AI voice translation for multilingual browser meetings.

## Category

Productivity

## Language

English

## Detailed description

Speak naturally with people who use another language during browser-based
meetings. Live Voice Translator translates both sides of the conversation in
real time: you speak in your language, the other participant hears a translated
voice, and their reply is translated back for you.

Designed for multilingual calls in Google Meet, Zoom Web, and Yandex Telemost.
Use it for international sales calls, customer interviews, remote-team
meetings, product demonstrations, support sessions, and everyday
cross-language communication.

Key features:

- Real-time, two-way speech translation
- Translated outgoing microphone in supported WebRTC meetings
- Live speaker-labelled transcript in a Chrome side panel
- Structured meeting notes with decisions, tasks, deadlines, and questions
- Translation, Notes, Translation + Notes, and Transcript modes
- English, Russian, Spanish, German, and French language choices
- Local meeting history with search, deletion, and Markdown export
- No developer-operated backend, analytics, or advertising

The extension connects directly to OpenAI using an API key supplied by the
user. OpenAI API usage is billed separately to the key owner. A dedicated API
key with a project spending limit is recommended.

Privacy: meeting audio is sent directly to OpenAI only during a session.
Settings and meeting history remain in local Chrome storage. The developer does
not receive meeting content or API keys.

Current release: 0.9.2. Chrome 116 or newer and headphones are recommended.

## URLs

- Homepage: https://github.com/mkdmit/live-voice-translator
- Support: https://github.com/mkdmit/live-voice-translator/issues
- Privacy policy: https://github.com/mkdmit/live-voice-translator/blob/main/PRIVACY.md

## Privacy practices draft

Single purpose: Translate and transcribe live browser meetings and optionally
create local meeting notes.

Data handled:

- Authentication information: user-provided OpenAI API key
- Personal communications: meeting audio and transcripts
- Website content: audio from the selected meeting tab
- Web browsing activity: active-tab URL, used only to recognize supported sites
- User activity: locally stored session duration and count

Data is not sold, used for advertising, or used for purposes unrelated to the
extension's single purpose. The developer does not operate a server that
receives this data. Audio and necessary text are transmitted directly to OpenAI
over HTTPS/WSS to provide the requested feature.

## Permission justifications

- `activeTab`: identify and start capture from the meeting tab selected by the user.
- `tabs`: find the active meeting tab, open settings/history, and restore routing.
- `storage`: save settings, the API key, counters, and meeting history locally.
- `tabCapture`: capture meeting audio after the user starts a session.
- `offscreen`: maintain real-time audio processing while the side panel changes state.
- `sidePanel`: display controls and the live transcript beside the meeting.
- Host permissions: connect to OpenAI and integrate only with supported meeting sites.

## Required graphics

- Icon: `assets/icon-128.png`
- Screenshots: `screenshots/live.png`, `screenshots/history.png`, `screenshots/settings.png`
