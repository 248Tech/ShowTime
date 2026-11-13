// Unit tests for the codec decision logic (pure functions; no ffmpeg needed).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-codec-'));
process.env.DATA_DIR = dir;
process.env.SHOWTIME_MASTER_KEY = 'ef'.repeat(32);
const { initVault } = await import('../lib/vault.js'); initVault();
const E = await import('../lib/encode.js');

const T = (secs, bps, extra = {}) => ({ ok: true, projectedSecs: secs, projectedBps: bps, tag: 'x', variant: 'x', ...extra });
const base = { dur: 600, budgetX: 2, tenBit: false, hdr: false, existing: [] };
const ok = (name, fn) => { fn(); console.log('  ok -', name); };

ok('playable H.264, big bitrate: AV1 wins when it is smallest and fits the budget', () => {
  const d = E.decide({ ...base, origPlayable: true, srcCodec: 'h264', videoBps: 8_000_000, trials: { h264: T(60, 8e6), vp9: T(900, 4.5e6), av1: T(1000, 3.2e6) } });
  assert.equal(d.stageA, null); assert.equal(d.stageB, 'av1');
});
ok('prefers VP9 when AV1 is too slow on this machine', () => {
  const d = E.decide({ ...base, origPlayable: true, srcCodec: 'h264', videoBps: 8_000_000, trials: { vp9: T(900, 4.5e6), av1: T(5000, 3.2e6) } });
  assert.equal(d.stageB, 'vp9'); assert.ok(d.reasons.some((r) => /AV1: too slow/.test(r)));
});
ok('skips re-encoding when savings are under 15%', () => {
  const d = E.decide({ ...base, origPlayable: true, srcCodec: 'h264', videoBps: 2_000_000, trials: { vp9: T(300, 1.9e6), av1: T(300, 1.8e6) } });
  assert.equal(d.stageB, null); assert.ok(d.reasons.some((r) => /saves only/.test(r)));
});
ok('already-AV1 source is not re-encoded to AV1; VP9 must still beat it by 15%', () => {
  const d = E.decide({ ...base, origPlayable: true, srcCodec: 'av1', videoBps: 3_000_000, trials: { av1: T(300, 2.9e6), vp9: T(300, 3.5e6) } });
  assert.equal(d.stageB, null);
});
ok('un-playable HEVC: H.264 first for compatibility, then AV1 judged against the H.264 baseline', () => {
  const d = E.decide({ ...base, origPlayable: false, srcCodec: 'hevc', videoBps: 6_000_000, trials: { h264: T(100, 9e6), vp9: T(800, 5.5e6), av1: T(900, 4e6) } });
  assert.equal(d.stageA, 'h264'); assert.equal(d.stageB, 'av1');
});
ok('un-playable and nothing fits the budget: still makes it watchable with the fastest encoder', () => {
  const d = E.decide({ ...base, origPlayable: false, srcCodec: 'hevc', videoBps: 6e6, trials: { h264: T(5000, 9e6), vp9: T(9000, 5e6), av1: T(20000, 4e6) } });
  assert.equal(d.stageA, 'h264'); assert.equal(d.stageB, null);
});
ok('un-playable and no working encoder: no plan, with an explanation', () => {
  const d = E.decide({ ...base, origPlayable: false, srcCodec: 'hevc', videoBps: 6e6, trials: { h264: { ok: false, err: 'boom' } } });
  assert.equal(d.stageA, null); assert.ok(d.reasons.some((r) => /no working encoder/.test(r)));
});
ok('HDR sources skip the efficiency re-encode', () => {
  const d = E.decide({ ...base, hdr: true, origPlayable: true, srcCodec: 'hevc', videoBps: 9e6, trials: { av1: T(100, 2e6) } });
  assert.equal(d.stageB, null);
});
ok('existing renditions are respected (no duplicate AV1) and set the bar to beat', () => {
  const d = E.decide({ ...base, origPlayable: true, srcCodec: 'h264', videoBps: 8e6, existing: [{ codec: 'av1', bitrate: 3e6 }], trials: { av1: T(100, 2.9e6), vp9: T(100, 3.4e6) } });
  assert.equal(d.stageB, null, 'VP9 at 3.4M does not beat the existing 3.0M AV1 by 15%');
});
ok('failed trials are explained, not fatal', () => {
  const d = E.decide({ ...base, origPlayable: true, srcCodec: 'h264', videoBps: 8e6, trials: { av1: { ok: false, err: 'no such encoder' }, vp9: T(100, 4e6) } });
  assert.equal(d.stageB, 'vp9'); assert.ok(d.reasons.some((r) => /AV1: trial failed/.test(r)));
});
ok('10-bit sources never get H.264 variants; AV1/VP9 keep 10-bit', () => {
  const v = E.variantsFor({ tenBit: true });
  assert.ok(!v.some((x) => x.codec === 'h264')); assert.ok(v.filter((x) => x.encoder === 'libsvtav1').every((x) => x.args.includes('yuv420p10le')));
});
ok('AV2 slot stays inactive until an encoder is configured', () => {
  assert.ok(!E.variantsFor({}).some((x) => x.codec === 'av2'));
  assert.equal(E.CODECS.av2.experimental, true);
});
ok('describe() reads bitrate, 10-bit, HDR and colour tags from ffprobe output', () => {
  const info = E.describe({ format: { duration: '100', bit_rate: '5000000' }, streams: [{ codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, avg_frame_rate: '24000/1001', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' }, { codec_type: 'audio', codec_name: 'ac3', channels: 6, bit_rate: '384000' }] });
  assert.equal(info.tenBit, true); assert.equal(info.hdr, true); assert.equal(Math.round(info.fps * 1000) / 1000, 23.976); assert.equal(info.videoBps, 5_000_000 - 384_000);
  assert.deepEqual(info.color, ['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084']);
});

console.log('CODEC OK');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite lock on Windows */ }
process.exit(0);
