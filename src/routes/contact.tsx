// The contact page — a real reachable contact; every legal page links
// here (docs/research/brand-and-legal.md, the "must have" set).
import { LegalPage, LegalSection } from './legal/shell';
import { brand } from '../lib/brand';

export default function Contact() {
  return (
    <LegalPage
      title={`Contact — ${brand.name}`}
      description={`How to reach ${brand.name}: support, privacy requests, and security reports.`}
      path="/contact"
      updated="November 28, 2026"
    >
      <p>
        {brand.name} is maintained by {brand.legalName}. Email is the fastest way to reach a human.
      </p>

      <LegalSection n="1" title="Support and product questions">
        <p>
          <a
            class="text-indigo-600 underline dark:text-indigo-400"
            href={`mailto:${brand.contactEmail}`}
          >
            {brand.contactEmail}
          </a>{' '}
          — anything about using the app: workspaces, boards, the MCP integration, or a bug you
          found.
        </p>
      </LegalSection>

      <LegalSection n="2" title="Privacy requests">
        <p>
          The same address ({brand.contactEmail}) handles privacy requests — access, correction,
          deletion beyond the self-service flows, or a question about this data. See the{' '}
          <a class="text-indigo-600 underline dark:text-indigo-400" href="/legal/privacy">
            privacy policy
          </a>{' '}
          for what's self-service.
        </p>
      </LegalSection>

      <LegalSection n="3" title="Security reports">
        <p>
          Found a security issue? Email {brand.contactEmail} with details. Please give us a
          reasonable window to fix before public disclosure — we'll credit you if you'd like.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
