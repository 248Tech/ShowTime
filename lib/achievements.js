// Achievements & badges. Everything is derived from data we already keep (watch time per day/title, friends, uploads...) plus a few
// counters; chat is deliberately never measured. Unlocks are stored once and announced live over the user's event stream.
import { get, all, run, now } from './db.js';
import { notify } from './presence.js';

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const H = 3600;

// unit: 'time' (value in seconds) | 'count'
export const DEFS = [
  // --- watching ---
  { key: 'first_reel', name: 'First Reel', desc: 'Watch your first minute', icon: '🎬', tier: 'bronze', group: 'Watching', unit: 'time', target: 60, v: (m) => m.seconds },
  { key: 'hour_1', name: 'Popcorn Starter', desc: 'Watch 1 hour in total', icon: '🍿', tier: 'bronze', group: 'Watching', unit: 'time', target: H, v: (m) => m.seconds },
  { key: 'hour_10', name: 'Couch Regular', desc: 'Watch 10 hours in total', icon: '🛋️', tier: 'silver', group: 'Watching', unit: 'time', target: 10 * H, v: (m) => m.seconds },
  { key: 'hour_24', name: 'Marathoner', desc: 'Watch a full day (24 hours) in total', icon: '🏃', tier: 'silver', group: 'Watching', unit: 'time', target: 24 * H, v: (m) => m.seconds },
  { key: 'hour_100', name: 'Cinephile', desc: 'Watch 100 hours in total', icon: '🎞️', tier: 'gold', group: 'Watching', unit: 'time', target: 100 * H, v: (m) => m.seconds },
  { key: 'hour_500', name: 'Screen Legend', desc: 'Watch 500 hours in total', icon: '👑', tier: 'platinum', group: 'Watching', unit: 'time', target: 500 * H, v: (m) => m.seconds },
  // --- variety ---
  { key: 'kinds_3', name: 'Genre Hopper', desc: 'Watch 3 different kinds of media (movies, TV, other videos, live TV, streams)', icon: '🎭', tier: 'silver', group: 'Variety', unit: 'count', target: 3, v: (m) => m.kinds },
  { key: 'movies_10', name: 'Movie Buff', desc: 'Watch 10 different movies', icon: '🎥', tier: 'silver', group: 'Variety', unit: 'count', target: 10, v: (m) => m.movies },
  { key: 'movies_50', name: 'Film Fanatic', desc: 'Watch 50 different movies', icon: '📽️', tier: 'gold', group: 'Variety', unit: 'count', target: 50, v: (m) => m.movies },
  { key: 'shows_5', name: 'Show Sampler', desc: 'Watch 5 different TV shows', icon: '📼', tier: 'bronze', group: 'Variety', unit: 'count', target: 5, v: (m) => m.shows },
  { key: 'binge_5', name: 'Binge Watcher', desc: 'Watch 5 episodes of the same show', icon: '📚', tier: 'silver', group: 'Variety', unit: 'count', target: 5, v: (m) => m.bestShowEpisodes },
  { key: 'binge_20', name: 'Series Addict', desc: 'Watch 20 episodes of the same show', icon: '🧠', tier: 'gold', group: 'Variety', unit: 'count', target: 20, v: (m) => m.bestShowEpisodes },
  { key: 'channels_5', name: 'Channel Surfer', desc: 'Watch 5 different live TV channels', icon: '📺', tier: 'bronze', group: 'Variety', unit: 'count', target: 5, v: (m) => m.channels },
  { key: 'channels_25', name: 'Remote Control Hero', desc: 'Watch 25 different live TV channels', icon: '🎛️', tier: 'silver', group: 'Variety', unit: 'count', target: 25, v: (m) => m.channels },
  { key: 'countries_5', name: 'Globe Trotter', desc: 'Watch live TV from 5 different countries', icon: '🌍', tier: 'silver', group: 'Variety', unit: 'count', target: 5, v: (m) => m.countries },
  { key: 'countries_15', name: 'World Tour', desc: 'Watch live TV from 15 different countries', icon: '🧭', tier: 'gold', group: 'Variety', unit: 'count', target: 15, v: (m) => m.countries },
  // --- social ---
  { key: 'friend_1', name: 'Plus One', desc: 'Make your first friend', icon: '🤝', tier: 'bronze', group: 'Social', unit: 'count', target: 1, v: (m) => m.friends },
  { key: 'friend_5', name: 'Social Butterfly', desc: 'Have 5 friends', icon: '🦋', tier: 'silver', group: 'Social', unit: 'count', target: 5, v: (m) => m.friends },
  { key: 'party_1', name: 'Watch Party', desc: 'Watch 10 minutes together with someone else in a room', icon: '🎉', tier: 'bronze', group: 'Social', unit: 'time', target: 600, v: (m) => m.party },
  { key: 'party_10h', name: 'Party Animal', desc: 'Spend 10 hours watching together', icon: '🥳', tier: 'gold', group: 'Social', unit: 'time', target: 10 * H, v: (m) => m.party },
  // --- habits ---
  { key: 'streak_3', name: 'On a Roll', desc: 'Watch something 3 days in a row', icon: '🔥', tier: 'bronze', group: 'Habits', unit: 'count', target: 3, v: (m) => m.streak },
  { key: 'streak_7', name: 'Weekly Habit', desc: 'Watch something 7 days in a row', icon: '📅', tier: 'silver', group: 'Habits', unit: 'count', target: 7, v: (m) => m.streak },
  { key: 'streak_30', name: 'Month of Movies', desc: 'Watch something 30 days in a row', icon: '🗓️', tier: 'gold', group: 'Habits', unit: 'count', target: 30, v: (m) => m.streak },
  { key: 'night_owl', name: 'Night Owl', desc: 'Watch 30 minutes between midnight and 5 am', icon: '🦉', tier: 'bronze', group: 'Habits', unit: 'time', target: 1800, v: (m) => m.night },
  { key: 'early_bird', name: 'Early Bird', desc: 'Watch 30 minutes between 5 am and 8 am', icon: '🌅', tier: 'bronze', group: 'Habits', unit: 'time', target: 1800, v: (m) => m.early },
  // --- creator ---
  { key: 'face', name: 'Say Cheese', desc: 'Set a profile picture', icon: '📸', tier: 'bronze', group: 'Creator', unit: 'count', target: 1, v: (m) => m.avatar },
  { key: 'uploader', name: 'Uploader', desc: 'Upload your first video', icon: '⬆️', tier: 'bronze', group: 'Creator', unit: 'count', target: 1, v: (m) => m.uploads },
  { key: 'librarian', name: 'Librarian', desc: 'Upload 10 videos', icon: '🗄️', tier: 'silver', group: 'Creator', unit: 'count', target: 10, v: (m) => m.uploads },
  { key: 'streamer', name: 'Streamer', desc: 'Stream a file from your computer to a room', icon: '📡', tier: 'bronze', group: 'Creator', unit: 'count', target: 1, v: (m) => m.liveHosted },
  { key: 'subtitle_savvy', name: 'Subtitle Savvy', desc: 'Upload a subtitle file', icon: '💬', tier: 'bronze', group: 'Creator', unit: 'count', target: 1, v: (m) => m.subtitles },
];
export const TIER_POINTS = { bronze: 10, silver: 25, gold: 50, platinum: 100 };

