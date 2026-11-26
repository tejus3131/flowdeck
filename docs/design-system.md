# Flowdeck design system — the frozen token layer

The playground experiments _within_ these tokens; nothing ships that
invents a new value. Every number traces to [`design-findings.md`](./design-findings.md)
or [`research/`](./research/). Changes to this file are ADR-grade: they
reopen decisions, so they get a line in `docs/adr.md` too.

## Color

Built in OKLCH (Tailwind 4 native; Stripe's finding: HSL lightness is
perceptually broken). Two grays are the P1 experiment: **warm** (Notion's
calm) vs **cool** (current). The playground renders both; whichever wins
by feel becomes the default and the other stays as a one-token swap.

```css
:root {
  /* text — warm variant (P1-A) */
  --fd-text: oklch(0.22 0.01 80); /* ≈ #37352f, Notion's warm near-black */
  --fd-text-2: oklch(0.45 0.01 80); /* secondary */
  --fd-text-3: oklch(0.62 0.01 80); /* placeholders, timestamps */
  /* text — cool variant (P1-B): same lightness, hue 250, chroma 0.005-0.01 */

  /* surfaces — light */
  --fd-bg: oklch(1 0 0); /* page */
  --fd-bg-1: oklch(0.975 0.002 80); /* raised: cards, inputs */
  --fd-bg-2: oklch(0.95 0.003 80); /* hover, wells */
  --fd-line: oklch(0.91 0.003 80); /* borders */

  /* accent — indigo (P2 tests indigo vs violet) */
  --fd-accent: oklch(0.55 0.21 275); /* ≈ current indigo-600 */
  --fd-accent-hover: oklch(0.6 0.21 275);
  --fd-accent-tint: oklch(0.96 0.03 275); /* selected rows, focus wells */

  /* semantic — rationed */
  --fd-danger: oklch(0.62 0.22 25); /* errors only */
  --fd-success: oklch(0.65 0.17 150); /* done-column tint, completion pulse */
}
.dark {
  /* dark surfaces follow Linear's ladder: 0.11 → 0.14 → 0.17 → 0.20 L */
  --fd-bg: oklch(0.145 0.004 260);
  --fd-bg-1: oklch(0.17 0.004 260);
  --fd-bg-2: oklch(0.2 0.005 260);
  --fd-line: oklch(0.24 0.005 260);
  --fd-text: oklch(0.95 0.004 260);
  --fd-accent: oklch(0.68 0.19 275); /* lighter for dark-bg contrast */
}
```

**Tag chips** (the OKLCH payoff): 8 hues at fixed L/C, lightness-stepped
per theme — perceptually even, no "yellow looks brighter than blue":

```css
--fd-tag-1..8: oklch(0.75 0.14 <hue>) … /* hues: 25, 60, 145, 195, 250, 300, 340, 80 */;
```

**60/30/10 discipline:** grays carry ~60% (surfaces, text), secondary
surfaces ~30%, accent ≤10% — links, primary buttons, focus, selection.
Danger/success appear only in their semantic roles.

## Typography

One family: **Inter** (variable). Notion's calm is one-font + 1.5
line-height + a reading measure; we inherit all three.

| Token            | Value                                     | Use                                           |
| ---------------- | ----------------------------------------- | --------------------------------------------- |
| `--fd-font`      | `Inter, -apple-system, sans-serif`        | everything                                    |
| `--fd-text-xs`   | 11px / 1.45                               | badges, timestamps                            |
| `--fd-text-sm`   | 13px / 1.5                                | card titles, body default (P4 tests 13 vs 14) |
| `--fd-text-base` | 14px / 1.5                                | drawer body, chat messages                    |
| `--fd-text-lg`   | 16px / 1.4                                | drawer title, section heads                   |
| `--fd-text-xl`   | 20px / 1.3                                | page titles                                   |
| `--fd-measure`   | 708px                                     | description/comment reading width             |
| `--fd-mono`      | `ui-monospace, SFMono-Regular, monospace` | code chips                                    |

Weights: 400 body, 500 emphasis/labels, 600 titles. No 700 — Inter at
600 reads bold enough and stays calm.

## Spacing & radius

Canva's 8px grid, Notion's semantic radius aliases:

```css
--fd-space-1: 4px;
--fd-space-2: 8px;
--fd-space-3: 12px;
--fd-space-4: 16px;
--fd-space-5: 24px;
--fd-space-6: 32px;
--fd-radius-sm: 6px; /* inputs, chips */
--fd-radius-md: 10px; /* cards, popovers */
--fd-radius-lg: 14px; /* drawer, modals */
--fd-radius-full: 999px; /* avatars, pills */
```

## Motion

The frozen budget (NN/g durations; rbd/Linear/Notion curves; the
frequency rule):

```css
--fd-dur-1: 100ms; /* feedback: hovers, toggles, chip states */
--fd-dur-2: 200ms; /* displacement, exits */
--fd-dur-3: 300ms; /* drawer/popover enters */
--fd-ease-out: cubic-bezier(0.16, 1, 0.3, 1); /* enters — Notion */
--fd-ease-move: cubic-bezier(0.2, 0, 0, 1); /* drag displacement — rbd */
--fd-ease-drop: cubic-bezier(0.2, 1, 0.1, 1); /* drop settle — rbd */
--fd-ease-spring: cubic-bezier(0.45, 1.45, 0.8, 1); /* completion ONLY */
```

**Rules (enforced in review):**

- Enter 300ms / exit 200ms — never equal
- Zero motion on: menu open, chip hover, tab switch, keystroke feedback
- Spring easing appears only on completion moments (Done-drop, board cleared)
- Drop animation duration lerps 330→550ms by distance (rbd)
- `prefers-reduced-motion: reduce` → all animation/transition off, globally

## Elevation

Two levels only (Linear's "felt not seen"):

```css
--fd-shadow-1: 0 1px 2px oklch(0 0 0 / 0.06); /* cards on board */
--fd-shadow-2: 0 8px 24px oklch(0 0 0 / 0.14); /* drawer, popovers */
```

Flat vs elevated cards is the P2 experiment; both use these two shadows.

## Component tokens (the contract)

Components read tokens; they never hardcode. The checklist a new
component passes: color from `--fd-*` → spacing from the 8px scale →
radius from the alias set → motion from the budget → text from the type
scale. If a component needs a value that doesn't exist, the token gets
added _here first_ — that's the freeze.
