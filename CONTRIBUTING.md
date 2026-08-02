# Contributing

Thanks for helping improve Live Voice Translator.

## Before opening a pull request

1. Create a focused branch from `main`.
2. Keep credentials and meeting data out of commits.
3. Run the regression tests:

```bash
node --test tests/*.test.mjs
```

4. Describe the browser, conference platform, operating system, and audio route used for testing.

## Good first contributions

- Verify compatibility with new versions of Google Meet, Zoom Web, Yandex Telemost, Telegram Web, or Discord Web.
- Improve translations and accessibility.
- Add regression tests for browser audio routing.
- Improve installation documentation for macOS, Windows, or Linux.

For suspected security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
