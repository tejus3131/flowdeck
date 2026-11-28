# Legal & Compliance Research — GDPR/CCPA for a Tiny Free SaaS

The full compliance grounding behind the page list in
[`brand-and-legal.md`](./brand-and-legal.md). Sources are official
(ICO, EDPB, CPPA/CA AG, gdpr-info.eu, vendor pages) unless noted.
Nothing here is legal advice.

## Lawful bases (GDPR Art. 6)

- **Account/auth → contract** (Art. 6(1)(b)): account creation,
  authentication, sessions, transactional emails
  ([ICO lawful basis](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/a-guide-to-lawful-basis/legitimate-interests/)).
- **Analytics → legitimate interests** requires the three-part test
  (purpose, necessity, balancing); document a Legitimate Interests
  Assessment and state the interests in the privacy policy
  ([ICO LI guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/a-guide-to-lawful-basis/legitimate-interests/)).
  Portability does not apply under LI; objection to LI marketing is absolute.
- **Product emails:** transactional (invites, security) = contract/LI;
  marketing email/push to individuals needs specific consent under PECR
  reg. 22 — service pushes ("your board changed") do not
  ([ICO electronic mail marketing](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/)).

## Cookies / device storage — the decision that matters most

**EU (ePrivacy Art. 5(3)):** consent required for any storage/access on
the device beyond strictly-necessary — **including localStorage**, not
just cookies (EDPB Guidelines 2/2023,
[edpb.europa.eu](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22023-technical-scope-art-53-eprivacy-directive_en)).

**UK (PECR, post Data (Use and Access) Act 2025):** five exceptions now
exist, including **statistical purposes** (aggregate analytics without
consent, given clear info + a simple means of objecting) and
**appearance** (theme/preference cookies) —
[ICO storage guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/),
[exceptions](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/).
The EU has no statistical exception — consent is still required there.

**Orbit's `fd_theme` cookie:** strictly necessary? No. UK: covered by
the appearance exception (no banner, provide info + objection). EU:
technically needs consent under strict reading (older WP29 04/2012 said
UI-customisation cookies likely exempt — conflicting source; current EU
DPA practice requires consent).

