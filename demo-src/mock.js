// ShowTime LIVE DEMO backend - runs entirely in the visitor's browser (no server, nothing is stored or sent anywhere).
// It replaces fetch / EventSource / XMLHttpRequest for /api/* and rewrites media URLs, so the REAL front-end runs unchanged on GitHub Pages.
// The chat uses the real end-to-end crypto (WebCrypto) - only the "server" and the other people are simulated.
import { deriveChannel, seal, open } from './chatcrypto.js';

const REPO = 'https://github.com/248Tech/ShowTime';
const realFetch = window.fetch.bind(window); // captured before we override fetch below
const DIR = new URL('./', import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.now();
const DAY = 86400000;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hueOf = (s) => { let n = 0; for (const c of String(s)) n = (n * 31 + c.charCodeAt(0)) % 360; return n; };
const svgUrl = (svg) => 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------------------------------------------------------------- people
const ME = { id: 1, username: 'demo', name: 'Demo Viewer', email: 'demo@example.com', isAdmin: true, avatar: null, showOnline: true, acceptRequests: true, shareActivity: true };
const friends = [
  { id: 2, name: 'Maya Chen', username: 'maya', avatar: null, online: true },
  { id: 3, name: 'Leo Park', username: 'leo', avatar: null, online: true },
  { id: 4, name: 'Sofia Reyes', username: 'sofia', avatar: null, online: false },
];
let incoming = [{ id: 10, alias: 'Velvet Kernel 15', message: 'Sam from the book club', at: NOW - 3600000 }];
let outgoing = [];
const blocked = [];
let friendCode = 'DEMO7-K2MQ9';

// ---------------------------------------------------------------- library
const CLIP = { h264: 'media/sample-h264.mp4', av1: 'media/sample-av1.mp4', vp9: 'media/sample-vp9.webm' };
const clipUrl = (codec) => DIR + CLIP[codec];
function poster(title) {
  // abstract key art (no text - the UI already prints the title next to it)
  const hu = hueOf(title), ini = esc((title.trim()[0] || '?').toUpperCase());
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hu} 72% 42%)"/><stop offset="1" stop-color="hsl(${(hu + 75) % 360} 70% 13%)"/></linearGradient><linearGradient id="b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="480" height="270" fill="url(#g)"/><circle cx="395" cy="70" r="110" fill="hsl(${(hu + 40) % 360} 90% 65%)" opacity=".22"/><circle cx="70" cy="250" r="140" fill="#000" opacity=".25"/><circle cx="250" cy="150" r="60" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="2"/><path d="M-40 230 L260 -30 L330 -30 L30 290Z" fill="url(#b)"/><text x="440" y="250" text-anchor="end" font-family="Segoe UI,Helvetica,Arial,sans-serif" font-weight="800" font-size="190" fill="#fff" opacity=".13">${ini}</text></svg>`);
}
const logo = (name) => { const hu = hueOf(name); return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="120" height="80" rx="14" fill="hsl(${hu} 60% 30%)"/><text x="60" y="52" text-anchor="middle" font-family="Segoe UI,Helvetica,Arial,sans-serif" font-weight="800" font-size="34" fill="#fff">${esc(name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase())}</text></svg>`); };

const media = [];
const mk = (id, o) => {
  const secs = o.secs, w = o.w || 1920, h = o.h || 1080, br = o.br || 7.5e6;
  const rend = [{ id: 'orig', codec: 'h264', container: 'mp4', width: w, height: h, bitrate: br, size: Math.round(secs * br / 8), original: true }];
  if (o.av1 !== false) rend.push({ id: 'r-av1-' + id, codec: 'av1', container: 'mp4', width: w, height: h, bitrate: Math.round(br * 0.46), size: Math.round(secs * br * 0.46 / 8) });
  if (o.vp9) rend.push({ id: 'r-vp9-' + id, codec: 'vp9', container: 'webm', width: w, height: h, bitrate: Math.round(br * 0.6), size: Math.round(secs * br * 0.6 / 8) });
  const owned = o.owner ? false : true;
  const subs = o.subs === false ? [] : [{ id: 'en-' + id, lang: 'en', label: 'English', source: 'embedded' }, { id: 'es-' + id, lang: 'es', label: 'Spanish', source: 'sidecar' }];
  const scan = owned && o.av1 !== false ? {
    at: NOW - 2 * DAY, budgetX: 2,
    source: { codec: 'h264', width: w, height: h, fps: 24, videoKbps: Math.round(br / 1000), durationSec: secs, tenBit: false, hdr: false },
    trials: {
      h264: { ok: true, tag: 'x264 fast', encoder: 'libx264', speedX: 5.6, projectedSecs: Math.round(secs / 5.6), projectedBps: Math.round(br * 0.9) },
      vp9: { ok: true, tag: 'libvpx-vp9 cpu-used 4', encoder: 'libvpx-vp9', speedX: 2.5, projectedSecs: Math.round(secs / 2.5), projectedBps: Math.round(br * 0.6) },
      av1: { ok: true, tag: 'SVT-AV1 p8', encoder: 'libsvtav1', speedX: 2.4, projectedSecs: Math.round(secs / 2.4), projectedBps: Math.round(br * 0.46) },
    },
    plan: { stageA: null, stageB: 'av1', reasons: ['Original (H.264) already plays in browsers.', 'AV1 chosen: ~54% smaller, ~' + Math.round(secs / 2.4) + 's to encode.', 'VP9: saves only ~40% (needs 15%).'] },
  } : undefined;
  media.push({
    id, title: o.title, kind: o.kind, show: o.show || null, season: o.season ?? null, episode: o.episode ?? null, year: o.year || null,
    duration: secs, width: w, height: h, vcodec: 'h264', acodec: 'aac', size: rend[0].size, playable: true, status: 'ready', error: null, source: 'vault',
    hasThumb: true, createdAt: NOW - (o.age ?? 5) * DAY, owner: o.owner || ME.name, owned, groups: owned ? (o.shared === false ? [] : [1]) : undefined,
    progress: undefined, encoding: undefined, renditions: rend, scan, subs, _poster: poster(o.show || o.title),
  });
};
const movies = [
  ['neon-heist', 'Neon Heist', 2021, 'Crime · Thriller', 6420], ['long-trip', 'The Long Trip', 2019, 'Sci-Fi', 7260], ['blue-planet-night', 'Blue Planet Night', 2018, 'Documentary', 5400],
  ['paper-moons', 'Paper Moons', 2020, 'Drama', 6000], ['midnight-run', 'Midnight Run Club', 2023, 'Comedy', 5700], ['glass-harbor', 'Glass Harbor', 2022, 'Mystery', 6900],
];
movies.forEach(([id, title, year, sub, secs], i) => mk(id, { title, kind: 'movie', year, sub, secs, age: 3 + i * 4, vp9: i < 3, owner: i === 4 || i === 5 ? 'Maya Chen' : null }));
const shows = [
  ['Space Saga', 1, ['Pilot', 'The Signal', 'Dead Reckoning', 'First Contact', 'Crossfire', 'Homecoming'], 2700],
  ['Harbor Lights', 1, ['Low Tide', 'The Lighthouse Keeper', 'Fog', 'Salt and Rust'], 2640],
  ['Kitchen Wars', 2, ['Opening Night', 'Too Many Cooks', 'The Final Service'], 2520],
];
shows.forEach(([show, season, eps, secs], si) => eps.forEach((t, i) => mk(`${show.toLowerCase().replace(/\s+/g, '-')}-${i + 1}`, { title: t, kind: 'tv', show, season, episode: i + 1, secs, w: 1280, h: 720, br: 3.2e6, age: 1 + si + i, vp9: false, owner: si === 2 ? 'Leo Park' : null })));
mk('city-timelapse', { title: 'City Timelapse', kind: 'video', secs: 240, sub: 'Timelapse', w: 3840, h: 2160, br: 18e6, av1: false, subs: false, age: 2 });
mk('ocean-drone', { title: 'Ocean Drone Flight', kind: 'video', secs: 410, sub: 'Drone footage', av1: true, subs: false, age: 6 });
const mediaById = (id) => media.find((m) => m.id === id);
const pubMedia = (m) => { const { _poster, ...rest } = m; return rest; };

