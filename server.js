import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { get, all, run, tx, now, audit, setting, setSetting, isMember, canAccessMedia, canAccessRoom, newFriendCode } from './lib/db.js';
import * as social from './lib/social.js';
import * as avatar from './lib/avatar.js';
import * as encode from './lib/encode.js';
import * as chat from './lib/chat.js';
import * as ach from './lib/achievements.js';
import { buildProfile } from './lib/profile.js';
import { initVault, encryptStream } from './lib/vault.js';
import * as sec from './lib/security.js';
import { HttpError, attach, command, signal, closeRoom, roomSnapshot, inRoom, currentItem, setPerms, PERM_KEYS, DEFAULT_GROUP_PERMS } from './lib/rooms.js';
import * as iptv from './lib/iptv.js';
import * as stats from './lib/stats.js';
import * as presence from './lib/presence.js';
import * as meta from './lib/meta.js';
import * as ratings from './lib/ratings.js';
import * as dvr from './lib/dvr.js';
import * as free from './lib/free.js';
import * as M from './lib/media.js';
import { beforeIngest } from './lib/compliance.js';

initVault();
await M.startInternalServer();

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const statics = new Map();
for (const f of fs.readdirSync(PUBLIC)) {
  const ext = path.extname(f);
  statics.set('/' + f, { body: fs.readFileSync(path.join(PUBLIC, f)), type: { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream' });
}

// ---------- helpers ----------
const json = (res, status, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store' });
  res.end(b);
};
const need = (c, status, msg) => { if (!c) throw new HttpError(status, msg); };
const readJson = (req, limit = 1e6) =>
  new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isHttps = (req) => !!config.tls || config.cookieSecure || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');
const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',').pop().trim() : req.socket.remoteAddress);
const baseUrl = () => config.publicUrl || `${config.tls ? 'https' : 'http'}://${config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host}:${config.port}`;

const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));

function sessionUser(req) {
  const sid = parseCookies(req).st_sid;
  if (!sid) return null;
  const h = sec.sha256(sid);
  const row = get('SELECT u.id,u.username,u.email,u.name,u.is_admin,u.avatar_v,u.show_online,u.accept_requests,u.share_activity,u.friend_code,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?', h);
  if (!row || row.expires_at < now()) return null;
  if (row.expires_at - now() < config.sessionDays * 43200000) run('UPDATE sessions SET expires_at=? WHERE id_hash=?', now() + config.sessionDays * 86400000, h);
  return { id: row.id, username: row.username, email: row.email, name: row.name, isAdmin: !!row.is_admin, avatarV: row.avatar_v, showOnline: !!row.show_online, acceptRequests: !!row.accept_requests, shareActivity: !!row.share_activity, friendCode: row.friend_code };
}
function startSession(req, res, userId) {
  const sid = sec.token(32);
  run('INSERT INTO sessions(id_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', sec.sha256(sid), userId, now(), now() + config.sessionDays * 86400000);
  res.setHeader('Set-Cookie', `st_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionDays * 86400}${isHttps(req) ? '; Secure' : ''}`);
}
const clearCookie = (req, res) => res.setHeader('Set-Cookie', `st_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);
setInterval(() => { run('DELETE FROM sessions WHERE expires_at<?', now()); run('DELETE FROM resets WHERE expires_at<?', now()); }, 3600000).unref();

const pubUser = (u) => ({ id: u.id, username: u.username, name: u.name, email: u.email, isAdmin: u.isAdmin, avatar: u.avatarV || null, showOnline: u.showOnline, acceptRequests: u.acceptRequests, shareActivity: u.shareActivity });
const pubMedia = (m, uid, groupsByMedia, subsByMedia, nm) => ({
  id: m.id, rkey: ratings.keyForMedia(m), title: m.title, kind: m.kind, show: m.show, season: m.season, episode: m.episode, year: m.year,
  duration: m.duration, width: m.width, height: m.height, vcodec: m.vcodec, acodec: m.acodec, size: m.size,
  playable: !!m.playable, status: m.status, error: m.error, source: m.src, hasThumb: !!m.thumb_path, createdAt: m.created_at,
  owner: nm(m.owner_id, m.owner_name), owned: m.owner_id === uid, groups: m.owner_id === uid ? groupsByMedia.get(m.id) || [] : undefined,
  progress: M.progress.get(m.id)?.p, encoding: M.progress.get(m.id)?.codec, renditions: M.renditionsOf(m), scan: m.owner_id === uid && m.scan ? JSON.parse(m.scan) : undefined,
  subs: subsByMedia.get(m.id) || [], ...posterOf(m),
});
const posterOf = (m) => { const p = m.kind === 'tv' ? meta.peek('tv', m.show) : m.kind === 'movie' ? meta.peek('movie', m.title, m.year) : null; return p ? { poster: p.poster, score: p.score } : {}; };

function ownedMedia(user, id) {
  const m = get('SELECT * FROM media WHERE id=?', id);
  need(m, 404, 'Not found');
  need(m.owner_id === user.id, 403, 'Only the owner can do that');
  return m;
}
function roomFor(user, id) {
  const r = get('SELECT * FROM rooms WHERE id=?', id);
  need(r && canAccessRoom(user.id, r), 404, 'Room not found');
  return r;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, opts, fn) => routes.push({ methods: [].concat(method), re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), opts, fn });
const AUTH = { auth: true };
const ADMIN = { auth: true, admin: true };
const PUB = {};

// --- session / account ---
route('GET', '/api/me', PUB, async ({ res, user }) => {
  json(res, 200, { user: user ? pubUser(user) : null, firstRun: !get('SELECT 1 FROM users LIMIT 1'), openSignup: setting('open_signup') === '1', mailEnabled: sec.mailEnabled });
});

route('POST', '/api/register', PUB, async ({ req, res, body }) => {
  const ip = clientIp(req);
  need(!sec.limited('reg:' + ip, 10, 3600000), 429, 'Too many attempts, try later');
  sec.hit('reg:' + ip, 3600000);
  const username = str(body.username, 32), email = str(body.email, 200).toLowerCase(), name = str(body.name, 60) || username;
  need(/^[A-Za-z0-9_.-]{3,32}$/.test(username), 400, 'Username: 3-32 chars, letters/numbers/._-');
  need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, 'Invalid email');
  const pwErr = sec.passwordProblem(body.password);
  need(!pwErr, 400, pwErr);
  const first = !get('SELECT 1 FROM users LIMIT 1');
  let inviteHash = null;
  if (!first && setting('open_signup') !== '1') {
    inviteHash = sec.sha256(str(body.invite, 100));
    need(get('SELECT 1 FROM invites WHERE code_hash=? AND used_by IS NULL AND expires_at>?', inviteHash, now()), 403, 'Valid invite code required');
  }
  need(!get('SELECT 1 FROM users WHERE username=? OR email=?', username, email), 409, 'Username or email already in use');
  const hash = await sec.hashPassword(body.password);
  const id = tx(() => {
    const r = run('INSERT INTO users(username,email,name,pass_hash,is_admin,created_at,friend_code) VALUES(?,?,?,?,?,?,?)', username, email, name, hash, first ? 1 : 0, now(), newFriendCode());
    if (inviteHash) run('UPDATE invites SET used_by=? WHERE code_hash=?', r.lastInsertRowid, inviteHash);
    return Number(r.lastInsertRowid);
  });
  audit(id, 'register', first ? 'first user (admin)' : '');
  startSession(req, res, id);
  json(res, 201, { ok: true });
});

route('POST', '/api/login', PUB, async ({ req, res, body }) => {
  const login = str(body.login, 200).toLowerCase();
  const ipKey = 'login-ip:' + clientIp(req), userKey = 'login-u:' + login;
  need(!sec.limited(ipKey, 20, 900000) && !sec.limited(userKey, 8, 900000), 429, 'Too many failed attempts. Try again in 15 minutes.');
  const u = get('SELECT * FROM users WHERE username=? OR email=?', login, login);
  const ok = u ? await sec.verifyPassword(String(body.password || ''), u.pass_hash) : (await sec.verifyPassword(String(body.password || ''), await sec.DUMMY_HASH), false);
  if (!ok) { sec.hit(ipKey, 900000); sec.hit(userKey, 900000); throw new HttpError(401, 'Invalid credentials'); }
  sec.clearHits(userKey);
  startSession(req, res, u.id);
  json(res, 200, { ok: true });
});

route('POST', '/api/logout', AUTH, async ({ req, res }) => {
  const sid = parseCookies(req).st_sid;
  if (sid) run('DELETE FROM sessions WHERE id_hash=?', sec.sha256(sid));
  clearCookie(req, res);
  json(res, 200, { ok: true });
});

route('POST', '/api/forgot', PUB, async ({ req, res, body }) => {
  const ip = clientIp(req);
  need(!sec.limited('forgot:' + ip, 5, 3600000), 429, 'Too many requests, try later');
  sec.hit('forgot:' + ip, 3600000);
  const email = str(body.email, 200).toLowerCase();
  const u = get('SELECT * FROM users WHERE email=?', email);
  if (u) {
    const t = sec.token(32);
    run('DELETE FROM resets WHERE user_id=?', u.id);
    run('INSERT INTO resets(token_hash,user_id,expires_at) VALUES(?,?,?)', sec.sha256(t), u.id, now() + 3600000);
    sec.sendMail(u.email, 'ShowTime password reset', `Hi ${u.name},\n\nReset your password (valid 1 hour):\n${baseUrl()}/#/reset?token=${t}\n\nIf you didn't ask for this, ignore this email.`).catch((e) => console.error('[mail]', e.message));
  }
  json(res, 200, { ok: true }); // identical response whether or not the account exists
});

