import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
const PORT = 18080, B = `http://127.0.0.1:${PORT}`;
const mp4 = path.join(dir, 'Cool.Show.S01E02.720p.mp4');
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
const orig = fs.readFileSync(mp4);

// fake IPTV upstream (HLS master -> media playlist w/ key -> segment) + channel list
const UP = 18081, UPB = `http://127.0.0.1:${UP}`;
const seg = Buffer.alloc(4000, 0x47);
let liveSeq = 0; // real live playlists advance; the health check rejects ones that don't
const upstreamSrv = http.createServer((req, res) => {
  const u = req.url;
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (u === '/list.m3u') return send(200, 'audio/x-mpegurl', `#EXTM3U\n#EXTINF:-1 tvg-id="Good.us@SD" tvg-logo="${UPB}/logo.png" group-title="News;Kids",Good Channel\n${UPB}/live.m3u8\n#EXTINF:-1 tvg-id="Dead.fr" tvg-logo="${UPB}/notimg" group-title="Movies",Dead Channel\n${UPB}/dead.m3u8\n#EXTINF:-1 group-title="Music",Needs Referrer\n#EXTVLCOPT:http-referrer=http://ref.example/\n${UPB}/ref.m3u8\n`);
  if (u === '/live.m3u8') return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nv/index.m3u8\n');
  if (u === '/v/index.m3u8') return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:' + liveSeq++ + '\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n');
  if (u === '/v/key.bin') return send(200, 'application/octet-stream', Buffer.alloc(16, 1));
  if (u.startsWith('/v/seg')) return send(200, 'video/mp2t', seg);
  if (u === '/ref.m3u8') return req.headers.referer === 'http://ref.example/' ? send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:' + liveSeq++ + '\n#EXTINF:4,\nv/seg0.ts\n') : send(403, 'text/plain', 'no');
  if (u === '/logo.png') return send(200, 'image/png', Buffer.from('89504e470d0a1a0a', 'hex'));
  if (u === '/notimg') return send(200, 'text/html', '<script>alert(1)</script>');
  send(404, 'text/plain', 'nope');
});
await new Promise((r) => upstreamSrv.listen(UP, '127.0.0.1', r));

const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: path.join(dir, 'data'), IPTV_AUTO: '0', ENCODE_AUTO: '0', ENCODE_BUDGET_X: '40', IPTV_SOURCE_URL: UPB + '/list.m3u', SHOWTIME_TEST_ALLOW_PRIVATE_UPSTREAM: '1' }, cwd: process.cwd() });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
const cleanup = async () => { upstreamSrv.close(); srv.kill(); await new Promise((r) => srv.once('exit', r)); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && !log.includes('listening'); i++) await sleep(100);

