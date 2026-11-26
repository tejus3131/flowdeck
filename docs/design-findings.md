# Design findings — what we adopt, adapt, skip

The filter over [`research/`](./research/): every finding scored against
Flowdeck's actual product (boards + chat + agents; Solid 2.0 + Tailwind 4;
solo-designed, team-used). Verdicts: **adopt** (do it), **adapt** (do a
Flowdeck-shaped version), **skip** (sounds nice, wrong for us — with the
reason).

## Adopt

| Finding                                                                     | Source                  | Why it fits Flowdeck                                                                                              |
| --------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **100ms feedback / 200-300ms panels / 500ms = drag-feel**                   | NN/g                    | Our sync engine already makes writes instant; motion must not undo that. Budgets become tokens.                   |
| **High-frequency actions get zero motion**                                  | Linear (Rauno)          | Card drags, chip hovers, menu opens happen hundreds of times/day. No entrance animations on them.                 |
| **Enter > exit duration** (300 in / 200 out)                                | NN/g                    | Drawer and popover transitions.                                                                                   |
| **Warm text gray, not cool** (`#37352f`-class)                              | Notion CSS              | Our current `neutral` is cool/blue-ish; warm reads calmer next to an indigo accent.                               |
| **One accent, 60/30/10**                                                    | Notion + Rauno          | Indigo stays the only interactive color; red rationed to errors.                                                  |
| **OKLCH for tints and tag chips**                                           | Stripe                  | Tailwind 4 native; fixes the "yellow looks lighter than blue at same L" problem in tag colors.                    |
| **Drag: movement is the indicator, no snap, no drop shadows**               | rbd design docs         | Our FLIP glide already matches; we adopt their exact curves (200ms displacement, 330-550ms distance-scaled drop). |
| **Auto-scroll: %-based zones, exponential ramp, max speed before the edge** | rbd                     | Replaces our fixed 90px/18px-per-frame.                                                                           |
| **Right drawer + deep-linkable URL**                                        | Linear + Jira consensus | We already have the drawer; add URL sync for the open card.                                                       |
| **Hide empty fields in the detail view**                                    | Monday                  | The single strongest anti-overwhelm pattern; kills the Jira wall-of-fields.                                       |
| **≤3 metadata items on the card face**                                      | Jira's hard cap         | Our face (priority, ≤3 tags, avatars, unseen badge) is at consensus — freeze it.                                  |
| **Comments primary, activity as collapsed history**                         | Linear/Monday           | Matches our drawer; add Linear's 3-minute activity grace.                                                         |
| **Never-blank onboarding; "keep or discard" sample content**                | Trello                  | First board ships with editable sample cards.                                                                     |
| **`prefers-reduced-motion` respected globally**                             | NN/g (vestibular)       | Non-negotiable; one media query.                                                                                  |
| **Three-state theme (light/dark/system), class-based, pre-paint**           | Canva                   | We already match — verified; no work.                                                                             |

## Adapt

| Finding                                                      | The adaptation                                                                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Command palette (Cmd+K)**                                  | Adopt the _feel_ (no entrance animation, rank filter, active-on-hover) but scope v1 to: search cards, jump boards, create card/board, toggle theme. Not a menu replacement — a supplement. |
| **Custom cursors**                                           | Presence only: remote-drag ghosts + (later) live cursors on the board. Never decorative custom pointers; CSS `cursor:` for affordances.                                                    |
| **Spring/overshoot easing**                                  | Budgeted to _completion moments_ only: card → Done, board cleared. `cubic-bezier(.45,1.45,.8,1)`, rare by design.                                                                          |
| **Notion's 708px measure**                                   | For description/comment reading surfaces inside the drawer; the board itself is density-first.                                                                                             |
| **Figma's 200-cursor cap + explicit "you're hidden" notice** | We won't hit it, but the _pattern_ (explicit over silent) applies to presence generally.                                                                                                   |
| **WIP limits with header count badge**                       | Optional per-list, off by default — our boards are small-team; the count badge ships regardless (it's free).                                                                               |
| **Peak-end celebration**                                     | A restrained completion pulse on Done-drops (spring scale + accent flash). No confetti — wrong register for a work tool.                                                                   |

## Skip

| Finding                                  | Why skipped                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Canva's template-gallery onboarding**  | We're a team workspace, not a design tool; one sample board beats a gallery.                                                        |
| **Slash-command block menus**            | Our descriptions are markdown, not block documents; `@`-mentions already cover the inline-insert need. A `/` menu is a later maybe. |
| **Monday's admin-configured card faces** | Config UI is a product in itself; per-user "hide empty" gets 90% of the value.                                                      |
| **Notion peek (hover-preview pages)**    | Our drawer is already the peek; a second preview layer adds motion cost, not value.                                                 |
| **Cursor chat (Figma)**                  | Ephemeral chat fights our durable, searchable board chat. Skip.                                                                     |
| **Asana-style celebrations (unicorn)**   | Register mismatch. Deep delight (speed, flow) before surface delight — NN/g's hierarchy.                                            |

## The three rules everything above folds into

1. **Frequency × novelty:** the more often it happens, the less motion it gets. Celebrate endings, never keystrokes.
2. **Structure felt, not seen** (Linear): fewer borders, dimmer chrome, content carries the weight.
3. **Familiar layout, novel moments** (Arc's lesson): navigation stays boring; delight lives in completions and presence.

## Open questions → answered by the playground, not by more research

- Warm-gray vs cool-gray at _our_ densities (P2 vs P1 settles it by feel)
- Indigo vs violet accent under both themes
- Flat cards (Linear) vs elevated cards (Canva) for a board people stare at all day
- How much spring is too much (P3 is deliberately over-sprung to find the line)
- Drawer density: 13px compact vs 14-16px comfortable
