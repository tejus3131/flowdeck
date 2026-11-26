// Two-user chat-level probe: A posts to a board; we inspect B's
// notification rows after each post. Usage:
//   node scripts/probe-drive.mjs <A_token> chat-post <linkType>
// Env: PROBE_BOARD_ID, PROBE_MSG (message text; may contain raw mention markdown)
import { chromium } from 'playwright-core';

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const BASE = process.env.PROBE_BASE ?? 'http://localhost:3001';
const tokenHash = process.argv[2];
const scenario = process.argv[3];
const linkType = process.argv[4] ?? 'magiclink';
const boardId = process.env.PROBE_BOARD_ID ?? '';
const msg = process.env.PROBE_MSG ?? 'hello from the probe';

const browser = await chromium.launch({ executablePath: BRAVE, headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('response', (res) => {
  if (res.status() >= 400)
    errors.push(
      `[${res.status()}] ${res.request().method()} ${res.url().replace(BASE, '').slice(0, 90)}`,
    );
});

await page.goto(`${BASE}/auth/confirm?token_hash=${tokenHash}&type=${linkType}`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(1500);
console.log('signed in:', page.url());

if (scenario === 'chat-post') {
  // ?chat=1 opens the board's chat panel directly.
  await page.goto(`${BASE}/b/${boardId}?chat=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/probe-board-chat.png' });
  // The chat composer is the contenteditable in the side panel.
  const composer = page.locator('[contenteditable]').last();
  const count = await composer.count();
  console.log('contenteditable count:', count);
  if (count) {
    await composer.click();
    await composer.fill(msg);
    await composer.press('Enter');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: '/tmp/probe-board-sent.png' });
    const body = await page.locator('body').innerText();
    const lines = body.split('\n').filter((l) => l.includes(msg.slice(0, 20)));
    console.log('message visible in chat:', lines.length > 0 ? 'YES' : 'NO');
  } else {
    console.log('NO composer found; page text:');
    console.log((await page.locator('body').innerText()).slice(0, 600));
  }
}

console.log('---- http errors ----');
for (const e of errors) console.log(e);
await browser.close();
