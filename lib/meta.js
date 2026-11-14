// Show / movie metadata (summary, genres, cast & crew with headshots) + a locked-down image proxy.
//
// Sources (all public APIs, all fetched BY THIS SERVER so browsers never talk to third parties):
//   - TVMaze  : TV shows, no API key needed
//   - TMDB    : movies and TV, needs a free API key (TMDB_API_KEY env or the admin setting "tmdb_key")
// Privacy: only the title (+ year) is ever sent upstream, never user data. Admins can switch lookups off (setting "meta_enabled" = 0).
// Results are cached in SQLite (30 days; misses 1 day), headshots are served through /api/img with a strict host allow-list.
import { get, run, now, setting } from './db.js';
import { upstream, readCapped } from './iptv.js';
import { HttpError } from './errors.js';

const TVMAZE = (process.env.META_TVMAZE_BASE || 'https://api.tvmaze.com').replace(/\/+$/, '');
const TMDB = (process.env.META_TMDB_BASE || 'https://api.themoviedb.org').replace(/\/+$/, '');
const ITUNES = (process.env.META_ITUNES_BASE || 'https://itunes.apple.com').replace(/\/+$/, '');
const testing = process.env.SHOWTIME_TEST_ALLOW_PRIVATE_UPSTREAM === '1';
const DAY = 86400000;

export const enabled = () => setting('meta_enabled', '1') === '1';
const tmdbKey = () => (setting('tmdb_key', '') || process.env.TMDB_API_KEY || '').trim();
export const hasTmdb = () => !!tmdbKey();

export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 80);