route('POST', '/api/reset', PUB, async ({ req, res, body }) => {
  need(!sec.limited('reset:' + clientIp(req), 10, 3600000), 429, 'Too many attempts');
  sec.hit('reset:' + clientIp(req), 3600000);
  const pwErr = sec.passwordProblem(body.password);
  need(!pwErr, 400, pwErr);
  const h = sec.sha256(str(body.token, 100));
  const r = get('SELECT * FROM resets WHERE token_hash=? AND used=0 AND expires_at>?', h, now());
  need(r, 400, 'Reset link invalid or expired');
  const hash = await sec.hashPassword(body.password);
  tx(() => {
    run('UPDATE users SET pass_hash=? WHERE id=?', hash, r.user_id);
    run('UPDATE resets SET used=1 WHERE token_hash=?', h);
    run('DELETE FROM sessions WHERE user_id=?', r.user_id);
  });
  audit(r.user_id, 'password-reset');
  json(res, 200, { ok: true });
});

route('POST', '/api/password', AUTH, async ({ req, res, user, body }) => {
  const u = get('SELECT * FROM users WHERE id=?', user.id);
  need(await sec.verifyPassword(String(body.current || ''), u.pass_hash), 403, 'Current password incorrect');
  const pwErr = sec.passwordProblem(body.password);
  need(!pwErr, 400, pwErr);
  const hash = await sec.hashPassword(body.password);
  const keep = sec.sha256(parseCookies(req).st_sid);
  tx(() => { run('UPDATE users SET pass_hash=? WHERE id=?', hash, user.id); run('DELETE FROM sessions WHERE user_id=? AND id_hash<>?', user.id, keep); });
  json(res, 200, { ok: true });
});

