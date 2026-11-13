// Codec scan + background encoding.
//
// On upload (and at startup for items never scanned) we run a QUICK SCAN: probe the file, then do a few-second trial encode per
// candidate codec on THIS machine (AV1 / VP9 / H.264) to measure real encode speed and real output size. A pure decision function
// (decide()) then picks what is worth producing:
//   Stage A  make it watchable      - only if the original isn't browser-playable: H.264 first (fast, plays everywhere)
//   Stage B  make it efficient      - AV1 or VP9, whichever projects smallest, if it saves >= 15% and fits the time budget
// The player then picks the best available version PER VIEWER at playback time (hardware decode > smooth software decode > smaller),
// and viewers can override or switch between AV1 / VP9 / H.264 live.
//
// AV2: the spec exists (2026) but FFmpeg has no AV2 encoder/decoder and no browser decodes it yet, so it is registered here as an
// inactive slot. Set AV2_ENCODER=<ffmpeg encoder name> once one exists; it is only ever served to browsers that report AV2 decode support.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { get, all, run, now, setting, audit } from './db.js';
import * as M from './media.js';
import { encryptStream } from './vault.js';

export const SAVINGS_REQUIRED = 0.85; // an efficiency rendition must be <= 85% of the best existing one
const av2Encoder = process.env.AV2_ENCODER || '';

export const CODECS = {
  av1: { label: 'AV1', container: 'mp4', note: 'Best compression; software decode is fine on modern CPUs, hardware decode on newer GPUs.' },
  vp9: { label: 'VP9', container: 'webm', note: 'Very widely decodable; ~35% smaller than H.264.' },
  h264: { label: 'H.264', container: 'mp4', note: 'Plays everywhere; the compatibility baseline.' },
  av2: { label: 'AV2', container: 'mp4', note: 'Spec released 2026, but FFmpeg and browsers have no AV2 support yet - slot is ready for when they do.', experimental: true },
};

