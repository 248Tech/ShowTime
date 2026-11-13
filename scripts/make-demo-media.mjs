// Generates the tiny branded sample clips used by the GitHub Pages live demo (H.264 / AV1 / VP9). Dev-only; the outputs are committed.
// Usage: node scripts/make-demo-media.mjs   (needs ffmpeg with libx264, libsvtav1, libvpx-vp9, libopus)
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const out = path.resolve('demo-src/media');
fs.mkdirSync(out, { recursive: true });
// ffmpeg filter syntax: the drive-letter colon must be escaped with a backslash
const font = process.platform === 'win32' ? 'C\\:/Windows/Fonts/segoeuib.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const DUR = 40;
const vf = [
  `drawtext=fontfile='${font}':text='ShowTime':fontsize=84:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-40:shadowcolor=black@0.45:shadowx=3:shadowy=3`,
  `drawtext=fontfile='${font}':text='live demo clip  %{pts\\:hms}':fontsize=30:fontcolor=white@0.85:x=(w-text_w)/2:y=(h/2)+40`,
].join(',');
const inputs = [
  '-f', 'lavfi', '-i', `gradients=s=854x480:d=${DUR}:r=24:speed=0.025:c0=0xff9a3d:c1=0xff4d6d:c2=0x7c5cff:c3=0x1b1236:nb_colors=4:seed=11`,
  '-f', 'lavfi', '-i', `aevalsrc='0.06*sin(2*PI*220*t)+0.05*sin(2*PI*277.18*t)+0.05*sin(2*PI*329.63*t)':s=44100:d=${DUR}`,
];
const af = 'tremolo=f=0.25:d=0.35,afade=t=in:d=1.5,afade=t=out:st=38:d=2';
const run = (name, enc) => {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-vf', vf, '-af', af, '-shortest', ...enc, path.join(out, name)], { stdio: 'inherit' });
  console.log(name, (fs.statSync(path.join(out, name)).size / 1024).toFixed(0) + ' KB');
};
run('sample-h264.mp4', ['-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart']);
run('sample-av1.mp4', ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '36', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart']);
run('sample-vp9.webm', ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '48k']);