// --- admin ---
route('GET', '/api/admin/info', ADMIN, async ({ res }) => {
  json(res, 200, {
    users: all('SELECT id,username,email,name,is_admin,created_at,(SELECT COALESCE(SUM(seconds),0) FROM watch_day w WHERE w.user_id=users.id) AS watch_seconds FROM users ORDER BY id'),
    iptv: { ...iptv.facets(), check: iptv.checkState },
    mediaDirs: config.mediaDirs, ffmpeg: await M.ffmpegAvailable(), mailEnabled: sec.mailEnabled, openSignup: setting('open_signup') === '1',
    encode: { auto: setting('encode_auto', config.encodeAuto ? '1' : '0') === '1', budgetX: config.encodeBudgetX, codecs: await encode.codecCapabilities() },
    invites: all('SELECT expires_at,used_by FROM invites ORDER BY expires_at DESC LIMIT 20'),
    meta: { enabled: meta.enabled(), tmdb: meta.hasTmdb() }, free: { total: get('SELECT COUNT(*) n FROM free').n }, dvr: { active: dvr.activeCount() },
  });
});
route('POST', '/api/admin/invites', ADMIN, async ({ res, user }) => {
  const code = sec.token(9);
  run('INSERT INTO invites(code_hash,created_by,expires_at) VALUES(?,?,?)', sec.sha256(code), user.id, now() + 7 * 86400000);
  audit(user.id, 'invite');
  json(res, 201, { code, url: `${baseUrl()}/#/register?invite=${code}` });
});
route('POST', '/api/admin/settings', ADMIN, async ({ res, body }) => {
  if ('openSignup' in body) setSetting('open_signup', body.openSignup ? '1' : '0');
  if ('encodeAuto' in body) setSetting('encode_auto', body.encodeAuto ? '1' : '0');
  if ('metaEnabled' in body) setSetting('meta_enabled', body.metaEnabled ? '1' : '0');
  if ('tmdbKey' in body) setSetting('tmdb_key', str(body.tmdbKey, 80).replace(/[^A-Za-z0-9]/g, ''));
  json(res, 200, { ok: true });
});
route('DELETE', '/api/admin/users/:id', ADMIN, async ({ res, user, params }) => {
  const id = +params.id;
  need(id !== user.id, 400, 'Cannot delete yourself');
  const t = get('SELECT * FROM users WHERE id=?', id);
  need(t, 404, 'No such user');
  for (const m of all('SELECT * FROM media WHERE owner_id=?', id)) await M.removeMediaFiles(m);
  await avatar.clearAvatar(id).catch(() => {});
  run('DELETE FROM users WHERE id=?', id);
  audit(user.id, 'delete-user', t.username);
  json(res, 200, { ok: true });
});
route('POST', '/api/admin/scan', ADMIN, async ({ res, user }) => {
  need(config.mediaDirs.length, 400, 'No MEDIA_DIRS configured');
  json(res, 200, { added: await M.scanLocal(user.id) });
});

// --- media ---
route('GET', '/api/media', AUTH, async ({ res, user }) => {
  const rows = all(
    `SELECT m.*, u.name AS owner_name FROM media m JOIN users u ON u.id=m.owner_id
     WHERE m.owner_id=? OR EXISTS(SELECT 1 FROM shares s JOIN group_members gm ON gm.group_id=s.group_id WHERE s.media_id=m.id AND gm.user_id=?)`,
    user.id, user.id,
  );
  const gm = new Map();
  for (const s of all('SELECT s.media_id,s.group_id FROM shares s JOIN media m ON m.id=s.media_id WHERE m.owner_id=?', user.id)) (gm.get(s.media_id) || gm.set(s.media_id, []).get(s.media_id)).push(s.group_id);
  const sm = new Map();
  for (const x of all('SELECT media_id,id,lang,label,source FROM subtitles ORDER BY label')) (sm.get(x.media_id) || sm.set(x.media_id, []).get(x.media_id)).push({ id: x.id, lang: x.lang, label: x.label, source: x.source });
  const nm = social.namer(user.id);
  json(res, 200, rows.map((m) => pubMedia(m, user.id, gm, sm, nm)));
});

route(['GET', 'HEAD'], '/api/media/:id/stream', AUTH, async ({ req, res, user, params, url }) => {
  need(canAccessMedia(user.id, params.id), 404, 'Not found');
  const m = get('SELECT * FROM media WHERE id=?', params.id);
  need(m.status === 'ready', 409, 'Not ready');
  const s = await M.resolveSource(m, 'play', url.searchParams.get('r')).catch(() => { throw new HttpError(404, 'File unavailable'); });
  await M.serveBlob(req, res, s.path, s.enc, s.mime);
});
route('GET', '/api/media/:id/thumb', AUTH, async ({ req, res, user, params }) => {
  need(canAccessMedia(user.id, params.id), 404, 'Not found');
  const m = get('SELECT thumb_path FROM media WHERE id=?', params.id);
  need(m?.thumb_path, 404, 'No thumbnail');
  await M.serveBlob(req, res, m.thumb_path, true, 'image/jpeg');
});

