# Design playground — resolving the open axes

The experiment layer over the frozen tokens: [`design-system.md`](./design-system.md)
freezes the values; this doc defines the variants that still have two
right answers, and how one gets picked. The developer playground's
foundations are live (`/playground/tokens` renders the P1 gray axis side
by side); the DECIDING happens in real use — each axis still ships behind
a local toggle inside the real surfaces, because gray, accent, and density
decisions are only trustworthy at real density with real data. Deciding
them from a mock page is how taste gets re-derived per PR all over again.

This is the focused token-axis playground, not the complete developer
component/surface catalogue. The full route, access, and variant-comparison
contract lives in
[`feature-flags-and-ui-playground.md`](./feature-flags-and-ui-playground.md).

## The four variants

| Variant | Axis                   | What it renders                                                                              | The question it answers                                                                           |
| ------- | ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **P1**  | Warm vs cool gray      | The same board under both text/surface sets (the two `:root` variants in `design-system.md`) | Which gray reads calmer at our density, in both themes                                            |
| **P2**  | Accent; card elevation | Same board, indigo vs violet accent; `--fd-shadow-1` on vs off                               | Which accent carries selection and focus best; do cards need elevation to separate from the board |
| **P3**  | Spring calibration     | Completion moments (Done-drop, board cleared), deliberately over-sprung                      | Where the line is — how much spring reads as delight before it reads as a toy                     |
| **P4**  | Type density           | Drawer and chat at 13px compact vs 14–16px comfortable                                       | Which body size holds up in a drawer people write in for hours                                    |

## How an axis resolves

1. **Live with the variant in real use.** A screenshot sitting is not
   evidence; a few days of actual boards is. Each axis ships behind a
   local toggle, not a PR-by-PR re-litigation.
2. **Pick by feel, and record the pick**: an amendment line in
   [`adr.md`](./adr.md) (ADR-16) plus the winning value written into
   `design-system.md` — in the same PR that adopts it. The losing value
   stays as a one-token swap.
3. **"Neither wins" is a finding too.** The axis gets a new variant, not
   a quiet default.

## Sequencing

Unresolved axes block the components that consume them — P1 blocks the
text tokens, P2 the accent and shadows, P4 the type scale — but they do
not block structure. Layout, routing, and the store wiring from
[`ui-data.md`](./ui-data.md) proceed regardless, so the playground PR and
the first component PRs can run in parallel until the axes close.
