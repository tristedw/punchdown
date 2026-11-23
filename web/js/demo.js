// A made-up house with a made-up network, used on the hosted demo. Same
// interface as the real API so the rest of the app can't tell the difference.

const SUBNET = '192.168.1.0/24';
const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

// [last octet, kind, name, vendor, mac, base rtt ms, jitter, open ports, extras]
const HOUSE = [
  [1, 'router', 'RT-AX86U', 'ASUSTek Computer', '04:d9:f5:3a:11:c0', 0.9, 0.3, [53, 80, 443, 1900], { title: 'ASUS Wireless Router RT-AX86U', upnp: { manufacturer: 'ASUSTeK Computer Inc.', modelName: 'RT-AX86U' } }],
  [2, 'access-point', 'Basement mesh node', 'ASUSTek Computer', '04:d9:f5:3a:7e:08', 2.4, 0.8, [80, 443], { title: 'ASUS Wireless Router RP-AX56' }],
  [10, 'nas', 'tank', 'Synology', '00:11:32:9c:4d:21', 0.6, 0.2, [22, 80, 139, 443, 445, 5000, 5001, 32400], { title: 'Synology DiskStation', mdns: 'tank.local' }],
  [11, 'server', 'pihole', 'Raspberry Pi', 'dc:a6:32:44:0b:9e', 0.8, 0.4, [22, 53, 80], { title: 'Pi-hole Admin Console', mdns: 'pihole.local' }],
  [12, 'server', 'homeassistant', 'Raspberry Pi', 'd8:3a:dd:12:6f:40', 1.1, 0.5, [22, 8123], { mdns: 'homeassistant.local' }],
  [20, 'computer', 'DESKTOP-TRIST', 'Micro-Star International', '04:7c:16:a2:93:5b', 0.4, 0.1, [135, 139, 445, 3389], { netbios: 'DESKTOP-TRIST' }],
  [21, 'computer', 'MacBook Pro', 'Apple', '3c:22:fb:81:0e:7a', 4.8, 3.2, [22, 445, 5900, 7000], { mdns: 'Tristans-MacBook-Pro.local' }],
  [23, 'printer', 'HP OfficeJet 8020', 'HP', 'a0:8c:fd:66:21:b3', 6.5, 4.0, [80, 443, 631, 9100], { title: 'HP OfficeJet Pro 8020 series', upnp: { modelName: 'OfficeJet Pro 8020' } }],
  [30, 'tv', 'Living Room TV', 'LG Electronics', 'a8:23:fe:0c:44:9d', 3.2, 1.5, [1900, 3000, 8008], { upnp: { friendlyName: 'Living Room TV', manufacturer: 'LG Electronics', modelName: 'OLED55C1' } }],
  [31, 'tv', 'Chromecast', 'Google', 'f4:f5:d8:7a:22:e1', 9.5, 6.0, [8008, 8009], { mdns: 'Chromecast-Bedroom.local' }],
  [32, 'speaker', 'Kitchen', 'Sonos', '5c:aa:fd:3e:90:14', 3.9, 2.1, [1400, 1443], { upnp: { friendlyName: 'Kitchen', manufacturer: 'Sonos, Inc.', modelName: 'Sonos One' } }],
  [33, 'speaker', 'Office', 'Sonos', '5c:aa:fd:3e:71:a2', 4.4, 2.5, [1400], { upnp: { friendlyName: 'Office', manufacturer: 'Sonos, Inc.', modelName: 'Sonos Era 100' } }],
  [34, 'console', 'Xbox Series X', 'Microsoft', '98:5f:d3:02:6c:4e', 1.2, 0.6, [3074], {}],
  [35, 'console', 'Nintendo Switch', 'Nintendo', '98:b6:e9:14:33:a7', 14, 9, [], {}],
  [40, 'iot', 'Hue Bridge', 'Signify Netherlands', 'ec:b5:fa:1d:88:0c', 1.9, 0.7, [80, 443], { title: 'hue personal wireless lighting', upnp: { modelName: 'Philips hue bridge 2015' } }],
  [41, 'iot', 'ecobee3 lite', 'ecobee', '44:61:32:ad:52:17', 18, 12, [], {}],
  [42, 'iot', 'garage-sensor', 'Espressif', '24:6f:28:a1:b3:9c', 22, 15, [80, 1883], { mdns: 'garage-sensor.local' }],
  [43, 'iot', 'Smart plug', 'TP-Link Systems', '50:c7:bf:62:10:3f', 26, 18, [9999], {}],
  [44, 'camera', 'Front door', 'Ring', '34:3e:a4:9f:61:50', 31, 22, [], {}],
  [101, 'phone', "Tristan's iPhone", null, '9a:41:c2:7f:0e:13', 38, 30, [62078], { mdns: 'Tristans-iPhone.local', loss: 0.12 }],
  [102, 'phone', 'Pixel 8', null, 'b2:6e:09:31:d4:aa', 44, 35, [], { loss: 0.2 }],
  [103, 'tablet', 'iPad', null, 'ce:12:8b:55:70:e9', 29, 20, [62078], { mdns: 'iPad.local', loss: 0.08 }],
  [104, 'unknown', null, null, '7e:03:51:aa:c8:42', 52, 40, [], { loss: 0.3 }],
  [150, 'computer', 'framework', 'Intel', '8c:f8:c5:2a:06:91', 5.6, 3.8, [22], { hostname: 'framework.lan' }],
];

