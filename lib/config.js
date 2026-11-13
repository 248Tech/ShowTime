import path from 'node:path';
import fs from 'node:fs';

try { process.loadEnvFile(path.resolve('.env')); } catch { /* no .env */ }

const e = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(+v) ? +v : d);

export const config = {
  port: num(e.PORT, 8080),
  host: e.HOST || '127.0.0.1', // set HOST=0.0.0.0 to serve your LAN
  dataDir: path.resolve(e.DATA_DIR || './data'),
  mediaDirs: (e.MEDIA_DIRS || '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p)),
  publicUrl: (e.PUBLIC_URL || '').replace(/\/+$/, ''),
  tls: e.TLS_CERT && e.TLS_KEY ? { cert: fs.readFileSync(e.TLS_CERT), key: fs.readFileSync(e.TLS_KEY) } : null,
  trustProxy: e.TRUST_PROXY === '1',
  cookieSecure: e.COOKIE_SECURE === '1',
  maxUploadBytes: num(e.MAX_UPLOAD_GB, 50) * 1e9,
  ffmpeg: e.FFMPEG || 'ffmpeg',
  ffprobe: e.FFPROBE || 'ffprobe',
  smtp: e.SMTP_HOST
    ? {
        host: e.SMTP_HOST,
        port: num(e.SMTP_PORT, 587),
        secure: e.SMTP_SECURE === '1',
        auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS || '' } : undefined,
        from: e.SMTP_FROM || e.SMTP_USER,
      }
    : null,
  // WebRTC for "stream local file". Add a TURN server here for peers behind strict NAT:
  // ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:host:3478","username":"u","credential":"p"}]'
  iceServers: (() => { try { return JSON.parse(e.ICE_SERVERS); } catch { return [{ urls: 'stun:stun.l.google.com:19302' }]; } })(),
  encodeAuto: e.ENCODE_AUTO !== '0', // scan new uploads and encode AV1/VP9/H.264 renditions in the background (admin can toggle)
  encodeBudgetX: num(e.ENCODE_BUDGET_X, 2), // an encode may take at most this many times the video's runtime on this machine
  iptvAuto: e.IPTV_AUTO !== '0', // import the free-channel index on first start + refresh daily
  sessionDays: 14,
};