// ---------- encoder variants, best compression first within each codec ----------
export function variantsFor(o = {}) {
  const pf = ['-pix_fmt', o.tenBit ? 'yuv420p10le' : 'yuv420p'];
  const V = (codec, encoder, tag, args) => ({ codec, encoder, tag, args });
  const list = [
    V('av1', 'libsvtav1', 'SVT-AV1 p8', ['-c:v', 'libsvtav1', '-preset', '8', '-crf', '34', '-g', '240', ...pf]),
    V('av1', 'libsvtav1', 'SVT-AV1 p12 (fast)', ['-c:v', 'libsvtav1', '-preset', '12', '-crf', '36', '-g', '240', ...pf]),
    V('av1', 'av1_nvenc', 'NVENC AV1', ['-c:v', 'av1_nvenc', '-preset', 'p5', '-cq', '34', '-b:v', '0', ...pf]),
    V('av1', 'av1_qsv', 'QuickSync AV1', ['-c:v', 'av1_qsv', '-global_quality', '34', '-preset', 'medium']),
    V('av1', 'av1_amf', 'AMF AV1', ['-c:v', 'av1_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '34', '-qp_p', '36']),
    V('av1', 'libaom-av1', 'libaom cpu-used 6', ['-c:v', 'libaom-av1', '-crf', '32', '-b:v', '0', '-cpu-used', '6', '-row-mt', '1', ...pf]),
    V('vp9', 'libvpx-vp9', 'libvpx-vp9 cpu-used 4', ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-tile-columns', '2', ...pf]),
    V('vp9', 'libvpx-vp9', 'libvpx-vp9 cpu-used 7 (fast)', ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-deadline', 'good', '-cpu-used', '7', '-row-mt', '1', '-tile-columns', '2', ...pf]),
    V('vp9', 'vp9_qsv', 'QuickSync VP9', ['-c:v', 'vp9_qsv', '-global_quality', '32']),
  ];
  if (!o.tenBit) { // 10-bit H.264 is poorly supported by browsers - only offer H.264 for 8-bit sources
    list.push(
      V('h264', 'libx264', 'x264 fast', ['-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p']),
      V('h264', 'h264_nvenc', 'NVENC H.264', ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '24', '-b:v', '0', '-pix_fmt', 'yuv420p']),
      V('h264', 'h264_qsv', 'QuickSync H.264', ['-c:v', 'h264_qsv', '-global_quality', '24', '-preset', 'medium']),
      V('h264', 'h264_amf', 'AMF H.264', ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '26']),
    );
  }
  if (av2Encoder) list.push(V('av2', av2Encoder, `${av2Encoder} (experimental)`, ['-c:v', av2Encoder, '-crf', '35', ...pf]));
  return list;
}

let encSet = null;
export async function availableEncoders() {
  if (!encSet) {
    const out = await M.spawnBuf(config.ffmpeg, ['-hide_banner', '-encoders'], null, 15000).catch(() => Buffer.alloc(0));
    encSet = new Set([...out.toString().matchAll(/^\s*V[\w.]*\s+(\S+)/gm)].map((m) => m[1]));
  }
  return encSet;
}
export async function codecCapabilities() {
  const have = await availableEncoders();
  return Object.entries(CODECS).map(([id, c]) => {
    const encoders = [...new Set(variantsFor({}).filter((v) => v.codec === id && have.has(v.encoder)).map((v) => v.encoder))];
    return { id, label: c.label, encoders, available: encoders.length > 0, note: c.note, experimental: !!c.experimental };
  });
}

// ---------- source description ----------
export function describe(pr, fallbackSize) {
  const v = pr.streams.find((x) => x.codec_type === 'video');
  const a = pr.streams.find((x) => x.codec_type === 'audio');
  const dur = +pr.format?.duration || 0;
  const [n, d] = String(v.avg_frame_rate || '0/1').split('/').map(Number);
  const totalBps = +pr.format?.bit_rate || (dur ? ((+pr.format?.size || fallbackSize || 0) * 8) / dur : 0);
  const audioBps = +a?.bit_rate || (a ? 160000 : 0);
  return {
    vcodec: v.codec_name, acodec: a?.codec_name || null, channels: a?.channels || 0, width: v.width, height: v.height,
    fps: d ? n / d : 0, dur, videoBps: +v.bit_rate || Math.max(0, totalBps - audioBps),
    tenBit: /10|12/.test(v.pix_fmt || ''), hdr: /smpte2084|arib-std-b67/.test(v.color_transfer || ''),
    color: [['-colorspace', v.color_space], ['-color_primaries', v.color_primaries], ['-color_trc', v.color_transfer]].filter(([, x]) => x && x !== 'unknown').flat(),
  };
}

// ---------- trial encode: real speed + real size for a few seconds of the file ----------
async function trial(src, info, variant) {
  const sample = Math.min(4, Math.max(1.5, info.dur * 0.02));
  const start = info.dur > 30 ? info.dur * 0.4 : 0;
  const t0 = Date.now();
  try {
    const out = await M.spawnBuf(config.ffmpeg, ['-v', 'error', '-nostdin', ...M.wl(src), '-ss', String(start), '-t', String(sample), '-i', src, '-map', '0:v:0', '-an', ...variant.args, ...info.color, '-f', 'matroska', 'pipe:1'], null, 30000);
    const wall = Math.max(0.05, (Date.now() - t0) / 1000);
    if (out.length < 200) return { ok: false, err: 'no output' };
    const speedX = sample / wall;
    return { ok: true, tag: variant.tag, encoder: variant.encoder, speedX: +speedX.toFixed(2), projectedSecs: Math.round(info.dur / speedX), projectedBps: Math.round((out.length * 8) / sample) };
  } catch (e) { return { ok: false, tag: variant.tag, encoder: variant.encoder, err: String(e.message).slice(0, 120) }; }
}

export async function scan(src, info, budgetX = config.encodeBudgetX) {
  const have = await availableEncoders();
  const all_ = variantsFor(info).filter((v) => have.has(v.encoder));
  const budget = budgetX * info.dur;
  const trials = {};
  for (const codec of ['h264', 'vp9', 'av1', 'av2']) {
    const attempts = [];
    for (const v of all_.filter((x) => x.codec === codec)) {
      const t = await trial(src, info, v);
      attempts.push(t);
      if (t.ok && t.projectedSecs <= budget) break; // best-compressing variant that fits the budget wins; otherwise try a faster one
    }
    if (!attempts.length) continue;
    const ok = attempts.filter((a) => a.ok);
    trials[codec] = ok.length
      ? { ...ok.filter((a) => a.projectedSecs <= budget).sort((a, b) => a.projectedBps - b.projectedBps)[0] || ok.sort((a, b) => a.projectedSecs - b.projectedSecs)[0], tried: attempts.length }
      : { ok: false, err: attempts[attempts.length - 1].err, tried: attempts.length };
    if (trials[codec].ok) trials[codec].variant = trials[codec].tag; // tag identifies the variant to re-use when encoding for real
  }
  return trials;
}

// ---------- the decision (pure; unit-tested) ----------
export function decide({ origPlayable, srcCodec, dur, videoBps, trials, existing = [], budgetX = config.encodeBudgetX, tenBit = false, hdr = false }) {
  const reasons = [];
  const fits = (c) => trials[c]?.ok && trials[c].projectedSecs <= budgetX * dur;
  let stageA = null, stageB = null;
  let baseline = origPlayable ? videoBps || null : null;
  for (const e of existing) if (e.bitrate && (!baseline || e.bitrate < baseline)) baseline = e.bitrate;
  const have = new Set(existing.map((e) => e.codec).concat(origPlayable ? [srcCodec] : []));

  if (!origPlayable && !have.size) {
    const order = ['h264', 'vp9', 'av1'];
    stageA = order.find((c) => fits(c)) || null;
    if (stageA) reasons.push(`Original (${srcCodec}) can't play in browsers -> ${CODECS[stageA].label} first (fits the time budget).`);
    else {
      const fastest = order.filter((c) => trials[c]?.ok).sort((a, b) => trials[a].projectedSecs - trials[b].projectedSecs)[0];
      if (fastest) { stageA = fastest; reasons.push(`Original can't play in browsers and nothing fits the time budget; using the fastest option (${CODECS[fastest].label}).`); }
      else reasons.push('Original can\'t play in browsers and no working encoder was found.');
    }
    if (stageA) baseline = trials[stageA].projectedBps;
  } else if (origPlayable) reasons.push(`Original (${srcCodec}) already plays in browsers.`);

  if (hdr) reasons.push('HDR source: efficiency re-encode skipped to avoid washed-out colours.');
  else if (!baseline) reasons.push('No baseline to compare against.');
  else {
    const cands = ['av1', 'vp9', 'av2'].filter((c) => c !== stageA && !have.has(c) && fits(c) && trials[c].projectedBps <= SAVINGS_REQUIRED * baseline);
    cands.sort((a, b) => trials[a].projectedBps - trials[b].projectedBps || trials[a].projectedSecs - trials[b].projectedSecs);
    stageB = cands[0] || null;
    for (const c of ['av1', 'vp9']) {
      const t = trials[c];
      if (c === stageB) reasons.push(`${CODECS[c].label} chosen: ~${Math.round((1 - t.projectedBps / baseline) * 100)}% smaller, ~${t.projectedSecs}s to encode.`);
      else if (have.has(c)) reasons.push(`${CODECS[c].label}: already have one.`);
      else if (!t) reasons.push(`${CODECS[c].label}: no encoder available.`);
      else if (!t.ok) reasons.push(`${CODECS[c].label}: trial failed (${t.err}).`);
      else if (t.projectedSecs > budgetX * dur) reasons.push(`${CODECS[c].label}: too slow here (~${t.projectedSecs}s > ${Math.round(budgetX * dur)}s budget).`);
      else reasons.push(`${CODECS[c].label}: saves only ~${Math.max(0, Math.round((1 - t.projectedBps / baseline) * 100))}% (needs ${Math.round((1 - SAVINGS_REQUIRED) * 100)}%).`);
    }
  }
  return { stageA, stageB, reasons };
}

// ---------- background encoding (serial, low priority) ----------
let encChain = Promise.resolve();
const queue = (fn) => (encChain = encChain.then(fn, fn));
const nice = (p) => { try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted - fine */ } };

async function encodeOne(m, src, info, variant, codec) {
  const container = CODECS[codec].container;
  const tmp = path.join(config.dataDir, 'tmp', `${m.id}.${codec}.${container}`);
  try {
    const audio = !info.acodec ? ['-an'] : container === 'webm' ? ['-c:a', 'libopus', '-b:a', '128k', '-ac', '2']
      : (['aac', 'mp3'].includes(info.acodec) && info.channels <= 2 ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']);
    await new Promise((resolve, reject) => {
      const p = spawn(config.ffmpeg, ['-v', 'error', '-nostdin', '-y', ...M.wl(src), '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-sn', ...variant.args, ...info.color, ...audio,
        ...(container === 'mp4' ? ['-movflags', '+faststart'] : []), '-progress', 'pipe:1', tmp]);
      nice(p);
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.stdout.on('data', (d) => { const mm = /out_time_(?:us|ms)=(\d+)/.exec(String(d)); if (mm && info.dur) M.progress.set(m.id, { codec, p: Math.min(0.99, +mm[1] / 1e6 / info.dur) }); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300) || `ffmpeg exit ${code}`))));
    });
    const dest = M.vaultPath(m.id, `r-${codec}`);
    const size = await encryptStream(fs.createReadStream(tmp), dest);
    const old = get('SELECT id,path FROM renditions WHERE media_id=? AND codec=?', m.id, codec);
    if (old) { run('DELETE FROM renditions WHERE id=?', old.id); if (old.path !== dest) await fsp.rm(old.path, { force: true }); }
    run('INSERT INTO renditions(id,media_id,codec,container,path,width,height,bitrate,size,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      M.newId(), m.id, codec, container, dest, info.width, info.height, info.dur ? Math.round((size * 8) / info.dur) : null, size, now());
    run('UPDATE media SET playable=1 WHERE id=?', m.id);
    audit(m.owner_id, 'encode', `${m.id} ${codec} ${variant.tag}`);
  } finally {
    M.progress.delete(m.id);
    await fsp.rm(tmp, { force: true });
  }
}

