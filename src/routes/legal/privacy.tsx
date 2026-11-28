// The privacy policy — GDPR Art. 13's information duty, structured as
// the research doc prescribes (docs/research/legal-compliance.md):
// identity, purposes with lawful bases, recipients, transfers, retention,
// rights, complaint right. Linked at signup. NOT legal advice — the
// maintainer reviews the text before it ships.
import { LegalPage, LegalSection } from './shell';
import { brand } from '../../lib/brand';

export default function PrivacyPolicy() {
  return (
    <LegalPage
      title={`Privacy Policy — ${brand.name}`}
      description={`How ${brand.name} handles your personal data: what we collect, why, the lawful bases, who receives it, how long we keep it, and your rights.`}
      path="/legal/privacy"
      updated="November 28, 2026"
    >
      <p>
        This policy explains what personal data {brand.name} ({brand.legalName}, the data
        controller) collects when you use {brand.name}, why we process it, and the rights you have.
        Plain language first: we collect the minimum needed to run a kanban board service, we never
        sell data, and analytics are cookieless.
      </p>

      <LegalSection n="1" title="Who we are">
        <p>
          The controller is {brand.legalName}. Contact:{' '}
          <a
            class="text-indigo-600 underline dark:text-indigo-400"
            href={`mailto:${brand.contactEmail}`}
          >
            {brand.contactEmail}
          </a>
          . For privacy-specific requests, use the same address — it reaches the maintainer
          directly.
        </p>
      </LegalSection>

      <LegalSection n="2" title="What we collect and why">
        <p>The data falls into two groups:</p>
        <p>
          <strong>Account data</strong> — your email address, display name, optional avatar, theme
          and status preferences, and the workspaces/boards/cards you create. Purpose: providing the
          service you signed up for. Lawful basis: <em>performance of a contract</em> (GDPR Art.
          6(1)(b)) — the account is the service.
        </p>
        <p>
          <strong>Product analytics</strong> — cookieless, aggregated usage events (page opens,
          feature usage, error rates) processed by PostHog Cloud (US region) through a first-party
          proxy. No cookies are set for analytics, no cross-site tracking, no advertising. Purpose:
          understanding which features are used so development effort goes where use is. Lawful
          basis: <em>legitimate interest</em> (Art. 6(1)(f)) — improving the product you use; the
          balancing test (LIA) concluded because the data is aggregated, cookieless, and never used
          to profile individuals.
        </p>
        <p>
          <strong>Service security</strong> — IP addresses and request logs processed by our
          infrastructure providers to rate-limit abuse and detect incidents. Lawful basis:{' '}
          <em>legitimate interest</em> in keeping the service available and secure.
        </p>
      </LegalSection>

      <LegalSection n="3" title="Who receives your data (subprocessors)">
        <p>We use a small set of processors, each bound by a data-processing agreement:</p>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            <strong>Supabase</strong> (database, authentication, file storage) — stores account and
            content data.
          </li>
          <li>
            <strong>Cloudflare</strong> (hosting, CDN, DDoS protection) — serves the application.
          </li>
          <li>
            <strong>PostHog Cloud US</strong> (product analytics, cookieless) — receives aggregated
            usage events.
          </li>
          <li>
            <strong>Resend</strong> (transactional email) — sends invite and sign-in emails when you
            request them.
          </li>
        </ul>
        <p>
          The current list with each vendor's transfer mechanism lives on the subprocessors page
          (linked below when published).
        </p>
      </LegalSection>

      <LegalSection n="4" title="International transfers">
        <p>
          The service is hosted in the United States. Where personal data leaves the EEA/UK:
          Cloudflare, PostHog, and Resend are certified under the EU–US Data Privacy Framework;
          Supabase relies on Standard Contractual Clauses. You can request the current transfer
          documentation for any vendor at {brand.contactEmail}.
        </p>
      </LegalSection>

      <LegalSection n="5" title="How long we keep data">
        <p>
          Account and content data are kept while your account exists. When you delete your account,
          the account row and everything it owns (profile, memberships, boards, cards, chats) are
          deleted immediately; residual copies in encrypted database backups age out within 30 days,
          and erasure requests extend to those backups on the same schedule. Request logs are kept
          at most 30 days.
        </p>
      </LegalSection>

      <LegalSection n="6" title="Your rights">
        <p>
          You have the rights GDPR grants: access, rectification, erasure, restriction, portability,
          and objection. Two are self-service:
        </p>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            <strong>Export</strong> — Profile → "Export my data" downloads a machine-readable copy
            of your account and the content you can access (JSON/CSV) — your profile, your
            memberships, and the boards, lists and cards visible to you under your workspaces'
            permissions.
          </li>
          <li>
            <strong>Erasure</strong> — Profile → "Delete account" removes the account and its
            content immediately (see the retention note above for backups).
          </li>
        </ul>
        <p>
          For everything else — or if the self-service flows don't cover your case — email{' '}
          <a
            class="text-indigo-600 underline dark:text-indigo-400"
            href={`mailto:${brand.contactEmail}`}
          >
            {brand.contactEmail}
          </a>
          . We answer within one month.
        </p>
      </LegalSection>

      <LegalSection n="7" title="Complaints">
        <p>
          You have the right to lodge a complaint with your local data-protection authority. In the
          EU, find yours at{' '}
          <a
            class="text-indigo-600 underline dark:text-indigo-400"
            href="https://edpb.europa.eu/about-edpb/about-edpb/members_en"
            rel="noreferrer"
            target="_blank"
          >
            edpb.europa.eu
          </a>
          ; in the UK, the ICO (ico.org.uk). We'd appreciate hearing from you first — we fix things.
        </p>
      </LegalSection>

      <LegalSection n="8" title="Cookies">
        <p>
          {brand.name} sets only strictly necessary cookies: your sign-in session (Supabase auth),
          your workspace choice, and your theme preference. No analytics or advertising cookies —
          PostHog runs in cookieless mode, so there is no consent banner to click.
        </p>
      </LegalSection>

      <LegalSection n="9" title="Changes">
        <p>
          Material changes to this policy are announced in the app before they take effect. The
          effective date above always reflects the current version.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
