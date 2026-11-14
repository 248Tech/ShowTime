// Watch-party rooms: in-memory synced playback state, pushed to clients over SSE.
import crypto from 'node:crypto';
import { get, all, run, canAccessMedia, isMember, audit, bump } from './db.js';
import { evaluate } from './achievements.js';

import { HttpError } from './errors.js';
import { nameFor } from './social.js';
import { renditionsOf } from './media.js';
import { keyForMedia } from './ratings.js';
export { HttpError };

export const PERM_KEYS = ['playback', 'seek', 'skip', 'queue'];
const ALL_ON = { playback: true, seek: true, skip: true, queue: true };
export const DEFAULT_GROUP_PERMS = { playback: true, seek: false, skip: true, queue: true }; // seeking is opt-in
export const parsePerms = (j) => { try { const o = JSON.parse(j); return Object.fromEntries(PERM_KEYS.map((k) => [k, !!o[k]])); } catch { return { ...ALL_ON }; } }; // legacy rooms (NULL) = everything allowed

const rooms = new Map();
const roomOf = (id) => {
  let r = rooms.get(id);
  const row = () => get('SELECT owner_id,perms FROM rooms WHERE id=?', id);
  if (!r) rooms.set(id, (r = { ownerId: row()?.owner_id, perms: parsePerms(row()?.perms), clients: new Set(), live: new Map(), state: { queue: [], index: -1, playing: false, pos: 0, at: Date.now(), rev: 0 } }));
  return r;
};

const curPos = (s) => s.pos + (s.playing ? (Date.now() - s.at) / 1000 : 0);
// Live items = a user's local file streamed peer-to-peer (WebRTC). The server only relays signaling; it never sees the video.
const item = (r, id, viewerId = null) => {
  if (id.startsWith('live:')) {
    const l = r.live.get(id);
    return l && { id, title: l.title, kind: 'live', live: true, hostId: l.hostUserId, hostName: viewerId == null ? '' : nameFor(viewerId, l.hostUserId), online: !!l.hostCid, playable: true, status: 'ready' };
  }
  if (id.startsWith('iptv:')) {
    const c = get('SELECT id,name,grp FROM iptv WHERE id=?', id.slice(5));
    return c && { id, title: c.name, kind: 'iptv', iptv: true, group: c.grp, rkey: 'iptv:' + String(c.id).toLowerCase(), playable: true, status: 'ready' };
  }
  if (id.startsWith('free:')) { // free public-domain / CC movie relayed from the Internet Archive
    const f = get('SELECT id,title,year FROM free WHERE id=?', id.slice(5));
    return f && { id, title: f.title, kind: 'movie', year: f.year, free: true, src: `/api/free/${encodeURIComponent(f.id)}/stream`, rkey: 'free:' + f.id.toLowerCase(), playable: true, status: 'ready', subs: [] };
  }
  const m = get('SELECT * FROM media WHERE id=?', id);
  return m && { id: m.id, rkey: keyForMedia(m), title: m.title, kind: m.kind, show: m.show, season: m.season, episode: m.episode, duration: m.duration, playable: m.playable, status: m.status,
    renditions: renditionsOf(m), subs: all('SELECT id,lang,label FROM subtitles WHERE media_id=? ORDER BY label', id) };
};
const LIVE_GRACE_MS = 60000;

function snapshot(r, viewerId) {
  // prune media that were deleted
  const s = r.state;
  const keep = s.queue.map((id) => !!item(r, id));
  if (keep.some((k) => !k)) {
    const cur = s.queue[s.index];
    s.queue = s.queue.filter((_, i) => keep[i]);
    s.index = cur && s.queue.includes(cur) ? s.queue.indexOf(cur) : Math.min(s.index, s.queue.length - 1);
    if (s.index < 0) { s.playing = false; s.pos = 0; }
  }
  return { ...s, items: s.queue.map((id) => item(r, id, viewerId)), perms: r.perms, ownerId: r.ownerId, serverNow: Date.now() };
}

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// Names are personalised per viewer: strangers in the same room only ever see each other's alias.
function presence(r, viewerId) {
  const ids = new Set();
  for (const c of r.clients) ids.add(c.user.id);
  return [...ids].map((id) => nameFor(viewerId, id));
}
const pushState = (r) => { for (const c of r.clients) send(c.res, 'state', snapshot(r, c.user.id)); };
const pushPresence = (r) => { for (const c of r.clients) send(c.res, 'presence', presence(r, c.user.id)); };

