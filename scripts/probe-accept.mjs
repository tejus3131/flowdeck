// B clicks the invite link (the notification href) and we watch acceptance.
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3001';
const browser = await chromium.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: true,
});
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('response', (res) => {
  const url = res.url().replace(BASE, '');
  if (url.startsWith('/_server') || res.status() >= 400) {
    errors.push(`[${res.status()}] ${res.request().method()} ${url.slice(0, 90)}`);
  }
});
await page.goto(`${BASE}/auth/confirm?token_hash=${process.argv[2]}&type=${process.argv[3]}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
console.log('signed in:', page.url());
// The notification's href: the invite accept page.
await page.goto(`${BASE}/invite/${process.argv[4]}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
console.log('after invite page url:', page.url());
const text = await page.locator('body').innerText();
console.log('---- page text ----');
console.log(text.split('\n').filter(Boolean).slice(0, 14).join('\n'));
console.log('---- server errors ----');
console.log(errors.join('\n') || '(none)');
await browser.close();
