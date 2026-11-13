import { initChat } from './chat.js';
// ShowTime SPA - vanilla JS, no innerHTML with data (XSS-safe by construction).
const $app = document.getElementById('app');

// ---------- helpers ----------
const h = (tag, props, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat(9)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const LOGO = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"> <defs> <radialGradient id=\"pc\" cx=\"40%\" cy=\"35%\" r=\"70%\"><stop offset=\"0\" stop-color=\"#fffbe8\"/><stop offset=\".65\" stop-color=\"#ffe9a3\"/><stop offset=\"1\" stop-color=\"#ffc94d\"/></radialGradient> <linearGradient id=\"bk\" x1=\"0\" x2=\"0\" y1=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"#ff5468\"/><stop offset=\"1\" stop-color=\"#d81e3c\"/></linearGradient> <clipPath id=\"bc\"><path d=\"M13 31h38l-4.2 26.4q-.4 2.6-3 2.6H20.2q-2.6 0-3-2.6z\"/></clipPath> </defs> <g class=\"k\"> <circle cx=\"10\" cy=\"14\" r=\"2.6\" fill=\"#ffe08a\"/><circle cx=\"55\" cy=\"11\" r=\"2.2\" fill=\"#ffd25e\"/><circle cx=\"6\" cy=\"27\" r=\"1.8\" fill=\"#fff1bd\"/><circle cx=\"58\" cy=\"25\" r=\"2\" fill=\"#ffe9a3\"/> </g> <g stroke=\"#f0b13f\" stroke-width=\".8\" fill=\"url(#pc)\"> <circle cx=\"21\" cy=\"25\" r=\"8.5\"/><circle cx=\"43\" cy=\"25\" r=\"8.5\"/> <circle cx=\"26\" cy=\"14\" r=\"7.5\"/><circle cx=\"39\" cy=\"13.5\" r=\"7.5\"/> <circle cx=\"32\" cy=\"22\" r=\"10\"/><circle cx=\"32\" cy=\"9.5\" r=\"6.2\"/> </g> <g fill=\"#fff\" opacity=\".55\"><circle cx=\"28\" cy=\"19\" r=\"2.2\"/><circle cx=\"18\" cy=\"22\" r=\"1.7\"/><circle cx=\"38\" cy=\"10\" r=\"1.6\"/><circle cx=\"46\" cy=\"22\" r=\"1.5\"/></g> <g clip-path=\"url(#bc)\"> <rect x=\"10\" y=\"28\" width=\"44\" height=\"34\" fill=\"#fff6e6\"/> <path fill=\"url(#bk)\" d=\"M13 28h7.6l1.2 34h-5.6zM28.2 28h7.6l.6 34h-8.8zM43.4 28H51l-4.6 34h-5.6z\"/> <rect x=\"10\" y=\"28\" width=\"44\" height=\"34\" fill=\"#000\" opacity=\".06\"/> </g> <rect x=\"11\" y=\"29\" width=\"42\" height=\"4.6\" rx=\"2.3\" fill=\"#fff6e6\" stroke=\"#e4d2b4\" stroke-width=\".6\"/> <path d=\"M13 31h38l-4.2 26.4q-.4 2.6-3 2.6H20.2q-2.6 0-3-2.6z\" fill=\"none\" stroke=\"#b0172f\" stroke-width=\".8\" stroke-linejoin=\"round\"/> </svg>";
const logoEl = () => { const t = document.createElement('template'); t.innerHTML = LOGO; return t.content.firstElementChild; }; // static trusted markup only
const mount = (...nodes) => {
  const swap = () => $app.replaceChildren(...nodes.flat().filter(Boolean));
  if (document.startViewTransition && $app.firstChild && !matchMedia('(prefers-reduced-motion: reduce)').matches) { const t = document.startViewTransition(swap); for (const p of [t.ready, t.finished, t.updateCallbackDone]) p?.catch(() => {}); /* a skipped transition is harmless */ } else swap();
};
const hueOf = (x) => { let n = 0; for (const c of String(x)) n = (n * 31 + c.charCodeAt(0)) % 360; return n; };
/** Round avatar: the user's photo if they're a friend with one, else a coloured initial (aliases get a generated look). */
const avatarEl = (u, size = 32) => {
  const w = h('span', { class: 'av' });
  w.style.setProperty('--s', size + 'px');
  const fallback = () => { w.style.setProperty('--hue', hueOf(u.name || '?')); w.replaceChildren(h('b', null, (u.name || '?')[0].toUpperCase())); };
  if (u.avatar) { const img = h('img', { src: `/api/avatars/${u.id}?v=${u.avatar}`, alt: '', loading: 'lazy' }); img.onerror = fallback; w.append(img); } else fallback();
  return w;
};
const FIT = { fit: ['Fit to screen', 'contain'], fill: ['Fill screen (crop edges)', 'cover'], stretch: ['Stretch to fill', 'fill'], orig: ['Original size (no upscaling)', 'scale-down'] };
const CODEC_LABEL = { av1: 'AV1', vp9: 'VP9', h264: 'H.264', vp8: 'VP8', av2: 'AV2', hevc: 'HEVC', orig: 'Original' };
let hlsP = null;
const loadHls = () => (hlsP ||= new Promise((res, rej) => { const el = document.createElement('script'); el.src = './hls.min.js'; el.onload = res; el.onerror = () => { hlsP = null; rej(new Error('hls')); }; document.head.append(el); }));
let toastT;
const toast = (m) => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); };

async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'showtime', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) { if (r.status === 401 && S.user) { S.user = null; go('/login'); } throw new Error(j?.error || r.statusText); }
  return j;
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };

const fmtHours = (sec) => { sec = sec || 0; return sec >= 3600 ? (sec / 3600).toFixed(1) + ' h' : sec >= 60 ? Math.round(sec / 60) + ' min' : sec + ' sec'; };
const fmtDur = (s) => { if (!s) return ''; const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
const epLabel = (m) => (m.season != null && m.episode != null ? `S${String(m.season).padStart(2, '0')}E${String(m.episode).padStart(2, '0')}` : m.episode != null ? `E${m.episode}` : '');
const subtitle = (m) => (m.kind === 'tv' ? [m.show, epLabel(m)].filter(Boolean).join(' · ') : [m.year, fmtDur(m.duration)].filter(Boolean).join(' · '));
const resLabel = (m) => (m.height >= 2000 ? '4K' : m.height >= 1000 ? '1080p' : m.height >= 700 ? '720p' : m.height ? m.height + 'p' : '');

// ---------- state ----------
const S = { user: null, media: [], groups: [], rooms: [], info: null, online: [], reqCount: 0, chatUnread: 0 };
const chat = initChat({ h, api, toast, shell, mount, onUnread: (n) => { S.chatUnread = n; updateBadges(); } });
function updateBadges() {
  for (const [id, n] of [['friendsBadge', S.reqCount], ['chatBadge', S.chatUnread]]) { const b = document.getElementById(id); if (b) { b.textContent = String(n); b.hidden = !n; } }
}
let cleanup = null;
let pollT = null;

async function loadMe() { S.info = await api('GET', '/me'); S.user = S.info.user; }
async function loadData() {
  [S.media, S.groups, S.rooms] = await Promise.all([api('GET', '/media'), api('GET', '/groups'), api('GET', '/rooms')]);
  clearTimeout(pollT);
  if (S.media.some((m) => m.status === 'processing')) pollT = setTimeout(async () => { try { S.media = await api('GET', '/media'); if (/^#\/(library)?$|^#\/?$/.test(location.hash) || location.hash === '#/library') render(); } catch { /* ignore */ } }, 3000);
}

// ---------- global events: who's online + room invites ----------
let evSrc = null;
const seenInvites = new Set();
let currentRoomId = null;

function connectEvents() {
  if (evSrc) return;
  evSrc = new EventSource('/api/events');
  evSrc.addEventListener('online', (e) => { S.online = JSON.parse(e.data); updateOnlineBadge(); });
  evSrc.addEventListener('invite', (e) => invitePopup(JSON.parse(e.data)));
  evSrc.addEventListener('achievement', (e) => achievementPopup(JSON.parse(e.data)));
  evSrc.addEventListener('friend-state', (e) => { S.reqCount = JSON.parse(e.data).incoming; updateBadges(); if (location.hash === '#/friends') render(); });
  evSrc.addEventListener('friend-request', (e) => toast(`New friend request${JSON.parse(e.data).message ? ': "' + JSON.parse(e.data).message + '"' : ''}`));
  evSrc.addEventListener('friend-accepted', (e) => { toast(`${JSON.parse(e.data).name} is now your friend`); if (location.hash === '#/friends') render(); });
  evSrc.addEventListener('invite-result', (e) => {
    const d = JSON.parse(e.data);
    toast(d.accepted ? `${d.userName} is joining "${d.roomName}"` : `${d.userName} declined the invite`);
  });
}
function disconnectEvents() { evSrc?.close(); evSrc = null; S.online = []; S.reqCount = 0; seenInvites.clear(); }

function updateOnlineBadge() {
  const b = document.getElementById('onlineBtn');
  if (b) b.replaceChildren(h('span', { class: 'dot' }), ` ${S.online.length} online`);
  const t = document.getElementById('tileOnline'); // Home tile stays in step when presence arrives after first render
  if (t) t.textContent = String(S.online.length);
}

function chime() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') return; // browsers block audio until the user has interacted with the page
    [[660, 0], [880, 0.12]].forEach(([f, t]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = f; o.type = 'sine'; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.25);
      o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.3);
    });
    setTimeout(() => ac.close(), 800);
  } catch { /* no audio */ }
}

// Xbox-style slide-in card
function invitePopup(inv) {
  if (seenInvites.has(inv.id)) return;
  seenInvites.add(inv.id);
  let box = document.getElementById('notifs');
  if (!box) { box = h('div', { id: 'notifs' }); document.body.append(box); }
  const card = h('div', { class: 'notif' });
  const dismiss = () => { card.classList.remove('in'); setTimeout(() => card.remove(), 300); };
  const answer = (accept) => async () => {
    try {
      const r = await api('POST', `/invites/${inv.id}/respond`, { accept });
      dismiss();
      if (accept && r.roomId) go('/room/' + r.roomId);
    } catch (e) { toast(e.message); dismiss(); }
  };
  card.append(
    avatarEl({ id: inv.from.id, name: inv.from.name, avatar: inv.from.avatar }, 44),
    h('div', { class: 'tx' }, h('div', { class: 'tt' }, `${inv.from.name} invited you`), h('div', { class: 'sb' }, `Join "${inv.roomName}"`),
      h('div', { class: 'ab' }, h('button', { class: 'btn sm', onclick: answer(true) }, 'Join'), h('button', { class: 'btn sec sm', onclick: answer(false) }, 'Not now'))),
    h('i', { class: 'cd' }),
  );
  box.append(card);
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
  chime();
  setTimeout(dismiss, 20000); // unanswered invites stay valid server-side for 1h and reappear after a reconnect/reload
}

const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
let achBuf = [], achTimer = null;
/** Unlocks arriving together are batched: up to 3 get their own card, bigger bursts collapse into one summary. */
function achievementPopup(a) { achBuf.push(a); clearTimeout(achTimer); achTimer = setTimeout(flushAch, 700); }
function flushAch() {
  const list = achBuf; achBuf = [];
  if (list.length > 3) showAch({ icon: '🏆', tier: 'gold', name: `${list.length} achievements unlocked`, desc: list.slice(0, 4).map((x) => x.name).join(', ') + ' and more' });
  else list.forEach(showAch);
}
function showAch(a) {
  let box = document.getElementById('notifs');
  if (!box) { box = h('div', { id: 'notifs' }); document.body.append(box); }
  const card = h('div', { class: 'notif ach', onclick: () => { go('/profile'); } });
  const dismiss = () => { card.classList.remove('in'); setTimeout(() => card.remove(), 300); };
  card.append(h('div', { class: 'medal ' + a.tier }, a.icon), h('div', { class: 'tx' }, h('div', { class: 'tt' }, 'Achievement unlocked!'), h('div', { class: 'sb' }, h('b', null, a.name), ' - ', a.desc), h('div', { class: 'tier' }, TIER_LABEL[a.tier] || a.tier)), h('i', { class: 'cd gold' }));
  box.append(card);
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
  chime();
  setTimeout(dismiss, 9000);
}

function onlineModal() {
  modal(() => h('div', { class: 'mb' }, h('h2', null, 'Online now'),
    h('p', { class: 'muted small' }, 'Only your friends can ever see you online (and only if you allow it in Account).'),
    S.online.length ? h('div', { class: 'list' }, S.online.map((u) => h('div', null, avatarEl(u, 30), h('span', { class: 'g' }, u.name, h('span', { class: 'muted' }, ` @${u.username}`), ' ', h('span', { class: 'dot' })),
      currentRoomId && h('button', { class: 'btn sm', onclick: guard(async (e) => { await inviteUser(currentRoomId, u.id, e.target); }) }, 'Invite to room')))) : h('p', { class: 'muted' }, 'Nobody else is online.')));
}

async function inviteUser(roomId, userId, btn) {
  const r = await api('POST', `/rooms/${roomId}/invite`, { userId });
  if (btn) { btn.textContent = r.already ? 'Already here' : r.delivered ? 'Invited ✓' : 'Sent (offline)'; btn.disabled = true; }
}

function inviteModal(roomId) {
  api('GET', `/rooms/${roomId}/invitees`).then((rows) => modal(() => h('div', { class: 'mb' }, h('h2', null, 'Invite to this room'),
    rows.length ? h('div', { class: 'list' }, rows.map((u) => h('div', null, avatarEl(u, 30), h('span', { class: 'g' }, u.name, ' ', u.friend ? h('span', { class: u.online ? 'dot' : 'dot off', title: u.online ? 'online' : 'offline' }) : h('span', { class: 'muted small' }, '(not a friend - identity hidden)')),
      h('button', { class: 'btn sm', disabled: u.inRoom, onclick: guard(async (e) => { await inviteUser(roomId, u.id, e.target); }) }, u.inRoom ? 'In room' : 'Invite'))))
      : h('p', { class: 'muted' }, 'Nobody else is in this room\'s group yet. Add people on the Groups page.')))).catch((e) => toast(e.message));
}

// ---------- router ----------
const go = (p) => { if (location.hash === '#' + p) render(); else location.hash = p; };
window.addEventListener('hashchange', render);

async function render() {
  cleanup?.(); cleanup = null;
  const [path, qs] = location.hash.slice(1).split('?');
  const q = new URLSearchParams(qs || '');
  const p = path || '/';
  try {
    if (!S.info) await loadMe();
    else if (!['/login', '/register', '/forgot', '/reset'].includes(p)) await loadMe();
    if (['/login', '/register', '/forgot', '/reset'].includes(p)) {
      if (S.user && p !== '/reset') return go('/');
      return authView(p, q);
    }
    if (!S.user) { disconnectEvents(); return go(S.info.firstRun ? '/register' : '/login'); }
    connectEvents();
    await loadData();
    if (p === '/') return homeView();
    if (p === '/library') return libraryView();
    if (p === '/rooms') return roomsView();
    if (p === '/friends') return friendsView();
    if (p === '/profile') return profileView();
    if (p.startsWith('/profile/')) return profileView(+p.split('/')[2]);
    if (p === '/chat') { cleanup = chat.leaveView; return chat.chatView(); }
    if (p === '/iptv') return iptvView();
    if (p === '/stats') return statsView();
    if (p.startsWith('/room/')) return roomView(p.split('/')[2]);
    if (p === '/groups') return groupsView();
    if (p === '/admin' && S.user.isAdmin) return adminView();
    if (p === '/account') return accountView();
    go('/');
  } catch (e) { mount(h('main', null, h('p', { class: 'err' }, e.message))); }
}

// ---------- chrome ----------
function shell(active, ...content) {
  const link = (href, label, bid) => { const n = bid === 'friendsBadge' ? S.reqCount : bid === 'chatBadge' ? S.chatUnread : 0; return h('a', { class: 'l' + (active === href ? ' on' : ''), href: '#' + href }, label, bid ? h('i', { class: 'nbadge', id: bid, hidden: !n }, String(n)) : null); };
  return [
    h('nav', { class: 'top' },
      h('a', { class: 'brand', href: '#/', title: 'ShowTime' }, logoEl(), h('b', null, 'ShowTime')),
      link('/', 'Home'), link('/library', 'Library'), link('/iptv', 'Live TV'), link('/rooms', 'Rooms'), link('/friends', 'Friends', 'friendsBadge'), link('/groups', 'Groups'), link('/chat', 'Chat', 'chatBadge'), link('/stats', 'Stats'),
      S.user.isAdmin && link('/admin', 'Admin'),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn sec sm', id: 'onlineBtn', title: 'Online now', onclick: onlineModal }, h('span', { class: 'dot' }), ` ${S.online.length} online`),
      h('button', { class: 'btn sm', onclick: uploadModal }, '＋ Upload'),
      h('a', { class: 'l acct', href: '#/profile', title: 'Your profile, badges & watch history' }, avatarEl({ id: S.user.id, name: S.user.name, avatar: S.user.avatar }, 26), S.user.name),
      h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('POST', '/logout'); disconnectEvents(); chat.resetChat(); S.user = null; S.info = null; go('/login'); }) }, 'Log out'),
    ),
    h('main', null, ...content),
  ];
}

