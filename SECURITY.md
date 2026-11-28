# Security policy

## Supported versions

Orbit deploys continuously from `main`; there are no versioned
releases. Security fixes apply to the latest `main` only.

| Version | Supported |
| ------- | --------- |
| `main`  | ✅        |

## Reporting a vulnerability

Private vulnerability reporting is enabled on this repository. Use the
**Report a vulnerability** button on the repository's **Security** tab
(https://github.com/tejus3131/flowdeck/security/advisories/new) — it is
private, and I am the only person who will see it.

Please don't open a public issue for anything you believe is a security
problem. Include what you can of: the affected area (app, MCP server,
Supabase layer), steps to reproduce, and expected vs. actual behavior.

I aim to acknowledge reports within 7 days and to fix confirmed issues
as quickly as practical. Note that as a solo maintainer on free-tier
infrastructure, response times depend on my availability.

## Scope notes

- **RLS is the security gate.** Orbit treats Postgres Row Level
  Security as the only authorization boundary (see
  [`docs/architecture.md`](docs/architecture.md) and
  [`docs/adr.md`](docs/adr.md)). Missing client-side checks are not
  vulnerabilities by themselves; a policy that allows a wrong user's
  write or read is.
- Secrets must never be committed. Publishable values (`VITE_*`,
  Supabase URL/anon key) are configuration, not secrets — see
  [`docs/ci-cd.md`](docs/ci-cd.md) for the split.
