// Encrypted-chat tests: real E2E crypto (same module the browser uses), server-blindness, no persistence, and a real wipe.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { deriveChannel, randomSalt, seal, open, b64, unb64 } from '../public/chatcrypto.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-'));
const PORT = +process.env.CHAT_TEST_PORT || 18090, B = `http://127.0.0.1:${PORT}`, WIPE = 20000; // generous: slow CI runners must finish the timed phase inside one window
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: path.join(dir, 'data'), IPTV_AUTO: '0', ENCODE_AUTO: '0', CHAT_WIPE_MS: String(WIPE) }, cwd: process.cwd() });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && !log.includes('listening'); i++) await sleep(100);

const mk = () => { let cookie = ''; const fn = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { 'X-Requested-With': 'showtime', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return r; }; fn.cookie = () => cookie; return fn; };
const sse = async (cookie, url) => {
  const ac = new AbortController(); const ev = []; const waiters = [];
  const r = await fetch(B + url, { headers: { Cookie: cookie }, signal: ac.signal });
  (async () => { let buf = ''; const dec = new TextDecoder(); try { for await (const c of r.body) { buf += dec.decode(c); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /event: ([\w-]+)\ndata: (.*)/.exec(blk); if (m) { ev.push({ type: m[1], data: JSON.parse(m[2]) }); waiters.splice(0).forEach((w) => w()); } } } } catch { /* aborted */ } })();
  const wait = async (type, pred = () => true, ms = 6000) => { const t0 = Date.now(); for (;;) { const f = ev.find((e) => e.type === type && pred(e.data) && !e.used); if (f) { f.used = true; return f.data; } if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + type); await new Promise((res) => { waiters.push(res); setTimeout(res, 100); }); } };
  return { wait, ev, close: () => ac.abort() };
};
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));