function modal(build) {
  const bg = h('div', { class: 'modalbg', onclick: (e) => e.target === bg && close() });
  const close = () => bg.remove();
  const m = h('div', { class: 'modal' });
  m.append(h('button', { class: 'x', onclick: close, 'aria-label': 'Close' }, '×'), ...[build(close)].flat());
  bg.append(m);
  document.body.append(bg);
  return close;
}

// ---------- auth views ----------
function authView(p, q) {
  const err = h('div', { class: 'err' });
  const f = (name, label, type = 'text', val = '') => [h('label', { for: name }, label), h('input', { id: name, name, type, value: val, autocomplete: type === 'password' ? (p === 'login' ? 'current-password' : 'new-password') : 'on', required: true })];
  const val = (id) => document.getElementById(id).value;
  const submit = (fn) => async (e) => { e.preventDefault(); err.textContent = ''; try { await fn(); } catch (x) { err.textContent = x.message; } };
  let title, body, links;
  if (p === '/login') {
    title = 'Sign In';
    body = h('form', { onsubmit: submit(async () => { await api('POST', '/login', { login: val('login'), password: val('password') }); S.info = null; go('/'); }) },
      f('login', 'Username or email'), f('password', 'Password', 'password'), err, h('p', null, h('button', { class: 'btn', style: false }, 'Sign in')));
    links = [h('a', { href: '#/forgot' }, 'Forgot password?'), S.info?.openSignup ? h('a', { href: '#/register' }, 'Create account') : h('a', { href: '#/register' }, 'Have an invite?')];
  } else if (p === '/register') {
    title = S.info?.firstRun ? 'Create Admin Account' : 'Create Account';
    body = h('form', { onsubmit: submit(async () => { await api('POST', '/register', { username: val('username'), name: val('name'), email: val('email'), password: val('password'), invite: S.info.firstRun ? '' : document.getElementById('invite')?.value }); S.info = null; go('/'); }) },
      !S.info?.firstRun && !S.info?.openSignup && f('invite', 'Invite code', 'text', q.get('invite') || ''),
      f('username', 'Username'), f('name', 'Display name'), f('email', 'Email', 'email'), f('password', 'Password (10+ characters)', 'password'), err,
      h('p', null, h('button', { class: 'btn' }, 'Create account')));
    links = [h('a', { href: '#/login' }, 'Already have an account?')];
  } else if (p === '/forgot') {
    title = 'Reset Password';
    body = h('form', { onsubmit: submit(async () => { await api('POST', '/forgot', { email: val('email') }); err.textContent = ''; body.replaceWith(h('p', null, 'If that email has an account, a reset link is on its way.')); }) },
      f('email', 'Email', 'email'), err, h('p', null, h('button', { class: 'btn' }, 'Send reset link')));
    links = [h('a', { href: '#/login' }, 'Back to sign in')];
  } else {
    title = 'Choose New Password';
    body = h('form', { onsubmit: submit(async () => { await api('POST', '/reset', { token: q.get('token'), password: val('password') }); toast('Password updated - sign in'); S.info = null; go('/login'); }) },
      f('password', 'New password (10+ characters)', 'password'), err, h('p', null, h('button', { class: 'btn' }, 'Set password')));
    links = [h('a', { href: '#/login' }, 'Back to sign in')];
  }
  mount(h('div', { class: 'authbox' }, h('div', { class: 'big' }, logoEl(), h('b', null, 'ShowTime')), h('h3', null, title), body, h('div', { class: 'links' }, links)));
}

// ---------- media cards / grouping ----------
const thumbEl = (m) => {
  const p = h('div', { class: 'poster' }, h('div', { class: 'ph' }, (m.show || m.title || '?')[0].toUpperCase()));
  if (m.hasThumb) { const img = h('img', { src: `/api/media/${m.id}/thumb`, loading: 'lazy', alt: '' }); img.onerror = () => img.remove(); p.prepend(img); }
  return p;
};
function mediaCard(m, onclick) {
  const p = thumbEl(m);
  if (m.status === 'processing') p.append(h('span', { class: 'badge warn' }, m.progress != null ? `Converting ${Math.round(m.progress * 100)}%` : 'Processing…'));
  else if (m.status === 'error') p.append(h('span', { class: 'badge warn' }, 'Error'));
  else if (m.encoding) p.append(h('span', { class: 'badge warn' }, m.encoding === 'scan' ? 'Scanning codecs…' : `Encoding ${CODEC_LABEL[m.encoding] || m.encoding} ${Math.round((m.progress || 0) * 100)}%`));
  else if (!m.playable) p.append(h('span', { class: 'badge warn' }, 'Needs convert'));
  else if (resLabel(m)) p.append(h('span', { class: 'badge' }, resLabel(m)));
  return h('div', { class: 'card', onclick: onclick || (() => mediaModal(m.id)) }, p, h('div', { class: 't' }, m.title), h('div', { class: 's' }, subtitle(m)));
}
function showCard(show, eps) {
  const first = eps.find((e) => e.hasThumb) || eps[0];
  const p = thumbEl({ ...first, show });
  p.append(h('span', { class: 'badge' }, `${eps.length} ep`));
  return h('div', { class: 'card', onclick: () => showModal(show) }, p, h('div', { class: 't' }, show), h('div', { class: 's' }, `${new Set(eps.map((e) => e.season)).size} season(s)`));
}
const byShow = (list) => { const g = new Map(); for (const m of list) (g.get(m.show || 'Unknown Show') || g.set(m.show || 'Unknown Show', []).get(m.show || 'Unknown Show')).push(m); return g; };
const epSort = (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title);

function showModal(show) {
  const eps = S.media.filter((m) => m.kind === 'tv' && (m.show || 'Unknown Show') === show).sort(epSort);
  modal((close) => h('div', { class: 'mb' }, h('h2', null, show),
    h('div', { class: 'acts' }, h('button', { class: 'btn sm', onclick: guard(async () => { close(); await playNow(eps.filter((e) => e.playable && e.status === 'ready').map((e) => e.id)); }) }, '▶ Play all'),
      h('button', { class: 'btn sec sm', onclick: guard(async () => { await queueTo(eps.filter((e) => e.playable && e.status === 'ready').map((e) => e.id)); }) }, '＋ Queue all')),
    h('div', { class: 'list' }, eps.map((e) => h('div', null, h('span', { class: 'muted' }, epLabel(e)), h('span', { class: 'g' }, e.title), h('span', { class: 'muted small' }, fmtDur(e.duration)),
      h('button', { class: 'btn sec sm', onclick: () => { close(); mediaModal(e.id); } }, 'Details'))))));
}

// ---------- play / queue ----------
async function soloRoom() { return (await api('POST', '/rooms', {})).id; }
async function playNow(ids) {
  if (!ids.length) throw new Error('Nothing playable');
  const id = await soloRoom();
  await api('POST', `/rooms/${id}/cmd`, { type: 'clear' });
  for (const mid of ids) await api('POST', `/rooms/${id}/cmd`, { type: 'add', mediaId: mid });
  go('/room/' + id);
}
function queueTo(ids) {
  return new Promise((resolve) => {
    const sel = h('select', null, S.rooms.map((r) => h('option', { value: r.id }, r.name + (r.groupId ? '' : ' (solo)'))));
    if (!S.rooms.length) { toast('Create a room first (Rooms tab) or press Play'); return resolve(); }
    const close = modal((c) => h('div', { class: 'mb' }, h('h3', null, 'Add to which room?'), sel,
      h('p', null, h('button', { class: 'btn', onclick: guard(async () => { for (const m of ids) await api('POST', `/rooms/${sel.value}/cmd`, { type: 'add', mediaId: m }); toast('Queued'); c(); resolve(); }) }, 'Add to queue'))));
  });
}

// ---------- media detail ----------
function mediaModal(id) {
  const m = S.media.find((x) => x.id === id);
  if (!m) return;
  modal((close) => {
    const chips = [m.kind, m.year, resLabel(m), m.vcodec, m.acodec, fmtDur(m.duration), m.size && fmtSize(m.size), m.source === 'local' ? 'local library' : m.owned ? 'encrypted vault' : `shared by ${m.owner}`].filter(Boolean);
    const acts = h('div', { class: 'acts' });
    const ready = m.status === 'ready' && m.playable;
    acts.append(
      h('button', { class: 'btn', disabled: !ready, onclick: guard(async () => { close(); await playNow([m.id]); }) }, '▶ Watch'),
      h('button', { class: 'btn sec', disabled: !ready, onclick: guard(() => queueTo([m.id])) }, '＋ Add to room queue'),
    );
    if (m.owned) {
      if (!m.playable && m.status === 'ready') acts.append(h('button', { class: 'btn sec', onclick: guard(async () => { await api('POST', `/media/${m.id}/convert`); toast('Converting - this can take a while'); close(); render(); }) }, 'Convert for browser'));
      acts.append(h('button', { class: 'btn sec', onclick: () => { close(); editModal(m); } }, 'Edit'), h('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm(m.source === 'local' ? 'Remove from library? (your original file is NOT deleted)' : 'Permanently delete this file?')) return; await api('DELETE', `/media/${m.id}`); close(); render(); }) }, 'Delete'));
    }
    const share = m.owned && S.groups.length ? h('div', null, h('h3', null, 'Share with groups'), S.groups.map((g) => {
      const cb = h('input', { type: 'checkbox', style: false, checked: m.groups.includes(g.id), onchange: guard(async () => { await api('POST', `/media/${m.id}/share`, { groupId: g.id, share: cb.checked }); toast(cb.checked ? 'Shared' : 'Unshared'); await loadData(); }) });
      cb.style.width = 'auto';
      return h('label', { style: false }, cb, ' ', g.name, h('span', { class: 'muted small' }, ` (${g.members.length})`));
    })) : null;
    return [h('div', { class: 'mh' }, thumbEl(m)), h('div', { class: 'mb' }, h('h2', null, m.title), h('div', { class: 'muted' }, subtitle(m)), h('div', { class: 'chips' }, chips.map((c) => h('span', { class: 'chip' }, c))),
      m.error && h('p', { class: 'err' }, m.error), m.status === 'processing' && h('p', { class: 'muted' }, 'Still processing…'), acts, share, codecSection(m, close), subsSection(m, close))];
  });
}
function codecSection(m, close) {
  const reopen = async () => { await loadData(); close(); mediaModal(m.id); };
  const kbps = (r) => (r.bitrate ? (r.bitrate / 1e6).toFixed(1) + ' Mbps' : '');
  const rows = (m.renditions || []).map((r) => h('div', null, h('span', { class: 'chip' }, CODEC_LABEL[r.codec] || r.codec), h('span', { class: 'g' }, [r.original ? 'original file' : 'encoded copy', r.height && r.height + 'p', kbps(r), r.size && fmtSize(r.size)].filter(Boolean).join(' · ')),
    m.owned && !r.original && h('button', { class: 'btn sec sm', title: 'Delete this encoded copy', onclick: guard(async () => { await api('DELETE', `/media/${m.id}/renditions/${r.id}`); await reopen(); }) }, '✕')));
  const have = new Set((m.renditions || []).map((r) => r.codec));
  const scan = m.scan;
  const T = scan?.trials || {};
  return h('div', null, h('h3', null, 'Video versions'),
    h('p', { class: 'muted small' }, 'Each viewer\'s player automatically picks the version that suits their device and connection (hardware decode, smooth playback, smallest bitrate). They can also switch AV1 / VP9 / H.264 live in the room.'),
    rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted small' }, 'No playable version yet.'),
    m.encoding && h('p', { class: 'muted small' }, m.encoding === 'scan' ? 'Scanning this file (trial-encoding a few seconds with each codec)…' : `Encoding ${CODEC_LABEL[m.encoding] || m.encoding}: ${Math.round((m.progress || 0) * 100)}%`),
    m.owned && h('div', { class: 'acts' },
      h('button', { class: 'btn sec sm', title: 'Re-run the quick codec scan and encode whatever is worth it', onclick: guard(async () => { await api('POST', `/media/${m.id}/analyze`); toast('Scanning - the best version(s) will be encoded in the background'); close(); }) }, 'Scan & optimise'),
      ['av1', 'vp9', 'h264'].filter((c) => !have.has(c)).map((c) => h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('POST', `/media/${m.id}/encode`, { codec: c }); toast(`Encoding ${CODEC_LABEL[c]} in the background`); close(); }) }, `＋ ${CODEC_LABEL[c]} version`))),
    scan?.plan && h('details', { class: 'scan' }, h('summary', null, 'Codec scan report'),
      h('p', { class: 'muted small' }, `Source: ${CODEC_LABEL[scan.source.codec] || scan.source.codec} ${scan.source.width}x${scan.source.height} · ${scan.source.videoKbps} kbps · ${scan.source.durationSec}s${scan.source.hdr ? ' · HDR' : ''}`),
      h('table', null, h('tr', null, ['Codec', 'Encoder tried', 'Speed', 'Projected size/time'].map((x) => h('th', null, x))), Object.entries(T).map(([c, t]) => h('tr', null, h('td', null, CODEC_LABEL[c] || c), h('td', { class: 'muted' }, t.ok ? t.tag : (t.err || 'n/a')), h('td', null, t.ok ? t.speedX + '× realtime' : '-'), h('td', { class: 'muted' }, t.ok ? `${(t.projectedBps / 1e6).toFixed(2)} Mbps · ${t.projectedSecs}s` : '-')))),
      h('ul', { class: 'muted small' }, scan.plan.reasons.map((r) => h('li', null, r))),
      scan.encodeError && h('p', { class: 'err' }, scan.encodeError), scan.error && h('p', { class: 'err' }, scan.error)));
}
function subsSection(m, close) {
  const reopen = async () => { await loadData(); close(); mediaModal(m.id); };
  const rows = m.subs.map((s) => h('div', null, h('span', { class: 'g' }, s.label), s.lang && h('span', { class: 'chip' }, s.lang), h('span', { class: 'chip' }, s.source),
    m.owned && h('button', { class: 'btn sec sm', title: 'Delete', onclick: guard(async () => { await api('DELETE', '/subs/' + s.id); await reopen(); }) }, '✕')));
  const upload = () => {
    const inp = h('input', { type: 'file', accept: '.srt,.vtt,.ass,.ssa' });
    inp.addEventListener('change', guard(async () => {
      const f = inp.files[0];
      if (!f) return;
      const lang = prompt('Language code (e.g. en, es, fr) - leave blank if unknown', 'en');
      if (lang === null) return;
      const r = await fetch(`/api/media/${m.id}/subs?name=${encodeURIComponent(f.name)}&lang=${encodeURIComponent(lang)}`, { method: 'PUT', headers: { 'X-Requested-With': 'showtime' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Upload failed');
      toast('Subtitles added');
      await reopen();
    }));
    inp.click();
  };
  return h('div', null, h('h3', null, 'Subtitles'),
    rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted small' }, 'None yet. Embedded tracks and sidecar .srt files next to library videos are found automatically.'),
    m.owned && h('div', { class: 'acts' }, h('button', { class: 'btn sec sm', onclick: upload }, '＋ Upload .srt / .vtt / .ass'),
      h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('POST', `/media/${m.id}/subs/extract`); toast('Scanning - reopen this window in a moment'); }) }, 'Scan file for subtitles')));
}

