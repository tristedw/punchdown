// Line glyphs for each device kind. Drawn on a 24 grid, stroke only, so they
// pick up currentColor and stay crisp at the 14-18px they're used at.

const P = {
  router: '<rect x="3" y="13" width="18" height="6" rx="1"/><path d="M7 16h.01M10 16h.01"/><path d="M8 13l-2-6M16 13l2-6"/>',
  'access-point': '<circle cx="12" cy="15" r="3.5"/><path d="M7.5 8.5a6.5 6.5 0 0 1 9 0M5 6a10 10 0 0 1 14 0"/>',
  computer: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  tablet: '<rect x="4.5" y="2.5" width="15" height="19" rx="2"/><path d="M11 18.5h2"/>',
  tv: '<rect x="2.5" y="4" width="19" height="13" rx="1"/><path d="M9 21l3-4 3 4"/>',
  speaker: '<rect x="6" y="2.5" width="12" height="19" rx="2"/><circle cx="12" cy="14" r="3.5"/><path d="M12 6.5h.01"/>',
  printer: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="1"/><path d="M7 14h10v7H7z"/>',
  nas: '<rect x="5" y="2.5" width="14" height="19" rx="1"/><path d="M8 7h8M8 11h8M8 15h8M15.5 18.5h.01"/>',
  console: '<path d="M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 14h-4l-1 1.6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4z"/><path d="M7 11v3M5.5 12.5h3M16 12h.01M18 11h.01"/>',
  camera: '<rect x="2.5" y="6" width="13" height="10" rx="1"/><path d="M15.5 10l6-3v10l-6-3"/><path d="M6 21l3-5"/>',
  iot: '<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/><rect x="10" y="10" width="4" height="4"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="1"/><rect x="3" y="14" width="18" height="7" rx="1"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  switch: '<rect x="2.5" y="8" width="19" height="8" rx="1"/><path d="M6 12h1.5M9.5 12H11M13 12h1.5M16.5 12H18"/>',
  unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01"/>',
};

export function glyph(kind, size = 18) {
  const body = P[kind] || P.unknown;
  return `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function glyphBody(kind) {
  return P[kind] || P.unknown;
}

export const KIND_NAMES = {
  router: 'Router',
  'access-point': 'Access point',
  computer: 'Computer',
  phone: 'Phone',
  tablet: 'Tablet',
  tv: 'TV or streamer',
  speaker: 'Speaker',
  printer: 'Printer',
  nas: 'Storage (NAS)',
  console: 'Game console',
  camera: 'Camera',
  iot: 'Smart home',
  server: 'Server',
  switch: 'Switch',
  unknown: 'Unidentified',
};
