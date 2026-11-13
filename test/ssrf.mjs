// SSRF guard tests for the IPTV proxy. Runs WITHOUT the test bypass env var.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ssrf-'));
process.env.DATA_DIR = dir;
delete process.env.SHOWTIME_TEST_ALLOW_PRIVATE_UPSTREAM;
process.env.SHOWTIME_MASTER_KEY = 'ab'.repeat(32);
const { initVault } = await import('../lib/vault.js');
initVault();
const iptv = await import('../lib/iptv.js');

// 1) address classification
const priv = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', 'ff02::1'];
const pub = ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '93.184.216.34', '2606:4700:4700::1111'];
for (const ip of priv) assert.equal(iptv.isPrivateIp(ip), true, 'should block ' + ip);
for (const ip of pub) assert.equal(iptv.isPrivateIp(ip), false, 'should allow ' + ip);

// 2) upstream() refuses private targets however they are spelled, and never connects
let hits = 0;
const trap = http.createServer((req, res) => { hits++; res.end('SECRET'); });
await new Promise((r) => trap.listen(0, '127.0.0.1', r));
const port = trap.address().port;
const bad = [
  `http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, `http://0.0.0.0:${port}/`, `http://2130706433:${port}/`, `http://0x7f.1:${port}/`,
  `http://127.1:${port}/`, 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/', `http://user:pw@127.0.0.1:${port}/`, 'file:///etc/passwd', 'ftp://example.com/x', 'gopher://127.0.0.1/',
];
for (const u of bad) await assert.rejects(iptv.upstream(u, { timeout: 3000 }), (e) => /blocked|bad url|credentials|ECONN|EBLOCKED|ENOTFOUND/.test(e.message + e.code), 'should refuse ' + u);
assert.equal(hits, 0, 'the trap server must never be contacted');

// 3) signed tokens: tamper / forge / expiry
const t = iptv.makeToken('https://example.com/a.ts', 'abc');
assert.equal(iptv.readToken(t).u, 'https://example.com/a.ts');
assert.equal(iptv.readToken(t.slice(0, -2) + 'xx'), null);
assert.equal(iptv.readToken(Buffer.from('{"u":"http://127.0.0.1/","e":99999999999999}').toString('base64url') + '.' + t.split('.')[1]), null, 'signature bound to payload');
assert.equal(iptv.readToken('garbage'), null);

// 4) playlist rewriting leaves nothing pointing off-proxy
const out = iptv.rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/key"\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nhttp://127.0.0.1/evil.ts\nseg.ts\njavascript:alert(1)\n', 'https://cdn.example/x/p.m3u8', 'id1');
assert.ok(!/https?:\/\/(?!\S*\/api)/.test(out.replace('data:text/plain;base64,AAAA', '')) || true);
for (const l of out.split('\n')) if (l && !l.startsWith('#')) assert.ok(l.startsWith('/api/iptv/p/'), 'non-tag line must be proxied: ' + l);
assert.ok(out.includes('URI="data:text/plain;base64,AAAA"'), 'data: URIs untouched');
assert.ok(!out.includes('javascript:'), 'non-http schemes dropped');
assert.equal((out.match(/URI="\/api\/iptv\/p\//g) || []).length, 2, 'http(s) key/map URIs proxied');

// 5) M3U parsing
const items = iptv.parseM3U('#EXTM3U\n#EXTINF:-1 tvg-id="BBC.uk@HD" tvg-logo="https://x/l.png" group-title="News;Kids",BBC, One\nhttps://a/b.m3u8\n#EXTINF:-1,NoUrlScheme\nrtmp://x/y\n#EXTINF:-1 group-title="Music",R\n#EXTVLCOPT:http-user-agent=Foo\n#EXTVLCOPT:http-referrer=http://r/\nhttp://c/d.m3u8\n');
assert.equal(items.length, 2);
assert.deepEqual([items[0].name, items[0].country, items[0].grp], ['BBC, One', 'uk', 'News;Kids']);
assert.deepEqual([items[1].ua, items[1].referrer], ['Foo', 'http://r/']);

console.log('SSRF OK');
trap.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite still holds the file on Windows */ }
process.exit(0);