// SRT/VTT -> [{s,e,text}] (used for live P2P subtitles; library subtitles use native <track>)
function parseCues(text) {
  const cues = [];
  const ts = (h2, m, s2, ms) => (+h2 || 0) * 3600 + +m * 60 + +s2 + +String(ms).padEnd(3, '0') / 1000;
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const m = lines[i].match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
    if (!m) continue;
    const t = lines.slice(i + 1).join('\n').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
    if (t) cues.push({ s: ts(m[1], m[2], m[3], m[4]), e: ts(m[5], m[6], m[7], m[8]), text: t });
  }
  return cues;
}

function editModal(m) {
  const inp = (k, label, type = 'text') => [h('label', null, label), h('input', { id: 'e_' + k, type, value: m[k] ?? '' })];
  modal((close) => h('div', { class: 'mb' }, h('h2', null, 'Edit details'),
    inp('title', 'Title'),
    h('label', null, 'Category'), h('select', { id: 'e_kind' }, ['movie', 'tv', 'video'].map((k) => h('option', { value: k, selected: m.kind === k }, k === 'tv' ? 'TV show' : k === 'movie' ? 'Movie' : 'Other video'))),
    inp('show', 'Show (TV only)'), h('div', { class: 'two' }, h('div', null, inp('season', 'Season', 'number')), h('div', null, inp('episode', 'Episode', 'number'))), inp('year', 'Year', 'number'),
    h('p', null, h('button', { class: 'btn', onclick: guard(async () => {
      const v = (k) => document.getElementById('e_' + k).value;
      await api('PATCH', `/media/${m.id}`, { title: v('title'), kind: v('kind'), show: v('show'), season: v('season'), episode: v('episode'), year: v('year') });
      close(); render();
    }) }, 'Save'))));
}

// ---------- upload ----------
function uploadModal() {
  const list = h('div', { class: 'list' });
  const input = h('input', { type: 'file', multiple: true, accept: 'video/*,.mkv,.avi,.ts,.m2ts,.wmv,.flv,.mpg,.mpeg,.ogv' });
  let busy = false;
  const start = async () => {
    if (busy) return;
    busy = true;
    for (const f of input.files) {
      const bar = h('i'); const stat = h('span', { class: 'muted small' }, 'waiting');
      list.append(h('div', null, h('span', { class: 'g' }, f.name), h('div', { class: 'prog', style: false }, bar), stat));
      list.lastChild.querySelector('.prog').style.width = '120px';
      await new Promise((res) => {
        const x = new XMLHttpRequest();
        x.open('PUT', '/api/upload?name=' + encodeURIComponent(f.name));
        x.setRequestHeader('X-Requested-With', 'showtime');
        x.upload.onprogress = (e) => { bar.style.width = (e.loaded / e.total) * 100 + '%'; stat.textContent = Math.round((e.loaded / e.total) * 100) + '%'; };
        x.onload = () => { stat.textContent = x.status === 201 ? 'encrypted ✓' : (JSON.parse(x.responseText || '{}').error || 'failed'); res(); };
        x.onerror = () => { stat.textContent = 'network error'; res(); };
        x.send(f);
      });
    }
    busy = false;
    await loadData(); if (location.hash.length <= 2 || location.hash === '#/library') render();
  };
  modal(() => h('div', { class: 'mb' }, h('h2', null, 'Upload'), h('p', { class: 'muted small' }, 'Files are encrypted (AES-256-GCM) as they arrive. Movies and TV episodes are sorted automatically from the filename and metadata. Only upload content you have the right to share.'),
    input, h('p', null, h('button', { class: 'btn', onclick: start }, 'Upload & encrypt')), list));
}

// ---------- home / library ----------
function homeView() {
  const ready = S.media;
  const movies = ready.filter((m) => m.kind === 'movie'), tv = ready.filter((m) => m.kind === 'tv'), other = ready.filter((m) => m.kind === 'video');
  const shared = ready.filter((m) => !m.owned);
  const pick = ready.filter((m) => m.hasThumb && m.status === 'ready')[Math.floor(Math.random() * ready.filter((m) => m.hasThumb && m.status === 'ready').length)];
  const row = (title, cards) => cards.length ? h('section', { class: 'row' }, h('h2', null, title), h('div', { class: 'strip' }, cards)) : null;
  const byRecent = (a, b) => b.createdAt - a.createdAt;
  const tWeek = h('div', { class: 'v g' }, '…'), tTotal = h('div', { class: 'v' }, '…');
  api('GET', '/stats').then((x) => { tWeek.textContent = fmtHours(x.week); tTotal.textContent = fmtHours(x.total); }).catch(() => {});
  mount(shell('/',
    h('div', { class: 'tiles' }, h('div', { class: 'tile' }, h('div', { class: 'v' }, String(ready.length)), h('div', { class: 't' }, 'in your library')), h('div', { class: 'tile' }, h('div', { class: 'v', id: 'tileOnline' }, String(S.online.length)), h('div', { class: 't' }, 'friends online')), h('div', { class: 'tile' }, tWeek, h('div', { class: 't' }, 'watched this week')), h('div', { class: 'tile' }, tTotal, h('div', { class: 't' }, 'watched all-time'))),
    pick ? h('div', { class: 'hero' }, h('img', { src: `/api/media/${pick.id}/thumb`, alt: '' }), h('div', { class: 'in' }, h('h1', null, pick.show || pick.title), h('p', { class: 'muted' }, subtitle(pick)),
      h('button', { class: 'btn', onclick: guard(() => playNow([pick.id])) }, '▶ Play'), ' ', h('button', { class: 'btn sec', onclick: () => mediaModal(pick.id) }, 'ⓘ Details'))) : null,
    !ready.length ? h('div', { class: 'panel' }, h('h2', null, 'Welcome to ShowTime'), h('p', { class: 'muted' }, 'Upload a video, or ask the admin to scan a local library folder. Then create a group, share, and start a room.')) : null,
    row('Recently added', [...ready].sort(byRecent).slice(0, 15).map((m) => mediaCard(m))),
    row('Movies', movies.sort(byRecent).map((m) => mediaCard(m))),
    row('TV Shows', [...byShow(tv)].map(([s, e]) => showCard(s, e))),
    row('Shared with you', shared.sort(byRecent).map((m) => mediaCard(m))),
    row('Other videos', other.map((m) => mediaCard(m))),
  ));
}

const lib = { q: '', tab: 'all', sort: 'recent' };
function libraryView() {
  const grid = h('div', { class: 'grid' });
  const draw = () => {
    let l = S.media.filter((m) => (lib.q ? (m.title + ' ' + (m.show || '')).toLowerCase().includes(lib.q.toLowerCase()) : true));
    l = l.filter((m) => ({ all: true, movie: m.kind === 'movie', tv: m.kind === 'tv', video: m.kind === 'video', mine: m.owned, shared: !m.owned })[lib.tab]);
    const sorters = { recent: (a, b) => b.createdAt - a.createdAt, title: (a, b) => (a.show || a.title).localeCompare(b.show || b.title) || epSort(a, b), year: (a, b) => (b.year || 0) - (a.year || 0), length: (a, b) => (b.duration || 0) - (a.duration || 0) };
    l.sort(sorters[lib.sort]);
    const cards = lib.tab === 'tv' ? [...byShow(l)].map(([s, e]) => showCard(s, e)) : l.map((m) => mediaCard(m));
    grid.replaceChildren(...(cards.length ? cards : [h('p', { class: 'muted' }, 'Nothing here yet.')]));
  };
  const tabs = h('div', { class: 'tabs' }, [['all', 'All'], ['movie', 'Movies'], ['tv', 'TV Shows'], ['video', 'Other'], ['mine', 'Mine'], ['shared', 'Shared with me']].map(([k, l]) => h('button', { class: 'tab' + (lib.tab === k ? ' on' : ''), onclick: (e) => { lib.tab = k; tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('on')); e.target.classList.add('on'); draw(); } }, l)));
  const search = h('input', { type: 'search', placeholder: 'Search…', value: lib.q, oninput: (e) => { lib.q = e.target.value; draw(); } });
  const sort = h('select', { onchange: (e) => { lib.sort = e.target.value; draw(); } }, [['recent', 'Recently added'], ['title', 'Title / episode'], ['year', 'Year'], ['length', 'Length']].map(([k, l]) => h('option', { value: k, selected: lib.sort === k }, l)));
  draw();
  mount(shell('/library', h('div', { class: 'toolbar' }, tabs, h('span', { style: false }), search, sort), grid));
}

// ---------- groups ----------
async function groupsView() {
  const create = h('input', { placeholder: 'New group name' });
  const friends = (await api('GET', '/friends')).friends;
  mount(shell('/groups',
    h('h1', null, 'Groups'), h('p', { class: 'muted' }, 'Share files with a group, then start a room for it. You can only add people from your Friends list; members who are not friends with each other see one another only as anonymous aliases.'),
    h('div', { class: 'panel toolbar' }, create, h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/groups', { name: create.value }); render(); }) }, 'Create group')),
    S.groups.map((g) => {
      const inGroup = new Set(g.members.map((u) => u.id));
      const pick = h('select', null, friends.filter((f) => !inGroup.has(f.id)).map((f) => h('option', { value: f.id }, f.name)));
      return h('div', { class: 'panel' }, h('h3', null, g.name, g.owned && h('span', { class: 'chip' }, ' owner')),
        h('div', { class: 'list' }, g.members.map((u) => h('div', null, avatarEl(u, 30), h('span', { class: 'g' }, u.id === S.user.id ? `${u.name} (you)` : u.name, ' ', u.friend ? h('span', { class: 'chip' }, 'friend') : u.id === S.user.id ? null : h('span', { class: 'muted small' }, 'identity hidden')),
          (g.owned && u.id !== S.user.id || u.id === S.user.id && !g.owned) && h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('DELETE', `/groups/${g.id}/members/${u.id}`); render(); }) }, u.id === S.user.id ? 'Leave' : 'Remove')))),
        g.owned && h('div', { class: 'toolbar' }, pick.options.length ? [pick, h('button', { class: 'btn sec', onclick: guard(async () => { await api('POST', `/groups/${g.id}/members`, { userId: +pick.value }); render(); }) }, 'Add friend')] : h('span', { class: 'muted small' }, 'All your friends are already in this group (add friends on the Friends page).'),
          h('button', { class: 'btn danger', onclick: guard(async () => { if (confirm('Delete group and its rooms?')) { await api('DELETE', `/groups/${g.id}`); render(); } }) }, 'Delete group')));
    }),
  ));
}

