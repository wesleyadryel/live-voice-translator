# Release checklist

- [ ] Test first-run setup and API-key diagnostics in a fresh Chrome profile.
- [ ] Test a two-person browser call and confirm that only translated speech reaches the participant.
- [ ] Confirm WebRTC microphone replacement in Meet, Zoom Web, Yandex Telemost, Telegram Web, and Discord Web individually.
- [ ] Confirm all six controls, before and during a call: muting a translation sends or plays the untranslated voice instead, muting a whole direction leaves it silent, and both recover without a reconnect while the transcript keeps filling.
- [ ] Stop a session and start it again from the panel — in a meeting tab and in a media tab, after a manual stop and after an error — without reopening the panel or reloading the page.
- [ ] Confirm expressive delivery: whisper, then speak loudly, then ask a question — the translated voice should follow the loudness, pace, and intonation instead of reading everything flat.
- [ ] Confirm the Monitor toggle: the return feed plays exactly what the participant receives, goes quiet when nothing translated is being sent, and — critically — does not reappear in the live transcript as incoming speech, which is what happens if the tab plays it and tabCapture picks it up.
- [ ] Confirm the Original toggle: both voices are audible together on the incoming side, and the participant hears the mixed original plus translation on the outgoing side.
- [ ] Confirm switching an interpreter off closes that direction's realtime session (no further API usage), plays or sends the untranslated voice, pauses only that side's transcript, and reconnects on demand.
- [ ] Confirm that stopping, closing, and reloading restore the original microphone track.
- [ ] Verify API-key diagnostics for valid, revoked, and rate-limited keys.
- [ ] Verify session reconnect after a brief network interruption.
- [ ] Verify timer limit, individual/history deletion, search, copy, and Markdown export.
- [ ] Check the side panel at 300 px, 360 px, and 480 px widths and at a 620 px viewport height.
- [ ] Check keyboard navigation, visible focus, reduced motion, and all six interface languages.
- [ ] Review [PRIVACY.md](PRIVACY.md) and obtain required participant notice.
- [ ] Package the exact tested commit and publish release notes with known limitations.