// ---------------------------------------------------------------- live TV (fictional channels)
const COUNTRIES = ['us', 'gb', 'fr', 'de', 'jp', 'br', 'in', 'au', 'ca', 'es', 'it', 'mx'];
const regionName = (cc) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc.toUpperCase()); } catch { return cc.toUpperCase(); } };
const CH = {
  News: ['Coastal News 24', 'Metro Headlines', 'World Report Live', 'Daybreak Network', 'The Evening Brief', 'Capital Today'], Sports: ['Arena Sports One', 'Goal Zone', 'Pitchside TV', 'Motorsport Live', 'Court & Track'],
  Movies: ['Retro Cinema', 'Midnight Movies', 'Indie Screen', 'Classic Reels', 'Blockbuster Nights'], Music: ['Vinyl FM TV', 'Beats & Bytes', 'Acoustic Corner', 'Club Pulse', 'Sunset Sessions'],
  Kids: ['Kids Club', 'Toon Town', 'Little Explorers', 'Bedtime Stories'], Documentary: ['Planet Atlas', 'Deep Dive Docs', 'History Vault', 'Wild Frontier'],
  Entertainment: ['Prime Time Plus', 'Laugh Track', 'Reality Hub', 'Talk of the Town'], Culture: ['Art House TV', 'Opera & Stage'], Lifestyle: ['Home & Garden TV', 'Taste Kitchen', 'Travel Today'], Education: ['Learn Live', 'Science Hour'],
};
const channels = [];
let ci = 0;
for (const [group, names] of Object.entries(CH)) for (const name of names) { channels.push({ id: 'd' + ci, name, group: ci % 7 === 0 ? group + ';General' : group, country: COUNTRIES[ci % COUNTRIES.length], ok: 1, hasLogo: true }); ci++; }
const chanById = (id) => channels.find((c) => c.id === id);
function iptvList(q) {
  const f = (k) => q.get(k) || '';
  let rows = channels.filter((c) => (!f('q') || c.name.toLowerCase().includes(f('q').toLowerCase())) && (!f('group') || c.group.split(';').includes(f('group'))) && (!f('country') || c.country === f('country')));
  const page = Math.max(1, +f('page') || 1), size = 60;
  return { total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / size)), items: rows.slice((page - 1) * size, page * size) };
}
function iptvFacets() {
  const g = new Map();
  for (const c of channels) for (const x of c.group.split(';')) g.set(x, (g.get(x) || 0) + 1);
  const cc = new Map();
  for (const c of channels) cc.set(c.country, (cc.get(c.country) || 0) + 1);
  return { groups: [...g].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), countries: [...cc].map(([code, count]) => ({ code, name: regionName(code), count })).sort((a, b) => a.name.localeCompare(b.name)), check: { running: false, done: 0, total: 0, ok: 0 }, total: channels.length, working: channels.length, checked: channels.length };
}

