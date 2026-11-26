# UX Mechanisms Research Report: Notion, Canva, Linear, Figma, Arc

**Method note:** Claims below are verified against production CSS bundles (Notion, Linear, Canva), official help docs, engineering blogs, and UX research. Where I could not verify a claim, I flag it explicitly. Flowdeck's current `src/app.css` (Tailwind 4, class-based dark mode, indigo accent) was reviewed to ground the recommendations.

---

## 1. Notion — Interaction patterns that make it feel easy

### Slash commands (verified from notion.com/help/keyboard-shortcuts)

Pressing `/` opens a full block-insert menu; typing after `/` filters it. Documented commands include `/text`, `/h1`–`/h3` (aliases `/#`, `/##`, `/###`), `/todo`, `/toggle`, `/div`, `/quote`, `/mention`, `/date`, `/emoji`, `/image`, `/code`, `/embed` (500+ embeds), `/duplicate`, `/moveto`, `/delete`, `/toc`, `/button`. `esc` clears the menu — "handy if you're just trying to use a / in your writing." Source: https://www.notion.com/help/keyboard-shortcuts

**Mechanism:** one chord (`/` + fuzzy type + Enter) replaces hunting through menus. The menu is _inline at the caret_, not a floating toolbar — zero pointer travel.

### Blocks as the universal primitive

Notion's help doc "What is a block?" confirms everything is a block that can be dragged, converted (`/turninto`), duplicated. Source: https://www.notion.com/help/what-is-a-block

### Keyboard-first editing (verified shortcuts)

- `cmd/ctrl + \` toggles the sidebar (source: notion.com/help/sidebar)
- `cmd/ctrl + shift + L` toggles dark/light mode (source: keyboard-shortcuts doc)
- `cmd/ctrl + [` / `]` navigates back/forward
- Database **peek view** has dedicated paging keys (`ctrl+shift+K`/`J` on Mac) — peek is a first-class navigation state, not a modal afterthought

### Drag handles on hover

Notion's production CSS shows hover-revealed affordances with `cubic-bezier(.16,1,.3,1)` transitions (extracted from `notion.com/_assets/main-b8d69ace73080c20.css`). The handle appears only on block hover — progressive disclosure of the drag affordance.

**Flowdeck implementation:** add `/` and `@` menus to the card description composer (you already have `@` chips in `SmartTextarea`); make the `/` menu filter-as-you-type with keyboard navigation, positioned at the caret.

---

## 2. Notion — Information density without overwhelm

### Progressive disclosure (research-backed)

Nielsen's foundational article: show only the few most important options initially; disclose secondary features only on request. Benefits: improves learnability, efficiency, and error rate; novice users avoid mistakes, advanced users scan less. Critically: "the very fact that something appears on the initial display tells users that it's important." Source: https://www.nngroup.com/articles/progressive-disclosure/ (Nielsen, 2006)

### Peek vs. full page

Notion's peek view (confirmed via keyboard-shortcuts doc: "database peek view" with dedicated paging shortcuts) lets users scan a page without losing their list context. The pattern: **hover/preview = lightweight overlay; click = full navigation; the peek has its own keyboard paging.**

### Sidebar behavior (verified from notion.com/help/sidebar)

- Infinite nesting via toggles; drag-and-drop reorganization
- Sidebar is made of **tabs** containing shortcuts (New page, My Tasks) and sections (Recents, Favorites, Teamspaces)
- "Two things stay in one spot. Your inbox sits in the top-right corner, and your workspace name sits at the bottom. Everything in between is yours to arrange."
- Tabs can be shown/hidden/reordered; workspace-defined "presets" exist

**Mechanism:** stable anchors (inbox, workspace name) + rearrangeable middle = density without disorientation. `cmd/ctrl+\` collapse keeps the keyboard path to it.

---

## 3. Notion — Typography and spacing (extracted from production CSS)

From `https://www.notion.com/_assets/main-b8d69ace73080c20.css` (downloaded and grepped):

| Property            | Value                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Font stack          | `NotionInter, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif` |
| Body line-height    | `1.5`                                                                                                                  |
| Content width       | **`708px`** at `width>=900px` (with `--margin-width: 1fr`); tablet: `--content-width: 1fr; --margin-width: 96px`       |
| Marketing max-width | `940px`                                                                                                                |
| Code font           | `Consolas, Monaco, Andale Mono, Ubuntu Mono, monospace`                                                                |

The 708px measure ≈ 65–75 characters per line at 16px — the classic optimal reading measure. The calm feeling comes from: one font family, generous `1fr` margins that center content, and a strict line-height of 1.5 everywhere.

