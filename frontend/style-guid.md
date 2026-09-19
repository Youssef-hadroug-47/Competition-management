# Tournly — Style Guide

Extracted from `public/css/styles.css`. This describes the visual system in
use, not the markup/JS behind it — hand this file alone to another tool/model
to match the look without needing the rest of the codebase.

## Concept

A light, editorial-sports look: a pitch-green primary color, a single
scoreboard-amber accent used sparingly, warm off-white background instead of
pure white. Headlines use a condensed sans (scoreboard-lettering feel without
going full all-caps); body copy uses a separate, plain grotesque. Components
are flat — thin 1px borders and soft shadows, no gradients, no heavy drop
shadows except on floating elements (menus, modals).

## Color palette

| Token | Hex / value | Use |
|---|---|---|
| `--bg` | `#f6f7f3` | Page background, and the fill for subdued/inset surfaces (favorite cards, bracket match cards, the segmented-control track) |
| `--surface` | `#ffffff` | Cards, panels, inputs, the topbar, the "active" pill in a segmented control |
| `--border` | `#dce3da` | All hairline borders/dividers |
| `--text` | `#17241c` | Primary text, headings |
| `--text-muted` | `#5c6b60` | Secondary text, meta labels, placeholders, inactive tab/pill labels |
| `--accent` | `#1f7a52` | Primary action color (buttons, active tab underline, focus ring source, links on hover) |
| `--accent-dark` | `#14523a` | Hover state for primary actions; link color; "active" text color on light accent backgrounds |
| `--accent-contrast` | `#f6f7f3` | Text-on-accent where needed (rarely used directly — most accent fills use white text) |
| `--highlight` | `#e8a33d` | The one deliberate accent-of-the-accent: logo mark, the "create" panel's left border stripe |
| `--highlight-dark` | `#b97a1f` | Text color for "live" status pills |
| `--danger` | `#b3261e` | Errors, destructive actions, "private" badge text |
| `--danger-bg` | `#fbeceb` | Error banner / destructive-badge background |

Derived/translucent fills used inline (not tokenized, but consistent):
- `rgba(31, 122, 82, 0.1)` — default badge background (green-tinted neutral)
- `rgba(179, 38, 30, 0.08)` — "private" badge background
- `rgba(92, 107, 96, 0.12)` — "scheduled" status pill background
- `rgba(232, 163, 61, 0.16)` — "live" status pill background
- `rgba(31, 122, 82, 0.12)` — "finished" status pill background
- `rgba(31, 122, 82, 0.35)` — focus ring (3px solid-color box-shadow ring)
- `rgba(23, 36, 28, 0.06)` — default panel/card shadow (`--shadow`)
- `rgba(23, 36, 28, 0.12)` — dropdown menu shadow
- `rgba(23, 36, 28, 0.22)` — modal shadow
- `rgba(23, 36, 28, 0.35)` — modal backdrop scrim
- `rgba(23, 36, 28, 0.14)` — active segmented-control pill shadow

**Color scheme**: light only (`color-scheme: light` on `<html>`); no dark-mode
variant currently defined.

## Typography

Two families, loaded from Google Fonts, one job each:

- **Headings** — `'Barlow Condensed', 'Work Sans', sans-serif`. Weight 600
  normally, 700 for the logo and a few emphasis spots (profile initials,
  leaderboard rank numbers, bracket-round titles). Slight positive letter
  spacing (`0.01–0.02em`) at the display sizes.
- **Body** — `'Work Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`.
  Weights used: 400 (body), 500, 600 (labels, buttons, table headers,
  emphasis).

Google Fonts URL in use:
```
https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Work+Sans:wght@400;500;600&display=swap
```

Base sizing: `16px` root, `1.5` line-height, antialiased.

| Element | Font | Size | Weight | Notes |
|---|---|---|---|---|
| `h1` | Barlow Condensed | `2.1rem` | 600 | |
| `h2` | Barlow Condensed | `1.5rem` | 600 | |
| `h3` | Barlow Condensed | `1.2rem` | 600 | |
| Body / `p` | Work Sans | `1rem` (16px) | 400 | `max-width: 62ch`, muted color |
| Logo | Barlow Condensed | `1.4rem` | 700 | letter-spacing `0.02em` |
| Buttons | Work Sans | `0.95rem` | 600 | |
| Table headers (standings) | Barlow Condensed | `0.78rem` | 600 | uppercase, letter-spacing `0.04em` |
| Badges / status pills | Work Sans | `0.72rem` | 600 | |
| Small meta text | Work Sans | `0.78–0.88rem` | 400–600 | rows' secondary lines, timestamps |
| Segmented-control label | Work Sans | `0.76rem` | 700 | uppercase, letter-spacing `0.05em` |
| Tab labels (primary) | Work Sans | `0.9rem` | 600 | |
| Pill-tab / segmented button labels | Work Sans | `0.82rem` | 600 | |