// ---------------------------------------------------------------- groups & rooms
let groups = [{ id: 1, name: 'Movie Night Crew', owned: true, members: [{ id: 1, name: ME.name, username: ME.username, friend: false, avatar: null }, { id: 2, name: 'Maya Chen', username: 'maya', friend: true, avatar: null }, { id: 3, name: 'Leo Park', username: 'leo', friend: true, avatar: null }, { id: 9, name: 'Cosmic Tiger 64', friend: false, avatar: null }] }];
const rooms = new Map();
const newState = () => ({ queue: [], index: -1, playing: false, pos: 0, at: Date.now(), rev: 0 });
const addRoom = (id, name, groupId, perms) => rooms.set(id, { id, name, groupId, owner: 1, perms, state: newState() });
addRoom('movie-night', 'Movie Night', 1, { playback: true, seek: false, skip: true, queue: true });
addRoom('solo', 'My Room', null, { playback: true, seek: true, skip: true, queue: true });
rooms.get('movie-night').state.queue = ['neon-heist', 'long-trip'];
rooms.get('movie-night').state.index = 0;
const roomItem = (id) => {
  if (id.startsWith('iptv:')) { const c = chanById(id.slice(5)); return c && { id, title: c.name, kind: 'iptv', iptv: true, group: c.group, playable: true, status: 'ready' }; }
  const m = mediaById(id);
  return m && { id: m.id, title: m.title, kind: m.kind, show: m.show, season: m.season, episode: m.episode, duration: m.duration, playable: true, status: 'ready', renditions: m.renditions, subs: m.subs };
};
const snapshot = (r) => ({ ...r.state, items: r.state.queue.map(roomItem), perms: r.perms, ownerId: r.owner, serverNow: Date.now() });
const curPos = (s) => s.pos + (s.playing ? (Date.now() - s.at) / 1000 : 0);
function roomCmd(r, b) {
  const s = r.state, now = Date.now();
  const setItem = (i, play = true) => { s.index = i; s.pos = 0; s.playing = play; s.at = now; };
  switch (b.type) {
    case 'play': if (s.index < 0 && s.queue.length) s.index = 0; if (s.index < 0) throw new HttpError(409, 'Queue is empty'); s.pos = b.pos != null ? Math.max(0, +b.pos) : curPos(s); s.playing = true; s.at = now; break;
    case 'pause': s.pos = b.pos != null ? Math.max(0, +b.pos) : curPos(s); s.playing = false; s.at = now; break;
    case 'seek': s.pos = Math.max(0, +b.pos || 0); s.at = now; break;
    case 'stop': s.playing = false; s.pos = 0; s.at = now; break;
    case 'next': if (s.index + 1 < s.queue.length) setItem(s.index + 1); break;
    case 'prev': if (curPos(s) > 5 || s.index <= 0) { s.pos = 0; s.at = now; } else setItem(s.index - 1); break;
    case 'jump': if (!(b.index >= 0 && b.index < s.queue.length)) throw new HttpError(400, 'bad index'); setItem(b.index); break;
    case 'ended': if (b.index !== s.index) return; if (s.index + 1 < s.queue.length) setItem(s.index + 1); else { s.playing = false; s.pos = 0; s.at = now; } break;
    case 'add': { if (!mediaById(b.mediaId)) throw new HttpError(404, 'Media not found'); s.queue.push(b.mediaId); if (s.index < 0) setItem(s.queue.length - 1); break; }
    case 'addIptv': { if (!chanById(b.id)) throw new HttpError(404, 'Channel not found'); s.queue.push('iptv:' + b.id); if (s.index < 0) setItem(s.queue.length - 1); break; }
    case 'remove': { const i = b.index; if (!(i >= 0 && i < s.queue.length)) throw new HttpError(400, 'bad index'); s.queue.splice(i, 1); if (i < s.index) s.index--; else if (i === s.index) { if (!s.queue.length) { s.index = -1; s.playing = false; s.pos = 0; } else { s.index = Math.min(i, s.queue.length - 1); s.pos = 0; } s.at = now; } break; }
    case 'move': { const cur = s.queue[s.index]; const [x] = s.queue.splice(b.from, 1); s.queue.splice(b.to, 0, x); if (cur) s.index = s.queue.indexOf(cur); break; }
    case 'clear': s.queue = []; s.index = -1; s.playing = false; s.pos = 0; s.at = now; break;
    case 'addLive': throw new HttpError(400, 'Streaming a local file needs the real app (it uses peer-to-peer WebRTC) - this demo has no peers. Install ShowTime to try it!');
    case 'rehost': break;
    default: throw new HttpError(400, 'unknown command');
  }
  s.rev++;
}

// ---------------------------------------------------------------- events (fake SSE)
const hubs = { global: new Set(), chat: new Set(), room: new Map() };
class FakeES {
  constructor(url) {
    this.url = url; this.readyState = 1; this.l = {};
    const p = new URL(url, location.href).pathname;
    this.kind = p.endsWith('/api/events') ? 'global' : p.endsWith('/api/chat/events') ? 'chat' : /\/api\/rooms\/([^/]+)\/events$/.test(p) ? 'room' : 'none';
    if (this.kind === 'room') { this.room = /\/api\/rooms\/([^/]+)\/events$/.exec(p)[1]; (hubs.room.get(this.room) || hubs.room.set(this.room, new Set()).get(this.room)).add(this); }
    else if (hubs[this.kind]) hubs[this.kind].add(this);
    setTimeout(() => onConnect(this), 40);
  }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  removeEventListener(t, f) { this.l[t] = (this.l[t] || []).filter((x) => x !== f); }
  close() { this.readyState = 2; hubs.global.delete(this); hubs.chat.delete(this); hubs.room.get(this.room)?.delete(this); }
  emit(t, data) { if (this.readyState === 2) return; for (const f of this.l[t] || []) f({ data: JSON.stringify(data) }); }
}
const emitAll = (set, t, d) => { for (const es of set || []) es.emit(t, d); };
const pushRoom = (r) => emitAll(hubs.room.get(r.id), 'state', snapshot(r));
const presenceNames = (r) => (r.groupId ? [ME.name, 'Maya Chen', 'Cosmic Tiger 64'] : [ME.name]);
let inviteShown = false, firstPing = true;
function onConnect(es) {
  if (es.kind === 'global') {
    es.emit('online', friends.filter((f) => f.online).map(({ id, name, username, avatar }) => ({ id, name, username, avatar })));
    es.emit('friend-state', { incoming: incoming.length });
    if (!inviteShown) { inviteShown = true; setTimeout(() => emitAll(hubs.global, 'invite', { id: 1, roomId: 'movie-night', roomName: 'Movie Night', from: { id: 2, name: 'Maya Chen', avatar: null, friend: true } }), 45000); }
  } else if (es.kind === 'room') {
    const r = rooms.get(es.room);
    if (!r) return;
    es.emit('hello', { cid: 'democid' });
    es.emit('state', snapshot(r));
    es.emit('presence', presenceNames(r));
  } else if (es.kind === 'chat') {
    es.emit('hello', { cid: 'demochat', nextWipe: nextWipe(), wipeMs: 48 * 3600 * 1000 });
  }
}
const nextWipe = () => (Math.floor(Date.now() / (48 * 3600 * 1000)) + 1) * 48 * 3600 * 1000;

