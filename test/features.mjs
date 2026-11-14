// Cast & crew metadata, global ratings, DVR, free movies and send-to-device, against mock providers.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-feat-'));
const hls = path.join(dir, 'hls'); fs.mkdirSync(hls);
const PORT = 18097, UP = 18098, B = `http://127.0.0.1:${PORT}`, UPB = `http://127.0.0.1:${UP}`;
const gen = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'vod', path.join(hls, 'live.m3u8')]);
assert.equal(gen.status, 0, 'ffmpeg could not make the test stream: ' + gen.stderr);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MOVIE = Buffer.alloc(1000, 7);
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, UPB);
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (u.pathname === '/list.m3u') return send(200, 'audio/x-mpegurl', `#EXTM3U\n#EXTINF:-1 group-title="News",Rec Channel\n${UPB}/hls/live.m3u8\n`);
  if (u.pathname.startsWith('/hls/')) { const f = path.join(hls, path.basename(u.pathname)); return fs.existsSync(f) ? send(200, f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', fs.readFileSync(f)) : send(404, 'text/plain', 'no'); }
  if (u.pathname === '/singlesearch/shows') return u.searchParams.get('q') === 'Nothing Here' ? send(404, 'text/plain', 'x') : send(200, 'application/json', JSON.stringify({ name: 'Mock Show', premiered: '2020-01-02', genres: ['Drama'], summary: '<p>A <b>tense</b> &amp; funny show.</p>', rating: { average: 8.4 }, network: { name: 'MockNet' }, image: { medium: `${UPB}/img.png` },
    _embedded: { cast: [{ person: { name: 'Ada Actor', image: { medium: `${UPB}/img.png` } }, character: { name: 'Hero' } }, { person: { name: 'No Photo' }, character: { name: 'Sidekick' } }], crew: [{ type: 'Creator', person: { name: 'Cree Ator' } }, { type: 'Caterer', person: { name: 'Nope' } }], episodes: [{ season: 1, number: 1, name: 'The Pilot', summary: '<p>It begins.</p>', airdate: '2020-01-02', runtime: 45, image: { medium: `${UPB}/img.png` }, rating: { average: 8.1 } }, { season: 1, number: 2, name: 'Second Wind', summary: '<p>It continues.</p>', airdate: '2020-01-09', runtime: 44 }] } }));
  if (u.pathname === '/search') return send(200, 'application/json', JSON.stringify({ results: u.searchParams.get('term') === 'Some Film' ? [{ trackName: 'Some Film', releaseDate: '1999-03-01T08:00:00Z', artworkUrl100: `${UPB}/img.png/100x100bb.jpg`, longDescription: 'A <fine> film.', primaryGenreName: 'Drama', artistName: 'Dee Rector' }] : [] }));
  if (u.pathname === '/img.png') return send(200, 'image/png', PNG);
  if (u.pathname === '/advancedsearch.php') return send(200, 'application/json', JSON.stringify({ response: { docs: [{ identifier: 'test_movie', title: 'Test Movie', year: 1950, licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/', downloads: 5, description: '<i>Old</i> film' }] } }));
  if (u.pathname === '/metadata/test_movie') return send(200, 'application/json', JSON.stringify({ files: [{ name: 'test_movie.ogv', format: 'Ogg Video' }, { name: 'test_movie.mp4', format: 'h.264', source: 'derivative', size: '1000' }] }));
  if (u.pathname === '/download/test_movie/test_movie.mp4') {
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 1000 }); return res.end(MOVIE); }
    const a = +m[1], b = m[2] ? +m[2] : 999;
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/1000`, 'Content-Length': b - a + 1 }); return res.end(MOVIE.subarray(a, b + 1));
  }
  send(404, 'text/plain', 'nope');
});
await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: path.join(dir, 'data'), IPTV_AUTO: '0', ENCODE_AUTO: '0', FREE_AUTO: '0', IPTV_SOURCE_URL: UPB + '/list.m3u', META_TVMAZE_BASE: UPB, META_ITUNES_BASE: UPB, FREE_API_BASE: UPB, SHOWTIME_TEST_ALLOW_PRIVATE_UPSTREAM: '1' }, cwd: process.cwd() });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && !log.includes('listening'); i++) await sleep(100);

const mk = () => {
  let cookie = '';
  const call = async (method, p, body, extra = {}) => { const r = await fetch(B + p, { method, headers: { 'X-Requested-With': 'showtime', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return r; };
  return { call, cookie: () => cookie };
};
const A = mk(), U2 = mk();
const sse = (who, p) => { const ev = []; const ac = new AbortController(); (async () => { try { const r = await fetch(B + p, { headers: { Cookie: who.cookie() }, signal: ac.signal }); let buf = ''; for await (const c of r.body) { buf += Buffer.from(c).toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const e = /event: (.*)/.exec(blk), d = /data: (.*)/.exec(blk); if (e) ev.push({ e: e[1], d: d ? JSON.parse(d[1]) : null }); } } } catch { /* aborted */ } })(); return { ev, close: () => ac.abort() }; };
const until = async (f, ms = 15000) => { for (let i = 0; i < ms / 100; i++) { const v = await f(); if (v) return v; await sleep(100); } throw new Error('timeout'); };

let ok = false;
try {
  assert.equal((await A.call('POST', '/api/register', { username: 'admin', email: 'a@x.io', password: 'correct horse battery' })).status, 201);
  await A.call('POST', '/api/admin/settings', { openSignup: true });
  assert.equal((await U2.call('POST', '/api/register', { username: 'bob', email: 'b@x.io', password: 'correct horse battery' })).status, 201);

  // --- cast & crew ---
  const m = await (await A.call('GET', '/api/meta?kind=tv&title=Mock%20Show')).json();
  assert.equal(m.found, true); assert.equal(m.title, 'Mock Show'); assert.equal(m.summary, 'A tense & funny show.', 'HTML stripped');
  assert.equal(m.cast[0].name, 'Ada Actor'); assert.equal(m.cast[0].role, 'Hero'); assert.ok(m.cast[0].img.startsWith('/api/img?u='), 'headshots go through the proxy');
  assert.equal(m.cast[1].img, null, 'person without a photo has no image'); assert.deepEqual(m.crew.map((c) => c.role), ['Creator'], 'only key crew roles kept');
  const im = await A.call('GET', m.cast[0].img); assert.equal(im.status, 200); assert.equal(im.headers.get('content-type'), 'image/png');
  assert.equal((await A.call('GET', '/api/meta?kind=tv&title=Nothing%20Here')).status, 200);
  assert.deepEqual(m.episodes.map((e) => [e.s, e.n, e.name]), [[1, 1, 'The Pilot'], [1, 2, 'Second Wind']], 'episode guide included');
  assert.equal(m.episodes[0].summary, 'It begins.'); assert.ok(m.episodes[0].img.startsWith('/api/img?u='), 'episode stills go through the proxy'); assert.equal(m.episodes[1].img, null);
  const mv = await (await A.call('GET', '/api/meta?kind=movie&title=Some%20Film&year=1999')).json();
  assert.equal(mv.found, true, 'keyless movie fallback'); assert.equal(mv.source, 'iTunes'); assert.equal(mv.year, 1999); assert.ok(mv.poster.startsWith('/api/img?u='), 'poster'); assert.equal(mv.crew[0].role, 'Director');
  assert.equal((await (await A.call('GET', '/api/meta?kind=movie&title=Unknown%20Zzz')).json()).found, false);
  // upload -> auto poster, score and episode title (no manual step)
  const clipPath = path.join(dir, 'Mock Show S01E01.mp4');
  assert.equal(spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipPath]).status, 0);
  const up = await fetch(B + '/api/upload?name=' + encodeURIComponent('Mock Show S01E01.mp4'), { method: 'PUT', headers: { 'X-Requested-With': 'showtime', Cookie: A.cookie() }, body: fs.readFileSync(clipPath) });
  assert.equal(up.status, 201);
  const ep = await until(async () => { const l = await (await A.call('GET', '/api/media')).json(); const e = l.find((x) => x.show === 'Mock Show'); return e && e.status === 'ready' && e.poster && e.title === 'The Pilot' ? e : null; }, 20000);
  assert.ok(ep.poster.startsWith('/api/img?u='), 'media list carries the poster'); assert.equal(ep.score, 8.4, 'and the score'); assert.equal(ep.title, 'The Pilot', 'placeholder episode title replaced');
  assert.equal((await fetch(B + '/api/meta?kind=tv&title=x')).status, 401, 'login required');
  assert.equal((await fetch(B + '/api/img?u=' + encodeURIComponent(UPB + '/img.png'))).status, 401);

  // --- global ratings ---
  assert.equal((await A.call('PUT', '/api/ratings', { key: 'show:mock-show', stars: 4 })).status, 200);
  const r2 = await (await U2.call('PUT', '/api/ratings', { key: 'show:mock-show', stars: 2 })).json();
  assert.equal(r2.avg, 3); assert.equal(r2.n, 2); assert.equal(r2.mine, 2);
  const sum = await (await A.call('GET', '/api/ratings')).json();
  assert.deepEqual(sum['show:mock-show'], { avg: 3, n: 2, mine: 4 }, 'global average, own vote only');
  assert.equal(JSON.stringify(sum).includes('bob'), false);
  assert.equal((await A.call('PUT', '/api/ratings', { key: '../etc', stars: 5 })).status, 400);
  assert.equal((await A.call('PUT', '/api/ratings', { key: 'show:x', stars: 9 })).status, 400);
  assert.equal((await (await A.call('PUT', '/api/ratings', { key: 'show:mock-show', stars: 0 })).json()).n, 1, 'stars 0 clears my vote');

  // --- free movies ---
  assert.equal((await A.call('POST', '/api/admin/free/refresh')).status, 202);
  const fl = await until(async () => { const r = await (await A.call('GET', '/api/free')).json(); return r.total === 1 && r; });
  assert.equal(fl.items[0].title, 'Test Movie'); assert.equal(fl.items[0].license, 'Public domain'); assert.equal(fl.items[0].rkey, 'free:test_movie');
  assert.equal((await (await A.call('GET', '/api/free?q=zzz')).json()).total, 0);
  const full = await A.call('GET', '/api/free/test_movie/stream'); assert.equal(full.status, 200); assert.equal((await full.arrayBuffer()).byteLength, 1000);
  const part = await A.call('GET', '/api/free/test_movie/stream', null, { Range: 'bytes=100-199' }); assert.equal(part.status, 206, 'range requests work so seeking works'); assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await A.call('GET', '/api/free/nope/stream')).status, 404);
  const room = await (await A.call('POST', '/api/rooms', {})).json();
  assert.equal((await A.call('POST', `/api/rooms/${room.id}/cmd`, { type: 'addFree', id: 'test_movie' })).status, 200);
  const rs = await (await A.call('GET', `/api/rooms/${room.id}`)).json();
  const fi = rs.state.items[0]; assert.equal(fi.free, true); assert.equal(fi.src, '/api/free/test_movie/stream'); assert.equal(fi.rkey, 'free:test_movie');
  assert.equal((await A.call('POST', `/api/rooms/${room.id}/cmd`, { type: 'addFree', id: 'nope' })).status, 404);

  // --- send to device ---
  const phone = sse(A, '/api/events?d=phone12345&n=My%20Phone'), tv = sse(A, '/api/events?d=livingtv99&n=TV');
  const devs = await until(async () => { const d = await (await A.call('GET', '/api/devices')).json(); return d.length === 2 && d; });
  assert.deepEqual(devs.map((d) => d.name).sort(), ['My Phone', 'TV']);
  assert.deepEqual(await (await U2.call('GET', '/api/devices')).json(), [], 'devices are private to the account');
  assert.equal((await A.call('POST', '/api/devices/livingtv99/cast', { roomId: room.id, from: 'My Phone' })).status, 200);
  const cast = await until(() => tv.ev.find((x) => x.e === 'cast')); assert.equal(cast.d.roomId, room.id);
  assert.equal(phone.ev.some((x) => x.e === 'cast'), false, 'only the chosen device is told');
  assert.equal((await A.call('POST', '/api/devices/gone123456/cast', { roomId: room.id })).status, 404);
  assert.equal((await U2.call('POST', '/api/devices/livingtv99/cast', { roomId: room.id })).status, 404, "can't cast into someone else's room/devices");
  phone.close(); tv.close();

  // --- DVR ---
  assert.equal((await A.call('POST', '/api/admin/iptv/refresh')).status, 202);
  const ch = await until(async () => (await (await A.call('GET', '/api/iptv')).json()).items.find((c) => c.name === 'Rec Channel'));
  assert.equal((await A.call('POST', '/api/dvr', { chanId: ch.id, minutes: 0 })).status, 400);
  assert.equal((await A.call('POST', '/api/dvr', { chanId: 'nope', minutes: 5 })).status, 404);
  assert.equal((await A.call('POST', '/api/dvr', { chanId: ch.id, minutes: 5, startAt: Date.now() - 3600000 })).status, 400, 'no past start');
  const later = await (await A.call('POST', '/api/dvr', { chanId: ch.id, minutes: 5, startAt: Date.now() + 3600000 })).json();
  assert.equal(later.status, 'scheduled');
  assert.equal((await U2.call('POST', `/api/dvr/${later.id}/stop`)).status, 404, "can't touch someone else's recording");
  assert.equal((await (await A.call('POST', `/api/dvr/${later.id}/stop`)).json()).status, 'canceled');
  assert.equal((await A.call('DELETE', `/api/dvr/${later.id}`)).status, 200);
  const rec = await (await A.call('POST', '/api/dvr', { chanId: ch.id, minutes: 3 })).json();
  const done = await until(async () => { const l = await (await A.call('GET', '/api/dvr')).json(); const r = l.find((x) => x.id === rec.id); if (r?.status === 'failed') throw new Error('recording failed: ' + r.error); return r?.status === 'done' && r; }, 40000);
  assert.ok(done.mediaId && done.bytes > 10000, 'recording saved with size');
  const lib = await (await A.call('GET', '/api/media')).json();
  const saved = lib.find((x) => x.id === done.mediaId); assert.ok(saved, 'recording appears in my library'); assert.match(saved.title, /^Rec Channel - \d{4}-\d\d-\d\d/);
  await until(async () => (await (await A.call('GET', '/api/media')).json()).find((x) => x.id === done.mediaId)?.status === 'ready');
  const sm = (await (await A.call('GET', '/api/media')).json()).find((x) => x.id === done.mediaId); assert.ok(sm.duration > 4, 'recorded video has real duration'); assert.equal(sm.playable, true, 'remuxed to browser-playable MP4');
  assert.equal((await (await U2.call('GET', '/api/media')).json()).some((x) => x.id === done.mediaId), false, 'recordings are private to the owner');
  assert.equal((await fetch(B + '/api/iptv/p/x', { headers: { 'X-DVR-Key': 'guess' } })).status, 401, 'the recorder relay key does not open the main API');
  ok = true; console.log('FEATURES OK');
} catch (e) { console.error('FAIL', e); console.error(log.slice(-1500)); } finally {
  srv.kill(); upstream.close(); await new Promise((r) => srv.once('exit', r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite lock */ }
  process.exit(ok ? 0 : 1);
}