**Notion's design system is internally called "Tatami"** — its tokens visible in the CSS: border-radius scale (`--tatami-border-radius-0/200/500/600/700`, `round: 624.938rem`), semantic radius aliases (`--tatami-border-button-radius`, `--tatami-border-popover-radius`, `--tatami-border-card-radius`), focus-ring style tokens (solid/dashed), and a `--tatami-motion-global-fade-in-duration` variable.

**Flowdeck implementation (Tailwind 4):**

```css
.prose-card {
  max-width: 708px;
  line-height: 1.5;
}
/* tokens mirroring Tatami's semantic-alias approach */
:root {
  --fd-radius-popover: 12px;
  --fd-radius-card: 16px;
  --fd-radius-button: 8px;
}
```

---

## 4. Notion — Empty states and onboarding

Notion's llms.txt confirms a Template Gallery ("Browse hundreds of pre-built templates for any use case") as the onboarding backbone — new users start from structure, not blankness. Source: https://www.notion.com/llms.txt

**The strongest onboarding guidance comes from Rauno Freiberg (Linear's interaction designer):** onboarding is the _one_ place to dial novelty up, because it happens once. His production pattern (Devouring Details): a login→welcome transition plays **only on first login** — a cookie gates it; on reload the page renders instantly with no motion. Implementation shown in his essay (Next.js middleware rewriting to an `-animate` route, cookie set to `false` after). Source: https://rauno.me/craft/novelty (Feb 2026)

> "A really good use case for increased novelty is onboarding because you generally only onboard a product once… Think of it as a special moment. Personally, I don't need to be novelly greeted 'welcome' by a product every single time I return."

---

## 5. Notion — Color: neutral-but-not-boring (extracted from production CSS)

From Notion's CSS bundles (frequency = occurrences in the bundle):

| Color           | Hex       | Count | Role                                 |
| --------------- | --------- | ----- | ------------------------------------ |
| Notion blue     | `#2383e2` | 125   | The single accent                    |
| Near-black text | `#0f0f0f` | 50    | Primary text (not pure black)        |
| Warm gray text  | `#37352f` | 34    | Secondary text — warm, not cool gray |
| Red             | `#eb5757` | 2     | Errors only                          |
| Gray            | `#9b9b9b` | 6     | Placeholders                         |

**Mechanism:** ~99% of the interface is warm-neutral (`#37352f` is a brown-tinted gray, warmer than Tailwind's `neutral`); one blue accent carries all interactivity; red is rationed. This maps to the 60/30/10 cinematography rule Freiberg cites: "about 60% primary, 30% secondary, 10% accent… the remaining 10% can be thought of as the _novelty_ color." Source: https://rauno.me/craft/novelty

**Flowdeck note:** your current `neutral` + `indigo` stack is close; consider warming the text gray slightly (e.g. `stone` or a custom `#37352f`-like value) for Notion's calm feel.

---

## 6. Canva — What makes it "fun"

**Verified:** Canva's design system is called **Easel** — consistency, composability, efficiency are its stated purposes. Core layout principles: **8px grid spacing scale** (`spacing1u`=8px through `spacing4u`=32px) and breakpoints **small: 600px, medium: 900px, large: 1200px**. Source: https://www.canva.dev/blog/engineering/adding-responsiveness-to-canvas-design-system/ (Jordan Cohn, Aug 2024)

**Verified:** Canva preloads `canva-sans` woff2 fonts and ships a no-flash theme script (see §9).

**Gap (flagged):** Canva has _no public engineering post_ on their spring animations, snap/bounce physics, or side-panel motion. I searched canva.dev/blog/engineering (all tags: UI/UX, backend, ML, infra, security, practices, data) — the UI/UX tag contains only the design-system, CSS-positioning, UI-testing, eyedropper, and localization posts. Their microinteraction "feel" is not publicly documented; the closest transferable evidence is Figma's motion glossary (§8) and M3's spring tokens.

**What can be said from adjacent evidence:** the "fun" comes from physics-plausibility — overshoot and settle. Figma's brand motion lead defines the vocabulary: "**Overshoot:** moving slightly past the final position before settling back… **Settle:** the final, subtle motion as something comes to rest… **Follow-through:** secondary motion that continues after the main movement stops." Source: https://www.figma.com/blog/principles-in-motion/ (June 2026). Linear ships exactly one overshoot curve in production CSS: `cubic-bezier(.45,1.45,.8,1)` (extracted from static.linear.app CSS).

---

## 7. Canva — Side panel organization

**Partially verified:** Canva's template gallery is the answer to "hundreds of assets" (llms.txt/marketing confirms template-first flows), but I found **no public doc** detailing the side panel's category/search/curated-row architecture. Flagged as a gap.

**Transferable pattern from cmdk (the library behind most command palettes, by Pacocoursey):** items become active **on pointer enter** (not click) — hover _is_ preview; `scroll-padding-block: 8px` keeps the selected item visible near edges; list height animates via `--cmdk-list-height` with `transition: height 100ms ease`. Source: https://github.com/pacocoursey/cmdk (README)

---

## 8. Motion language — concrete numbers (multi-source)

### Durations (NN/g, Laubheimer 2020 — https://www.nngroup.com/articles/animation-duration/)

- **100 ms** — simple feedback (checkbox, toggle); "feels immediate… creates the illusion of physically manipulating the object"
- **200–300 ms** — substantial changes (modal entering)
- **400 ms** — "a very slow animation, to be used only for big movements"
- **500 ms** — "animations start to feel like a real drag"
- **Enter > exit:** "a popup window may take 300ms to appear, but only 200 or 250ms to disappear"
- **Frequency rule:** "the more frequent the animation, the more subtle and shorter you'll want it to be"

### Easings

- **NN/g:** ease-out for entering (fast start, slow rest — "allows the eye time to focus"), ease-in for exiting. Source: animation-duration article
- **Material 3 tokens** (verified via mdui's token docs, which mirror M3): standard `cubic-bezier(0.2, 0, 0, 1)`; emphasized-decelerate `cubic-bezier(0.05, 0.7, 0.1, 1)`; emphasized-accelerate `cubic-bezier(0.3, 0, 0.8, 0.15)`; durations short1=50ms, medium1=250ms, long1=450ms. Source: https://github.com/zdhxiong/mdui `docs/en/styles/design-tokens.md:1155-1246`
- **Linear's signature easing** (extracted from production CSS, 7 occurrences): `cubic-bezier(.32,.72,0,1)` — a strong decelerate used for their hallmark panel/overlay motion. Also present: `cubic-bezier(.66,0,0,1)` and the overshoot `cubic-bezier(.45,1.45,.8,1)`. Duration tokens: **50ms** (`--sx-imi5ey: 50ms`).
- **Notion's easings** (extracted): `cubic-bezier(.16,1,.3,1)` (2×), `cubic-bezier(.45,0,.55,1)` (3×, standard ease-in-out), `cubic-bezier(.22,1,.36,1)`, `cubic-bezier(.32,.72,0,1)` (same as Linear's).

### What NOT to animate (Rauno Freiberg — https://rauno.me/craft/interaction-design)

> "Command menus… It's tempting to throw an opacity and scale fade on the overlay. But if we for a moment consider the interaction frequency being hundreds of times a day, it does start to feel more like cognitive burden… I removed motion from core interactions and suddenly felt like I was moving much faster."

- macOS context menus appear with **no motion**; the selected item **blinks the accent color** to confirm selection; the menu _fades out_ (graceful exit)
- The macOS App Switcher never animates; if the time delta between Cmd and Tab is low enough, it switches **without showing the menu at all**
- His bookmarking tool felt sluggish _because of_ its add/remove animations, despite snappy tuning

**Flowdeck implementation (Tailwind 4 tokens):**

```css
:root {
  --fd-ease-out: cubic-bezier(0.16, 1, 0.3, 1); /* Notion's */
  --fd-ease-panel: cubic-bezier(0.32, 0.72, 0, 1); /* Linear's */
  --fd-ease-spring: cubic-bezier(0.45, 1.45, 0.8, 1); /* overshoot, rare */
  --fd-dur-fast: 100ms;
  --fd-dur-med: 200ms;
  --fd-dur-slow: 300ms;
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition: none !important;
  }
}
```

NN/g explicitly requires respecting reduce-motion (vestibular disorders, seizure risk). Source: animation-duration article.

---

## 9. Theme systems — light/dark done right

### Canva's no-flash theme init (verified from canva.dev HTML source — inline `beforeInteractive` script):

```js
try {
  var e = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    t = localStorage.getItem('theme') || 'system',
    a = 'system' === t ? e : t;
  document.documentElement.classList.add(a);
} catch {}
```

Three-state model (`light`/`dark`/`system`), class-based, runs before paint. **Flowdeck already does this** (your `app.css` comment describes the mirror-cookie + inline head script) — you match Canva's pattern.

### Linear's palette (extracted from static.linear.app CSS)

- Accent: `--color-accent:#7170ff`, hover `#828fff`, tint `#f1f1ff` (light) / `#18182f` (dark)
- Background levels (light): `#fff → #f8f8f8 → #f4f4f4 → #f0f0f0`; (dark): `#08090a → #0f1011 → #141516 → #191a1b`
- Radius: `8px` dominant (35 uses), then 6px, 4px
- Fonts: **Inter Variable** + **Berkeley Mono** for code
- Notion's dark-mode toggle: `cmd/ctrl+shift+L` (keyboard-shortcuts doc)

### Accent color psychology

**Gap flagged:** I could not fetch the Labrecque & Milne (2012) study directly (Springer returned 406). It's the standard citation ("Exciting red and competent blue: the importance of color in marketing" — blue reliably maps to "competence"), but treat as unverified-here. The verified adjacent finding is Stripe's: HSL lightness is perceptually broken ("at the same level of mathematical lightness, yellow appears lighter than blue"), so they rebuilt their palette in a perceptual model (OKLCH) to get WCAG-passing contrast (4.5:1 small text) _without_ muddy colors. Source: https://stripe.com/blog/accessible-color-systems (Koopersmith & Miner, 2019)

**Flowdeck note:** Tailwind 4 supports `oklch()` natively — define your indigo accent in OKLCH and generate tints by lightness steps for perceptually even chips (your amber/sky/violet mention/tag colors).

---

## 10. Custom cursors / pointers

- **Figma:** multiplayer cursors are the canonical example; their engineering post covers the transport (WebSockets, per-document server process) but the _cursor rendering_ specifics post was not retrievable (404 on all slug guesses; not in current blog index). Source for multiplayer architecture: https://www.figma.com/blog/how-figmas-multiplayer-technology-works/ (Evan Wallace, 2019)
- **macOS shake-to-find-pointer** — Freiberg calls it out as tapping "the frustration and natural reaction that people feel when losing track of the pointer" (interaction-design essay) — evidence that custom pointer behavior helps when it addresses a _felt_ problem
- **Implementation pattern:** CSS `cursor:` for static affordances (you already use `cursor-help` on mention chips, `cursor-text` on the composer — correct and cheap); a custom element following the mouse is warranted only for _presence_ (multiplayer) or _precision_ (Figma's loupe), never decoration. cmdk's "active on pointer enter" shows the middle path: pointer proximity drives UI state without replacing the cursor.

---

## 11. Command palettes (Cmd+K)

**What makes them feel fast (Rauno, interaction-design essay):** no entrance animation, instant render, and the Cmd-Tab-style shortcut that skips the menu entirely when the intent is unambiguous.

**Implementation specifics (cmdk README — verified):**

- Custom `filter` returning a rank (not boolean), with `keywords` as aliases affecting rank
- `loop` prop wraps arrow keys
- `scroll-padding-block: 8px` on the list
- List height: `min-height: 300px; height: var(--cmdk-list-height); max-height: 500px; transition: height 100ms ease`
- Items activate on pointer enter; `Command.Empty` for no-results

**When they replace menus:** Freiberg's ⌘K breadcrumbs prototype (rauno.me/craft, Dec 2022) and Linear's product itself demonstrate the pattern — the palette _supplements_ visible UI for high-frequency keyboard users; it doesn't remove the menus (progressive disclosure still governs discovery for novices).

---

## 12. Micro-interaction research — what works vs. noise

| Finding                                                                                                                                         | Number   | Source                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Instantaneous feel / direct manipulation limit                                                                                                  | **0.1s** | NN/g response-times (Miller 1968; Card et al. 1991; Nielsen 1993) https://www.nngroup.com/articles/response-times-3-important-limits/ |
| Flow-of-thought limit                                                                                                                           | **1.0s** | same                                                                                                                                  |
| Attention limit                                                                                                                                 | **10s**  | same                                                                                                                                  |
| Microinteractions = trigger-feedback pairs; convey status, prevent errors, communicate brand                                                    | —        | NN/g https://www.nngroup.com/articles/microinteractions/ (Kendrick 2018)                                                              |
| Animation beats static feedback due to change blindness (cart-badge example)                                                                    | —        | NN/g animation-purpose (Laubheimer 2020) https://www.nngroup.com/articles/animation-purpose-ux/                                       |
| Motion is pre-attentively detected by peripheral vision (rods) — impossible to ignore, so it must be relevant                                   | —        | same                                                                                                                                  |
| Aesthetic-usability effect: pretty UI makes users forgive _minor_ issues (not large ones)                                                       | —        | NN/g https://www.nngroup.com/articles/aesthetic-usability-effect/ (Moran 2024)                                                        |
| Surface delight (animations, microcopy, sound) vs **deep delight** (flow state; "hands all the right instruments exactly when they are needed") | —        | NN/g https://www.nngroup.com/articles/theory-user-delight/ (Fessenden 2017)                                                           |
| Peak-end rule: 80% chose the _longer_ cold-water trial because it ended milder; design peaks and ends (Duolingo's celebration)                  | —        | NN/g https://www.nngroup.com/articles/peak-end-rule/ (Kane 2018; Kahneman & Frederickson 1993)                                        |
| "The greatest joy of using computers comes through user empowerment… In 'look and feel,' _feel_ wins every time"                                | —        | NN/g https://www.nngroup.com/articles/user-empowerment-and-the-fun-factor/ (Nielsen 2002)                                             |
| Frequency × novelty: high-frequency actions must not animate; semantic satiation kills flourishes                                               | —        | rauno.me/craft/interaction-design + /novelty                                                                                          |
| "Make 90% of the experience familiar, 10% novel"                                                                                                | 90/10    | rauno.me/craft/novelty                                                                                                                |
| Asana's flying unicorn on task-complete: sporadic celebration + undo affordance (error prevention)                                              | —        | NN/g microinteractions article                                                                                                        |

**The synthesis:** engagement-driving microinteractions are (1) feedback within 100ms, (2) status-communicating, (3) error-preventing (undo), (4) rare enough to stay novel (celebrations on completions, not on every keystroke). Noise is: entrance animations on high-frequency overlays, motion that decorates instead of informs, anything over 500ms.

---

## 13. Delight — the evidence

1. **Deep delight > surface delight** (NN/g, Fessenden 2017): flow-state usability is the precondition; confetti on a broken flow has no ROI. Walter's hierarchy: functional → reliable → usable → pleasurable.
2. **Peak-end rule** (NN/g, Kane 2018): invest disproportionately in (a) the most intense moments of the journey and (b) the _end_ of interactions — a card moved to Done, a board cleared. Duolingo's end-of-lesson celebration is the cited exemplar.
3. **Negativity bias**: users remember bad more than good — removing pain beats adding sparkle (delight article).
4. **Personality in copy**: Groupon's snarky microcopy and Yelp's "sassy" copy are NN/g's cited examples of surface delight that works _on top of_ solid usability.
5. **Once-only moments**: Freiberg's cookie-gated login transition — delight that respects frequency.
6. **Arc's cautionary tale**: The Browser Company's own "novelty tax" admission (quoted in Freiberg's novelty essay): "the tabs are over here and there are these things called Spaces and then there are Pin Tabs… People just couldn't handle how much there was to learn that was new." Novelty in navigation structure taxes users; novelty in _moments_ doesn't.

---

## Gaps and uncertainties

1. **Canva's motion/spring/snap specifics** — no public engineering source exists (searched all canva.dev blog tags). Their "fun" is undocumented; I've substituted Figma's motion glossary + Linear's extracted curves as the closest verifiable proxies.
2. **Figma UI3 blog post** — 404 on every plausible slug (`introducing-ui3`, `ui3`, `figma-ui3-design-system`); not in the current blog index; no Wayback snapshot. Figma's _current_ design-system specifics unverified.
3. **Figma multiplayer-cursors post** — the famous cursors-specific article wasn't retrievable; I verified the multiplayer-technology post instead (architecture, not cursor rendering).
4. **Arc's easing values** — eases.co is now domain-parked; Arc itself is discontinued ("A farewell to Arc" on arc.net homepage). No verifiable Arc motion tokens.
5. **Labrecque & Milne color-personality study** — Springer blocked the fetch (406). Standard citation, unverified here.
6. **Slack's color-system engineering post** — 404; slack.engineering's current index has no design-system color post.
7. **Notion peek help page** — 404 at all guessed slugs; peek's _existence_ and keyboard paging verified via the keyboard-shortcuts doc, but its interaction spec (hover vs. click behavior) is inferred, not doc-verified.

## Suggested follow-ups

- Figma UI3: try `web.archive.org/web/2024/figma.com/blog/*` CDX query with a longer timeout (my query was cut off)
- Canva motion: check Canva's Config talk recordings or their design org's Medium/Dribbble posts rather than canva.dev
- For Solid 2.0 specifically: `cmdk` is React-only; the equivalent primitives (Kobalte or Ark UI for Solid) provide the same combobox/dialog a11y — the filter-rank/keywords/scroll-padding patterns transfer directly.