// ---------------------------------------------------------------- real E2E chat, simulated server + people
const DEMO_SALT = 'c2hvd3RpbWUtZGVtby0xNg==';
const DEMO_PASS = 'popcorn';
const chans = new Map(); // name -> { salt, verifier, msgs, nextId }
let demoKey = null;
async function demoChannel() {
  if (chans.has('#demo')) return chans.get('#demo');
  const d = await deriveChannel('#demo', DEMO_PASS, DEMO_SALT);
  demoKey = d.key;
  const ch = { salt: DEMO_SALT, verifier: d.verifier, msgs: [], nextId: 1 };
  chans.set('#demo', ch);
  const hist = [['Maple', 'm', 'anyone watching the space documentary tonight?', 42], ['BlueFox', 'm', 'yes! grabbing popcorn', 40], ['Kernel2210', 'j', '', 38], ['Maple', 'm', 'welcome Kernel2210 - this room is end-to-end encrypted btw', 36], ['Kernel2210', 'm', 'ha, nice. nobody can read this but us?', 33], ['BlueFox', 'a', 'nods', 31]];
  for (const [n, t, x, minsAgo] of hist) await pushMsg('#demo', { t, n, x }, NOW - minsAgo * 60000, false);
  return ch;
}
async function pushMsg(name, obj, ts = Date.now(), broadcast = true) {
  const ch = chans.get(name);
  const key = name === '#demo' ? demoKey : ch.key;
  const sealed = await seal(key, name, obj);
  const m = { id: ch.nextId++, ts, ...sealed };
  ch.msgs.push(m);
  if (broadcast) emitAll(hubs.chat, 'msg', { chan: name, id: m.id, ts: m.ts, iv: m.iv, ct: m.ct });
  return m;
}
const BOT_LINES = ['the colours on this one look incredible', 'the AV1 version is half the size and looks identical', 'brb refilling the popcorn bowl', 'who has the invite for the next watch party?', 'this chat wipes itself every 48 hours - nothing is saved anywhere', 'anyone else on the live TV page? found a great channel', 'badge unlocked: Night Owl, finally', 'friend codes are such a nice way to keep strangers out'];
let botTimer = null;
function startBots() {
  if (botTimer) return;
  const nicks = ['Maple', 'BlueFox', 'Kernel2210'];
  botTimer = setInterval(() => { if (chans.get('#demo') && hubs.chat.size) pushMsg('#demo', { t: 'm', n: nicks[Math.floor(Math.random() * nicks.length)], x: BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)] }); }, 11000);
}
async function botReply(text) {
  await sleep(1200 + Math.random() * 1500);
  const t = text.toLowerCase();
  const x = /encrypt|secure|private/.test(t) ? 'yep - your browser encrypts it with a key made from the passphrase. the server only ever sees scrambled bytes.' : /hello|hi\b|hey/.test(t) ? 'hey there! welcome to the demo channel' : /wipe|48/.test(t) ? 'everything here is destroyed every 48 hours - messages, channels, keys.' : /demo|github|install/.test(t) ? 'you can run the real thing yourself - the repo is linked at the bottom of the page!' : ['ha, true', 'agreed', 'good point', 'the chat looks very mIRC, i love it'][Math.floor(Math.random() * 4)];
  await pushMsg('#demo', { t: 'm', n: 'Maple', x });
}