// ---------- rooms ----------
function roomsView() {
  const name = h('input', { placeholder: 'Room name' });
  const gsel = h('select', null, S.groups.map((g) => h('option', { value: g.id }, g.name)));
  mount(shell('/rooms', h('h1', null, 'Watch rooms'),
    S.groups.length ? h('div', { class: 'panel toolbar' }, name, gsel, h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/rooms', { name: name.value, groupId: +gsel.value }); go('/room/' + r.id); }) }, 'Create room for group')) : h('p', { class: 'muted' }, 'Create a group first to open shared rooms.'),
    h('div', { class: 'panel list' }, S.rooms.length ? S.rooms.map((r) => h('div', null, h('span', { class: 'g' }, r.name, h('span', { class: 'muted small' }, r.groupId ? ` · ${S.groups.find((g) => g.id === r.groupId)?.name || 'group'}` : ' · solo')),
      h('a', { class: 'btn sm', href: '#/room/' + r.id }, 'Join'), r.owned && r.groupId && h('button', { class: 'btn danger sm', onclick: guard(async () => { await api('DELETE', '/rooms/' + r.id); render(); }) }, 'Delete'))) : h('p', { class: 'muted' }, 'No rooms yet - press Play on any title to open your solo room.'))));
}

function roomView(id) {
  const video = h('video', { controls: true, playsinline: true, preload: 'auto' });
  const stage = h('div', { class: 'stage' });
  const queueEl = h('div', { class: 'list q' });
  const whoEl = h('div', { class: 'who' });
  const titleEl = h('h2', null, '');
  let st = null, offset = 0, loaded = null, ignoreUntil = 0, es = null, roomName = '', myCid = null;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  // --- live ("stream local file", peer-to-peer) state ---
  const hosted = new Map(); // liveId -> { url, file }   (host side: files never leave this browser except as a WebRTC stream)
  const peers = new Map(); // host side: viewerCid -> RTCPeerConnection
  const pendingWants = new Set();
  let hostStream = null, hostLive = null; // host side
  let vPc = null, vLive = null, wantAt = 0, earlyIce = []; // viewer side
  // --- subtitles for live streams: sent host -> viewers over the WebRTC data channel (never via the server) ---
  let hostSub = null; // host: { label, text, cues }
  let viewSub = null, subBuf = null; // viewer: { label, cues }
  let clock = null; // viewer's estimate of the host's media time: { pos, at, playing }
  const subEl = h('div', { class: 'subs' });
  currentRoomId = id;

  // library subtitles -> native <track> elements (each viewer picks their own; language choice is remembered locally)
  let trackGuard = 0;
  const prefLang = () => { try { return localStorage.getItem('st_sublang') || ''; } catch { return ''; } };
  video.textTracks.addEventListener('change', () => {
    if (performance.now() < trackGuard) return;
    const on = [...video.textTracks].find((t) => t.mode === 'showing');
    try { localStorage.setItem('st_sublang', on ? on.language || on.label : ''); } catch { /* private mode */ }
  });
  const setTracks = (subs) => {
    trackGuard = performance.now() + 1500;
    video.querySelectorAll('track').forEach((t) => t.remove());
    const pref = prefLang();
    let chosen = false;
    for (const sb of subs || []) {
      const want = !chosen && pref && (sb.lang === pref || sb.label === pref);
      if (want) chosen = true;
      video.append(h('track', { kind: 'subtitles', src: '/api/subs/' + sb.id, srclang: sb.lang || false, label: sb.label, default: !!want }));
    }
  };
  const cueAt = (cues, t) => cues?.find((c) => t >= c.s && t <= c.e)?.text || '';
  const subTimer = setInterval(() => {
    if (!stage.contains(subEl)) stage.append(subEl);
    const it = cur();
    let text = '';
    if (it?.live) {
      if (it.hostId === S.user.id) text = cueAt(hostSub?.cues, video.currentTime);
      else if (clock && viewSub) text = cueAt(viewSub.cues, clock.pos + (clock.playing ? (performance.now() - clock.at) / 1000 : 0));
    }
    if (subEl.dataset.t !== text) { subEl.dataset.t = text; subEl.replaceChildren(...(text ? [h('span', null, text)] : [])); }
    const showBar = viewingLive() && !!clock?.dur;
    liveBar.hidden = !showBar;
    if (showBar && !seekDrag) {
      const pos = Math.min(clock.dur, clock.pos + (clock.playing ? (performance.now() - clock.at) / 1000 : 0));
      seekRange.max = Math.floor(clock.dur); seekRange.value = Math.floor(pos);
      seekTime.textContent = `${mmss(pos)} / ${mmss(clock.dur)}`;
    }
  }, 150);

  const sendSubs = (dc) => {
    if (dc.readyState !== 'open') return;
    if (!hostSub) return dc.send(JSON.stringify({ t: 'nosub' }));
    const n = Math.ceil(hostSub.text.length / 12000);
    for (let i = 0; i < n; i++) dc.send(JSON.stringify({ t: 'sub', label: hostSub.label, i, n, d: hostSub.text.slice(i * 12000, (i + 1) * 12000) }));
  };
  const onAux = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'time') clock = { pos: +m.pos || 0, at: performance.now(), playing: !!m.playing, dur: +m.dur || 0 };
    else if (m.t === 'nosub') { viewSub = null; subBuf = null; }
    else if (m.t === 'sub' && Number.isInteger(m.i) && Number.isInteger(m.n) && m.n > 0 && m.n <= 150 && typeof m.d === 'string') {
      if (m.i === 0) subBuf = { label: String(m.label || 'Subtitles').slice(0, 60), parts: [], n: m.n };
      if (!subBuf || m.n !== subBuf.n) return;
      subBuf.parts[m.i] = m.d;
      if (subBuf.parts.filter((x) => x !== undefined).length === subBuf.n) { viewSub = { label: subBuf.label, cues: parseCues(subBuf.parts.join('')) }; subBuf = null; toast(`Subtitles available: ${viewSub.label}`); }
    }
  };
  const hostTimer = setInterval(() => {
    for (const pc of peers.values()) if (pc._dc?.readyState === 'open') pc._dc.send(JSON.stringify({ t: 'time', pos: video.currentTime, playing: !video.paused, dur: Number.isFinite(video.duration) ? video.duration : 0 }));
  }, 500);
  const pickLiveSub = () => {
    const it = cur();
    if (!it?.live || it.hostId !== S.user.id) return toast('Start streaming a local file first, then add subtitles for it');
    pickFile(async (f) => {
      const ext = f.name.toLowerCase().split('.').pop();
      if (!['srt', 'vtt'].includes(ext)) return toast('Live subtitles: use a .srt or .vtt file');
      if (f.size > 1.5e6) return toast('Subtitle file too large');
      const buf = new Uint8Array(await f.arrayBuffer());
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
      const cues = parseCues(text);
      if (!cues.length) return toast('No subtitle cues found in that file');
      hostSub = { label: f.name.replace(/\.[^.]+$/, ''), text, cues };
      for (const pc of peers.values()) if (pc._dc) sendSubs(pc._dc);
      toast('Subtitles on - viewers receive them peer-to-peer');
    });
  };


  const ignore = (ms = 900) => { ignoreUntil = performance.now() + ms; };
  const ignoring = () => performance.now() < ignoreUntil;
  const cmd = (type, extra = {}) => api('POST', `/rooms/${id}/cmd`, { type, ...extra }).catch((e) => toast(e.message));
  const sig = (to, liveId, data) => api('POST', `/rooms/${id}/signal`, { from: myCid, to, liveId, data }).catch(() => {});
  const target = () => st.pos + (st.playing ? (Date.now() + offset - st.at) / 1000 : 0);
  const cur = () => st?.items[st.index];
  const viewingLive = () => { const it = cur(); return !!it?.live && it.hostId !== S.user.id; };
  // permissions: the room owner can do everything; so can whoever is streaming the current local file (except queue edits); others get what the host allowed
  const isOwner = () => !!st && st.ownerId === S.user.id;
  const hostsCurrent = () => { const it = cur(); return !!it?.live && it.hostId === S.user.id; };
  const can = (k) => !!st && (isOwner() || !!st.perms?.[k] || (hostsCurrent() && k !== 'queue'));
  const noSeekItem = () => { const it = cur(); return !!it && (!!it.iptv || (!!it.live && it.hostId !== S.user.id)); }; // live TV / someone's P2P feed: no native timeline
  const posArg = () => (noSeekItem() ? {} : { pos: video.currentTime }); // a live viewer's clock is meaningless; host's is the truth
  const NOPE = { playback: 'play or pause', seek: 'seek', skip: 'skip tracks', queue: 'change the queue' };
  const denied = (k) => { toast(`The host hasn't allowed viewers to ${NOPE[k]}`); ignore(); setTimeout(() => st && applyPlay(), 60); };
  const gated = []; // [element, perm]
  const gate = (el, perm) => { gated.push([el, perm]); return el; };
  let roomGroup = null;
  const permNote = h('span', { class: 'lock' });
  const permBoxes = {};
  const PERM_LABELS = { playback: 'Play / pause / stop', seek: 'Seek (scrub bar)', skip: 'Skip & jump between items', queue: 'Edit the queue' };
  const permPanel = h('div', { class: 'panel', hidden: true }, h('h3', null, 'Viewer permissions'), h('p', { class: 'muted small' }, 'What people you invite may do. You always have full control.'),
    h('div', { class: 'perms' }, Object.keys(PERM_LABELS).map((k) => h('label', null, (permBoxes[k] = h('input', { type: 'checkbox', onchange: guard(async () => { await api('PATCH', `/rooms/${id}/perms`, Object.fromEntries(Object.keys(PERM_LABELS).map((q) => [q, permBoxes[q].checked]))); }) })), PERM_LABELS[k]))));
  // seek bar for viewers of someone's live P2P stream (library files use the native timeline) - works only when the host allows seeking
  let seekDrag = false;
  const seekRange = h('input', { type: 'range', min: 0, max: 100, step: 1, value: 0 });
  const seekTime = h('span', null, '0:00 / 0:00');
  const liveBar = h('div', { class: 'liveseek', hidden: true }, seekRange, seekTime);
  const mmss = (t) => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  seekRange.addEventListener('input', () => { seekDrag = true; seekTime.textContent = `${mmss(+seekRange.value)} / ${mmss(+seekRange.max)}`; });
  seekRange.addEventListener('change', () => { seekDrag = false; if (can('seek')) cmd('seek', { pos: +seekRange.value }); else denied('seek'); });
  const refreshPerms = () => {
    if (!st) return;
    for (const [el, perm] of gated) el.disabled = !can(perm);
    video.classList.toggle('noseek', !can('seek') || !!cur()?.iptv);
    seekRange.disabled = !can('seek');
    const allowed = Object.keys(PERM_LABELS).filter((k) => st.perms?.[k]);
    permNote.textContent = isOwner() ? 'You are the host.' : allowed.length === 4 ? 'Everyone controls playback.' : allowed.length ? `Host allows: ${allowed.map((k) => PERM_LABELS[k].toLowerCase()).join(' · ')}` : 'View only - the host controls playback.';
    permPanel.hidden = !(isOwner() && roomGroup != null);
    for (const k of Object.keys(PERM_LABELS)) if (permBoxes[k].checked !== !!st.perms?.[k]) permBoxes[k].checked = !!st.perms?.[k];
  };
  const iceInit = (c) => ({ candidate: String(c.candidate), sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
  const canCapture = () => !!(HTMLVideoElement.prototype.captureStream || HTMLVideoElement.prototype.mozCaptureStream);

  const setNote = (content) => {
    stage.querySelector('.note')?.remove();
    if (content) stage.append(h('div', { class: 'ov note' }, content));
  };
  const overlay = (e) => { if ((e && e.name && e.name !== 'NotAllowedError') || stage.querySelector('.gate')) return; /* only when the browser really blocks autoplay */ const ov = h('div', { class: 'ov gate' }, h('button', { class: 'btn', onclick: () => { ov.remove(); ignore(); video.play().catch(() => {}); } }, '▶ Click to join playback')); stage.append(ov); };

  // ----- host side -----
  function stopHosting() { for (const pc of peers.values()) pc.close(); peers.clear(); pendingWants.clear(); hostStream = null; hostLive = null; }
  async function offerTo(cid, liveId) {
    peers.get(cid)?.close();
    const pc = new RTCPeerConnection({ iceServers });
    pc._q = [];
    peers.set(cid, pc);
    pc._dc = pc.createDataChannel('aux');
    pc._dc.onopen = () => sendSubs(pc._dc);
    for (const t of hostStream.getTracks()) pc.addTrack(t, hostStream);
    pc.onicecandidate = (e) => e.candidate && sig(cid, liveId, { t: 'ice', c: iceInit(e.candidate) });
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState) && peers.get(cid) === pc) peers.delete(cid); };
    await pc.setLocalDescription(await pc.createOffer());
    sig(cid, liveId, { t: 'offer', sdp: pc.localDescription.sdp });
  }
  async function prepHost(liveId) {
    hostLive = liveId;
    const cap = video.captureStream || video.mozCaptureStream;
    if (!cap) return toast("This browser can't share local files - use Chrome, Edge or Firefox");
    hostStream = cap.call(video);
    if (!hostStream.getTracks().length) await new Promise((r) => { const t = setTimeout(r, 5000); hostStream.addEventListener('addtrack', () => { clearTimeout(t); r(); }, { once: true }); });
    for (const cid of pendingWants) offerTo(cid, liveId);
    pendingWants.clear();
  }
  function pickFile(onFile) {
    const inp = h('input', { type: 'file', accept: 'video/*,.mkv,.mov,.webm,.mp4' });
    inp.addEventListener('change', () => inp.files[0] && onFile(inp.files[0]));
    inp.click();
  }
  const hostFile = () => {
    if (!canCapture()) return toast("This browser can't stream local files - use Chrome, Edge or Firefox");
    if (!myCid) return toast('Still connecting - try again');
    pickFile((f) => {
      const key = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
      hosted.set('live:' + key, { url: URL.createObjectURL(f), file: f });
      cmd('addLive', { key, title: f.name.replace(/\.[^.]+$/, ''), cid: myCid }).then(() => toast('Streaming - keep this tab open'));
    });
  };

  // ----- viewer side -----
  function stopViewing() { vPc?.close(); vPc = null; vLive = null; earlyIce = []; viewSub = null; subBuf = null; clock = null; if (video.srcObject) video.srcObject = null; }
  function wantStream(it) {
    if (!it.online || vPc || Date.now() - wantAt < 4000) return;
    wantAt = Date.now(); vLive = it.id;
    sig('host', it.id, { t: 'want' });
  }
  async function onOffer(from, liveId, data) {
    vPc?.close();
    const pc = (vPc = new RTCPeerConnection({ iceServers }));
    pc._q = earlyIce; earlyIce = [];
    pc.ondatachannel = (e) => { e.channel.onmessage = onAux; };
    pc.ontrack = (ev) => { video.srcObject = ev.streams[0]; setNote(null); ignore(); if (st?.playing) video.play().catch(overlay); };
    pc.onicecandidate = (ev) => ev.candidate && sig('host', liveId, { t: 'ice', c: iceInit(ev.candidate) });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') toast("Can't reach the host directly (firewall/NAT blocks peer-to-peer). Admin: configure a TURN server via ICE_SERVERS.");
      if (['failed', 'closed'].includes(pc.connectionState) && vPc === pc) { vPc = null; video.srcObject = null; wantAt = 0; }
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: String(data.sdp) });
    for (const c of pc._q) await pc.addIceCandidate(c).catch(() => {});
    pc._q = [];
    await pc.setLocalDescription(await pc.createAnswer());
    sig('host', liveId, { t: 'answer', sdp: pc.localDescription.sdp });
  }
  async function onSignal(from, liveId, data) {
    if (!data || typeof data !== 'object') return;
    if (data.t === 'want') { if (hostLive === liveId && hostStream) offerTo(from, liveId); else if (hosted.has(liveId)) pendingWants.add(from); }
    else if (data.t === 'offer') { if (vLive === liveId && viewingLive()) await onOffer(from, liveId, data); }
    else if (data.t === 'answer') {
      const pc = peers.get(from);
      if (pc && !pc.remoteDescription) { await pc.setRemoteDescription({ type: 'answer', sdp: String(data.sdp) }); for (const c of pc._q) await pc.addIceCandidate(c).catch(() => {}); pc._q = []; }
    } else if (data.t === 'ice' && data.c) {
      const c = iceInit(data.c);
      const pc = peers.get(from) || vPc;
      if (!pc) earlyIce.push(c);
      else if (!pc.remoteDescription) pc._q.push(c);
      else pc.addIceCandidate(c).catch(() => {});
    }
  }

  // ----- playback sync -----
  const applyPlay = () => {
    if (!st || st.index < 0) return;
    if (!noSeekItem()) {
      const t = target();
      if (Math.abs(video.currentTime - t) > 1.2) { ignore(); video.currentTime = t; }
    }
    if (st.playing && video.paused) { ignore(); if (cur()?.iptv && iptvHls?.liveSyncPosition) video.currentTime = iptvHls.liveSyncPosition; video.play().catch(overlay); }
    else if (!st.playing && !video.paused) { ignore(); video.pause(); }
  };
  // ----- live TV (HLS through the server's proxy) -----
  let iptvHls = null;
  const destroyHls = () => { if (iptvHls?._timer) clearInterval(iptvHls._timer); iptvHls?.destroy(); iptvHls = null; };
  async function startHls(chanId) {
    destroyHls(); video.removeAttribute('src'); video.load(); setNote(null);
    const src = `/api/iptv/${chanId}/stream.m3u8`;
    let H = null;
    try { await loadHls(); H = window.Hls?.isSupported() ? window.Hls : null; } catch { /* fall back to native below */ }
    // Native HLS (Safari, and now Chromium) has no stall/error recovery - a hiccup freezes the picture for good. Use it only when hls.js can't run (iPhone).
    if (!H) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = src; ignore(2000); if (st?.playing) video.play().catch(overlay); return; }
      return toast("This browser can't play live TV streams");
    }
    const E = H.Events, ET = H.ErrorTypes;
    const hls = (iptvHls = new H({
      enableWorker: false,
      liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, // stay close to live, jump forward if we fall too far behind
      maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 45, // bounded memory so very long sessions don't exhaust the buffer
      maxBufferHole: 0.6, nudgeMaxRetry: 8, // skip over small gaps / discontinuities (ad breaks)
      manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 8, fragLoadingMaxRetry: 8, manifestLoadingRetryDelay: 1000, levelLoadingRetryDelay: 1000, fragLoadingRetryDelay: 800, fragLoadingMaxRetryTimeout: 8000,
    }));
    let netFails = 0, mediaFails = 0;
    const giveUp = () => {
      if (iptvHls === hls) iptvHls = null;
      hls.destroy();
      api('POST', `/iptv/${chanId}/report`).catch(() => {}); // drops it off the working list until the next health check
      setNote(h('div', null, h('p', null, 'This channel stopped responding.'), h('button', { class: 'btn', onclick: () => startHls(chanId) }, '↻ Retry')));
    };
    hls.on(E.ERROR, (_e, d) => {
      if (!d.fatal) return;
      if (d.type === ET.NETWORK_ERROR) { // transient upstream trouble: back off and keep trying instead of giving up
        if (++netFails > 8) return giveUp();
        setNote('Reconnecting…');
        setTimeout(() => { if (iptvHls === hls) hls.startLoad(); }, Math.min(1000 * 2 ** netFails, 12000));
      } else if (d.type === ET.MEDIA_ERROR) {
        if (++mediaFails > 4) return giveUp();
        if (mediaFails === 2) hls.swapAudioCodec();
        hls.recoverMediaError();
      } else giveUp();
    });
    // Is the provider's live playlist still producing new segments? If not, nothing we do can make it play - say so instead of freezing silently.
    let lastEnd = -1, lastAdvance = Date.now(), warned = false;
    hls.on(E.LEVEL_UPDATED, (_e, d) => { if (d.details.endSN > lastEnd) { lastEnd = d.details.endSN; lastAdvance = Date.now(); } });
    hls._feedAge = () => (lastEnd < 0 ? 0 : Date.now() - lastAdvance);
    hls._timer = setInterval(() => {
      if (warned || hls._feedAge() < 30000 || iptvHls !== hls) return;
      warned = true;
      toast("This channel's live feed has stopped - the provider is only serving old video");
      api('POST', `/iptv/${chanId}/report`).catch(() => {});
    }, 5000);
    hls.on(E.FRAG_LOADED, () => { if (netFails || mediaFails) { netFails = 0; mediaFails = 0; setNote(null); } else if (stage.querySelector('.note')) setNote(null); });
    hls.on(E.MANIFEST_PARSED, () => { ignore(2000); if (st?.playing) video.play().catch(overlay); });
    hls.loadSource(src); hls.attachMedia(video);
  }
  const resetVideo = () => { stopHosting(); stopViewing(); destroyHls(); video.removeAttribute('src'); video.load(); };
  const reselect = (it) => pickFile((f) => { hosted.set(it.id, { url: URL.createObjectURL(f), file: f }); cmd('rehost', { liveId: it.id, cid: myCid }); loaded = null; apply(); });

  // ----- codec selection: every viewer's player picks the best rendition for ITS device, and can switch AV1 / VP9 / H.264 live -----
  const MC = new Map();
  const CSTR = { av1: 'av01.0.08M.08', vp9: 'vp09.00.40.08', h264: 'avc1.640028', vp8: 'vp8' };
  const prefCodec = () => { try { return localStorage.getItem('st_codec') || 'auto'; } catch { return 'auto'; } };
  let rendId = null;
  const tried = new Set();
  async function capability(r) {
    const key = [r.codec, r.container, r.width, r.height, Math.round((r.bitrate || 2e6) / 1e6)].join('|');
    if (MC.has(key)) return MC.get(key);
    const mime = r.container === 'webm' ? 'video/webm' : 'video/mp4';
    const cs = CSTR[r.codec];
    let res = { supported: false, smooth: false, powerEfficient: false };
    try {
      if (cs && navigator.mediaCapabilities?.decodingInfo) {
        const i = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: { contentType: `${mime}; codecs="${cs}"`, width: r.width || 1280, height: r.height || 720, bitrate: Math.max(100000, Math.round(r.bitrate || 2e6)), framerate: 30 } });
        res = { supported: !!i.supported, smooth: !!i.smooth, powerEfficient: !!i.powerEfficient };
      } else if (cs) { const ok = document.createElement('video').canPlayType(`${mime}; codecs="${cs}"`) !== ''; res = { supported: ok, smooth: ok, powerEfficient: false }; }
    } catch { /* leave unsupported */ }
    MC.set(key, res);
    return res;
  }
  /** Auto: smooth playback required -> smallest bitrate (fits your connection) -> but prefer hardware decode if it costs <= 50% more bandwidth. */
  async function pickRendition(it, force) {
    const list = (it.renditions || []).filter((r) => !tried.has(r.id));
    if (!list.length) return null;
    const pref = force || prefCodec();
    if (pref !== 'auto') { const m = list.find((r) => r.codec === pref || r.id === pref); if (m) return m.id; }
    const scored = [];
    for (const r of list) scored.push({ r, c: await capability(r) });
    let ok = scored.filter((x) => x.c.supported && x.c.smooth);
    if (!ok.length) ok = scored.filter((x) => x.c.supported);
    if (!ok.length) ok = scored;
    const dl = navigator.connection?.downlink;
    if (dl) { const fit = ok.filter((x) => (x.r.bitrate || 0) <= dl * 0.8e6); if (fit.length) ok = fit; }
    ok.sort((a, b) => (a.r.bitrate || 9e12) - (b.r.bitrate || 9e12));
    const small = ok[0];
    const hw = ok.filter((x) => x.c.powerEfficient)[0];
    return (!small.c.powerEfficient && hw && (hw.r.bitrate || 0) <= 1.5 * (small.r.bitrate || 0) ? hw : small).r.id;
  }
  const getFit = () => { try { return localStorage.getItem('st_fit') || 'fit'; } catch { return 'fit'; } };
  const applyFit = () => { video.style.objectFit = (FIT[getFit()] || FIT.fit)[1]; };
  const fitSel = h('select', { class: 'codec-sel', title: 'How the picture fills the player', onchange: () => { try { localStorage.setItem('st_fit', fitSel.value); } catch { /* private mode */ } applyFit(); } }, Object.entries(FIT).map(([k, [l]]) => h('option', { value: k, selected: getFit() === k }, l)));
  let roomEl = null;
  const theaterBtn = h('button', { class: 'btn sec sm', title: 'Make the player as large as the window', onclick: () => { const on = !roomEl.classList.contains('theater'); roomEl.classList.toggle('theater', on); theaterBtn.textContent = on ? '▣ Exit theater' : '▭ Theater'; try { localStorage.setItem('st_theater', on ? '1' : '0'); } catch { /* private mode */ } } }, '▭ Theater');
  applyFit();
  const codecChip = h('span', { class: 'chip codec-chip', hidden: true });
  const codecSel = h('select', { class: 'codec-sel', hidden: true, title: 'Video codec (Auto picks the best for this device)', onchange: () => {
    const v = codecSel.value;
    try { localStorage.setItem('st_codec', v); } catch { /* private mode */ }
    const it = cur();
    if (!it || it.live || it.iptv) return;
    tried.clear();
    const t = video.currentTime;
    pickRendition(it, v).then((rid) => rid && playRendition(it, rid, t));
  } });
  function updateCodecUI(it) {
    const list = it?.renditions || [];
    codecSel.hidden = list.length < 2;
    codecChip.hidden = !rendId;
    const r = list.find((x) => x.id === rendId);
    codecChip.textContent = r ? `${CODEC_LABEL[r.codec] || r.codec}${r.height ? ' · ' + r.height + 'p' : ''}${r.bitrate ? ' · ' + (r.bitrate / 1e6).toFixed(1) + ' Mbps' : ''}` : '';
    const pref = prefCodec();
    codecSel.replaceChildren(h('option', { value: 'auto', selected: pref === 'auto' }, 'Auto codec'), ...list.map((x) => h('option', { value: x.codec, selected: pref === x.codec }, `${CODEC_LABEL[x.codec] || x.codec}${x.original ? ' (original)' : ''}`)));
  }
  const onceMeta = (it, keepT) => video.addEventListener('loadedmetadata', () => { ignore(1500); video.currentTime = Math.min(keepT ?? target(), video.duration || 1e9); applyPlay(); if (it.live) prepHost(it.id); }, { once: true });
  function playRendition(it, rid, keepT) {
    rendId = rid; ignore(3000);
    video.src = `/api/media/${it.id}/stream?r=${encodeURIComponent(rid)}`;
    onceMeta(it, keepT); video.load(); updateCodecUI(it);
  }
  async function setupCodec(it) {
    const rid = await pickRendition(it);
    if (!rid || loaded !== it.id) return;
    playRendition(it, rid, undefined);
  }

  const apply = () => {
    const it = cur();
    for (const [k, v] of hosted) if (!st.queue.includes(k)) { URL.revokeObjectURL(v.url); hosted.delete(k); }
    const mine = it?.live && it.hostId === S.user.id;
    titleEl.textContent = it ? (it.iptv ? `📺 ${it.title}` : it.live ? `📡 ${it.title}${mine ? ' (you are streaming - keep this tab open)' : ` (streamed by ${it.hostName})`}` : it.kind === 'tv' ? `${it.show} · ${it.title}` : it.title) : roomName;
    queueEl.replaceChildren(...(st.items.length ? st.items.map((m, i) => h('div', { class: i === st.index ? 'cur' : '' },
      h('span', { class: 'g', onclick: () => (can('skip') ? cmd('jump', { index: i }) : denied('skip')) }, `${i + 1}. ${m.live ? '📡 ' : m.iptv ? '📺 ' : ''}${m.kind === 'tv' ? `${m.show} ${epLabel(m)} ` : ''}${m.title}`),
      h('button', { class: 'btn sec sm', title: 'Move up', disabled: !can('queue'), onclick: () => i > 0 && cmd('move', { from: i, to: i - 1 }) }, '↑'),
      h('button', { class: 'btn sec sm', title: 'Move down', disabled: !can('queue'), onclick: () => i < st.items.length - 1 && cmd('move', { from: i, to: i + 1 }) }, '↓'),
      h('button', { class: 'btn sec sm', title: 'Remove', disabled: !can('queue'), onclick: () => cmd('remove', { index: i }) }, '✕'))) : [h('p', { class: 'muted' }, 'Queue is empty.')]));
    refreshPerms();
    queueEl.querySelectorAll('.g').forEach((g) => (g.style.cursor = 'pointer'));
    if (!it) {
      loaded = null; resetVideo();
      stage.replaceChildren(h('div', { class: 'empty' }, 'Nothing playing - add something to the queue'));
      return;
    }
    if (!stage.contains(video)) stage.replaceChildren(video);
    // someone else's live stream: show the WebRTC feed
    if (it.live && !mine) {
      if (loaded !== it.id) { loaded = it.id; resetVideo(); }
      wantStream(it);
      setNote(video.srcObject ? null : it.online ? 'Connecting to the host…' : `${it.hostName} went offline - waiting for them to return…`);
      if (video.srcObject) applyPlay();
      return;
    }
    // live TV channel (HLS via proxy; nothing to seek, play/pause stay in sync)
    if (it.iptv) {
      setNote(null); video.classList.add('noseek');
      if (loaded !== it.id) { loaded = it.id; stopHosting(); stopViewing(); hostSub = null; setTracks([]); startHls(it.id.slice(5)); } else applyPlay();
      return;
    }
    // my own live item whose file handle is gone (page was reloaded)
    if (it.live && !hosted.has(it.id)) {
      if (loaded !== it.id) { loaded = it.id; resetVideo(); }
      setNote(h('button', { class: 'btn', onclick: () => reselect(it) }, 'Select the file again to resume streaming'));
      return;
    }
    // normal library file, or my own local file
    setNote(null);
    if (video.srcObject) { stopViewing(); }
    if (loaded !== it.id) {
      loaded = it.id; stopHosting(); stopViewing(); destroyHls(); hostSub = null; ignore(3000);
      setTracks(it.live ? [] : it.subs);
      rendId = null; tried.clear();
      if (it.live) { video.src = hosted.get(it.id).url; onceMeta(it, undefined); video.load(); updateCodecUI(null); } else setupCodec(it);
    } else applyPlay();
  };

  video.addEventListener('playing', () => stage.querySelector('.gate')?.remove());
  video.addEventListener('play', () => { if (ignoring() || !st || st.playing) return; if (!can('playback')) return denied('playback'); cmd('play', posArg()); });
  let lastGesture = 0;
  for (const ev of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) stage.addEventListener(ev, () => { lastGesture = performance.now(); }, true);
  const byUser = () => performance.now() - lastGesture < 1500;
  video.addEventListener('pause', () => {
    if (ignoring() || video.ended || !st || !st.playing) return;
    if (!byUser()) { // not the user: the browser/stream paused itself (stall, error, recovery). Keep the room playing and resume.
      ignore(); setTimeout(() => { if (st?.playing && video.paused && !video.ended) video.play().catch(overlay); }, 300);
      return;
    }
    if (!can('playback')) return denied('playback');
    cmd('pause', posArg());
  });
  if ('mediaSession' in navigator) { // media keys / picture-in-picture / OS controls count as user actions
    try {
      navigator.mediaSession.setActionHandler('play', () => { lastGesture = performance.now(); can('playback') ? cmd('play', posArg()) : denied('playback'); });
      navigator.mediaSession.setActionHandler('pause', () => { lastGesture = performance.now(); can('playback') ? cmd('pause', posArg()) : denied('playback'); });
    } catch { /* unsupported action */ }
  }
  video.addEventListener('seeked', () => { if (ignoring() || !st || noSeekItem()) return; if (!can('seek')) return denied('seek'); cmd('seek', { pos: video.currentTime }); });
  video.addEventListener('ended', () => st && !noSeekItem() && cmd('ended', { index: st.index }));
  video.addEventListener('error', () => {
    const it0 = cur();
    if (it0 && !it0.live && !it0.iptv && rendId && video.getAttribute('src')) { // this version didn't play on this device: fall back to another one automatically
      tried.add(rendId);
      pickRendition(it0).then((rid) => { if (rid && loaded === it0.id) { toast('That video format did not play here - switching to another version'); playRendition(it0, rid, st ? target() : 0); } else toast('Playback error - no other version available'); });
      return;
    }
    if (!cur()?.iptv && video.getAttribute('src')) toast(cur()?.live ? "Your browser can't play that file - try an MP4 (H.264/AAC) or WebM" : 'Playback error - format may need converting'); });
  const tick = setInterval(() => {
    if (!st) return;
    if (noSeekItem()) { const it = cur(); if (viewingLive() && it && !vPc) wantStream(it); return; }
    if (st.playing && !video.paused && loaded && Math.abs(video.currentTime - target()) > 2.5) { ignore(); video.currentTime = target(); }
  }, 4000);

  let wdLast = 0, wdAt = Date.now(), wdStage = 0, wdRestarts = 0;
  const iptvWatch = setInterval(() => {
    const it = cur();
    if (!it?.iptv || !st?.playing || !loaded || video.ended) { wdStage = 0; wdAt = Date.now(); return; }
    if (video.paused) { if (!ignoring() && !stage.querySelector('.gate')) { ignore(); video.play().catch(overlay); } wdAt = Date.now(); return; } // should be playing
    const t = video.currentTime;
    if (t > wdLast + 0.3 || t < wdLast - 1) { wdLast = t; wdAt = Date.now(); wdStage = 0; return; } // moving forward, or the timeline was reset - either way not stuck
    const stuck = Date.now() - wdAt;
    if (iptvHls?._feedAge?.() > 30000 && stuck > 6000) { // stuck because the provider's feed is dead: restarting can't help
      const cid = it.id.slice(5); destroyHls(); wdStage = 9;
      setNote(h('div', null, h('p', null, 'This channel\'s live feed has stopped.'), h('p', { class: 'muted small' }, 'The provider is only serving old video, so there is nothing new to play. It has been flagged and will drop off the working list.'), h('button', { class: 'btn', onclick: () => startHls(cid) }, '↻ Try again')));
      api('POST', `/iptv/${cid}/report`).catch(() => {});
      return;
    }
    if (wdStage === 9) return;
    if (stuck > 9000 && wdStage === 0) { wdStage = 1; const live = iptvHls?.liveSyncPosition; ignore(); if (live) video.currentTime = live; else if (video.buffered.length) video.currentTime = video.buffered.end(video.buffered.length - 1) - 0.4; }
    else if (stuck > 18000 && wdStage === 1) { wdStage = 2; iptvHls?.recoverMediaError(); }
    else if (stuck > 30000 && wdStage === 2) { wdStage = 3; toast('Stream stalled - reconnecting…'); wdAt = Date.now(); startHls(it.id.slice(5)); wdStage = 0; if (++wdRestarts >= 2) { wdRestarts = 0; api('POST', `/iptv/${it.id.slice(5)}/report`).catch(() => {}); } }
  }, 3000);

  const connect = () => {
    es = new EventSource(`/api/rooms/${id}/events`);
    es.addEventListener('hello', (e) => { myCid = JSON.parse(e.data).cid; for (const lid of hosted.keys()) cmd('rehost', { liveId: lid, cid: myCid }); });
    es.addEventListener('state', (e) => { const d = JSON.parse(e.data); offset = d.serverNow - Date.now(); st = d; apply(); });
    es.addEventListener('presence', (e) => whoEl.replaceChildren(...JSON.parse(e.data).map((n) => h('span', null, n))));
    es.addEventListener('signal', (e) => { const { from, liveId, data } = JSON.parse(e.data); onSignal(from, liveId, data).catch(() => {}); });
  };
  // watch-time tracker: the server credits time only while the room is really playing and I'm attached to it
  const pingTimer = setInterval(() => { if (st?.playing && !video.paused && !video.ended && video.readyState > 2) api('POST', '/watch/ping', { roomId: id }).catch(() => {}); }, 10000);
  cleanup = () => { currentRoomId = null; clearInterval(pingTimer); clearInterval(iptvWatch); try { navigator.mediaSession?.setActionHandler('play', null); navigator.mediaSession?.setActionHandler('pause', null); } catch { /* ok */ } clearInterval(subTimer); clearInterval(hostTimer); es?.close(); clearInterval(tick); resetVideo(); for (const v of hosted.values()) URL.revokeObjectURL(v.url); };

  api('GET', '/ice').then((r) => r.iceServers?.length && (iceServers = r.iceServers)).catch(() => {});
  api('GET', '/rooms/' + id).then((r) => { roomName = r.name; roomGroup = r.groupId; titleEl.textContent = r.name; connect(); }).catch((e) => { toast(e.message); go('/rooms'); });

  const picker = () => {
    const q = h('input', { placeholder: 'Search your library…' });
    const list = h('div', { class: 'list' });
    const drawL = () => list.replaceChildren(...S.media.filter((m) => m.playable && m.status === 'ready' && (m.title + (m.show || '')).toLowerCase().includes(q.value.toLowerCase())).sort((a, b) => (a.show || a.title).localeCompare(b.show || b.title) || epSort(a, b)).slice(0, 200)
      .map((m) => h('div', null, h('span', { class: 'g' }, `${m.kind === 'tv' ? m.show + ' ' + epLabel(m) + ' · ' : ''}${m.title}`), h('span', { class: 'muted small' }, m.owned ? '' : 'shared'), h('button', { class: 'btn sm', onclick: () => cmd('add', { mediaId: m.id }).then(() => toast('Added')) }, '＋'))));
    q.oninput = drawL; drawL();
    modal(() => h('div', { class: 'mb' }, h('h3', null, 'Add to queue'), q, list));
  };

  const iptvPicker = () => {
    const q = h('input', { placeholder: 'Search live channels…' });
    const list = h('div', { class: 'list' });
    let t = null;
    const draw = async () => {
      try {
        const r = await api('GET', '/iptv?working=1&q=' + encodeURIComponent(q.value));
        list.replaceChildren(...(r.items.length ? r.items.map((c) => h('div', null, h('span', { class: 'g' }, c.name), h('span', { class: 'muted small' }, c.group.split(';')[0]), h('button', { class: 'btn sm', onclick: () => cmd('addIptv', { id: c.id }).then(() => toast('Added')) }, '＋'))) : [h('p', { class: 'muted' }, 'No verified channels match (admins can refresh/check the list).')]));
      } catch (e) { toast(e.message); }
    };
    q.oninput = () => { clearTimeout(t); t = setTimeout(draw, 250); };
    draw();
    modal(() => h('div', { class: 'mb' }, h('h3', null, 'Add a live channel'), q, list));
  };

  mount(shell('/rooms', roomEl = h('div', { class: 'room' },
    h('div', null, titleEl, stage, h('div', { class: 'ctl' },
      gate(h('button', { class: 'btn sec sm', onclick: () => cmd('prev') }, '⏮ Prev'), 'skip'), gate(h('button', { class: 'btn sec sm', onclick: () => cmd('play') }, '▶ Play'), 'playback'), gate(h('button', { class: 'btn sec sm', onclick: () => cmd('pause') }, '⏸ Pause'), 'playback'),
      gate(h('button', { class: 'btn sec sm', onclick: () => cmd('stop') }, '⏹ Stop'), 'playback'), gate(h('button', { class: 'btn sec sm', onclick: () => cmd('next') }, '⏭ Next'), 'skip'), h('button', { class: 'btn sec sm', title: 'Fullscreen with subtitles', onclick: () => stage.requestFullscreen?.() }, '⛶ Fullscreen'), theaterBtn, fitSel, codecSel, codecChip,
      permNote),
      liveBar,
      h('div', { class: 'muted small' }, 'Watching now:'), whoEl, permPanel),
    h('div', { class: 'panel' }, h('div', { class: 'toolbar' }, h('h3', null, 'Queue'), h('button', { class: 'btn sm', onclick: () => inviteModal(id) }, '✉ Invite'), gate(h('button', { class: 'btn sm', onclick: picker }, '＋ Library'), 'queue'), gate(h('button', { class: 'btn sm', onclick: iptvPicker }, '📺 Live TV'), 'queue'), gate(h('button', { class: 'btn sm', title: 'Play a file from this computer for the room. Nothing is uploaded or stored on the server.', onclick: hostFile }, '📡 Stream local file'), 'queue'), h('button', { class: 'btn sec sm', title: 'Add a .srt/.vtt for the file you are streaming', onclick: pickLiveSub }, 'CC Live subs'), gate(h('button', { class: 'btn sec sm', onclick: () => cmd('clear') }, 'Clear'), 'queue')),
      h('p', { class: 'muted small' }, 'Stream local file = peer-to-peer from your browser; never uploaded or stored. Viewers see your IP address.'), queueEl)),
  ));
  try { if (localStorage.getItem('st_theater') === '1') { roomEl.classList.add('theater'); theaterBtn.textContent = '▣ Exit theater'; } } catch { /* private mode */ }
  stage.replaceChildren(h('div', { class: 'empty' }, 'Connecting…'));
}

