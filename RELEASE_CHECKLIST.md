# Release checklist

- [ ] Test first-run setup and API-key diagnostics in a fresh Chrome profile.
- [ ] Test a two-person browser call and confirm that only translated speech reaches the participant.
- [ ] Confirm WebRTC microphone replacement in Meet, Zoom Web, and Yandex Telemost individually.
- [ ] Confirm that stopping, closing, and reloading restore the original microphone track.
- [ ] Verify API-key diagnostics for valid, revoked, and rate-limited keys.
- [ ] Verify session reconnect after a brief network interruption.
- [ ] Verify timer limit, individual/history deletion, search, copy, and Markdown export.
- [ ] Check the side panel at 300 px, 360 px, and 480 px widths and at a 620 px viewport height.
- [ ] Check keyboard navigation, visible focus, reduced motion, and all five interface languages.
- [ ] Review [PRIVACY.md](PRIVACY.md) and obtain required participant notice.
- [ ] Package the exact tested commit and publish release notes with known limitations.
