// Encrypted, ephemeral IRC-style chat.
//
//  * END-TO-END: the key is derived in the browser from a channel passphrase (PBKDF2-SHA256 600k -> AES-256-GCM). The server never sees
//    the passphrase, the key, nicknames or plaintext - only opaque ciphertext blobs, a public salt, and a verifier (a SHA-256 of a
//    separate half of the derived bits, so it can't be used to decrypt anything).
//  * RAM ONLY: ciphertext lives solely in this process's memory. It is never written to disk, the database, logs or the audit table.
//  * WIPED every 48h (fixed UTC-aligned windows): every buffer is zero-filled, every channel is deleted, every client is told to drop
//    its copy. After that there is nothing left anywhere to recover. A server restart is also a wipe.
//  * No account <-> nickname link is stored: users pick any nick, and it only ever exists inside encrypted payloads.
import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import * as sec from './security.js';

export const WIPE_MS = Math.max(1000, +process.env.CHAT_WIPE_MS || 48 * 3600 * 1000);
const MAX_CHANNELS = 50, MAX_MSGS = 500, MAX_CT = 2048, MAX_JOINED = 20;
const NAME_RE = /^#[a-z0-9_-]{1,24}$/;

const channels = new Map(); // name -> { salt:string, verifier:Buffer, msgs:[{id,ts,iv:Buffer,ct:Buffer}], nextId, members:Set<connId> }
const conns = new Map(); // connId -> { res, userId, joined:Set<name> }
let epoch = Math.floor(Date.now() / WIPE_MS);

export const nextWipe = () => (Math.floor(Date.now() / WIPE_MS) + 1) * WIPE_MS;
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function b64(s, bytes, what) {
  if (typeof s !== 'string' || s.length > 8192 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new HttpError(400, `bad ${what}`);
  const b = Buffer.from(s, 'base64');
  if (bytes != null && b.length !== bytes) throw new HttpError(400, `bad ${what}`);
  return b;
}
const chanName = (n) => { const v = String(n || '').toLowerCase(); if (!NAME_RE.test(v)) throw new HttpError(400, 'Channel names look like #lobby (letters, numbers, - _ up to 24)'); return v; };
const owned = (cid, user) => { const c = conns.get(String(cid || '')); if (!c || c.userId !== user.id) throw new HttpError(400, 'Unknown chat connection - reload the page'); return c; };

export function attach(user, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const cid = crypto.randomBytes(9).toString('base64url');
  conns.set(cid, { res, userId: user.id, joined: new Set() });
  send(res, 'hello', { cid, nextWipe: nextWipe(), wipeMs: WIPE_MS });
  const hb = setInterval(() => res.write(': hb\n\n'), 20000);
  req.on('close', () => {
    clearInterval(hb);
    const c = conns.get(cid);
    for (const n of c?.joined || []) channels.get(n)?.members.delete(cid);
    conns.delete(cid);
  });
}

export function status() { return { nextWipe: nextWipe(), wipeMs: WIPE_MS, channels: channels.size }; }

/** Existence + public salt, so a joiner can derive the key. (Channel names are not secret; contents are.) */
export function lookup(name) { const ch = channels.get(chanName(name)); return ch ? { exists: true, salt: ch.salt } : { exists: false }; }

export function join(user, body) {
  const name = chanName(body.name);
  const c = owned(body.cid, user);
  const fail = `chat-join:${user.id}`;
  if (sec.limited(fail, 10, 600000)) throw new HttpError(429, 'Too many wrong passphrases - wait a few minutes');
  const verifier = b64(body.verifier, 32, 'verifier');
  let ch = channels.get(name);
  if (!ch) {
    if (channels.size >= MAX_CHANNELS) throw new HttpError(429, 'The chat is full right now');
    const salt = body.salt;
    b64(salt, 16, 'salt');
    ch = { salt, verifier, msgs: [], nextId: 1, members: new Set() };
    channels.set(name, ch);
  } else if (!crypto.timingSafeEqual(ch.verifier, verifier)) {
    sec.hit(fail, 600000);
    throw new HttpError(403, 'Wrong passphrase for that channel');
  }
  if (!c.joined.has(name) && c.joined.size >= MAX_JOINED) throw new HttpError(400, 'Too many channels');
  c.joined.add(name);
  ch.members.add(String(body.cid));
  return { ok: true, salt: ch.salt, backlog: ch.msgs.map((m) => ({ id: m.id, ts: m.ts, iv: m.iv.toString('base64'), ct: m.ct.toString('base64') })) };
}

export function leave(user, body) {
  const c = owned(body.cid, user);
  const name = chanName(body.name);
  c.joined.delete(name);
  channels.get(name)?.members.delete(String(body.cid));
}

export function post(user, body) {
  const name = chanName(body.name);
  const c = owned(body.cid, user);
  const ch = channels.get(name);
  if (!ch || !c.joined.has(name)) throw new HttpError(403, 'Join the channel first');
  if (sec.limited(`chat-msg:${user.id}`, 12, 10000)) throw new HttpError(429, 'Slow down');
  sec.hit(`chat-msg:${user.id}`, 10000);
  const iv = b64(body.iv, 12, 'iv');
  const ct = b64(body.ct, null, 'ciphertext');
  if (ct.length < 17 || ct.length > MAX_CT) throw new HttpError(400, 'Message too long');
  const m = { id: ch.nextId++, ts: Date.now(), iv, ct };
  ch.msgs.push(m);
  while (ch.msgs.length > MAX_MSGS) { const old = ch.msgs.shift(); old.iv.fill(0); old.ct.fill(0); }
  const out = { chan: name, id: m.id, ts: m.ts, iv: iv.toString('base64'), ct: ct.toString('base64') };
  for (const cid of ch.members) { const t = conns.get(cid); if (t) send(t.res, 'msg', out); }
  return { id: m.id };
}

/** Destroy everything. Buffers are zeroed before being released. */
export function wipe() {
  for (const ch of channels.values()) { for (const m of ch.msgs) { m.iv.fill(0); m.ct.fill(0); } ch.verifier.fill(0); ch.msgs.length = 0; ch.members.clear(); }
  channels.clear();
  for (const c of conns.values()) { c.joined.clear(); send(c.res, 'wipe', { nextWipe: nextWipe() }); }
  console.log('[chat] 48h wipe complete - all channels and messages destroyed');
}

setInterval(() => {
  const e = Math.floor(Date.now() / WIPE_MS);
  if (e !== epoch) { epoch = e; wipe(); }
}, Math.max(250, Math.min(30000, WIPE_MS / 4))).unref();

export const stats = () => ({ channels: channels.size, connections: conns.size }); // counts only; used by tests
