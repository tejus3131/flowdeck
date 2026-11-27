# Data playbook — from telemetry to product decisions

How Flowdeck turns what it measures into what it builds. This is the
process layer between the contracts — [`observability.md`](./observability.md)
defines _what_ we capture and the budget rules; this doc defines _why_,
_how we read it_, and _how a number becomes a decision_. Everything here is
grounded in sourced research (frameworks, engineering blogs, the
experimentation literature); the source list is at the bottom, and claims
that are industry folklore rather than verified practice are flagged as
such.

The one-line philosophy, before any framework:

> **Data-informed, not data-driven.** Data is one input — alongside
> judgment, user conversations, and strategy. Below ~100 users,
> conversations outrank funnels. The data's job is to catch us lying to
> ourselves, not to make decisions for us.

## The two layers of measurement

Every event in this repo belongs to one of two layers. They answer
different questions, serve different moods of work, and both live in the
same PostHog stream.

|          | System telemetry                                                         | Product analytics                                       |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| Question | "Is the machine healthy?"                                                | "What do humans do?"                                    |
| Events   | `mutation_echo`, `sync_resync`, `cache_hit`, `fold_applied`, `exception` | `card_created`, `chat_message_sent`, `teammate_invited` |
| Answers  | faster? broken? within budget?                                           | used? ignored? abandoned? loved?                        |
| Consumer | debugging, perf work                                                     | roadmap, redesign, kill decisions                       |

[`observability.md`](./observability.md)'s taxonomy is mostly system
telemetry — deliberately, because the six phases were engineering work.
The redesign's success metric is behavioral, so the behavior layer below
lands with the PostHog foundation PR and rides the same PRs as the UI
work it measures — as its **own commits**. Instrumentation is never
smuggled into a UI commit; each commit still does one thing, and a UI
revert must not have to untangle a tracking change to revert cleanly.

**The pre-redesign baseline.** A before/after claim needs a before. The
PostHog foundation PR lands **before the first redesign PR merges**, then
runs long enough to accumulate a baseline of the North Star and its
input metrics — that frozen window is what every redesign result
compares against. Skipping it means the redesign gets judged by vibes,
which is the failure mode this playbook exists to prevent.

**The baseline, concretely (recorded when the sink landed):** the window
opens when the observability PR reaches **production** and runs until
the first redesign surface ships. The frozen numbers are the
"Pre-redesign baseline" dashboard tiles — `page_open`/`panel_open`
p50/p95 by route/panel (the performance "before"), `mutation_echo` p95
and `sync_resync` by trigger (the "is the architecture holding" before),
and the North Star inputs (`card_created`, `card_completed`,
`chat_message_sent`, `teammate_invited`, `mcp_tool_call`). Preview
traffic is filtered out (`app_environment`); the comparison window for
any redesign claim is the same-length window on production, per route.

**The redesign's rollback metric (the pre-registered kill criteria):**

> We believe that the redesigned surfaces, shipped behind release flags
> with the existing surface as fallback, will result in faster opens and
> more collaborative actions. We'll know it's working if the affected
> routes' `page_open`/`panel_open` p95 holds or drops against the frozen
> baseline and the North Star inputs do not decline. **Kill criteria:**
> roll the flag back to control if, in the two weeks after a surface
> reaches 100%, either (a) the affected route's `page_open` p95 regresses
>
> > 20% vs. baseline, (b) the `exception` rate for the surface doubles
> > vs. its baseline week, or (c) `sync_resync` counts spike >2× without a
> > known fold cause (the canonical test failing in prod). A rollback is a
> > flag flip, not a revert scramble — that is the point of the flag.

No experiment launches with the baseline PR; the policy remains
ship-and-observe with the canary → 100% → holdout ladder below.

That foundation also implements the typed flag runtime and SSR contract in
[`feature-flags-and-ui-playground.md`](./feature-flags-and-ui-playground.md):
the event baseline alone is not sufficient to make the UI rollout reversible.

**The honesty rule.** Telemetry tells us _what_, never _why_ and never
_whether users like it_. "Like" is inferred, never captured:

- **Like** = repetition + return (stickiness per feature, usage growing
  after exposure)
- **Dislike** = abandon, undo, rage-click, never-touch-again-after-exposure
- **Why** = watch the replay, or ask (surveys) — the qualitative layer
  exists because events cannot answer this

## Deriving what to measure: GSM

No event without a goal behind it. The derivation chain (Google's
Goals-Signals-Metrics process, from the HEART paper) is the single best
defense against instrumenting random things:

