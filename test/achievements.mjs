// Achievements + profile data: exact thresholds, streak math, privacy gating (uses a temp database; no server needed).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ach-'));
process.env.DATA_DIR = dir;
process.env.SHOWTIME_MASTER_KEY = '12'.repeat(32);
const { initVault } = await import('../lib/vault.js'); initVault();
const D = await import('../lib/db.js');
const A = await import('../lib/achievements.js');
const P = await import('../lib/profile.js');
const { run, get } = D;
const ok = (name, fn) => { fn(); console.log('  ok -', name); };

const now = Date.now();
const mkUser = (id, name) => run('INSERT INTO users(id,username,email,name,pass_hash,created_at,friend_code) VALUES(?,?,?,?,?,?,?)', id, name, name + '@x.io', name[0].toUpperCase() + name.slice(1), 'x', now, ('CODE' + id).padEnd(10, 'A'));
[[1, 'ann'], [2, 'ben'], [3, 'cat'], [4, 'dan'], [5, 'eve'], [6, 'fay'], [7, 'gus']].forEach(([i, n]) => mkUser(i, n));
const mkMedia = (id, owner, kind, title, show, ep) => run("INSERT INTO media(id,owner_id,title,kind,show,season,episode,filename,src,path,status,created_at,playable) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)", id, owner, title, kind, show || null, show ? 1 : null, ep ?? null, title + '.mp4', 'local', '/x/' + id, 'ready', now);
const watch = (uid, ref, secs, ago = 0) => run('INSERT INTO watch_title(user_id,ref,seconds,last_at) VALUES(?,?,?,?)', uid, ref, secs, now - ago * 1000);
for (let i = 1; i <= 12; i++) { mkMedia('mv' + i, 1, 'movie', 'Movie ' + i); watch(1, 'mv' + i, 120, i * 100); }
mkMedia('mvshort', 1, 'movie', 'Skipped Movie'); watch(1, 'mvshort', 30, 5); // under a minute: must not count
for (let e = 1; e <= 6; e++) { mkMedia('al' + e, 1, 'tv', 'Ep ' + e, 'Alpha', e); watch(1, 'al' + e, 100, 2000 + e); }
for (let e = 1; e <= 2; e++) { mkMedia('be' + e, 1, 'tv', 'Ep ' + e, 'Beta', e); watch(1, 'be' + e, 100, 3000 + e); }
for (const s of ['Gamma', 'Delta', 'Eps']) { mkMedia('x' + s, 1, 'tv', 'Ep 1', s, 1); watch(1, 'x' + s, 100, 4000); }
for (let i = 1; i <= 2; i++) { mkMedia('vid' + i, 1, 'video', 'Clip ' + i); watch(1, 'vid' + i, 90, 5000 + i); }
['us', 'gb', 'fr', 'de', 'jp', 'us'].forEach((cc, i) => { run('INSERT INTO iptv(id,name,grp,country,url) VALUES(?,?,?,?,?)', 'ch' + i, 'Channel ' + i, i % 2 ? 'News;General' : 'Sports', cc, 'http://x/' + i); watch(1, 'iptv:ch' + i, 90, 6000 + i); });
// 8 consecutive days + an isolated earlier day
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
for (let n = 0; n < 8; n++) run('INSERT INTO watch_day(user_id,day,kind,seconds) VALUES(?,?,?,?)', 1, day(n), 'movie', 3600);
run('INSERT INTO watch_day(user_id,day,kind,seconds) VALUES(?,?,?,?)', 1, day(20), 'movie', 10800);
run('INSERT INTO watch_day(user_id,day,kind,seconds) VALUES(?,?,?,?)', 1, day(1), 'tv', 600);
run('INSERT INTO watch_day(user_id,day,kind,seconds) VALUES(?,?,?,?)', 1, day(2), 'iptv', 500);
run('INSERT INTO watch_day(user_id,day,kind,seconds) VALUES(?,?,?,?)', 1, day(3), 'video', 20); // under a minute total that day? (day 3 also has movie, fine)
for (const f of [2, 3, 4, 5, 6]) { run('INSERT INTO friends(a,b,since) VALUES(?,?,?)', 1, f, now); run('INSERT INTO friends(a,b,since) VALUES(?,?,?)', f, 1, now); }
D.bump(1, 'party_s', 700); D.bump(1, 'night_s', 2000);

ok('metrics: thresholds, one-minute rule, streaks', () => {
  const m = A.metrics(1);
  assert.equal(m.movies, 12, 'the 30-second movie does not count');
  assert.equal(m.shows, 5); assert.equal(m.bestShowEpisodes, 6);
  assert.equal(m.channels, 6); assert.equal(m.countries, 5, 'us counted once');
  assert.equal(m.friends, 5); assert.equal(m.streak, 8, 'best run of consecutive days (the isolated day does not extend it)');
  assert.equal(m.kinds, 3, 'movie, tv, iptv - the video kind has only 20s so it does not count');
  assert.equal(m.party, 700); assert.equal(m.night, 2000);
});