**PostHog specifics:** default persistence is `localStorage+cookie` — a
365-day first-party cookie `ph_<token>_posthog` + localStorage
([persistence docs](https://posthog.com/docs/libraries/js/persistence));
autocapture is on by default and can capture typed form content
([usage docs](https://posthog.com/docs/libraries/js/usage)). Escape
hatches: `cookieless_mode: 'always'` (no storage at all, no banner
needed), `'on_reject'` (consent-gated), or `disable_persistence`
([data-collection docs](https://posthog.com/docs/privacy/data-collection)).

**Decision for the implementation PR:** run PostHog cookieless
(`cookieless_mode: 'always'`, filtered autocapture) and document "no
cookies, no banner needed" Plausible-style
([plausible.io/compliance](https://plausible.io/compliance)); the
auth/session cookie is strictly necessary (no consent needed); the theme
cookie gets an information note + the UK appearance exception. If
consent-gated analytics is ever wanted, `on_reject` + a compliant banner
(no pre-ticks, no scroll-consent, reject as easy as accept — EDPB
Guidelines 05/2020).

## Records of processing (Art. 30) — not exempt

The <250-employee exemption only covers _occasional_ processing. A
continuously-operating SaaS processes account/board/analytics data
constantly — "not occasional" — so **a RoPA is legally required**
([ICO who-needs-to-document](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/documentation/who-needs-to-document-their-processing-activities/)).
A living doc, not a public page.

## Breach notification (Arts. 33–34)

72 hours to the supervisory authority when risk to individuals exists;
individuals without undue delay when high risk; document the decision
either way; record all breaches even non-notifiable; processors
(Supabase/Cloudflare/Resend) must inform "without undue delay"
([ICO breach guide](https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach/personal-data-breaches-a-guide/)).
Practical: a written breach plan + log. PECR breach reporting moved from
24 to 72 hours (DUAA).

## Data-subject rights (Arts. 15–22) — the flows are the obligation

One month to respond (extendable +2 for complex)
([ICO SAR guide](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access/)).
Minimum tooling:

1. **Export account data** (access + portability; JSON/CSV — ICO names
   CSV/XML/JSON explicitly
   ([portability](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-data-portability/))).
2. **Delete account** cascading to boards/data, with an honest
   backup-retention statement — erasure extends to backups
   ([ICO erasure](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)).
3. A published privacy@ contact for the remaining rights.

Precedents: Plausible's self-serve Settings → Danger zone deletion;
Cal.com's "self-serve or by email… deleting means deleted, including at
our subprocessors"; GitHub's confirm-then-delete flow.

## EU–US transfers — vendor status (verified from their pages)

- **DPF survived its first challenge** (_Latombe_, General Court,
  3 Sept 2025 — appeal status unverified)
  ([CJEU press release](https://curia.europa.eu/jcms/upload/docs/application/pdf/2025-09/cp250106en.pdf)).
- **Cloudflare:** DPF certified (EU-US, UK Extension, Swiss), SCCs as
  fallback ([cloudflare.com/privacypolicy](https://www.cloudflare.com/privacypolicy/)).
- **PostHog:** DPF certified (all three); EU hosting available
  ([posthog.com/privacy](https://posthog.com/privacy)).
- **Resend:** DPF certified per DPA §11.1; SCCs (Modules 1–3) + UK
  Addendum ([resend.com/legal/dpa](https://resend.com/legal/dpa)).
- **Supabase: relies on SCCs, not DPF** — their EEA/UK/Switzerland
  disclosures cite SCCs for US/Singapore transfers; verify at
  [dataprivacyframework.gov](https://www.dataprivacyframework.gov/)
  ([supabase.com/privacy](https://supabase.com/privacy)).

The subprocessor page states each vendor's mechanism.

## Minors

No age gate needed for a productivity tool not directed at children
(COPPA 16 CFR §312.2 "directed to children" test); best practice: state
a minimum age (13/16) in ToS and close accounts discovered below it
(Supabase does exactly this). UK Children's Code: document that the
service is unlikely to be accessed by children.

## CCPA/CPRA — likely does not apply

A tiny free SaaS fails all three thresholds ($25M revenue — CPI-adjusted
to $26,625,000 from Jan 2025; 100k+ CA residents; 50%+ revenue from
selling data)
([oag.ca.gov/privacy/ccpa](https://oag.ca.gov/privacy/ccpa),
[CPPA CPI adjustment](https://cppa.ca.gov/regulations/cpi_adjustment.html)).
First-party analytics is a business purpose, not "sharing" (sharing =
cross-context behavioral advertising) — no "Do Not Sell" link needed.
Follow the notice-at-collection pattern anyway (best practice + future
proofing).

## Privacy policy hosting

Publicly accessible URL, linked **pre-signup** (at the registration
form) and at collection points; concise, plain language; purposes,
lawful bases (name the legitimate interests), recipients, transfers,
retention, rights, complaint right
([ICO right to be informed](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-be-informed/)).

## Page verdicts (consolidated matrix)

| Page                | Verdict               | Rationale                                                                                                          |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Privacy policy      | **MUST**              | GDPR Art. 13 / CCPA notice-at-collection                                                                           |
| Terms of service    | **MUST**              | Contract for an account service; fold AUP in (Plausible/Cal.com pattern)                                           |
| Export/delete flows | **MUST**              | Arts. 17/20; in-app self-serve, one-month deadline                                                                 |
| Cookie banner       | **MUST (a decision)** | Avoid entirely via PostHog cookieless mode                                                                         |
| security.txt        | **MUST (trivial)**    | RFC 9116: `Contact:` + `Expires:` at `/.well-known/security.txt`                                                   |
| DPA                 | **SHOULD → MUST**     | Publish self-serve click-through when org workspaces exist (Plausible: "in place automatically for all customers") |
| Subprocessors       | **SHOULD**            | Umami-style table (name, purpose, location) inside privacy policy                                                  |
| Security page       | **SHOULD**            | Documents Art. 32 measures                                                                                         |
| Status page         | **NICE**              | Instatus/BetterStack free tier; supports breach-readiness credibility                                              |
| Changelog           | **NICE**              | Supports the "communicate changes" transparency duty                                                               |
| Impressum           | **NICE (skip)**       | DACH-only (DDG §5); not required for a US product                                                                  |

## Real product page structures (the patterns to copy)

- **Plausible** ([privacy](https://plausible.io/privacy),
  [terms](https://plausible.io/terms), [dpa](https://plausible.io/dpa)):
  TL;DR → controller identity → visitor-vs-account data split → legal
  bases → subprocessors in-policy → SCCs → retention → rights. No cookie
  banner (cookieless by design). Plain-language single-page ToS; DPA is
  an automatic click-through addendum.
- **Cal.com** ([privacy](https://cal.com/privacy),
  [terms](https://cal.com/terms)): short version + full version;
  controller-vs-processor table; retention table; version archive;
  AUP as ToS §4.3; free plans fully covered ("across accounts and
  plans").
- **Umami** ([privacy](https://umami.is/privacy),
  [subprocessors](https://umami.is/subprocessors)): summary-first policy;
  simple subprocessor table with last-updated date.
- **Fathom** ([legal/*](https://usefathom.com/legal/privacy)):
  purpose/lawful-basis/retention per scenario; sign-and-return DPA.

**Gaps/uncertainties:** _Latombe_ appeal status unverified; Supabase DPF
absence inferred from their disclosures (participant list not
programmatically queryable); CPPA's proposed 100k-threshold change shows
no evidence of finalization; CA AADC remains enjoined as last verified;
EU-vs-UK theme-cookie conflict (WP29 04/2012 vs current strict EU
practice) — the UK appearance exception resolves it for the UK only.
