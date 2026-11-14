// DVR: record a Live TV channel now, or schedule it, and drop the finished recording into the user's own encrypted library.
//
// ffmpeg never talks to the channel host directly. It reads from a loopback-only relay (key-protected, random port) that sits in
// front of the same SSRF-guarded HLS proxy the player uses - so a hostile playlist can't make ffmpeg touch your network.
// Limits: 2 recordings at once server-wide, 10 pending per user, 4 h each, size-capped. Recordings are private to their owner.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { get, all, run, now, audit, bump } from './db.js';
import * as iptv from './iptv.js';
import * as M from './media.js';
import { encryptStream } from './vault.js';
import { beforeIngest } from './compliance.js';
import { HttpError } from './errors.js';
import { notify } from './presence.js';

const MAX_CONCURRENT = 2, MAX_PENDING_PER_USER = 10, MAX_MINUTES = 240, MAX_BYTES = (+process.env.DVR_MAX_GB || 8) * 1e9;
const dir = () => path.join(config.dataDir, 'dvr');
const tmpTs = (id) => path.join(dir(), id + '.ts');
const active = new Map(); // id -> { proc, stop() }

// ---------- loopback relay for ffmpeg ----------
const KEY = crypto.randomBytes(24).toString('hex');
let relayPort = 0;
const isLoop = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
function startRelay() {
  const srv = http.createServer(async (req, res) => {
    if (req.headers['x-dvr-key'] !== KEY || !isLoop(req.socket.remoteAddress)) return res.writeHead(404).end();
    const u = new URL(req.url, 'http://x');
    try {
      let m;
      if ((m = /^\/api\/iptv\/p\/([^/]+)$/.exec(u.pathname))) {
        const t = iptv.readToken(m[1]);
        if (!t) return res.writeHead(403).end();
        return await iptv.proxy(req, res, t.u, t.s, { key: t.k ?? null, issuedAt: t.iat });
      }
      if ((m = /^\/api\/iptv\/([^/]+)\/stream\.m3u8$/.exec(u.pathname))) {
        const c = get('SELECT id,url FROM iptv WHERE id=?', decodeURIComponent(m[1]));
        if (!c) return res.writeHead(404).end();
        return await iptv.proxy(req, res, c.url, c.id, { forcePlaylist: true });
      }
      res.writeHead(404).end();
    } catch { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { relayPort = srv.address().port; srv.unref(); r(); }));
}

// ---------- public API ----------
const view = (r) => ({ id: r.id, chanId: r.chan_id, channel: r.chan_name, startAt: r.start_at, endAt: r.end_at, status: r.status, mediaId: r.media_id || null, bytes: r.bytes || 0, error: r.error || null });
export const list = (userId) => all('SELECT * FROM dvr WHERE user_id=? ORDER BY start_at DESC LIMIT 100', userId).map(view);

export function create(userId, { chanId, startAt, minutes }) {
  const c = get('SELECT id,name FROM iptv WHERE id=?', String(chanId || ''));
  if (!c) throw new HttpError(404, 'Channel not found');
  minutes = Math.round(+minutes);
  if (!(minutes >= 1 && minutes <= MAX_MINUTES)) throw new HttpError(400, `Length must be 1-${MAX_MINUTES} minutes`);
  const t = now();
  let start = startAt == null ? t : Math.round(+startAt);
  if (!Number.isFinite(start)) throw new HttpError(400, 'Bad start time');
  if (start < t - 60000) throw new HttpError(400, 'Start time is in the past');
  if (start > t + 14 * 86400000) throw new HttpError(400, 'Can only schedule 14 days ahead');
  if (start < t) start = t;
  if (get(`SELECT COUNT(*) n FROM dvr WHERE user_id=? AND status IN ('scheduled','recording')`, userId).n >= MAX_PENDING_PER_USER) throw new HttpError(429, 'Too many pending recordings');
  const id = crypto.randomBytes(8).toString('hex');
  run('INSERT INTO dvr(id,user_id,chan_id,chan_name,start_at,end_at,status,created_at) VALUES(?,?,?,?,?,?,?,?)', id, userId, c.id, c.name, start, start + minutes * 60000, 'scheduled', t);
  audit(userId, 'dvr-schedule', `${c.name} ${minutes}min`);
  tick();
  return view(get('SELECT * FROM dvr WHERE id=?', id));
}

/** Stop a running recording early (it is still saved) or cancel a scheduled one. */
export function stop(userId, id) {
  const r = get('SELECT * FROM dvr WHERE id=? AND user_id=?', id, userId);
  if (!r) throw new HttpError(404, 'Recording not found');
  if (r.status === 'scheduled') { run(`UPDATE dvr SET status='canceled' WHERE id=?`, id); return view(get('SELECT * FROM dvr WHERE id=?', id)); }
  if (r.status === 'recording') active.get(id)?.stop();
  return view(get('SELECT * FROM dvr WHERE id=?', id));
}
/** Remove the schedule entry. The saved video (if any) stays in the library. */
export function remove(userId, id) {
  const r = get('SELECT * FROM dvr WHERE id=? AND user_id=?', id, userId);
  if (!r) throw new HttpError(404, 'Recording not found');
  if (['scheduled', 'recording', 'processing'].includes(r.status)) throw new HttpError(409, 'Stop it first');
  run('DELETE FROM dvr WHERE id=?', id);
}

// ---------- recorder ----------
const setStatus = (id, status, extra = {}) => {
  run('UPDATE dvr SET status=?,error=?,media_id=COALESCE(?,media_id),bytes=COALESCE(?,bytes) WHERE id=?', status, extra.error ?? null, extra.mediaId ?? null, extra.bytes ?? null, id);
  const r = get('SELECT user_id FROM dvr WHERE id=?', id);
  if (r) notify(r.user_id, 'dvr', { id, status });
};

function record(r, legacy = false) {
  fs.mkdirSync(dir(), { recursive: true });
  const secs = Math.max(5, Math.ceil((r.end_at - now()) / 1000));
  const args = ['-hide_banner', '-loglevel', process.env.DVR_LOGLEVEL || 'error', '-nostdin', '-y',
    '-protocol_whitelist', 'http,tcp,crypto,data', '-allowed_extensions', 'ALL', ...(legacy ? [] : ['-extension_picky', '0']), // proxied segment URLs have no file extension
    '-headers', `X-DVR-Key: ${KEY}\r\n`,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '20000000',
    '-i', `http://127.0.0.1:${relayPort}/api/iptv/${encodeURIComponent(r.chan_id)}/stream.m3u8`,
    '-dn', '-sn', '-c', 'copy', '-t', String(secs), '-fs', String(Math.floor(MAX_BYTES)), '-f', 'mpegts', tmpTs(r.id)];
  const proc = spawn(config.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-600); });
  proc.stdin.on('error', () => {});
  const rec = { proc, stop: () => { try { proc.stdin.write('q'); } catch { /* gone */ } setTimeout(() => proc.kill(), 8000).unref(); } };
  active.set(r.id, rec);
  setStatus(r.id, 'recording');
  proc.on('error', (e) => { active.delete(r.id); setStatus(r.id, 'failed', { error: 'ffmpeg not available: ' + e.message }); });
  proc.on('close', (code) => { active.delete(r.id); if (!legacy && /Unrecognized option/i.test(err)) return record(r, true); // older ffmpeg without -extension_picky
    if (process.env.DVR_LOGLEVEL) console.error('[dvr] ffmpeg exit', code, err); finalize(r.id, err || ('ffmpeg exit ' + code)).catch((e) => setStatus(r.id, 'failed', { error: String(e.message).slice(0, 200) })); tick(); });
}

