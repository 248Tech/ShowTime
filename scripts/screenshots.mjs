// Regenerates the README / landing-page screenshots from the LIVE DEMO (so they always match the real UI and never show private data).
// Dev-only tool, not a runtime dependency:   npm i --no-save playwright-core   then   node scripts/screenshots.mjs
// Uses an installed Chromium-family browser: PW_CHANNEL=msedge (default) | chrome   or   BROWSER_PATH=/path/to/browser
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'site/assets/screens');
fs.mkdirSync(OUT, { recursive: true });

const srv = spawn(process.execPath, ['scripts/build-site.mjs', '--serve'], { cwd: ROOT });
let log = '';
srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !log.includes('serving'); i++) await sleep(100);
const BASE = 'http://localhost:4173/ShowTime/demo/';

const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: process.env.PW_CHANNEL || 'msedge' }), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
const save = async (name, opts = {}) => { await sleep(opts.wait ?? 900); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 86, ...opts.shot }); console.log('  ' + name + '.jpg'); };
const go = async (hash, waitFor) => { await page.goto(BASE + hash); await page.waitForSelector(waitFor, { timeout: 15000 }); };
try {
  await page.goto(BASE); await page.waitForSelector('.tiles');
  await page.evaluate(() => document.getElementById('demo-ribbon')?.remove()); // keep the marketing shots clean
  await sleep(600);
  await save('home');

  await page.click('nav.top a:has-text("Library")'); await page.waitForSelector('.grid .card'); await save('library');
  await page.click('button.chip:has-text("TV Shows"), button:has-text("TV Shows")'); await page.click('.card:has-text("Space Saga")'); await page.waitForSelector('.ep'); await page.waitForSelector('.head img'); await sleep(500); await save('details', { wait: 500 });
  await page.click('.modal .x'); await page.click('button:has-text("All")');

  await page.click('.card:has-text("Neon Heist")'); await page.waitForSelector('text=Video versions'); await page.click('summary:has-text("Codec scan report")');
  await sleep(500); await page.evaluate(() => document.querySelector('.modalbg').scrollTo(0, 420)); await save('codecs', { wait: 400 });
  await page.click('.modal .x');

  await page.click('nav.top a:has-text("Rooms")'); await page.waitForSelector('a.btn:has-text("Join")'); await page.click('a.btn:has-text("Join") >> nth=0');
  await page.waitForSelector('video'); await page.click('button:has-text("▶ Play")');
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.currentTime > 2.2 && !v.paused; }, null, { timeout: 15000 });
  await save('room', { wait: 300 });

  await page.click('nav.top a:has-text("Live TV")'); await page.waitForSelector('.chan'); await save('livetv');

  await page.click('nav.top a:has-text("Friends")'); await page.waitForSelector('code.k.big'); await save('friends');
  await page.click('nav.top a:has-text("Groups")'); await page.waitForSelector('.panel:has-text("Movie Night Crew")'); await save('groups');

  await page.click('nav.top a:has-text("Chat")'); await page.waitForSelector('.irc-in');
  const say = async (t) => { await page.fill('.irc-in', t); await page.press('.irc-in', 'Enter'); await sleep(300); };
  await say('/join #demo popcorn'); await page.waitForFunction(() => /earlier message\(s\) decrypted/.test(document.querySelector('.irc-log').textContent), null, { timeout: 25000 });
  await say('/nick Kernel'); await say('hey all - first time in the demo chat!');
  await page.waitForFunction(() => /^\[[\d:]+\] <Maple>/m.test(document.querySelector('.irc-log').innerText) && /welcome|hey there/i.test(document.querySelector('.irc-log').innerText), null, { timeout: 12000 }).catch(() => {});
  await save('chat', { wait: 2600 });

  await page.click('nav.top a:has-text("Stats")'); await page.waitForSelector('.bars'); await save('stats', { wait: 1200 });
  await go('#/profile', '.abadge'); await page.evaluate(() => document.querySelector('.notif.ach')?.remove()); await sleep(300);
  await save('profile', { wait: 1400 });
  await page.evaluate(() => document.querySelector('.badges')?.scrollIntoView({ block: 'start' })); await sleep(300);
  await page.screenshot({ path: path.join(OUT, 'badges.jpg'), type: 'jpeg', quality: 86 }); console.log('  badges.jpg');
  // mobile
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  await m.goto(BASE); await m.waitForSelector('.tiles'); await m.evaluate(() => document.getElementById('demo-ribbon')?.remove()); await sleep(1200);
  await m.screenshot({ path: path.join(OUT, 'mobile.jpg'), type: 'jpeg', quality: 84 }); console.log('  mobile.jpg');
} finally { await browser.close(); srv.kill(); }
console.log('done ->', OUT);