const OFFLINE = [
  { key: 'b4:2e:99:10:7c:33', ip: '192.168.1.151', mac: 'b4:2e:99:10:7c:33', vendor: 'Dell', kind: 'computer', hostname: 'WORK-LT-0412', last_seen: NOW() - 3 * DAY, first_seen: NOW() - 60 * DAY },
  { key: '00:1e:06:44:90:2b', ip: '192.168.1.24', mac: '00:1e:06:44:90:2b', vendor: 'Wibrain', kind: 'iot', label: 'Old weather station', color: 'brown', last_seen: NOW() - 19 * DAY, first_seen: NOW() - 200 * DAY },
];

const REASONS = {
  router: ["it's the default gateway", 'answers DNS', 'admin page title looks like a router'],
  'access-point': ['made by ASUSTek Computer', 'admin page title looks like a router'],
  nas: ['made by Synology', 'Synology DSM ports open', 'SMB file sharing'],
  server: ['made by Raspberry Pi', 'SSH open', 'name looks like a server'],
  computer: ['name looks like a computer', 'SMB file sharing'],
  printer: ['print service open', 'made by HP', 'admin page title mentions a printer'],
  tv: ['Google Cast ports open', 'UPnP description says so'],
  speaker: ['made by Sonos', 'Sonos control port open'],
  console: ['made by a console maker'],
  iot: ['made by a smart home vendor'],
  camera: ['made by Ring'],
  phone: ['uses a private (randomized) MAC', 'iPhone sync port open'],
  tablet: ['uses a private (randomized) MAC', 'name looks like a tablet'],
  unknown: ['uses a private (randomized) MAC', 'nothing else answered'],
};

