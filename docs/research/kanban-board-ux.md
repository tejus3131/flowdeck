***

# Kanban/Project Tool Design Research — Flowdeck Redesign

## Summary

I researched primary sources: Atlassian's `react-beautiful-dnd` design docs (the physics model behind Trello-class dragging, with exact curves and timings), Atlassian support docs for Trello and Jira (card anatomy, WIP limits, collapse, templates), Linear's design blog and docs (drawer hierarchy, visual-weight principles), Figma's multiplayer engineering post + help center (presence limits, cursor chat), Notion's comments docs (side-panel comment patterns), and Monday's Zendesk help API (item card field grouping, updates-as-chat). Asana and Height were inaccessible (JS-walled / site sunset) — noted as gaps. I also grounded findings against Flowdeck's current implementation (`src/routes/b/[boardId].tsx`, `src/lib/panel-width.ts`).

---

## 1. Card Anatomy — What's on the Face

**Consensus stack (top → bottom):** title → cover image (optional) → badges row → footer row (avatars + due date).

| Tool                    | Title      | Badges/metadata on face                                                                                                                                                                                                       | Avatars                      | Cap                                                                                                                                            |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trello**              | Always     | Labels (color chips), due-date chip, checklist progress `3/5`, attachment count, description icon, cover image (half/full)                                                                                                    | Members bottom-right         | 30 label colors + colorless; colorless only shows on card _back_ ([source](https://support.atlassian.com/trello/docs/adding-labels-to-cards/)) |
| **Jira**                | Always top | 3 fixed layers: summary → up to **3 custom fields** → type/priority/assignee/estimate. "To view all other fields, select a card" ([customize-cards](https://support.atlassian.com/jira-software-cloud/docs/customize-cards/)) | Assignee avatar              | 3 custom fields max — a hard consensus number                                                                                                  |
| **Monday (Cards View)** | Always     | Configurable column subset (e.g. Designer, Status, Asset) + cover from a File/People column ([Cards View](https://support.monday.com/hc/en-us/articles/4405723870994))                                                        | People column                | Admin picks which columns render                                                                                                               |
| **Linear**              | Always     | Priority icon, labels, sub-issue progress, linked PR status                                                                                                                                                                   | Assignee avatar bottom-right | Minimal by philosophy (see §6)                                                                                                                 |

**How much is TOO much — the consensus:**

- **Jira's own answer is "3 custom fields max"** and a strict 3-layer layout; everything else lives in the detail view. That's the most-cited hard number.
- **Trello's answer is progressive:** labels show _color only_ by default on the face; names appear on click or `;` toggle. Colorless labels are face-invisible entirely. Half covers keep the badge row visible; full covers hide it — the cover never _adds_ clutter, it trades.
- **Monday's answer is admin-curated:** the face shows a chosen subset, and clicking a face field edits inline without opening the item.
- **Linear's design principle** (from their 2026 refresh): _"Don't compete for attention you haven't earned"_ — elements supporting orientation recede; only task-central elements carry weight. They _reduced_ icon usage and sizes in the refresh ([behind-the-latest-design-refresh](https://linear.app/now/behind-the-latest-design-refresh)).

**Flowdeck today** (`src/routes/b/[boardId].tsx:1717-1770`): title, priority pill, ≤3 tag chips, ≤4 avatars + overflow, "Details" button, unseen-comment badge. This is already within consensus; the one addition worth making is a **due-date chip** and **checklist progress** if those fields exist.

---

## 2. List/Column Design

- **WIP limits (Jira):** Column constraints = "Work item count" or "Work item count, excluding subtasks" (subtask exclusion recommended for Scrum). Both **min and max** per column. Enabling constraints _shows the live count in each column header_ — the count display is a feature of the limit, not separate. Right-click column → "Set column limit" in the new board UI ([configure-columns](https://support.atlassian.com/jira-software-cloud/docs/configure-columns/)).
- **Column semantics (Jira):** Multiple workflow statuses map to one column to keep column count low. Category colors: leftmost gray (new), middle blue (in progress), rightmost green (done) — a 3-color semantic system.
- **Collapsed state (Trello):** Collapsed list shows **name + card count only**. Toggle: collapse button, or hover + `\`. "Collapse/expand all" lives in the board menu (paid tiers) ([collapse-or-expand-a-list](https://support.atlassian.com/trello/docs/collapse-or-expand-a-list/)).
- **Scroll behavior:** Trello columns scroll independently; the board scrolls horizontally. Jira's kanban backlog grows beyond a few items → moves to a **dedicated backlog space** rather than an ever-longer first column.
- **Capacity numbers:** Trello hard limit 5,000 cards/board, perf degrades >1,000 ([adding-cards](https://support.atlassian.com/trello/docs/adding-cards/)). Jira board/backlog render max 5,000 items, then warn the admin to tighten the filter ([issue-limits](https://support.atlassian.com/jira-software-cloud/docs/issue-limits-in-company-managed-projects/)).

**Flowdeck:** already has per-device collapse (`board-fold.test.tsx`). Add: card count in collapsed header (Trello pattern), optional per-list max with header count badge (Jira pattern).

---

## 3. Drag-and-Drop Feel

The definitive source is Atlassian's `react-beautiful-dnd` design docs — written by the team whose drag feel is the industry reference.

**Core physics model** ([design-principles.md](https://github.com/atlassian/react-beautiful-dnd/blob/master/docs/about/design-principles.md)):

1. **Physicality — no snapping.** "At no point is an item instantly moved anywhere." Items animate out of the way and animate on drop.
2. **Center of gravity, not grab point.** Impact is based on the dragged item's _center_ crossing another item's edge — "like a set of scales." This is why it feels fair regardless of where you grab.
3. **Movement, not markers.** No drop shadows/line indicators — displacement _is_ the drop indicator. (Linear and Figma follow the same: the gap opening is the affordance.)
4. **Maximize interactivity.** Only two non-interactive windows exist: mid-cancel-animation and dropping-into-own-drop. You can grab other items while a drop animates.
5. **No axis locking** — it breaks the physical metaphor.

**Exact animation constants** ([src/animation.js](https://github.com/atlassian/react-beautiful-dnd/blob/master/src/animation.js)):

```ts
curves = {
  outOfTheWay: 'cubic-bezier(0.2, 0, 0, 1)', // items making room
  drop: 'cubic-bezier(.2,1,.1,1)', // settling into place
};
timings = {
  outOfTheWay: 0.2, // 200ms displacement
  minDropTime: 0.33, // drop animates 330–550ms,
  maxDropTime: 0.55, // duration scales with distance traveled
};
placeholderTransitionDelayTime = 0.1; // 100ms before ghost resize animates
combine = { opacity: { dragging: 0.7, drop: 0 }, scale: { drop: 0.75 } };
```

The **displacement curve is 3-phase** ([animations.md](https://github.com/atlassian/react-beautiful-dnd/blob/master/docs/about/animations.md)): warm-up (natural response time) → fast move → long tail (so text stays readable in the second half). The **drop is spring-like with dynamic duration** based on distance.

**Auto-scroll** ([auto-scrolling.md](https://github.com/atlassian/react-beautiful-dnd/blob/master/docs/guides/auto-scrolling.md)):

- Zones are **percentages of container size**, not pixels — works at any container size.
- Speed **accelerates exponentially** as you approach the edge; **max speed is reached _before_ the true edge** so precision isn't required.
- Manual wheel/trackpad scroll stays available _during_ drag.
- If the dragged item is bigger than the container on an axis, that axis won't auto-scroll.

**Preset styles** ([preset-styles.md](https://github.com/atlassian/react-beautiful-dnd/blob/master/docs/guides/preset-styles.md)) — the full "what to apply during drag" checklist:

- Resting handle: `cursor: grab`; dragging: `cursor: grabbing` on body, `user-select: none`
- During drag: `pointer-events: none` on droppables (kills hover-style flicker), `touch-action: manipulation`, `-webkit-touch-callout: none`, `overflow-anchor: none` (prevents post-drop scroll jumps)
- Drop animation must not be `transition-duration: 0s` (breaks `transitionend`) — use `0.001s` if skipping

**Flowdeck today** (`src/routes/b/[boardId].tsx:586-643`): rAF auto-scroll with fixed `EDGE=90px, SPEED=18px/frame`. **Upgrade path:** switch edge zone to `%` of container (rbd model), add exponential ramp (e.g. `speed = max * (1 - dist/EDGE)^2`), and adopt the 200ms `cubic-bezier(0.2,0,0,1)` displacement curve + 330–550ms distance-scaled drop. The existing FLIP glide (`offsetTop`-measured, per the code comments) already matches the "no snapping" principle.

---

## 4. Card Detail Views — Drawer vs Modal vs Page

| Tool       | Pattern                                                                                                                                                                                                                                             | Why                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Linear** | Right **drawer** over the board, board stays visible                                                                                                                                                                                                | Issue work is in-context; keyboard-first (`C` create, `Esc` close); the 2024 redesign explicitly tuned "sidebar, tabs, headers, and panels" as one chrome system ([how-we-redesigned](https://linear.app/now/how-we-redesigned-the-linear-ui)) |
| **Trello** | **Popover-then-full**: card opens as a full detail overlay (historically a modal; card "front/back" metaphor)                                                                                                                                       | The card _is_ the object — front (face) / back (details)                                                                                                                                                                                       |
| **Jira**   | **Issue detail view** — configurable field layout, opened from board; in active sprints it's a side detail ([view-and-edit-issue-details](https://support.atlassian.com/jira-software-cloud/docs/view-and-edit-issue-details-in-an-active-sprint/)) | Enterprise needs deep-linkable URLs + admin-configured screens                                                                                                                                                                                 |
| **Monday** | **Item page with tabs**: Updates / Files / Activity Log / **Item Card** (addable widget-tab) ([Item Card](https://support.monday.com/hc/en-us/articles/360017143959))                                                                               | Tabbed sub-views inside a full-page drawer                                                                                                                                                                                                     |
| **Notion** | **Peek/preview side panel** for database rows; full page vs inline is a user choice ([full-page-vs-inline](https://www.notion.com/help/guides/full-page-vs-inline-databases))                                                                       | Peek = quick look without losing list context; "Open as page" for focus                                                                                                                                                                        |

**Consensus for a board app:** right-side **drawer** (Linear/Notion model) for speed + context, with a **deep-linkable URL** (Jira model) so a card is shareable. Modal-only (old Trello) loses board context; page-only (Jira) kills throughput for triage flows.

**Flowdeck:** already drawer-based with one-panel-one-owner semantics and 384–768px resizable width (`src/lib/panel-width.ts`) — matches Linear's model. Keep it; add URL sync for open card.

---

## 5. Information Hierarchy in the Card Detail

**Jira's anti-pattern and its fix:** Jira's "wall of fields" is solved _adminstratively_ — fields are configured per screen; summary is always displayed and always editable; description can be hidden; some fields only display conditionally (e.g. Fix versions only if the space has versions) ([configure-the-issue-detail-view](https://support.atlassian.com/jira-software-cloud/docs/configure-the-issue-detail-view/)). The lesson: **conditional display beats universal display**.

**Monday's Item Card is the best-documented hierarchy** ([source](https://support.monday.com/hc/en-us/articles/360017143959)):

- Core = **Information widget** pulling board columns; per-widget field order _independent_ of board column order ("order that suits filling in one item at a time")
- **"Show only columns with values"** — empty fields stay hidden until filled (direct answer to wall-of-fields)
- 4 density layouts: fits-to-width / 1 / 2 / 3 fields per row
- New columns land at the _end_ — never disrupt a user's chosen order

**Linear's hierarchy** (from docs + design posts): title + status first (the only required fields), description as markdown body, properties as a compact row of pills, activity/comments below. Their 2026 refresh principle: _"Structure should be felt not seen"_ — fewer borders, rounded edges, softened separators ([refresh post](https://linear.app/now/behind-the-latest-design-refresh)). Also: **edits in the first 3 minutes of issue creation don't hit the activity log** ([creating-issues](https://linear.app/docs/creating-issues)) — a noise-reduction pattern worth copying.

**Above the fold (consensus):** title, status/list, assignee, priority, due date. **Below:** description, checklists/subtasks, attachments, comments/activity. **Never** show all fields — show filled ones (Monday) or a curated set (Jira's 3).

---

## 6. Handling "Too Much Information" in a Detail View

Ranked by observed usage:

1. **Conditional visibility** — Monday's "only columns with values" toggle; Jira's conditional field display. Strongest pattern.
2. **Tabs within the drawer** — Monday item page: Updates / Files / Activity Log / Item Card as sibling tabs, addable via `+`.
3. **Sections with independent order** — Monday widgets each keep their own field order; per-widget settings.
4. **Visual-weight recession** — Linear: dim navigation chrome, shrink icons, remove colored icon backgrounds, reduce separators. "Not every element should carry equal visual weight."
5. **Progressive disclosure on the face → full detail on open** — Jira's "to view all other fields, select a card."

**Accordion vs tabs:** No major tool uses accordions for primary detail content. Tabs (Monday) for _peer_ content types; single scroll with sections (Linear/Trello) for _one_ narrative. Rule of thumb from the evidence: **tabs when content types differ (chat vs files vs activity); sections when it's one document.**

---

## 7. Activity/Timeline Placement

- **Monday:** Activity Log is a **dedicated tab** in the item page, peer to Updates and Files.
- **Linear:** activity is **inline below the description/comments** in the issue drawer (with the 3-minute grace period suppressing creation noise).
- **Trello:** activity is on the card back, below comments.
- **Jira:** issue history is a tab/section in the detail view.

**Consensus:** comments and activity are _adjacent but distinct_; activity is never the default landing content. For Flowdeck's card drawer: comments first (primary), activity as a collapsible "history" section or tab — matching Monday's tab split if the timeline grows.

---

## 8. Chat/Comments Attached to Objects

- **Monday's Updates Section** is the purest "chat-in-card" ([source](https://support.monday.com/hc/en-us/articles/115005900249)): social-media-style thread inside the item; @person and @team mentions with bell notifications; emoji reactions; replies with GIFs/files; **"Seen" eye icon** under each update showing who viewed it (hover for the list); 46,000-char limit per update; checklists embeddable in updates.
- **Notion** ([comments doc](https://www.notion.com/help/comments-mentions-and-reminders)): two levels — top-level page discussions + inline comments. Comments render **to the right of the content by default**; long threads collapse; a **"Minimal" mode** shows only comment icons. A dedicated **comments pane** (💬 top-right, red dot for unread) lists all comments with filters by person and open/resolved; threads sort by most recent reply but **don't re-sort while you have the pane open** ("so you can keep working from your current view").
- **Linear:** comments live in the issue drawer below the description; @mentions subscribe the mentioned user to the issue automatically ([editor doc](https://linear.app/docs/editor)).
- **Figma:** comments are pins on the canvas object; cursor chat is _ephemeral_ (see §9).
- **Height:** (gap — site sunset, 2.0 waitlist only; archived blog index confirms the "chat in tasks" positioning but details weren't retrievable.)

**Placement verdict:** **below the content in the same drawer** (Linear/Monday) for task chat; **side-by-side** only for _inline/anchored_ comments (Notion, Figma) where the comment must point at specific content. Flowdeck's board-level chat as a side panel + card-level comments in the drawer matches this split correctly.

---

## 9. Presence & Realtime

**Figma's published limits** ([how many people](https://help.figma.com/hc/en-us/articles/1500006775761)):

- **200 cursors** shown at once (you always see your own); **200 editors**; **500 total participants**
- Cursor priority: editors first; **anyone being followed is always shown and exempt from the 200 cap**
- When the cap is hit, new joiners are **told their cursor is hidden** — explicit feedback, not silent failure

**Cursor chat** ([send messages with cursor chat](https://help.figma.com/hc/en-us/articles/1500004414842)): `/` to enter; message is **live-typed to others in real time**; displays **5 seconds** after you stop typing; no log kept; Esc/click/tool-switch exits; auto-fades after inactivity.

**Architecture** ([multiplayer post](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)): WebSocket client/server; **one server process per document**; on open, client downloads full copy then syncs deltas; offline edits reapply on reconnect; CRDT-_inspired_ but simplified because the server is the central authority; presence/comments/users sync over a **separate system** from document ops (different perf/security tradeoffs) — a direct endorsement of Flowdeck's split between board ops and chat/presence channels.

**Avatar stacks:** Figma shows collaborator avatars stacked in the toolbar with follow-on-click; overflow beyond ~5 collapses. (The specific help article on avatar stacks was JS-walled — inferred from product behavior, flagged as unverified.)

**Flowdeck:** remote-drag ghosts + hover-slot hints already exist (`BoardColumn` props `remoteDrag`, `remoteDropHint`). Add: avatar stack in board header with "X is viewing" tooltip; a presence cap with explicit notification (Figma pattern) if boards ever get large.

---

## 10. Onboarding & Empty States

- **Trello:** template-first. Create flow offers **"Start with a Template"**; community template gallery at trello.com/templates with overview pages (creator, "About this template", preview, Power-Ups used); **"Create board from template" flow lets you keep or discard the template's cards** ([template gallery](https://support.atlassian.com/trello/docs/community-template-gallery/), [template boards](https://support.atlassian.com/trello/docs/creating-template-boards/)). Historically ships a sample "Welcome Board" with instructional cards.
- **Linear:** **demo workspace before signup** — "explore our demo workspace to see how issues, projects, and workflows fit together" ([start guide](https://linear.app/docs/start-guide)); workspace creation auto-generates one team; "keeping everyone on one team is the simplest approach" ([teams](https://linear.app/docs/teams)); onboarding sessions + video resources by role size.
- **Monday:** views are added per-board ("Add View" dropdown); Cards View walks through cover → columns → details in its doc flow.
- **Jira:** boards start from defaults (Scrum: To Do/In Progress/Done; Kanban: Backlog/Selected for Development/In Progress/Done) — opinionated defaults over blank slates.

**Consensus:** **never blank.** Either sample data (Trello welcome board), a demo space (Linear), or opinionated defaults + templates (Jira/Trello). The "keep or discard template cards" choice is the cleanest pattern: users learn by editing real content, then optionally purge.

---

## Implementation Cheat-Sheet (Solid 2.0 + Tailwind 4)

```css
/* Drag physics — adopt rbd's constants */
:root {
  --ease-out-of-the-way: cubic-bezier(0.2, 0, 0, 1); /* displacement, 200ms */
  --ease-drop: cubic-bezier(0.2, 1, 0.1, 1); /* settle, 330–550ms by distance */
}
.card-shift {
  transition: transform 200ms var(--ease-out-of-the-way);
}
/* drop duration: lerp 330→550ms by px distance traveled */
```

| Decision                   | Number                                                           | Source                   |
| -------------------------- | ---------------------------------------------------------------- | ------------------------ |
| Displacement animation     | 200ms, `cubic-bezier(0.2,0,0,1)`                                 | rbd `animation.js`       |
| Drop animation             | 330–550ms scaled by distance, `cubic-bezier(.2,1,.1,1)`          | rbd `animation.js`       |
| Ghost/placeholder delay    | 100ms                                                            | rbd `animation.js`       |
| Auto-scroll zone           | % of container (not px); exponential ramp; max speed before edge | rbd auto-scrolling guide |
| Custom fields on card face | max 3                                                            | Jira customize-cards     |
| Card-face labels           | color-only default; name toggle                                  | Trello labels            |
| Collapsed list             | name + count; `\` shortcut                                       | Trello collapse          |
| WIP limit                  | min & max per column; count badge in header when enabled         | Jira configure-columns   |
| Detail fields              | hide empty ones ("only columns with values")                     | Monday Item Card         |
| Drawer width               | 384–768px (Flowdeck current = consensus)                         | `src/lib/panel-width.ts` |
| Presence caps              | 200 cursors / 500 participants; notify when hidden               | Figma help               |
| Cursor-chat TTL            | 5s after typing stops                                            | Figma help               |
| Activity-log grace         | 3min after creation, no log entries                              | Linear creating-issues   |
| Board capacity guard       | warn >1,000 cards, hard cap 5,000                                | Trello adding-cards      |
| First-run                  | template with "keep or discard sample cards"                     | Trello templates         |

---

## Gaps & Uncertainties

- **Asana:** all help/guide pages are Cloudflare/JS-walled (`asana.com/guide/...` returns "Loading × Sorry to interrupt"); Zendesk API not exposed. No Asana-specific numbers retrieved.
- **Height:** product appears sunset (height.app shows a 2.0 waitlist; blog archive only has 2022–23 changelog titles). Its "chat in tasks" details are unretrievable; only positioning confirmed via archived blog index.
- **Notion "peek preview":** the help URL 404s and isn't in the current help sitemap; peek behavior described above is inferred from the full-page-vs-inline guide + product knowledge — treat specifics as unverified.
- **Figma avatar-stack article:** JS-walled; stack behavior (overflow count, follow-on-click) is inferred from product use, not a fetched source.
- **Linear drag internals:** Linear publishes no drag-physics post; their feel is consistent with rbd's model (movement-as-indicator, no snap), but exact curves are unverified — rbd's constants are the best-sourced proxy.
- **Monday board columns/WIP:** Monday's kanban column limits doc wasn't among fetched articles; their model is status-column based rather than WIP-limit based.
