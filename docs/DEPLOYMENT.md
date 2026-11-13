# Deployment guide

ShowTime is a single Node.js process. This page covers running it for friends, safely.

> **Register your admin account first**, before exposing the server to any network. Whoever registers first becomes the admin; after that signup is invite-only.

## 1. Choose how people reach it

| Setup | Good for | Notes |
|---|---|---|
| `localhost` only (default) | Trying it out, solo use | Everything works, including chat and peer-to-peer streaming. |
| LAN (`HOST=0.0.0.0`) | Household | Plain `http://192.168.x.x` is **not a secure context**, so the browser disables WebCrypto (chat) and some WebRTC features. Use HTTPS (below) even on a LAN for the full feature set. |
| Tunnel (Tailscale Funnel / Cloudflare Tunnel) | Friends anywhere, no port-forwarding | Easiest: gives you HTTPS automatically. |
| Reverse proxy (Caddy / nginx) on a domain | Permanent public instance | You manage DNS and TLS. |

Whichever you pick behind a proxy/tunnel, set in `.env`:

```ini
PUBLIC_URL=https://your.public.address     # used in password-reset emails
TRUST_PROXY=1                              # trust X-Forwarded-For / X-Forwarded-Proto (rate limits + Secure cookies)
```

`TRUST_PROXY=1` must only be set when ShowTime is *actually* behind a proxy you control, otherwise clients could spoof their IP.

## 2. Recipes

### Tailscale Funnel

```bash
npm start                      # in one terminal (HOST stays 127.0.0.1)
tailscale funnel --bg 8080     # publishes https://<machine>.<tailnet>.ts.net
tailscale funnel status        # shows the URL
tailscale funnel reset         # turn it off
```

Funnel must be enabled for your tailnet (admin console → Access controls). It is only reachable while your computer is awake and running ShowTime.

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:8080      # quick, temporary https://*.trycloudflare.com URL
```

For a permanent hostname, create a named tunnel in the Cloudflare dashboard and point it at `http://localhost:8080`.

### Caddy

```caddyfile
show.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy obtains and renews certificates automatically and passes streaming/SSE correctly.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name show.example.com;
  # ssl_certificate / ssl_certificate_key ...

  client_max_body_size 0;               # large uploads (ShowTime enforces MAX_UPLOAD_GB itself)
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;                 # server-sent events + video streaming
    proxy_request_buffering off;         # stream uploads straight through
    proxy_read_timeout 1h;
  }
}
```

### Direct HTTPS (no proxy)

Set `TLS_CERT` and `TLS_KEY` to your certificate/key paths and ShowTime serves HTTPS itself.

## 3. Run it as a service

**Linux (systemd)** — `/etc/systemd/system/showtime.service`:

```ini
[Unit]
Description=ShowTime
After=network.target

[Service]
WorkingDirectory=/opt/ShowTime
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=showtime
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/ShowTime/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now showtime
```

**Windows** — easiest is [NSSM](https://nssm.cc/) (`nssm install ShowTime "C:\Program Files\nodejs\node.exe" server.js`, set the startup directory) or a Task Scheduler task that runs `node server.js` at logon.

**macOS** — a `launchd` agent running `node server.js`, or `pm2 start server.js --name showtime && pm2 save`.

## 4. Back up & update

- **Back up the whole `data/` directory** (`showtime.db`, `vault/`, `master.key`). Uploaded files are encrypted with keys derived from `master.key`; **without it they cannot be recovered.** Keep a copy somewhere separate from the data.
- Update: `git pull && npm install` then restart. Database migrations run automatically on start.

## 5. Peer-to-peer streaming behind strict NATs

"Stream local file" sends video directly from the host's browser to viewers (WebRTC). Most home networks work with the default STUN server. If viewers can't connect, add a TURN relay:

```ini
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]
```

## 6. Hardening checklist

- [ ] Admin account registered; `openSignup` left **off** (invite-only).
- [ ] Served over HTTPS; `PUBLIC_URL` and `TRUST_PROXY` set correctly.
- [ ] `data/` backed up (including `master.key`) and not world-readable.
- [ ] SMTP configured, or you know reset links are printed to the console.
- [ ] Server kept on a supported Node.js version and updated regularly.
- [ ] Only share media you have the right to share (see the [responsible-use note](../README.md#%EF%B8%8F-responsible-use)).