const SERVICES = {
  22: 'ssh', 53: 'dns', 80: 'http', 135: 'msrpc', 139: 'netbios', 443: 'https', 445: 'smb', 631: 'ipp',
  1400: 'sonos', 1443: 'sonos-tls', 1883: 'mqtt', 1900: 'upnp', 3000: 'dev-http', 3074: 'xbox-live',
  3389: 'rdp', 5000: 'upnp/synology', 5001: 'synology', 5900: 'vnc', 7000: 'airplay', 8008: 'cast',
  8009: 'cast', 8123: 'home-assistant', 9100: 'jetdirect', 9999: 'kasa', 32400: 'plex', 62078: 'iphone-sync',
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const noise = (base, jitter) => Math.max(0.2, base + (Math.random() - 0.4) * jitter);

export class DemoApi {
  constructor() {
    this.demo = true;
    this.scanState = null;
    this.saved = { layout: {}, extras: [{ id: 'sw-office', kind: 'switch', name: 'Office switch' }], links: {
      '04:7c:16:a2:93:5b': 'sw-office', '00:11:32:9c:4d:21': 'sw-office', 'dc:a6:32:44:0b:9e': 'sw-office',
      'd8:3a:dd:12:6f:40': 'sw-office', 'a0:8c:fd:66:21:b3': 'sw-office',
      'ip:192.168.1.101': '04:d9:f5:3a:7e:08', 'ip:192.168.1.102': '04:d9:f5:3a:7e:08', '98:b6:e9:14:33:a7': '04:d9:f5:3a:7e:08',
    } };
    this.labels = { 'd8:3a:dd:12:6f:40': { label: 'Home Assistant', color: 'blue' }, '24:6f:28:a1:b3:9c': { label: 'Garage door', color: 'orange' } };
    this.hosts = HOUSE.map(([oct, kind, name, vendor, mac, rtt, jitter, ports, x]) => {
      const ip = `192.168.1.${oct}`;
      const randomized = (parseInt(mac[1], 16) & 2) === 2;
      const key = randomized ? `ip:${ip}` : mac;
      return {
        ip, key, mac, kind, vendor, name, rtt, jitter,
        randomized_mac: randomized,
        is_gateway: oct === 1,
        is_self: oct === 20,
        loss: x.loss || 0,
        mdns: x.mdns || null,
        netbios: x.netbios || null,
        hostname: x.hostname || null,
        http: x.title ? { title: x.title, port: ports.includes(443) && !ports.includes(80) ? 443 : 80 } : null,
        upnp: x.upnp || null,
        ports: ports.map((p) => ({ port: p, service: SERVICES[p] || '', state: 'open' })),
        reasons: REASONS[kind],
        confidence: kind === 'unknown' ? 10 : 60 + ((oct * 7) % 35),
        found_by: oct === 35 || oct === 44 ? 'arp only' : 'ping or tcp',
        first_seen: oct === 104 ? NOW() - 60 : NOW() - (40 + oct) * DAY,
        new: oct === 104 || oct === 150,
        ...(this.labels?.[key] || {}),
      };
    });
  }

  async info() {
    await wait(120);
    return {
      hostname: 'DESKTOP-TRIST', os: 'Windows', local_ip: '192.168.1.20', gateway: '192.168.1.1',
      interfaces: [{ name: 'Ethernet', ip: '192.168.1.20', prefix: 24, network: SUBNET }],
      default_subnet: SUBNET, version: 'demo',
      known: [...OFFLINE, ...this.hosts.filter((h) => !h.new).map((h) => ({ key: h.key, ip: h.ip, mac: h.mac, vendor: h.vendor, kind: h.kind, label: h.label, color: h.color, first_seen: h.first_seen, last_seen: NOW() - DAY }))],
      ...this.saved,
      scanning: false,
    };
  }

  async state() {
    return { running: false, hosts: [] };
  }

  async scan(subnet, thorough) {
    if (subnet.replace(/\s/g, '') !== SUBNET) {
      throw new Error(`The demo house only has ${SUBNET}. Run punchdown locally to scan your own.`);
    }
    this.scanState = { thorough, cancelled: false };
    return { subnet: SUBNET, count: 254 };
  }

  async cancel() {
    if (this.scanState) this.scanState.cancelled = true;
    return { ok: true };
  }

  async events(_from, onEvent) {
    const st = this.scanState;
    const t0 = performance.now();
    onEvent({ type: 'start', subnet: SUBNET, first: '192.168.1.1', count: 254, gateway: '192.168.1.1', local_ip: '192.168.1.20', thorough: st.thorough });
    const byOct = new Map(this.hosts.map((h) => [Number(h.ip.split('.')[3]), h]));
    const basic = (h) => ({ ip: h.ip, rtt: h.found_by === 'arp only' ? null : h.rtt, found_by: h.found_by, is_gateway: h.is_gateway, is_self: h.is_self, kind: h.is_gateway ? 'router' : 'unknown', ports: [], enriched: false });

    // Real sweeps finish out of order because dead addresses wait out their
    // timeouts. Shuffle in chunks so the panel fills the same lumpy way.
    const order = Array.from({ length: 254 }, (_, i) => i + 1);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.max(0, i - Math.floor(Math.random() * 40));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let i = 0; i < order.length; i += 6) {
      if (st.cancelled) break;
      for (const oct of order.slice(i, i + 6)) {
        const h = byOct.get(oct);
        onEvent({ type: 'probe', ip: `192.168.1.${oct}`, alive: !!h });
        if (h) onEvent({ type: 'host', host: basic(h) });
      }
      await wait(28);
    }
    onEvent({ type: 'phase', phase: 'identify', hosts: this.hosts.length });
    for (const h of [...this.hosts].sort(() => Math.random() - 0.5)) {
      if (st.cancelled) break;
      await wait(70 + Math.random() * 110);
      const { jitter, loss, ...rest } = h;
      onEvent({ type: 'host', host: { ...rest, enriched: true, rtt: h.found_by === 'arp only' ? null : +noise(h.rtt, h.jitter).toFixed(2) } });
    }
    onEvent({ type: 'done', cancelled: st.cancelled, hosts: this.hosts.length, seconds: +((performance.now() - t0) / 1000).toFixed(1) });
  }

  async ping(ips) {
    await wait(60);
    const out = {};
    for (const ip of ips) {
      const h = this.hosts.find((x) => x.ip === ip);
      out[ip] = !h || Math.random() < h.loss ? null : +noise(h.rtt, h.jitter).toFixed(2);
    }
    return out;
  }

  async ports(ip) {
    await wait(1400);
    const h = this.hosts.find((x) => x.ip === ip);
    return { ip, checked: 1047, ports: h ? h.ports : [] };
  }

  async label(key, label, color) {
    this.labels[key] = { label: label || null, color };
    return { key, label: label || null, color };
  }

  async layout(payload) {
    Object.assign(this.saved, payload);
    return { ok: true };
  }

  async forget() {
    return { ok: true };
  }

  async wake(mac) {
    await wait(200);
    return { sent: true, mac, broadcast: '192.168.1.255' };
  }
}