let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

function finalize(id, ffErr = '') {
  return serial(async () => {
    const r = get('SELECT * FROM dvr WHERE id=?', id);
    if (!r || r.status === 'canceled') return;
    const ts = tmpTs(id), mp4 = path.join(dir(), id + '.mp4');
    const size = fs.existsSync(ts) ? fs.statSync(ts).size : 0;
    if (size < 20 * 1024) { fs.rmSync(ts, { force: true }); return setStatus(id, 'failed', { error: 'The channel did not deliver any video' + (ffErr ? ': ' + ffErr.split('\n').pop().slice(0, 120) : '') }); }
    setStatus(id, 'processing', { bytes: size });
    const remuxed = await new Promise((res) => {
      const p = spawn(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', ts, '-c', 'copy', '-movflags', '+faststart', mp4], { stdio: 'ignore' });
      p.on('error', () => res(false)); p.on('close', (c) => res(c === 0 && fs.existsSync(mp4) && fs.statSync(mp4).size > 0));
    });
    const src = remuxed ? mp4 : ts;
    const stamp = new Date(r.start_at), p2 = (n) => String(n).padStart(2, '0');
    const label = `${stamp.getFullYear()}-${p2(stamp.getMonth() + 1)}-${p2(stamp.getDate())} ${p2(stamp.getHours())}-${p2(stamp.getMinutes())}`;
    const base = r.chan_name.replace(/[\x00-\x1f<>:"|?*\\/]/g, '_').slice(0, 80);
    const filename = `${base} - ${label}${remuxed ? '.mp4' : '.ts'}`;
    const verdict = await beforeIngest({ userId: r.user_id, filename, source: 'dvr' });
    if (!verdict.allow) { fs.rmSync(ts, { force: true }); fs.rmSync(mp4, { force: true }); return setStatus(id, 'failed', { error: verdict.reason || 'Not allowed' }); }
    const mid = M.newId();
    const bytes = await encryptStream(fs.createReadStream(src), M.vaultPath(mid), Infinity);
    run(`INSERT INTO media(id,owner_id,title,filename,src,path,size,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, mid, r.user_id, filename, filename, 'vault', M.vaultPath(mid), bytes, 'processing', now());
    fs.rmSync(ts, { force: true }); fs.rmSync(mp4, { force: true });
    audit(r.user_id, 'dvr-saved', `${mid} ${r.chan_name}`);
    bump(r.user_id, 'dvr_saved', 1);
    M.ingest(mid);
    setStatus(id, 'done', { mediaId: mid, bytes });
  });
}

function tick() {
  const t = now();
  for (const r of all(`SELECT * FROM dvr WHERE status='scheduled' AND start_at<=? ORDER BY start_at`, t)) {
    if (r.end_at <= t + 5000) { setStatus(r.id, 'failed', { error: 'Missed: the server was not recording at that time' }); continue; }
    if (active.size >= MAX_CONCURRENT) continue; // wait for a free slot (until its window passes)
    record(r);
  }
  for (const [id, a] of active) { const r = get('SELECT end_at FROM dvr WHERE id=?', id); if (!r) a.stop(); }
}

export async function startDvrJobs() {
  await startRelay();
  fs.mkdirSync(dir(), { recursive: true });
  for (const r of all(`SELECT id FROM dvr WHERE status IN ('recording','processing')`)) finalize(r.id, 'interrupted by a server restart').catch(() => {}); // salvage what was captured
  setInterval(tick, 5000).unref();
  tick();
}
export const activeCount = () => active.size;
