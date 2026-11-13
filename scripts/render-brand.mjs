// Renders the brand assets: social preview (og.png 1200x630) + app icons, from the logo and the demo screenshots.
// Dev-only (needs playwright-core, see scripts/screenshots.mjs):   node scripts/render-brand.mjs
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'site/assets');
const logo = fs.readFileSync(path.join(ROOT, 'public/logo.svg'), 'utf8');
const room = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(OUT, 'screens/room.jpg')).toString('base64');
const bg = 'radial-gradient(900px 500px at 5% -10%,rgba(255,138,61,.42),transparent 60%),radial-gradient(800px 520px at 105% 10%,rgba(124,92,255,.40),transparent 58%),radial-gradient(700px 400px at 60% 120%,rgba(255,77,109,.28),transparent 60%),#0b0b10';
const brand = 'linear-gradient(135deg,#ffd04a 0%,#ff8a3d 55%,#ff4d6d 100%)';
const font = "font-family:'Segoe UI Variable','Segoe UI',system-ui,Helvetica,Arial,sans-serif";

const ogHtml = `<!doctype html><meta charset=utf-8><body style="margin:0;width:1200px;height:630px;overflow:hidden;background:${bg};${font};color:#f6f5f9;position:relative">
<div style="position:absolute;left:68px;top:64px;display:flex;align-items:center;gap:18px"><div style="width:74px;height:74px">${logo}</div><div style="font-size:46px;font-weight:850;letter-spacing:-1.5px;background:${brand};-webkit-background-clip:text;color:transparent">ShowTime</div></div>
<div style="position:absolute;left:68px;top:178px;width:580px">
  <div style="font-size:68px;font-weight:850;line-height:1.04;letter-spacing:-2.6px">Watch together.<br><span style="background:${brand};-webkit-background-clip:text;color:transparent">Privately.</span></div>
  <div style="margin-top:22px;font-size:24px;line-height:1.4;color:#b9b7c8">Self-hosted watch parties with an encrypted library, friends-only privacy and end-to-end encrypted chat.</div>
  <div style="margin-top:26px;display:flex;gap:12px;font-size:19px;color:#d9d7e6"><span style="padding:8px 18px;border-radius:99px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16)">Open source</span><span style="padding:8px 18px;border-radius:99px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16)">AV1 · VP9</span><span style="padding:8px 18px;border-radius:99px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16)">MIT</span></div>
</div>
<div style="position:absolute;left:650px;top:96px;width:640px;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.2);background:#0d0c14;box-shadow:0 40px 90px -20px #000;transform:perspective(1400px) rotateY(-9deg) rotateX(3deg)">
  <div style="display:flex;gap:7px;padding:10px 14px;background:#17161f"><i style="width:10px;height:10px;border-radius:50%;background:#ff5f57"></i><i style="width:10px;height:10px;border-radius:50%;background:#febc2e"></i><i style="width:10px;height:10px;border-radius:50%;background:#28c840"></i></div>
  <img src="${room}" style="display:block;width:100%">
</div></body>`;

const iconHtml = (pad) => `<!doctype html><meta charset=utf-8><body style="margin:0;width:512px;height:512px;display:grid;place-items:center;background:radial-gradient(420px 320px at 20% 0%,rgba(255,138,61,.55),transparent 62%),radial-gradient(420px 320px at 100% 100%,rgba(124,92,255,.5),transparent 62%),#12101c"><div style="width:${512 - pad * 2}px;height:${512 - pad * 2}px">${logo}</div></body>`;

const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: process.env.PW_CHANNEL || 'msedge' }) });
const shot = async (html, w, h, file, scale = 1) => {
  const p = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale })).newPage();
  await p.setContent(html); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, file), type: 'png' }); console.log('  ' + file);
};
await shot(ogHtml, 1200, 630, 'og.png');
await shot(iconHtml(70), 512, 512, 'icon-512.png');
await shot(iconHtml(70), 512, 512, 'icon-192.png', 192 / 512);
await shot(iconHtml(86), 512, 512, 'apple-touch-icon.png', 180 / 512);
await browser.close();