export function attach(roomId, user, req, res) {
  const r = roomOf(roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const client = { res, user, cid: crypto.randomBytes(6).toString('hex') };
  r.clients.add(client);
  send(res, 'hello', { cid: client.cid });
  send(res, 'state', snapshot(r, user.id));
  pushPresence(r);
  const hb = setInterval(() => res.write(': hb\n\n'), 20000);
  req.on('close', () => {
    clearInterval(hb);
    r.clients.delete(client);
    pushPresence(r);
    for (const l of r.live.values()) {
      if (l.hostCid !== client.cid) continue;
      l.hostCid = null; // host gone: viewers see "offline"; drop the item if they don't come back
      clearTimeout(l.timer);
      l.timer = setTimeout(() => {
        const i = r.state.queue.indexOf(l.id);
        if (i >= 0 && !l.hostCid) { removeAt(r.state, i, Date.now()); r.state.rev++; pushState(r); }
      }, LIVE_GRACE_MS);
      l.timer.unref();
      pushState(r);
    }
  });
}

/** Current item + whether it's playing (for the watch-time tracker). */
export function currentItem(roomId) {
  const r = rooms.get(roomId);
  if (!r) return null;
  const id = r.state.queue[r.state.index];
  return { item: id ? item(r, id) : null, playing: r.state.playing, viewers: new Set([...r.clients].map((c) => c.user.id)).size };
}

export function setPerms(roomId, perms) {
  const r = roomOf(roomId);
  r.perms = Object.fromEntries(PERM_KEYS.map((k) => [k, !!perms[k]]));
  pushState(r);
  return r.perms;
}

export const inRoom = (roomId, userId) => [...(rooms.get(roomId)?.clients || [])].some((c) => c.user.id === userId);

export function roomSnapshot(roomId, viewerId) { return snapshot(roomOf(roomId), viewerId); }

export function closeRoom(roomId) {
  const r = rooms.get(roomId);
  if (r) for (const c of r.clients) c.res.end();
  rooms.delete(roomId);
}

const int = (v, d = 0) => (Number.isFinite(+v) ? Math.floor(+v) : d);
const num = (v, d = 0) => (Number.isFinite(+v) ? Math.max(0, +v) : d);

function removeAt(s, i, now) {
  s.queue.splice(i, 1);
  if (i < s.index) s.index--;
  else if (i === s.index) {
    if (s.queue.length === 0) { s.index = -1; s.playing = false; s.pos = 0; s.at = now; }
    else { s.index = Math.min(i, s.queue.length - 1); s.pos = 0; s.at = now; }
  }
}

const ownClient = (r, user, cid) => [...r.clients].find((c) => c.cid === cid && c.user.id === user.id);

/** Relay a WebRTC signaling message to one client in the room. Payload is opaque to the server. */
export function signal(room, user, body) {
  const r = roomOf(room.id);
  const from = ownClient(r, user, String(body.from || ''));
  if (!from) throw new HttpError(400, 'Unknown client');
  const l = r.live.get(String(body.liveId || ''));
  if (!l || !r.state.queue.includes(l.id)) throw new HttpError(404, 'Stream not found');
  if (!body.data || typeof body.data !== 'object' || JSON.stringify(body.data).length > 65536) throw new HttpError(400, 'Bad signal');
  const toCid = body.to === 'host' ? l.hostCid : String(body.to || '');
  const target = toCid && [...r.clients].find((c) => c.cid === toCid);
  if (!target) throw new HttpError(409, 'Peer offline');
  send(target.res, 'signal', { from: from.cid, liveId: l.id, data: body.data });
}

const PERM_OF = { play: 'playback', pause: 'playback', stop: 'playback', seek: 'seek', next: 'skip', prev: 'skip', jump: 'skip', add: 'queue', addLive: 'queue', addIptv: 'queue', addFree: 'queue', tune: 'skip', remove: 'queue', move: 'queue', clear: 'queue' };
const PERM_LABEL = { playback: 'play, pause or stop', seek: 'seek', skip: 'skip or jump between items', queue: 'change the queue' };

/** The room owner always has full control; so does whoever is streaming the current local file (it's their video). */
function allowed(r, room, user, perm) {
  if (user.id === room.owner_id || r.perms[perm]) return true;
  const cur = r.live.get(r.state.queue[r.state.index]);
  return !!cur && cur.hostUserId === user.id && perm !== 'queue';
}

export function command(room, user, body) {
  const r = roomOf(room.id);
  const s = r.state;
  const now = Date.now();
  const need = PERM_OF[body.type];
  if (need && !allowed(r, room, user, need)) throw new HttpError(403, `The host hasn't allowed viewers to ${PERM_LABEL[need]}`);
  const setItem = (i, play = true) => { s.index = i; s.pos = 0; s.playing = play; s.at = now; };
  switch (body.type) {
    case 'play':
      if (s.index < 0 && s.queue.length) s.index = 0;
      if (s.index < 0) throw new HttpError(409, 'Queue is empty');
      s.pos = body.pos != null ? num(body.pos) : curPos(s);
      s.playing = true;
      s.at = now;
      break;
    case 'pause':
      s.pos = body.pos != null ? num(body.pos) : curPos(s);
      s.playing = false;
      s.at = now;
      break;
    case 'seek':
      s.pos = num(body.pos);
      s.at = now;
      break;
    case 'stop':
      s.playing = false; s.pos = 0; s.at = now;
      break;
    case 'next':
      if (s.index + 1 < s.queue.length) setItem(s.index + 1);
      break;
    case 'prev':
      if (curPos(s) > 5 || s.index <= 0) { s.pos = 0; s.at = now; } else setItem(s.index - 1);
      break;
    case 'jump': {
      const i = int(body.index, -1);
      if (i < 0 || i >= s.queue.length) throw new HttpError(400, 'bad index');
      setItem(i);
      break;
    }
    case 'ended':
      if (int(body.index, -2) !== s.index) return; // stale / duplicate report from another client
      if (s.index + 1 < s.queue.length) setItem(s.index + 1);
      else { s.playing = false; s.pos = 0; s.at = now; }
      break;
    case 'add': {
      const id = String(body.mediaId || '');
      const m = get('SELECT * FROM media WHERE id=?', id);
      if (!m || !canAccessMedia(user.id, id)) throw new HttpError(404, 'Media not found');
      if (m.status !== 'ready') throw new HttpError(409, 'Media still processing');
      if (!m.playable) throw new HttpError(409, 'Not browser-playable yet - convert it first');
      if (room.group_id != null) {
        const shared = get('SELECT 1 FROM shares WHERE media_id=? AND group_id=?', id, room.group_id);
        if (!shared) {
          // everyone in the room must be able to watch it: only the owner may auto-share it into the room's group
          if (m.owner_id !== user.id || !isMember(room.group_id, user.id)) throw new HttpError(403, 'Not shared with this room\'s group');
          run('INSERT OR IGNORE INTO shares(media_id,group_id) VALUES(?,?)', id, room.group_id);
          audit(user.id, 'share', `${id} -> group ${room.group_id} (queue)`);
        }
      }
      s.queue.push(id);
      if (s.index < 0) setItem(s.queue.length - 1);
      break;
    }
    case 'tune': { // change channel: swap the CURRENT live channel in place (no queue clutter). {id} | {dir:+1|-1} (next/previous in the same category) | {recall:true} (last channel)
      const curId = String(s.queue[s.index] || '');
      const curChan = curId.startsWith('iptv:') ? curId.slice(5) : null;
      let target = null;
      if (body.recall) target = r.lastChan || null;
      else if (body.id) target = String(body.id);
      else if (body.dir) {
        const g = curChan ? get('SELECT grp FROM iptv WHERE id=?', curChan)?.grp : null;
        let ids = (g ? all('SELECT id FROM iptv WHERE ok=1 AND grp=? ORDER BY name COLLATE NOCASE, id', g) : all('SELECT id FROM iptv WHERE ok=1 ORDER BY name COLLATE NOCASE, id')).map((x) => x.id);
        if (ids.length < 2 && g) ids = all('SELECT id FROM iptv WHERE ok=1 ORDER BY name COLLATE NOCASE, id').map((x) => x.id); // tiny category: step through everything instead
        if (!ids.length) throw new HttpError(404, 'No working channels');
        const at = ids.indexOf(curChan);
        target = ids[at < 0 ? (body.dir > 0 ? 0 : ids.length - 1) : (at + (body.dir > 0 ? 1 : -1) + ids.length) % ids.length];
      }
      if (!target) throw new HttpError(409, 'No previous channel yet');
      if (!get('SELECT 1 FROM iptv WHERE id=?', target)) throw new HttpError(404, 'Channel not found');
      if (target === curChan) break;
      if (curChan) { s.queue[s.index] = 'iptv:' + target; r.lastChan = curChan; setItem(s.index); }
      else { s.queue.push('iptv:' + target); setItem(s.queue.length - 1); }
      break;
    }
    case 'addIptv': {
      const cid = String(body.id || '');
      if (!get('SELECT 1 FROM iptv WHERE id=?', cid)) throw new HttpError(404, 'Channel not found');
      s.queue.push('iptv:' + cid);
      if (s.index < 0) setItem(s.queue.length - 1);
      break;
    }
    case 'addFree': {
      const fid = String(body.id || '');
      if (!get('SELECT 1 FROM free WHERE id=?', fid)) throw new HttpError(404, 'Movie not found');
      s.queue.push('free:' + fid);
      if (s.index < 0) setItem(s.queue.length - 1);
      break;
    }
    case 'addLive': {
      const key = String(body.key || '');
      if (!/^[a-f0-9]{16}$/.test(key) || r.live.has('live:' + key)) throw new HttpError(400, 'bad key');
      const client = ownClient(r, user, String(body.cid || ''));
      if (!client) throw new HttpError(400, 'Unknown client');
      if ([...r.live.values()].filter((l) => l.hostUserId === user.id).length >= 3) throw new HttpError(429, 'Max 3 live streams per user per room');
      const title = String(body.title || 'Live stream').trim().slice(0, 200) || 'Live stream';
      r.live.set('live:' + key, { id: 'live:' + key, title, hostUserId: user.id, hostName: user.name, hostCid: client.cid });
      s.queue.push('live:' + key);
      if (s.index < 0) setItem(s.queue.length - 1);
      audit(user.id, 'live-stream', `room ${room.id} (no file stored)`);
      bump(user.id, 'live_hosted', 1); evaluate(user.id);
      break;
    }
    case 'rehost': {
      const l = r.live.get(String(body.liveId || ''));
      const client = ownClient(r, user, String(body.cid || ''));
      if (!l || l.hostUserId !== user.id || !client) throw new HttpError(403, 'Not your stream');
      l.hostCid = client.cid;
      clearTimeout(l.timer);
      break;
    }
    case 'remove': {
      const i = int(body.index, -1);
      if (i < 0 || i >= s.queue.length) throw new HttpError(400, 'bad index');
      removeAt(s, i, now);
      break;
    }
    case 'move': {
      const f = int(body.from, -1), t = int(body.to, -1);
      if (f < 0 || t < 0 || f >= s.queue.length || t >= s.queue.length) throw new HttpError(400, 'bad index');
      const curId = s.queue[s.index];
      const [x] = s.queue.splice(f, 1);
      s.queue.splice(t, 0, x);
      if (curId) s.index = s.queue.indexOf(curId);
      break;
    }
    case 'clear':
      s.queue = []; s.index = -1; s.playing = false; s.pos = 0; s.at = now;
      break;
    default:
      throw new HttpError(400, 'unknown command');
  }
  for (const [id, l] of r.live) if (!s.queue.includes(id)) { clearTimeout(l.timer); r.live.delete(id); }
  s.rev++;
  pushState(r);
}
