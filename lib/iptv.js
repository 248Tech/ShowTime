// Free live-TV (IPTV) directory + hardened HLS proxy.
//
// Source: the iptv-org community index (publicly available channels; adult content is a separate list we never import).
// Streams are played THROUGH this server so that: (a) viewers' IPs aren't leaked to dozens of third-party hosts,
// (b) CORS / mixed-content problems vanish, (c) our CSP can stay strict.
// Because the server fetches URLs on behalf of users, every outbound request is SSRF-guarded:
//   - only http(s); hostname resolved with a custom lookup that rejects private/loopback/link-local/etc. addresses
//   - redirects are followed manually and re-validated
//   - the proxy only fetches URLs found in the imported list or inside their playlists, via HMAC-signed, expiring tokens
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { get, all, run, tx, now, setting, setSetting } from './db.js';
import { subkey } from './vault.js';

export const SOURCE_URL = process.env.IPTV_SOURCE_URL || 'https://iptv-org.github.io/iptv/index.m3u'; // any M3U URL (e.g. your own mirror)
const UA = 'Mozilla/5.0 (compatible; ShowTime/0.1)';
const allowPrivate = process.env.SHOWTIME_TEST_ALLOW_PRIVATE_UPSTREAM === '1'; // tests only

// ---------- SSRF guard ----------
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return isPrivateIp([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.')); }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('64:ff9b') || l.startsWith('2002:');
  }
  return true;
}

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

/** GET a URL with redirect following + SSRF checks. Resolves with the IncomingMessage (status already validated as 2xx). */
export function upstream(url, { headers = {}, timeout = 15000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const hop = (u, left) => {
      let parsed;
      try { parsed = new URL(u); } catch { return reject(new Error('bad url')); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('blocked protocol'));
      if (parsed.username || parsed.password) return reject(new Error('credentials in url'));
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host) && !allowPrivate && isPrivateIp(host)) return reject(new Error('blocked address')); // literals bypass lookup()
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(parsed, { method: 'GET', lookup: guardedLookup, timeout, headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...headers } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return reject(new Error('too many redirects'));
          return hop(new URL(res.headers.location, parsed).href, left - 1);
        }
        res.finalUrl = parsed.href;
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(Object.assign(new Error(`upstream ${res.statusCode}`), { status: res.statusCode })); }
        resolve(res);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    };
    hop(url, maxRedirects);
  });
}

async function readCapped(res, cap) {
  const chunks = [];
  let n = 0;
  for await (const c of res) { n += c.length; if (n > cap) { res.destroy(); throw new Error('too large'); } chunks.push(c); }
  return Buffer.concat(chunks);
}

// ---------- signed proxy tokens ----------
let key = null;
const sig = (payload) => crypto.createHmac('sha256', (key ||= subkey('iptv-proxy'))).update(payload).digest('base64url');
const TOKEN_TTL = 6 * 3600 * 1000;
export function makeToken(u, streamId, key = null) {
  const p = Buffer.from(JSON.stringify({ u, s: streamId, e: Date.now() + TOKEN_TTL, ...(key != null ? { k: key } : {}) })).toString('base64url');
  return `${p}.${sig(p)}`;
}
export function readToken(t) {
  const [p, s] = String(t).split('.');
  if (!p || !s) return null;
  const a = Buffer.from(sig(p)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); if (!(d.e > Date.now() && typeof d.u === 'string')) return null; d.iat = d.e - TOKEN_TTL; return d; } catch { return null; }
}

// ---------- playlist rewriting ----------
/** Stable identity of an EXT-X-MEDIA rendition inside a master playlist (survives session-token changes in its URL). */
const mediaKey = (line) => { const g = (k) => new RegExp('[:,]' + k + '="?([^",]*)"?').exec(line)?.[1] || ''; return 'm:' + g('TYPE') + '|' + g('GROUP-ID') + '|' + g('NAME') + '|' + g('LANGUAGE'); };

