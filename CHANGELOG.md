# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-13

### Added
- **Auto-metadata on upload (Plex-style):** poster, synopsis, genres, score, cast & crew and the full season / episode guide are fetched in the background as soon as a file is imported (and for your existing library on boot). Placeholder titles like "Episode 3" are replaced with the real episode name. Keyless movie posters/synopsis via the iTunes Search API; movie cast photos with an optional TMDB key.
- **Redesigned library & details:** poster grid with score badges, TV episodes grouped into show cards, a hero details view (poster, facts, synopsis), season tabs and an episode list with stills, air date, runtime and summary, and the episode's own info on its details page.
- **Cast & crew:** Plex-style floating headshots, summary, genres and score in show, movie and free-movie details (TVMaze for TV, TMDB for movies with an optional free key). Only the title is sent upstream; photos are cached and relayed by the server through a host-allow-listed image proxy. Admins can switch lookups off.
- **Global ratings:** 1-5 stars shared across the whole server, keyed by title (not file owner); only the average and count are public, never who voted. Shown on cards, details and in the room.
- **DVR:** record any live channel now or scheduled (up to 4 h, 2 at once, 10 pending per user). ffmpeg reads through a key-protected loopback relay in front of the SSRF-guarded proxy; the result is remuxed to MP4 and saved into the owner's encrypted library.
- **Free movies:** public-domain / Creative-Commons feature films from the Internet Archive, relayed with Range support so seeking works.
- **Send to device:** per-account device list (never visible to anyone else) and one-tap send of a room to another signed-in device.
- **Live TV:** prefetch/buffer system for smoother playback; change-channel, previous-channel and channel-picker controls.
- Test suite `features` (metadata, ratings, free movies, devices, DVR).

## [0.1.0] - 2026-11-13

First public release (beta).

### Added
- **Watch parties:** synchronized play/pause/seek/stop/queue/skip over server-sent events; per-room host permissions (play, seek, skip, queue); invite popups; theater mode and picture-fit options.
- **Local-file streaming:** play a file from the host's computer to the room peer-to-peer over WebRTC - nothing is uploaded; live subtitles over the data channel; viewer seek bar when the host allows it.
- **Encrypted library:** chunked AES-256-GCM at rest with per-file HKDF keys; read-only local library folders; automatic movie/TV detection and sorting; subtitles (embedded, sidecar, uploaded) stored as encrypted WebVTT.
- **Smart codecs:** quick scan with trial encodes, a tested decision function, background AV1 / VP9 / H.264 encoding, per-viewer rendition choice via `MediaCapabilities` with live switching and automatic fallback. AV2 is a ready slot (no FFmpeg/browser support yet).
- **Privacy:** invisible-by-default social model - friend codes, anonymous requests with an optional note, aliases for strangers, friends-only presence, opt-in activity sharing, blocks; encrypted profile pictures.
- **Encrypted chat:** mIRC-style, end-to-end (PBKDF2 + AES-256-GCM), RAM-only server, nicknames inside the ciphertext, scheduled 48-hour wipe that zero-fills memory.
- **Live TV:** import of the iptv-org community index (~11k channels), health checks including frozen-feed detection, SSRF-guarded HLS proxy with signed links and provider-session self-healing, hls.js with retry/recovery and a stall watchdog.
- **Profiles & achievements:** server-side watch-time tracking, recently watched, media variety, 30 badges across five groups, levels.
- **Accounts & security:** scrypt, HttpOnly SameSite sessions, CSRF protection, strict CSP, rate limiting, invite-only signup, password reset by email, upload signature checks, FFmpeg protocol whitelisting.
- **Live demo & site:** GitHub Pages site and a fully in-browser demo of the real front-end.
- **Tests:** six automated suites (SSRF, codec decisions, achievements, IPTV healing, API/privacy/crypto/codecs, encrypted chat).

[0.1.0]: https://github.com/248Tech/ShowTime/releases/tag/v0.1.0