1. **Goal** — stated in user terms, not implementation terms ("users
   resolve work with their team", not "cards get moved")
2. **Signal** — a behavior in logs or an attitude in surveys that moves
   only when the experience gets better or worse (the paper's own test:
   signals must be _sensitive and specific to the goal_)
3. **Metric** — the dashboard-able form. Prefer **ratios, percentages,
   and per-user averages** over raw counts, which grow with the user base
   and flatter us for free.

The paper's other gift: _"sometimes failure is easier to identify than
success"_ — task abandonment, undo usage, and rage clicks are signals
too, and often the cheapest honest ones.

## The North Star and its inputs

For freemium team-based B2B products (Slack, Coda, Airtable, HubSpot),
the surveyed pattern is an **engagement or customer-growth** North Star —
not revenue, not signups. Flowdeck's:

> **Weekly active users who performed a collaborative action** — created
> or moved a card, sent a chat message, or acted through the MCP server.

Input metrics (the things we can actually move): boards created,
teammates invited, invite acceptance rate. The North Star connects the
language of the user ("we got our work done") to the language of the
product (collaboration events) to the language of the business (teams
that collaborate stay).

## The behavior event taxonomy

Same rules as the system taxonomy: `snake_case`, static names (never
interpolated — `page_viewed` + a property, never `page_viewed_${name}`),
a closed verb allowlist, no PII, ids and counts only. One event per user
action type with a bounded property schema; split into separate events
only when funnel semantics differ.

| Event                                         | Properties                                      | Question                                    |
| --------------------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `user_signed_up`                              | `signup_method` (link/passkey/password)         | which auth methods earn their place         |
| `board_created`                               | `board_id`, `is_from_template`                  | activation                                  |
| `card_created`                                | `board_id`, `has_description`, `has_due_date`   | core loop flowing                           |
| `card_moved`                                  | `board_id`, `list_from`, `list_to`              | is work progressing                         |
| `card_completed`                              | `board_id`, `time_in_list_hours`                | do cards reach Done (task success)          |
| `comment_created` / `chat_message_sent`       | `board_id`, `message_length_bucket`             | collaboration depth per surface             |
| `tag_applied` / `filter_used` / `search_used` | kind, board_id                                  | do organization tools earn their UI         |
| `notification_clicked`                        | kind, `ms_since_created`                        | do notifications drive return visits        |
| `teammate_invited` / `invite_accepted`        | `board_id`, channel, `days_since_invite`        | the multiplayer aha candidates              |
| `composer_abandoned`                          | surface, `typed_length_bucket`                  | friction: typed then closed                 |
| `undo_used`                                   | op kind                                         | regret — a design smell, not a feature stat |
| `pref_changed`                                | pref, value-bucket                              | users voting with their settings            |
| `session_summary`                             | duration bucket, action count, surfaces touched | engagement shape, 1/session                 |

Backend-captured where possible (ad blockers, accuracy); frontend for
interaction journeys where partial data is acceptable. Version events
(`_v2`) instead of mutating meaning — historical comparability is worth
more than a tidy name.

**Provisional until the surfaces exist.** Affordance-dependent events
(`composer_abandoned`, `undo_used`, `pref_changed`) are confirmed,
renamed, or dropped when the redesign fixes what those affordances
actually are. The foundation PR implements the stable core
(`card_created`, `card_completed`, `chat_message_sent`,
`teammate_invited`); the rest follow the redesigned surfaces, one PR
behind them.

## What we deliberately do not track

- **Vanity metrics** — the test (Ries): counts a technical process not
  humans, gross not per-customer, no built-in causality. Total messages
  sent = vanity. Messages per active user per week = real.
- **Anything that becomes a target** — Goodhart's law: when a measure
  becomes a target it ceases to be a good measure. Prefer per-user
  ratios; never celebrate a raw counter.
- **PII in any property** — GDPR treats data as personal when _combined_
  with other data; even innocuous properties accumulate. Ids, counts,
  buckets. The property allowlist is the taxonomy tables; a new property
  needs a line in one.
- **High-frequency UI noise** — per-keystroke, per-hover, per-heartbeat.
  Quota burn and analysis paralysis, no decisions.
- **Blind downsampling** — silently drops funnel-critical events
  (signups, invites). Sample replays, never the event stream.

## Journeys: where users break

The stage model is product-specific (that is the norm for product-led
products); the friction signals at each stage are the standard set.

| #   | Stage             | Definition (event)                 | Friction signals                                           | Feedback touchpoint                                             |
| --- | ----------------- | ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| 0   | Land              | first pageview                     | bounce, dead clicks                                        | none — passive only                                             |
| 1   | Sign up           | `user_signed_up`                   | funnel drop, rage clicks on form                           | none (don't interrupt)                                          |
| 2   | Workspace         | `workspace_created`                | time from signup, drop-off replays                         | —                                                               |
| 3   | First board       | `board_created`                    | time-to-step, wandering paths, dead clicks on empty states | —                                                               |
| 4   | First card        | `card_created`, `card_moved`       | rage clicks on drag targets, thrashing                     | microsurvey after first card (event-triggered, wait-capped)     |
| 5   | Invite sent       | `teammate_invited`                 | drop-off at invite step                                    | —                                                               |
| 6   | Teammate joins ⭐ | `invite_accepted`                  | invite→accept conversion, invitee's first-session replay   | —                                                               |
| 7   | Team active ⭐    | ≥2 distinct users active in 7 days | team-level weekly-active trend                             | —                                                               |
| 8   | Habit             | weekly board+card+chat usage       | retention curves, churn spikes                             | CES-style "how easy was X" after first use of each core feature |
| 9   | PMF               | sustained team retention           | NPS trend (post-PMF only)                                  | PMF survey quarterly; churn survey on cancellation              |

⭐ = the multiplayer "aha" candidates. The famous folklore numbers
(Facebook's "7 friends in 10 days", Slack's "2,000 messages") are
**unverified industry folklore** — the _method_ they illustrate is sound:
correlate an early behavior with retention in _our own_ data, then drive
that behavior. Validate with a retention comparison of teams with
`invite_accepted` vs without before investing in invite UX.

**Drop-off methodology** (the loop for any stage that looks broken):

1. Define the flow as a funnel with the fewest non-optional steps
2. Read per-step conversion + time-to-convert; biggest drop + longest
   time = friction candidate
3. Open paths from that step — what do people do instead
4. Watch replays of users who dropped vs converted (from the funnel
   insight, directly)
5. Fix, or if the flow itself is wrong, change the flow

**Friction signals**: rage clicks (rapid repeated clicks on one element),
dead clicks (clicks with no effect), error clicks. Autocapture catches
dead clicks free; read them as _rates per page/element_ — a spike is the
investigation trigger, not an absolute count.

**Replay budget (5K/mo)**: trigger groups — 100% of sessions hitting
signup/onboarding/invite URLs, 100% of sessions with an exception, 5%
baseline. The discipline warning from PostHog's own data: the median
recording is never opened (99.8%) and median watch time is 17 seconds —
watch _struggling_ sessions surfaced by signals, never browse.

## Feedback without frustration

Surveys are the _why_ layer. The rules that keep them from becoming
noise:

1. **Never ask what analytics already tells you** — usage and drop-off
   come from events; surveys are for intent, opinion, and why
2. **One question by default; branch, don't stack** — conditional
   questions so people only answer what applies to them
3. **Ask at the moment of context, then never again soon** — trigger on
   the event, set the wait period so nobody is interrupted twice
4. **Cap total asks, not just per-survey** — with 1,500 responses/mo the
   standing set is: PMF survey (quarterly) + churn survey
   (event-triggered) + always-on open widget (wait-capped) + NPS
   (quarterly, only after retention stabilizes)
5. **Make negative feedback the cheapest signal** — thumbs up/down
   everywhere interaction is frequent; only a thumbs-down opens a text
   box
6. **Every answer links to evidence** — survey responses are events, so
   each carries the respondent's replay and events; route to Slack so
   they actually get read

**The PMF survey** (Sean Ellis's original methodology): "How would you
feel if you could no longer use Flowdeck?" — target only users who
_experienced the core, used it at least twice, and used it in the last
two weeks_. Over 40% "very disappointed" = must-have signal. Then
Superhuman's engine: build for the very-disappointed (what they'd miss
is the roadmap), and ask the somewhat-disappointed what would hold them
back from the alternative — fixing exactly that converts them.

**Churn feedback is the highest-yield survey we'll run** — ask
immediately on the churn event, with reasons drawn from what we've
actually heard.

## Shipping changes: flags and experiments at our scale

**The number that shapes everything**: a real A/B test needs roughly
N = 16·variance/d² exposures — detecting a 30% relative lift on a 10%
baseline takes ~16,000 exposures. At our scale that is years, and
underpowered tests don't just fail to detect effects — they _manufacture
inflated fake winners_ (the winner's curse). PostHog itself refuses to
analyze below 50 exposures per variant.

So the playbook at our size:

- **Default: ship-and-observe, not A/B.** Ship behind a flag, watch
  guardrails (errors, replays, retention, support pings), not
  significance.
- **Keep a 5–10% holdout for the redesign** — the only causal comparison
  we can afford. Compare _rate metrics_ (tasks completed per user,
  sessions per user) between holdout and everyone else over 4–8 weeks.
  No p-value needed; a stable, directionally-clear gap is decision-grade
  at this scale.
- **If we ever run a true experiment**: sequential testing (peek-safe),
  MDE ≥30% relative, primary metric and duration pre-registered in
  writing, and **randomize at the workspace level, never per-user** —
  splitting teammates across variants contaminates both arms
  (interference; the multiplayer-product A/B trap).
- **Scope rollouts to the surface**: personal preferences may be user-level;
  shared board and collaboration experiences should be consistent per
  workspace. Flag value and audience are distinct from experiment exposure.
- **$0 workspace targeting**: do not enable PostHog Group Analytics. Its
  group-targeted flags require a paid add-on billed across all identified
  events. Instead, send the verified active workspace UUID as a transient
  person-property override and target exact workspace IDs in flag rules
  with 100% rollout. User percentage rollouts still split by person, not
  workspace. If workspace-randomized experiments become necessary, use a
  Flowdeck-owned deterministic workspace assignment and treat analysis as
  custom, not as a native PostHog group experiment. Details and SDK
  requirements:
  [`feature-flags-and-ui-playground.md`](./feature-flags-and-ui-playground.md).
- **Qualitative-first below ~100 users**: five good interviews outrank
  any test we can run. Ask about the _last time_ they did the task, not
  what they want.

**Flag lifecycle** (Fowler's toggle categories + vendor lifetime
tables):

| Type              | Purpose                   | Lifetime                 |
| ----------------- | ------------------------- | ------------------------ |
| Release           | ship incomplete work dark | ~40 days, delete at 100% |
| Experiment        | A/B routing               | 40 days                  |
| Ops / kill switch | emergency off             | permanent                |
| Permission        | beta/premium access       | permanent                |

Rules: the removal task is created _at flag creation_; expiry date and
revert condition go in the flag description; **a flag at 100% is done —
remove or archive it**; wrap flag reads in one function; CI tests both
states; cap the total number of live flags (the Knight Capital failure
is the canonical unmanaged-flag story).

The registry, safe fallbacks, SSR evaluation, quota behavior, and
developer-only playground access are specified in
[`feature-flags-and-ui-playground.md`](./feature-flags-and-ui-playground.md).
In particular, permission flags fail closed and do not replace server
authorization or database RLS.

**The redesign rollout, concretely**: flag it (release type) → canary
~5% for a few days checking errors and replays → 100% → keep a 10%
holdout for a month → interview 5 users → keep an opt-out switch for
early users → delete the old surface one release after the flag reads
100% (per L5 rule 5).

## From data to decisions: the cadence

Three loops, sized for one person (modeled on PostHog's own nested
cadences and the small-team rituals documented by others):

| Cadence       | Time               | What happens                                                                                                                                                                                                                                             |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Weekly**    | 30 min, fixed slot | ONE dashboard, ~5 metrics: activation funnel, weekly active workspaces, cards completed, error/sync health, invites. One question: _"Why aren't we growing faster?"_ One sentence per metric: normal / changed / investigate. Skim 2–3 struggle replays. |
| **Monthly**   | 60–90 min, async   | One spreadsheet, one column per month. Input metrics (things we control) vs output metrics (retention, revenue). Rotate the focus across the quarter: research question → user questions → impact of what shipped.                                       |
| **Quarterly** | half a day         | Keep / kill / improve every active feature area. Set the next goal ladder (10 workspaces → 100 → first $1000 MRR — the thin-data regime: direction and ladder, not dashboards).                                                                          |

**Artifacts:**

- **Hypothesis card** — written _before_ shipping anything nontrivial,
  in the standard format:

  > We believe that [change] for [user group] will result in [outcome].
  > We'll know we're right if [signal + threshold + deadline]. It's worth
  > doing because [reason]. **Kill criteria:** if [signal] is not met by
  > [date], we revert or retire it.

  Kill criteria are mandatory at ship time. The cautionary case:
  37signals removed a homepage signup form and didn't notice **17 months
  of −10% signups** until someone checked the funnel — the cost of
  shipping without a tripwire.

- **Decision log** — ADR format (Title / Context / Decision / Status),
  one entry per build/kill/improve call, supersede never delete. Product
  decisions join [`adr.md`](./adr.md) — the same discipline the
  architecture already uses.

**The decision loop when a number moves:**

> event moves → segment to find _who_ (cohorts) → flag-split to confirm
> _why_ (the only causal tool we have) → replay or survey to understand
> the human reason → fix, revert, or accept.

A usage drop after a change is a _hypothesis_, not a conclusion — usage
moves for reasons that aren't our change (mix shift, seasonality, a bug
elsewhere). Segmentation and the flag split separate correlated from
caused.

**Anti-pattern guards:**

- **No peeking** — decide the observation window when writing the
  hypothesis; don't re-judge mid-window
- **Judge process, not outcomes** — a well-designed comparison that
  kills a pet feature is a win
- **Survivorship bias** — dashboards show retained users; the churned
  ones (the bullet holes) are invisible unless we look for them
- **Analysis depth matched to stakes** — 30 seconds for most questions,
  a deep dive only for existential ones
- **One dashboard, trimmed quarterly** — delete events and tiles nobody
  reads; instrumentation rots exactly like code (clarity, integrity,
  mutability are the three failure modes)

## Why this beats opinion: documented cases

- **37signals** — the signup-form story above: one funnel metric, checked
  rarely but honestly, caught a regression opinions never would; the
  A/B-tested fix recovered +16% signups
- **PostHog** — their "struggle scanner" over session replays surfaced
  users rage-clicking a popover that closed itself; the bug-fix PR landed
  ~80 minutes after the signal
- **Slack** — notification overload was a top-3 driver of support
  tickets; that aggregate pain metric justified the full notifications
  rebuild (which then found four conflicting user mental models)

## Sources

The research behind this doc (all fetched and verified live; folklore
flagged in place):

- **Frameworks**: HEART + GSM (Rodden et al., CHI 2010;
  library.gv.com), AARRR (McClure via PostHog's explainer), North Star
  (Amplitude Playbook; Lenny Rachitsky's a16z survey of 40+ companies),
  One Metric That Matters (Croll & Yoskovitz, leananalyticsbook.com)
- **Taxonomy**: PostHog product-analytics best practices, schema
  management, autocapture docs; Amplitude's event-taxonomy essay;
  Segment's tracking-plan docs; Avo naming conventions
- **What not to track**: Ries on vanity metrics (startuplessonslearned,
  2009); Goodhart's law (Strathern's formulation); PostHog's
  fewer-unwanted-events guide and PII guide
- **Journeys & friction**: PostHog funnels/paths/customer-journeys
  docs; FullStory on rage and dead clicks; Userpilot TTV benchmark;
  Kaushik's See-Think-Do-Care
- **Feedback**: Sean Ellis's original PMF survey posts
  (startup-marketing.com, 2009/2010); Superhuman's PMF engine (First
  Round Review, 2018); PostHog survey docs and templates; survey-fatigue
  research (QuestionPro); NPS criticism (Wikipedia, Reichheld)
- **Experimentation**: Kohavi/Tang/Xu, _Trustworthy Online Controlled
  Experiments_ (experimentguide.com); Kohavi's power-analysis paper
  (arXiv 2512.24521); Microsoft ExP; Airbnb's "4 Principles";
  Booking.com's experimentation culture (HBR, KDD); LinkedIn's
  interference paper (arXiv 2211.03262); Spotify's Bayesian A/B testing
  critique; PostHog's sample-size, sequential-testing, holdout, and
  A/B-mistakes docs
- **Flags**: Fowler/Hodgson, "Feature Toggles" (martinfowler.com);
  trunkbaseddevelopment.com; Unleash's flag-lifetime table;
  LaunchDarkly release/kill-switch docs; PostHog flag best practices
- **Decision process**: PostHog handbook (growth sessions, per-product
  reviews, metrics, small teams); Depot's 30-minute weekly review;
  37signals' analysis-depth and signup-form posts; Shape Up (the
  contrarian absence of metrics language); Des Traynor's
  "data-informed" essay (Intercom, 2011); Barry O'Reilly's
  hypothesis-driven development; Nygard's ADR format; Evan Miller on
  peeking; PostHog's replay-sprawl study

Known folklore, deliberately not cited as fact: Facebook's "7 friends in
10 days", Slack's "2,000 messages", Dropbox's aha metric, numeric
rage-click thresholds, Josh Elman's "only metric that matters".