/** A "title" only counts as watched after a minute, so flicking past things doesn't inflate the badges. */
const MIN_TITLE_S = 60;

export function metrics(uid) {
  const m = {};
  m.seconds = get('SELECT COALESCE(SUM(seconds),0) s FROM watch_day WHERE user_id=?', uid).s;
  m.kinds = all('SELECT kind FROM watch_day WHERE user_id=? GROUP BY kind HAVING SUM(seconds)>=?', uid, MIN_TITLE_S).length;
  const refs = all('SELECT ref FROM watch_title WHERE user_id=? AND seconds>=?', uid, MIN_TITLE_S).map((r) => r.ref);
  const mediaIds = refs.filter((r) => !r.startsWith('iptv:'));
  const iptvIds = refs.filter((r) => r.startsWith('iptv:')).map((r) => r.slice(5));
  const q = (ids) => ids.map(() => '?').join(',');
  const media = mediaIds.length ? all(`SELECT kind,show FROM media WHERE id IN (${q(mediaIds)})`, ...mediaIds) : [];
  m.movies = media.filter((x) => x.kind === 'movie').length;
  const eps = new Map();
  for (const x of media) if (x.kind === 'tv') eps.set(x.show || 'Unknown Show', (eps.get(x.show || 'Unknown Show') || 0) + 1);
  m.shows = eps.size;
  m.bestShowEpisodes = Math.max(0, ...eps.values());
  const ch = iptvIds.length ? all(`SELECT country FROM iptv WHERE id IN (${q(iptvIds)})`, ...iptvIds) : [];
  m.channels = ch.length;
  m.countries = new Set(ch.map((c) => c.country).filter(Boolean)).size;
  m.friends = get('SELECT COUNT(*) c FROM friends WHERE a=?', uid).c;
  const ctr = Object.fromEntries(all('SELECT key,value FROM counters WHERE user_id=?', uid).map((r) => [r.key, r.value]));
  m.party = ctr.party_s || 0; m.night = ctr.night_s || 0; m.early = ctr.early_s || 0; m.liveHosted = ctr.live_hosted || 0;
  // best consecutive-day streak (a day counts after a minute of watching)
  const days = all('SELECT day FROM watch_day WHERE user_id=? GROUP BY day HAVING SUM(seconds)>=? ORDER BY day', uid, MIN_TITLE_S).map((r) => r.day);
  let best = 0, run_ = 0, prev = null;
  for (const d of days) {
    const t = new Date(d + 'T12:00:00');
    run_ = prev && Math.round((t - prev) / 86400000) === 1 ? run_ + 1 : 1;
    best = Math.max(best, run_); prev = t;
  }
  m.streak = best;
  m.uploads = get("SELECT COUNT(*) c FROM media WHERE owner_id=? AND src='vault'", uid).c;
  m.avatar = get('SELECT avatar_v FROM users WHERE id=?', uid)?.avatar_v ? 1 : 0;
  m.subtitles = get("SELECT COUNT(*) c FROM subtitles s JOIN media md ON md.id=s.media_id WHERE md.owner_id=? AND s.source='upload'", uid).c;
  return m;
}

