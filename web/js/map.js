// Topology view, drawn in SVG. Layout is a radial tree eased into place by a
// tiny simulation. A few hundred nodes at most, so the O(n^2) collision pass
// is fine.

import { glyphBody } from './icons.js';
import { esc, reducedMotion } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const R = 19;

// Order around the ring, so all the speakers end up near each other.
const SECTORS = ['access-point', 'switch', 'computer', 'server', 'nas', 'printer', 'tv', 'speaker', 'console', 'iot', 'camera', 'phone', 'tablet', 'unknown'];


function svg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export class TopoMap {
  constructor(root, { onSelect, onMove }) {
    this.root = root;
    this.onSelect = onSelect;
    this.onMove = onMove;
    this.nodes = new Map();
    this.edges = [];
    this.selected = null;
    this.alpha = 0;
    this.view = { x: -480, y: -340, w: 960, h: 680 };
    // keep framing the whole network until the person pans or zooms
    this.autoFit = true;

    this.svg = svg('svg', { class: 'topo', role: 'img', 'aria-label': 'Network map' });
    this.gEdges = svg('g', { class: 'edges' });
    this.gNodes = svg('g', { class: 'nodes' });
    this.svg.append(this.gEdges, this.gNodes);
    root.append(this.svg);
    this.applyView();
    this.bindPointer();
    new ResizeObserver(() => this.applyView()).observe(root);
  }

  // data --------------------------------------------------------------------

  update(nodes, edges) {
    const seen = new Set();
    const parentOf = new Map(edges.map((e) => [e.target, e.source]));
    for (const n of nodes) {
      seen.add(n.id);
      let node = this.nodes.get(n.id);
      if (!node) {
        const parent = this.nodes.get(parentOf.get(n.id));
        const a = Math.random() * Math.PI * 2;
        node = { x: (parent?.x ?? 0) + Math.cos(a) * 20, y: (parent?.y ?? 0) + Math.sin(a) * 20, vx: 0, vy: 0 };
        this.nodes.set(n.id, node);
        this.alpha = Math.max(this.alpha, 0.6);
      }
      Object.assign(node, n);
      if (n.pinned) {
        node.fx = node.x = n.pinned[0];
        node.fy = node.y = n.pinned[1];
      } else if (!node.dragging) {
        node.fx = node.fy = undefined;
      }
      if (n.isRoot && !n.pinned) { node.fx = 0; node.fy = 0; }
    }
    for (const id of [...this.nodes.keys()]) if (!seen.has(id)) this.nodes.delete(id);
    const structural = edges.map((e) => e.source + '>' + e.target).join('|');
    if (structural !== this._structure) this.alpha = Math.max(this.alpha, 0.5);
    this._structure = structural;
    this.edges = edges.filter((e) => this.nodes.has(e.source) && this.nodes.has(e.target));
    this.layoutTargets();
    this.render();
    this.kick();
  }

  select(id) {
    this.selected = id;
    for (const g of this.gNodes.children) g.classList.toggle('is-selected', g.dataset.id === id);
  }

  // simulation --------------------------------------------------------------

  kick() {
    if (this.raf) return;
    const step = () => {
      this.tick();
      this.paint();
      if (this.alpha > 0.008) this.raf = requestAnimationFrame(step);
      else {
        this.raf = null;
        if (this.autoFit) this.fit();
      }
    };
    if (reducedMotion()) {
      // settle off screen, draw once
      for (let i = 0; i < 300 && this.alpha > 0.008; i++) this.tick();
      this.paint();
      if (this.autoFit) this.fit();
      return;
    }
    this.raf = requestAnimationFrame(step);
  }

  // Radial tree: the gateway in the middle, its children on a ring sorted by
  // kind, and anything plugged into a switch or AP fanned out behind it. Each
  // subtree gets a slice of the circle sized by how many leaves it has, so
  // cables don't cross. The simulation just eases nodes toward those spots
  // and keeps labels from sitting on top of each other.
  layoutTargets() {
    const kids = new Map();
    const hasParent = new Set();
    for (const e of this.edges) {
      if (!kids.has(e.source)) kids.set(e.source, []);
      kids.get(e.source).push(e.target);
      hasParent.add(e.target);
    }
    const order = (a, b) => {
      const na = this.nodes.get(a), nb = this.nodes.get(b);
      return (SECTORS.indexOf(na.kind) - SECTORS.indexOf(nb.kind)) || String(na.title).localeCompare(nb.title);
    };
    const weight = new Map();
    const w = (id, seen = new Set()) => {
      if (seen.has(id)) return 1;
      seen.add(id);
      const c = kids.get(id) || [];
      const v = c.length ? Math.max(1, c.reduce((sum, k) => sum + w(k, seen), 0) * 0.85 + 0.3) : 1;
      weight.set(id, v);
      return v;
    };
    const roots = [...this.nodes.keys()].filter((id) => !hasParent.has(id));
    const root = roots.find((id) => this.nodes.get(id).isRoot) ?? roots[0];
    if (root == null) return;
    const firstRing = (kids.get(root) || []).length;
    const leaves = w(root);
    const r1 = Math.max(170, (firstRing * 92) / (Math.PI * 2));
    const r2 = Math.max(r1 + 125, (leaves * 78) / (Math.PI * 2));
    const radius = (depth) => (depth === 0 ? 0 : depth === 1 ? r1 : r2 + (depth - 2) * 110);

    const place = (id, a0, a1, depth, seen) => {
      if (seen.has(id)) return;
      seen.add(id);
      const n = this.nodes.get(id);
      const mid = (a0 + a1) / 2;
      n.tx = Math.cos(mid) * radius(depth);
      n.ty = Math.sin(mid) * radius(depth);
      const c = (kids.get(id) || []).slice().sort(order);
      const total = c.reduce((sum, k) => sum + (weight.get(k) || 1), 0);
      // a subtree off the first ring gets at least a little fan to spread into
      let span = a1 - a0;
      let start = a0;
      if (depth >= 1 && c.length > 1) {
        const want = Math.min(Math.PI * 0.9, (c.length * 74) / radius(depth + 1));
        if (want > span) { start = mid - want / 2; span = want; }
      }
      let a = start;
      for (const k of c) {
        const slice = (span * (weight.get(k) || 1)) / (total || 1);
        place(k, a, a + slice, depth + 1, seen);
        a += slice;
      }
    };
    const seen = new Set();
    place(root, -Math.PI / 2, Math.PI * 1.5, 0, seen);
    // islands with no path to the gateway park in a row underneath
    let i = 0;
    for (const id of this.nodes.keys()) {
      if (seen.has(id)) continue;
      const n = this.nodes.get(id);
      n.tx = -r2 + (i % 8) * 110;
      n.ty = r2 + 120 + Math.floor(i / 8) * 90;
      i++;
    }
  }

  tick() {
    const list = [...this.nodes.values()];
    const a = this.alpha;
    for (const n of list) {
      if (n.fx != null || n.tx == null) continue;
      n.vx += (n.tx - n.x) * 0.09 * Math.max(a, 0.2);
      n.vy += (n.ty - n.y) * 0.09 * Math.max(a, 0.2);
    }
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const q = list[j];
        let dx = q.x - p.x, dy = q.y - p.y;
        // labels are wide and short, so measure the gap as an oval
        const ex = dx / 92, ey = dy / 62;
        const d = Math.hypot(ex, ey);
        if (d >= 1) continue;
        if (d < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const push = (1 - d) * 4;
        const len = Math.hypot(dx, dy) || 1;
        const fx = (dx / len) * push, fy = (dy / len) * push;
        if (p.fx == null) { p.vx -= fx; p.vy -= fy; }
        if (q.fx == null) { q.vx += fx; q.vy += fy; }
      }
    }
    for (const n of list) {
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
      n.vx *= 0.62; n.vy *= 0.62;
      n.x += n.vx; n.y += n.vy;
    }
    this.alpha *= 0.965;
  }

  // drawing -----------------------------------------------------------------

  render() {
    this.gEdges.replaceChildren(...this.edges.map((e) => {
      const p = svg('path', { class: `cable band-${e.band}${e.live ? ' is-live' : ''}${e.lost ? ' is-lost' : ''}` });
      p._edge = e;
      return p;
    }));

    const byId = new Map([...this.gNodes.children].map((g) => [g.dataset.id, g]));
    const frag = [];
    for (const n of this.nodes.values()) {
      const sig = [n.kind, n.title, n.sub, n.label, n.color, n.isNew, n.offline, n.isRoot, n.extra].join('|');
      let g = byId.get(n.id);
      if (!g || g._sig !== sig) {
        g = this.buildNode(n);
        g._sig = sig;
      }
      g.classList.toggle('is-selected', n.id === this.selected);
      g.classList.toggle('is-dim', !!n.dim);
      frag.push(g);
    }
    this.gNodes.replaceChildren(...frag);
    this.paint();
  }

  buildNode(n) {
    const g = svg('g', {
      class: `node kind-${n.kind}${n.offline ? ' is-offline' : ''}${n.isRoot ? ' is-root' : ''}${n.extra ? ' is-extra' : ''}`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${n.label || n.title}, ${n.sub || ''}`,
    });
    g.dataset.id = n.id;
    const r = n.isRoot ? R + 5 : R;
    if (n.extra) {
      g.append(svg('rect', { class: 'disc', x: -r - 4, y: -r + 6, width: (r + 4) * 2, height: (r - 6) * 2, rx: 3 }));
    } else {
      g.append(svg('circle', { class: 'disc', r }));
    }
    const icon = svg('g', { class: 'icon', transform: `translate(${-11} ${-11}) scale(${22 / 24})` });
    icon.innerHTML = glyphBody(n.kind);
    g.append(icon);
    if (n.isNew) g.append(svg('circle', { class: 'new-dot', cx: r * 0.72, cy: -r * 0.72, r: 4.5 }));

    let y = r + 15;
    if (n.label) {
      const tape = svg('g', { class: `tape tape-${n.color || 'black'}`, transform: `translate(0 ${y})` });
      const rect = svg('rect', { y: -11, height: 16, rx: 1.5 });
      const t = svg('text', { 'text-anchor': 'middle', y: 1.5 });
      t.textContent = n.label;
      tape.append(rect, t);
      g.append(tape);
      // width after it's in the DOM; set on next frame
      requestAnimationFrame(() => {
        const w = t.getComputedTextLength?.() || n.label.length * 7;
        rect.setAttribute('x', -(w / 2) - 6);
        rect.setAttribute('width', w + 12);
      });
      y += 15;
    } else {
      const t = svg('text', { class: 'title', 'text-anchor': 'middle', y });
      t.textContent = n.title.length > 22 ? n.title.slice(0, 21) + '…' : n.title;
      g.append(t);
      y += 13;
    }
    if (n.sub) {
      const s = svg('text', { class: 'sub', 'text-anchor': 'middle', y });
      s.textContent = n.sub;
      g.append(s);
    }
    return g;
  }

  paint() {
    for (const p of this.gEdges.children) {
      const s = this.nodes.get(p._edge.source), t = this.nodes.get(p._edge.target);
      if (!s || !t) continue;
      // a cable sags a bit under its own weight
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      const sag = Math.min(40, Math.hypot(t.x - s.x, t.y - s.y) * 0.12);
      p.setAttribute('d', `M${s.x.toFixed(1)} ${s.y.toFixed(1)} Q${mx.toFixed(1)} ${(my + sag).toFixed(1)} ${t.x.toFixed(1)} ${t.y.toFixed(1)}`);
    }
    for (const g of this.gNodes.children) {
      const n = this.nodes.get(g.dataset.id);
      if (n) g.setAttribute('transform', `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
    }
  }

  // view --------------------------------------------------------------------

  applyView() {
    const rect = this.root.getBoundingClientRect();
    if (!rect.width) return;
    // keep aspect, width drives
    this.view.h = this.view.w * (rect.height / rect.width);
    const v = this.view;
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  }

  fit() {
    const list = [...this.nodes.values()];
    if (!list.length) return;
    const xs = list.map((n) => n.x), ys = list.map((n) => n.y);
    const pad = 90;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const rect = this.root.getBoundingClientRect();
    const aspect = rect.height / rect.width || 0.7;
    let w = Math.max(maxX - minX, 760), h = w * aspect;
    if (h < maxY - minY) { h = maxY - minY; w = h / aspect; }
    this.view = { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h };
    this.applyView();
  }

  zoom(factor, cx, cy) {
    const v = this.view;
    const w = Math.min(6000, Math.max(240, v.w * factor));
    const k = w / v.w;
    cx ??= v.x + v.w / 2;
    cy ??= v.y + v.h / 2;
    this.view = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w, h: v.h * k };
    this.applyView();
  }

  toWorld(evt) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: this.view.x + ((evt.clientX - rect.left) / rect.width) * this.view.w,
      y: this.view.y + ((evt.clientY - rect.top) / rect.height) * this.view.h,
    };
  }

  bindPointer() {
    let drag = null;
    this.svg.addEventListener('pointerdown', (e) => {
      const g = e.target.closest('.node');
      this.svg.setPointerCapture(e.pointerId);
      if (g) {
        const n = this.nodes.get(g.dataset.id);
        drag = { node: n, moved: false, start: this.toWorld(e) };
        n.dragging = true;
      } else {
        this.autoFit = false;
        drag = { pan: true, sx: e.clientX, sy: e.clientY, v: { ...this.view }, moved: false };
      }
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.pan) {
        const rect = this.svg.getBoundingClientRect();
        const dx = ((e.clientX - drag.sx) / rect.width) * drag.v.w;
        const dy = ((e.clientY - drag.sy) / rect.height) * drag.v.h;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        this.view.x = drag.v.x - dx;
        this.view.y = drag.v.y - dy;
        this.applyView();
        return;
      }
      const p = this.toWorld(e);
      if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 4) return;
      drag.moved = true;
      drag.node.fx = drag.node.x = p.x;
      drag.node.fy = drag.node.y = p.y;
      this.alpha = Math.max(this.alpha, 0.15);
      this.paint();
      this.kick();
    });
    const end = () => {
      if (!drag) return;
      if (drag.node) {
        drag.node.dragging = false;
        if (drag.moved) {
          drag.node.pinned = [drag.node.x, drag.node.y];
          this.onMove(drag.node.id, [Math.round(drag.node.x), Math.round(drag.node.y)]);
        } else {
          this.onSelect(drag.node.id);
        }
      } else if (!drag.moved) {
        this.onSelect(null);
      }
      drag = null;
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.autoFit = false;
      const p = this.toWorld(e);
      this.zoom(Math.exp(e.deltaY * 0.0015), p.x, p.y);
    }, { passive: false });
    this.svg.addEventListener('keydown', (e) => {
      const g = e.target.closest?.('.node');
      if (g && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.onSelect(g.dataset.id);
      }
    });
  }

  // export ------------------------------------------------------------------

  toSVG(css) {
    this.fit();
    const clone = this.svg.cloneNode(true);
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('width', 1600);
    clone.setAttribute('height', Math.round(1600 * (this.view.h / this.view.w)));
    const style = document.createElementNS(NS, 'style');
    style.textContent = css;
    clone.prepend(style);
    const bg = svg('rect', { x: this.view.x, y: this.view.y, width: this.view.w, height: this.view.h, fill: '#eef0f2' });
    clone.insertBefore(bg, clone.children[1]);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + clone.outerHTML;
  }
}

export { esc };