// ---------------------------------------------------------------- stats / profile / badges
let BADGE_DEFS = [];
const loadBadges = (async () => { try { BADGE_DEFS = await (await realFetch(DIR + 'badges.json')).json(); } catch { BADGE_DEFS = []; } })();
const METRIC = { first_reel: 'seconds', hour_1: 'seconds', hour_10: 'seconds', hour_24: 'seconds', hour_100: 'seconds', hour_500: 'seconds', kinds_3: 'kinds', movies_10: 'movies', movies_50: 'movies', shows_5: 'shows', binge_5: 'binge', binge_20: 'binge', channels_5: 'channels', channels_25: 'channels', countries_5: 'countries', countries_15: 'countries', friend_1: 'friends', friend_5: 'friends', party_1: 'party', party_10h: 'party', streak_3: 'streak', streak_7: 'streak', streak_30: 'streak', night_owl: 'night', early_bird: 'early', face: 'avatar', uploader: 'uploads', librarian: 'uploads', streamer: 'live', subtitle_savvy: 'subs' };
const DM = { seconds: 42.5 * 3600, kinds: 4, movies: 7, shows: 3, binge: 6, channels: 9, countries: 6, friends: 3, party: 5.2 * 3600, streak: 6, night: 3900, early: 600, avatar: 0, uploads: 2, live: 0, subs: 1 };
const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daily = Array.from({ length: 14 }, (_, i) => { const d = new Date(NOW - (13 - i) * DAY); return { day: dayStr(d), seconds: [3300, 7200, 0, 5400, 9100, 12600, 4200, 2400, 0, 8800, 10400, 6300, 7700, 5100][i] }; });
const byKind = [{ kind: 'movie', seconds: 17.8 * 3600 }, { kind: 'tv', seconds: 13.2 * 3600 }, { kind: 'iptv', seconds: 8.1 * 3600 }, { kind: 'video', seconds: 3.4 * 3600 }];
const watch = { total: DM.seconds, today: 5100, week: 49000, month: 126000, byKind, daily };
function badges() {
  return BADGE_DEFS.map((d, i) => {
    const v = Math.min(d.target, Math.floor(DM[METRIC[d.key]] ?? 0));
    const got = v >= d.target;
    return { ...d, value: v, unlockedAt: got ? NOW - (3 + i) * DAY : null };
  });
}
const levelOf = (bs) => { const pts = { bronze: 10, silver: 25, gold: 50, platinum: 100 }; const score = bs.filter((b) => b.unlockedAt).reduce((a, b) => a + pts[b.tier], 0); const level = Math.floor(Math.sqrt(score / 10)) + 1; const base = (level - 1) ** 2 * 10, next = level ** 2 * 10; return { score, level, into: score - base, span: next - base }; };
function recent() {
  const mm = (id, mins) => { const m = mediaById(id); return { kind: m.kind, title: m.kind === 'tv' ? m.show : m.title, sub: m.kind === 'tv' ? `S0${m.season}E0${m.episode} · ${m.title}` : String(m.year || ''), mediaId: id, hasThumb: true, seconds: 1500 + mins * 20, lastAt: NOW - mins * 60000, accessible: true }; };
  const ch = (id, mins, secs) => { const c = chanById(id); return { kind: 'iptv', title: c.name, sub: c.group.split(';')[0], chan: id, hasLogo: true, seconds: secs, lastAt: NOW - mins * 60000, accessible: true }; };
  return [mm('neon-heist', 25), ch('d0', 140, 2700), mm('space-saga-4', 300), mm('space-saga-3', 1500), mm('blue-planet-night', 2900), ch('d8', 4100, 1900), mm('harbor-lights-2', 5200), mm('long-trip', 7000)];
}
function variety() {
  return {
    counts: { movies: 7, shows: 3, episodes: 11, videos: 2, channels: 9, countries: 6, categories: 6 },
    movies: movies.slice(0, 5).map((m) => ({ title: m[1], year: m[2], seconds: m[4] * 0.9 })),
    shows: [{ show: 'Space Saga', episodes: 6, seconds: 16200 }, { show: 'Harbor Lights', episodes: 4, seconds: 10560 }, { show: 'Kitchen Wars', episodes: 1, seconds: 2520 }],
    videos: [{ title: 'City Timelapse', seconds: 240 }, { title: 'Ocean Drone Flight', seconds: 410 }],
    channels: channels.slice(0, 9).map((c, i) => ({ name: c.name, group: c.group.split(';')[0], country: regionName(c.country), seconds: 5400 - i * 480 })),
    categories: [{ name: 'News', seconds: 11000 }, { name: 'Sports', seconds: 7400 }, { name: 'Movies', seconds: 5100 }, { name: 'Music', seconds: 3100 }, { name: 'Kids', seconds: 1400 }, { name: 'Documentary', seconds: 900 }],
    countries: ['us', 'gb', 'fr', 'de', 'jp', 'br'].map((c, i) => ({ code: c, name: regionName(c), seconds: 9000 - i * 1300 })),
  };
}
async function profile(id) {
  await loadBadges;
  const bs = badges();
  const self = !id || id === 1;
  const who = self ? ME : friends.find((f) => f.id === id);
  if (!who) throw new HttpError(404, 'Not found');
  return { id: who.id, name: who.name, username: who.username, avatar: null, since: NOW - 120 * DAY, self, shareActivity: true, private: false, watch, level: levelOf(bs), badges: bs, recent: recent(), variety: variety() };
}
const stats = () => ({ ...watch, top: [{ title: 'Space Saga - Pilot', kind: 'tv', seconds: 7200 }, { title: 'Neon Heist', kind: 'movie', seconds: 6100 }, { title: 'Coastal News 24', kind: 'iptv', seconds: 5400 }, { title: 'The Long Trip', kind: 'movie', seconds: 4800 }, { title: 'Harbor Lights - Fog', kind: 'tv', seconds: 3300 }], board: [{ name: 'Maya Chen', username: 'maya', seconds: 61 * 3600, me: false }, { name: ME.name, username: 'demo', seconds: DM.seconds, me: true }, { name: 'Leo Park', username: 'leo', seconds: 28 * 3600, me: false }, { name: 'Sofia Reyes', username: 'sofia', seconds: 9 * 3600, me: false }] });

// ---------------------------------------------------------------- codecs / admin
const CODECS = [
  { id: 'av1', label: 'AV1', encoders: ['libsvtav1', 'libaom-av1', 'av1_nvenc'], available: true, note: 'Best compression; software decode is fine on modern CPUs, hardware decode on newer GPUs.', experimental: false },
  { id: 'vp9', label: 'VP9', encoders: ['libvpx-vp9'], available: true, note: 'Very widely decodable; ~35% smaller than H.264.', experimental: false },
  { id: 'h264', label: 'H.264', encoders: ['libx264', 'h264_nvenc'], available: true, note: 'Plays everywhere; the compatibility baseline.', experimental: false },
  { id: 'av2', label: 'AV2', encoders: [], available: false, note: 'Spec released 2026, but FFmpeg and browsers have no AV2 support yet - slot is ready for when they do.', experimental: true },
];
const adminInfo = () => ({ users: [{ id: 1, username: 'demo', email: 'demo@example.com', name: ME.name, is_admin: 1, created_at: NOW - 120 * DAY, watch_seconds: DM.seconds }, { id: 2, username: 'maya', email: 'maya@example.com', name: 'Maya Chen', is_admin: 0, created_at: NOW - 100 * DAY, watch_seconds: 61 * 3600 }, { id: 3, username: 'leo', email: 'leo@example.com', name: 'Leo Park', is_admin: 0, created_at: NOW - 90 * DAY, watch_seconds: 28 * 3600 }], mediaDirs: [], ffmpeg: true, mailEnabled: false, openSignup: false, encode: { auto: true, budgetX: 2, codecs: CODECS }, iptv: iptvFacets(), invites: [] });

