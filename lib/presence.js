// Global per-user event channel (SSE): friends' online status, room invites, friend requests.
// Privacy: online status is shared ONLY between accepted friends, and only if the friend hasn't chosen to appear offline.
import { get, all, run, now } from './db.js';
import { nameFor, areFriends, incomingCount, viewOf } from './social.js';

export const INVITE_TTL_MS = 3600000;
const conns = new Map(); // userId -> Set<res>
let timer = null;
const devices = new Map(); // res -> { id, name, since } : the browsers/devices signed in to ONE account (never shared with anyone else)

/** Distinct devices currently connected for this account. */
export function devicesOf(userId) {
  const seen = new Map();
  for (const res of conns.get(userId) || []) { const d = devices.get(res); if (d && !seen.has(d.id)) seen.set(d.id, d); }
  return [...seen.values()].map((d) => ({ id: d.id, name: d.name, since: d.since }));
}
const pushDevices = (userId) => notify(userId, 'devices', devicesOf(userId));
/** Tell one of YOUR devices to open a room ("send to device"). Returns false if that device is not connected. */
export function cast(userId, deviceId, payload) {
  let hit = false;
  for (const res of conns.get(userId) || []) if (devices.get(res)?.id === deviceId) { send(res, 'cast', payload); hit = true; }
  return hit;
}

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
export const isOnline = (userId) => conns.has(userId);
/** Online AND willing to be seen as online. */
export const isVisiblyOnline = (userId) => conns.has(userId) && (get('SELECT show_online FROM users WHERE id=?', userId)?.show_online ?? 1) === 1;

export function notify(userId, event, data) {
  for (const res of conns.get(userId) || []) send(res, event, data);
}

export const friends = (userId) =>
  all('SELECT u.id,u.name,u.username,u.avatar_v,u.show_online FROM friends f JOIN users u ON u.id=f.b WHERE f.a=?', userId);

const onlineFor = (userId) =>
  friends(userId).filter((u) => conns.has(u.id) && u.show_online === 1).map((u) => ({ id: u.id, name: u.name, username: u.username, avatar: u.avatar_v || null }));

export function pendingInvites(userId) {
  return all(
    `SELECT i.id,i.room_id AS roomId,r.name AS roomName,i.from_id AS fromId FROM room_invites i
     JOIN rooms r ON r.id=i.room_id WHERE i.to_id=? AND i.created_at>?`,
    userId, now() - INVITE_TTL_MS,
  ).map((i) => ({ id: i.id, roomId: i.roomId, roomName: i.roomName, from: fromInfo(userId, i.fromId) }));
}

/** The inviter as the recipient is allowed to see them (alias unless friends). */
export function fromInfo(viewerId, fromId) {
  const u = get('SELECT id,name,username,avatar_v FROM users WHERE id=?', fromId);
  const v = u ? viewOf(viewerId, u) : { id: fromId, name: 'Someone' };
  return { id: v.id, name: v.name, avatar: v.avatar || null, friend: !!v.friend };
}

/** Recompute everyone's online-friends list (debounced; also call after friendship changes). */
export function refresh() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const [uid, set] of conns) for (const res of set) send(res, 'online', onlineFor(uid));
  }, 250);
}
export const pushFriendState = (userId) => notify(userId, 'friend-state', { incoming: incomingCount(userId) });

export function attach(user, req, res, device = null) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  (conns.get(user.id) || conns.set(user.id, new Set()).get(user.id)).add(res);
  if (device) devices.set(res, { ...device, since: now() });
  send(res, 'online', onlineFor(user.id));
  send(res, 'friend-state', { incoming: incomingCount(user.id) });
  for (const inv of pendingInvites(user.id)) send(res, 'invite', inv);
  refresh();
  if (device) pushDevices(user.id);
  const hb = setInterval(() => res.write(': hb\n\n'), 20000);
  req.on('close', () => {
    clearInterval(hb);
    devices.delete(res);
    const s = conns.get(user.id);
    s?.delete(res);
    if (s && !s.size) conns.delete(user.id);
    refresh();
    if (device) pushDevices(user.id);
  });
}

setInterval(() => run('DELETE FROM room_invites WHERE created_at<?', now() - INVITE_TTL_MS), 600000).unref();
export { nameFor, areFriends };