const saveScan = (id, obj) => run('UPDATE media SET scan=? WHERE id=?', JSON.stringify(obj), id);

/** Scan this file and produce whatever renditions are worth having. */
export function autoEncode(id, { force = false } = {}) {
  return queue(async () => {
    const m = get('SELECT * FROM media WHERE id=?', id);
    if (!m || m.status !== 'ready') return;
    if (!force && setting('encode_auto', config.encodeAuto ? '1' : '0') !== '1') return;
    let tok;
    const scanInfo = { at: now() };
    try {
      if (!(await M.ffmpegAvailable())) return;
      const s = await M.resolveSource(m, 'orig');
      tok = s.enc ? M.issueToken(s.path) : null;
      const src = tok ? tok.url : s.path;
      const info = describe(await M.probe(src), m.size);
      if (!info.dur) throw new Error('unknown duration');
      M.progress.set(id, { codec: 'scan', p: 0 });
      const trials = await scan(src, info);
      M.progress.delete(id);
      const existing = all('SELECT codec,bitrate FROM renditions WHERE media_id=?', id);
      const plan = decide({ origPlayable: !!m.orig_playable, srcCodec: info.vcodec, dur: info.dur, videoBps: info.videoBps, trials, existing, tenBit: info.tenBit, hdr: info.hdr });
      Object.assign(scanInfo, { source: { codec: info.vcodec, width: info.width, height: info.height, fps: +info.fps.toFixed(2), videoKbps: Math.round(info.videoBps / 1000), durationSec: Math.round(info.dur), tenBit: info.tenBit, hdr: info.hdr }, trials, plan, budgetX: config.encodeBudgetX });
      saveScan(id, scanInfo);
      for (const codec of [plan.stageA, plan.stageB].filter(Boolean)) {
        const t = trials[codec];
        const variant = variantsFor(info).find((v) => v.tag === t.variant && v.codec === codec);
        try { await encodeOne(m, src, info, variant, codec); } catch (e) { scanInfo.encodeError = `${codec}: ${String(e.message).slice(0, 200)}`; saveScan(id, scanInfo); }
      }
    } catch (e) {
      scanInfo.error = String(e.message).slice(0, 200);
      saveScan(id, scanInfo);
    } finally { tok?.revoke(); M.progress.delete(id); }
  });
}

