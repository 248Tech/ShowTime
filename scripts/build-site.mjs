// Builds the GitHub Pages site into ./_site:
//   /            landing page (from ./site)
//   /demo/       the REAL ShowTime front-end (from ./public) running against an in-browser mock backend (from ./demo-src)
// Usage: node scripts/build-site.mjs [--serve]     (--serve hosts _site at http://localhost:4173/ShowTime/ exactly like GitHub Pages does)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '_site');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REPO = 'https://github.com/248Tech/ShowTime';
const SITE = 'https://248tech.github.io/ShowTime/';
const BASE = '/ShowTime';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'demo'), { recursive: true });

const copyDir = (from, to, skip = () => false) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    e.isDirectory() ? copyDir(a, b, skip) : fs.copyFileSync(a, b);
  }
};

// 1) landing page
if (fs.existsSync(path.join(ROOT, 'site'))) copyDir(path.join(ROOT, 'site'), OUT);
const subst = (s) => s.replaceAll('{{VERSION}}', pkg.version).replaceAll('{{REPO}}', REPO).replaceAll('{{SITE}}', SITE).replaceAll('{{DATE}}', new Date().toISOString().slice(0, 10));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(OUT)) if (/\.(html|xml|txt|json|webmanifest)$/.test(f)) fs.writeFileSync(f, subst(fs.readFileSync(f, 'utf8')));

// 2) the real front-end + mock backend
const demo = path.join(OUT, 'demo');
copyDir(path.join(ROOT, 'public'), demo, (n) => n === 'hls.min.js' || n === 'hls.js.LICENSE.txt');
copyDir(path.join(ROOT, 'demo-src'), demo, (n) => n === 'hls-stub.js');
fs.copyFileSync(path.join(ROOT, 'demo-src/hls-stub.js'), path.join(demo, 'hls.min.js'));
let html = fs.readFileSync(path.join(demo, 'index.html'), 'utf8');
html = html
  .replace('<title>ShowTime</title>', '<title>ShowTime - Live Demo</title>\n<meta name="robots" content="noindex">\n<link rel="canonical" href="' + SITE + '">')
  .replace('<script src="./app.js" type="module"></script>', '<script>window.ST_DEMO = true;</script>\n<script type="module" src="./mock.js"></script>\n<script src="./app.js" type="module"></script>');
fs.writeFileSync(path.join(demo, 'index.html'), html);

// 3) badge definitions come straight from the real achievement engine (kept in sync automatically)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-build-'));
process.env.DATA_DIR = tmp;
process.env.SHOWTIME_MASTER_KEY = '00'.repeat(32);
const { DEFS } = await import(new URL('../lib/achievements.js', import.meta.url));
fs.writeFileSync(path.join(demo, 'badges.json'), JSON.stringify(DEFS.map(({ v, ...d }) => d)));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
const size = walk(OUT).reduce((a, f) => a + fs.statSync(f).size, 0);
console.log(`built _site: ${walk(OUT).length} files, ${(size / 1e6).toFixed(1)} MB (v${pkg.version})`);

if (process.argv.includes('--serve')) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.xml': 'application/xml', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };
  http.createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith(BASE + '/') && p !== BASE) { res.writeHead(404).end('Not found (served under ' + BASE + '/ like GitHub Pages)'); return; }
    p = p.slice(BASE.length) || '/';
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(OUT, path.normalize(p));
    if (!f.startsWith(OUT)) { res.writeHead(403).end(); return; }
    try {
      const st = await fsp.stat(f); const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      const h = { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
      if (range) { const s = +range[1] || 0, e = range[2] ? +range[2] : st.size - 1; res.writeHead(206, { ...h, 'Content-Range': `bytes ${s}-${e}/${st.size}`, 'Content-Length': e - s + 1 }); fs.createReadStream(f, { start: s, end: e }).pipe(res); }
      else { res.writeHead(200, { ...h, 'Content-Length': st.size }); fs.createReadStream(f).pipe(res); }
    } catch { res.writeHead(404, { 'Content-Type': 'text/html' }).end(fs.existsSync(path.join(OUT, '404.html')) ? fs.readFileSync(path.join(OUT, '404.html')) : 'Not found'); }
  }).listen(4173, () => console.log(`serving http://localhost:4173${BASE}/  (demo: ${BASE}/demo/)`));
} else process.exit(0);
