// Profile pictures: re-encoded server-side to a clean 256x256 JPEG (strips EXIF/GPS, neutralises polyglot files),
// then stored encrypted. Only the owner and their accepted friends can fetch them.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { config } from './config.js';
import { spawnBuf, ffmpegAvailable } from './media.js';
import { encryptBuffer } from './vault.js';
import { run, now } from './db.js';

export const avatarPath = (id) => path.join(config.dataDir, 'vault', `avatar.${id}.enc`);
export const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

const sniff = (b) =>
  (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') || (b[0] === 0xff && b[1] === 0xd8) || b.toString('latin1', 0, 4) === 'GIF8' ||
  (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');

export async function setAvatar(userId, buf) {
  if (buf.length < 16 || !sniff(buf)) throw new Error('Use a PNG, JPEG, GIF or WebP image');
  if (!(await ffmpegAvailable())) throw new Error('ffmpeg is required to process profile pictures');
  const jpg = await spawnBuf(config.ffmpeg, ['-v', 'error', '-protocol_whitelist', 'pipe', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1',
    '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=256:256", '-map_metadata', '-1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'], buf, 20000).catch(() => null);
  if (!jpg || jpg.length < 100) throw new Error('That image could not be read');
  await encryptBuffer(jpg, avatarPath(userId));
  run('UPDATE users SET avatar_v=? WHERE id=?', now(), userId);
}

export async function clearAvatar(userId) {
  await fsp.rm(avatarPath(userId), { force: true });
  run('UPDATE users SET avatar_v=NULL WHERE id=?', userId);
}