// ---------- live TV ----------
const iptvState = { q: '', group: '', country: '', working: true };
const cc = (code) => (code ? code.toUpperCase() : '');
async function iptvView() {
  const fac = await api('GET', '/iptv/facets');
  if (!fac.working) iptvState.working = false;
  const grid = h('div', { class: 'cgrid' });
  const info = h('span', { class: 'muted small' });
  const more = h('button', { class: 'btn sec', hidden: true }, 'Load more');
  let page = 0, busy = false, seq = 0;
  const regionOf = new Map(fac.countries.map((c) => [c.code, c.name]));
  const card = (c) => {
    const lg = h('div', { class: 'lg' });
    const ph = () => lg.prepend(h('div', { class: 'ph' }, (c.name || '?')[0].toUpperCase()));
    if (c.hasLogo) { const img = h('img', { src: `/api/iptv/logo/${c.id}`, loading: 'lazy', alt: '' }); img.onerror = () => { img.remove(); ph(); }; lg.append(img); } else ph();
    if (c.ok === 1) lg.append(h('span', { class: 'st dot', title: 'Verified working' }));
    return h('div', { class: 'chan', onclick: () => chanModal(c) }, lg, h('div', { class: 'n' }, c.name), h('div', { class: 'm' }, [c.group.split(';')[0], regionOf.get(c.country)].filter(Boolean).join(' · ')));
  };
  async function load(reset) {
    if (busy && !reset) return;
    const my = ++seq; busy = true;
    if (reset) { page = 0; grid.replaceChildren(); }
    page++;
    try {
      const r = await api('GET', '/iptv?' + new URLSearchParams({ q: iptvState.q, group: iptvState.group, country: iptvState.country, working: iptvState.working ? '1' : '0', page }));
      if (my !== seq) return;
      grid.append(...r.items.map(card));
      info.textContent = `${r.total.toLocaleString()} channel${r.total === 1 ? '' : 's'}`;
      more.hidden = page >= r.pages;
      if (!r.items.length && page === 1) grid.append(h('p', { class: 'muted' }, fac.total ? 'No channels match.' : 'No channels yet - an admin can import the list from the Admin page.'));
    } catch (e) { toast(e.message); } finally { busy = false; }
  }
  more.onclick = () => load(false);
  let t = null;
  const search = h('input', { type: 'search', placeholder: 'Search channels…', value: iptvState.q, oninput: (e) => { iptvState.q = e.target.value; clearTimeout(t); t = setTimeout(() => load(true), 250); } });
  const gsel = h('select', { onchange: (e) => { iptvState.group = e.target.value; load(true); } }, h('option', { value: '' }, 'All categories'), fac.groups.map((g) => h('option', { value: g.name, selected: iptvState.group === g.name }, `${g.name} (${g.count})`)));
  const csel = h('select', { onchange: (e) => { iptvState.country = e.target.value; load(true); } }, h('option', { value: '' }, 'All countries'), fac.countries.map((c) => h('option', { value: c.code, selected: iptvState.country === c.code }, `${c.name} (${c.count})`)));
  const wk = h('input', { type: 'checkbox', checked: iptvState.working, disabled: !fac.working, onchange: (e) => { iptvState.working = e.target.checked; load(true); } });
  load(true);
  mount(shell('/iptv',
    h('div', { class: 'page-h' }, h('h1', null, 'Live TV'), h('span', { class: 'live-pill' }, 'LIVE')),
    h('p', { class: 'muted' }, `Free, publicly available channels from the iptv-org community list. ${fac.working.toLocaleString()} verified working${fac.check?.running ? ` · checking ${fac.check.done}/${fac.check.total}…` : ''}.`),
    h('div', { class: 'toolbar' }, search, gsel, csel, h('label', { style: false }, wk, ' Working only'), info),
    grid, h('p', null, more)));
}
function chanModal(c) {
  modal((close) => h('div', { class: 'mb' }, h('h2', null, c.name), h('div', { class: 'chips' }, c.group.split(';').map((g) => h('span', { class: 'chip' }, g)), c.country && h('span', { class: 'chip' }, cc(c.country)), c.ok === 1 ? h('span', { class: 'chip' }, '● verified working') : c.ok === 0 ? h('span', { class: 'chip' }, 'last check failed') : null),
    h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: guard(async () => { close(); await playIptv(c.id); }) }, '▶ Watch now'), h('button', { class: 'btn sec', onclick: guard(() => queueIptv(c.id)) }, '＋ Add to room queue')),
    h('p', { class: 'muted small' }, 'Streams are relayed by this server, so friends in a room all see the same channel in sync. Channel availability is outside our control.')));
}
async function playIptv(chanId) {
  const id = await soloRoom();
  await api('POST', `/rooms/${id}/cmd`, { type: 'clear' });
  await api('POST', `/rooms/${id}/cmd`, { type: 'addIptv', id: chanId });
  go('/room/' + id);
}
function queueIptv(chanId) {
  if (!S.rooms.length) { toast('Create a room first (Rooms tab) or press Watch now'); return; }
  const sel = h('select', null, S.rooms.map((r) => h('option', { value: r.id }, r.name + (r.groupId ? '' : ' (solo)'))));
  modal((c) => h('div', { class: 'mb' }, h('h3', null, 'Add to which room?'), sel, h('p', null, h('button', { class: 'btn', onclick: guard(async () => { await api('POST', `/rooms/${sel.value}/cmd`, { type: 'addIptv', id: chanId }); toast('Queued'); c(); }) }, 'Add to queue'))));
}