export function rewritePlaylist(text, baseUrl, streamId) {
  const sign = (u, key) => { const a = new URL(u, baseUrl); return ['http:', 'https:'].includes(a.protocol) ? `/api/iptv/p/${makeToken(a.href, streamId, key)}` : null; };
  let vIdx = 0, nextKey = null;
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return '';
    if (t.startsWith('#EXT-X-STREAM-INF')) { nextKey = 'v' + vIdx++; return t.replace(/URI="([^"]*)"/g, (m) => m); }
    if (t.startsWith('#')) {
      const key = t.startsWith('#EXT-X-MEDIA') ? mediaKey(t) : null; // only master-playlist renditions are re-resolvable
      return t.replace(/URI="([^"]*)"/g, (m, u) => { try { const s = sign(u, key); return s ? `URI="${s}"` : m; } catch { return m; } });
    }
    const key = nextKey; nextKey = null;
    try { return sign(t, key) || ''; } catch { return ''; }
  }).join('\n');
}

// Providers that expire session-tokenised URLs (often every few minutes) - and some invalidate EVERY old URL whenever the master is fetched again.
// So one master fetch refreshes ALL variants/renditions at once, concurrent refreshes share one fetch, and any older token is remapped to the fresh set.
const streamHeal = new Map(); // streamId -> { at, byKey: Map(key -> fresh absolute url) }
const inflight = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of streamHeal) if (t - v.at > 3600000) streamHeal.delete(k); }, 300000).unref();

export async function refreshMaster(streamId, minAgeMs = 0) {
  const cur = streamHeal.get(streamId);
  if (cur && Date.now() - cur.at < minAgeMs) return cur.byKey;
  if (inflight.has(streamId)) return inflight.get(streamId);
  const pr = (async () => {
    const e = get('SELECT url,referrer,ua FROM iptv WHERE id=?', streamId);
    if (!e) return new Map();
    const up = await upstream(e.url, { headers: { ...(e.referrer ? { Referer: e.referrer } : {}), ...(e.ua ? { 'User-Agent': e.ua } : {}) }, timeout: 10000 });
    const text = (await readCapped(up, 2 * 1024 * 1024)).toString('utf8').replace(/^\uFEFF/, '');
    const byKey = new Map();
    if (text.trimStart().startsWith('#EXTM3U')) {
      let vIdx = 0, pending = false;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('#EXT-X-STREAM-INF')) pending = true;
        else if (line.startsWith('#EXT-X-MEDIA')) { const m = /URI="([^"]*)"/.exec(line); if (m) byKey.set(mediaKey(line), new URL(m[1], up.finalUrl).href); }
        else if (pending && line && !line.startsWith('#')) { byKey.set('v' + vIdx++, new URL(line, up.finalUrl).href); pending = false; }
      }
    }
    streamHeal.set(streamId, { at: Date.now(), byKey });
    return byKey;
  })().finally(() => inflight.delete(streamId));
  inflight.set(streamId, pr);
  return pr;
}

const headersFor = (streamId) => {
  const e = streamId ? get('SELECT referrer,ua FROM iptv WHERE id=?', streamId) : null;
  return { ...(e?.referrer ? { Referer: e.referrer } : {}), ...(e?.ua ? { 'User-Agent': e.ua } : {}) };
};

let active = 0;
const MAX_ACTIVE = 200;

