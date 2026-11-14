// Free movies: public-domain / Creative-Commons feature films from the Internet Archive (archive.org).
// Only items the Archive tags with a public-domain or Creative Commons licence are listed. Streams are relayed through this server (SSRF-guarded,
// host-pinned to archive.org, Range requests supported so seeking works) and nothing is stored locally.
import { get, all, run, tx, now, setting, setSetting } from './db.js';
import { upstream, readCapped } from './iptv.js';
import { HttpError } from './errors.js';

const API = (process.env.FREE_API_BASE || 'https://archive.org').replace(/\/+$/, '');
const testing = process.env.SHOWTIME_TEST_ALLOW_PRIVATE_UPSTREAM === '1';
const QUERY = 'collection:feature_films AND mediatype:movies AND (licenseurl:*publicdomain* OR licenseurl:*creativecommons*) AND -collection:adultcinema AND -subject:adult';
const LIMIT = 400;
const okHost = (u) => { try { const h = new URL(u).hostname.toLowerCase(); return testing || h === 'archive.org' || h.endsWith('.archive.org'); } catch { return false; } };
const getJson = async (url) => JSON.parse((await readCapped(await upstream(url, { timeout: 20000, headers: { Accept: 'application/json' } }), 8 * 1024 * 1024)).toString('utf8'));

let refreshing = false;
export async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const q = new URLSearchParams({ q: QUERY, rows: String(LIMIT), output: 'json' });
    for (const f of ['identifier', 'title', 'year', 'licenseurl', 'downloads', 'description']) q.append('fl[]', f);
    q.append('sort[]', 'downloads desc');
    const docs = (await getJson(`${API}/advancedsearch.php?${q}`)).response?.docs || [];
    const ts = now();
    tx(() => {
      for (const d of docs) {
        if (!/^[A-Za-z0-9._-]{1,120}$/.test(d.identifier || '')) continue;
        const descr = String(Array.isArray(d.description) ? d.description[0] : d.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
        run(`INSERT INTO free(id,title,year,license,downloads,descr,fetched_at) VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title,year=excluded.year,license=excluded.license,downloads=excluded.downloads,descr=excluded.descr,fetched_at=excluded.fetched_at`,
          d.identifier, String(d.title || d.identifier).slice(0, 200), +d.year || null, String(d.licenseurl || '').slice(0, 200), +d.downloads || 0, descr, ts);
      }
      run('DELETE FROM free WHERE fetched_at<?', ts);
    });
    setSetting('free_at', now());
  } catch (e) { console.error('[free] refresh failed:', e.message); } finally { refreshing = false; }
}
export const startFreeJobs = () => {
  if (process.env.FREE_AUTO === '0') return;
  if (!get('SELECT 1 FROM free LIMIT 1') || now() - +setting('free_at', '0') > 7 * 86400000) refresh();
  setInterval(() => now() - +setting('free_at', '0') > 7 * 86400000 && refresh(), 6 * 3600000).unref();
};

const esc = (s) => s.replace(/[\\%_]/g, '\\$&');
export function list({ q = '', page = 1, size = 48 }) {
  const w = q ? "WHERE title LIKE ? ESCAPE '\\'" : '', a = q ? [`%${esc(q)}%`] : [];
  const total = get(`SELECT COUNT(*) n FROM free ${w}`, ...a).n;
  const items = all(`SELECT id,title,year,license,descr FROM free ${w} ORDER BY downloads DESC LIMIT ? OFFSET ?`, ...a, size, (page - 1) * size)
    .map((f) => ({ id: f.id, title: f.title, year: f.year, descr: f.descr, rkey: 'free:' + f.id.toLowerCase(), license: /publicdomain/i.test(f.license) ? 'Public domain' : 'Creative Commons' }));
  return { total, pages: Math.max(1, Math.ceil(total / size)), items };
}

/** Pick the best browser-playable file (H.264 MP4) for an item; cached in the DB. */
async function fileFor(id) {
  const row = get('SELECT file FROM free WHERE id=?', id);
  if (!row) throw new HttpError(404, 'Movie not found');
  if (row.file) return row.file;
  const md = await getJson(`${API}/metadata/${encodeURIComponent(id)}`).catch(() => { throw new HttpError(502, 'The Internet Archive is not reachable right now'); });
  const files = (md.files || []).filter((f) => /\.mp4$/i.test(f.name));
  const score = (f) => (/h\.?264/i.test(f.format || '') ? 0 : /mpeg4/i.test(f.format || '') ? 1 : 2) * 1e15 + (f.source === 'derivative' ? 0 : 1e14) + Math.abs((+f.size || 5e8) - 6e8);
  const best = files.sort((a, b) => score(a) - score(b))[0];
  if (!best) throw new HttpError(404, 'No playable file for this movie');
  run('UPDATE free SET file=? WHERE id=?', best.name, id);
  return best.name;
}

export const exists = (id) => !!get('SELECT 1 FROM free WHERE id=?', id);
export const titleOf = (id) => get('SELECT id,title,year FROM free WHERE id=?', id);

/** Range-aware relay of the movie file. */
export async function stream(req, res, id) {
  const name = await fileFor(id);
  const url = `${API}/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
  const range = req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range) ? { Range: req.headers.range } : {};
  let up;
  try { up = await upstream(url, { timeout: 20000, headers: range }); } catch (e) { throw new HttpError(e.status === 416 ? 416 : 502, 'Stream unavailable'); }
  if (!okHost(up.finalUrl)) { up.resume(); throw new HttpError(502, 'Unexpected stream host'); }
  const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  for (const k of ['content-length', 'content-range']) if (up.headers[k]) h[k] = up.headers[k];
  res.writeHead(up.statusCode === 206 ? 206 : 200, h);
  req.on('close', () => up.destroy());
  up.pipe(res);
  up.on('error', () => res.destroy());
}
