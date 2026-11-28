// The terms of service — the standard SaaS set with the acceptable-use
// policy folded in (docs/research/legal-compliance.md). NOT legal advice
// — the maintainer reviews the text before it ships.
import { LegalPage, LegalSection } from './shell';
import { brand } from '../../lib/brand';

export default function Terms() {
  return (
    <LegalPage
      title={`Terms of Service — ${brand.name}`}
      description={`The terms governing your use of ${brand.name}: accounts, acceptable use, content ownership, liability, and termination.`}
      path="/legal/terms"
      updated="November 28, 2026"
    >
      <p>
        These terms govern your use of {brand.name}, a realtime kanban board service operated by{' '}
        {brand.legalName}. By creating an account you accept them.
      </p>

      <LegalSection n="1" title="Acceptance and eligibility">
        <p>
          You must be able to form a binding contract (generally 16+; older where your local law
          requires). If you use {brand.name} for an organization, you confirm you may bind it to
          these terms.
        </p>
      </LegalSection>

      <LegalSection n="2" title="Accounts and security">
        <p>
          Sign-in is passwordless (passkeys or one-time email links). You're responsible for the
          devices that hold your passkeys and for the content of your workspaces. Tell us
          immediately at {brand.contactEmail} if you believe an account was compromised.
        </p>
      </LegalSection>

      <LegalSection n="3" title="The service">
        <p>
          {brand.name} is provided free of charge, as is, with no uptime guarantee. Features change;
          we aim to announce breaking changes in the app before they land. We may discontinue the
          service; if so, we'll give reasonable notice and a window to export your data.
        </p>
      </LegalSection>

      <LegalSection n="4" title="Your content">
        <p>
          You own your boards, cards, comments, and messages. By using the service you grant{' '}
          {brand.name} the limited license needed to store, display, and synchronize that content to
          the collaborators you invite — nothing more. We never use your content to train models or
          for advertising.
        </p>
      </LegalSection>

      <LegalSection n="5" title="Acceptable use">
        <p>You agree not to:</p>
        <ul class="list-disc space-y-1 pl-5">
          <li>use the service for unlawful content or to infringe others' rights;</li>
          <li>harass, threaten, or dox other users;</li>
          <li>upload malware or attempt to breach the service's security;</li>
          <li>
            scrape or access the service other than through the app and the documented MCP API with
            your own credentials;
          </li>
          <li>resell or commercialize access to the service without written permission;</li>
          <li>abuse rate limits or attempt to disrupt other users' use of the service.</li>
        </ul>
        <p>
          We may suspend accounts that violate this section — with notice when possible, without it
          where the law or the safety of others requires.
        </p>
      </LegalSection>

      <LegalSection n="6" title="Disclaimers">
        <p>
          THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS
          OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
          NON-INFRINGEMENT. We do not warrant the service will be uninterrupted or error-free.
        </p>
      </LegalSection>

      <LegalSection n="7" title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, {brand.legalName}'s total liability arising out of
          or relating to the service is limited to the greater of the amounts you paid us in the 12
          months before the claim (currently zero — the service is free) or USD 100. We are not
          liable for indirect, incidental, special, consequential, or punitive damages, or for lost
          profits, data, or goodwill. Nothing here limits liability that cannot be limited by law
          (e.g. for gross negligence or willful misconduct).
        </p>
      </LegalSection>

      <LegalSection n="8" title="Termination and your data">
        <p>
          You can delete your account at any time (Profile → Delete account); deletion removes your
          account and its content immediately, subject to the backup retention described in the
          privacy policy. We may suspend or terminate accounts for acceptable-use violations. On
          termination, your right to use the service ends; the privacy policy governs what data we
          retain and for how long.
        </p>
      </LegalSection>

      <LegalSection n="9" title="Changes to these terms">
        <p>
          We may update these terms; material changes are announced in the app before they take
          effect. Continuing to use the service after the effective date means you accept the
          updated terms.
        </p>
      </LegalSection>

      <LegalSection n="10" title="Governing law">
        <p>
          These terms are governed by the laws of the Republic of India, without regard to its
          conflict-of-law rules. Nothing here deprives consumers of the protections of their local
          mandatory law.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
