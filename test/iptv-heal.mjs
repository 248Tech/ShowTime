// A provider whose session-tokenised playlist URLs expire (the classic "stream freezes after a few minutes"):
// the proxy must re-resolve a fresh session from the channel's master playlist, transparently.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-heal-'));
const PORT = 18095, UP = 18096, B = `http://127.0.0.1:${PORT}`, UPB = `http://127.0.0.1:${UP}`;
let session = 0, masterHits = 0, liveSeq = 0;
const seg = Buffer.alloc(188 * 20, 0x47);
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, UPB), s = +u.searchParams.get('s');
  if (u.pathname === '/list.m3u') return send(res, 200, 'audio/x-mpegurl', `#EXTM3U\n#EXTINF:-1 tvg-id="Sess.us@SD" group-title="News",Session Channel\n${UPB}/sess/master.m3u8\n#EXTINF:-1 group-title="News",Frozen Feed\n${UPB}/frozen/live.m3u8\n`);
  if (u.pathname === '/frozen/live.m3u8') return send(res, 200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:922199651\n#EXTINF:1.9,\nold0.ts\n#EXTINF:1.9,\nold1.ts\n'); // provider stopped: same segments forever
  if (u.pathname.startsWith('/frozen/old')) return send(res, 200, 'video/mp2t', seg);
  if (u.pathname === '/sess/master.m3u8') { masterHits++; session++; return send(res, 200, 'application/vnd.apple.mpegurl', `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="a/en.m3u8?s=${session}"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="aud"\nv/low.m3u8?s=${session}\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,AUDIO="aud"\nv/high.m3u8?s=${session}\n`); }
  if (u.pathname === '/expire') { session++; return send(res, 200, 'text/plain', 'expired'); }
  if (u.pathname === '/stats') return send(res, 200, 'application/json', JSON.stringify({ masterHits, session }));
  if (/^\/sess\/(v|a)\/\w+\.m3u8$/.test(u.pathname)) return s === session ? send(res, 200, 'application/vnd.apple.mpegurl', `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:${liveSeq++}\n#EXTINF:4,\nseg0.ts?s=${s}\n`) : send(res, 404, 'text/plain', 'session expired');
  if (u.pathname === '/sess/v/seg0.ts' || u.pathname === '/sess/a/seg0.ts') return s === session ? send(res, 200, 'video/mp2t', seg) : send(res, 404, 'text/plain', 'expired');
  send(res, 404, 'text/plain', 'nope');
});
await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: path.join(dir, 'data'), IPTV_AUTO: '0', ENCODE_AUTO: '0', IPTV_SOURCE_URL: UPB + '/list.m3u', SHOWTIME_TEST_ALLOW_PRIVATE_UPSTREAM: '1' }, cwd: process.cwd() });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && !log.includes('listening'); i++) await sleep(100);
let cookie = '';
const call = async (method, p, body) => { const r = await fetch(B + p, { method, headers: { 'X-Requested-With': 'showtime', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return r; };
const up = async (p) => (await fetch(UPB + p)).json();
let ok = false;
try {
  assert.equal((await call('POST', '/api/register', { username: 'admin', email: 'a@x.io', password: 'correct horse battery' })).status, 201);
  assert.equal((await call('POST', '/api/admin/iptv/refresh')).status, 202);
  let ch; for (let i = 0; i < 60; i++) { const r = await (await call('GET', '/api/iptv')).json(); if (r.total === 2) { ch = r.items.find((c) => c.name === 'Session Channel'); break; } await sleep(200); }
  assert.ok(ch, 'channel imported');
  await waitCheck();
  async function waitCheck() { for (let i = 0; i < 60; i++) { const f = (await (await call('GET', '/api/admin/info')).json()).iptv; if (f.checked === 2 && !f.check.running) return; await sleep(200); } }
  assert.equal((await (await call('GET', '/api/iptv?working=1')).json()).total, 1, 'health check passes the live channel and REJECTS the frozen feed (same segments forever)');
  assert.equal((await (await call('GET', '/api/iptv?working=1')).json()).items[0].name, 'Session Channel');

  const master = await (await call('GET', `/api/iptv/${ch.id}/stream.m3u8`)).text();
  const lines = master.split('\n');
  const variants = lines.filter((l) => l.startsWith('/api/iptv/p/'));
  const audio = /URI="(\/api\/iptv\/p\/[^"]+)"/.exec(master)[1];
  assert.equal(variants.length, 2); assert.ok(!master.includes('127.0.0.1'));
  const high = variants[1];
  const hit = async (p) => call('GET', p);
  assert.equal((await hit(high)).status, 200, 'variant plays while the session is fresh');
  assert.equal((await hit(audio)).status, 200, 'audio rendition plays while the session is fresh');
  const media1 = await (await hit(high)).text(); const seg1 = media1.split('\n').find((l) => l.startsWith('/api/iptv/p/'));
  assert.equal((await hit(seg1)).status, 200);

  // --- provider session expires ---
  await fetch(UPB + '/expire');
  const before = (await up('/stats')).masterHits;
  const healed = await hit(high);
  assert.equal(healed.status, 200, 'variant URL healed transparently after the provider session expired');
  const media2 = await healed.text(); assert.ok(media2.includes('/api/iptv/p/'), 'fresh media playlist is rewritten through the proxy');
  assert.equal((await up('/stats')).masterHits, before + 1, 'exactly one master re-fetch was needed');
  assert.equal((await hit((media2.split('\n').find((l) => l.startsWith('/api/iptv/p/'))))).status, 200, 'segments from the fresh session work');
  assert.equal((await hit(audio)).status, 200, 'audio rendition healed too (identified by group/name, not URL)');
  const mid = (await up('/stats')).masterHits;
  assert.equal((await hit(high)).status, 200); assert.equal((await hit(high)).status, 200);
  assert.equal((await up('/stats')).masterHits, mid, 'later reloads reuse the healed URL (no master hammering)');
  assert.equal((await hit(seg1)).status, 404, 'a stale SEGMENT url is not healed (segments come from the fresh playlist)');
  // --- expires again and again ---
  for (let i = 0; i < 3; i++) { await fetch(UPB + '/expire'); assert.equal((await hit(high)).status, 200, 'heals repeatedly (round ' + (i + 1) + ')'); }
  // the OTHER variant resolves to its own URL, not the high one
  await fetch(UPB + '/expire');
  const low = await (await hit(variants[0])).text(); assert.ok(low.includes('/api/iptv/p/'), 'low variant healed independently');

  // --- viewers can flag a channel their player could not recover ---
  assert.equal((await fetch(B + `/api/iptv/${ch.id}/report`, { method: 'POST', headers: { 'X-Requested-With': 'showtime' } })).status, 401, 'login required');
  assert.deepEqual(await (await call('POST', `/api/iptv/${ch.id}/report`)).json(), { marked: true });
  assert.equal((await (await call('GET', '/api/iptv?working=1')).json()).total, 0, 'reported channel leaves the working list');
  assert.equal((await (await call('GET', '/api/iptv')).json()).total, 2, 'but stays in the full directory');
  assert.deepEqual(await (await call('POST', `/api/iptv/${ch.id}/report`)).json(), { marked: false });
  assert.equal((await call('POST', '/api/iptv/nope/report')).status, 404);
  await call('POST', '/api/admin/iptv/check'); await sleep(300); await waitCheck();
  assert.equal((await (await call('GET', '/api/iptv?working=1')).json()).total, 1, 'the next health check restores it if it works');
  ok = true; console.log('IPTV-HEAL OK');
} catch (e) { console.error('FAIL', e); console.error(log.slice(-1200)); } finally {
  srv.kill(); upstream.close(); await new Promise((r) => srv.once('exit', r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite lock */ }
  process.exit(ok ? 0 : 1);
}
