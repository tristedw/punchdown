// Two backends behind one interface. LocalApi talks to the python server on
// 127.0.0.1. DemoApi fakes a household network entirely in the page, which is
// what runs on GitHub Pages where there's no server to talk to.

import { DemoApi } from './demo.js';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function takeToken() {
  const m = location.hash.match(/k=([\w-]+)/);
  if (m) {
    sessionStorage.setItem('punchdown-token', m[1]);
    // get it out of the address bar and out of history
    history.replaceState(null, '', location.pathname + location.search);
  }
  return sessionStorage.getItem('punchdown-token');
}

class LocalApi {
  constructor(token) {
    this.token = token;
    this.demo = false;
  }

  async call(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'X-Punchdown-Token': this.token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  info() { return this.call('/api/info'); }
  state() { return this.call('/api/scan/state'); }
  scan(subnet, thorough) { return this.call('/api/scan', { subnet, thorough }); }
  cancel() { return this.call('/api/scan/cancel', {}); }
  ping(ips) { return this.call('/api/ping', { ips }); }
  ports(ip) { return this.call('/api/ports', { ip }); }
  label(key, label, color) { return this.call('/api/label', { key, label, color }); }
  layout(payload) { return this.call('/api/layout', payload); }
  forget(key) { return this.call('/api/forget', { key }); }
  wake(mac) { return this.call('/api/wake', { mac }); }

  // Reads the NDJSON stream line by line. Resolves when the scan finishes.
  async events(from, onEvent, signal) {
    const res = await fetch(`/api/scan/events?from=${from}`, {
      headers: { 'X-Punchdown-Token': this.token },
      signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('Lost the scan stream.');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
  }
}

export function connect() {
  if (!LOCAL_HOSTS.has(location.hostname) || new URLSearchParams(location.search).has('demo')) {
    return { api: new DemoApi(), mode: 'demo' };
  }
  const token = takeToken();
  if (!token) return { api: null, mode: 'locked' };
  return { api: new LocalApi(token), mode: 'local' };
}

export function demoApi() {
  return new DemoApi();
}