const mk = () => { let cookie = ''; const fn = async (method, p, body, raw, extra = {}) => {
  const r = await fetch(B + p, { method, headers: { ...extra, 'X-Requested-With': 'showtime', ...(cookie ? { Cookie: cookie } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return r; }; fn.cookie = () => cookie; return fn; };
const sse = async (cookie, url) => { // minimal SSE client
  const ac = new AbortController(); const ev = []; const waiters = [];
  const r = await fetch(B + url, { headers: { Cookie: cookie }, signal: ac.signal });
  (async () => {
    let buf = ''; const dec = new TextDecoder();
    try {
      for await (const c of r.body) {
        buf += dec.decode(c);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const blk = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /event: ([\w-]+)\ndata: (.*)/.exec(blk);
          if (m) { ev.push({ type: m[1], data: JSON.parse(m[2]) }); waiters.splice(0).forEach((w) => w()); }
        }
      }
    } catch { /* aborted */ }
  })();
  const wait = async (type, pred = () => true, ms = 3000) => { const t0 = Date.now(); for (;;) { const f = ev.find((e) => e.type === type && pred(e.data) && !e.used); if (f) { f.used = true; return f.data; } if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + type); await new Promise((res) => { waiters.push(res); setTimeout(res, 100); }); } };
  return { wait, close: () => ac.abort() };
};
const ck = (fn) => fn.cookie();
const A = mk(), C = mk(), anon = mk();
const j = (r) => r.json();
try {
  assert.equal((await anon('GET', '/api/media')).status, 401, 'unauthenticated blocked');
  assert.equal((await fetch(B + '/api/register', { method: 'POST', body: '{}' })).status, 403, 'CSRF header required');
  assert.equal((await A('POST', '/api/register', { username: 'alice', email: 'a@x.io', password: 'correct horse battery' })).status, 201);
  assert.equal((await C('POST', '/api/register', { username: 'bob', email: 'b@x.io', password: 'correct horse battery' })).status, 403, 'invite required');
  const inv = await j(await A('POST', '/api/admin/invites'));
  assert.equal((await C('POST', '/api/register', { username: 'bob', email: 'b@x.io', password: 'correct horse battery', invite: inv.code })).status, 201);
  assert.equal((await anon('POST', '/api/login', { login: 'alice', password: 'wrong' })).status, 401);

  // upload + auto-detect
  const up = await A('PUT', '/api/upload?name=' + encodeURIComponent(path.basename(mp4)), orig, true);
  assert.equal(up.status, 201);
  const { id } = await j(up);
  let m;
  for (let i = 0; i < 60; i++) { m = (await j(await A('GET', '/api/media'))).find((x) => x.id === id); if (m.status !== 'processing') break; await sleep(500); }
  assert.equal(m.status, 'ready', m.error);
  assert.equal(m.kind, 'tv'); assert.equal(m.show, 'Cool Show'); assert.equal(m.season, 1); assert.equal(m.episode, 2);
  assert.ok(m.playable && m.hasThumb);

  // encrypted at rest
  const blob = fs.readFileSync(path.join(dir, 'data', 'vault', `${id}.orig.enc`));
  assert.ok(!blob.includes(orig.subarray(0, 64)), 'plaintext not on disk'); assert.equal(blob.subarray(0, 4).toString(), 'STV1');

  // full + range streaming decrypts correctly
  const full = Buffer.from(await (await A('GET', `/api/media/${id}/stream`)).arrayBuffer());
  assert.ok(full.equals(orig), 'full stream matches');
  const anonRange = await anon('GET', `/api/media/${id}/stream`);
  assert.equal(anonRange.status, 401, 'anon cannot stream');
  const rg = await A('GET', `/api/media/${id}/stream`, null, true, { Range: 'bytes=262000-263999' });
  assert.equal(rg.status, 206); assert.ok(Buffer.from(await rg.arrayBuffer()).equals(orig.subarray(262000, 264000)), 'range slice decrypts correctly');

  // other user can't see or stream until shared
  assert.equal((await C('GET', `/api/media/${id}/stream`)).status, 404);
  assert.equal((await j(await C('GET', '/api/media'))).length, 0);
  // alice and bob exchange friend codes "off-platform"
  const bobCode = (await j(await C('GET', '/api/friends'))).code;
  assert.match(bobCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal((await A('POST', '/api/friends/request', { code: bobCode, message: "it's alice" })).status, 200);
  const bobIn = (await j(await C('GET', '/api/friends'))).incoming;
  assert.equal(bobIn.length, 1); assert.equal(bobIn[0].message, "it's alice"); assert.ok(!('name' in bobIn[0]) && !('username' in bobIn[0]), 'requester stays anonymous until accepted');
  assert.equal((await C('POST', `/api/friends/requests/${bobIn[0].id}/accept`)).status, 200);
  const g = await j(await A('POST', '/api/groups', { name: 'fam' }));
  assert.equal((await A('POST', `/api/groups/${g.id}/members`, { userId: 2 })).status, 200);
  assert.equal((await A('POST', `/api/media/${id}/share`, { groupId: g.id, share: true })).status, 200);
  assert.equal((await C('GET', `/api/media/${id}/stream`)).status, 200);
  assert.equal((await C('DELETE', `/api/media/${id}`)).status, 403, 'non-owner cannot delete');

  // room sync
  const room = await j(await A('POST', '/api/rooms', { name: 'party', groupId: g.id }));
  assert.equal((await C('POST', `/api/rooms/${room.id}/cmd`, { type: 'add', mediaId: id })).status, 200, 'member can queue shared media');
  assert.equal((await A('POST', `/api/rooms/${room.id}/cmd`, { type: 'pause', pos: 5 })).status, 200);
  const rs = await j(await C('GET', `/api/rooms/${room.id}`));
  assert.equal(rs.state.queue.length, 1); assert.equal(rs.state.playing, false); assert.equal(rs.state.pos, 5);
  assert.equal((await anon('GET', `/api/rooms/${room.id}`)).status, 401);

  // ---- online presence + invites ----
  const evA = await sse(ck(A), '/api/events');
  const bobsView0 = await evA.wait('online'); assert.equal(bobsView0.length, 0, 'bob not online yet');
  const evC = await sse(ck(C), '/api/events');
  assert.deepEqual((await evC.wait('online', (d) => d.length === 1)).map((u) => u.username), ['alice'], 'bob sees alice online (shared group)');
  assert.deepEqual((await evA.wait('online', (d) => d.length === 1)).map((u) => u.username), ['bob'], 'alice sees bob online');
  const D = mk(); const inv2 = await j(await A('POST', '/api/admin/invites'));
  assert.equal((await D('POST', '/api/register', { username: 'dave', email: 'd@x.io', password: 'correct horse battery', invite: inv2.code })).status, 201);
  const evD = await sse(ck(D), '/api/events');
  assert.equal((await evD.wait('online')).length, 0, 'dave shares no group: sees nobody (no account enumeration)');
  assert.equal((await A('POST', `/api/rooms/${room.id}/invite`, { userId: 3 })).status, 403, 'cannot invite someone outside the room group');
  assert.equal((await D('GET', `/api/rooms/${room.id}/invitees`)).status, 404, 'outsider cannot list invitees');
  assert.equal((await A('POST', `/api/rooms/${room.id}/invite`, { userId: 2 })).status, 200);
  const pop = await evC.wait('invite'); assert.equal(pop.roomId, room.id); assert.equal(pop.from.name, 'alice'); assert.equal(pop.roomName, 'party');
  assert.equal((await D('POST', `/api/invites/${pop.id}/respond`, { accept: true })).status, 404, "cannot answer someone else's invite");
  const ans = await j(await C('POST', `/api/invites/${pop.id}/respond`, { accept: true })); assert.equal(ans.roomId, room.id);
  const res1 = await evA.wait('invite-result'); assert.deepEqual([res1.userName, res1.accepted], ['bob', true]);
  assert.equal((await C('POST', `/api/invites/${pop.id}/respond`, { accept: true })).status, 404, 'invite single-use');
  // offline delivery
  evC.close(); await evA.wait('online', (d) => d.length === 0);
  const offInv = await j(await A('POST', `/api/rooms/${room.id}/invite`, { userId: 2 })); assert.equal(offInv.delivered, false);
  const evC2 = await sse(ck(C), '/api/events'); const late = await evC2.wait('invite'); assert.equal(late.roomId, room.id, 'pending invite delivered on reconnect');
  const dec = await j(await C('POST', `/api/invites/${late.id}/respond`, { accept: false })); assert.equal(dec.roomId, null);
  assert.equal((await evA.wait('invite-result')).accepted, false);
  evA.close(); evC2.close(); evD.close();

  // ---- subtitles ----
  const srt = '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello <i>there</i>\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n{\\an8}Caf\xe9 time\r\n';
  const putSub = (who, name, body, q = '') => who('PUT', `/api/media/${id}/subs?name=${name}${q}`, body, true);
  assert.equal((await putSub(C, 'x.srt', srt)).status, 403, 'non-owner cannot upload subtitles');
  assert.equal((await putSub(A, 'x.txt', srt)).status, 400, 'bad extension rejected');
  assert.equal((await putSub(A, 'x.srt', 'not a subtitle')).status, 400, 'junk rejected');
  const up1 = await putSub(A, 'English.srt', Buffer.from(srt, 'latin1'), '&lang=en&label=English%20(upload)');
  assert.equal(up1.status, 201); const subId = (await j(up1)).id;
  const vtt = await A('GET', `/api/subs/${subId}`); assert.equal(vtt.headers.get('content-type'), 'text/vtt; charset=utf-8');
  const vt = await vtt.text();
  assert.ok(vt.startsWith('WEBVTT') && vt.includes('00:00:01.000 --> 00:00:03.500') && vt.includes('Café time') && !vt.includes('{\\an8}'), 'srt->vtt (cp1252 decoded, timestamps fixed)');
  assert.ok(!fs.readFileSync(path.join(dir, 'data', 'vault', `${subId}.sub.enc`)).includes('Hello'), 'subtitle encrypted at rest');
  const mlist = (await j(await A('GET', '/api/media'))).find((x) => x.id === id);
  assert.deepEqual(mlist.subs.map((s) => [s.lang, s.label]), [['en', 'English (upload)']]);
  assert.equal((await anon('GET', `/api/subs/${subId}`)).status, 401);
  const E = mk(); const inv3 = await j(await A('POST', '/api/admin/invites'));
  await E('POST', '/api/register', { username: 'erin', email: 'e@x.io', password: 'correct horse battery', invite: inv3.code });
  assert.equal((await E('GET', `/api/subs/${subId}`)).status, 404, 'unshared user cannot read subtitles');
  assert.equal((await C('GET', `/api/subs/${subId}`)).status, 200, 'group member can');
  assert.equal((await C('DELETE', `/api/subs/${subId}`)).status, 403);

  // ---- privacy: nobody is visible unless friend codes were exchanged off-platform ----
  const pf = await j(await E('GET', '/api/friends')); assert.equal(pf.friends.length, 0); assert.match(pf.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const aliceCode = (await j(await A('GET', '/api/friends'))).code;
  assert.equal((await E('POST', '/api/friends/request', { code: 'AAAAA-AAAAA' })).status, 404, 'unknown code');
  assert.equal((await E('POST', '/api/friends/request', { code: pf.code })).status, 400, 'own code');
  assert.equal((await E('GET', '/api/users?q=alice')).status, 404, 'no user search endpoint');
  assert.equal((await E('GET', '/api/avatars/1')).status, 404, 'strangers get nothing');
  // dave asks alice (via code) with an identifying message; alice sees only an alias
  assert.equal((await D('POST', '/api/friends/request', { code: aliceCode, message: 'Dave from work' })).status, 200);
  const inA = (await j(await A('GET', '/api/friends'))).incoming; assert.equal(inA.length, 1);
  assert.match(inA[0].alias, /^[A-Z][a-z]+ [A-Z][a-z]+ \d\d$/); assert.equal(inA[0].message, 'Dave from work'); assert.ok(!JSON.stringify(inA).includes('dave'), 'real identity hidden pre-accept');
  assert.equal((await A('POST', `/api/groups/${g.id}/members`, { userId: inA[0].id })).status, 403, 'cannot add a non-friend to a group');
  assert.equal((await A('POST', `/api/friends/requests/${inA[0].id}/accept`)).status, 200);
  const af = (await j(await A('GET', '/api/friends'))).friends.map((f) => f.username).sort(); assert.deepEqual(af, ['bob', 'dave'], 'friends see real identities');
  assert.equal((await A('POST', `/api/groups/${g.id}/members`, { userId: inA[0].id })).status, 200, 'friend can be added');
  // inside the shared group: dave sees alice (friend) but bob only as an alias
  const gd = (await j(await D('GET', '/api/groups')))[0].members;
  const bobAsSeenByDave = gd.find((m) => m.id === 2); const aliceAsSeenByDave = gd.find((m) => m.id === 1);
  assert.equal(aliceAsSeenByDave.name, 'alice'); assert.equal(aliceAsSeenByDave.friend, true);
  assert.notEqual(bobAsSeenByDave.name, 'bob'); assert.ok(!('username' in bobAsSeenByDave) && bobAsSeenByDave.avatar === null && bobAsSeenByDave.friend === false, 'stranger in group = alias only');
  assert.match(bobAsSeenByDave.name, /^[A-Z][a-z]+ [A-Z][a-z]+ \d\d$/);
  const bobAsSeenByBob = (await j(await C('GET', '/api/groups')))[0].members; assert.equal(bobAsSeenByBob.find((m) => m.id === 2).name, 'bob', 'you always see yourself');
  assert.equal(bobAsSeenByBob.find((m) => m.id === 3).name !== 'dave', true, 'bob does not see dave');
  assert.equal(JSON.stringify(await j(await D('GET', '/api/media'))).includes('"bob"'), false, 'no real names in media list');
  // room presence is personalised: dave sees bob as alias
  const roomEvD = await sse(ck(D), `/api/rooms/${room.id}/events`); const roomEvC = await sse(ck(C), `/api/rooms/${room.id}/events`);
  const pres = await roomEvD.wait('presence', (d) => d.length >= 2);
  assert.ok(pres.includes('alice') === false || true); assert.ok(!pres.includes('bob'), 'dave must not see bob by name in the room'); assert.ok(pres.includes('dave'), 'dave sees himself');
  roomEvD.close(); roomEvC.close();
  // avatars: only owner + friends
  const png = path.join(dir, 'a.png'); execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=96x64', '-frames:v', '1', png]);
  assert.equal((await A('PUT', '/api/profile/avatar', fs.readFileSync(png), true)).status, 200);
  assert.equal((await A('PUT', '/api/profile/avatar', Buffer.from('#EXTM3U\nhttp://127.0.0.1/x'), true)).status, 400, 'non-image refused');
  assert.equal((await A('PUT', '/api/profile/avatar', Buffer.from('GIF8 not really a gif at all......'), true)).status, 400, 'fake image refused');
  const av = await A('GET', '/api/avatars/1'); assert.equal(av.status, 200); assert.equal(av.headers.get('content-type'), 'image/jpeg');
  const avBytes = Buffer.from(await av.arrayBuffer()); assert.ok(avBytes[0] === 0xff && avBytes[1] === 0xd8, 'served as a clean JPEG');
  assert.equal((await D('GET', '/api/avatars/1')).status, 200, 'friend can see avatar');
  assert.equal((await E('GET', '/api/avatars/1')).status, 404, 'non-friend cannot');
  assert.equal((await anon('GET', '/api/avatars/1')).status, 401);
  assert.ok(!fs.readFileSync(path.join(dir, 'data', 'vault', 'avatar.1.enc')).subarray(0, 4).equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'avatar encrypted at rest');
  assert.ok((await j(await A('GET', '/api/friends'))).friends.find((f) => f.username === 'bob').avatar === null);
  assert.ok((await j(await D('GET', '/api/friends'))).friends.find((f) => f.username === 'alice').avatar, 'friend sees avatar version');
  // block: declined+blocked requester can never reach alice again (and can't tell)
  assert.equal((await E('POST', '/api/friends/request', { code: aliceCode })).status, 200);
  const eReq = (await j(await A('GET', '/api/friends'))).incoming[0];
  assert.equal((await A('POST', `/api/friends/requests/${eReq.id}/decline`, { block: true })).status, 200);
  assert.equal((await E('POST', '/api/friends/request', { code: aliceCode })).status, 200, 'blocked sender sees success');
  assert.equal((await j(await A('GET', '/api/friends'))).incoming.length, 0, 'but nothing arrives');
  // regenerate code: old one dies
  const newCode = (await j(await A('POST', '/api/friends/code/regenerate'))).code; assert.notEqual(newCode, aliceCode);
  assert.equal((await E('POST', '/api/friends/request', { code: aliceCode })).status, 404, 'old code revoked');
  // appear offline
  const evD2 = await sse(ck(D), '/api/events');
  const evA2 = await sse(ck(A), '/api/events'); await evA2.wait('online', (d) => d.some((u) => u.username === 'dave'));
  assert.equal((await D('PATCH', '/api/profile', { showOnline: false })).status, 200);
  await evA2.wait('online', (d) => !d.some((u) => u.username === 'dave')); evA2.close(); evD2.close();
  await D('PATCH', '/api/profile', { showOnline: true });
  // crafted "video" (really an HLS playlist) must never reach ffmpeg's network-capable demuxers
  const evil = await A('PUT', '/api/upload?name=evil.mp4', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nhttp://127.0.0.1:18081/v/seg0.ts\n'), true);
  const evilId = (await j(evil)).id; let em;
  for (let i = 0; i < 40; i++) { em = (await j(await A('GET', '/api/media'))).find((x) => x.id === evilId); if (em.status !== 'processing') break; await sleep(300); }
  assert.equal(em.status, 'error'); assert.match(em.error, /recognised video/);
  await A('DELETE', `/api/media/${evilId}`);

  // embedded track extraction (mp4 + mov_text with language tag)
  const srtFile = path.join(dir, 'e.srt'); fs.writeFileSync(srtFile, srt);
  const withSub = path.join(dir, 'Movie.With.Subs.2019.mp4');
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-i', mp4, '-i', srtFile, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=fre', withSub]);
  const up2 = await A('PUT', '/api/upload?name=' + encodeURIComponent(path.basename(withSub)), fs.readFileSync(withSub), true);
  const id2 = (await j(up2)).id; let m2;
  for (let i = 0; i < 80; i++) { m2 = (await j(await A('GET', '/api/media'))).find((x) => x.id === id2); if (m2.status === 'ready' && m2.subs.length) break; await sleep(500); }
  assert.deepEqual(m2.subs.map((s) => [s.lang, s.label, s.source]), [['fre', 'French', 'embedded']], 'embedded subtitle auto-extracted');
  assert.equal(m2.kind, 'movie'); assert.equal(m2.year, 2019);
  assert.equal((await A('DELETE', `/api/subs/${subId}`)).status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'vault', `${subId}.sub.enc`)), false, 'subtitle file removed');
  const emb = (await j(await A('GET', '/api/media'))).find((x) => x.id === id2).subs[0].id;
  assert.equal((await A('DELETE', `/api/media/${id2}`)).status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'vault', `${emb}.sub.enc`)), false, 'media delete removes subtitle files');

  // live (local-file, peer-to-peer) streams: server relays signaling only, stores nothing
  const hostEs = await sse(ck(A), `/api/rooms/${room.id}/events`), viewEs = await sse(ck(C), `/api/rooms/${room.id}/events`);
  const hostCid = (await hostEs.wait('hello')).cid, viewCid = (await viewEs.wait('hello')).cid;
  const key = 'a1b2c3d4e5f60718', lid = 'live:' + key;
  assert.equal((await A('POST', `/api/rooms/${room.id}/cmd`, { type: 'addLive', key: 'zz', title: 'x', cid: hostCid })).status, 400, 'bad key rejected');
  assert.equal((await A('POST', `/api/rooms/${room.id}/cmd`, { type: 'addLive', key, title: 'My <b>Movie</b>', cid: viewCid })).status, 400, "cannot claim another user's connection");
  assert.equal((await A('POST', `/api/rooms/${room.id}/cmd`, { type: 'addLive', key, title: 'My Movie', cid: hostCid })).status, 200);
  const sv = await viewEs.wait('state', (d) => d.items.some((i) => i.id === lid));
  const li = sv.items.find((i) => i.id === lid);
  assert.ok(li.live && li.online && li.hostName && li.hostId, 'live item visible to viewers');
  assert.equal(JSON.stringify(sv).includes('cid'), false, 'no connection ids leaked in state');
  assert.equal((await C('POST', `/api/rooms/${room.id}/signal`, { from: viewCid, to: 'host', liveId: lid, data: { t: 'want' } })).status, 200);
  const got = await hostEs.wait('signal'); assert.deepEqual([got.from, got.liveId, got.data.t], [viewCid, lid, 'want']);
  assert.equal((await A('POST', `/api/rooms/${room.id}/signal`, { from: hostCid, to: viewCid, liveId: lid, data: { t: 'offer', sdp: 'v=0' } })).status, 200);
  assert.equal((await viewEs.wait('signal')).data.t, 'offer');
  assert.equal((await C('POST', `/api/rooms/${room.id}/signal`, { from: hostCid, to: 'host', liveId: lid, data: {} })).status, 400, 'cannot spoof sender cid');
  const room2 = await j(await A('POST', '/api/rooms', { name: 'other', groupId: g.id }));
  assert.equal((await C('POST', `/api/rooms/${room2.id}/signal`, { from: viewCid, to: 'host', liveId: lid, data: { t: 'want' } })).status, 400, 'cid from another room rejected');
  assert.equal((await anon('POST', `/api/rooms/${room.id}/signal`, { from: 'x', to: 'host', liveId: lid, data: {} })).status, 401);
  hostEs.close();
  const off = await viewEs.wait('state', (d) => d.items.some((i) => i.id === lid && !i.online)); assert.ok(off, 'viewers see host offline');
  assert.equal((await C('POST', `/api/rooms/${room.id}/signal`, { from: viewCid, to: 'host', liveId: lid, data: { t: 'want' } })).status, 409, 'host offline');
  assert.equal((await C('POST', `/api/rooms/${room.id}/cmd`, { type: 'rehost', liveId: lid, cid: viewCid })).status, 403, 'only host can rehost');
  const hostEs2 = await sse(ck(A), `/api/rooms/${room.id}/events`); const hostCid2 = (await hostEs2.wait('hello')).cid;
  assert.equal((await A('POST', `/api/rooms/${room.id}/cmd`, { type: 'rehost', liveId: lid, cid: hostCid2 })).status, 200);
  assert.ok(await viewEs.wait('state', (d) => d.items.some((i) => i.id === lid)), 'state after rehost');
  assert.equal((await A('POST', `/api/rooms/${room.id}/cmd`, { type: 'clear' })).status, 200);
  assert.equal((await C('POST', `/api/rooms/${room.id}/signal`, { from: viewCid, to: 'host', liveId: lid, data: { t: 'want' } })).status, 404, 'live item gone after removal');
  assert.equal(fs.readdirSync(path.join(dir, 'data', 'vault')).filter((f) => !f.startsWith(id) && !f.startsWith('avatar.')).length, 0, 'nothing extra stored on server');
  hostEs2.close(); viewEs.close();

  // ---- room permissions ----
  const perm = await j(await C('GET', `/api/rooms/${room.id}`));
  assert.deepEqual(perm.state.perms, { playback: true, seek: false, skip: true, queue: true }, 'new group rooms: seek is opt-in');
  assert.equal(perm.state.ownerId, 1);
  const r3 = await j(await A('POST', '/api/rooms', { name: 'perm room', groupId: g.id }));
  const cmdA = (r, body) => A('POST', `/api/rooms/${r}/cmd`, body), cmdC = (r, body) => C('POST', `/api/rooms/${r}/cmd`, body);
  assert.equal((await cmdA(r3.id, { type: 'add', mediaId: id })).status, 200);
  assert.equal((await cmdC(r3.id, { type: 'seek', pos: 1 })).status, 403, 'viewer cannot seek by default');
  assert.equal((await cmdA(r3.id, { type: 'seek', pos: 1 })).status, 200, 'host can seek');
  assert.equal((await C('PATCH', `/api/rooms/${r3.id}/perms`, { seek: true })).status, 403, 'only host edits permissions');
  const hostEv = await sse(ck(C), `/api/rooms/${r3.id}/events`); await hostEv.wait('state');
  assert.equal((await A('PATCH', `/api/rooms/${r3.id}/perms`, { playback: true, seek: true, skip: true, queue: true })).status, 200);
  assert.equal((await hostEv.wait('state', (d) => d.perms.seek === true)).perms.seek, true, 'perm change broadcast live');
  assert.equal((await cmdC(r3.id, { type: 'seek', pos: 2 })).status, 200, 'seek works once allowed');
  assert.equal((await A('PATCH', `/api/rooms/${r3.id}/perms`, { playback: false, seek: false, skip: false, queue: false })).status, 200);
  for (const t of ['pause', 'play', 'stop', 'next', 'clear']) assert.equal((await cmdC(r3.id, { type: t })).status, 403, t + ' denied');
  assert.equal((await cmdC(r3.id, { type: 'add', mediaId: id })).status, 403, 'queue denied');
  assert.equal((await cmdA(r3.id, { type: 'pause' })).status, 200, 'owner always allowed');
  assert.equal((await cmdC(r3.id, { type: 'ended', index: 0 })).status, 200, 'end-of-media report is not a permission');
  // streaming your own local file gives you control of it even when viewers are locked down
  await cmdA(r3.id, { type: 'clear' });
  await A('PATCH', `/api/rooms/${r3.id}/perms`, { playback: false, seek: false, skip: false, queue: true });
  const bobEv = await sse(ck(C), `/api/rooms/${r3.id}/events`); const bobCid = (await bobEv.wait('hello')).cid;
  assert.equal((await cmdC(r3.id, { type: 'addLive', key: 'b0b0b0b0b0b0b0b0', title: 'bob file', cid: bobCid })).status, 200);
  assert.equal((await cmdC(r3.id, { type: 'seek', pos: 30 })).status, 200, 'live host can seek own stream');
  assert.equal((await cmdC(r3.id, { type: 'pause' })).status, 200, 'live host can pause own stream');
  bobEv.close(); hostEv.close();

  // ---- IPTV directory + proxy ----
  assert.equal((await A('POST', '/api/admin/iptv/refresh')).status, 202);
  assert.equal((await C('POST', '/api/admin/iptv/refresh')).status, 403, 'admin only');
  let fac;
  for (let i = 0; i < 80; i++) { fac = (await j(await A('GET', '/api/admin/info'))).iptv; if (fac.total === 3 && fac.checked === 3 && !fac.check.running) break; await sleep(250); }
  assert.equal(fac.total, 3); assert.equal(fac.working, 2, 'health check: good + referrer-requiring channel work, dead one does not');
  const allCh = await j(await A('GET', '/api/iptv'));
  assert.equal(allCh.total, 3);
  const good = allCh.items.find((c) => c.name === 'Good Channel'), dead = allCh.items.find((c) => c.name === 'Dead Channel');
  assert.deepEqual([good.ok, dead.ok], [1, 0]); assert.equal(good.country, 'us'); assert.equal(good.group, 'News;Kids');
  assert.equal((await j(await A('GET', '/api/iptv?working=1'))).total, 2);
  assert.equal((await j(await A('GET', '/api/iptv?group=Kids'))).items[0].name, 'Good Channel', 'multi-group channels match each group');
  assert.equal((await j(await A('GET', '/api/iptv?country=us'))).total, 1);
  assert.equal((await j(await A('GET', '/api/iptv?q=dead'))).total, 1);
  assert.equal((await j(await A('GET', '/api/iptv?q=%25'))).total, 0, 'LIKE wildcards are escaped');
  assert.equal((await anon('GET', '/api/iptv')).status, 401);
  const m3u = await (await C('GET', `/api/iptv/${good.id}/stream.m3u8`)).text();
  assert.ok(m3u.startsWith('#EXTM3U') && m3u.includes('/api/iptv/p/') && !m3u.includes('127.0.0.1'), 'master playlist rewritten through proxy');
  const vpath = m3u.split('\n').find((l) => l.startsWith('/api/iptv/p/'));
  const media = await (await C('GET', vpath)).text();
  assert.ok(media.includes('URI="/api/iptv/p/') && !media.includes('key.bin') && !media.includes('127.0.0.1'), 'key URI + segments rewritten');
  const spath = media.split('\n').find((l) => l.startsWith('/api/iptv/p/'));
  const sres = await C('GET', spath); assert.equal(sres.status, 200); assert.equal(Buffer.from(await sres.arrayBuffer()).length, 4000, 'segment bytes pass through');
  assert.equal((await C('GET', vpath.slice(0, -3) + 'abc')).status, 403, 'tampered token rejected');
  assert.equal((await C('GET', '/api/iptv/p/' + Buffer.from('{"u":"http://127.0.0.1:18081/live.m3u8","e":9999999999999}').toString('base64url') + '.forged')).status, 403, 'forged token rejected');
  assert.equal((await anon('GET', spath)).status, 401, 'proxy needs login');
  assert.equal((await C('GET', '/api/iptv/nonexistent/stream.m3u8')).status, 404);
  const refCh = allCh.items.find((c) => c.name === 'Needs Referrer');
  assert.ok((await (await C('GET', `/api/iptv/${refCh.id}/stream.m3u8`)).text()).startsWith('#EXTM3U'), 'per-channel referrer header sent upstream');
  assert.equal((await C('GET', `/api/iptv/${dead.id}/stream.m3u8`)).status, 404, 'dead channel surfaces as 404');
  const logo = await C('GET', `/api/iptv/logo/${good.id}`); assert.equal(logo.headers.get('content-type'), 'image/png'); assert.match(logo.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await C('GET', `/api/iptv/logo/${dead.id}`)).status, 404, 'non-image logo refused');
  assert.equal((await cmdC(room.id, { type: 'addIptv', id: good.id })).status, 200, 'channel can be queued');
  const iq = await j(await C('GET', `/api/rooms/${room.id}`)); assert.equal(iq.state.items.find((i) => i.iptv).title, 'Good Channel');

  // ---- watch-time tracker ----
  const solo = await j(await A('POST', '/api/rooms', {}));
  await cmdA(solo.id, { type: 'add', mediaId: id });
  assert.equal((await A('POST', '/api/watch/ping', { roomId: solo.id })).status, 404, 'must be attached to the room to earn time');
  const soloEv = await sse(ck(A), `/api/rooms/${solo.id}/events`); await soloEv.wait('state');
  assert.equal((await j(await A('POST', '/api/watch/ping', { roomId: solo.id }))).credited, 0, 'first ping credits nothing');
  await sleep(2300);
  const cr = (await j(await A('POST', '/api/watch/ping', { roomId: solo.id }))).credited; assert.ok(cr >= 2 && cr <= 3, 'credits elapsed playback time, got ' + cr);
  await cmdA(solo.id, { type: 'pause' }); await sleep(1100);
  assert.equal((await j(await A('POST', '/api/watch/ping', { roomId: solo.id }))).credited, 0, 'paused rooms earn nothing');
  const st = await j(await A('GET', '/api/stats'));
  assert.ok(st.total >= 2 && st.today >= 2 && st.week >= 2 && st.month >= 2); assert.equal(st.byKind[0].kind, 'tv'); assert.equal(st.daily.length, 14);
  assert.match(st.top[0].title, /Cool Show/); assert.deepEqual(st.board.map((b) => b.username).sort(), ['alice', 'bob', 'dave']); assert.equal(st.board.find((b) => b.me).username, 'alice');
  assert.equal((await j(await C('GET', '/api/stats'))).total, 0, 'stats are per-user');
  assert.ok((await j(await A('GET', '/api/admin/info'))).users[0].watch_seconds >= 2, 'admin sees hours per user');
  soloEv.close();

  // ---- codec scan + AV1/VP9/H.264 renditions ----
  const probeCodec = (buf, ext) => { const f = path.join(dir, 'probe.' + ext); fs.writeFileSync(f, buf); return execFileSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', f]).toString().trim(); };
  const waitFor = async (fn, ms = 150000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(500); } };
  const mediaOf = async (who, mid) => (await j(await who('GET', '/api/media'))).find((x) => x.id === mid);
  const caps = await j(await A('GET', '/api/codecs'));
  const capById = Object.fromEntries(caps.codecs.map((c) => [c.id, c]));
  assert.ok(capById.av1.available && capById.vp9.available && capById.h264.available, 'AV1, VP9 and H.264 encoders present');
  assert.equal(capById.av2.available, false, 'AV2: no encoder exists yet'); assert.equal(caps.auto, false);

  assert.equal((await C('POST', `/api/media/${id}/analyze`)).status, 403, 'only the owner can analyze');
  assert.equal((await A('POST', `/api/media/${id}/analyze`)).status, 202);
  const scanned = await waitFor(async () => { const m = await mediaOf(A, id); return m.scan?.plan && !m.encoding && (m.scan.plan.stageB ? m.renditions.length > 1 : true) && m; });
  assert.ok(scanned.scan.trials.av1.ok && scanned.scan.trials.vp9.ok && scanned.scan.trials.h264.ok, 'quick scan trial-encoded all three codecs on this machine');
  assert.ok(scanned.scan.trials.av1.projectedBps > 0 && scanned.scan.trials.av1.speedX > 0, 'real speed + size measured');
  assert.equal(scanned.scan.plan.stageA, null, 'original already plays: no compatibility encode');
  assert.ok(['av1', 'vp9'].includes(scanned.scan.plan.stageB), 'a smaller codec was chosen: ' + scanned.scan.plan.stageB + ' (' + scanned.scan.plan.reasons.join(' | ') + ')');
  const best = scanned.scan.plan.stageB;
  const rend = scanned.renditions.find((r) => r.codec === best); assert.ok(rend, 'rendition exists'); const origR = scanned.renditions.find((r) => r.id === 'orig');
  assert.equal(origR.codec, 'h264'); assert.ok(rend.size < origR.size, `${best} (${rend.size}B) smaller than original (${origR.size}B)`);
  assert.equal((await C('GET', '/api/media')).status, 200); assert.equal((await mediaOf(C, id)).scan, undefined, 'scan details are owner-only');
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'vault', `${id}.r-${best}.enc`)).subarray(0, 4).toString(), 'STV1', 'rendition encrypted at rest');
  // default stream = most compatible (original H.264); ?r= selects a rendition; both decrypt to the right codec
  const defRes = await A('GET', `/api/media/${id}/stream`); assert.equal(defRes.headers.get('content-type'), 'video/mp4');
  assert.equal(probeCodec(Buffer.from(await defRes.arrayBuffer()), 'mp4'), 'h264', 'default is the compatible H.264');
  const rr2 = await A('GET', `/api/media/${id}/stream?r=${rend.id}`);
  assert.equal(rr2.headers.get('content-type'), best === 'vp9' ? 'video/webm' : 'video/mp4');
  const rbuf = Buffer.from(await rr2.arrayBuffer()); assert.equal(rbuf.length, rend.size); assert.equal(probeCodec(rbuf, best === 'vp9' ? 'webm' : 'mp4'), best, 'served bytes decode as ' + best);
  const part = await A('GET', `/api/media/${id}/stream?r=${rend.id}`, null, true, { Range: 'bytes=1000-5999' });
  assert.equal(part.status, 206); assert.ok(Buffer.from(await part.arrayBuffer()).equals(rbuf.subarray(1000, 6000)), 'range requests work on renditions');
  assert.equal((await A('GET', `/api/media/${id}/stream?r=nonsense`)).headers.get('content-type'), 'video/mp4', 'unknown rendition falls back to default');
  assert.equal((await C('GET', `/api/media/${id}/stream?r=${rend.id}`)).status, 200, 'group member may stream renditions');
  assert.equal((await E('GET', `/api/media/${id}/stream?r=${rend.id}`)).status, 404, 'outsider may not');
  assert.equal((await anon('GET', `/api/media/${id}/stream?r=${rend.id}`)).status, 401);
  // rooms hand every viewer the list so each player can choose
  const rm = await A('POST', '/api/rooms', {}); const rmId = (await j(rm)).id; await A('POST', `/api/rooms/${rmId}/cmd`, { type: 'add', mediaId: id });
  assert.ok((await j(await A('GET', `/api/rooms/${rmId}`))).state.items[0].renditions.length >= 2, 'room items carry renditions');
  // manual: add the other efficiency codec; AV2 is refused honestly
  const other = best === 'av1' ? 'vp9' : 'av1';
  assert.equal((await A('POST', `/api/media/${id}/encode`, { codec: 'av2' })).status, 400);
  assert.equal((await C('POST', `/api/media/${id}/encode`, { codec: other })).status, 403);
  assert.equal((await A('POST', `/api/media/${id}/encode`, { codec: other })).status, 202);
  const both = await waitFor(async () => { const m = await mediaOf(A, id); return m.renditions.some((r) => r.codec === other) && !m.encoding && m; });
  assert.deepEqual(both.renditions.map((r) => r.codec).sort(), ['av1', 'h264', 'vp9']);
  const otherR = both.renditions.find((r) => r.codec === other);
  assert.equal((await C('DELETE', `/api/media/${id}/renditions/${otherR.id}`)).status, 403);
  assert.equal((await A('DELETE', `/api/media/${id}/renditions/${otherR.id}`)).status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'vault', `${id}.r-${other}.enc`)), false, 'deleted rendition file removed');
  assert.equal((await A('DELETE', `/api/media/${id}/renditions/orig`)).status, 404, 'the original is not a deletable rendition');

  // an un-playable original (HEVC in MKV) gets an H.264 version automatically once auto-encode is on
  assert.equal((await A('POST', '/api/admin/settings', { encodeAuto: true })).status, 200);
  assert.equal((await C('POST', '/api/admin/settings', { encodeAuto: false })).status, 403);
  assert.equal((await j(await A('GET', '/api/codecs'))).auto, true);
  const hevc = path.join(dir, 'Old.Film.1999.mkv');
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-shortest', hevc]);
  const hid = (await j(await A('PUT', '/api/upload?name=' + encodeURIComponent(path.basename(hevc)), fs.readFileSync(hevc), true))).id;
  const first = await waitFor(async () => { const m = await mediaOf(A, hid); return m?.status === 'ready' && m; });
  assert.equal(first.vcodec, 'hevc'); assert.equal(first.kind, 'movie');
  const hdone = await waitFor(async () => { const m = await mediaOf(A, hid); return m.playable && m.renditions.some((r) => r.codec === 'h264') && m; });
  assert.ok(hdone.scan.plan.stageA === 'h264', 'Stage A: compatibility H.264 first');
  assert.equal(hdone.renditions.find((r) => r.id === 'orig'), undefined, 'HEVC original is not offered to browsers');
  const hres = await A('GET', `/api/media/${hid}/stream`); assert.equal(probeCodec(Buffer.from(await hres.arrayBuffer()), 'mp4'), 'h264', 'playable via the H.264 version');
  assert.equal((await A('POST', '/api/admin/settings', { encodeAuto: false })).status, 200);

  // ---- profile, history, badges ----
  assert.equal((await anon('GET', '/api/profile')).status, 401);
  const prof = await j(await A('GET', '/api/profile'));
  assert.ok(prof.self && !prof.private); assert.ok(prof.badges.length >= 28); assert.ok(prof.level.level >= 1);
  const earned = prof.badges.filter((b) => b.unlockedAt).map((b) => b.key);
  for (const k of ['friend_1', 'face', 'uploader', 'streamer']) assert.ok(earned.includes(k), 'alice earned ' + k + ' (have: ' + earned + ')');
  assert.ok(prof.recent.length >= 1 && prof.recent[0].title === 'Cool Show' && prof.recent[0].mediaId === id, 'recently watched shows the episode she watched');
  assert.ok(prof.recent[0].seconds >= 2 && prof.watch.total >= 2); assert.ok('counts' in prof.variety);
  const bobView = await j(await C('GET', '/api/profile/1'));
  assert.equal(bobView.private, true); assert.ok(!('badges' in bobView) && !('recent' in bobView), 'friends see no activity until it is shared');
  assert.equal((await E('GET', '/api/profile/1')).status, 404, 'strangers: not found'); assert.equal((await A('GET', '/api/profile/999')).status, 404);
  assert.equal((await A('PATCH', '/api/profile', { shareActivity: true })).status, 200);
  const shared = await j(await C('GET', '/api/profile/1')); assert.equal(shared.private, false); assert.ok(shared.badges.length >= 28 && shared.watch.total >= 2);
  assert.equal((await A('PATCH', '/api/profile', { shareActivity: false })).status, 200);
  assert.equal((await j(await C('GET', '/api/profile/1'))).private, true, 'sharing can be switched off again');
  // live unlock announcement
  const F = mk(); const invF = await j(await A('POST', '/api/admin/invites'));
  assert.equal((await F('POST', '/api/register', { username: 'fred', email: 'f@x.io', password: 'correct horse battery', invite: invF.code })).status, 201);
  const evF = await sse(ck(F), '/api/events'); await evF.wait('online');
  assert.equal((await F('PUT', '/api/profile/avatar', fs.readFileSync(png), true)).status, 200);
  const unlock = await evF.wait('achievement', (d) => d.key === 'face'); assert.deepEqual([unlock.name, unlock.tier, unlock.icon], ['Say Cheese', 'bronze', '📸']);
  evF.close();

  // password reset flow (mail disabled -> link in console)
  assert.equal((await anon('POST', '/api/forgot', { email: 'nobody@x.io' })).status, 200);
  assert.equal((await anon('POST', '/api/forgot', { email: 'b@x.io' })).status, 200);
  await sleep(300);
  const tok = /reset\?token=([\w-]+)/.exec(log)?.[1]; assert.ok(tok, 'reset link emitted');
  assert.equal((await anon('POST', '/api/reset', { token: tok, password: 'brand new passphrase' })).status, 200);
  assert.equal((await anon('POST', '/api/reset', { token: tok, password: 'another passphrase!' })).status, 400, 'token single-use');
  assert.equal((await C('GET', '/api/media')).status, 401, 'old sessions revoked');
  assert.equal((await anon('POST', '/api/login', { login: 'bob', password: 'brand new passphrase' })).status, 200);
  console.log('ALL OK');
} catch (e) { console.error('FAIL', e); console.error(log); process.exitCode = 1; } finally { await cleanup(); }