// ---------- stats ----------
const KIND = { movie: 'Movies', tv: 'TV shows', video: 'Other videos', live: 'Local streams', iptv: 'Live TV' };
async function statsView() {
  const x = await api('GET', '/stats');
  const max = Math.max(1, ...x.daily.map((d) => d.seconds));
  const dow = (day) => 'SMTWTFS'[new Date(day + 'T12:00:00').getDay()];
  const bars = h('div', { class: 'bars' }, x.daily.map((d) => { const i = h('i', { class: d.seconds ? '' : 'zero', title: `${d.day}: ${fmtHours(d.seconds)}` }); i.style.setProperty('--h', Math.max(3, (d.seconds / max) * 100) + '%'); return h('div', { class: 'b' }, i, h('span', null, dow(d.day))); }));
  const meter = (v, tot) => { const m = h('div', { class: 'meter' }, h('i')); m.firstChild.style.setProperty('--w', (tot ? (v / tot) * 100 : 0) + '%'); return m; };
  const top = Math.max(1, ...x.board.map((b) => b.seconds));
  mount(shell('/stats',
    h('div', { class: 'page-h' }, h('h1', null, 'Your watch time')),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('div', { class: 'v g' }, fmtHours(x.total)), h('div', { class: 't' }, 'all-time')),
      h('div', { class: 'tile' }, h('div', { class: 'v' }, fmtHours(x.month)), h('div', { class: 't' }, 'last 30 days')),
      h('div', { class: 'tile' }, h('div', { class: 'v' }, fmtHours(x.week)), h('div', { class: 't' }, 'last 7 days')),
      h('div', { class: 'tile' }, h('div', { class: 'v' }, fmtHours(x.today)), h('div', { class: 't' }, 'today'))),
    h('div', { class: 'split' },
      h('div', null,
        h('div', { class: 'panel' }, h('h3', null, 'Last 14 days'), bars),
        h('div', { class: 'panel' }, h('h3', null, 'Most watched'), x.top.length ? h('div', { class: 'list' }, x.top.map((t) => h('div', null, h('span', { class: 'g' }, t.title), h('span', { class: 'chip' }, KIND[t.kind] || t.kind), h('span', { class: 'muted small' }, fmtHours(t.seconds))))) : h('p', { class: 'muted' }, 'Nothing yet - start watching something.'))),
      h('div', null,
        h('div', { class: 'panel' }, h('h3', null, 'By type'), x.byKind.length ? x.byKind.map((k) => h('div', { class: 'lb' }, h('span', { class: 'g', style: false }, KIND[k.kind] || k.kind), meter(k.seconds, x.total), h('span', { class: 'muted small' }, fmtHours(k.seconds)))) : h('p', { class: 'muted' }, 'No data yet.')),
        h('div', { class: 'panel' }, h('h3', null, 'Friends leaderboard'), h('p', { class: 'muted small' }, 'You and people who share a group with you. Time only counts while a room is actually playing.'),
          x.board.map((b, i) => h('div', { class: 'lb' + (b.me ? ' me' : '') }, h('span', { class: 'rk' }, String(i + 1)), h('span', { class: 'g', style: false }, b.me ? 'You' : b.name), meter(b.seconds, top), h('span', { class: 'muted small' }, fmtHours(b.seconds)))))))));
}

