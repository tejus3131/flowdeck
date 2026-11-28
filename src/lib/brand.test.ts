// Brand parity — the edge function cannot import `src/` (a separately
// deployed Deno bundle), so its brand strings live in
// supabase/functions/mcp/brand.json. This test pins that file to
// src/lib/brand.ts: a brand change that updates one side and not the
// other fails here instead of shipping a split brand.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { brand } from './brand';

const edgeBrand = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../supabase/functions/mcp/brand.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown>;

describe('brand parity — src/lib/brand.ts ↔ supabase/functions/mcp/brand.json', () => {
  it('carries the same name, shortName and description', () => {
    expect(edgeBrand.name).toBe(brand.name);
    expect(edgeBrand.shortName).toBe(brand.shortName);
    expect(edgeBrand.description).toBe(brand.description);
  });

  it('carries the same tagline, legalName, contact and sender', () => {
    expect(edgeBrand.tagline).toBe(brand.tagline);
    expect(edgeBrand.legalName).toBe(brand.legalName);
    expect(edgeBrand.contactEmail).toBe(brand.contactEmail);
    expect(edgeBrand.senderEmail).toBe(brand.senderEmail);
  });

  it('carries the same themeColor, ogImage and social list', () => {
    expect(edgeBrand.themeColor).toBe(brand.themeColor);
    expect(edgeBrand.ogImage).toBe(brand.ogImage);
    expect(edgeBrand.social).toEqual([...brand.social]);
  });

  it('carries the same base URL (the edge advertises the consent page)', () => {
    expect(edgeBrand.url).toBe(brand.url);
  });
});
