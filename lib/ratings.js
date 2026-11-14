// Global star ratings (1-5), shared by everyone on this ShowTime server.
// Keyed by WHAT the title is, not by who owns the file, so two users with the same movie rate the same thing.
// Privacy: other people's individual votes are never exposed - only the average and the count.
import { get, all, run, now } from './db.js';
import { norm } from './meta.js';

export const KEY_RE = /^(show|movie|video|iptv|free):[a-z0-9:_.-]{1,140}$/;

/** Stable rating key for a library item. */
export function keyForMedia(m) {
  if (m.kind === 'tv') return 'show:' + (norm(m.show || m.title) || 'unknown');
  const t = norm(m.title) || 'unknown';
  return `${m.kind === 'movie' ? 'movie' : 'video'}:${t}${m.year ? ':' + m.year : ''}`;
}

/** { key: { avg, n, mine } } for every rated key (small: one row per distinct title). */
export function summary(userId) {
  const out = {};
  for (const r of all('SELECT key,AVG(stars) a,COUNT(*) n FROM ratings GROUP BY key')) out[r.key] = { avg: Math.round(r.a * 10) / 10, n: r.n };
  for (const r of all('SELECT key,stars FROM ratings WHERE user_id=?', userId)) (out[r.key] ||= { avg: r.stars, n: 1 }).mine = r.stars;
  return out;
}

export function rate(userId, key, stars) {
  if (!KEY_RE.test(key)) return null;
  stars = Math.round(+stars);
  if (!(stars >= 0 && stars <= 5)) return null;
  if (stars === 0) run('DELETE FROM ratings WHERE user_id=? AND key=?', userId, key);
  else run('INSERT INTO ratings(user_id,key,stars,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET stars=excluded.stars,updated_at=excluded.updated_at', userId, key, stars, now());
  const r = get('SELECT AVG(stars) a,COUNT(*) n FROM ratings WHERE key=?', key);
  return { key, avg: r.n ? Math.round(r.a * 10) / 10 : 0, n: r.n, mine: stars || undefined };
}
