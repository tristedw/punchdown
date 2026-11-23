// Latency strip for the inspector. One bar per ping, newest on the right.
// A missed reply draws as a short red tick on the baseline so loss reads at a
// glance without needing its own chart.

import { band } from './util.js';

const COLORS = { good: '#2f8a4e', fair: '#d9731a', slow: '#7a4e2d', lost: '#c23a2b', grid: '#c9ced4', text: '#5b6672' };

export function drawSpark(canvas, samples, slots = 60) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const ok = samples.filter((s) => s != null);
  // scale to the worst sample but never tighter than 10 ms, so a quiet wired
  // host doesn't look like it's spiking over a 0.3 ms wobble
  const top = Math.max(10, ...ok) * 1.15;
  const base = h - 14;

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, base + 0.5);
  ctx.lineTo(w, base + 0.5);
  ctx.stroke();

  ctx.fillStyle = COLORS.text;
  ctx.font = '500 10px Barlow, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Math.round(top)} ms`, 0, 0);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`last ${slots} s`, 0, h - 2);

  const bw = w / slots;
  const offset = slots - samples.length;
  samples.forEach((s, i) => {
    const x = (offset + i) * bw;
    if (s == null) {
      ctx.fillStyle = COLORS.lost;
      ctx.fillRect(x + 1, base - 6, Math.max(1, bw - 2), 6);
      return;
    }
    const bh = Math.max(2, (s / top) * (base - 14));
    ctx.fillStyle = COLORS[band(s)];
    ctx.fillRect(x + 1, base - bh, Math.max(1, bw - 2), bh);
  });
}
