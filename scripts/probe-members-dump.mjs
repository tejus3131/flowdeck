// Dump the members page DOM + a screenshot after navigating, signed in.
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3001';
const browser = await chromium.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: true,
});
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/auth/confirm?token_hash=${process.argv[2]}&type=${process.argv[3]}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.goto(`${BASE}/w/${process.env.PROBE_WS_ID}/members`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/probe-members-fresh.png' });
const text = await page.locator('body').innerText();
console.log(text.slice(0, 2200));
const dialogCount = await page.locator('dialog, [role="dialog"], .fixed.inset-0').count();
console.log('---- overlay/dialog count:', dialogCount);
const emailInputs = await page.locator('input[type="email"], input[placeholder*="company" i]').count();
console.log('---- email-ish inputs:', emailInputs);

// Drive the inline invite form: fill B's email, submit, read feedback.
const existingEmail = process.env.PROBE_EXISTING_EMAIL ?? '';
if (existingEmail) {
  page.on('response', (res) => {
    if (res.request().method() === 'POST') console.log(`[traffic ${res.status()}] ${res.url().replace(BASE, '').slice(0, 80)}`);
  });
  await page.locator('input[type="email"]').first().fill(existingEmail);
  await page.getByRole('button', { name: /^invite$/i }).click();
  await page.waitForTimeout(3000);
  const text = await page.locator('body').innerText();
  const lines = text.split('\n').filter((l) => /invit|link|error|already|Only addresses|✓|copy/i.test(l)).slice(0, 8);
  console.log('---- invite feedback ----');
  console.log(lines.join('\n'));
  await page.screenshot({ path: '/tmp/probe-invite-after.png' });
}
await browser.close();