/** Fetch upstream `url` for a stream and pipe to `res`; HLS playlists are rewritten so every sub-request comes back through us. */
export async function proxy(req, res, url, streamId, { forcePlaylist = false, key = null, issuedAt = 0 } = {}) {
  if (active >= MAX_ACTIVE) { res.writeHead(503).end(); return; }
  active++;
  let up;
  try {
    const h = headersFor(streamId);
    if (req.headers.range && !forcePlaylist) h.Range = req.headers.range;
    // an older token whose provider session has since been refreshed goes straight to the fresh URL for the same variant
    const sh = key != null && streamId ? streamHeal.get(streamId) : null;
    let usedMapped = false;
    if (sh && sh.at > issuedAt && sh.byKey.has(key)) { url = sh.byKey.get(key); usedMapped = true; }
    try { up = await upstream(url, { headers: h }); } catch (e) {
      if ([403, 404, 410].includes(e.status) && key != null && streamId) {
        // session expired on the provider's side (the classic "freezes after a few minutes"): get fresh URLs from the master
        let fresh = (await refreshMaster(streamId, usedMapped ? 1500 : 0).catch(() => new Map())).get(key);
        if (usedMapped && fresh === url) fresh = (await refreshMaster(streamId, 0).catch(() => new Map())).get(key); // the mapped URL itself expired too: really refetch
        if (!fresh || fresh === url) throw e;
        up = await upstream(fresh, { headers: h });
      } else {
        if (e.status && e.status < 500) throw e; // a real 4xx is not transient
        if (res.destroyed || req.destroyed) throw e;
        await new Promise((r) => setTimeout(r, 400)); // one quick retry for resets / timeouts / 5xx - live streams hiccup constantly
        up = await upstream(url, { headers: h });
      }
    }
    const ct = String(up.headers['content-type'] || '').toLowerCase();
    const looksPlaylist = forcePlaylist || /mpegurl|text\//.test(ct) || /\.m3u8?(\?|$)/i.test(up.finalUrl);
    if (looksPlaylist) {
      const body = (await readCapped(up, 2 * 1024 * 1024)).toString('utf8').replace(/^﻿/, '');
      if (!body.trimStart().startsWith('#EXTM3U')) { res.writeHead(502, { 'Content-Type': 'text/plain' }).end('not a playlist'); return; }
      const out = rewritePlaylist(body, up.finalUrl, streamId);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(out) });
      res.end(out);
      return;
    }
    const safeCt = /^(video|audio)\//.test(ct) || ct.startsWith('application/octet-stream') ? ct.split(';')[0] : 'application/octet-stream';
    const hdr = { 'Content-Type': safeCt, 'Cache-Control': 'no-store' };
    if (up.headers['content-length']) hdr['Content-Length'] = up.headers['content-length'];
    if (up.headers['content-range']) hdr['Content-Range'] = up.headers['content-range'];
    res.writeHead(up.statusCode === 206 ? 206 : 200, hdr);
    let sent = 0;
    up.on('data', (c) => { sent += c.length; if (sent > 300 * 1024 * 1024) up.destroy(); }); // never an infinite pipe
    res.on('close', () => { if (!res.writableFinished) up.destroy(); }); // client left -> stop pulling from the provider
    await new Promise((r) => { up.on('end', r); up.on('close', r); up.on('error', r); up.pipe(res); });
  } catch (e) {
    if (!res.headersSent) res.writeHead(e.status === 404 ? 404 : 502, { 'Content-Type': 'text/plain' }).end('upstream unavailable');
    else res.destroy();
  } finally { active--; }
}

// ---------- logos (proxied + cached so viewers never contact third-party image hosts) ----------
const logoDir = () => path.join(config.dataDir, 'iptv-logos');
export async function serveLogo(res, id) {
  const e = get('SELECT logo FROM iptv WHERE id=?', id);
  if (!e?.logo) { res.writeHead(404).end(); return; }
  fs.mkdirSync(logoDir(), { recursive: true });
  const f = path.join(logoDir(), id);
  const hdr = (ct, len) => ({ 'Content-Type': ct, 'Content-Length': len, 'Cache-Control': 'private, max-age=604800', 'Content-Security-Policy': "sandbox; default-src 'none'" });
  try {
    const buf = await fsp.readFile(f + '.bin');
    const ct = await fsp.readFile(f + '.ct', 'utf8');
    res.writeHead(200, hdr(ct, buf.length)).end(buf);
    return;
  } catch { /* not cached */ }
  try {
    const up = await upstream(e.logo, { timeout: 8000 });
    const ct = String(up.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(ct)) { up.resume(); throw new Error('bad type'); }
    const buf = await readCapped(up, 600 * 1024);
    await fsp.writeFile(f + '.bin', buf);
    await fsp.writeFile(f + '.ct', ct);
    res.writeHead(200, hdr(ct, buf.length)).end(buf);
  } catch { res.writeHead(404).end(); }
}

// ---------- import ----------
export function parseM3U(text) {
  const out = [];
  let pend = null;
  let ref = null, ua = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
      const rest = line.replace(/[\w-]+="[^"]*"/g, ''); // drop attributes first so commas inside the channel name survive
      pend = { attrs, name: rest.slice(rest.indexOf(',') + 1).trim() };
      ref = attrs['http-referrer'] || null; ua = attrs['http-user-agent'] || null;
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const m = /^#EXTVLCOPT:http-(referrer|user-agent)=(.*)$/i.exec(line);
      if (m) m[1].toLowerCase() === 'referrer' ? (ref = m[2]) : (ua = m[2]);
    } else if (pend && /^https?:\/\//i.test(line) && line.length < 2000 && pend.name) {
      const tvg = pend.attrs['tvg-id'] || '';
      const cc = /\.([a-z]{2})(?:@|$)/i.exec(tvg)?.[1]?.toLowerCase() || null;
      out.push({
        id: crypto.createHash('sha1').update(line).digest('hex').slice(0, 16), tvg_id: tvg || null, name: pend.name.slice(0, 200),
        logo: /^https?:\/\//i.test(pend.attrs['tvg-logo'] || '') ? pend.attrs['tvg-logo'].slice(0, 500) : null,
        grp: (pend.attrs['group-title'] || 'Undefined').slice(0, 100), country: cc, url: line, referrer: ref?.slice(0, 300) || null, ua: ua?.slice(0, 300) || null,
      });
      pend = null; ref = null; ua = null;
    }
  }
  return out;
}

