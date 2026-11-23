export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const ipNum = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
export const lastOctet = (ip) => Number(ip.split('.').pop());

// Latency bands borrow the pair colours off a T568B cable: green is fine,
// orange is noticeable, brown is slow. Red is reserved for packet loss.
export function band(rtt) {
  if (rtt == null) return 'none';
  if (rtt < 8) return 'good';
  if (rtt < 40) return 'fair';
  return 'slow';
}

export function ms(rtt) {
  if (rtt == null) return 'no reply';
  if (rtt < 1) return '<1 ms';
  if (rtt < 10) return `${rtt.toFixed(1)} ms`;
  return `${Math.round(rtt)} ms`;
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function displayName(h) {
  return h.label || h.name || h.vendor || (h.is_gateway ? 'Gateway' : h.ip);
}

export function stats(samples) {
  const ok = samples.filter((s) => s != null);
  if (!samples.length) return null;
  const loss = 1 - ok.length / samples.length;
  if (!ok.length) return { loss, min: null, avg: null, max: null, jitter: null };
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  let jitter = 0;
  for (let i = 1; i < ok.length; i++) jitter += Math.abs(ok[i] - ok[i - 1]);
  jitter = ok.length > 1 ? jitter / (ok.length - 1) : 0;
  return { loss, min: Math.min(...ok), avg, max: Math.max(...ok), jitter };
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