const A = mk(), Bo = mk(), anon = mk();
let ok = false;
try {
  assert.equal((await A('POST', '/api/register', { username: 'alice', email: 'a@x.io', password: 'correct horse battery' })).status, 201);
  const inv = await (await A('POST', '/api/admin/invites')).json();
  assert.equal((await Bo('POST', '/api/register', { username: 'bob', email: 'b@x.io', password: 'correct horse battery', invite: inv.code })).status, 201);
  for (const p of ['/api/chat/status', '/api/chat/events', '/api/chat/chan?name=%23lobby']) assert.equal((await anon('GET', p)).status, 401, 'chat needs login: ' + p);

  // derive everything up front (PBKDF2 is deliberately slow) so the timed phase is quick
  const salt = randomSalt(), PASS = 'correct horse battery staple';
  const alice = await deriveChannel('#lobby', PASS, salt), bob = await deriveChannel('#lobby', PASS, salt), eve = await deriveChannel('#lobby', 'wrong passphrase', salt);
  assert.equal(alice.verifier, bob.verifier, 'same passphrase+salt+channel -> same verifier'); assert.notEqual(alice.verifier, eve.verifier);
  const other = await deriveChannel('#other', PASS, salt); assert.notEqual(other.verifier, alice.verifier, 'channel name is mixed into the key');
  assert.equal(alice.verifier.length, 44);

  // wait for the start of a fresh wipe window so the whole timed phase fits inside it
  let st; for (;;) { st = await (await A('GET', '/api/chat/status')).json(); if (st.nextWipe - Date.now() > WIPE - 1500) break; await sleep(150); }
  assert.equal(st.wipeMs, WIPE); assert.equal(st.nextWipe % WIPE, 0, 'wipe windows are aligned');

  const evA = await sse(A.cookie(), '/api/chat/events'), evB = await sse(Bo.cookie(), '/api/chat/events'), evE = await sse(Bo.cookie(), '/api/chat/events');
  const hA = await evA.wait('hello'), hB = await evB.wait('hello'), hE = await evE.wait('hello');
  assert.ok(hA.cid && hA.cid !== hB.cid); assert.equal(hA.wipeMs, WIPE);

  assert.deepEqual(await (await A('GET', '/api/chat/chan?name=%23lobby')).json(), { exists: false });
  assert.equal((await A('POST', '/api/chat/join', { name: 'lobby', cid: hA.cid, salt, verifier: alice.verifier })).status, 400, 'bad channel name');
  assert.equal((await A('POST', '/api/chat/join', { name: '#lobby', cid: 'nope', salt, verifier: alice.verifier })).status, 400, 'unknown connection');
  assert.equal((await A('POST', '/api/chat/join', { name: '#lobby', cid: hB.cid, salt, verifier: alice.verifier })).status, 400, "can't use someone else's connection");
  assert.equal((await A('POST', '/api/chat/join', { name: '#lobby', cid: hA.cid, salt, verifier: alice.verifier })).status, 200, 'creator joins (creates) the channel');
  assert.deepEqual(await (await Bo('GET', '/api/chat/chan?name=%23LOBBY')).json(), { exists: true, salt }, 'names are case-insensitive; salt is public');
  assert.equal((await Bo('POST', '/api/chat/join', { name: '#lobby', cid: hE.cid, verifier: eve.verifier })).status, 403, 'wrong passphrase rejected');
  assert.equal((await Bo('POST', '/api/chat/send', { name: '#lobby', cid: hE.cid, iv: 'AAAAAAAAAAAAAAAA', ct: b64(new Uint8Array(40)) })).status, 403, 'cannot post without joining');
  const jb = await (await Bo('POST', '/api/chat/join', { name: '#lobby', cid: hB.cid, verifier: bob.verifier })).json(); assert.equal(jb.backlog.length, 0);

  // encrypted message: alice -> bob
  const MARK = 'TOP-SECRET-MARKER-98765';
  const sealed = await seal(alice.key, '#lobby', { t: 'm', n: 'Kernel1234', x: MARK });
  assert.ok(!sealed.ct.includes(MARK) && !atob(sealed.ct).includes(MARK), 'ciphertext does not contain the plaintext');
  assert.equal((await A('POST', '/api/chat/send', { name: '#lobby', cid: hA.cid, ...sealed })).status, 200);
  const got = await evB.wait('msg'); assert.equal(got.chan, '#lobby'); assert.ok(!JSON.stringify(got).includes(MARK), 'the wire carries only ciphertext');
  assert.ok(!JSON.stringify(got).includes('Kernel1234') && !JSON.stringify(got).includes('alice'), 'server sees no nick and no account name');
  assert.deepEqual(await open(bob.key, '#lobby', got.iv, got.ct), { t: 'm', n: 'Kernel1234', x: MARK }, 'bob decrypts it');
  assert.equal(await open(eve.key, '#lobby', got.iv, got.ct), null, 'wrong key cannot decrypt');
  assert.equal(await open(other.key, '#other', got.iv, got.ct), null, 'other channel cannot decrypt (AAD binds channel)');
  assert.equal(await open(bob.key, '#other', got.iv, got.ct), null, 'cannot replay into another channel');
  const tam = unb64(got.ct); tam[5] ^= 1; assert.equal(await open(bob.key, '#lobby', got.iv, b64(tam)), null, 'tampering is detected');
  const s2 = await seal(alice.key, '#lobby', { t: 'm', n: 'x', x: 'hi' }), s3 = await seal(alice.key, '#lobby', { t: 'm', n: 'x', x: 'a much longer message '.repeat(8) });
  assert.equal(unb64(s2.ct).length, 128 + 16, 'short messages are padded to a bucket'); assert.ok(unb64(s3.ct).length > unb64(s2.ct).length);

  // validation + abuse limits
  assert.equal((await A('POST', '/api/chat/send', { name: '#lobby', cid: hA.cid, iv: sealed.iv, ct: b64(new Uint8Array(3000)) })).status, 400, 'oversize');
  assert.equal((await A('POST', '/api/chat/send', { name: '#lobby', cid: hA.cid, iv: 'short', ct: sealed.ct })).status, 400, 'bad iv');
  let limited = false; for (let i = 0; i < 20 && !limited; i++) limited = (await A('POST', '/api/chat/send', { name: '#lobby', cid: hA.cid, ...s2 })).status === 429; assert.ok(limited, 'rate limited');

  // late joiner gets the encrypted backlog and can read it
  const evL = await sse(Bo.cookie(), '/api/chat/events'); const hL = await evL.wait('hello');
  const jlRes = await Bo('POST', '/api/chat/join', { name: '#lobby', cid: hL.cid, verifier: bob.verifier });
  const jl = await jlRes.json();
  assert.equal(jlRes.status, 200, 'late join failed: ' + JSON.stringify(jl) + ' (did the wipe window expire mid-test?)');
  assert.ok(jl.backlog.length >= 1); assert.equal((await open(bob.key, '#lobby', jl.backlog[0].iv, jl.backlog[0].ct)).x, MARK, 'backlog decrypts for someone with the passphrase');

  // NOTHING is persisted: scan every byte under the data dir for the plaintext and for the ciphertext
  const ctText = got.ct, ivText = got.iv;
  for (const f of files(path.join(dir, 'data'))) { const b = fs.readFileSync(f); assert.ok(!b.includes(MARK), 'plaintext found on disk in ' + f); assert.ok(!b.includes(ctText) && !b.includes(Buffer.from(ctText, 'base64')) && !b.includes(Buffer.from(ivText, 'base64')), 'ciphertext found on disk in ' + f); }
  console.log('  ok - plaintext and ciphertext appear nowhere in', files(path.join(dir, 'data')).length, 'files under the data dir');
  assert.ok(!log.includes(MARK) && !log.includes(ctText), 'nothing chat-related in server logs');

  // ---- the wipe ----
  const w = await evA.wait('wipe', () => true, WIPE + 3000); assert.ok(w.nextWipe > Date.now());
  await evB.wait('wipe', () => true, 6000).catch((e) => { console.log('evB events:', evB.ev.map((x) => x.type).join(','), '| evA:', evA.ev.map((x) => x.type).join(',')); throw e; });
  assert.deepEqual(await (await A('GET', '/api/chat/chan?name=%23lobby')).json(), { exists: false }, 'channel destroyed');
  assert.equal((await (await A('GET', '/api/chat/status')).json()).channels, 0);
  assert.equal((await A('POST', '/api/chat/send', { name: '#lobby', cid: hA.cid, ...s2 })).status, 403, 'old membership is gone');
  // re-creating the same channel starts completely empty (the old messages cannot come back)
  const fresh = await deriveChannel('#lobby', 'a totally new passphrase', randomSalt());
  const newSalt = randomSalt(); const again = await deriveChannel('#lobby', PASS, newSalt);
  const rj = await (await A('POST', '/api/chat/join', { name: '#lobby', cid: hA.cid, salt: newSalt, verifier: again.verifier })).json();
  assert.equal(rj.backlog.length, 0, 'nothing survives a wipe'); assert.notEqual(rj.salt, salt);
  assert.equal(await open(again.key, '#lobby', got.iv, got.ct), null, 'even the same passphrase cannot read pre-wipe ciphertext (new salt)');
  void fresh;
  evA.close(); evB.close(); evE.close(); evL.close();
  ok = true;
  console.log('CHAT OK');
} catch (e) { console.error('FAIL', e); console.error(log.slice(-1500)); process.exitCode = 1; } finally {
  srv.kill(); await new Promise((r) => srv.once('exit', r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite lock */ }
  process.exit(ok ? 0 : 1);
}