const getJson = async (url) => JSON.parse((await readCapped(await upstream(url, { timeout: 10000, headers: { Accept: 'application/json' } }), 3 * 1024 * 1024)).toString('utf8'));
const clean = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
const img = (u) => (u && /^https:\/\//.test(u) ? '/api/img?u=' + encodeURIComponent(u) : testing && u ? '/api/img?u=' + encodeURIComponent(u) : null);
const person = (name, role, u) => ({ name: String(name || '').slice(0, 80), role: String(role || '').slice(0, 80), img: img(u) });

const CREW_RANK = ['Creator', 'Developer', 'Director', 'Writer', 'Screenplay', 'Executive Producer', 'Producer', 'Composer'];
const crewKey = (j) => { const i = CREW_RANK.findIndex((x) => (j || '').toLowerCase().includes(x.toLowerCase())); return i < 0 ? 99 : i; };
const topCrew = (list) => {
  const seen = new Set();
  return list.filter((c) => c.name && crewKey(c.role) < 99 && !seen.has(c.name + c.role) && seen.add(c.name + c.role)).sort((a, b) => crewKey(a.role) - crewKey(b.role)).slice(0, 8);
};

async function fromTvmaze(title) {
  let s;
  try { s = await getJson(`${TVMAZE}/singlesearch/shows?q=${encodeURIComponent(title)}&embed[]=cast&embed[]=crew&embed[]=episodes`); } catch (e) { if (e.status === 404) return null; throw e; }
  const cast = (s._embedded?.cast || []).slice(0, 24).map((c) => person(c.person?.name, c.character?.name, c.person?.image?.medium));
  const crew = topCrew((s._embedded?.crew || []).map((c) => person(c.person?.name, c.type, c.person?.image?.medium)));
  const episodes = (s._embedded?.episodes || []).filter((e) => e.number != null).slice(0, 600).map((e) => ({ s: e.season, n: e.number, name: String(e.name || '').slice(0, 120), summary: clean(e.summary).slice(0, 420), img: img(e.image?.medium), air: e.airdate || null, runtime: e.runtime || null, score: e.rating?.average ?? null }));
  return { source: 'TVMaze', title: s.name, year: s.premiered ? +s.premiered.slice(0, 4) : null, summary: clean(s.summary), genres: (s.genres || []).slice(0, 5), network: s.network?.name || s.webChannel?.name || null,
    status: s.status || null, score: s.rating?.average ?? null, poster: img(s.image?.medium), cast, crew, episodes };
}

async function fromTmdb(kind, title, year) {
  const key = tmdbKey();
  const t = kind === 'tv' ? 'tv' : 'movie';
  const q = new URLSearchParams({ api_key: key, query: title, include_adult: 'false', ...(year ? { [t === 'tv' ? 'first_air_date_year' : 'year']: String(year) } : {}) });
  const hit = (await getJson(`${TMDB}/3/search/${t}?${q}`)).results?.[0];
  if (!hit) return null;
  const d = await getJson(`${TMDB}/3/${t}/${hit.id}?api_key=${encodeURIComponent(key)}&append_to_response=credits`);
  const pic = (p) => (p ? `https://image.tmdb.org/t/p/w185${p}` : null), big = (p) => (p ? `https://image.tmdb.org/t/p/w342${p}` : null);
  const cast = (d.credits?.cast || []).slice(0, 24).map((c) => person(c.name, c.character, pic(c.profile_path)));
  const crew = topCrew((d.credits?.crew || []).map((c) => person(c.name, c.job, pic(c.profile_path))));
  const date = d.release_date || d.first_air_date || '';
  return { source: 'TMDB', title: d.title || d.name, year: date ? +date.slice(0, 4) : null, summary: clean(d.overview), genres: (d.genres || []).map((g) => g.name).slice(0, 5), network: d.networks?.[0]?.name || null,
    status: d.status || null, score: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null, poster: img(big(d.poster_path)), cast, crew, episodes: [] };
}

// keyless movie fallback: Apple's public iTunes Search API (poster, synopsis, genre, year, director; no cast photos)
async function fromItunes(title, year) {
  const r = (await getJson(`${ITUNES}/search?media=movie&entity=movie&limit=5&term=${encodeURIComponent(title)}`)).results || [];
  const n = norm(title);
  const hit = r.find((x) => norm(x.trackName) === n && (!year || String(x.releaseDate || '').startsWith(String(year)))) || r.find((x) => norm(x.trackName) === n);
  if (!hit) return null;
  const art = String(hit.artworkUrl100 || '').replace(/\/\d+x\d+bb\.(jpg|png)$/, '/300x450bb.$1');
  return { source: 'iTunes', title: hit.trackName, year: hit.releaseDate ? +String(hit.releaseDate).slice(0, 4) : null, summary: clean(hit.longDescription || hit.shortDescription), genres: hit.primaryGenreName ? [hit.primaryGenreName] : [], network: null, status: hit.contentAdvisoryRating || null,
    score: null, poster: img(art), cast: [], crew: hit.artistName ? [person(hit.artistName, 'Director', null)] : [], episodes: [] };
}

/** Cache-only and synchronous: what we already know about a title (poster + score). Never touches the network. */
export function peek(kind, title, year = null) {
  kind = kind === 'tv' ? 'tv' : 'movie';
  if (!title) return null;
  const row = get('SELECT json FROM meta WHERE key=?', `${kind}:${norm(title)}:${kind === 'movie' && year ? year : ''}:${hasTmdb() ? 't' : 'n'}`);
  if (!row) return null;
  try { const j = JSON.parse(row.json); return j.found ? { poster: j.poster || null, score: j.score ?? null } : null; } catch { return null; }
}

const inflight = new Map();
/** kind: 'tv' | 'movie'. Never throws for "not found"; returns { found:false }. */
export async function lookup(kind, title, year = null) {
  kind = kind === 'tv' ? 'tv' : 'movie';
  title = String(title || '').trim().slice(0, 120);
  if (!title || !enabled()) return { found: false, disabled: !enabled() };
  const key = `${kind}:${norm(title)}:${kind === 'movie' && year ? year : ''}:${hasTmdb() ? 't' : 'n'}`;
  const row = get('SELECT json,fetched_at FROM meta WHERE key=?', key);
  if (row) { const j = JSON.parse(row.json); if (now() - row.fetched_at < (j.found ? 30 * DAY : DAY)) return j; }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let r = null;
    try {
      if (kind === 'tv') r = await fromTvmaze(title);
      if (!r && hasTmdb()) r = await fromTmdb(kind, title, year).catch(() => null);
      if (!r && kind === 'movie') r = await fromItunes(title, year).catch(() => null);
    } catch { return { found: false, error: true }; } // upstream down: don't cache the failure
    const out = r ? { found: true, ...r } : { found: false, needsKey: false };
    run('INSERT INTO meta(key,json,fetched_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json,fetched_at=excluded.fetched_at', key, JSON.stringify(out), now());
    return out;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- image proxy ----------
const IMG_HOSTS = (h) => h === 'static.tvmaze.com' || h.endsWith('.mzstatic.com') || h === 'image.tmdb.org' || h === 'archive.org' || h.endsWith('.archive.org');
const imgCache = new Map(); // url -> { buf, type, at }
let imgBytes = 0;
const IMG_CAP = 24 * 1024 * 1024;
setInterval(() => { const t = Date.now(); for (const [k, v] of imgCache) if (t - v.at > 6 * 3600000) { imgBytes -= v.buf.length; imgCache.delete(k); } }, 600000).unref();

export async function serveImage(res, u) {
  let parsed;
  try { parsed = new URL(u); } catch { throw new HttpError(400, 'bad url'); }
  if (!testing && (parsed.protocol !== 'https:' || !IMG_HOSTS(parsed.hostname.toLowerCase()) || parsed.port)) throw new HttpError(403, 'host not allowed');
  const send = (c) => { res.writeHead(200, { 'Content-Type': c.type, 'Content-Length': c.buf.length, 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' }); res.end(c.buf); };
  let c = imgCache.get(parsed.href);
  if (c) return send(c);
  let up;
  try { up = await upstream(parsed.href, { timeout: 10000, headers: { Accept: 'image/*' } }); } catch { throw new HttpError(502, 'image unavailable'); }
  const type = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) { up.resume(); throw new HttpError(415, 'not an image'); }
  if (!testing && !IMG_HOSTS(new URL(up.finalUrl).hostname.toLowerCase())) { up.resume(); throw new HttpError(403, 'host not allowed'); }
  let buf;
  try { buf = await readCapped(up, 3 * 1024 * 1024); } catch { throw new HttpError(502, 'image too large'); }
  c = { buf, type, at: Date.now() };
  if (imgBytes + buf.length < IMG_CAP) { imgCache.set(parsed.href, c); imgBytes += buf.length; }
  send(c);
}
