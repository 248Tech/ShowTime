// Encrypted-at-rest blob store.
// AES-256-GCM, chunked (256 KiB) so HTTP Range / seeking works without decrypting the whole file.
// Per-file key = HKDF-SHA256(masterKey, randomSalt). Each chunk is authenticated; header is AAD;
// final chunk is flagged in the nonce so truncation / reordering is detected.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

const MAGIC = Buffer.from('STV1');
const CHUNK = 262144;
const TAG = 16;
const HDR = 40; // magic(4) + salt(32) + chunkSize(4)

let master;
export function initVault() {
  if (process.env.SHOWTIME_MASTER_KEY) {
    master = Buffer.from(process.env.SHOWTIME_MASTER_KEY, 'hex');
    if (master.length !== 32) throw new Error('SHOWTIME_MASTER_KEY must be 64 hex chars');
    return;
  }
  const f = path.join(config.dataDir, 'master.key');
  if (fs.existsSync(f)) master = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  else {
    master = crypto.randomBytes(32);
    fs.writeFileSync(f, master.toString('hex'), { mode: 0o600 });
    console.log(`[vault] generated master key at ${f} - BACK IT UP, files are unrecoverable without it`);
  }
  if (master.length !== 32) throw new Error('master.key corrupt');
}

const fileKey = (salt) => Buffer.from(crypto.hkdfSync('sha256', master, salt, 'showtime-file-v1', 32));
const nonce = (i, last) => {
  const n = Buffer.alloc(12);
  n[0] = last ? 1 : 0;
  n.writeBigUInt64BE(BigInt(i), 4);
  return n;
};

export const plainSize = (encSize) => {
  const t = encSize - HDR;
  const full = CHUNK + TAG;
  const n = Math.floor(t / full);
  const rem = t % full;
  return n * CHUNK + (rem ? rem - TAG : 0);
};

/** Encrypt a readable into destPath. Returns plaintext byte count. Rejects empty / oversize input. */
export async function encryptStream(readable, destPath, maxBytes = Infinity) {
  const salt = crypto.randomBytes(32);
  const hdr = Buffer.alloc(HDR);
  MAGIC.copy(hdr, 0);
  salt.copy(hdr, 4);
  hdr.writeUInt32BE(CHUNK, 36);
  const key = fileKey(salt);
  let idx = 0;
  let total = 0;
  const seal = (plain, last) => {
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce(idx++, last));
    c.setAAD(hdr);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  const part = destPath + '.part';
  try {
    await pipeline(
      readable,
      async function* (src) {
        yield hdr;
        let pending = Buffer.alloc(0);
        for await (const d of src) {
          total += d.length;
          if (total > maxBytes) throw new Error('file too large');
          pending = pending.length ? Buffer.concat([pending, d]) : d;
          while (pending.length > CHUNK) {
            yield seal(pending.subarray(0, CHUNK), false);
            pending = pending.subarray(CHUNK);
          }
        }
        if (!pending.length) throw new Error('empty file');
        yield seal(pending, true);
      },
      fs.createWriteStream(part, { mode: 0o600 }),
    );
    await fsp.rename(part, destPath);
    return total;
  } catch (e) {
    await fsp.rm(part, { force: true });
    throw e;
  }
}

export const encryptBuffer = (buf, dest) => encryptStream(Readable.from([buf]), dest);

/** Stream plaintext bytes [start,end] (inclusive) from an encrypted blob. */
export function openRange(p, start, end) {
  async function* gen() {
    const fh = await fsp.open(p, 'r');
    try {
      const st = await fh.stat();
      const hdr = Buffer.alloc(HDR);
      await fh.read(hdr, 0, HDR, 0);
      if (!hdr.subarray(0, 4).equals(MAGIC)) throw new Error('not a vault file');
      const chunk = hdr.readUInt32BE(36);
      const key = fileKey(hdr.subarray(4, 36));
      const full = chunk + TAG;
      const nChunks = Math.ceil((st.size - HDR) / full);
      for (let i = Math.floor(start / chunk); i <= Math.floor(end / chunk); i++) {
        const off = HDR + i * full;
        const len = Math.min(full, st.size - off);
        const b = Buffer.alloc(len);
        await fh.read(b, 0, len, off);
        const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(i, i === nChunks - 1));
        d.setAAD(hdr);
        d.setAuthTag(b.subarray(len - TAG));
        const plain = Buffer.concat([d.update(b.subarray(0, len - TAG)), d.final()]);
        const cs = i * chunk;
        yield plain.subarray(Math.max(start - cs, 0), Math.min(end - cs + 1, plain.length));
      }
    } finally {
      await fh.close();
    }
  }
  return Readable.from(gen(), { objectMode: false });
}

export async function readBuffer(p) {
  const size = plainSize((await fsp.stat(p)).size);
  const chunks = [];
  for await (const c of openRange(p, 0, size - 1)) chunks.push(c);
  return Buffer.concat(chunks);
}

/** Derive a purpose-specific key from the master key (e.g. for signing proxy tokens). */
export const subkey = (label) => Buffer.from(crypto.hkdfSync('sha256', master, '', `showtime-${label}`, 32));
