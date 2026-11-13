// End-to-end chat crypto (WebCrypto only - runs in browsers and in Node for tests).
// passphrase --PBKDF2-SHA256(600k, salt||channel)--> 512 bits = [32B AES-256-GCM key | 32B verifier seed]
// The server only ever receives SHA-256(verifier seed): it cannot derive the key from it.
const enc = new TextEncoder();
const dec = new TextDecoder();
export const ITERATIONS = 600000;
export const MAX_PLAINTEXT = 1700; // bytes, keeps ciphertext under the server's 2 KiB cap

export const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const randomSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));

export async function deriveChannel(name, passphrase, saltB64) {
  const salt = unb64(saltB64);
  const mixed = new Uint8Array(salt.length + name.length);
  mixed.set(salt); mixed.set(enc.encode(name), salt.length);
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: mixed, iterations: ITERATIONS }, base, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']); // non-extractable
  const verifier = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', bits.slice(32))));
  bits.fill(0);
  return { key, verifier };
}

/** Encrypt a small JSON object. Plaintext is padded to a size bucket so length reveals little. Channel name is bound as AAD. */
export async function seal(key, chan, obj) {
  const raw = enc.encode(JSON.stringify(obj));
  if (raw.length > MAX_PLAINTEXT) throw new Error('Message too long');
  const bucket = [128, 256, 512, 1024, 1700].find((n) => raw.length <= n);
  const padded = new Uint8Array(bucket).fill(0x20); // trailing spaces are valid JSON whitespace
  padded.set(raw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(chan) }, key, padded));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function open(key, chan, ivB64, ctB64) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64), additionalData: enc.encode(chan) }, key, unb64(ctB64));
    return JSON.parse(dec.decode(pt));
  } catch { return null; } // wrong key / tampered / other channel
}
