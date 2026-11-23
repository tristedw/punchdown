import { connect } from './api.js';
import { PatchPanel } from './panel.js';
import { TopoMap } from './map.js';
import { drawSpark } from './spark.js';
import { glyph, KIND_NAMES } from './icons.js';
import { $, $$, esc, ipNum, lastOctet, band, ms, ago, displayName, stats, download } from './util.js';

const TAPES = ['black', 'orange', 'green', 'blue', 'brown'];
const SAMPLE_SLOTS = 60;

const S = {
  mode: 'local',
  api: null,
  info: null,
  hosts: new Map(),     // ip -> host
  known: new Map(),     // key -> stored record
  layout: {},
  extras: [],
  links: {},
  selected: null,       // node id: ip, extra id, or k:<key>
  view: 'map',
  showOffline: false,
  watchAll: false,
  watch: new Set(),
  samples: new Map(),   // ip -> [rtt|null]
  scanning: false,
  scanStats: null,
  search: '',
  sort: { col: 'ip', dir: 1 },
  portsBusy: new Set(),
};

let panel, topo;

// boot ------------------------------------------------------------------------

async function boot() {
  const { api, mode } = connect();
  S.api = api;
  S.mode = mode;
  document.body.dataset.mode = mode;

  panel = new PatchPanel($('#ports'), { onSelect: (ip) => select(ip) });
  topo = new TopoMap($('#map'), { onSelect: (id) => select(id), onMove: saveNodePosition });
  bindUi();

  if (mode === 'locked') {
    $('#locked').hidden = false;
    $('#empty').hidden = true;
    $('#scanBtn').disabled = true;
    renderInspector();
    return;
  }
  $('#demoNote').hidden = mode !== 'demo';

  try {
    S.info = await api.info();
  } catch (err) {
    toast(err.message, true);
    return;
  }
  for (const k of S.info.known || []) S.known.set(k.key, k);
  S.layout = S.info.layout || {};
  S.extras = S.info.extras || [];
  S.links = S.info.links || {};

  const subs = new Set((S.info.interfaces || []).map((i) => i.network));
  $('#subnets').innerHTML = [...subs].map((n) => `<option value="${esc(n)}">`).join('');
  $('#subnet').value = S.info.default_subnet || '';
  $('#emptyText').textContent = S.info.default_subnet
    ? `Scan ${S.info.default_subnet} to see what's plugged in. Everything stays on this machine.`
    : "Couldn't work out your subnet. Type one in above, like 192.168.1.0/24.";

  if (mode === 'local') {
    const st = await api.state().catch(() => null);
    if (st?.hosts?.length) {
      setPanelFor(st.subnet);
      for (const h of st.hosts) ingest(h);
      if (st.running) follow(0);
    }
  }
  render();
  if (mode === 'demo') setTimeout(() => startScan(), 500);
}