route('PUT', '/api/upload', AUTH, async ({ req, res, user, url }) => {
  const name = path.basename(str(url.searchParams.get('name'), 255)).replace(/[\x00-\x1f<>:"|?*\\/]/g, '_');
  const ext = path.extname(name).toLowerCase();
  need(M.VIDEO_EXT.has(ext), 400, 'Unsupported file type');
  const len = +req.headers['content-length'];
  need(!len || len <= config.maxUploadBytes, 413, 'File too large');
  const verdict = await beforeIngest({ userId: user.id, filename: name, source: 'upload' });
  need(verdict.allow, 403, verdict.reason || 'Upload not allowed');
  const id = M.newId();
  let size;
  try { size = await encryptStream(req, M.vaultPath(id), config.maxUploadBytes); } catch (e) { throw new HttpError(e.message === 'file too large' ? 413 : 400, e.message === 'file too large' ? 'File too large' : 'Upload failed'); }
  run(`INSERT INTO media(id,owner_id,title,filename,src,path,size,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, user.id, name, name, 'vault', M.vaultPath(id), size, 'processing', now());
  audit(user.id, 'upload', `${id} ${name}`);
  ach.evaluate(user.id);
  M.ingest(id);
  json(res, 201, { id });
});

route('PATCH', '/api/media/:id', AUTH, async ({ res, user, params, body }) => {
  const m = ownedMedia(user, params.id);
  const kind = ['movie', 'tv', 'video'].includes(body.kind) ? body.kind : m.kind;
  const n = (v) => (v === '' || v == null ? null : Number.isFinite(+v) ? Math.floor(+v) : null);
  run('UPDATE media SET title=?,kind=?,show=?,season=?,episode=?,year=? WHERE id=?', str(body.title, 200) || m.title, kind, str(body.show, 200) || null, n(body.season), n(body.episode), n(body.year), m.id);
  json(res, 200, { ok: true });
});
route('DELETE', '/api/media/:id', AUTH, async ({ res, user, params }) => {
  const m = ownedMedia(user, params.id);
  await M.removeMediaFiles(m); // files first (subtitle rows cascade with the media row)
  run('DELETE FROM media WHERE id=?', m.id); // never touches the user's original local file
  audit(user.id, 'delete-media', m.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/media/:id/convert', AUTH, async ({ res, user, params }) => {
  const m = ownedMedia(user, params.id);
  need(m.status === 'ready', 409, 'Busy');
  encode.autoEncode(m.id, { force: true });
  json(res, 202, { ok: true });
});
route('POST', '/api/media/:id/analyze', AUTH, async ({ res, user, params }) => {
  const m = ownedMedia(user, params.id);
  need(m.status === 'ready', 409, 'Busy');
  encode.autoEncode(m.id, { force: true });
  json(res, 202, { ok: true });
});
route('POST', '/api/media/:id/encode', AUTH, async ({ res, user, params, body }) => {
  const m = ownedMedia(user, params.id);
  need(m.status === 'ready', 409, 'Busy');
  need(['av1', 'vp9', 'h264'].includes(body.codec), 400, 'Pick av1, vp9 or h264 (AV2 has no encoder/decoder in FFmpeg or browsers yet)');
  need(!M.progress.has(m.id), 409, 'Already encoding this item');
  encode.encodeCodec(m.id, body.codec);
  json(res, 202, { ok: true });
});
route('DELETE', '/api/media/:id/renditions/:rid', AUTH, async ({ res, user, params }) => {
  const m = ownedMedia(user, params.id);
  const r = get('SELECT * FROM renditions WHERE id=? AND media_id=?', params.rid, m.id);
  need(r, 404, 'Not found');
  need(m.orig_playable || get('SELECT COUNT(*) c FROM renditions WHERE media_id=?', m.id).c > 1, 400, 'This is the only playable version');
  await fsp.rm(r.path, { force: true });
  run('DELETE FROM renditions WHERE id=?', r.id);
  json(res, 200, { ok: true });
});
route('GET', '/api/codecs', AUTH, async ({ res }) => json(res, 200, { codecs: await encode.codecCapabilities(), auto: setting('encode_auto', config.encodeAuto ? '1' : '0') === '1', budgetX: config.encodeBudgetX }));
route('POST', '/api/media/:id/share', AUTH, async ({ res, user, params, body }) => {
  const m = ownedMedia(user, params.id);
  const gid = +body.groupId;
  need(isMember(gid, user.id), 403, 'You are not in that group');
  if (body.share) run('INSERT OR IGNORE INTO shares(media_id,group_id) VALUES(?,?)', m.id, gid);
  else run('DELETE FROM shares WHERE media_id=? AND group_id=?', m.id, gid);
  audit(user.id, body.share ? 'share' : 'unshare', `${m.id} group ${gid}`);
  json(res, 200, { ok: true });
});

// --- groups ---
route('GET', '/api/groups', AUTH, async ({ res, user }) => {
  const gs = all('SELECT g.* FROM groups g JOIN group_members gm ON gm.group_id=g.id WHERE gm.user_id=? ORDER BY g.name', user.id);
  const fr = new Set(social.friendIds(user.id));
  json(res, 200, gs.map((g) => ({ id: g.id, name: g.name, owned: g.owner_id === user.id, members: all('SELECT u.id,u.username,u.name,u.avatar_v FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=?', g.id).map((u) => social.viewOf(user.id, u, fr)) })));
});
route('POST', '/api/groups', AUTH, async ({ res, user, body }) => {
  const name = str(body.name, 60);
  need(name, 400, 'Name required');
  const id = tx(() => {
    const r = run('INSERT INTO groups(name,owner_id,created_at) VALUES(?,?,?)', name, user.id, now());
    run('INSERT INTO group_members VALUES(?,?)', r.lastInsertRowid, user.id);
    return Number(r.lastInsertRowid);
  });
  json(res, 201, { id });
});
route('POST', '/api/groups/:id/members', AUTH, async ({ res, user, params, body }) => {
  const g = get('SELECT * FROM groups WHERE id=?', +params.id);
  need(g && g.owner_id === user.id, 403, 'Only the group owner can add members');
  const uid = +body.userId;
  need(uid && uid !== user.id && social.areFriends(user.id, uid), 403, 'You can only add people from your friends list');
  run('INSERT OR IGNORE INTO group_members VALUES(?,?)', g.id, uid);
  presence.refresh();
  json(res, 200, { ok: true });
});
route('DELETE', '/api/groups/:id/members/:uid', AUTH, async ({ res, user, params }) => {
  const g = get('SELECT * FROM groups WHERE id=?', +params.id);
  need(g && isMember(g.id, user.id), 404, 'Not found');
  const uid = +params.uid;
  need(uid === user.id || g.owner_id === user.id, 403, 'Not allowed');
  need(uid !== g.owner_id, 400, 'Owner cannot leave; delete the group instead');
  run('DELETE FROM group_members WHERE group_id=? AND user_id=?', g.id, uid);
  run('DELETE FROM room_invites WHERE to_id=? AND room_id IN (SELECT id FROM rooms WHERE group_id=?)', uid, g.id);
  presence.refresh();
  json(res, 200, { ok: true });
});
route('DELETE', '/api/groups/:id', AUTH, async ({ res, user, params }) => {
  const g = get('SELECT * FROM groups WHERE id=?', +params.id);
  need(g && g.owner_id === user.id, 403, 'Only the owner can delete a group');
  for (const r of all('SELECT id FROM rooms WHERE group_id=?', g.id)) closeRoom(r.id);
  run('DELETE FROM groups WHERE id=?', g.id);
  presence.refresh();
  json(res, 200, { ok: true });
});

// --- rooms ---
route('GET', '/api/rooms', AUTH, async ({ res, user }) => {
  json(res, 200, all(
    `SELECT r.id,r.name,r.group_id AS groupId,r.owner_id=? AS owned FROM rooms r
     WHERE r.owner_id=? OR r.group_id IN (SELECT group_id FROM group_members WHERE user_id=?) ORDER BY r.created_at DESC`, user.id, user.id, user.id,
  ).map((r) => ({ ...r, owned: !!r.owned })));
});
route('POST', '/api/rooms', AUTH, async ({ res, user, body }) => {
  const gid = body.groupId == null ? null : +body.groupId;
  if (gid == null) {
    const solo = get('SELECT id FROM rooms WHERE owner_id=? AND group_id IS NULL', user.id);
    if (solo) return json(res, 200, { id: solo.id });
  } else need(isMember(gid, user.id), 403, 'You are not in that group');
  const id = M.newId().slice(0, 12);
  const perms = JSON.stringify(gid == null ? Object.fromEntries(PERM_KEYS.map((k) => [k, true])) : DEFAULT_GROUP_PERMS);
  run('INSERT INTO rooms(id,name,owner_id,group_id,created_at,perms) VALUES(?,?,?,?,?,?)', id, gid == null ? 'My Room' : str(body.name, 60) || 'Watch Party', user.id, gid, now(), perms);
  json(res, 201, { id });
});
route('DELETE', '/api/rooms/:id', AUTH, async ({ res, user, params }) => {
  const r = get('SELECT * FROM rooms WHERE id=?', params.id);
  need(r && r.owner_id === user.id, 403, 'Only the owner can delete a room');
  closeRoom(r.id);
  run('DELETE FROM rooms WHERE id=?', r.id);
  json(res, 200, { ok: true });
});
route('PATCH', '/api/rooms/:id/perms', AUTH, async ({ res, user, params, body }) => {
  const r = get('SELECT * FROM rooms WHERE id=?', params.id);
  need(r && r.owner_id === user.id, 403, 'Only the room host can change permissions');
  const perms = Object.fromEntries(PERM_KEYS.map((k) => [k, !!body[k]]));
  run('UPDATE rooms SET perms=? WHERE id=?', JSON.stringify(perms), r.id);
  json(res, 200, { perms: setPerms(r.id, perms) });
});

// --- encrypted ephemeral chat (RAM only; the server only ever sees ciphertext; wiped every 48h) ---
route('GET', '/api/chat/events', AUTH, async ({ req, res, user }) => chat.attach(user, req, res));
route('GET', '/api/chat/status', AUTH, async ({ res }) => json(res, 200, chat.status()));
route('GET', '/api/chat/chan', AUTH, async ({ res, url }) => json(res, 200, chat.lookup(url.searchParams.get('name'))));
route('POST', '/api/chat/join', AUTH, async ({ res, user, body }) => json(res, 200, chat.join(user, body)));
route('POST', '/api/chat/leave', AUTH, async ({ res, user, body }) => { chat.leave(user, body); json(res, 200, { ok: true }); });
route('POST', '/api/chat/send', AUTH, async ({ res, user, body }) => json(res, 200, chat.post(user, body)));

// --- watch-time tracker ---
route('POST', '/api/watch/ping', AUTH, async ({ res, user, body }) => {
  const r = get('SELECT * FROM rooms WHERE id=?', str(body.roomId, 40));
  need(r && canAccessRoom(user.id, r) && inRoom(r.id, user.id), 404, 'Not in that room');
  json(res, 200, { credited: stats.ping(user.id, currentItem(r.id)) });
});
route('GET', '/api/stats', AUTH, async ({ res, user }) => json(res, 200, stats.statsFor(user)));

// --- live TV (IPTV) ---
route('GET', '/api/iptv', AUTH, async ({ res, url }) => {
  const g = (k) => str(url.searchParams.get(k), 100);
  json(res, 200, iptv.list({ q: g('q'), group: g('group'), country: g('country').toLowerCase(), working: url.searchParams.get('working') === '1', page: Math.max(1, +url.searchParams.get('page') || 1) }));
});
route('GET', '/api/iptv/facets', AUTH, async ({ res }) => json(res, 200, iptv.facets()));
route('GET', '/api/iptv/logo/:id', AUTH, async ({ res, params }) => iptv.serveLogo(res, params.id));
route('GET', '/api/iptv/p/:token', AUTH, async ({ req, res, params }) => {
  const t = iptv.readToken(params.token);
  need(t, 403, 'Bad or expired link');
  await iptv.proxy(req, res, t.u, t.s, { key: t.k ?? null, issuedAt: t.iat });
});
route('GET', '/api/iptv/:id/stream.m3u8', AUTH, async ({ req, res, params }) => {
  const c = get('SELECT id,url FROM iptv WHERE id=?', params.id);
  need(c, 404, 'Channel not found');
  await iptv.proxy(req, res, c.url, c.id, { forcePlaylist: true });
});
route('POST', '/api/iptv/:id/report', AUTH, async ({ res, user, params }) => {
  need(!sec.limited('iptv-report:' + user.id, 30, 3600000), 429, 'Too many reports');
  sec.hit('iptv-report:' + user.id, 3600000);
  need(get('SELECT 1 FROM iptv WHERE id=?', params.id), 404, 'Channel not found');
  json(res, 200, { marked: iptv.reportBroken(params.id) });
});
route('POST', '/api/admin/iptv/refresh', ADMIN, async ({ res, user }) => {
  audit(user.id, 'iptv-refresh');
  iptv.refreshAndCheck();
  json(res, 202, { ok: true });
});
route('POST', '/api/admin/iptv/check', ADMIN, async ({ res }) => { iptv.runCheck({ staleMs: 0 }); json(res, 202, { ok: true }); });

route('GET', '/api/rooms/:id', AUTH, async ({ res, user, params }) => {
  const r = roomFor(user, params.id);
  json(res, 200, { id: r.id, name: r.name, groupId: r.group_id, state: roomSnapshot(r.id, user.id) });
});
route('GET', '/api/rooms/:id/events', AUTH, async ({ req, res, user, params }) => {
  const r = roomFor(user, params.id);
  attach(r.id, user, req, res);
});
route('POST', '/api/rooms/:id/cmd', AUTH, async ({ res, user, params, body }) => {
  const r = roomFor(user, params.id);
  command(r, user, body || {});
  json(res, 200, { ok: true });
});

route('POST', '/api/rooms/:id/signal', AUTH, async ({ res, user, params, body }) => {
  signal(roomFor(user, params.id), user, body || {});
  json(res, 200, { ok: true });
});
route('GET', '/api/ice', AUTH, async ({ res }) => json(res, 200, { iceServers: config.iceServers }));

// --- friends (private friend codes; nobody is discoverable any other way) ---
const friendView = (userId) => {
  const o = social.overview(userId);
  return { ...o, friends: o.friends.map((u) => ({ id: u.id, name: u.name, username: u.username, avatar: u.avatar_v || null, online: u.show_online === 1 && presence.isOnline(u.id) })) };
};
route('GET', '/api/friends', AUTH, async ({ res, user }) => json(res, 200, friendView(user.id)));
route('POST', '/api/friends/request', AUTH, async ({ res, user, body }) => {
  const r = social.requestByCode(user, body.code, body.message);
  if (r.status === 'sent' && r.target) {
    presence.notify(r.target, 'friend-request', { alias: social.alias(user.id), message: str(body.message, 80) });
    presence.pushFriendState(r.target);
  }
  if (r.accepted) { presence.notify(r.target, 'friend-accepted', { name: user.name }); presence.refresh(); presence.pushFriendState(user.id); ach.evaluate(user.id); ach.evaluate(r.target); }
  json(res, 200, { status: r.status, accepted: !!r.accepted });
});
route('POST', '/api/friends/requests/:id/accept', AUTH, async ({ res, user, params }) => {
  const from = +params.id;
  social.respond(user, from, true);
  presence.notify(from, 'friend-accepted', { name: user.name });
  presence.refresh(); presence.pushFriendState(user.id);
  ach.evaluate(user.id); ach.evaluate(from);
  json(res, 200, { ok: true });
});
route('POST', '/api/friends/requests/:id/decline', AUTH, async ({ res, user, params, body }) => {
  social.respond(user, +params.id, false, !!body.block);
  presence.pushFriendState(user.id);
  json(res, 200, { ok: true });
});
route('DELETE', '/api/friends/requests/:id', AUTH, async ({ res, user, params }) => {
  run('DELETE FROM friend_requests WHERE from_id=? AND to_id=?', user.id, +params.id);
  presence.pushFriendState(+params.id);
  json(res, 200, { ok: true });
});
route('DELETE', '/api/friends/:id', AUTH, async ({ res, user, params }) => {
  social.unfriend(user.id, +params.id);
  presence.refresh();
  json(res, 200, { ok: true });
});
route('DELETE', '/api/blocks/:id', AUTH, async ({ res, user, params }) => {
  run('DELETE FROM blocks WHERE user_id=? AND blocked_id=?', user.id, +params.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/friends/code/regenerate', AUTH, async ({ res, user }) => {
  social.regenerateCode(user.id); // old code stops working immediately
  json(res, 200, { code: social.overview(user.id).code });
});
route('PATCH', '/api/profile', AUTH, async ({ res, user, body }) => {
  const name = str(body.name, 60) || user.name;
  const flag = (k, cur) => (k in body ? (body[k] ? 1 : 0) : cur ? 1 : 0);
  run('UPDATE users SET name=?,show_online=?,accept_requests=?,share_activity=? WHERE id=?', name, flag('showOnline', user.showOnline), flag('acceptRequests', user.acceptRequests), flag('shareActivity', user.shareActivity), user.id);
  presence.refresh();
  json(res, 200, { ok: true });
});
route('GET', '/api/profile', AUTH, async ({ res, user }) => {
  ach.evaluate(user.id); // catch up on anything earned before badges existed
  json(res, 200, buildProfile(user.id, user.id));
});
route('GET', '/api/profile/:id', AUTH, async ({ res, user, params }) => {
  const p = buildProfile(user.id, +params.id);
  need(p, 404, 'Not found'); // strangers and nonexistent users look the same
  json(res, 200, p);
});
route('PUT', '/api/profile/avatar', AUTH, async ({ req, res, user }) => {
  need(!sec.limited('avatar:' + user.id, 10, 3600000), 429, 'Too many changes - try later');
  sec.hit('avatar:' + user.id, 3600000);
  const buf = await readRaw(req, avatar.MAX_AVATAR_BYTES);
  try { await avatar.setAvatar(user.id, buf); } catch (e) { throw new HttpError(400, e.message); }
  presence.refresh();
  ach.evaluate(user.id);
  json(res, 200, { ok: true });
});
route('DELETE', '/api/profile/avatar', AUTH, async ({ res, user }) => { await avatar.clearAvatar(user.id); presence.refresh(); json(res, 200, { ok: true }); });
route('GET', '/api/avatars/:id', AUTH, async ({ req, res, user, params }) => {
  const id = +params.id;
  const u = get('SELECT avatar_v FROM users WHERE id=?', id);
  // strangers and nonexistent users are indistinguishable (both 404)
  need(u?.avatar_v && social.areFriends(user.id, id), 404, 'Not found');
  await M.serveBlob(req, res, avatar.avatarPath(id), true, 'image/jpeg');
});

// --- online presence + room invites ---
route('GET', '/api/events', AUTH, async ({ req, res, user, url }) => {
  const id = str(url.searchParams.get('d'), 32), name = str(url.searchParams.get('n'), 40).replace(/[ -<>]/g, '');
  presence.attach(user, req, res, /^[a-z0-9]{6,32}$/.test(id) ? { id, name: name || 'Device' } : null);
});

// --- my devices: send what you're watching to another device signed in to YOUR account ---
route('GET', '/api/devices', AUTH, async ({ res, user }) => json(res, 200, presence.devicesOf(user.id)));
route('POST', '/api/devices/:id/cast', AUTH, async ({ res, user, params, body }) => {
  const room = roomFor(user, str(body.roomId, 64));
  need(!sec.limited('cast:' + user.id, 30, 60000), 429, 'Slow down');
  sec.hit('cast:' + user.id, 60000);
  need(presence.cast(user.id, params.id, { roomId: room.id, roomName: room.name, from: str(body.from, 40) || 'another device' }), 404, 'That device is no longer online');
  json(res, 200, { ok: true });
});

// --- cast & crew, global ratings ---
route('GET', '/api/meta', AUTH, async ({ res, user, url }) => {
  need(!sec.limited('meta:' + user.id, 120, 60000), 429, 'Slow down');
  sec.hit('meta:' + user.id, 60000);
  json(res, 200, await meta.lookup(str(url.searchParams.get('kind'), 8), str(url.searchParams.get('title'), 120), +url.searchParams.get('year') || null));
});
route('GET', '/api/img', AUTH, async ({ res, url }) => meta.serveImage(res, str(url.searchParams.get('u'), 600)));
route('GET', '/api/ratings', AUTH, async ({ res, user }) => json(res, 200, ratings.summary(user.id)));
route('PUT', '/api/ratings', AUTH, async ({ req, res, user }) => {
  need(!sec.limited('rate:' + user.id, 120, 60000), 429, 'Slow down');
  sec.hit('rate:' + user.id, 60000);
  const body = await readJson(req, 2000);
  const r = ratings.rate(user.id, str(body.key, 160), body.stars);
  need(r, 400, 'Bad rating');
  json(res, 200, r);
});

// --- DVR (record live TV into your own library) ---
route('GET', '/api/dvr', AUTH, async ({ res, user }) => json(res, 200, dvr.list(user.id)));
route('POST', '/api/dvr', AUTH, async ({ res, user, body }) => json(res, 201, dvr.create(user.id, body)));
route('POST', '/api/dvr/:id/stop', AUTH, async ({ res, user, params }) => json(res, 200, dvr.stop(user.id, params.id)));
route('DELETE', '/api/dvr/:id', AUTH, async ({ res, user, params }) => { dvr.remove(user.id, params.id); json(res, 200, { ok: true }); });

// --- free movies (public-domain / Creative Commons, Internet Archive) ---
route('GET', '/api/free', AUTH, async ({ res, url }) => json(res, 200, free.list({ q: str(url.searchParams.get('q'), 100), page: Math.max(1, +url.searchParams.get('page') || 1) })));
route(['GET', 'HEAD'], '/api/free/:id/stream', AUTH, async ({ req, res, params }) => {
  need(free.exists(params.id), 404, 'Movie not found');
  if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' }); return res.end(); }
  await free.stream(req, res, params.id);
});
route('POST', '/api/admin/free/refresh', ADMIN, async ({ res, user }) => { audit(user.id, 'free-refresh'); free.refresh(); json(res, 202, { ok: true }); });

route('GET', '/api/rooms/:id/invitees', AUTH, async ({ res, user, params }) => {
  const r = roomFor(user, params.id);
  need(r.group_id != null, 400, 'Solo rooms cannot have guests - create a group room to invite people');
  const fr = new Set(social.friendIds(user.id));
  const rows = all('SELECT u.id,u.name,u.username,u.avatar_v FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? AND u.id<>?', r.group_id, user.id);
  // online status is only ever revealed between friends
  json(res, 200, rows.map((u) => ({ ...social.viewOf(user.id, u, fr), online: fr.has(u.id) && presence.isVisiblyOnline(u.id), inRoom: inRoom(r.id, u.id) })));
});

route('POST', '/api/rooms/:id/invite', AUTH, async ({ res, user, params, body }) => {
  const r = roomFor(user, params.id);
  need(r.group_id != null, 400, 'Solo rooms cannot have guests');
  need(!sec.limited('invite:' + user.id, 20, 60000), 429, 'Slow down - too many invites');
  sec.hit('invite:' + user.id, 60000);
  const target = get('SELECT id,name FROM users WHERE id=?', +body.userId);
  need(target && target.id !== user.id, 404, 'No such user');
  need(canAccessRoom(target.id, r), 403, "They are not in this room's group - add them to the group first");
  if (inRoom(r.id, target.id)) return json(res, 200, { delivered: false, already: true });
  run('INSERT INTO room_invites(room_id,from_id,to_id,created_at) VALUES(?,?,?,?) ON CONFLICT(room_id,from_id,to_id) DO UPDATE SET created_at=excluded.created_at', r.id, user.id, target.id, now());
  const inv = get('SELECT id FROM room_invites WHERE room_id=? AND from_id=? AND to_id=?', r.id, user.id, target.id);
  const online = social.areFriends(user.id, target.id) && presence.isVisiblyOnline(target.id);
  presence.notify(target.id, 'invite', { id: inv.id, roomId: r.id, roomName: r.name, from: presence.fromInfo(target.id, user.id) });
  audit(user.id, 'invite-room', `${r.id} -> ${target.id}`);
  json(res, 200, { delivered: online });
});

route('POST', '/api/invites/:id/respond', AUTH, async ({ res, user, params, body }) => {
  const inv = get('SELECT * FROM room_invites WHERE id=? AND to_id=?', +params.id, user.id);
  need(inv && inv.created_at > now() - presence.INVITE_TTL_MS, 404, 'Invite expired');
  const r = get('SELECT * FROM rooms WHERE id=?', inv.room_id);
  run('DELETE FROM room_invites WHERE id=?', inv.id);
  const accept = !!body.accept && !!r && canAccessRoom(user.id, r);
  presence.notify(inv.from_id, 'invite-result', { userName: social.nameFor(inv.from_id, user.id), roomName: r?.name, accepted: accept });
  json(res, 200, { roomId: accept ? r.id : null });
});

// --- subtitles ---
const readRaw = (req, limit) =>
  new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(new HttpError(413, 'File too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

route('GET', '/api/subs/:id', AUTH, async ({ req, res, user, params }) => {
  const s = get('SELECT * FROM subtitles WHERE id=?', params.id);
  need(s && canAccessMedia(user.id, s.media_id), 404, 'Not found');
  await M.serveBlob(req, res, s.path, true, 'text/vtt; charset=utf-8');
});
route('PUT', '/api/media/:id/subs', AUTH, async ({ req, res, user, params, url }) => {
  const m = ownedMedia(user, params.id);
  const name = path.basename(str(url.searchParams.get('name'), 255));
  const ext = path.extname(name).toLowerCase();
  need(M.SUB_UPLOAD_EXT.has(ext), 400, 'Use a .srt, .vtt, .ass or .ssa file');
  need(get('SELECT COUNT(*) c FROM subtitles WHERE media_id=?', m.id).c < 30, 400, 'Too many subtitle tracks');
  const buf = await readRaw(req, M.MAX_SUB_BYTES);
  need(buf.length, 400, 'Empty file');
  let vtt;
  try { vtt = await M.toVtt(buf, ext); } catch (e) { throw new HttpError(400, e.message); }
  const lang = M.normLang(url.searchParams.get('lang'));
  const id = await M.addSubtitle(m.id, { lang, label: M.cleanLabel(url.searchParams.get('label')) || name.replace(/\.[^.]+$/, ''), source: 'upload' }, vtt);
  audit(user.id, 'subtitle-upload', `${m.id} ${id}`);
  ach.evaluate(user.id);
  json(res, 201, { id });
});
route('DELETE', '/api/subs/:id', AUTH, async ({ res, user, params }) => {
  const s = get('SELECT * FROM subtitles WHERE id=?', params.id);
  need(s, 404, 'Not found');
  ownedMedia(user, s.media_id);
  await fsp.rm(s.path, { force: true });
  run('DELETE FROM subtitles WHERE id=?', s.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/media/:id/subs/extract', AUTH, async ({ res, user, params }) => {
  const m = ownedMedia(user, params.id);
  need(m.status === 'ready', 409, 'Busy');
  M.extractSubs(m.id);
  json(res, 202, { ok: true });
});

// ---------- dispatcher ----------
async function handler(req, res) {
  const secure = isHttps(req);
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const f = statics.get(url.pathname) || (url.pathname === '/' || !path.extname(url.pathname) ? statics.get('/index.html') : null);
      need(f, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.body.length, 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : f.body);
    }
    let matched = null, params = null, pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.methods.includes(req.method)) { matched = r; params = m.groups || {}; break; }
    }
    if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
    if (!['GET', 'HEAD'].includes(req.method)) {
      // CSRF: custom header forces a CORS preflight for cross-site callers; also verify Origin when sent
      need(req.headers['x-requested-with'] === 'showtime', 403, 'Bad request');
      const o = req.headers.origin;
      if (o) { let ok = false; try { ok = new URL(o).host === req.headers.host; } catch { /* bad origin */ } need(ok, 403, 'Cross-origin request blocked'); }
    }
    const user = sessionUser(req);
    if (matched.opts.auth) need(user, 401, 'Login required');
    if (matched.opts.admin) need(user.isAdmin, 403, 'Admin only');
    const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    await matched.fn({ req, res, url, params, user, body });
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Server error' });
  }
}

const server = config.tls ? https.createServer(config.tls, handler) : http.createServer(handler);
server.requestTimeout = 0; // long uploads / streams
server.headersTimeout = 30000;
// Plex-style auto-metadata: as soon as an upload is probed, fetch poster / cast / episode info in the background (title only leaves the server).
async function warmMeta(id) {
  const m = get('SELECT kind,show,title,year FROM media WHERE id=?', id);
  if (!m || !meta.enabled()) return;
  if (m.kind === 'tv' && m.show && m.show !== 'Unknown Show') {
    const j = await meta.lookup('tv', m.show);
    if (!j.found) return;
    for (const e of j.episodes || []) run(`UPDATE media SET title=? WHERE kind='tv' AND show=? AND season=? AND episode=? AND title LIKE 'Episode %'`, e.name, m.show, e.s, e.n);
  } else if (m.kind === 'movie') await meta.lookup('movie', m.title, m.year);
}
M.setReadyHook((id, ...rest) => { warmMeta(id).catch(() => {}); return encode.queueAuto(id, ...rest); });
setTimeout(async () => { // existing library: fill in whatever is missing, politely
  try {
    const seen = new Set();
    for (const m of all(`SELECT id,kind,show,title,year FROM media WHERE status='ready' AND kind IN ('tv','movie')`)) {
      const k = m.kind === 'tv' ? 'tv:' + m.show : `movie:${m.title}:${m.year}`;
      if (seen.has(k)) continue; seen.add(k);
      await warmMeta(m.id).catch(() => {}); await new Promise((r) => setTimeout(r, 800));
    }
  } catch { /* best effort */ }
}, 8000).unref();
encode.startEncodeJobs();
iptv.startIptvJobs();
free.startFreeJobs();
dvr.startDvrJobs().catch((e) => console.error('[dvr] failed to start:', e.message));
server.listen(config.port, config.host, () => {
  console.log(`ShowTime listening on ${config.tls ? 'https' : 'http'}://${config.host}:${config.port}`);
  if (!config.tls && config.host !== '127.0.0.1') console.log('[warn] plain HTTP on a network: put it behind a TLS reverse proxy (see README) or set TLS_CERT/TLS_KEY');
  if (!config.publicUrl) console.log('[note] set PUBLIC_URL so password-reset emails contain the right link');
  M.ffmpegAvailable().then((ok) => !ok && console.log('[warn] ffmpeg/ffprobe not found - imports will fail until installed'));
});