// ---------- admin / account ----------
async function adminView() {
  const a = await api('GET', '/admin/info');
  const out = h('div');
  mount(shell('/admin', h('h1', null, 'Admin'),
    h('div', { class: 'panel' }, h('h3', null, 'Status'), h('p', null, `ffmpeg: ${a.ffmpeg ? 'found ✓' : 'NOT FOUND - install it to import media'} · email: ${a.mailEnabled ? 'SMTP configured ✓' : 'not configured (reset links print to server console)'}`)),
    h('div', { class: 'panel' }, h('h3', null, 'Local library'), h('p', { class: 'muted' }, a.mediaDirs.length ? a.mediaDirs.join(' ; ') : 'Set MEDIA_DIRS in .env to scan folders. Files stay where they are (read-only) and are streamed only to logged-in users.'),
      h('button', { class: 'btn', disabled: !a.mediaDirs.length, onclick: guard(async () => { const r = await api('POST', '/admin/scan'); toast(`Added ${r.added} file(s)`); }) }, 'Scan now')),
    h('div', { class: 'panel' }, h('h3', null, 'Invites & signup'),
      h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/admin/invites'); out.replaceChildren(h('p', null, 'Share this link (valid 7 days, single use):'), h('code', { class: 'k' }, r.url)); }) }, 'Create invite link'), out,
      h('p', null, h('label', { style: false }, h('input', { type: 'checkbox', checked: a.openSignup, style: false, onchange: guard(async (e) => api('POST', '/admin/settings', { openSignup: e.target.checked })) }), ' Allow open signup (no invite needed)'))),
    h('div', { class: 'panel' }, h('h3', null, 'Live TV (IPTV)'),
      h('p', { class: 'muted' }, `${a.iptv.total.toLocaleString()} channels · ${a.iptv.working.toLocaleString()} verified working · ${a.iptv.checked.toLocaleString()} checked${a.iptv.check.running ? ` · checking ${a.iptv.check.done}/${a.iptv.check.total}…` : ''}`),
      h('p', { class: 'muted small' }, 'Source: iptv-org community index of publicly available channels (refreshed daily). Streams are fetched through this server; nothing is stored.'),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/admin/iptv/refresh'); toast('Importing the channel list - this runs in the background'); }) }, 'Refresh list'), h('button', { class: 'btn sec', onclick: guard(async () => { await api('POST', '/admin/iptv/check'); toast('Checking every channel - runs in the background, takes a while'); }) }, 'Re-check all streams'))),
    h('div', { class: 'panel' }, h('h3', null, 'Video codecs (AV1 / VP9 / H.264)'),
      h('p', { class: 'muted small' }, `New uploads get a quick scan: a few seconds are trial-encoded with each codec on this machine to measure real speed and size, then the best worthwhile version is encoded in the background (at most ${a.encode.budgetX}x the video's runtime). Each viewer's player picks the best version for their device.`),
      h('p', null, h('label', { style: false }, h('input', { type: 'checkbox', checked: a.encode.auto, onchange: guard(async (e) => api('POST', '/admin/settings', { encodeAuto: e.target.checked })) }), ' Scan & encode new uploads automatically (uncheck to pause background encoding)')),
      h('table', null, a.encode.codecs.map((c) => h('tr', null, h('td', null, h('b', null, c.label)), h('td', null, c.available ? '✓ available' : '✗ not available'), h('td', { class: 'muted small' }, c.available ? c.encoders.join(', ') : c.note)))),
      h('p', { class: 'muted small' }, 'AV2: the specification was released in 2026, but FFmpeg and browsers do not support it yet. The slot is ready - set AV2_ENCODER=<ffmpeg encoder name> in .env once one exists; it is only served to browsers that report AV2 decode support.')),
    h('div', { class: 'panel' }, h('h3', null, 'Users'), h('table', null, a.users.map((u) => h('tr', null, h('td', null, u.name, ' ', h('span', { class: 'muted' }, '@' + u.username)), h('td', { class: 'muted' }, u.email), h('td', null, u.is_admin ? 'admin' : ''), h('td', { class: 'muted' }, fmtHours(u.watch_seconds)),
      h('td', null, u.id !== S.user.id && h('button', { class: 'btn danger sm', onclick: guard(async () => { if (confirm(`Delete ${u.username} and all their files?`)) { await api('DELETE', '/admin/users/' + u.id); render(); } }) }, 'Delete'))))))));
}

const fmtAgo = (ms) => { const sec = (Date.now() - ms) / 1000; return sec < 60 ? 'just now' : sec < 3600 ? Math.floor(sec / 60) + ' min ago' : sec < 86400 ? Math.floor(sec / 3600) + ' h ago' : Math.floor(sec / 86400) + ' d ago'; };
function badgeEl(b) {
  const done = !!b.unlockedAt;
  const bar = h('div', { class: 'meter' }, h('i'));
  bar.firstChild.style.setProperty('--w', Math.round((b.value / b.target) * 100) + '%');
  const prog = b.unit === 'time' ? `${fmtHours(b.value)} / ${fmtHours(b.target)}` : `${b.value} / ${b.target}`;
  return h('div', { class: 'abadge ' + (done ? 'got' : 'locked'), title: b.desc }, h('div', { class: 'medal ' + b.tier }, b.icon), h('div', { class: 'bn' }, b.name), h('div', { class: 'bd' }, b.desc),
    done ? h('div', { class: 'bt' }, `${TIER_LABEL[b.tier]} · ${new Date(b.unlockedAt).toLocaleDateString()}`) : [bar, h('div', { class: 'bt' }, prog)]);
}
let badgeFilter = 'all';
async function profileView(id) {
  const p = await api('GET', id ? `/profile/${id}` : '/profile');
  const head = h('div', { class: 'panel prof' }, avatarEl(p, 96),
    h('div', { class: 'grow' }, h('h1', null, p.self ? p.name : p.name), h('p', { class: 'muted small' }, [p.self ? `@${p.username}` : `@${p.username} · friend`, 'member since ' + new Date(p.since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })].join(' · ')),
      p.level && h('div', { class: 'lvl' }, h('span', { class: 'chip' }, `Level ${p.level.level}`), h('span', { class: 'chip' }, `${p.level.score} points`), (() => { const m = h('div', { class: 'meter lvlbar' }, h('i')); m.firstChild.style.setProperty('--w', Math.round((p.level.into / p.level.span) * 100) + '%'); return m; })(), h('span', { class: 'muted small' }, `${p.level.span - p.level.into} to level ${p.level.level + 1}`))),
    p.self && h('div', { class: 'acts' }, h('a', { class: 'btn sec sm', href: '#/account' }, '⚙ Settings & privacy')));
  if (p.private) { mount(shell('/profile', head, h('div', { class: 'panel' }, h('h3', null, 'Activity is private'), h('p', { class: 'muted' }, `${p.name} hasn't chosen to share their watch time, badges or history with friends.`)))); return; }

  const w = p.watch, v = p.variety;
  const max = Math.max(1, ...w.daily.map((d) => d.seconds));
  const dow = (day) => 'SMTWTFS'[new Date(day + 'T12:00:00').getDay()];
  const bars = h('div', { class: 'bars short' }, w.daily.map((d) => { const i = h('i', { class: d.seconds ? '' : 'zero', title: `${d.day}: ${fmtHours(d.seconds)}` }); i.style.setProperty('--h', Math.max(3, (d.seconds / max) * 100) + '%'); return h('div', { class: 'b' }, i, h('span', null, dow(d.day))); }));
  const unlocked = p.badges.filter((b) => b.unlockedAt).length;
  const grid = h('div', { class: 'badges' });
  const drawBadges = () => {
    const list = p.badges.filter((b) => badgeFilter === 'all' || (badgeFilter === 'got' ? b.unlockedAt : !b.unlockedAt));
    const groups = [...new Set(p.badges.map((b) => b.group))];
    grid.replaceChildren(...groups.flatMap((g) => { const items = list.filter((b) => b.group === g).sort((a, b) => (b.unlockedAt ? 1 : 0) - (a.unlockedAt ? 1 : 0) || (a.target > b.target ? 1 : -1)); return items.length ? [h('h4', null, g), h('div', { class: 'bgrid' }, items.map(badgeEl))] : []; }));
  };
  const chips = h('div', { class: 'tabs' }, [['all', 'All'], ['got', 'Unlocked'], ['todo', 'In progress']].map(([k, l]) => h('button', { class: 'tab' + (badgeFilter === k ? ' on' : ''), onclick: (e) => { badgeFilter = k; chips.querySelectorAll('.tab').forEach((t) => t.classList.remove('on')); e.target.classList.add('on'); drawBadges(); } }, l)));
  drawBadges();

  const recentCard = (r) => {
    const poster = h('div', { class: 'poster' });
    const ph = () => poster.prepend(h('div', { class: 'ph' }, (r.title || '?')[0].toUpperCase()));
    if (r.mediaId && r.hasThumb) { const img = h('img', { src: `/api/media/${r.mediaId}/thumb`, loading: 'lazy', alt: '' }); img.onerror = () => { img.remove(); ph(); }; poster.append(img); }
    else if (r.chan && r.hasLogo) { poster.classList.add('logo'); const img = h('img', { src: `/api/iptv/logo/${r.chan}`, loading: 'lazy', alt: '' }); img.onerror = () => { img.remove(); ph(); }; poster.append(img); } else ph();
    poster.append(h('span', { class: 'badge-pill' }, r.kind === 'iptv' ? 'Live TV' : r.kind === 'tv' ? 'TV' : r.kind === 'movie' ? 'Movie' : 'Video'));
    const open = r.mediaId ? () => mediaModal(r.mediaId) : r.chan ? () => chanModal({ id: r.chan, name: r.title, group: r.sub || '', country: null, ok: null }) : null;
    return h('div', { class: 'card' + (open ? '' : ' dim'), onclick: open || undefined, title: open ? '' : 'Not available to you' }, poster, h('div', { class: 't' }, r.title), h('div', { class: 's' }, [r.sub, `${fmtAgo(r.lastAt)} · ${fmtHours(r.seconds)}`].filter(Boolean).join(' · ')));
  };
  const list = (rows, line) => rows.length ? h('div', { class: 'list' }, rows.map((x) => h('div', null, h('span', { class: 'g' }, line(x)[0]), h('span', { class: 'muted small' }, line(x)[1])))) : h('p', { class: 'muted small' }, 'Nothing yet.');
  const meterRow = (label, secs, tot) => { const m = h('div', { class: 'meter' }, h('i')); m.firstChild.style.setProperty('--w', (tot ? (secs / tot) * 100 : 0) + '%'); return h('div', { class: 'lb' }, h('span', { class: 'g', style: false }, label), m, h('span', { class: 'muted small' }, fmtHours(secs))); };
  const catTot = Math.max(1, ...v.categories.map((c) => c.seconds)), ctTot = Math.max(1, ...v.countries.map((c) => c.seconds));

  mount(shell('/profile', head,
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('div', { class: 'v g' }, fmtHours(w.total)), h('div', { class: 't' }, 'watch time, all-time')),
      h('div', { class: 'tile' }, h('div', { class: 'v' }, fmtHours(w.month)), h('div', { class: 't' }, 'last 30 days')),
      h('div', { class: 'tile' }, h('div', { class: 'v' }, fmtHours(w.week)), h('div', { class: 't' }, 'last 7 days')),
      h('div', { class: 'tile' }, h('div', { class: 'v' }, `${unlocked}/${p.badges.length}`), h('div', { class: 't' }, 'badges earned'))),
    h('div', { class: 'split' },
      h('div', { class: 'panel' }, h('h3', null, 'Last 14 days'), bars),
      h('div', { class: 'panel' }, h('h3', null, 'Watch time by type'), w.byKind.length ? w.byKind.map((k) => meterRow(KIND[k.kind] || k.kind, k.seconds, w.total)) : h('p', { class: 'muted' }, 'No data yet.'))),
    h('section', { class: 'row' }, h('h2', null, 'Recently watched'), p.recent.length ? h('div', { class: 'strip' }, p.recent.map(recentCard)) : h('p', { class: 'muted' }, 'Nothing watched yet - press play on something!')),
    h('div', { class: 'panel' }, h('div', { class: 'page-h' }, h('h2', null, 'Badges'), h('span', { class: 'muted small' }, `${unlocked} of ${p.badges.length} unlocked`)), chips, grid),
    h('div', { class: 'panel' }, h('h2', null, 'Everything you watch'), h('p', { class: 'muted small' }, 'Titles count once you have watched at least a minute of them.'),
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('div', { class: 'v' }, String(v.counts.movies)), h('div', { class: 't' }, 'different movies')),
        h('div', { class: 'tile' }, h('div', { class: 'v' }, String(v.counts.shows)), h('div', { class: 't' }, `TV shows (${v.counts.episodes} episodes)`)),
        h('div', { class: 'tile' }, h('div', { class: 'v' }, String(v.counts.videos)), h('div', { class: 't' }, 'other videos')),
        h('div', { class: 'tile' }, h('div', { class: 'v' }, String(v.counts.channels)), h('div', { class: 't' }, `live channels (${v.counts.countries} countries)`))),
      h('div', { class: 'split' },
        h('div', null,
          h('details', { class: 'scan', open: v.counts.movies > 0 }, h('summary', null, `Movies (${v.counts.movies})`), list(v.movies, (m) => [m.title + (m.year ? ` (${m.year})` : ''), fmtHours(m.seconds)])),
          h('details', { class: 'scan', open: v.counts.shows > 0 }, h('summary', null, `TV shows (${v.counts.shows})`), list(v.shows, (x) => [x.show, `${x.episodes} episode${x.episodes === 1 ? '' : 's'} · ${fmtHours(x.seconds)}`])),
          h('details', { class: 'scan' }, h('summary', null, `Other videos (${v.counts.videos})`), list(v.videos, (x) => [x.title, fmtHours(x.seconds)]))),
        h('div', null,
          h('details', { class: 'scan', open: v.counts.channels > 0 }, h('summary', null, `Live channels (${v.counts.channels})`), list(v.channels, (c) => [c.name, [c.group, c.country, fmtHours(c.seconds)].filter(Boolean).join(' · ')])),
          v.categories.length ? h('details', { class: 'scan' }, h('summary', null, 'Live TV categories'), v.categories.map((c) => meterRow(c.name, c.seconds, catTot))) : null,
          v.countries.length ? h('details', { class: 'scan' }, h('summary', null, 'Live TV countries'), v.countries.map((c) => meterRow(c.name, c.seconds, ctTot))) : null)))));
}

