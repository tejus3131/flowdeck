// Board-page smoke test: renders, board chat (with the new context),
// @all composer, card creation → drawer → Settings → Activity timeline.
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3001';
const browser = await chromium.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: true,
});
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || t.includes('timeline-debug'))
    errors.push('[console] ' + t.slice(0, 250));
});
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('response', (res) => {
  if (res.status() >= 400)
    errors.push(
      `[${res.status()}] ${res.request().method()} ${res.url().replace(BASE, '').slice(0, 80)}`,
    );
});

await page.goto(`${BASE}/auth/confirm?token_hash=${process.argv[2]}&type=${process.argv[3]}`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(1500);

const boardId = process.env.PROBE_BOARD_ID;
await page.goto(`${BASE}/b/${boardId}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
let text = await page.locator('body').innerText();
console.log(
  'board renders:',
  /To do|In progress|Done/.test(text) ? 'YES' : 'NO —\n' + text.slice(0, 300),
);

// Dismiss the one-time push prompt when it shows (fresh browser context).
const notNow = page.getByRole('button', { name: /not now/i }).first();
if (await notNow.count()) {
  await notNow.click();
  await page.waitForTimeout(300);
}

// Create a card in the first list.
const addCard = page.getByRole('button', { name: /\+ Add card/i }).first();
if (await addCard.count()) {
  await addCard.click();
  await page.waitForTimeout(400);
  const area = page.locator('textarea[name="title"]').first();
  await area.fill('Probe timeline card');
  await page.locator('button[type="submit"]').last().click();
  await page.waitForTimeout(2000);
}

// Open the card → drawer → Settings tab.
const card = page.getByText('Probe timeline card').first();
if (await card.count()) {
  await card.click();
  await page.waitForTimeout(1500);
  const settingsTab = page.getByRole('button', { name: /Settings/i }).first();
  if (await settingsTab.count()) {
    await settingsTab.click();
    // Give the gated comments stream time to release its connection (the
    // http/1.1 six-per-origin budget) before the timeline fetch fires.
    await page.waitForTimeout(10000);
    await page.screenshot({ path: '/tmp/probe-card-settings.png' });
    text = await page.locator('body').innerText();
    console.log('settings tab shows title editor:', /Title/i.test(text) ? 'YES' : 'NO');
    console.log('timeline section:', /Activity/.test(text) ? 'present' : 'MISSING');
    const activityIdx = text.indexOf('Activity');
    console.log('---- activity text ----');
    console.log(activityIdx >= 0 ? text.slice(activityIdx, activityIdx + 400) : '(none)');
  } else {
    console.log('NO settings tab found');
  }
} else {
  console.log('card creation failed');
}

// Board chat: composer + @all chip. A fresh page frees the previous
// page's live connections first (dev http/1.1 caps at six per origin).
{
  await page.close();
  const page2 = await browser.newPage();
  await page2
    .goto(`${BASE}/b/${boardId}?chat=1`, { waitUntil: 'domcontentloaded' })
    .catch(() => {});
  await page2.waitForTimeout(3000);
  const composer = page2.locator('[contenteditable]').last();
  if (await composer.count()) {
    await composer.click();
    await composer.fill('[All](all:everyone) hello everyone — probe');
    await composer.press('Enter');
    await page2.waitForTimeout(2500);
    await page2.screenshot({ path: '/tmp/probe-board-chat-all.png' });
    const text2 = await page2.locator('body').innerText();
    console.log('@all message posted:', /hello everyone — probe/i.test(text2) ? 'YES' : 'NO');
    console.log('@all renders as chip:', /@All/i.test(text2) ? 'YES (chip label visible)' : 'NO');
  } else {
    console.log('NO board chat composer');
  }
  await page2.close();
}
await page.close();

console.log('---- errors ----');
console.log(errors.filter((e) => !e.includes('401')).join('\n') || '(none)');
await browser.close();
