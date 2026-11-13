// Profile data: watch time, recently watched, what kinds of media you watch, level + badges.
// Visible to yourself; to an accepted friend only if you switched on "share my activity" (off by default).
import { get, all, canAccessMedia } from './db.js';
import { areFriends } from './social.js';
import { watchSummary } from './stats.js';
import { progress, level } from './achievements.js';
import { regionName } from './iptv.js';

const MIN_TITLE_S = 60;

function recent(viewerId, uid, selfView) {
  const out = [];
  for (const r of all('SELECT ref,seconds,last_at FROM watch_title WHERE user_id=? ORDER BY last_at DESC LIMIT 60', uid)) {
    if (out.length >= 12) break;
    if (r.ref.startsWith('iptv:')) {
      const c = get('SELECT id,name,grp,country,(logo IS NOT NULL) AS hasLogo FROM iptv WHERE id=?', r.ref.slice(5));
      if (c) out.push({ kind: 'iptv', title: c.name, sub: c.grp.split(';')[0], chan: c.id, hasLogo: !!c.hasLogo, seconds: r.seconds, lastAt: r.last_at, accessible: true });
      continue;
    }
    const m = get('SELECT id,title,kind,show,season,episode,year,(thumb_path IS NOT NULL) AS ht FROM media WHERE id=?', r.ref);
    if (!m) continue;
    const accessible = canAccessMedia(viewerId, m.id);
    if (selfView && !accessible) continue; // no longer shared with you
    const ep = m.season != null && m.episode != null ? `S${String(m.season).padStart(2, '0')}E${String(m.episode).padStart(2, '0')}` : '';
    out.push({ kind: m.kind, title: m.kind === 'tv' && m.show ? m.show : m.title, sub: m.kind === 'tv' ? [ep, m.title].filter(Boolean).join(' · ') : m.year ? String(m.year) : '', mediaId: accessible ? m.id : null, hasThumb: accessible && !!m.ht, seconds: r.seconds, lastAt: r.last_at, accessible });
  }
  return out;
}

function variety(uid) {
  const rows = all('SELECT ref,seconds FROM watch_title WHERE user_id=? AND seconds>=? ORDER BY seconds DESC', uid, MIN_TITLE_S);
  const movies = [], videos = [], channels = [], showMap = new Map(), cat = new Map(), ctry = new Map();
  for (const r of rows) {
    if (r.ref.startsWith('iptv:')) {
      const c = get('SELECT name,grp,country FROM iptv WHERE id=?', r.ref.slice(5));
      if (!c) continue;
      channels.push({ name: c.name, group: c.grp.split(';')[0], country: c.country ? regionName(c.country) : null, seconds: r.seconds });
      for (const g of c.grp.split(';')) cat.set(g, (cat.get(g) || 0) + r.seconds);
      if (c.country) ctry.set(c.country, (ctry.get(c.country) || 0) + r.seconds);
      continue;
    }
    const m = get('SELECT title,kind,show,year FROM media WHERE id=?', r.ref);
    if (!m) continue;
    if (m.kind === 'movie') movies.push({ title: m.title, year: m.year, seconds: r.seconds });
    else if (m.kind === 'tv') { const k = m.show || 'Unknown Show'; const s = showMap.get(k) || { show: k, episodes: 0, seconds: 0 }; s.episodes++; s.seconds += r.seconds; showMap.set(k, s); }
    else videos.push({ title: m.title, seconds: r.seconds });
  }
  const shows = [...showMap.values()].sort((a, b) => b.seconds - a.seconds);
  const top = (a) => a.slice(0, 40);
  return {
    counts: { movies: movies.length, shows: shows.length, episodes: shows.reduce((a, s) => a + s.episodes, 0), videos: videos.length, channels: channels.length, countries: ctry.size, categories: cat.size },
    movies: top(movies), shows: top(shows), videos: top(videos), channels: top(channels),
    categories: [...cat].map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds).slice(0, 12),
    countries: [...ctry].map(([code, seconds]) => ({ code, name: regionName(code), seconds })).sort((a, b) => b.seconds - a.seconds).slice(0, 12),
  };
}

/** @returns null when the viewer may not see this profile (strangers get nothing - not even a hint the account exists) */
export function buildProfile(viewerId, targetId) {
  const t = get('SELECT id,name,username,avatar_v,created_at,share_activity FROM users WHERE id=?', targetId);
  if (!t) return null;
  const self = viewerId === targetId;
  if (!self && !areFriends(viewerId, targetId)) return null;
  const base = { id: t.id, name: t.name, username: t.username, avatar: t.avatar_v || null, since: t.created_at, self, shareActivity: !!t.share_activity };
  if (!self && !t.share_activity) return { ...base, private: true };
  const badges = progress(t.id).map(({ _hit, ...b }) => b);
  return { ...base, private: false, watch: watchSummary(t.id), level: level(t.id), badges, recent: recent(viewerId, t.id, self), variety: variety(t.id) };
}
