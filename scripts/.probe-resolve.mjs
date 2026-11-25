import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const BASE = 'http://localhost:3000';
const jar = readFileSync('/tmp/fd-cookies.txt', 'utf8');
const cookies = [];
for (const line of jar.split('\n')) {
  if (!line || line.startsWith('#') || line.split('\t').length < 7) continue;
  const p = line.split('\t');
  cookies.push({ name: p[5], value: p[6], url: `${BASE}/` });
}
const browser = await chromium.launch({ executablePath: BRAVE, headless: true });
const ctx = await browser.newContext();
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);
await page.goto(`${BASE}/b/3f28d5e1-2095-4f4c-9cf3-c257887d51f7`, { waitUntil: 'domcontentloaded' });
await wait(3000);

// Resolve via the drawer first (state-aware: only if visible on board).
let body = await page.locator('body').innerText();
if (body.includes('Probe card')) {
  await page.getByText('Probe card', { exact: true }).first().click();
  await wait(1800);
  await page.getByRole('button', { name: /resolve/i }).first().click();
  await wait(2200);
  await page.keyboard.press('Escape');
  await wait(1200);
  body = await page.locator('body').innerText();
  console.log('card hidden from board:', !body.includes('Probe card') ? 'YES' : 'NO');
}

// Board settings panel — by its title.
await page.locator('button[title^="Board settings"]').first().click();
await wait(2200);
await page.screenshot({ path: '/tmp/resolve-6-panel.png' });
body = await page.locator('body').innerText();
console.log('headings:', body.split('\n').filter((l) => /RESOLVED CARDS|DANGER ZONE|DETAILS|MEMBERS/i.test(l)).join(' | '));
const rows = body.match(/Resolved cards[^\n]*/);
console.log('resolved heading:', rows ? rows[0] : 'MISSING');