/** Owner asked for a specific codec: use the best available variant, no budget check. */
export function encodeCodec(id, codec) {
  return queue(async () => {
    const m = get('SELECT * FROM media WHERE id=?', id);
    if (!m || m.status !== 'ready' || !CODECS[codec]) return;
    let tok;
    try {
      const s = await M.resolveSource(m, 'orig');
      tok = s.enc ? M.issueToken(s.path) : null;
      const src = tok ? tok.url : s.path;
      const info = describe(await M.probe(src), m.size);
      const have = await availableEncoders();
      const variant = variantsFor(info).find((v) => v.codec === codec && have.has(v.encoder));
      if (!variant) throw new Error(`no ${CODECS[codec].label} encoder available`);
      M.progress.set(id, { codec, p: 0 });
      await encodeOne(m, src, info, variant, codec);
    } catch (e) {
      const prev = get('SELECT scan FROM media WHERE id=?', id)?.scan; const sc = prev ? JSON.parse(prev) : { at: now() };
      sc.encodeError = `${codec}: ${String(e.message).slice(0, 200)}`; saveScan(id, sc);
    } finally { tok?.revoke(); M.progress.delete(id); }
  });
}

/** Called when an item becomes ready (upload/scan) and at startup for never-scanned items. */
export const queueAuto = (id) => autoEncode(id);

export function startEncodeJobs() {
  setTimeout(() => {
    for (const { id } of all("SELECT id FROM media WHERE status='ready' AND scan IS NULL ORDER BY created_at")) autoEncode(id);
  }, 8000).unref();
}
