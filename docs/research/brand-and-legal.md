# Brand, Rebrand & Legal Research — Flowdeck → Orbit

Deep research grounding for the rebrand: the single-source-of-truth brand
config, the rename practice, and the legal/compliance page set a small SaaS
ships. Companion docs: [`seo.md`](./seo.md), [`pwa-and-offline.md`](./pwa-and-offline.md).
Research + contract, not an implementation claim.

**Repo baseline (verified):** `VITE_APP_NAME` exists in `env.ts` (default
`Flowdeck`) but is consumed once (`App.tsx`); ~36 hardcoded "Flowdeck"
strings live across routes, invite emails (`workspaces.ts`), the MCP server
text (`supabase/functions/mcp/index.ts`), the SW notification title, and
the manifest. `RESEND_FROM` defaults to a Flowdeck sender.

## Single source of truth — the brand config

**The pattern:** one typed module (e.g. `src/lib/brand.ts`) holds every
brand fact; everything else derives from it. The comparable open-source
products centralize exactly this way — Cal.com's privacy policy is
generated from the same config that drives their Trust Center subprocessor
table ([cal.com/privacy](https://cal.com/privacy)); Plausible's policy
derives its controller identity and contact from one place
([plausible.io/privacy](https://plausible.io/privacy)).

**Recommended schema (fields, with current values):**

| Field                                             | Value today                                                   | Notes                                           |
| ------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| `name`                                            | Flowdeck → Orbit                                              | from `VITE_APP_NAME` override, constant default |
| `shortName`                                       | Flowdeck → Orbit                                              | manifest `short_name`; ≤ 12 chars               |
| `tagline`                                         | "Realtime kanban boards for you, your team — and your agents" | landing `<h1>` area, OG description             |
| `description`                                     | "A realtime kanban board your team can work on together"      | manifest, meta description seed                 |
| `legalName`                                       | the maintainer's legal identity                               | privacy policy "data controller"                |
| `contactEmail` / `privacyEmail` / `securityEmail` | to decide                                                     | policy contact + `security.txt`                 |
| `url`                                             | `VITE_APP_URL` (prod: flowdeck.tejusgupta.dev)                | canonical/OG base                               |
| `themeColor`                                      | `#4f46e5`                                                     | manifest + `<meta name="theme-color">`          |
| `ogImage`                                         | to create (1200×630)                                          | OG/Twitter card                                 |
| `social` / `sameAs`                               | to decide                                                     | Organization JSON-LD                            |
| `senderEmail`                                     | `RESEND_FROM` default                                         | invite emails                                   |

**Consumers to migrate (the ~36 strings):** every `<Title>`, landing and
sign-in headings, invite emails (server-side — needs a server-readable
constant, not just `VITE_`), MCP server description + consent page, SW
notification title, manifest (generate or CI-substitute), OG/meta tags.

**Rule for the codebase:** no literal brand name in components — a
grep guard like the hardcoded-color check in pr-prep.

**What NOT to rename (decide explicitly):** internal identifiers — the
`fd_` CSS token prefix, `flowdeck_workspace_id` PostHog property, cache
names (`flowdeck-images-v1`), env var names, DB/schema identifiers.
Renaming those is churn with zero user value and breaks PostHog
continuity. Brand rename ≠ identifier rename.

## Rebrand practice

Advisory (no official standard governs renames; agency guidance is
consensus, not law):

1. **Clearance before anything ships:** trademark search (USPTO TESS /
   EUIPO for EU exposure), domain availability, social/handle availability.
   "Orbit" is a common word — check for existing software marks
   specifically (the USPTO search was started during this research; the
   maintainer should complete and record the result).
2. **Migration plan for existing users:** in-product announcement, keep
   the old email sender working during transition, 301s if URLs change
   (see [`seo.md`](./seo.md) §migration for the same-domain vs new-domain
   split — same domain means no site move at all).
3. **Dual-name transition period** where invites/notifications say the new
   name but old links keep working.

## Legal pages — the standard set

**Must have (launch blockers for a public rebrand):**

1. **Privacy Policy** — what data, why (lawful basis per GDPR), retention,
   third parties, user rights, controller identity + contact. Must be
   publicly accessible **before signup**. Structure precedent:
   [Plausible](https://plausible.io/privacy) (controller identity, two
   data types, legal bases table, "never sold"), [Cal.com](https://cal.com/privacy)
   (10-line TL;DR, controller-vs-processor table, subprocessor notice
   promise), [Umami](https://umami.is/privacy) (summary-first, DPA link).
2. **Terms of Service** — account, acceptable use, liability, termination,
   governing law.
3. **Contact** — a real reachable contact; every other page links to it.

**Should have (SaaS standard):**

4. **Subprocessors list** — public table naming each subprocessor
   (Supabase, Cloudflare, PostHog, Resend), purpose, location; Cal.com
   promises prior written notice of changes — a good pattern even solo.
5. **DPA** — required when business customers process EU personal data
   through the product (GDPR Art. 28); click-through pattern is standard
   (Plausible: [plausible.io/dpa](https://plausible.io/dpa), Umami:
   [umami.is/dpa](https://umami.is/dpa)).
6. **Security page + `/.well-known/security.txt`** — RFC 9116 defines the
   machine-parsable disclosure format: `Contact:` field required, plus
   `Expires`, `Encryption`, `Policy` fields
   ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116.html)).
7. **Cookie/consent notice** — required only if non-essential cookies are
   set (EU ePrivacy). PostHog sets no cookies by default in cookieless
   mode; if the app itself sets only auth/session cookies, a notice
   section inside the privacy policy may suffice — decide when the
   PostHog foundation lands.
8. **Changelog** — trust signal; release records already exist in
   `docs/ci-cd.md`.

**Nice to have:** status page, pricing (if ever paid), docs index
(`/docs/mcp` is the seed).

## GDPR/CCPA obligations that actually bind a tiny free SaaS

GDPR (official guidance hub: [ICO UK GDPR](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/);
EU entry point: [commission.europa.eu data-protection](https://commission.europa.eu/law/law-topic/data-protection_en)):

- **Lawful basis** per processing purpose (contract for the service,
  legitimate interest for security/abuse prevention).
- **Data-subject rights:** access, erasure, portability — this needs an
  account-delete/export flow (the only code-heavy legal item).
- **Processor contracts:** Supabase/Cloudflare/PostHog/Resend each carry
  their own DPA terms — link them from the subprocessor page.
- **Breach notification:** 72h to the supervisory authority when risk to
  individuals exists.
- **EU-US transfers:** rely on each subprocessor's DPF/SCC coverage;
  document on the subprocessor page.
- **Records of processing:** a living doc, not a public page.

CCPA/CPRA (official: [oag.ca.gov/privacy/ccpa](https://oag.ca.gov/privacy/ccpa),
[cppa.ca.gov](https://cppa.ca.gov/)): notice at collection, right to
know/delete/opt-out of sale-share, non-discrimination — applies above
revenue/data-volume thresholds; a free product with no data sales mostly
needs the notice + delete path.

## Page inventory (the deliverable list)

| Page                     | Priority         | Route (proposed)                          |
| ------------------------ | ---------------- | ----------------------------------------- |
| Landing (new, SEO-ready) | P0               | `/`                                       |
| Privacy policy           | P0               | `/legal/privacy`                          |
| Terms of service         | P0               | `/legal/terms`                            |
| Contact                  | P0               | `/contact` (or a section)                 |
| Subprocessors            | P1               | `/legal/subprocessors`                    |
| DPA                      | P1               | `/legal/dpa`                              |
| Security + security.txt  | P1               | `/security` + `/.well-known/security.txt` |
| Cookie notice            | P1 (conditional) | section in privacy                        |
| Changelog                | P2               | `/changelog`                              |

All public pages get the SEO treatment from [`seo.md`](./seo.md) (title,
description, canonical, OG, sitemap entry); legal routes are static,
crawlable, and indexed.

**Gaps/uncertainties:** the USPTO trademark search for "Orbit" was started
but not completed — the maintainer must finish and record the result
before the name is committed anywhere. Cal.com's subprocessor page moved
into their Trust Center (404 at the old path). Umami's legal pages live
at `/privacy` and `/dpa`, not `/legal/*`. Nothing here is legal advice;
the page contents need a real review pass before launch.