export async function importList(text) {
  if (text == null) {
    const res = await upstream(SOURCE_URL, { timeout: 60000 });
    text = (await readCapped(res, 30 * 1024 * 1024)).toString('utf8');
  }
  const items = parseM3U(text);
  if (items.length < 1) throw new Error('no channels found in list');
  return tx(() => {
    const seen = new Set();
    let added = 0;
    for (const c of items) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const r = run(
        `INSERT INTO iptv(id,tvg_id,name,logo,grp,country,url,referrer,ua) VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET tvg_id=excluded.tvg_id,name=excluded.name,logo=excluded.logo,grp=excluded.grp,country=excluded.country,referrer=excluded.referrer,ua=excluded.ua`,
        c.id, c.tvg_id, c.name, c.logo, c.grp, c.country, c.url, c.referrer, c.ua,
      );
      if (r.changes && !get('SELECT 1 FROM iptv WHERE id=? AND checked_at IS NOT NULL', c.id)) added++;
    }
    let removed = 0;
    for (const { id } of all('SELECT id FROM iptv')) if (!seen.has(id)) { run('DELETE FROM iptv WHERE id=?', id); removed++; }
    return { total: seen.size, added, removed };
  });
}

// ---------- health check ----------
export const checkState = { running: false, done: 0, total: 0, ok: 0 };

/** Is this (live) media playlist still moving? A dead provider feed keeps serving its last few segments forever: a player gets a few minutes of video, then freezes. */
async function isAdvancing(text, mediaUrl, textOf) {
  if (/#EXT-X-ENDLIST/.test(text)) return true; // VOD - nothing to advance
  const td = +/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1] || 6;
  if (td > 6) return true; // long segments: can't tell within a few seconds, don't guess
  const sig = (t) => (/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(t)?.[1] ?? '') + '|' + (t.trim().split(/\r?\n/).filter((l) => l && !l.startsWith('#')).pop() ?? '');
  const first = sig(text);
  await new Promise((r) => setTimeout(r, Math.min(7000, td * 1000 + 600)));
  return sig((await textOf(mediaUrl)).text) !== first;
}

async function probeStream(e) {
  const h = { ...(e.referrer ? { Referer: e.referrer } : {}), ...(e.ua ? { 'User-Agent': e.ua } : {}) };
  const textOf = async (u) => { const r = await upstream(u, { headers: h, timeout: 8000 }); return { text: (await readCapped(r, 1024 * 1024)).toString('utf8'), url: r.finalUrl }; };
  let { text, url } = await textOf(e.url);
  if (!text.trimStart().startsWith('#EXTM3U')) return false;
  const pick = (t, base) => { const ls = t.split(/\r?\n/).map((l) => l.trim()); for (let i = 0; i < ls.length; i++) { if (ls[i].startsWith('#EXT-X-STREAM-INF')) { const n = ls.slice(i + 1).find((l) => l && !l.startsWith('#')); if (n) return { variant: new URL(n, base).href }; } } const seg = ls.find((l) => l && !l.startsWith('#')); return seg ? { segment: new URL(seg, base).href } : {}; };
  let mediaUrl = url;
  let pk = pick(text, url);
  if (pk.variant) { mediaUrl = pk.variant; ({ text, url } = await textOf(pk.variant)); if (!text.trimStart().startsWith('#EXTM3U')) return false; mediaUrl = url; pk = pick(text, url); }
  if (!pk.segment) return false;
  const seg = await upstream(pk.segment, { headers: h, timeout: 8000 });
  let got = 0;
  for await (const c of seg) { got += c.length; if (got >= 188) { seg.destroy(); break; } }
  if (got < 188) return false;
  return isAdvancing(text, mediaUrl, textOf);
}

