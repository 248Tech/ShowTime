// Watch-time tracker. Time is credited SERVER-side from real playback state, not from client-reported durations:
// a ping only counts if the user is attached to the room, the room is actually playing, and only for the time elapsed since their last ping.
import { get, all, run, bump } from './db.js';
import { evaluateSoon } from './achievements.js';
import { friends } from './presence.js';

const last = new Map(); // userId -> last ping ms (shared across tabs, so two tabs can't double-count)
const MAX_GAP_MS = 40000;
const MAX_CREDIT_S = 25;

const dayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** @param current { item, playing } from rooms.currentItem() */
export function ping(userId, current) {
  const t = Date.now();
  if (!current?.item || !current.playing) { last.delete(userId); return 0; }
  const prev = last.get(userId);
  last.set(userId, t);
  if (!prev || t - prev > MAX_GAP_MS) return 0;
  const secs = Math.min(Math.round((t - prev) / 1000), MAX_CREDIT_S);
  if (secs <= 0) return 0;
  const it = current.item;
  const kind = it.live ? 'live' : it.iptv ? 'iptv' : ['movie', 'tv', 'video'].includes(it.kind) ? it.kind : 'video';
  run('INSERT INTO watch_day(user_id,day,kind,seconds) VALUES(?,?,?,?) ON CONFLICT(user_id,day,kind) DO UPDATE SET seconds=seconds+excluded.seconds', userId, dayStr(), kind, secs);
  if (current.viewers >= 2) bump(userId, 'party_s', secs); // watching together
  const hr = new Date().getHours();
  if (hr < 5) bump(userId, 'night_s', secs); else if (hr < 8) bump(userId, 'early_s', secs);
  if (!it.live) run('INSERT INTO watch_title(user_id,ref,seconds,last_at) VALUES(?,?,?,?) ON CONFLICT(user_id,ref) DO UPDATE SET seconds=seconds+excluded.seconds,last_at=excluded.last_at', userId, it.id, secs, t);
  evaluateSoon(userId);
  return secs;
}

const sum = (uid, since) => get('SELECT COALESCE(SUM(seconds),0) s FROM watch_day WHERE user_id=?' + (since ? ' AND day>=?' : ''), ...(since ? [uid, since] : [uid])).s;

/** Everything about one person's watch time (no friend data) - used by the profile page. */
export function watchSummary(uid) {
  const today = new Date();
  const back = (n) => dayStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  const byDay = new Map(all('SELECT day,SUM(seconds) s FROM watch_day WHERE user_id=? AND day>=? GROUP BY day', uid, back(13)).map((r) => [r.day, r.s]));
  return {
    total: sum(uid), today: sum(uid, back(0)), week: sum(uid, back(6)), month: sum(uid, back(29)),
    byKind: all('SELECT kind,SUM(seconds) seconds FROM watch_day WHERE user_id=? GROUP BY kind ORDER BY seconds DESC', uid),
    daily: Array.from({ length: 14 }, (_, i) => { const day = back(13 - i); return { day, seconds: byDay.get(day) || 0 }; }),
  };
}

export function statsFor(user) {
  const today = new Date();
  const back = (n) => dayStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  const byDay = new Map(all('SELECT day,SUM(seconds) s FROM watch_day WHERE user_id=? AND day>=? GROUP BY day', user.id, back(13)).map((r) => [r.day, r.s]));
  const daily = Array.from({ length: 14 }, (_, i) => { const day = back(13 - i); return { day, seconds: byDay.get(day) || 0 }; });
  const top = all('SELECT ref,seconds FROM watch_title WHERE user_id=? ORDER BY seconds DESC LIMIT 25', user.id).map((r) => {
    if (r.ref.startsWith('iptv:')) { const c = get('SELECT name FROM iptv WHERE id=?', r.ref.slice(5)); return c && { title: c.name, kind: 'iptv', seconds: r.seconds }; }
    const m = get('SELECT title,show,kind FROM media WHERE id=?', r.ref);
    return m && { title: m.kind === 'tv' && m.show ? `${m.show} - ${m.title}` : m.title, kind: m.kind, seconds: r.seconds };
  }).filter(Boolean).slice(0, 8);
  const ids = [user.id, ...friends(user.id).map((u) => u.id)];
  const board = all(`SELECT u.id,u.name,u.username,COALESCE((SELECT SUM(seconds) FROM watch_day w WHERE w.user_id=u.id),0) AS seconds FROM users u WHERE u.id IN (${ids.map(() => '?').join(',')}) ORDER BY seconds DESC`, ...ids)
    .map((r) => ({ name: r.name, username: r.username, seconds: r.seconds, me: r.id === user.id }));
  return {
    total: sum(user.id), today: sum(user.id, back(0)), week: sum(user.id, back(6)), month: sum(user.id, back(29)),
    byKind: all('SELECT kind,SUM(seconds) seconds FROM watch_day WHERE user_id=? GROUP BY kind ORDER BY seconds DESC', user.id),
    daily, top, board,
  };
}
