// Privacy model: nobody can see anybody by default, ever.
//  - There is no user search and no member directory. People find each other ONLY through a private friend code
//    that one person hands to the other OFF the platform.
//  - A friend request shows the sender as an anonymous alias plus an optional message ("hi, it's Sam from work").
//    Real display names / usernames / avatars are revealed only between accepted friends.
//  - Where non-friends are unavoidably in the same place (a shared group or room), they appear as a stable alias
//    ("Crispy Otter 42") with a generated avatar. Online status is only ever shared between friends.
import crypto from 'node:crypto';
import { get, all, run, tx, now, newFriendCode, normalizeFriendCode } from './db.js';
import { subkey } from './vault.js';
import { HttpError } from './errors.js';
import * as sec from './security.js';

const ADJ = ['Crispy', 'Buttery', 'Salty', 'Toasty', 'Golden', 'Fluffy', 'Sweet', 'Smoky', 'Spicy', 'Cheesy', 'Warm', 'Quiet', 'Brave', 'Sleepy', 'Lucky', 'Cosmic', 'Mellow', 'Zesty', 'Velvet', 'Neon', 'Cozy', 'Swift', 'Gentle', 'Witty', 'Dapper', 'Jolly', 'Sunny', 'Misty', 'Plucky', 'Snappy', 'Breezy', 'Proud'];
const NOUN = ['Kernel', 'Otter', 'Falcon', 'Panda', 'Comet', 'Maple', 'Badger', 'Heron', 'Walrus', 'Lynx', 'Sparrow', 'Koala', 'Pixel', 'Marlin', 'Fox', 'Owl', 'Newt', 'Gecko', 'Tiger', 'Moose', 'Raven', 'Llama', 'Bison', 'Finch', 'Cobra', 'Dingo', 'Ibis', 'Okapi', 'Quokka', 'Yak', 'Wombat', 'Zebra'];
let key = null;
export function alias(id) {
  const h = crypto.createHmac('sha256', (key ||= subkey('alias'))).update(String(id)).digest();
  return `${ADJ[h[0] % 32]} ${NOUN[h[1] % 32]} ${10 + (((h[2] << 8) | h[3]) % 90)}`;
}

export const areFriends = (a, b) => a === b || !!get('SELECT 1 FROM friends WHERE a=? AND b=?', a, b);
export const friendIds = (uid) => all('SELECT b FROM friends WHERE a=?', uid).map((r) => r.b);

/** What `viewerId` is allowed to know about `u` ({id,name,username,avatar_v}). Strangers get an alias, nothing else. */
export function viewOf(viewerId, u, friendSet) {
  const known = u.id === viewerId || (friendSet ? friendSet.has(u.id) : areFriends(viewerId, u.id));
  return known
    ? { id: u.id, name: u.name, username: u.username, friend: u.id !== viewerId, avatar: u.avatar_v || null }
    : { id: u.id, name: alias(u.id), friend: false, avatar: null };
}
export function nameFor(viewerId, targetId) {
  if (targetId === viewerId || areFriends(viewerId, targetId)) return get('SELECT name FROM users WHERE id=?', targetId)?.name ?? 'Unknown';
  return alias(targetId);
}
/** Faster batch variant: build once per request. */
export function namer(viewerId) {
  const fr = new Set(friendIds(viewerId));
  return (id, realName) => (id === viewerId || fr.has(id) ? realName : alias(id));
}

// ---------- friend requests ----------
const OUT_LIMIT = 20;
export const isBlocked = (by, who) => !!get('SELECT 1 FROM blocks WHERE user_id=? AND blocked_id=?', by, who);

function makeFriends(a, b) {
  tx(() => {
    run('INSERT OR IGNORE INTO friends(a,b,since) VALUES(?,?,?)', a, b, now());
    run('INSERT OR IGNORE INTO friends(a,b,since) VALUES(?,?,?)', b, a, now());
    run('DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)', a, b, b, a);
  });
}

/** @returns {{status:'friends'|'sent', target?:number, accepted?:boolean}} */
export function requestByCode(user, rawCode, message) {
  const fail = `fc-fail:${user.id}`;
  if (sec.limited(fail, 10, 3600000) || sec.limited(`fc-req:${user.id}`, 20, 3600000)) throw new HttpError(429, 'Too many attempts - try again later');
  const code = normalizeFriendCode(rawCode);
  const target = code.length === 10 ? get('SELECT id,accept_requests FROM users WHERE friend_code=?', code) : null;
  if (!target) { sec.hit(fail, 3600000); throw new HttpError(404, 'No one has that friend code'); }
  sec.hit(`fc-req:${user.id}`, 3600000);
  if (target.id === user.id) throw new HttpError(400, "That's your own code");
  if (areFriends(user.id, target.id)) return { status: 'friends', target: target.id };
  // silently dropped (but looks identical to the sender) when blocked or when they don't accept requests
  if (isBlocked(target.id, user.id) || !target.accept_requests) return { status: 'sent' };
  if (get('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?', target.id, user.id)) { makeFriends(user.id, target.id); return { status: 'friends', target: target.id, accepted: true }; }
  if (get('SELECT COUNT(*) c FROM friend_requests WHERE from_id=?', user.id).c >= OUT_LIMIT) throw new HttpError(400, 'Too many pending requests');
  run('INSERT INTO friend_requests(from_id,to_id,message,created_at) VALUES(?,?,?,?) ON CONFLICT(from_id,to_id) DO UPDATE SET message=excluded.message,created_at=excluded.created_at',
    user.id, target.id, String(message || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 80) || null, now());
  return { status: 'sent', target: target.id };
}

export function respond(user, fromId, accept, block) {
  const req = get('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?', fromId, user.id);
  if (!req) throw new HttpError(404, 'No such request');
  if (accept) { makeFriends(user.id, fromId); return; }
  run('DELETE FROM friend_requests WHERE from_id=? AND to_id=?', fromId, user.id);
  if (block) run('INSERT OR IGNORE INTO blocks(user_id,blocked_id) VALUES(?,?)', user.id, fromId);
}

export function unfriend(userId, otherId) {
  run('DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)', userId, otherId, otherId, userId);
}

export function overview(userId) {
  const me = get('SELECT friend_code FROM users WHERE id=?', userId);
  return {
    code: `${me.friend_code.slice(0, 5)}-${me.friend_code.slice(5)}`,
    friends: all('SELECT u.id,u.name,u.username,u.avatar_v,u.show_online FROM friends f JOIN users u ON u.id=f.b WHERE f.a=? ORDER BY u.name COLLATE NOCASE', userId),
    incoming: all('SELECT r.from_id AS id,r.message,r.created_at AS at FROM friend_requests r WHERE r.to_id=? ORDER BY r.created_at DESC', userId).map((r) => ({ id: r.id, alias: alias(r.id), message: r.message, at: r.at })),
    outgoing: all('SELECT r.to_id AS id,r.created_at AS at,u.friend_code FROM friend_requests r JOIN users u ON u.id=r.to_id WHERE r.from_id=? ORDER BY r.created_at DESC', userId).map((r) => ({ id: r.id, hint: `code ending ${r.friend_code.slice(-3)}`, at: r.at })),
    blocked: all('SELECT blocked_id AS id FROM blocks WHERE user_id=?', userId).map((r) => ({ id: r.id, alias: alias(r.id) })),
  };
}
export const incomingCount = (userId) => get('SELECT COUNT(*) c FROM friend_requests WHERE to_id=?', userId).c;

export function regenerateCode(userId) {
  run('UPDATE users SET friend_code=? WHERE id=?', newFriendCode(), userId);
}