function setPanelFor(subnet) {
  if (!subnet) return;
  const [base, bits] = subnet.split('/');
  const size = 2 ** (32 - Number(bits));
  const n = ipNum(base) + 1;
  const first = [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.');
  panel.reset({ first, count: Math.max(0, size - 2), gateway: S.info?.gateway, self: S.info?.local_ip });
  $('#silkSubnet').textContent = subnet;
}

// scanning --------------------------------------------------------------------

async function startScan() {
  if (S.scanning) {
    await S.api.cancel().catch(() => {});
    return;
  }
  const subnet = $('#subnet').value.trim();
  try {
    await S.api.scan(subnet, $('#thorough').checked);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  // keep hosts around for the diff, but mark them stale until seen again
  S.previous = new Set(S.hosts.keys());
  S.hosts.clear();
  setPanelFor(subnet);
  follow(0);
}

async function follow(from) {
  S.scanning = true;
  S.scanStats = { phase: 'sweep', started: performance.now() };
  renderScanState();
  try {
    await S.api.events(from, onEvent);
  } catch (err) {
    toast(err.message, true);
  }
  S.scanning = false;
  renderScanState();
  render();
}

function onEvent(ev) {
  switch (ev.type) {
    case 'start':
      S.scanStats.count = ev.count;
      break;
    case 'probe':
      panel.mark(ev.ip, ev.alive);
      break;
    case 'host':
      ingest(ev.host);
      break;
    case 'phase':
      S.scanStats.phase = 'identify';
      break;
    case 'done': {
      S.scanStats.phase = 'done';
      const gone = [...(S.previous || [])].filter((ip) => !S.hosts.has(ip));
      const fresh = [...S.hosts.values()].filter((h) => h.new).length;
      let msg = ev.cancelled ? `Stopped. ${ev.hosts} devices so far.` : `Found ${ev.hosts} devices in ${ev.seconds} s.`;
      if (fresh) msg += ` ${fresh} new.`;
      if (gone.length) msg += ` ${gone.length} dropped off since last scan.`;
      toast(msg);
      break;
    }
  }
  renderScanState();
  scheduleRender();
}

function ingest(h) {
  const prev = S.hosts.get(h.ip);
  const host = prev ? Object.assign(prev, h) : { ...h };
  if (host.key) {
    const rec = S.known.get(host.key) || {};
    host.label = host.label ?? rec.label ?? null;
    host.color = host.color ?? rec.color ?? null;
    S.known.set(host.key, { ...rec, key: host.key, ip: host.ip, mac: host.mac, vendor: host.vendor, kind: host.kind, label: host.label, color: host.color, first_seen: host.first_seen ?? rec.first_seen, last_seen: Date.now() / 1000 });
  }
  S.hosts.set(h.ip, host);
  if (host.rtt != null && !S.samples.has(host.ip)) S.samples.set(host.ip, [host.rtt]);
  panel.plug(host);
}

// graph -----------------------------------------------------------------------

const keyOf = (h) => h.key || `ip:${h.ip}`;

function matches(h) {
  if (!S.search) return true;
  const hay = [displayName(h), h.ip, h.mac, h.vendor, h.kind, KIND_NAMES[h.kind], h.hostname, h.mdns].join(' ').toLowerCase();
  return hay.includes(S.search);
}

function latest(ip) {
  const s = S.samples.get(ip);
  return s?.length ? s[s.length - 1] : undefined;
}

function cableFor(h) {
  const s = S.samples.get(h.ip) || [];
  const recent = s.slice(-10);
  const lost = recent.length >= 4 && recent.filter((x) => x == null).length / recent.length > 0.15;
  const last = latest(h.ip);
  const rtt = last === undefined ? h.rtt : last ?? h.rtt;
  return { band: h.found_by === 'arp only' && last === undefined ? 'none' : band(rtt), lost };
}

function buildGraph() {
  const hosts = [...S.hosts.values()];
  const gw = hosts.find((h) => h.is_gateway);
  const rootId = gw ? gw.ip : null;
  const byKey = new Map(hosts.filter((h) => h.key).map((h) => [h.key, h.ip]));
  const extraIds = new Set(S.extras.map((e) => e.id));
  const resolve = (target) => {
    if (!target) return rootId;
    if (extraIds.has(target)) return target;
    return byKey.get(target) || rootId;
  };

  const nodes = [], edges = [];
  for (const h of hosts) {
    const k = keyOf(h);
    nodes.push({
      id: h.ip,
      kind: h.kind || 'unknown',
      title: displayName(h),
      label: h.label || null,
      color: h.color,
      sub: displayName(h) === h.ip ? KIND_NAMES[h.kind] || '' : h.ip,
      isNew: !!h.new,
      isRoot: h.ip === rootId,
      pinned: S.layout[k] || null,
      dim: !matches(h),
    });
    if (h.ip !== rootId && rootId) {
      let parent = resolve(S.links[k]);
      if (parent === h.ip) parent = rootId;
      const c = cableFor(h);
      edges.push({ source: parent, target: h.ip, band: c.band, lost: c.lost, live: S.watchAll || S.watch.has(h.ip) });
    }
  }
  if (rootId) {
    for (const x of S.extras) {
      nodes.push({ id: x.id, kind: x.kind, title: x.name || KIND_NAMES[x.kind], sub: 'added by you', extra: true, pinned: S.layout[x.id] || null });
      const parent = resolve(S.links[x.id]);
      edges.push({ source: parent === x.id ? rootId : parent, target: x.id, band: 'none' });
    }
  }
  if (S.showOffline && rootId) {
    const liveKeys = new Set(hosts.map(keyOf));
    for (const rec of S.known.values()) {
      if (liveKeys.has(rec.key)) continue;
      const id = `k:${rec.key}`;
      nodes.push({ id, kind: rec.kind || 'unknown', title: rec.label || rec.hostname || rec.vendor || rec.ip, label: null, sub: `seen ${ago(rec.last_seen)}`, offline: true, pinned: S.layout[rec.key] || null, dim: false });
      edges.push({ source: resolve(S.links[rec.key]), target: id, band: 'none' });
    }
  }
  return { nodes, edges };
}

// rendering -------------------------------------------------------------------

let pending = false;
function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

function render() {
  const any = S.hosts.size > 0;
  $('#empty').hidden = any || S.mode === 'locked' || S.scanning;
  $('#map').hidden = S.view !== 'map';
  $('#mapTools').hidden = S.view !== 'map' || !any;
  $('.legend').hidden = S.view !== 'map' || !any;
  $('#table').hidden = S.view !== 'list' || !any;

  if (S.view === 'map') {
    const { nodes, edges } = buildGraph();
    topo.update(nodes, edges);
    topo.select(S.selected);
  } else {
    renderTable();
  }
  renderInspector();
  renderStatus();
}

function renderScanState() {
  const btn = $('#scanBtn');
  btn.textContent = S.scanning ? 'Stop scan' : 'Scan network';
  btn.classList.toggle('is-stop', S.scanning);
  $('#emptyScan').disabled = S.scanning;
  document.body.classList.toggle('is-scanning', S.scanning);
  const p = panel.progress();
  let text = '';
  if (S.scanning) {
    text = S.scanStats?.phase === 'identify'
      ? `Identifying ${S.hosts.size} devices`
      : `Swept ${p.done} of ${p.total}, ${p.live} answered`;
  } else if (p.total) {
    text = `${p.live} of ${p.total} jacks in use`;
  }
  $('#silkProgress').textContent = text;
}

function renderStatus() {
  const hosts = [...S.hosts.values()];
  if (!hosts.length) {
    $('#status').innerHTML = S.mode === 'demo'
      ? '<span>Demo mode. Fake devices, no network traffic.</span>'
      : '<span>Bound to 127.0.0.1. No data leaves this machine.</span>';
    return;
  }
  const gw = hosts.find((h) => h.is_gateway);
  const fresh = hosts.filter((h) => h.new).length;
  const quiet = hosts.filter((h) => h.found_by === 'arp only').length;
  const cells = [
    `<span><b>${hosts.length}</b> online</span>`,
    fresh ? `<span class="is-new"><b>${fresh}</b> new</span>` : '',
    quiet ? `<span><b>${quiet}</b> only in ARP</span>` : '',
    gw ? `<span>gateway <b>${esc(ms(latest(gw.ip) ?? gw.rtt))}</b></span>` : '',
    S.watchAll || S.watch.size ? `<span>pinging ${S.watchAll ? 'everything' : S.watch.size} every second</span>` : '',
    `<span class="right">${S.mode === 'demo' ? 'demo data' : `${esc(S.info?.hostname || '')} on 127.0.0.1`}</span>`,
  ];
  $('#status').innerHTML = cells.join('');
}

// table -----------------------------------------------------------------------

const COLS = [
  ['ip', 'Jack', (h) => lastOctet(h.ip), (h) => ipNum(h.ip)],
  ['name', 'Device', null, (h) => displayName(h).toLowerCase()],
  ['kind', 'Kind', (h) => KIND_NAMES[h.kind] || '', (h) => h.kind],
  ['addr', 'IP', (h) => h.ip, (h) => ipNum(h.ip)],
  ['mac', 'MAC', (h) => h.mac || '', (h) => h.mac || 'zz'],
  ['vendor', 'Maker', (h) => h.vendor || (h.randomized_mac ? 'private address' : ''), (h) => (h.vendor || 'zz').toLowerCase()],
  ['rtt', 'Latency', null, (h) => latest(h.ip) ?? h.rtt ?? 1e9],
  ['ports', 'Open ports', (h) => (h.ports || []).map((p) => p.port).join(' '), (h) => -(h.ports || []).length],
  ['seen', 'First seen', (h) => ago(h.first_seen), (h) => -(h.first_seen || 0)],
];

function renderTable() {
  const { col, dir } = S.sort;
  const sorter = COLS.find((c) => c[0] === col)[3];
  const rows = [...S.hosts.values()].filter(matches).sort((a, b) => {
    const x = sorter(a), y = sorter(b);
    return (x > y ? 1 : x < y ? -1 : 0) * dir;
  });
  const head = COLS.map(([id, label]) => {
    const sort = id === col ? (dir > 0 ? 'ascending' : 'descending') : 'none';
    return `<th aria-sort="${sort}" class="c-${id}"><button data-sort="${id}">${label}</button></th>`;
  }).join('');
  const body = rows.map((h) => {
    const rtt = latest(h.ip) ?? h.rtt;
    const cells = COLS.map(([id, , fmt]) => {
      if (id === 'name') {
        const tape = h.label ? `<span class="tape tape-${esc(h.color || 'black')}">${esc(h.label)}</span>` : esc(displayName(h));
        return `<td class="c-name"><button class="row-btn" data-ip="${h.ip}">${glyph(h.kind, 16)}${tape}</button>${h.new ? '<span class="new-tag">new</span>' : ''}</td>`;
      }
      if (id === 'rtt') return `<td class="c-rtt"><i class="sw ${band(rtt)}"></i>${esc(h.found_by === 'arp only' && rtt == null ? 'ignores ping' : ms(rtt))}</td>`;
      return `<td class="c-${id}">${esc(fmt(h))}</td>`;
    }).join('');
    return `<tr class="${S.selected === h.ip ? 'is-selected' : ''}">${cells}</tr>`;
  }).join('');
  $('#table').innerHTML = rows.length
    ? `<table class="sheet"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : `<p class="no-match">Nothing matches "${esc(S.search)}".</p>`;
}

// inspector -------------------------------------------------------------------

function select(id) {
  S.selected = id || null;
  panel.select(S.hosts.has(id) ? id : null);
  topo.select(S.selected);
  if (S.view === 'list') renderTable();
  renderInspector();
}

function renderInspector() {
  const el = $('#inspector');
  if (S.mode === 'locked') {
    el.innerHTML = '<div class="insp-body"><p class="muted">Waiting for a session key.</p></div>';
    return;
  }
  const id = S.selected;
  if (id && S.hosts.has(id)) return inspectHost(el, S.hosts.get(id));
  const extra = S.extras.find((x) => x.id === id);
  if (extra) return inspectExtra(el, extra);
  if (id?.startsWith('k:')) {
    const rec = S.known.get(id.slice(2));
    if (rec) return inspectOffline(el, rec);
  }
  overview(el);
}

function overview(el) {
  const hosts = [...S.hosts.values()];
  if (!hosts.length) {
    el.innerHTML = `<div class="insp-body">
      <h2 class="insp-title">Your network</h2>
      <dl class="facts">
        <dt>This machine</dt><dd>${esc(S.info?.local_ip || 'unknown')}</dd>
        <dt>Gateway</dt><dd>${esc(S.info?.gateway || 'not found')}</dd>
        <dt>Subnet</dt><dd>${esc(S.info?.default_subnet || 'not found')}</dd>
        <dt>Remembered</dt><dd>${S.known.size} devices</dd>
      </dl>
      <p class="muted">A scan pings every address, knocks on a few common ports, then asks each device what it is over mDNS, NetBIOS, UPnP and your router's DNS. None of it goes past your router.</p>
    </div>`;
    return;
  }
  const counts = {};
  for (const h of hosts) counts[h.kind] = (counts[h.kind] || 0) + 1;
  const max = Math.max(...Object.values(counts));
  const kinds = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
    `<li><span class="k">${glyph(k, 15)}${esc(KIND_NAMES[k] || k)}</span><svg class="bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="6" rx="3"/><rect class="fill" width="${Math.max(4, (n / max) * 100).toFixed(1)}" height="6" rx="3"/></svg><span class="n">${n}</span></li>`).join('');
  const fresh = hosts.filter((h) => h.new);
  const slow = hosts.filter((h) => (latest(h.ip) ?? h.rtt) != null).sort((a, b) => (latest(b.ip) ?? b.rtt) - (latest(a.ip) ?? a.rtt)).slice(0, 4);
  const list = (arr, fmt) => arr.map((h) => `<li><button class="link-row" data-ip="${h.ip}">${glyph(h.kind, 15)}<span>${esc(displayName(h))}</span><span class="r">${fmt(h)}</span></button></li>`).join('');
  el.innerHTML = `<div class="insp-body">
    <h2 class="insp-title">${esc(S.scanning ? 'Scanning' : 'Your network')}</h2>
    <p class="muted">${hosts.length} devices on ${esc($('#silkSubnet').textContent)}. Pick one on the map or a lit jack above.</p>
    <h3>What's here</h3>
    <ul class="kinds">${kinds}</ul>
    ${fresh.length ? `<h3>New since last time</h3><ul class="rows">${list(fresh, (h) => esc(h.ip))}</ul>` : ''}
    ${slow.length ? `<h3>Slowest to answer</h3><ul class="rows">${list(slow, (h) => esc(ms(latest(h.ip) ?? h.rtt)))}</ul>` : ''}
  </div>`;
}

function fact(label, value, cls = '') {
  return value ? `<dt>${label}</dt><dd class="${cls}">${value}</dd>` : '';
}

function parentOptions(selfKey, current) {
  const hosts = [...S.hosts.values()];
  const gw = hosts.find((h) => h.is_gateway);
  const opts = [];
  if (gw) opts.push([keyOf(gw), `${displayName(gw)} (gateway)`]);
  for (const x of S.extras) opts.push([x.id, x.name || KIND_NAMES[x.kind]]);
  for (const h of hosts) if (h.kind === 'access-point' && keyOf(h) !== selfKey) opts.push([keyOf(h), displayName(h)]);
  const cur = current || (gw ? keyOf(gw) : '');
  return opts.map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

function inspectHost(el, h) {
  const k = keyOf(h);
  const samples = S.samples.get(h.ip) || [];
  const st = samples.length > 1 ? stats(samples) : null;
  const watching = S.watchAll || S.watch.has(h.ip);
  const upnp = h.upnp || {};
  const model = [upnp.manufacturer, upnp.modelName].filter(Boolean).join(' ');
  const web = h.http?.title ? `<a href="${h.http.port === 443 ? 'https' : 'http'}://${h.ip}${[80, 443].includes(h.http.port) ? '' : ':' + h.http.port}/" target="_blank" rel="noopener noreferrer">${esc(h.http.title)}</a>` : '';
  const ports = (h.ports || []).map((p) => `<li><b>${p.port}</b>${esc(p.service || '')}</li>`).join('');
  const reasons = (h.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('');
  const tape = h.label
    ? `<span class="tape big tape-${esc(h.color || 'black')}">${esc(h.label)}</span>`
    : `<span class="insp-name">${esc(displayName(h))}</span>`;

  el.innerHTML = `<div class="insp-body" data-ip="${h.ip}">
    <div class="insp-head">
      <span class="insp-glyph">${glyph(h.kind, 28)}</span>
      <div>
        ${tape}
        <p class="insp-kind">${esc(KIND_NAMES[h.kind] || 'Unidentified')}${h.enriched && h.kind !== 'unknown' ? `, ${h.confidence}% sure` : ''}${h.new ? ' <span class="new-tag">new</span>' : ''}</p>
      </div>
      <button class="icon-btn" data-act="close" aria-label="Close details" title="Close (Esc)">&times;</button>
    </div>

    <form class="label-form" data-act="label-form" hidden>
      <label for="labelInput">Label</label>
      <input id="labelInput" maxlength="40" value="${esc(h.label || '')}" placeholder="${esc(h.name || 'Kitchen speaker')}">
      <fieldset class="tapes"><legend>Tape colour</legend>
        ${TAPES.map((c) => `<label><input type="radio" name="tape" value="${c}" ${(h.color || 'black') === c ? 'checked' : ''}><span class="swatch tape-${c}" title="${c}"></span></label>`).join('')}
      </fieldset>
      <div class="row"><button class="btn primary" type="submit">Save label</button><button class="btn" type="button" data-act="label-cancel">Cancel</button></div>
    </form>

    <div class="actions">
      <button class="btn" data-act="label" ${h.key ? '' : 'disabled title="Wait for the scan to identify it"'}>${h.label ? 'Edit label' : 'Add label'}</button>
      <button class="btn ${watching ? 'is-on' : ''}" data-act="watch" aria-pressed="${watching}">${watching ? 'Stop watching' : 'Watch latency'}</button>
      <button class="btn" data-act="ports" ${S.portsBusy.has(h.ip) ? 'disabled' : ''}>${S.portsBusy.has(h.ip) ? 'Checking 1,047 ports' : 'Check all ports'}</button>
    </div>

    <h3>Latency</h3>
    <canvas class="spark" width="320" height="86" aria-label="Ping history"></canvas>
    ${st ? `<dl class="nums">
      <div><dt>now</dt><dd>${esc(ms(samples[samples.length - 1]))}</dd></div>
      <div><dt>avg</dt><dd>${esc(ms(st.avg))}</dd></div>
      <div><dt>jitter</dt><dd>${st.jitter != null ? esc(ms(st.jitter)) : 'n/a'}</dd></div>
      <div><dt>loss</dt><dd class="${st.loss > 0.05 ? 'bad' : ''}">${Math.round(st.loss * 100)}%</dd></div>
    </dl>` : `<p class="muted small">${watching ? 'Collecting pings.' : 'Watch latency to ping it once a second.'}</p>`}

    <h3>Identity</h3>
    <dl class="facts">
      ${fact('IP', esc(h.ip))}
      ${fact('MAC', h.mac ? esc(h.mac) + (h.randomized_mac ? '<small>private address, changes per network</small>' : '') : h.is_self ? 'this machine' : '')}
      ${fact('Maker', esc(h.vendor || ''))}
      ${fact('Model', esc(model))}
      ${fact('mDNS', esc(h.mdns || ''))}
      ${fact('DNS name', esc(h.hostname || ''))}
      ${fact('NetBIOS', esc(h.netbios || ''))}
      ${fact('Web page', web)}
      ${fact('Found by', esc(h.found_by === 'arp only' ? 'ARP only. It ignores ping and every port we tried.' : h.found_by || ''))}
      ${fact('First seen', esc(ago(h.first_seen)))}
    </dl>

    <label class="parent">Plugged into
      <select data-act="parent" ${h.is_gateway ? 'disabled' : ''}>${h.is_gateway ? '<option>Nothing, it is the gateway</option>' : parentOptions(k, S.links[k])}</select>
    </label>

    <h3>Open ports</h3>
    ${ports ? `<ul class="ports-list">${ports}</ul>` : `<p class="muted small">${h.enriched ? 'None of the ports we tried were open.' : 'Still checking.'}</p>`}

    ${reasons ? `<h3>Why ${esc((KIND_NAMES[h.kind] || 'unknown').toLowerCase())}</h3><ul class="why">${reasons}</ul>` : ''}

    <div class="actions quiet">
      ${h.mac ? '<button class="btn" data-act="wake">Send wake packet</button>' : ''}
      ${h.key ? '<button class="btn danger" data-act="forget">Forget device</button>' : ''}
    </div>
  </div>`;
  drawSpark($('.spark', el), samples, SAMPLE_SLOTS);
}

function inspectExtra(el, x) {
  el.innerHTML = `<div class="insp-body">
    <div class="insp-head">
      <span class="insp-glyph">${glyph(x.kind, 28)}</span>
      <div><span class="insp-name">${esc(x.name || KIND_NAMES[x.kind])}</span><p class="insp-kind">${esc(KIND_NAMES[x.kind])}, added by you</p></div>
      <button class="icon-btn" data-act="close" aria-label="Close details">&times;</button>
    </div>
    <p class="muted">Unmanaged switches and dumb access points don't have an IP, so a scan can't see them. Add them here and plug devices into them from each device's details.</p>
    <label class="field">Name <input data-act="extra-name" maxlength="40" value="${esc(x.name || '')}"></label>
    <label class="parent">Plugged into <select data-act="parent">${parentOptions(x.id, S.links[x.id])}</select></label>
    <div class="actions quiet"><button class="btn danger" data-act="extra-remove">Remove ${esc(KIND_NAMES[x.kind].toLowerCase())}</button></div>
  </div>`;
}

function inspectOffline(el, rec) {
  el.innerHTML = `<div class="insp-body">
    <div class="insp-head">
      <span class="insp-glyph">${glyph(rec.kind, 28)}</span>
      <div>${rec.label ? `<span class="tape big tape-${esc(rec.color || 'black')}">${esc(rec.label)}</span>` : `<span class="insp-name">${esc(rec.hostname || rec.vendor || rec.ip)}</span>`}
      <p class="insp-kind">Offline, last seen ${esc(ago(rec.last_seen))}</p></div>
      <button class="icon-btn" data-act="close" aria-label="Close details">&times;</button>
    </div>
    <dl class="facts">
      ${fact('Last IP', esc(rec.ip || ''))}
      ${fact('MAC', esc(rec.mac || ''))}
      ${fact('Maker', esc(rec.vendor || ''))}
      ${fact('First seen', esc(ago(rec.first_seen)))}
    </dl>
    <div class="actions">
      ${rec.mac ? `<button class="btn" data-act="wake" data-mac="${esc(rec.mac)}">Send wake packet</button>` : ''}
      <button class="btn danger" data-act="forget" data-key="${esc(rec.key)}">Forget device</button>
    </div>
  </div>`;
}

// actions ---------------------------------------------------------------------

async function inspectorAction(act, target) {
  const h = S.hosts.get(S.selected);
  switch (act) {
    case 'close': return select(null);
    case 'label': {
      const form = $('.label-form');
      form.hidden = false;
      $('#labelInput').focus();
      return;
    }
    case 'label-cancel': $('.label-form').hidden = true; return;
    case 'watch':
      if (!h) return;
      if (S.watch.has(h.ip)) S.watch.delete(h.ip); else S.watch.add(h.ip);
      tickWatch();
      return render();
    case 'ports': {
      if (!h) return;
      S.portsBusy.add(h.ip);
      renderInspector();
      try {
        const res = await S.api.ports(h.ip);
        h.ports = res.ports;
        toast(`${res.ports.length} open on ${displayName(h)} out of ${res.checked} checked.`);
      } catch (err) {
        toast(err.message, true);
      }
      S.portsBusy.delete(h.ip);
      return render();
    }
    case 'wake': {
      const mac = target.dataset.mac || h?.mac;
      try {
        const res = await S.api.wake(mac);
        toast(`Wake packet sent to ${res.mac} on ${res.broadcast}.`);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    case 'forget': {
      const key = target.dataset.key || h?.key;
      if (!key) return;
      await S.api.forget(key).catch(() => {});
      S.known.delete(key);
      delete S.layout[key];
      delete S.links[key];
      if (h) { h.label = null; h.new = true; }
      toast('Forgotten. It will show as new next scan.');
      select(null);
      return render();
    }
    case 'extra-remove': {
      S.extras = S.extras.filter((x) => x.id !== S.selected);
      for (const [k, v] of Object.entries(S.links)) if (v === S.selected) delete S.links[k];
      delete S.links[S.selected];
      saveLayout();
      select(null);
      return render();
    }
  }
}

async function saveLabel(form) {
  const h = S.hosts.get(S.selected);
  if (!h?.key) return;
  const label = $('#labelInput').value.trim();
  const color = form.querySelector('input[name=tape]:checked')?.value || 'black';
  try {
    await S.api.label(h.key, label, color);
    h.label = label || null;
    h.color = color;
    const rec = S.known.get(h.key);
    if (rec) Object.assign(rec, { label: h.label, color });
    toast(label ? `Labelled ${label}.` : 'Label removed.');
  } catch (err) {
    toast(err.message, true);
  }
  render();
}

function addExtra(kind) {
  const n = S.extras.filter((x) => x.kind === kind).length + 1;
  const id = `${kind === 'switch' ? 'sw' : 'ap'}-${Math.random().toString(36).slice(2, 8)}`;
  S.extras.push({ id, kind, name: `${KIND_NAMES[kind]} ${n}` });
  saveLayout();
  render();
  select(id);
}

let layoutTimer;
function saveLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    S.api.layout({ layout: S.layout, extras: S.extras, links: S.links }).catch((err) => toast(err.message, true));
  }, 400);
}

function saveNodePosition(id, pos) {
  const h = S.hosts.get(id);
  const key = h ? keyOf(h) : id.startsWith('k:') ? id.slice(2) : id;
  S.layout[key] = pos;
  saveLayout();
}

// latency watch ---------------------------------------------------------------

let watchBusy = false;
async function tickWatch() {
  if (watchBusy || document.hidden) return;
  const ips = S.watchAll ? [...S.hosts.keys()] : [...S.watch].filter((ip) => S.hosts.has(ip));
  if (!ips.length) return;
  watchBusy = true;
  try {
    for (let i = 0; i < ips.length; i += 64) {
      const res = await S.api.ping(ips.slice(i, i + 64));
      for (const [ip, rtt] of Object.entries(res)) {
        const arr = S.samples.get(ip) || [];
        arr.push(rtt);
        if (arr.length > SAMPLE_SLOTS) arr.shift();
        S.samples.set(ip, arr);
        const h = S.hosts.get(ip);
        if (h) panel.plug({ ...h, rtt: rtt ?? h.rtt });
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
  watchBusy = false;
  scheduleRender();
}
setInterval(tickWatch, 1000);

// export ----------------------------------------------------------------------

function exportAs(kind) {
  const hosts = [...S.hosts.values()].sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  if (kind === 'json') {
    download(`punchdown-${stamp}.json`, JSON.stringify({ subnet: $('#silkSubnet').textContent, scanned: new Date().toISOString(), devices: hosts }, null, 2), 'application/json');
  } else if (kind === 'csv') {
    const cols = ['ip', 'mac', 'label', 'name', 'kind', 'vendor', 'rtt', 'ports', 'hostname', 'mdns', 'netbios'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = hosts.map((h) => cols.map((c) => q(c === 'ports' ? (h.ports || []).map((p) => p.port).join(' ') : h[c])).join(','));
    download(`punchdown-${stamp}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
  } else if (kind === 'svg') {
    if (S.view !== 'map') setView('map');
    const css = `.cable{fill:none;stroke-width:2.2;stroke:#9aa3ac}.band-good{stroke:#2f8a4e}.band-fair{stroke:#d9731a}.band-slow{stroke:#7a4e2d}.is-lost{stroke:#c23a2b}
      .disc{fill:#fff;stroke:#1a2230;stroke-width:1.5}.icon{color:#1a2230}.is-root .disc{fill:#1a2230}.is-root .icon{color:#fff}
      text{font-family:Poppins,Arial,sans-serif}.title{font-weight:600;font-size:11.5px;fill:#1a2230}.sub{font-size:9.5px;fill:#5b6672}
      .tape rect{fill:#1a2230}.tape text{fill:#fff;font-weight:600;font-size:10.5px}.tape-orange rect{fill:#c25e0c}.tape-green rect{fill:#2f8a4e}.tape-blue rect{fill:#2b5da6}.tape-brown rect{fill:#7a4e2d}.new-dot{fill:#d9731a}`;
    download(`punchdown-map-${stamp}.svg`, topo.toSVG(css), 'image/svg+xml');
  }
  $('.export').open = false;
}

// ui wiring -------------------------------------------------------------------

function setView(v) {
  S.view = v;
  for (const t of $$('.views [role=tab]')) t.setAttribute('aria-selected', String(t.dataset.view === v));
  render();
  if (v === 'map') setTimeout(() => topo.fit(), 30);
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('is-error', isError);
  t.classList.add('is-on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('is-on'), isError ? 6000 : 3800);
}

function cycle(dir) {
  const ips = [...S.hosts.keys()].sort((a, b) => ipNum(a) - ipNum(b));
  if (!ips.length) return;
  const i = ips.indexOf(S.selected);
  select(ips[(i + dir + ips.length) % ips.length]);
}

function bindUi() {
  $('#scanForm').addEventListener('submit', (e) => { e.preventDefault(); startScan(); });
  $('#emptyScan').addEventListener('click', () => startScan());
  for (const t of $$('.views [role=tab]')) t.addEventListener('click', () => setView(t.dataset.view));
  $('#search').addEventListener('input', (e) => { S.search = e.target.value.trim().toLowerCase(); scheduleRender(); });
  $('#showOffline').addEventListener('change', (e) => { S.showOffline = e.target.checked; render(); });
  $('#watchAll').addEventListener('change', (e) => { S.watchAll = e.target.checked; tickWatch(); render(); });
  const setJacks = (open) => {
    $('#panelToggle').setAttribute('aria-expanded', String(open));
    $('#panelToggle').textContent = open ? 'Hide jacks' : 'Show jacks';
    $('#ports').hidden = !open;
  };
  $('#panelToggle').addEventListener('click', (e) => setJacks(e.currentTarget.getAttribute('aria-expanded') !== 'true'));
  // 254 jacks on a phone is a wall, start folded there
  if (matchMedia('(max-width: 960px)').matches) setJacks(false);
  $('#mapTools').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'fit') { topo.autoFit = true; topo.fit(); }
    if (act === 'add-switch') addExtra('switch');
    if (act === 'add-ap') addExtra('access-point');
  });
  for (const b of $$('[data-export]')) b.addEventListener('click', () => exportAs(b.dataset.export));

  $('#table').addEventListener('click', (e) => {
    const sort = e.target.closest('[data-sort]')?.dataset.sort;
    if (sort) {
      S.sort = { col: sort, dir: S.sort.col === sort ? -S.sort.dir : 1 };
      return renderTable();
    }
    const row = e.target.closest('[data-ip]');
    if (row) select(row.dataset.ip);
  });

  const insp = $('#inspector');
  insp.addEventListener('click', (e) => {
    const row = e.target.closest('.link-row');
    if (row) return select(row.dataset.ip);
    const btn = e.target.closest('button[data-act]');
    if (btn) inspectorAction(btn.dataset.act, btn);
  });
  insp.addEventListener('submit', (e) => {
    if (e.target.matches('.label-form')) { e.preventDefault(); saveLabel(e.target); }
  });
  insp.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'parent') {
      const h = S.hosts.get(S.selected);
      const k = h ? keyOf(h) : S.selected.startsWith('k:') ? S.selected.slice(2) : S.selected;
      S.links[k] = e.target.value;
      saveLayout();
      render();
    } else if (e.target.dataset.act === 'extra-name') {
      const x = S.extras.find((v) => v.id === S.selected);
      if (x) { x.name = e.target.value.trim(); saveLayout(); render(); }
    }
  });

  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select');
    if (e.key === 'Escape') {
      if (typing) e.target.blur();
      else select(null);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const keys = {
      '/': () => $('#search').focus(),
      s: () => startScan(),
      m: () => setView('map'),
      l: () => setView('list'),
      f: () => { topo.autoFit = true; topo.fit(); },
      ']': () => cycle(1),
      '[': () => cycle(-1),
      w: () => S.hosts.has(S.selected) && inspectorAction('watch'),
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickWatch(); });
}

boot();
