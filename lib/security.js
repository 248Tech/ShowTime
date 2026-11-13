import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from './config.js';

const scrypt = (pw, salt, len, opts) => new Promise((res, rej) => crypto.scrypt(pw, salt, len, opts, (e, k) => (e ? rej(e) : res(k))));
const P = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, 64, P)).toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [, s, h] = stored.split('$');
  const k = await scrypt(pw, Buffer.from(s, 'base64'), 64, P);
  const hb = Buffer.from(h, 'base64');
  return hb.length === k.length && crypto.timingSafeEqual(hb, k);
}
export const DUMMY_HASH = hashPassword('dummy-password-for-timing'); // equalise timing for unknown users

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const token = (n = 32) => crypto.randomBytes(n).toString('base64url');

// simple in-memory fixed-window limiter
const buckets = new Map();
export function limited(key, max, windowMs) {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < t) return false;
  return b.n >= max;
}
export function hit(key, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) buckets.set(key, (b = { n: 0, reset: t + windowMs }));
  b.n++;
}
export const clearHits = (key) => buckets.delete(key);
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

export const passwordProblem = (pw) =>
  typeof pw !== 'string' || pw.length < 10 ? 'Password must be at least 10 characters' : pw.length > 200 ? 'Password too long' : null;

// ---- mail ----
const transport = config.smtp ? nodemailer.createTransport(config.smtp) : null;
export const mailEnabled = !!transport;
export async function sendMail(to, subject, text) {
  if (!transport) {
    console.log(`\n[mail disabled - set SMTP_HOST] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }
  await transport.sendMail({ from: config.smtp.from, to, subject, text });
}
