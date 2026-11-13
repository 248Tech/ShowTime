import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.join(config.dataDir, 'vault'), { recursive: true });
fs.rmSync(path.join(config.dataDir, 'tmp'), { recursive: true, force: true }); // wipe leftover plaintext temp
fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'showtime.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, pass_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resets(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS invites(
  code_hash TEXT PRIMARY KEY, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL, used_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS media(
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'video', show TEXT, season INTEGER, episode INTEGER, year INTEGER,
  filename TEXT NOT NULL, src TEXT NOT NULL, path TEXT NOT NULL, play_path TEXT, thumb_path TEXT,
  duration REAL, vcodec TEXT, acodec TEXT, width INTEGER, height INTEGER, size INTEGER,
  playable INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'processing', error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS media_owner ON media(owner_id);
CREATE TABLE IF NOT EXISTS groups(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_members(
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, user_id));
CREATE TABLE IF NOT EXISTS shares(
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY(media_id, group_id));
CREATE TABLE IF NOT EXISTS rooms(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS room_invites(
  id INTEGER PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, UNIQUE(room_id, from_id, to_id));
CREATE TABLE IF NOT EXISTS subtitles(
  id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  lang TEXT, label TEXT NOT NULL, source TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS subtitles_media ON subtitles(media_id);
CREATE TABLE IF NOT EXISTS watch_day(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, kind TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, day, kind));
CREATE TABLE IF NOT EXISTS watch_title(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, ref TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, ref));
CREATE TABLE IF NOT EXISTS iptv(
  id TEXT PRIMARY KEY, tvg_id TEXT, name TEXT NOT NULL, logo TEXT, grp TEXT NOT NULL DEFAULT 'Undefined', country TEXT,
  url TEXT NOT NULL UNIQUE, referrer TEXT, ua TEXT, ok INTEGER, checked_at INTEGER);
CREATE INDEX IF NOT EXISTS iptv_name ON iptv(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS friends(
  a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  since INTEGER NOT NULL, PRIMARY KEY(a, b));
CREATE TABLE IF NOT EXISTS friend_requests(
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(from_id, to_id));
CREATE TABLE IF NOT EXISTS blocks(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, blocked_id));
CREATE TABLE IF NOT EXISTS renditions(
  id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, codec TEXT NOT NULL, container TEXT NOT NULL,
  path TEXT NOT NULL, width INTEGER, height INTEGER, bitrate INTEGER, size INTEGER, created_at INTEGER NOT NULL, UNIQUE(media_id, codec));
CREATE TABLE IF NOT EXISTS achievements(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, unlocked_at INTEGER NOT NULL, PRIMARY KEY(user_id, key));
CREATE TABLE IF NOT EXISTS counters(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, key));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id INTEGER, action TEXT NOT NULL, detail TEXT);
`);

const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('rooms', 'perms', 'TEXT');
addCol('media', 'orig_playable', 'INTEGER');
addCol('media', 'scan', 'TEXT');
addCol('users', 'avatar_v', 'INTEGER');
addCol('users', 'share_activity', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'friend_code', 'TEXT');
addCol('users', 'show_online', 'INTEGER NOT NULL DEFAULT 1');
addCol('users', 'accept_requests', 'INTEGER NOT NULL DEFAULT 1');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_friend_code ON users(friend_code)');

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
};
export const get = (sql, ...a) => stmt(sql).get(...a);
export const all = (sql, ...a) => stmt(sql).all(...a);
export const run = (sql, ...a) => stmt(sql).run(...a);
export const tx = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

export const now = () => Date.now();
export const audit = (userId, action, detail = '') => run('INSERT INTO audit(ts,user_id,action,detail) VALUES(?,?,?,?)', now(), userId ?? null, action, String(detail).slice(0, 500));
export const setting = (k, d = '') => get('SELECT value FROM settings WHERE key=?', k)?.value ?? d;
export const setSetting = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));

// ---- access control (single source of truth) ----
export const isMember = (groupId, userId) => !!get('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?', groupId, userId);

export const canAccessMedia = (userId, mediaId) =>
  !!get(
    `SELECT 1 FROM media m WHERE m.id=? AND (m.owner_id=? OR EXISTS(
       SELECT 1 FROM shares s JOIN group_members gm ON gm.group_id=s.group_id WHERE s.media_id=m.id AND gm.user_id=?))`,
    mediaId, userId, userId,
  );

export const canAccessRoom = (userId, room) => !!room && (room.owner_id === userId || (room.group_id != null && isMember(room.group_id, userId)));

// ---- friend codes: private, unguessable (~49 bits), shared OFF-platform; the only way two people can find each other ----
const FC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newFriendCode() {
  for (;;) {
    let c = '';
    for (const x of crypto.randomBytes(10)) c += FC[x % FC.length];
    if (!get('SELECT 1 FROM users WHERE friend_code=?', c)) return c;
  }
}
export const normalizeFriendCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
for (const u of all('SELECT id FROM users WHERE friend_code IS NULL')) run('UPDATE users SET friend_code=? WHERE id=?', newFriendCode(), u.id);

// ---- migration: legacy single "converted copy" (play_path) becomes an H.264 rendition; orig_playable = was the original itself playable ----
db.exec('UPDATE media SET orig_playable=CASE WHEN play_path IS NULL THEN playable ELSE 0 END WHERE orig_playable IS NULL');
for (const m of all('SELECT id,play_path,width,height,size,duration FROM media WHERE play_path IS NOT NULL')) {
  run('INSERT OR IGNORE INTO renditions(id,media_id,codec,container,path,width,height,bitrate,size,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    crypto.randomBytes(12).toString('hex'), m.id, 'h264', 'mp4', m.play_path, m.width, m.height, null, null, Date.now());
  run('UPDATE media SET play_path=NULL WHERE id=?', m.id);
}

export const bump = (userId, key, n = 1) => run('INSERT INTO counters(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=value+excluded.value', userId, key, n);
