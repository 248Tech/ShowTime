# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
