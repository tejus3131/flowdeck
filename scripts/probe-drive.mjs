// Probe harness v2: drives the local dev app in headless Brave with a probe
// session minted via scripts/probe-link.mjs. Records ALL network traffic.
// Usage: node scripts/probe-drive.mjs <token_hash> <scenario> [linkType]
import { chromium } from 'playwright-core';

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const BASE = process.env.PROBE_BASE ?? 'http://localhost:3001';
const tokenHash = process.argv[2];
const scenario = process.argv[3] ?? 'create-ws';
const linkType = process.argv[4] ?? 'magiclink';
if (!tokenHash) {
  console.error('usage: node scripts/probe-drive.mjs <token_hash> <scenario> [linkType]');
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: BRAVE, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const traffic = [];
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console.error] ${msg.text().slice(0, 300)}`);
});
page.on('response', (res) => {
  const url = res.url().replace(BASE, '');
  if (url.includes('.supabase.') || url.startsWith('/_server') || res.status() >= 400) {
    traffic.push(`[${res.status()}] ${res.request().method()} ${url.slice(0, 120)}`);
  }
});

const shot = async (name) => {
  await page.screenshot({ path: `/tmp/probe-${name}.png`, fullPage: false });
  console.log(`shot: /tmp/probe-${name}.png`);
};

const wsId = () => process.env.PROBE_WS_ID ?? '';

// 1. Sign in through the magic-link route.
await page.goto(`${BASE}/auth/confirm?token_hash=${tokenHash}&type=${linkType}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
console.log('after-confirm url:', page.url());

if (scenario === 'create-ws') {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const input = page.locator('input[placeholder*="Acme" i]').first();
  if (await input.count()) {
    await input.fill('Probe Test Workspace');
    await shot('create-filled');
    await input.press('Enter');
    await page.waitForTimeout(3500);
    await shot('create-result');
    console.log('after-create url:', page.url());
    const bodyText = (await page.locator('body').innerText()).slice(0, 800);
    console.log('--- page text (first 800) ---');
    console.log(bodyText);
  } else {
    console.log('NO create-workspace input — page text:');
    console.log((await page.locator('body').innerText()).slice(0, 400));
  }
}

if (scenario === 'invite-flow') {
  // Prereq: PROBE_WS_ID env set, probe is owner; PROBE_EXISTING_EMAIL set.
  const existingEmail = process.env.PROBE_EXISTING_EMAIL ?? '';
  const outDomainEmail = process.env.PROBE_OUT_DOMAIN ?? 'nobody@gmail.com';
  await page.goto(`${BASE}/w/${wsId()}/members`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await shot('members');

  const inviteByEmail = async (email) => {
    const emailInput = page.locator('input[type="email"], input[placeholder*="mail" i]').first();
    await emailInput.fill(email);
    const sendBtn = page.getByRole('button', { name: /invite|send/i }).first();
    await sendBtn.click();
    await page.waitForTimeout(2500);
    const bodyText = (await page.locator('body').innerText()).slice(0, 3000);
    const lines = bodyText.split('\n').filter((l) => /already in this workspace|Only addresses|error|Error|✓|could not/i.test(l));
    console.log(`invite ${email} →`, lines.length ? lines.join(' | ') : '(no visible feedback)');
    await shot('invite-result');
  };

  if (existingEmail) await inviteByEmail(existingEmail);
  await inviteByEmail(outDomainEmail);
}

console.log('---- traffic ----');
for (const t of traffic) console.log(t);
console.log('---- page errors ----');
for (const e of errors) console.log(e);
await browser.close();