export async function runCheck({ staleMs = 3 * 86400000, concurrency = 25 } = {}) {
  if (checkState.running) return checkState;
  const todo = all('SELECT id,url,referrer,ua FROM iptv WHERE checked_at IS NULL OR checked_at<? ORDER BY checked_at IS NOT NULL, RANDOM()', now() - staleMs);
  Object.assign(checkState, { running: true, done: 0, total: todo.length, ok: 0 });
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const e = todo[i++];
      let ok = false;
      try { ok = await Promise.race([probeStream(e), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 20000))]); } catch { ok = false; }
      run('UPDATE iptv SET ok=?,checked_at=? WHERE id=?', ok ? 1 : 0, now(), e.id);
      checkState.done++;
      if (ok) checkState.ok++;
    }
  };
  Promise.all(Array.from({ length: concurrency }, worker)).finally(() => { checkState.running = false; });
  return checkState;
}

let refreshing = false;
export async function refreshAndCheck() {
  if (refreshing) return;
  refreshing = true;
  try {
    const r = await importList();
    console.log(`[iptv] imported ${r.total} channels (+${r.added} new, -${r.removed} removed); health check running in background`);
    await runCheck();
  } catch (e) { console.error('[iptv] import failed:', e.message); } finally { refreshing = false; }
}

export function startIptvJobs() {
  if (!config.iptvAuto) return;
  // v2 health check also rejects frozen provider feeds: re-verify everything that was previously marked working
  if (setting('iptv_check_v', '1') !== '2') { run('UPDATE iptv SET checked_at=NULL WHERE ok=1'); setSetting('iptv_check_v', '2'); }
  if (!get('SELECT 1 FROM iptv LIMIT 1')) refreshAndCheck();
  else runCheck();
  setInterval(refreshAndCheck, 24 * 3600 * 1000).unref();
}

// ---------- query ----------
const esc = (s) => s.replace(/[\\%_]/g, '\\$&');
export const regionName = (() => { let dn; try { dn = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* old ICU */ } return (cc) => { try { return dn?.of(cc === 'uk' ? 'GB' : cc.toUpperCase()) || cc.toUpperCase(); } catch { return cc.toUpperCase(); } }; })();

/** A viewer's player gave up on this channel: take it off the "working" list until the next health check proves otherwise. */
export function reportBroken(id) {
  return run('UPDATE iptv SET ok=0,checked_at=? WHERE id=? AND ok=1', now() - 3 * 86400000 + 6 * 3600000, id).changes > 0; // re-checked within ~6h
}

export function list({ q = '', group = '', country = '', working = false, page = 1, size = 60 }) {
  const where = [], args = [];
  if (q) { where.push("name LIKE ? ESCAPE '\\'"); args.push(`%${esc(q)}%`); }
  if (group) { where.push("(';'||grp||';') LIKE ? ESCAPE '\\'"); args.push(`%;${esc(group)};%`); }
  if (country) { where.push('country=?'); args.push(country); }
  if (working) where.push('ok=1');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = get(`SELECT COUNT(*) c FROM iptv ${w}`, ...args).c;
  const items = all(`SELECT id,name,grp,country,ok,(logo IS NOT NULL) AS hasLogo FROM iptv ${w} ORDER BY ok DESC, name COLLATE NOCASE LIMIT ? OFFSET ?`, ...args, size, (Math.max(1, page) - 1) * size)
    .map((r) => ({ id: r.id, name: r.name, group: r.grp, country: r.country, ok: r.ok, hasLogo: !!r.hasLogo }));
  return { total, page, pages: Math.max(1, Math.ceil(total / size)), items };
}

export function facets() {
  const groups = new Map();
  for (const r of all('SELECT grp,COUNT(*) c FROM iptv GROUP BY grp')) for (const g of r.grp.split(';')) groups.set(g, (groups.get(g) || 0) + r.c);
  return {
    groups: [...groups].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    countries: all("SELECT country,COUNT(*) c FROM iptv WHERE country IS NOT NULL GROUP BY country").map((r) => ({ code: r.country, name: regionName(r.country), count: r.c })).sort((a, b) => a.name.localeCompare(b.name)),
    check: checkState, total: get('SELECT COUNT(*) c FROM iptv').c, working: get('SELECT COUNT(*) c FROM iptv WHERE ok=1').c, checked: get('SELECT COUNT(*) c FROM iptv WHERE checked_at IS NOT NULL').c,
  };
}
