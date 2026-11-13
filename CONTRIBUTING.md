# Contributing to ShowTime

Thanks for helping! ShowTime is intentionally small and dependency-light, so contributions that keep it that way are the easiest to merge.

## Getting started

```bash
git clone https://github.com/248Tech/ShowTime.git && cd ShowTime
npm install
npm start          # http://127.0.0.1:8080 (first signup becomes admin)
npm test           # needs Node 22.13+ and FFmpeg (libx264, libvpx-vp9, libsvtav1, libx265, libopus)
npm run demo       # static live demo at http://localhost:4173/ShowTime/demo/
```

## Ground rules

- **No new runtime dependencies** without a strong reason. No front-end frameworks or build step - the SPA is plain ES modules.
- **Privacy is a feature.** Never add anything that reveals a user's identity, avatar, online status or activity to someone who isn't their accepted friend. Route names through `lib/social.js` (`viewOf` / `nameFor`).
- **One access-control path.** Anything that serves a file must use the helpers in `lib/db.js`; there are no public links.
- **Never log or persist chat content.** Chat data lives in RAM only (see `lib/chat.js`).
- **Render with the `h()` helper or `textContent`**, never `innerHTML` with data (the CSP forbids inline script and we want to keep it that way).
- Outbound requests made on behalf of users must go through the SSRF-guarded `upstream()` in `lib/iptv.js`.

## Pull requests

1. Open an issue first for anything big.
2. Add or update tests - every suite in `test/` is a real end-to-end check, so a regression test is usually a few lines.
3. Run `npm test` and make sure it passes.
4. If you changed the UI, run `npm run demo` and check the demo still works; the mock backend lives in `demo-src/mock.js`.
5. Update `CHANGELOG.md` under *Unreleased*.

## Reporting bugs & security issues

- Bugs and ideas: [open an issue](https://github.com/248Tech/ShowTime/issues/new/choose).
- **Security problems: do not open a public issue** - follow [SECURITY.md](SECURITY.md).