const EXPECT = ['first_reel', 'hour_1', 'hour_10', 'kinds_3', 'movies_10', 'shows_5', 'binge_5', 'channels_5', 'countries_5', 'friend_1', 'friend_5', 'party_1', 'streak_3', 'streak_7', 'night_owl'].sort();
ok('evaluate unlocks exactly the earned badges, once', () => {
  const fresh = A.evaluate(1);
  assert.deepEqual(fresh.map((b) => b.key).sort(), EXPECT);
  assert.deepEqual(A.evaluate(1), [], 'second run unlocks nothing new (idempotent)');
  assert.equal(get('SELECT COUNT(*) c FROM achievements WHERE user_id=1').c, EXPECT.length);
});
ok('progress reports value/target and clamps', () => {
  const p = Object.fromEntries(A.progress(1).map((b) => [b.key, b]));
  assert.equal(p.hour_24.unlockedAt, null); assert.equal(p.hour_24.target, 86400); assert.ok(p.hour_24.value > 0 && p.hour_24.value < 86400);
  assert.equal(p.movies_50.value, 12); assert.equal(p.streak_30.value, 8); assert.equal(p.binge_5.value, 5, 'value is clamped at the target'); assert.ok(p.binge_5.unlockedAt);
  assert.equal(p.uploader.value, 0, 'local library items are not uploads');
});
ok('level maths follows tier points', () => {
  const pts = EXPECT.reduce((a, k) => a + A.TIER_POINTS[A.DEFS.find((d) => d.key === k).tier], 0);
  const l = A.level(1);
  assert.equal(l.score, pts); assert.equal(l.level, Math.floor(Math.sqrt(pts / 10)) + 1); assert.ok(l.into >= 0 && l.into < l.span);
});
ok('unlock triggers: friends, counters', () => {
  assert.equal(A.evaluate(2).map((b) => b.key).join(), 'friend_1', 'ben has one friend');
  D.bump(1, 'live_hosted', 1); D.bump(1, 'early_s', 1800);
  assert.deepEqual(A.evaluate(1).map((b) => b.key).sort(), ['early_bird', 'streamer']);
});
ok('DEFS are well-formed and unique', () => {
  assert.equal(new Set(A.DEFS.map((d) => d.key)).size, A.DEFS.length);
  for (const d of A.DEFS) { assert.ok(d.name && d.desc && d.icon && A.TIER_POINTS[d.tier] && d.target > 0 && ['time', 'count'].includes(d.unit), d.key); }
  assert.ok(A.DEFS.length >= 28);
});

ok('profile: recently watched + variety (self)', () => {
  const p = P.buildProfile(1, 1);
  assert.equal(p.self, true); assert.equal(p.private, false);
  assert.equal(p.recent.length, 12); assert.equal(p.recent[0].title, 'Skipped Movie', 'newest first (all recents, even short ones)');
  assert.ok(p.recent.every((r, i, a) => i === 0 || a[i - 1].lastAt >= r.lastAt), 'sorted newest -> oldest');
  assert.deepEqual(p.variety.counts, { movies: 12, shows: 5, episodes: 11, videos: 2, channels: 6, countries: 5, categories: 3 });
  assert.equal(p.variety.shows[0].show, 'Alpha'); assert.equal(p.variety.shows[0].episodes, 6);
  assert.equal(p.variety.categories[0].name !== undefined, true);
  assert.deepEqual(p.variety.countries.map((c) => c.code).sort(), ['de', 'fr', 'gb', 'jp', 'us']);
  assert.equal(p.watch.total, 8 * 3600 + 10800 + 600 + 500 + 20); assert.equal(p.watch.daily.length, 14);
  assert.equal(p.badges.length, A.DEFS.length); assert.ok(p.badges.every((b) => !('_hit' in b)));
});
ok('profile privacy: friends see nothing by default; strangers see nothing at all', () => {
  const asBen = P.buildProfile(2, 1);
  assert.equal(asBen.private, true); assert.ok(!('badges' in asBen) && !('watch' in asBen) && !('recent' in asBen) && !('variety' in asBen));
  assert.equal(P.buildProfile(7, 1), null, 'stranger'); assert.equal(P.buildProfile(1, 99), null, 'nonexistent');
  run('UPDATE users SET share_activity=1 WHERE id=1');
  const shared = P.buildProfile(2, 1);
  assert.equal(shared.private, false); assert.ok(shared.badges.length && shared.watch.total > 0);
  assert.ok(shared.recent.every((r) => r.accessible === false && r.mediaId === null || r.kind === 'iptv'), "friend can't open what isn't shared with them");
  assert.equal(P.buildProfile(7, 1), null, 'strangers still nothing after sharing');
  run("UPDATE media SET src='local' WHERE id='mv1'");
  D.run('INSERT INTO groups(id,name,owner_id,created_at) VALUES(1,?,?,?)', 'g', 1, now); D.run('INSERT INTO group_members VALUES(1,1)'); D.run('INSERT INTO group_members VALUES(1,2)'); D.run("INSERT INTO shares(media_id,group_id) VALUES('mv1',1)");
  const withShare = P.buildProfile(2, 1).recent.find((r) => r.title === 'Movie 1');
  assert.ok(withShare.accessible && withShare.mediaId === 'mv1', 'shared items become openable');
});

console.log('ACHIEVEMENTS OK');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite lock on Windows */ }
process.exit(0);
