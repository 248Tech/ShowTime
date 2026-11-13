# Security Policy

ShowTime is designed to be exposed to people you don't know, so security reports are taken seriously.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability

**Please do not open a public issue.** Report privately using GitHub's
[private vulnerability reporting](https://github.com/248Tech/ShowTime/security/advisories/new)
("Security" tab → "Report a vulnerability").

Include what you found, how to reproduce it, and the impact you expect. You can expect an acknowledgement within a few days and a fix or mitigation plan as soon as practical. Good-faith research that avoids harming other people's data or instances is welcome, and reporters will be credited unless they prefer otherwise.

## What's in scope

- Authentication, sessions, CSRF, rate limiting and password reset
- Access control (reading another user's media, thumbnails, subtitles, avatars, profile)
- **The privacy model** - anything that reveals a user's identity, avatar, online status or activity to someone who is not their friend
- The live-TV proxy (SSRF, request smuggling, open redirects, size limits)
- Upload handling and the FFmpeg invocation surface
- The encrypted chat (anything that makes the server learn plaintext, nicknames or keys, or persist chat data)
- Encryption at rest (`lib/vault.js`)
- XSS / CSP bypasses in the front-end

## Out of scope

- Findings that need a malicious *admin* (the admin runs the server)
- Denial of service by an authenticated admin, or by volumetric network floods
- Content served by third-party IPTV providers
- Chat limitations that are documented (anyone with a channel passphrase can read it; screenshots; a compromised device)
- Missing hardening on a server exposed over plain HTTP against the [deployment guide](docs/DEPLOYMENT.md)

## Operating ShowTime safely

See the [hardening checklist](docs/DEPLOYMENT.md#6-hardening-checklist). In short: register your admin account first, keep signup invite-only, serve over HTTPS, back up `data/` (including `master.key`), and keep Node.js updated.
