// MIRC-style encrypted chat UI. Everything lives in memory only: no localStorage, no IndexedDB, no cookies.
// Passphrases are never stored; keys are non-extractable CryptoKeys that vanish on reload / wipe / logout.
import { deriveChannel, randomSalt, seal, open, MAX_PLAINTEXT } from './chatcrypto.js';

export function initChat({ h, api, toast, shell, mount, onUnread }) {
  const st = { es: null, cid: null, nextWipe: 0, nick: 'Kernel' + (1000 + Math.floor(Math.random() * 9000)), wins: new Map(), active: 'status', chain: Promise.resolve(), history: [], hpos: 0, tick: null, ui: null };
  const mkWin = (name) => ({ name, lines: [], users: new Map(), key: null, verifier: null, salt: null, joined: false, unread: 0, hostLines: 0 });
  const status = mkWin('status');
  st.wins.set('status', status);
  const secure = !!(window.crypto && crypto.subtle);

  // ---------- model ----------
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const hue = (s) => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
  const totalUnread = () => [...st.wins.values()].reduce((a, w) => a + w.unread, 0);

  function line(win, kind, text, extra = {}) {
    win.lines.push({ ts: Date.now(), kind, text, ...extra });
    if (win.lines.length > 400) win.lines.shift();
    if (st.ui && st.active === win.name) { drawLog(); }
    else if (kind === 'msg' || kind === 'action') { win.unread++; onUnread(totalUnread()); drawTabs(); }
  }
  const sys = (text, win = status) => line(win, 'sys', text);
  const activeWin = () => st.wins.get(st.active) || status;

  function banner() {
    sys('*** ShowTime Chat - end-to-end encrypted, RAM-only, wiped every 48 hours.');
    sys('*** The server only ever sees ciphertext. Nicknames and text exist only inside encrypted messages.');
    sys('*** Type /help for commands, or press "Join channel". Share the channel name + passphrase with friends OFF the platform.');
    if (!secure) sys('*** Encryption needs a secure connection (https:// or localhost). Chat is disabled here.');
    if (window.ST_DEMO) sys('*** LIVE DEMO: type   /join #demo popcorn   to chat with simulated users. The encryption is real and runs in your browser.');
  }
  banner();

  // ---------- connection ----------
  function connect() {
    if (st.es || !secure) return;
    st.es = new EventSource('/api/chat/events');
    st.es.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      const reconnect = !!st.cid;
      st.cid = d.cid; st.nextWipe = d.nextWipe;
      if (reconnect) for (const w of st.wins.values()) if (w.joined) rejoin(w); // new connection id after a network blip
    });
    st.es.addEventListener('msg', (e) => { const d = JSON.parse(e.data); st.chain = st.chain.then(() => incoming(d)).catch(() => {}); });
    st.es.addEventListener('wipe', (e) => wipeLocal(JSON.parse(e.data).nextWipe));
  }

  async function rejoin(w) {
    try { await api('POST', '/chat/join', { name: w.name, cid: st.cid, verifier: w.verifier }); } catch { w.joined = false; sys(`*** Lost ${w.name} (the chat was wiped or the passphrase changed).`, w); }
  }

  function wipeLocal(next) {
    for (const w of st.wins.values()) { w.lines.length = 0; w.users.clear(); w.key = null; w.verifier = null; w.salt = null; w.joined = false; w.unread = 0; }
    st.wins = new Map([['status', status]]);
    st.active = 'status'; st.nextWipe = next || 0; st.history.length = 0;
    onUnread(0);
    sys('*** THE 48-HOUR WIPE HAS HAPPENED. All channels, messages and keys were permanently destroyed - on the server and on this device.');
    sys('*** Nothing can be recovered. Join a channel again with your passphrase to start fresh.');
    if (st.ui) { drawTabs(); drawLog(); drawUsers(); }
  }

  // ---------- crypto helpers ----------
  async function send(win, obj) {
    if (!win.joined || !win.key) return sys('*** You are not in this channel.', win);
    try {
      const sealed = await seal(win.key, win.name, obj);
      await api('POST', '/chat/send', { name: win.name, cid: st.cid, ...sealed });
    } catch (e) { sys(`*** ${e.message}`, win); }
  }

  async function incoming(d) {
    const w = st.wins.get(d.chan);
    if (!w || !w.key) return;
    const m = await open(w.key, w.name, d.iv, d.ct);
    if (!m || typeof m !== 'object') return;
    applyMsg(w, m, d.ts, false);
  }
  function applyMsg(w, m, ts, quiet) {
    const n = String(m.n || '?').slice(0, 24);
    const text = String(m.x || '').slice(0, 600);
    switch (m.t) {
      case 'm': w.users.set(n, Date.now()); line(w, 'msg', text, { nick: n, ts, mine: n === st.nick }); break;
      case 'a': w.users.set(n, Date.now()); line(w, 'action', text, { nick: n, ts }); break;
      case 'j': w.users.set(n, Date.now()); if (!quiet) { line(w, 'join', `${n} has joined ${w.name}`, { ts }); if (n !== st.nick) setTimeout(() => send(w, { t: 'p', n: st.nick }), 200 + Math.random() * 1200); } break;
      case 'q': w.users.delete(n); if (!quiet) line(w, 'part', `${n} has left ${w.name}`, { ts }); break;
      case 'n': { const o = String(m.o || '').slice(0, 24); w.users.delete(o); w.users.set(n, Date.now()); if (!quiet) line(w, 'sys', `${o} is now known as ${n}`, { ts }); break; }
      case 'p': w.users.set(n, Date.now()); break;
    }
    if (st.ui && st.active === w.name) drawUsers();
  }

  async function joinChannel(rawName, pass) {
    if (!secure) return sys('*** Chat needs https:// or localhost for encryption.');
    const name = ('#' + String(rawName).replace(/^#+/, '')).toLowerCase();
    if (!/^#[a-z0-9_-]{1,24}$/.test(name)) return sys('*** Channel names look like #lobby (letters, numbers, - and _).');
    if (st.wins.get(name)?.joined) { st.active = name; return refreshAll(); }
    if (!pass) return sys('*** A passphrase is required: /join #channel your passphrase   (or use the Join button)');
    connect();
    const t0 = Date.now();
    while (!st.cid && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
    if (!st.cid) return sys('*** Not connected to the chat server yet.');
    try {
      const info = await api('GET', '/chat/chan?name=' + encodeURIComponent(name));
      if (!info.exists && pass.length < 8) return sys('*** To create a channel use a passphrase of at least 8 characters (longer is better).');
      sys(info.exists ? `*** Deriving key for ${name} ...` : `*** Creating ${name} and deriving its key ...`);
      const salt = info.exists ? info.salt : randomSalt();
      const { key, verifier } = await deriveChannel(name, pass, salt);
      const r = await api('POST', '/chat/join', { name, cid: st.cid, salt, verifier });
      const w = mkWin(name);
      Object.assign(w, { key, verifier, salt: r.salt, joined: true });
      st.wins.set(name, w); st.active = name;
      sys(`*** Joined ${name} as ${st.nick} - end-to-end encrypted. History is kept only until the next wipe.`, w);
      let readable = 0;
      for (const b of r.backlog) { const m = await open(key, name, b.iv, b.ct); if (m) { readable++; applyMsg(w, m, b.ts, true); } }
      w.unread = 0; onUnread(totalUnread());
      if (r.backlog.length) sys(`*** ${readable} earlier message(s) decrypted.`, w);
      await send(w, { t: 'j', n: st.nick });
      w.users.set(st.nick, Date.now());
      refreshAll();
    } catch (e) { sys(`*** ${e.message}`); }
  }

  async function partChannel(name) {
    const w = st.wins.get(name);
    if (!w || name === 'status') return;
    await send(w, { t: 'q', n: st.nick }).catch(() => {});
    api('POST', '/chat/leave', { name, cid: st.cid }).catch(() => {});
    w.key = null; w.verifier = null; w.joined = false; w.lines.length = 0;
    st.wins.delete(name);
    if (st.active === name) st.active = 'status';
    onUnread(totalUnread());
    refreshAll();
  }

  // ---------- commands ----------
  async function handleInput(text) {
    text = text.replace(/[\x00-\x1f]/g, ' ').trim();
    if (!text) return;
    st.history.push(text); st.hpos = st.history.length;
    const w = activeWin();
    if (!text.startsWith('/')) {
      if (w === status) return sys('*** Join a channel first (/join #name passphrase).');
      if (new TextEncoder().encode(text).length > MAX_PLAINTEXT - 120) return sys('*** Message too long.', w);
      return send(w, { t: 'm', n: st.nick, x: text });
    }
    const [cmd, ...rest] = text.slice(1).split(' ');
    const arg = rest.join(' ').trim();
    switch (cmd.toLowerCase()) {
      case 'help':
        ['*** Commands:', '  /join #channel passphrase   join or create an encrypted channel', '  /part [#channel]            leave a channel (and forget its key)', '  /nick NewNick               change your nickname (only visible inside encrypted chat)', '  /me does something          action message', '  /who                        list people seen in this channel', '  /list                       list channels you are in', '  /clear                      clear this window on your screen', '  /wipe                       time until the next permanent wipe', '  /quit                       leave everything and forget all keys', '  Tip: use the Join button to type the passphrase in a hidden field.'].forEach((l) => sys(l, w));
        break;
      case 'join': { const [c, ...p] = arg.split(' '); if (!c) return sys('*** Usage: /join #channel passphrase', w); return joinChannel(c, p.join(' ')); }
      case 'part': case 'leave': return partChannel(arg ? ('#' + arg.replace(/^#+/, '')).toLowerCase() : st.active);
      case 'nick': {
        const n = arg.replace(/\s+/g, '').slice(0, 24);
        if (!n) return sys('*** Usage: /nick NewNick', w);
        const old = st.nick; st.nick = n;
        sys(`*** You are now known as ${n}`, w);
        for (const x of st.wins.values()) if (x.joined) send(x, { t: 'n', o: old, n });
        refreshAll();
        return;
      }
      case 'me': return w === status ? sys('*** Join a channel first.') : send(w, { t: 'a', n: st.nick, x: arg });
      case 'who': { const now = Date.now(); const us = [...w.users].filter(([, t]) => now - t < 90000).map(([n]) => n); return sys(`*** In ${w.name}: ${us.join(', ') || '(nobody seen yet)'}`, w); }
      case 'list': return sys(`*** Channels: ${[...st.wins.values()].filter((x) => x.joined).map((x) => x.name).join(', ') || '(none)'}`, w);
      case 'clear': w.lines.length = 0; return drawLog();
      case 'wipe': return sys(`*** Next wipe in ${countdown()}.`, w);
      case 'quit': for (const x of [...st.wins.keys()]) if (x !== 'status') await partChannel(x); status.lines.length = 0; banner(); return refreshAll();
      default: return sys(`*** Unknown command /${cmd}. Try /help`, w);
    }
  }

  function countdown() {
    let s = Math.max(0, Math.floor((st.nextWipe - Date.now()) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400; const hh = Math.floor(s / 3600); s -= hh * 3600; const mm = Math.floor(s / 60);
    return `${d ? d + 'd ' : ''}${pad(hh)}h ${pad(mm)}m ${pad(s - mm * 60)}s`;
  }

  setInterval(() => { for (const w of st.wins.values()) if (w.joined) { send(w, { t: 'p', n: st.nick }); } }, 30000);

  // ---------- UI ----------
  function drawTabs() {
    if (!st.ui) return;
    st.ui.tabs.replaceChildren(...[...st.wins.values()].map((w) => h('button', { class: 'irc-tab' + (st.active === w.name ? ' on' : '') + (w.unread ? ' hot' : ''), onclick: () => { st.active = w.name; w.unread = 0; onUnread(totalUnread()); refreshAll(); } },
      w.name === 'status' ? 'Status' : `🔒 ${w.name}`, w.unread ? h('b', null, ` ${w.unread}`) : null)));
  }
  function drawLog() {
    if (!st.ui) return;
    const w = activeWin();
    const log = st.ui.log;
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.replaceChildren(...w.lines.map((l) => {
      const t = h('span', { class: 'ts' }, `[${clock(l.ts)}] `);
      if (l.kind === 'msg') { const n = h('span', { class: 'nick' + (l.mine ? ' me' : '') }, `<${l.nick}>`); n.style.setProperty('--hue', hue(l.nick)); return h('div', { class: 'irc-l' }, t, n, ' ', l.text); }
      if (l.kind === 'action') { const n = h('span', { class: 'nick' }, `* ${l.nick}`); n.style.setProperty('--hue', hue(l.nick)); return h('div', { class: 'irc-l act' }, t, n, ' ', l.text); }
      return h('div', { class: 'irc-l ' + l.kind }, t, l.text);
    }));
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function drawUsers() {
    if (!st.ui) return;
    const w = activeWin(); const now = Date.now();
    const us = w.name === 'status' ? [] : [...w.users].filter(([n, t]) => n === st.nick || now - t < 90000).map(([n]) => n).sort((a, b) => a.localeCompare(b));
    st.ui.users.replaceChildren(h('div', { class: 'irc-uh' }, w.name === 'status' ? 'Status' : `${us.length} user${us.length === 1 ? '' : 's'}`), ...us.map((n) => { const e = h('div', { class: 'irc-u' + (n === st.nick ? ' me' : '') }, n); e.style.setProperty('--hue', hue(n)); return e; }));
    st.ui.title.textContent = w.name === 'status' ? 'Status' : `${w.name}  ·  end-to-end encrypted`;
  }
  const refreshAll = () => { drawTabs(); drawLog(); drawUsers(); if (st.ui) st.ui.prompt.textContent = `[${st.nick}]`; };

  function joinDialog() {
    const bg = h('div', { class: 'modalbg', onclick: (e) => e.target === bg && bg.remove() });
    const ch = h('input', { placeholder: '#lobby', value: activeWin().name.startsWith('#') ? activeWin().name : '#' });
    const pw = h('input', { type: 'password', placeholder: 'channel passphrase', autocomplete: 'off' });
    const go = () => { const c = ch.value, p = pw.value; bg.remove(); joinChannel(c, p); };
    [ch, pw].forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && go()));
    bg.append(h('div', { class: 'modal' }, h('button', { class: 'x', onclick: () => bg.remove() }, '×'), h('div', { class: 'mb' }, h('h2', null, 'Join an encrypted channel'),
      h('p', { class: 'muted small' }, 'New channel? Pick any name and a strong passphrase (8+ characters) - you create it. Existing channel? Enter its passphrase. The passphrase never leaves your browser and is not stored.'),
      h('label', null, 'Channel'), ch, h('label', null, 'Passphrase'), pw, h('p', null, h('button', { class: 'btn', onclick: go }, 'Join')))));
    document.body.append(bg);
    (ch.value.length > 1 ? pw : ch).focus();
  }

  function chatView() {
    connect();
    onUnread(0);
    for (const w of st.wins.values()) w.unread = 0;
    const tabs = h('div', { class: 'irc-tabs' });
    const title = h('span', null, 'Status');
    const wipe = h('span', { class: 'irc-wipe' });
    const log = h('div', { class: 'irc-log', tabindex: 0 });
    const users = h('div', { class: 'irc-users' });
    const prompt = h('span', { class: 'irc-prompt' }, `[${st.nick}]`);
    const input = h('input', { class: 'irc-in', maxlength: 500, placeholder: secure ? 'Type a message or /help' : 'Chat is disabled (needs https or localhost)', autocomplete: 'off', spellcheck: 'false', disabled: !secure });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = input.value; input.value = ''; handleInput(v); }
      else if (e.key === 'ArrowUp') { if (st.hpos > 0) input.value = st.history[--st.hpos] || ''; e.preventDefault(); }
      else if (e.key === 'ArrowDown') { st.hpos = Math.min(st.history.length, st.hpos + 1); input.value = st.history[st.hpos] || ''; e.preventDefault(); }
    });
    st.ui = { tabs, title, log, users, prompt, input, wipe };
    clearInterval(st.tick);
    st.tick = setInterval(() => { wipe.textContent = st.nextWipe ? `🕒 wipe in ${countdown()}` : ''; }, 1000);
    wipe.textContent = st.nextWipe ? `🕒 wipe in ${countdown()}` : '';
    mount(shell('/chat',
      h('div', { class: 'page-h' }, h('h1', null, 'Chat'), h('span', { class: 'chip' }, '🔒 end-to-end encrypted'), h('span', { class: 'chip' }, 'RAM only'), h('span', { class: 'chip' }, 'wiped every 48h')),
      h('div', { class: 'irc' },
        h('div', { class: 'irc-title' }, h('span', { class: 'irc-ico' }, '💬'), h('span', { class: 'irc-name' }, 'ShowTime IRC - ', title), wipe),
        h('div', { class: 'irc-bar' }, h('button', { class: 'irc-btn', onclick: joinDialog }, '＋ Join channel'), h('button', { class: 'irc-btn', onclick: () => { const n = prompt_('New nickname', st.nick); if (n) handleInput('/nick ' + n); } }, 'Nick'), h('button', { class: 'irc-btn', onclick: () => handleInput('/help') }, 'Help'), h('button', { class: 'irc-btn', onclick: () => handleInput('/quit') }, 'Quit all')),
        tabs,
        h('div', { class: 'irc-main' }, log, users),
        h('div', { class: 'irc-input' }, prompt, input)),
      h('p', { class: 'muted small' }, 'Nothing here is saved: messages exist only in memory (yours and the server\'s) until the next 48-hour wipe, then every copy is destroyed. Anyone with a channel\'s passphrase can read it and can type under any nickname, so share it only with people you trust. Reloading this page forgets your keys.')));
    refreshAll();
    setTimeout(() => input.focus(), 50);
  }
  const prompt_ = (m, d) => window.prompt(m, d);
  const leaveView = () => { st.ui = null; clearInterval(st.tick); };

  function resetChat() {
    st.es?.close(); st.es = null; st.cid = null; clearInterval(st.tick);
    for (const w of st.wins.values()) { w.lines.length = 0; w.users.clear(); w.key = null; w.verifier = null; w.joined = false; }
    st.wins = new Map([['status', status]]); status.lines.length = 0; status.unread = 0; st.active = 'status'; st.history.length = 0; st.ui = null; banner(); onUnread(0);
  }

  return { chatView, leaveView, resetChat, connect };
}