// ---------------------------------------------------------------- router
const R = [];
const route = (method, re, fn) => R.push([method, re, fn]);
const ok = { ok: true };
route('GET', /^\/me$/, () => ({ user: ME, firstRun: false, openSignup: false, mailEnabled: false }));
route('POST', /^\/(login|register|forgot|reset|password|logout)$/, () => ok);
route('GET', /^\/media$/, () => media.map(pubMedia));
route('PATCH', /^\/media\/([^/]+)$/, ([id], q, b) => { const m = mediaById(id); if (m) { Object.assign(m, { title: b.title || m.title, kind: b.kind || m.kind, show: b.show || null, season: b.season === '' ? null : +b.season || null, episode: b.episode === '' ? null : +b.episode || null, year: b.year === '' ? null : +b.year || null }); m._poster = poster(m.show || m.title); } return ok; });
route('DELETE', /^\/media\/([^/]+)$/, ([id]) => { const i = media.findIndex((m) => m.id === id); if (i >= 0) media.splice(i, 1); return ok; });
route('POST', /^\/media\/([^/]+)\/share$/, ([id], q, b) => { const m = mediaById(id); if (m?.owned) { m.groups = (m.groups || []).filter((g) => g !== b.groupId); if (b.share) m.groups.push(b.groupId); } return ok; });
route('POST', /^\/media\/([^/]+)\/(analyze|encode|convert|subs\/extract)$/, () => { throw new HttpError(403, 'Encoding runs on the real server - install ShowTime to scan and encode your own files'); });
route('DELETE', /^\/media\/([^/]+)\/renditions\/(.+)$/, ([id, rid]) => { const m = mediaById(id); if (m) m.renditions = m.renditions.filter((r) => r.id !== rid); return ok; });
route('DELETE', /^\/subs\/(.+)$/, ([sid]) => { for (const m of media) m.subs = m.subs.filter((s) => s.id !== sid); return ok; });
route('GET', /^\/groups$/, () => groups);
route('POST', /^\/groups$/, (p, q, b) => { const id = Math.max(0, ...groups.map((g) => g.id)) + 1; groups.push({ id, name: String(b.name || 'New group').slice(0, 60), owned: true, members: [{ id: 1, name: ME.name, username: ME.username, friend: false, avatar: null }] }); return { id }; });
route('POST', /^\/groups\/(\d+)\/members$/, ([gid], q, b) => { const g = groups.find((x) => x.id === +gid); const f = friends.find((x) => x.id === +b.userId); if (!g || !f) throw new HttpError(403, 'You can only add people from your friends list'); if (!g.members.some((m) => m.id === f.id)) g.members.push({ id: f.id, name: f.name, username: f.username, friend: true, avatar: null }); return ok; });
route('DELETE', /^\/groups\/(\d+)\/members\/(\d+)$/, ([gid, uid]) => { const g = groups.find((x) => x.id === +gid); if (g) g.members = g.members.filter((m) => m.id !== +uid); return ok; });
route('DELETE', /^\/groups\/(\d+)$/, ([gid]) => { groups = groups.filter((g) => g.id !== +gid); return ok; });
route('GET', /^\/rooms$/, () => [...rooms.values()].map((r) => ({ id: r.id, name: r.name, groupId: r.groupId, owned: true })));
route('POST', /^\/rooms$/, (p, q, b) => { if (b.groupId == null) return { id: 'solo' }; const id = 'room-' + Math.random().toString(36).slice(2, 8); addRoom(id, String(b.name || 'Watch Party').slice(0, 60), +b.groupId, { playback: true, seek: false, skip: true, queue: true }); return { id }; });
route('GET', /^\/rooms\/([^/]+)$/, ([id]) => { const r = rooms.get(id); if (!r) throw new HttpError(404, 'Room not found'); return { id: r.id, name: r.name, groupId: r.groupId, state: snapshot(r) }; });
route('DELETE', /^\/rooms\/([^/]+)$/, ([id]) => { rooms.delete(id); return ok; });
route('POST', /^\/rooms\/([^/]+)\/cmd$/, ([id], q, b) => { const r = rooms.get(id); if (!r) throw new HttpError(404, 'Room not found'); roomCmd(r, b); pushRoom(r); return ok; });
route('PATCH', /^\/rooms\/([^/]+)\/perms$/, ([id], q, b) => { const r = rooms.get(id); if (!r) throw new HttpError(404, 'Room not found'); r.perms = { playback: !!b.playback, seek: !!b.seek, skip: !!b.skip, queue: !!b.queue }; pushRoom(r); return { perms: r.perms }; });
route('GET', /^\/rooms\/([^/]+)\/invitees$/, () => [{ id: 2, name: 'Maya Chen', username: 'maya', friend: true, avatar: null, online: true, inRoom: true }, { id: 3, name: 'Leo Park', username: 'leo', friend: true, avatar: null, online: true, inRoom: false }, { id: 9, name: 'Cosmic Tiger 64', friend: false, avatar: null, online: false, inRoom: false }]);
route('POST', /^\/rooms\/([^/]+)\/(invite|signal)$/, () => ({ delivered: true }));
route('POST', /^\/invites\/(\d+)\/respond$/, (p, q, b) => ({ roomId: b.accept ? 'movie-night' : null }));
route('GET', /^\/ice$/, () => ({ iceServers: [] }));
route('POST', /^\/watch\/ping$/, () => { if (firstPing) { firstPing = false; setTimeout(() => emitAll(hubs.global, 'achievement', { key: 'night_owl_demo', name: 'Popcorn Starter', desc: 'Watch 1 hour in total', icon: '🍿', tier: 'bronze' }), 800); } return { credited: 10 }; });
route('GET', /^\/stats$/, () => stats());
route('GET', /^\/profile$/, () => profile());
route('GET', /^\/profile\/(\d+)$/, ([id]) => profile(+id));
route('PATCH', /^\/profile$/, (p, q, b) => { if (b.name) ME.name = b.name; for (const k of ['showOnline', 'acceptRequests', 'shareActivity']) if (k in b) ME[k] = !!b[k]; return ok; });
route('PUT', /^\/profile\/avatar$/, () => { throw new HttpError(403, 'Profile pictures are disabled in the live demo'); });
route('DELETE', /^\/profile\/avatar$/, () => ok);
route('GET', /^\/friends$/, () => ({ code: friendCode, friends, incoming, outgoing, blocked }));
route('POST', /^\/friends\/request$/, (p, q, b) => { const c = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (c.length !== 10) throw new HttpError(404, 'No one has that friend code'); if (c === 'DEMO7K2MQ9') throw new HttpError(400, "That's your own code"); outgoing.push({ id: 100 + outgoing.length, hint: 'code ending ' + c.slice(-3), at: Date.now() }); return { status: 'sent', accepted: false }; });
route('POST', /^\/friends\/requests\/(\d+)\/accept$/, ([id]) => { const r = incoming.find((x) => x.id === +id); if (r) { friends.push({ id: r.id, name: 'Sam Rivera', username: 'sam', avatar: null, online: true }); incoming = incoming.filter((x) => x.id !== r.id); emitAll(hubs.global, 'friend-state', { incoming: incoming.length }); } return ok; });
route('POST', /^\/friends\/requests\/(\d+)\/decline$/, ([id], q, b) => { const r = incoming.find((x) => x.id === +id); incoming = incoming.filter((x) => x.id !== +id); if (r && b.block) blocked.push({ id: r.id, alias: r.alias }); emitAll(hubs.global, 'friend-state', { incoming: incoming.length }); return ok; });
route('DELETE', /^\/friends\/requests\/(\d+)$/, ([id]) => { outgoing = outgoing.filter((x) => x.id !== +id); return ok; });
route('DELETE', /^\/friends\/(\d+)$/, ([id]) => { const i = friends.findIndex((f) => f.id === +id); if (i >= 0) friends.splice(i, 1); return ok; });
route('DELETE', /^\/blocks\/(\d+)$/, ([id]) => { const i = blocked.findIndex((b) => b.id === +id); if (i >= 0) blocked.splice(i, 1); return ok; });
route('POST', /^\/friends\/code\/regenerate$/, () => { friendCode = 'DEMO' + Math.floor(Math.random() * 10) + '-' + Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[IO01]/g, 'X'); return { code: friendCode }; });
route('GET', /^\/iptv$/, (p, q) => iptvList(q));
route('GET', /^\/iptv\/facets$/, () => iptvFacets());
route('POST', /^\/iptv\/([^/]+)\/report$/, () => ({ marked: false }));
route('GET', /^\/codecs$/, () => ({ codecs: CODECS, auto: true, budgetX: 2 }));
route('GET', /^\/admin\/info$/, () => adminInfo());
route('POST', /^\/admin\/(settings|scan|iptv\/refresh|iptv\/check)$/, () => ({ ok: true, added: 0 }));
route('POST', /^\/admin\/invites$/, () => ({ code: 'DEMO-INVITE', url: location.href.split('#')[0] + '#/register?invite=DEMO-INVITE' }));
route('DELETE', /^\/admin\/users\/(\d+)$/, () => { throw new HttpError(400, 'Disabled in the live demo'); });
route('GET', /^\/chat\/status$/, () => ({ nextWipe: nextWipe(), wipeMs: 48 * 3600 * 1000, channels: chans.size }));
route('GET', /^\/chat\/chan$/, async (p, q) => { const name = (q.get('name') || '').toLowerCase(); if (name === '#demo') { const ch = await demoChannel(); return { exists: true, salt: ch.salt }; } const ch = chans.get(name); return ch ? { exists: true, salt: ch.salt } : { exists: false }; });
route('POST', /^\/chat\/join$/, async (p, q, b) => {
  const name = String(b.name || '').toLowerCase();
  if (!/^#[a-z0-9_-]{1,24}$/.test(name)) throw new HttpError(400, 'Channel names look like #lobby (letters, numbers, - _ up to 24)');
  let ch = name === '#demo' ? await demoChannel() : chans.get(name);
  if (ch) { if (ch.verifier !== b.verifier) throw new HttpError(403, 'Wrong passphrase for that channel'); }
  else { ch = { salt: b.salt, verifier: b.verifier, msgs: [], nextId: 1 }; chans.set(name, ch); }
  if (name === '#demo') startBots();
  else if (!ch.key) { ch.key = null; } // user-created channels: the "server" never learns the key, so there are no bots there
  return { ok: true, salt: ch.salt, backlog: ch.msgs.map((m) => ({ id: m.id, ts: m.ts, iv: m.iv, ct: m.ct })) };
});
route('POST', /^\/chat\/leave$/, () => ok);
route('POST', /^\/chat\/send$/, async (p, q, b) => {
  const name = String(b.name || '').toLowerCase(); const ch = chans.get(name);
  if (!ch) throw new HttpError(403, 'Join the channel first');
  const m = { id: ch.nextId++, ts: Date.now(), iv: b.iv, ct: b.ct };
  ch.msgs.push(m);
  emitAll(hubs.chat, 'msg', { chan: name, id: m.id, ts: m.ts, iv: m.iv, ct: m.ct });
  if (name === '#demo' && demoKey) { const plain = await open(demoKey, name, b.iv, b.ct); if (plain?.t === 'm' && plain.x) botReply(plain.x); }
  return { id: m.id };
});

// ---------------------------------------------------------------- install: fetch / EventSource / XHR / media URLs
const jsonRes = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const i = url.pathname.indexOf('/api/');
  if (i < 0) return realFetch(input, init);
  const path = url.pathname.slice(i + 4);
  const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  let body = {};
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { /* not json */ } }
  await sleep(25);
  try {
    if (path === '/upload' || /\/subs$/.test(path) && method === 'PUT') throw new HttpError(403, 'Uploads are disabled in the live demo');
    for (const [m, re, fn] of R) { if (m !== method) continue; const mt = re.exec(path); if (mt) return jsonRes(200, await fn(mt.slice(1), url.searchParams, body)); }
    throw new HttpError(404, 'Not found');
  } catch (e) { return jsonRes(e.status || 500, { error: e.message }); }
};
window.EventSource = FakeES;
const RealXHR = window.XMLHttpRequest;
window.XMLHttpRequest = class extends RealXHR {
  open(m, u, ...a) { this._demo = String(u).includes('/api/'); if (!this._demo) super.open(m, u, ...a); }
  send(b) { if (!this._demo) return super.send(b); setTimeout(() => { Object.defineProperty(this, 'status', { value: 403 }); Object.defineProperty(this, 'responseText', { value: JSON.stringify({ error: 'Uploads are disabled in the live demo' }) }); this.onload?.(); }, 300); }
};