export function progress(uid) {
  const m = metrics(uid);
  const unlocked = new Map(all('SELECT key,unlocked_at FROM achievements WHERE user_id=?', uid).map((r) => [r.key, r.unlocked_at]));
  return DEFS.map((d) => ({ key: d.key, name: d.name, desc: d.desc, icon: d.icon, tier: d.tier, group: d.group, unit: d.unit, target: d.target, value: Math.min(d.target, Math.floor(d.v(m))), unlockedAt: unlocked.get(d.key) || null, _hit: d.v(m) >= d.target }));
}

export function level(uid) {
  const score = all('SELECT key FROM achievements WHERE user_id=?', uid).reduce((a, r) => a + (TIER_POINTS[DEFS.find((d) => d.key === r.key)?.tier] || 0), 0);
  const lvl = Math.floor(Math.sqrt(score / 10)) + 1;
  const base = (lvl - 1) ** 2 * 10, next = lvl ** 2 * 10;
  return { score, level: lvl, into: score - base, span: next - base };
}

/** Unlock anything newly earned and tell the user. Returns the newly unlocked badges. */
export function evaluate(uid) {
  const fresh = [];
  for (const p of progress(uid)) {
    if (!p._hit || p.unlockedAt) continue;
    const r = run('INSERT OR IGNORE INTO achievements(user_id,key,unlocked_at) VALUES(?,?,?)', uid, p.key, now());
    if (r.changes) fresh.push(p);
  }
  for (const p of fresh) notify(uid, 'achievement', { key: p.key, name: p.name, desc: p.desc, icon: p.icon, tier: p.tier });
  return fresh;
}

const last = new Map();
/** Cheap trigger for hot paths (watch pings): evaluates at most every 30s per user. */
export function evaluateSoon(uid, minGapMs = 30000) {
  const t = Date.now();
  if (t - (last.get(uid) || 0) < minGapMs) return [];
  last.set(uid, t);
  return evaluate(uid);
}
export { dayKey };