Numeric columns (scores, standings stats) use `font-variant-numeric:
tabular-nums` so digits align in a column.

## Spacing, radius, shadow

| Token | Value |
|---|---|
| `--radius` | `10px` — panels, cards, modals |
| Small radius | `8px` — buttons, inputs, list rows, badges' inner corners |
| Pill radius | `999px` — badges, status pills, tab pills, segmented control/track |
| `--shadow` | `0 1px 2px rgba(23,36,28,0.06)` — resting card/panel elevation |
| `--focus-ring` | `0 0 0 3px rgba(31,122,82,0.35)` — universal `:focus-visible` treatment, replaces the native outline |
| `--max-width` | `960px` — main content column, centered |

Typical internal padding: panels/cards `24px`; buttons `10px 18px`; list rows
`10–14px 12–14px`; badges `3px 9px`; status pills `2px 8px`.

## Layout

- Single centered column, `max-width: 960px`, `24px` horizontal padding
  (`16px` under `640px`).
- Sticky-feeling but static topbar: flex row, logo left, actions right,
  `1px` bottom border, white surface.
- Page sections are stacked `.panel` blocks (`24px` gap between them via the
  `main` flex container), each a white card with a border and the resting
  shadow. One variant, `.panel--accent`, adds a `4px` amber left border for
  a single "this is the one energetic panel" moment (the create-tournament
  card on the home page).
- Two responsive breakpoints in use: `640px` (stack padding down, single
  leaderboard column) and `480px` (segmented control goes full-width).

## Components

**Buttons** (`.btn`) — pill-adjacent (8px radius, not fully round), three
variants:
- `--primary`: solid `--accent` fill, white text, darkens on hover.
- `--ghost`: transparent fill, border in `--border`, text in `--text`;
  on hover the border/text shift to accent colors.
- `--danger`: transparent fill, `--danger` border and text, tinted-red
  background on hover.
- Disabled state: `opacity: 0.55`, `cursor: not-allowed` (no color change).

**Badges** (`.badge`) — small pill, translucent-green fill by default,
translucent-red (`--badge--private`) variant for private content.

**Status pills** (`.status-pill`) — same pill shape as badges, one modifier
per match status (`scheduled` muted-gray, `live` amber, `finished` green,
`postponed`/`cancelled` red).

**Tabs — two distinct levels, deliberately different shapes:**
1. `.tab` (primary navigation, e.g. the tournament page's Matches /
   Standings & bracket / Top scorers) — underline style: transparent
   background, `2px` bottom border that turns `--accent` when active, text
   turns `--accent-dark` when active. Sits against a shared `1px` bottom
   rule (`.tabs`).
2. `.pill-tab` (secondary, e.g. which stage within "Standings & bracket") —
   discrete pill: white surface + border when inactive, solid `--accent`
   fill + white text when active (`aria-selected="true"` or
   `aria-pressed="true"`).

**Segmented control** (`.segmented`) — used specifically for the "group
matches by" filter, to read as one contained control rather than
independent buttons: a `--bg`-colored track with `3px` padding, each
`.segmented__btn` transparent until active, at which point it gets a white
pill background and a small shadow (`rgba(23,36,28,0.14)`) — a sliding
"selected" look. Paired with a small uppercase `.segmented-row__label`.

**Cards / rows** — list rows (`.tournament-row`, `.match-row`) are flat
white/bordered rectangles, `8px` radius, content split flex-start/flex-end.
`.favorite-card` and `.bracket-match` use the muted `--bg` fill instead of
white, to read as "nested inside" the panel rather than another top-level
card.

**Tables** (`.standings-table`) — no vertical rules, thin horizontal row
dividers only, header row in the condensed uppercase treatment, first
column left-aligned and everything else centered.

**Forms** (`.field`) — label above input, `8px`-radius bordered input,
border + focus ring turn `--accent` on focus. Hint text below in muted,
smaller type.

**Overlays** — dropdown menu (`.profile__menu`) and modal (`.modal`) both
float on a white surface with a stronger shadow than resting panels
(`0 8px 24px` and `0 20px 48px` respectively, both in the same dark-green
tinted rgba family); the modal additionally sits over a `rgba(23,36,28,0.35)`
scrim.

## Accessibility notes baked into the system

- Every interactive element relies on `:focus-visible` with the shared
  `--focus-ring` (a colored box-shadow ring) rather than the browser
  default outline, but never removes focus indication outright.
- Color is never the only signal for state: active tabs/pills also change
  background or add an underline; status pills carry a text label, not
  just a color.