const VTT = { en: ['Welcome to the ShowTime live demo.', 'These subtitles are served from an encrypted vault in the real app.', 'Pick another track from the player\'s CC menu.', 'Every viewer chooses their own language.'], es: ['Bienvenido a la demo de ShowTime.', 'En la app real estos subtitulos viven en una boveda cifrada.', 'Elige otra pista en el menu CC del reproductor.', 'Cada espectador elige su propio idioma.'] };
const vtt = (lang) => 'data:text/vtt;charset=utf-8,' + encodeURIComponent('WEBVTT\n\n' + VTT[lang].map((t, i) => `00:00:${String(2 + i * 9).padStart(2, '0')}.000 --> 00:00:${String(8 + i * 9).padStart(2, '0')}.500\n${t}\n`).join('\n'));
/** /api/... asset URLs (images, video, subtitles) -> generated data URIs or the sample clips. */
function rewrite(u) {
  if (typeof u !== 'string' || !u.includes('/api/')) return u;
  const p = u.slice(u.indexOf('/api/') + 4);
  let m;
  if ((m = /^\/media\/([^/]+)\/thumb/.exec(p))) return mediaById(m[1])?._poster ?? poster('Video');
  if ((m = /^\/media\/([^/]+)\/stream\?r=([^&]*)/.exec(p))) { const r = mediaById(m[1])?.renditions.find((x) => x.id === decodeURIComponent(m[2])); return clipUrl(r?.codec === 'av1' ? 'av1' : r?.codec === 'vp9' ? 'vp9' : 'h264'); }
  if (/^\/media\/[^/]+\/stream/.test(p)) return clipUrl('h264');
  if ((m = /^\/subs\/(es|en)-/.exec(p))) return vtt(m[1]);
  if ((m = /^\/iptv\/logo\/(.+)$/.exec(p))) return logo(chanById(m[1])?.name || 'TV');
  if (/^\/iptv\/[^/]+\/stream\.m3u8/.test(p)) return clipUrl('h264');
  if (/^\/avatars\//.test(p)) return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#555"/></svg>');
  return u;
}
const protoSet = (proto, name) => { const d = Object.getOwnPropertyDescriptor(proto, name); Object.defineProperty(proto, name, { ...d, set(v) { d.set.call(this, rewrite(v)); } }); };
protoSet(HTMLMediaElement.prototype, 'src');
protoSet(HTMLImageElement.prototype, 'src');
const setAttr = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (n, v) { return setAttr.call(this, n, n === 'src' || n === 'href' ? rewrite(String(v)) : v); };

// ---------------------------------------------------------------- demo ribbon
addEventListener('DOMContentLoaded', () => {
  const bar = document.createElement('div');
  bar.id = 'demo-ribbon';
  bar.innerHTML = `<span class="dr-dot"></span><span><b>Live demo</b> · simulated data, nothing is stored · every title plays a short sample clip</span><a href="${REPO}" target="_blank" rel="noopener">★ Get ShowTime</a><button aria-label="Dismiss" title="Dismiss">×</button>`;
  bar.querySelector('button').onclick = () => bar.remove();
  const st = document.createElement('style');
  st.textContent = '#demo-ribbon{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:95;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 24px);padding:9px 12px 9px 16px;border-radius:999px;background:rgba(20,19,28,.82);backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 40px -12px #000;color:#f6f5f9;font:13px/1.3 system-ui,sans-serif}#demo-ribbon b{color:#ffb627}#demo-ribbon a{background:linear-gradient(135deg,#ffd04a,#ff8a3d 55%,#ff4d6d);color:#1c1005;font-weight:700;text-decoration:none;padding:6px 14px;border-radius:999px;white-space:nowrap}#demo-ribbon button{background:none;border:0;color:#a3a1b3;font-size:20px;line-height:1;cursor:pointer;padding:0 4px}.dr-dot{width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399;flex:0 0 8px}@media(max-width:640px){#demo-ribbon span:nth-child(2){display:none}}';
  document.head.append(st);
  document.body.append(bar);
});
