# Live Voice Translator — Design System

## Product character

Native-feeling macOS utility: calm, precise, trustworthy and continuously observable. The UI should resemble a polished system control surface, not a marketing dashboard.

## Foundations

- Font: `-apple-system`, BlinkMacSystemFont, SF Pro fallbacks. No remote fonts.
- Grid: 4px base; primary spacing 8/12/16/24/32.
- Radius: 8px controls, 12px groups, 16px primary surfaces, 20px hero.
- One accent: macOS system blue. Green is reserved for live/success, amber for recovery, red for errors.
- Light and dark modes follow `prefers-color-scheme` with semantic tokens.
- Glass/blur is limited to navigation and top-level chrome; content surfaces remain opaque enough for WCAG AA contrast.

## Semantic colors

| Token | Light | Dark |
| --- | --- | --- |
| `--app-bg` | `#f5f5f7` | `#171719` |
| `--surface` | `rgba(255,255,255,.86)` | `rgba(45,45,48,.86)` |
| `--surface-solid` | `#ffffff` | `#252528` |
| `--text` | `#1d1d1f` | `#f5f5f7` |
| `--text-secondary` | `#626267` | `#a7a7ad` |
| `--separator` | `rgba(60,60,67,.18)` | `rgba(235,235,245,.14)` |
| `--accent` | `#007aff` | `#0a84ff` |
| `--success` | `#248a3d` | `#30d158` |
| `--warning` | `#b25000` | `#ff9f0a` |
| `--danger` | `#d70015` | `#ff453a` |

## Interaction

- Minimum interactive height: 40px desktop, 44px in touch-like/narrow layouts.
- Visible `:focus-visible` ring on every control.
- 160–240ms transitions using opacity/transform only.
- Live waveform is the only continuous animation and respects `prefers-reduced-motion`.
- Every network operation has connecting, success, recovery and failure copy.

## Layout

- Side panel: 320–520px, single primary column.
- Settings: adaptive two-column shell; sidebar collapses above content under 760px.
- History: master-detail at desktop, stacked list/detail at narrow widths.
- Avoid horizontal scrolling at 320px.

## Release UX requirements

- Preflight shows API, microphone, meeting tab and output routing before start.
- Starting is disabled only with a nearby explanation and recovery action.
- Session view shows timer, mode, connection phase and transcript count.
- API credentials are masked and never logged.
- Notes modes disclose that audio is sent to OpenAI and provide local retention controls.
- Destructive history removal requires confirmation.
