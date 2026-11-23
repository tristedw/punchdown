// The patch panel. One jack per address in the subnet, grouped in eights like
// a real punch-down panel. Jacks get "plugged" as the sweep finds hosts, so
// you can watch the scan happen instead of staring at a progress bar.

import { band, esc, ipNum, ms, displayName } from './util.js';
import { KIND_NAMES } from './icons.js';

export class PatchPanel {
  constructor(root, { onSelect }) {
    this.root = root;
    this.onSelect = onSelect;
    this.ports = new Map();
    this.base = 0;
    this.prefix = '';
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button.port');
      if (btn) this.onSelect(btn.dataset.ip);
    });
  }

  reset({ first, count, gateway, self }) {
    this.ports.clear();
    if (!first) {
      this.root.innerHTML = '';
      return;
    }
    this.base = ipNum(first);
    const octs = first.split('.');
    const blocks = [];
    for (let b = 0; b < count; b += 8) {
      const cells = [];
      for (let i = b; i < Math.min(b + 8, count); i++) {
        const n = this.base + i;
        const ip = [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.');
        const role = ip === gateway ? 'gateway' : ip === self ? 'self' : '';
        cells.push(
          `<span class="port" data-ip="${ip}" data-state="idle" data-role="${role}">` +
          `<span class="jack"><span class="boot"></span></span><span class="led"></span>` +
          `<span class="num">${n & 255}</span></span>`
        );
      }
      blocks.push(`<div class="block">${cells.join('')}</div>`);
    }
    // the third octet changes inside a /22, so show which /24 each row is
    this.prefix = octs.slice(0, 3).join('.');
    this.root.innerHTML = blocks.join('');
    for (const el of this.root.querySelectorAll('.port')) this.ports.set(el.dataset.ip, el);
  }

  mark(ip, alive) {
    const el = this.ports.get(ip);
    if (!el || el.dataset.state === 'live') return;
    if (!alive) el.dataset.state = 'empty';
  }

  plug(host) {
    let el = this.ports.get(host.ip);
    if (!el) return;
    if (el.tagName !== 'BUTTON') {
      const btn = document.createElement('button');
      btn.className = 'port';
      btn.type = 'button';
      for (const [k, v] of Object.entries(el.dataset)) btn.dataset[k] = v;
      btn.innerHTML = el.innerHTML;
      el.replaceWith(btn);
      this.ports.set(host.ip, btn);
      el = btn;
    }
    el.dataset.state = 'live';
    el.dataset.band = host.is_gateway ? 'gateway' : band(host.rtt);
    el.dataset.quiet = host.found_by === 'arp only' ? 'true' : 'false';
    el.title = `${host.ip}\n${displayName(host)}\n${KIND_NAMES[host.kind] || ''} ${ms(host.rtt)}`;
    el.setAttribute('aria-label', `${esc(displayName(host))}, ${host.ip}`);
  }

  unplug(ip) {
    const el = this.ports.get(ip);
    if (el) el.dataset.state = 'empty';
  }

  select(ip) {
    for (const el of this.root.querySelectorAll('.port[aria-pressed="true"]')) el.removeAttribute('aria-pressed');
    const el = ip && this.ports.get(ip);
    if (el && el.tagName === 'BUTTON') el.setAttribute('aria-pressed', 'true');
  }

  progress() {
    let done = 0, live = 0;
    for (const el of this.ports.values()) {
      if (el.dataset.state !== 'idle') done++;
      if (el.dataset.state === 'live') live++;
    }
    return { done, live, total: this.ports.size };
  }
}
