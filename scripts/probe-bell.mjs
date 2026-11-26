// Sign in as B and open the notification bell — the invite must be there.
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3001';
const browser = await chromium.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: true,
});
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/auth/confirm?token_hash=${process.argv[2]}&type=${process.argv[3]}`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(1500);
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
// The bell button (🔔) in the header.
const bell = page.getByRole('button', { name: /notification|bell|🔔/i }).first();
if (await bell.count()) {
  await bell.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/tmp/probe-bell.png' });
  const text = await page.locator('body').innerText();
  const lines = text
    .split('\n')
    .filter((l) => /invited you|Invite|Workspace|mark as read/i.test(l))
    .slice(0, 8);
  console.log('---- bell panel ----');
  console.log(lines.join('\n') || '(no invite lines found)');

  // The invite row's Accept button — the panel-side acceptance path.
  const acceptBtn = page.getByRole('button', { name: /^accept$/i }).first();
  if (await acceptBtn.count()) {
    await acceptBtn.click();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: '/tmp/probe-bell-accepted.png' });
    const after = await page.locator('body').innerText();
    const interesting = after
      .split('\n')
      .filter((l) => /Accepted|Declined|error|invalid|Probe Test/i.test(l))
      .slice(0, 8);
    console.log('---- after Accept ----');
    console.log(interesting.join('\n') || '(nothing matched)');
  } else {
    console.log('NO Accept button in the bell');
  }
} else {
  console.log('no bell button found');
}
await browser.close();