async function friendsView() {
  const f = await api('GET', '/friends');
  const code = h('input', { placeholder: "A friend's code, e.g. 7K2MQ-9XDWB", autocomplete: 'off', spellcheck: 'false' });
  const msg = h('input', { placeholder: 'Optional note so they know it\'s you (shown instead of your name)', maxlength: 80 });
  const refresh = () => render();
  mount(shell('/friends',
    h('div', { class: 'page-h' }, h('h1', null, 'Friends'), h('span', { class: 'chip' }, '🔒 invisible by default')),
    h('p', { class: 'muted' }, 'Nobody on ShowTime can see you - not your name, photo, or whether you\'re online - until you swap friend codes with them off the platform (text, in person, anything). There is no user search or directory.'),
    h('div', { class: 'split' },
      h('div', null,
        h('div', { class: 'panel' }, h('h3', null, 'Your friend code'), h('p', { class: 'muted small' }, 'Give this to someone you want as a friend. Anyone with it can send you a request (you decide whether to accept).'),
          h('p', null, h('code', { class: 'k big' }, f.code)),
          h('div', { class: 'acts' }, h('button', { class: 'btn sec sm', onclick: () => { navigator.clipboard?.writeText(f.code).then(() => toast('Copied'), () => toast('Select and copy it manually')); } }, 'Copy'),
            h('button', { class: 'btn sec sm', title: 'Revoke the old code and make a new one', onclick: guard(async () => { if (!confirm('Make a new code? The old one stops working immediately.')) return; await api('POST', '/friends/code/regenerate'); refresh(); }) }, 'New code'))),
        h('div', { class: 'panel' }, h('h3', null, 'Add a friend'), code, h('div', { style: false }, msg),
          h('p', null, h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/friends/request', { code: code.value, message: msg.value }); toast(r.accepted ? 'You are now friends!' : r.status === 'friends' ? 'Already friends' : 'Request sent'); refresh(); }) }, 'Send request')),
          f.outgoing.length ? h('div', null, h('h3', null, 'Sent requests'), h('div', { class: 'list' }, f.outgoing.map((o) => h('div', null, h('span', { class: 'g muted' }, `Pending - ${o.hint}`), h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('DELETE', `/friends/requests/${o.id}`); refresh(); }) }, 'Cancel'))))) : null)),
      h('div', null,
        f.incoming.length ? h('div', { class: 'panel' }, h('h3', null, `Requests (${f.incoming.length})`), h('p', { class: 'muted small' }, 'Senders stay anonymous until you accept. Their note is how you recognise them.'),
          h('div', { class: 'list' }, f.incoming.map((r) => h('div', null, avatarEl({ id: r.id, name: r.alias }, 34), h('span', { class: 'g' }, r.alias, r.message ? h('span', { class: 'muted' }, `  "${r.message}"`) : null),
            h('button', { class: 'btn sm', onclick: guard(async () => { await api('POST', `/friends/requests/${r.id}/accept`); refresh(); }) }, 'Accept'),
            h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('POST', `/friends/requests/${r.id}/decline`, {}); refresh(); }) }, 'Decline'),
            h('button', { class: 'btn danger sm', title: 'Decline and never hear from them again', onclick: guard(async () => { await api('POST', `/friends/requests/${r.id}/decline`, { block: true }); refresh(); }) }, 'Block'))))) : null,
        h('div', { class: 'panel' }, h('h3', null, `Friends (${f.friends.length})`),
          f.friends.length ? h('div', { class: 'list' }, f.friends.map((u) => h('div', null, avatarEl(u, 34), h('span', { class: 'g' }, h('a', { href: `#/profile/${u.id}`, class: 'plink', title: 'View profile' }, u.name), h('span', { class: 'muted' }, ` @${u.username}`), ' ', h('span', { class: u.online ? 'dot' : 'dot off' })),
            currentRoomId && h('button', { class: 'btn sm', onclick: guard(async (e) => { await inviteUser(currentRoomId, u.id, e.target); }) }, 'Invite'),
            h('button', { class: 'btn sec sm', onclick: guard(async () => { if (confirm(`Remove ${u.name}? You'll become anonymous to each other again.`)) { await api('DELETE', `/friends/${u.id}`); refresh(); } }) }, 'Remove')))) : h('p', { class: 'muted' }, 'No friends yet - swap codes with someone.')),
        f.blocked.length ? h('div', { class: 'panel' }, h('h3', null, 'Blocked'), h('div', { class: 'list' }, f.blocked.map((b) => h('div', null, h('span', { class: 'g muted' }, b.alias), h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('DELETE', `/blocks/${b.id}`); refresh(); }) }, 'Unblock'))))) : null))));
}

function accountView() {
  const err = h('div', { class: 'err' });
  const name = h('input', { value: S.user.name, maxlength: 60 });
  const avInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
  avInput.addEventListener('change', guard(async () => {
    const f = avInput.files[0];
    if (!f) return;
    const r = await fetch('/api/profile/avatar', { method: 'PUT', headers: { 'X-Requested-With': 'showtime' }, body: f });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    toast('Profile picture updated'); render();
  }));
  const toggle = (label, key, help) => h('label', { class: 'tg' }, h('input', { type: 'checkbox', checked: S.user[key], onchange: guard(async (e) => { await api('PATCH', '/profile', { [key]: e.target.checked }); toast('Saved'); }) }), h('span', null, label, h('small', { class: 'muted' }, help)));
  mount(shell('', h('h1', null, 'Your profile'),
    h('div', { class: 'panel prof' }, avatarEl(S.user, 84),
      h('div', null, h('h3', null, S.user.name), h('p', { class: 'muted small' }, `@${S.user.username} · ${S.user.email}`),
        h('p', { class: 'muted small' }, 'Your photo and name are only ever shown to accepted friends. Everyone else sees an anonymous alias.'),
        h('div', { class: 'acts' }, h('button', { class: 'btn sm', onclick: () => avInput.click() }, S.user.avatar ? 'Change picture' : 'Upload picture'), S.user.avatar && h('button', { class: 'btn sec sm', onclick: guard(async () => { await api('DELETE', '/profile/avatar'); render(); }) }, 'Remove'), avInput))),
    h('div', { class: 'panel' }, h('h3', null, 'Display name'), h('div', { class: 'toolbar' }, name, h('button', { class: 'btn sec', onclick: guard(async () => { await api('PATCH', '/profile', { name: name.value }); toast('Saved'); render(); }) }, 'Save'))),
    h('div', { class: 'panel' }, h('h3', null, 'Privacy'),
      toggle('Show me as online to my friends', 'showOnline', ' Turn off to appear offline everywhere.'),
      toggle('Allow new friend requests', 'acceptRequests', ' When off, anyone using your code is silently ignored.'),
      toggle('Let friends see my watch activity', 'shareActivity', ' Shows your badges, watch time, recently watched and what you watch on your profile - to friends only. Off by default.')),
    h('div', { class: 'panel' }, h('h3', null, 'Video display'), h('p', { class: 'muted small' }, 'How the picture fills the player (you can also change this in any room). Saved on this device.'),
      h('div', { class: 'toolbar' }, (() => { const sel = h('select', { onchange: () => { try { localStorage.setItem('st_fit', sel.value); } catch { /* private mode */ } toast('Saved'); } }, Object.entries(FIT).map(([k, [l]]) => h('option', { value: k, selected: (() => { try { return (localStorage.getItem('st_fit') || 'fit') === k; } catch { return k === 'fit'; } })() }, l))); return sel; })())),
    h('div', { class: 'panel', style: false }, h('h3', null, 'Change password'), h('label', null, 'Current password'), h('input', { id: 'cp', type: 'password', autocomplete: 'current-password' }), h('label', null, 'New password (10+ characters)'), h('input', { id: 'np', type: 'password', autocomplete: 'new-password' }), err,
      h('p', null, h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/password', { current: document.getElementById('cp').value, password: document.getElementById('np').value }); toast('Password changed'); err.textContent = ''; } catch (e) { err.textContent = e.message; } } }, 'Update')))));
}

render();
