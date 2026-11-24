/* ClimaGrid PWA — dashboard cuaca & iklim terdistribusi (demo) */
'use strict';

/* ============================== utils ============================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
function rand(seed) { return hashStr(String(seed)); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function fmtTime(d) { return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); }
function fmtClock(d) { return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/\./g, ':'); }
function timeAgo(d) {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, n >> 8 & 255, n & 255]; }
function colorAt(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      const ca = hexRgb(a[1]), cb = hexRgb(b[1]);
      return `rgb(${Math.round(ca[0] + (cb[0] - ca[0]) * k)},${Math.round(ca[1] + (cb[1] - ca[1]) * k)},${Math.round(ca[2] + (cb[2] - ca[2]) * k)})`;
    }
  }
  return stops[stops.length - 1][1];
}
function valueColor(variable, value) {
  const v = VARIABLES[variable];
  return colorAt(v.stops, (value - v.domain[0]) / (v.domain[1] - v.domain[0]));
}
function diurnal(hour) { return 3.0 * Math.sin((hour - 9) * Math.PI / 12); }

/* ============================== data prep ============================== */
const state = {
  view: 'dashboard', variable: 'temp', timeOffset: 0, interp: true,
  alertFilter: 'all', stationFilter: 'all', query: '',
  tick: 0, readings: 1284512, selected: null, focusStation: null,
  alerts: [], started: Date.now()
};

function rainAt(s, hoursAgo) {
  const r = rand(s.id + 'rain' + hoursAgo);
  if (s.rainBase >= 20) {
    const peak = Math.exp(-(hoursAgo * hoursAgo) / 7);
    return Math.max(0, s.rainBase * peak * (0.78 + r * 0.34));
  }
  if (s.rainBase > 0) {
    const peak = Math.exp(-Math.pow(hoursAgo - 3, 2) / 5);
    return Math.max(0, s.rainBase * 2.4 * peak * (0.6 + r * 0.8));
  }
  if (r > 0.9) return (r - 0.9) * 70;
  if (r > 0.82) return (r - 0.82) * 18;
  return 0;
}

function buildHistory(s, now) {
  const out = [];
  for (let i = 23; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 3600000);
    const h = t.getHours() + t.getMinutes() / 60;
    const temp = s.tempBase + diurnal(h) + (rand(s.id + 't' + i) - 0.5) * 1.3;
    const rh = clamp(s.rhBase - (temp - s.tempBase) * 1.7 + (rand(s.id + 'h' + i) - 0.5) * 5, 28, 98);
    const rain = rainAt(s, i);
    const wind = s.windBase + (rand(s.id + 'w' + i) - 0.5) * 6 + (h > 10 && h < 17 ? 3 : 0);
    out.push({ t, temp, rh, rain, wind });
  }
  return out;
}

function refreshCurrent() {
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60;
  STATIONS.forEach((s, idx) => {
    if (s.status === 'offline') {
      const last = s.history[s.history.length - 1];
      s.values = { ...last, at: new Date(now.getTime() - 2 * 3600000) };
      return;
    }
    const j = Math.sin(state.tick * 0.35 + s._seed * 9) * 0.35;
    const temp = s.tempBase + diurnal(h) + j + (rand(s.id + 'tick' + Math.floor(state.tick / 4)) - 0.5) * 0.5;
    const rh = clamp(s.rhBase - (temp - s.tempBase) * 1.7 + (rand(s.id + 'rh' + Math.floor(state.tick / 5)) - 0.5) * 2.5, 28, 98);
    const rain = Math.max(0, s.rainBase * (0.92 + 0.1 * Math.sin(state.tick * 0.22 + idx)));
    const wind = Math.max(0, s.windBase + 2.4 * Math.sin(state.tick * 0.3 + idx));
    s.values = { t: now, temp, rh, rain, wind, at: now };
  });
}

function valueAt(s, variable, offset) {
  if (offset === 0) return s.values[variable];
  const idx = clamp(23 - offset, 0, 23);
  return s.history[idx][variable];
}

const now0 = new Date();
STATIONS.forEach(s => {
  s._seed = hashStr(s.id);
  s.history = buildHistory(s, now0);
});
refreshCurrent();

/* ============================== alerts ============================== */
function buildAlerts() {
  const out = [];
  const now = Date.now();
  STATIONS.forEach(s => {
    if (s.status !== 'online') return;
    const checks = [
      ['heat', s.values.temp, s.values.temp >= ALERT_RULES.heat.high, s.values.temp >= ALERT_RULES.heat.medium],
      ['rain', s.values.rain, s.values.rain >= ALERT_RULES.rain.high, s.values.rain >= ALERT_RULES.rain.medium],
      ['dry', s.values.rh, s.values.rh <= ALERT_RULES.dry.high, s.values.rh <= ALERT_RULES.dry.medium],
      ['wind', s.values.wind, s.values.wind >= ALERT_RULES.wind.high, s.values.wind >= ALERT_RULES.wind.medium]
    ];
    checks.forEach(([key, value, high, active]) => {
      if (!active) return;
      const rule = ALERT_RULES[key];
      const sev = high ? 'high' : 'medium';
      const mins = Math.round(4 + rand(s.id + key + 'm') * (high ? 34 : 70));
      const unit = key === 'rain' ? 'mm/jam' : key === 'wind' ? 'km/j' : key === 'dry' ? '%' : '°C';
      const num = key === 'rain' || key === 'wind' || key === 'dry' ? Math.round(value) : nf1.format(value);
      const desc = key === 'heat'
        ? `Suhu terpantau ${nf1.format(value)}°C di ${s.area}, di atas ambang nyaman untuk aktivitas luar ruang.`
        : key === 'rain'
          ? `Intensitas ${Math.round(value)} mm/jam terpantau di ${s.area}; potensi genangan dalam 1–2 jam.`
          : key === 'dry'
            ? `Kelembapan turun ke ${Math.round(value)}%; penguapan tinggi dan risiko debu di ${s.area}.`
            : `Angin ${Math.round(value)} km/jam di ${s.area}; gelombang pesisir dan operasi laut perlu waspada.`;
      out.push({
        id: `${s.id}-${key}`, stationId: s.id, station: s, key, rule, severity: sev, value, num, unit,
        title: `${rule.label} di ${s.area}`, desc, advice: rule.advice,
        at: new Date(now - mins * 60000), status: 'active'
      });
    });
  });
  out.push({
    id: 'done-jbr', stationId: 'JBR-01', station: STATIONS.find(s => s.id === 'JBR-01'),
    key: 'rain', rule: ALERT_RULES.rain, severity: 'high', value: 46, num: 46, unit: 'mm/jam',
    title: 'Hujan lebat di Jember', desc: 'Peringatan telah berakhir setelah intensitas hujan turun di bawah 20 mm/jam.',
    advice: 'Pantau genangan sisa dan pastikan drainase kembali normal.', at: new Date(now - 2.2 * 3600000), status: 'done'
  });
  out.push({
    id: 'done-grk', stationId: 'GRK-01', station: STATIONS.find(s => s.id === 'GRK-01'),
    key: 'heat', rule: ALERT_RULES.heat, severity: 'medium', value: 33.1, num: '33,1', unit: '°C',
    title: 'Suhu tinggi di Gresik', desc: 'Suhu kembali normal setelah puncak siang berlalu.',
    advice: 'Tetap jaga hidrasi pada aktivitas sore.', at: new Date(now - 5.4 * 3600000), status: 'done'
  });
  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => (a.status === b.status ? (rank[a.severity] - rank[b.severity]) || (b.at - a.at) : a.status === 'active' ? -1 : 1));
  return out;
}
state.alerts = buildAlerts();

/* ============================== charts ============================== */
let chartSeq = 0;
function chartData() {
  const online = STATIONS.filter(s => s.status === 'online');
  const temp = [], rain = [];
  for (let i = 0; i < 24; i++) {
    temp.push(avg(online.map(s => s.history[i].temp)));
    rain.push(Math.max(...online.map(s => s.history[i].rain)));
  }
  return { temp, rain, times: online[0].history.map(h => h.t) };
}

function lineChart(values, times, opts = {}) {
  const W = 640, H = opts.height || 220;
  const P = { l: 36, r: 14, t: 14, b: 28 };
  const id = 'lg' + (++chartSeq);
  const minV = Math.min(...values), maxV = Math.max(...values);
  const pad = Math.max(0.5, (maxV - minV) * 0.25);
  let lo = Math.floor(minV - pad), hi = Math.ceil(maxV + pad);
  if (opts.domain) { lo = opts.domain[0]; hi = opts.domain[1]; }
  const x = i => P.l + (i / (values.length - 1)) * (W - P.l - P.r);
  const y = v => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = 'M' + pts.join(' L');
  const area = `${line} L${x(values.length - 1).toFixed(1)},${H - P.b} L${P.l},${H - P.b} Z`;
  const grid = [];
  for (let i = 0; i < 4; i++) {
    const v = lo + (hi - lo) * i / 3;
    const yy = y(v);
    grid.push(`<line x1="${P.l}" y1="${yy.toFixed(1)}" x2="${W - P.r}" y2="${yy.toFixed(1)}" stroke="#E3ECE9" stroke-width="1"/>`);
    grid.push(`<text x="${P.l - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="12.5" fill="#8CA0A5">${opts.fmtY ? opts.fmtY(v) : Math.round(v)}</text>`);
  }
  const xl = [];
  [0, 6, 12, 18, 23].forEach(i => {
    const t = times[i];
    const label = i === 23 ? 'Skrg' : String(t.getHours()).padStart(2, '0') + ':00';
    xl.push(`<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 23 ? 'end' : 'middle'}" font-size="12.5" fill="#8CA0A5">${label}</text>`);
  });
  const lastX = x(values.length - 1), lastY = y(values[values.length - 1]);
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'Grafik')}">
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${opts.color || '#0F6B62'}" stop-opacity=".22"/>
    <stop offset="1" stop-color="${opts.color || '#0F6B62'}" stop-opacity="0"/>
  </linearGradient></defs>
  ${grid.join('')}
  <path d="${area}" fill="url(#${id})"/>
  <path d="${line}" fill="none" stroke="${opts.color || '#0F6B62'}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4.4" fill="#FCFEFD" stroke="${opts.color || '#0F6B62'}" stroke-width="2.6"/>
  ${xl.join('')}
</svg>`;
}

function barChart(values, times, opts = {}) {
  const W = 640, H = 220;
  const P = { l: 36, r: 14, t: 14, b: 28 };
  const maxV = Math.max(10, Math.ceil(Math.max(...values) / 10) * 10);
  const bw = (W - P.l - P.r) / values.length;
  const y = v => P.t + (1 - v / maxV) * (H - P.t - P.b);
  const grid = [];
  for (let i = 0; i < 4; i++) {
    const v = maxV * i / 3, yy = y(v);
    grid.push(`<line x1="${P.l}" y1="${yy.toFixed(1)}" x2="${W - P.r}" y2="${yy.toFixed(1)}" stroke="#E3ECE9" stroke-width="1"/>`);
    grid.push(`<text x="${P.l - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="12.5" fill="#8CA0A5">${Math.round(v)}</text>`);
  }
  const bars = values.map((v, i) => {
    const h = Math.max(v > 0 ? 2 : 0, (H - P.t - P.b) * (v / maxV));
    const xx = P.l + i * bw + bw * 0.2;
    const isLast = i === 23;
    return `<rect x="${xx.toFixed(1)}" y="${(H - P.b - h).toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${isLast ? '#F2B13A' : '#2E8B7F'}" opacity="${isLast ? '1' : '.8'}"><title>${nf0.format(v)} ${opts.unit || ''}</title></rect>`;
  });
  const xl = [0, 6, 12, 18, 23].map(i => {
    const t = times[i], label = i === 23 ? 'Skrg' : String(t.getHours()).padStart(2, '0') + ':00';
    const xx = P.l + i * bw + bw / 2;
    return `<text x="${xx.toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 23 ? 'end' : 'middle'}" font-size="12.5" fill="#8CA0A5">${label}</text>`;
  });
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'Grafik')}">
  ${grid.join('')}${bars.join('')}${xl.join('')}
</svg>`;
}

/* ============================== map ============================== */
const MAP = { W: 760, H: 440, lon0: 110.85, lon1: 114.65, lat0: -8.85, lat1: -6.65 };
const project = (lon, lat) => [
  (lon - MAP.lon0) / (MAP.lon1 - MAP.lon0) * MAP.W,
  (MAP.lat1 - lat) / (MAP.lat1 - MAP.lat0) * MAP.H
];
const landPath = EAST_JAVA.map(ring => 'M' + ring.map(p => {
  const [x, y] = project(p[0], p[1]);
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}).join(' L') + ' Z').join(' ');

function idw(lon, lat, variable, offset) {
  let num = 0, den = 0;
  const cos = Math.cos(lat * Math.PI / 180);
  for (const s of STATIONS) {
    const dx = (lon - s.lon) * cos, dy = lat - s.lat;
    const d2 = dx * dx + dy * dy;
    const w = 1 / (Math.pow(d2, 1.12) + 0.00035);
    num += valueAt(s, variable, offset) * w;
    den += w;
  }
  return num / den;
}

function heatURL(variable, offset) {
  const w = 190, h = 112;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const v = VARIABLES[variable];
  for (let y = 0; y < h; y++) {
    const lat = MAP.lat1 - (y + 0.5) / h * (MAP.lat1 - MAP.lat0);
    for (let x = 0; x < w; x++) {
      const lon = MAP.lon0 + (x + 0.5) / w * (MAP.lon1 - MAP.lon0);
      const val = idw(lon, lat, variable, offset);
      const t = clamp((val - v.domain[0]) / (v.domain[1] - v.domain[0]), 0, 1);
      const rgb = colorAt(v.stops, t).replace('rgb(', '').replace(')', '').split(',').map(Number);
      const i = (y * w + x) * 4;
      img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function mapDots() {
  return STATIONS.map(s => {
    const [x, y] = project(s.lon, s.lat);
    const v = valueAt(s, state.variable, state.timeOffset);
    const c = s.status === 'offline' ? '#8FA3A3' : valueColor(state.variable, v);
    const sel = state.focusStation === s.id;
    const unit = VARIABLES[state.variable].unit;
    return `<g class="map-station" data-station="${s.id}" tabindex="0" role="button" aria-label="${esc(s.name)}: ${nf1.format(v)} ${unit}">
      ${sel ? `<circle class="map-ring" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="none" stroke="#F2B13A" stroke-width="2" opacity=".9"/>` : ''}
      <circle class="map-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${sel ? 6 : 4.8}" fill="${c}" stroke="#FCFEFD" stroke-width="1.8"/>
    </g>`;
  }).join('');
}

function mapSVG() {
  const V = VARIABLES[state.variable];
  const heat = state.interp ? heatURL(state.variable, state.timeOffset) : null;
  const cityLabels = CITY_LABELS.map(c => {
    const [x, y] = project(c.lon, c.lat);
    return `<text class="city-label" x="${(x + (c.dx || 0)).toFixed(1)}" y="${(y + (c.dy || 0)).toFixed(1)}" text-anchor="middle" font-size="9.4" font-weight="600" fill="#41605F" paint-order="stroke" stroke="#EAF3F2" stroke-width="2.6" stroke-linejoin="round">${esc(c.name)}</text>`;
  }).join('');
  const grid = [];
  for (let lon = 111.5; lon < 114.6; lon += 0.5) {
    const [x] = project(lon, 0);
    grid.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${MAP.H}" stroke="#BFD6D2" stroke-width=".6" opacity=".5"/>`);
  }
  for (let lat = -8.5; lat < -6.7; lat += 0.5) {
    const [, y] = project(0, lat);
    grid.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${MAP.W}" y2="${y.toFixed(1)}" stroke="#BFD6D2" stroke-width=".6" opacity=".5"/>`);
  }
  return `<svg id="mapSvg" viewBox="0 0 ${MAP.W} ${MAP.H}" role="img" aria-label="Peta interpolasi ${V.label.toLowerCase()} Jawa Timur">
  <defs>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#EAF3F2"/><stop offset="1" stop-color="#D9EAE6"/>
    </linearGradient>
    <clipPath id="landClip"><path d="${landPath}"/></clipPath>
    <filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="dotShadow" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="1.4" stdDeviation="1.4" flood-color="#0B2530" flood-opacity=".35"/></filter>
  </defs>
  <rect width="${MAP.W}" height="${MAP.H}" fill="url(#sea)"/>
  <g>${grid.join('')}</g>
  <path d="${landPath}" fill="#E9F2F0" stroke="none"/>
  ${heat ? `<image href="${heat}" x="0" y="0" width="${MAP.W}" height="${MAP.H}" preserveAspectRatio="none" clip-path="url(#landClip)" filter="url(#soft)" opacity=".88"/>` : ''}
  <path d="${landPath}" fill="none" stroke="#9FBCB7" stroke-width="1.35" opacity=".9"/>
  <g>${cityLabels}</g>
  <g filter="url(#dotShadow)">${mapDots()}</g>
</svg>`;
}

function legendHTML() {
  const V = VARIABLES[state.variable];
  const grad = V.stops.map(([p, c]) => `${c} ${Math.round(p * 100)}%`).join(',');
  return `<div class="map-overlay">
    <div class="legend-title">${V.label} (${V.unit})</div>
    <div class="legend-bar" style="background:linear-gradient(90deg,${grad})"></div>
    <div class="legend-scale"><span>${V.domain[0]}</span><span>${V.domain[1]}</span></div>
  </div>`;
}

function mapCardHTML() {
  const V = VARIABLES[state.variable];
  const chips = STATIONS.slice().sort((a, b) => valueAt(b, state.variable, state.timeOffset) - valueAt(a, state.variable, state.timeOffset))
    .map(s => `<button class="chip-station" data-station="${s.id}"><span class="dotstatus ${s.status === 'offline' ? 'off' : ''}"></span><strong>${esc(s.area)}</strong><span>${nf1.format(valueAt(s, state.variable, state.timeOffset))} ${V.unit === '%' ? '%' : V.unit === '°C' ? '°' : ''}</span></button>`).join('');
  const active = state.alerts.filter(a => a.status === 'active').length;
  return `<div class="card map-card" id="mapCard">
    <div class="map-toolbar">
      <div class="tool-group">
        <span class="tool-label">Variabel</span>
        <div class="segmented" role="group" aria-label="Pilih variabel peta">
          ${Object.entries(VARIABLES).map(([k, v]) => `<button data-var="${k}" class="${state.variable === k ? 'active' : ''}">${v.short}</button>`).join('')}
        </div>
        <span class="tool-label" style="margin-left:8px">Waktu</span>
        <div class="segmented mini" role="group" aria-label="Pilih waktu">
          <button data-time="0" class="${state.timeOffset === 0 ? 'active' : ''}">Sekarang</button>
          <button data-time="3" class="${state.timeOffset === 3 ? 'active' : ''}">−3 jam</button>
          <button data-time="6" class="${state.timeOffset === 6 ? 'active' : ''}">−6 jam</button>
        </div>
      </div>
      <label class="toggle"><input type="checkbox" id="interpToggle" ${state.interp ? 'checked' : ''} data-interp><span>Interpolasi IDW</span></label>
    </div>
    <div class="map-wrap">
      ${mapSVG()}
      ${legendHTML()}
      <div class="map-meta"><svg class="ico"><use href="#i-layers"/></svg><span>${state.interp ? 'IDW · 20 titik' : 'Tanpa interpolasi'}</span></div>
    </div>
    <div class="map-strip">${chips}</div>
  </div>`;
}

/* ============================== shared partials ============================== */
function stationRows(limit) {
  const list = STATIONS.filter(s => s.status === 'online').sort((a, b) => b.values.temp - a.values.temp).slice(0, limit);
  return list.map(s => `<div class="station-row" data-station="${s.id}" role="button" tabindex="0">
    <div class="st-name"><span class="dotstatus ${s.status === 'offline' ? 'off' : ''}"></span><div><strong>${esc(s.area)}</strong><small>${esc(s.kab)}</small></div></div>
    <div><span class="num" data-st="${s.id}-temp">${nf1.format(s.values.temp)}°</span><span class="sub">suhu</span></div>
    <div><span class="num" data-st="${s.id}-rain">${nf0.format(s.values.rain)}</span><span class="sub">mm/jam</span></div>
    <div class="hide-sm"><span class="num" data-st="${s.id}-rh">${nf0.format(s.values.rh)}%</span><span class="sub">RH</span></div>
    <span class="chev"><svg class="ico"><use href="#i-chevron"/></svg></span>
  </div>`).join('');
}

function alertItem(a) {
  const sevClass = a.severity === 'high' ? '' : a.severity === 'medium' ? 'med' : 'low';
  return `<div class="am" data-alert="${a.id}">
    <div class="am-ico ${sevClass === 'med' ? 'med' : ''}"><svg class="ico"><use href="#${a.rule.icon}"/></svg></div>
    <div class="am-body"><strong>${esc(a.title)}</strong><span>${timeAgo(a.at)} · ${esc(a.station.kab)}</span></div>
    <div class="am-val ${sevClass === 'med' ? 'med' : ''}">${a.num}${a.unit === '%' ? '%' : a.unit === '°C' ? '°' : ''}</div>
  </div>`;
}

function alertCards() {
  let list = state.alerts.filter(a => state.alertFilter === 'all' ? a.status === 'active' : state.alertFilter === 'done' ? a.status === 'done' : a.status === 'active' && a.severity === state.alertFilter);
  if (!list.length) return `<div class="card empty" style="grid-column:1/-1"><svg class="ico"><use href="#i-check"/></svg><div>Tidak ada peringatan pada filter ini.</div></div>`;
  return list.map(a => {
    const sevClass = a.status === 'done' ? 'sev-done' : a.severity === 'high' ? '' : a.severity === 'medium' ? 'sev-medium' : 'sev-low';
    const badge = a.status === 'done' ? 'Selesai' : a.severity === 'high' ? 'Tinggi' : a.severity === 'medium' ? 'Sedang' : 'Rendah';
    const badgeClass = a.status === 'done' ? 'done' : a.severity === 'high' ? '' : a.severity === 'medium' ? 'medium' : 'low';
    return `<article class="card alert-card ${sevClass}">
      <div class="ac-top">
        <div class="ac-title"><svg class="ico"><use href="#${a.rule.icon}"/></svg>${esc(a.title)}</div>
        <span class="sev-badge ${badgeClass}">${badge}</span>
      </div>
      <div class="ac-meta"><span>${esc(a.station.kab)}</span><span>·</span><b>${timeAgo(a.at)}</b><span>·</span><span>${a.station.id}</span></div>
      <p class="ac-desc">${esc(a.desc)}</p>
      <div class="ac-foot">
        <div class="ac-value">${a.num}<small>${a.unit}</small></div>
        <button class="link" data-station="${a.stationId}">Lihat stasiun <svg class="ico"><use href="#i-arrow"/></svg></button>
      </div>
    </article>`;
  }).join('');
}

/* ============================== views ============================== */
function viewDashboard() {
  const online = STATIONS.filter(s => s.status === 'online');
  const tempNow = avg(online.map(s => s.values.temp));
  const rhNow = avg(online.map(s => s.values.rh));
  const pressNow = avg(online.map(s => 1012 - s.elev * 0.011));
  const maxRain = Math.max(...online.map(s => s.values.rain));
  const active = state.alerts.filter(a => a.status === 'active');
  const high = active.filter(a => a.severity === 'high').length;
  const data = chartData();
  const totalRain = Math.max(...data.rain);
  const tempLast = avg(online.map(s => s.values.temp));
  const yesterday = avg(online.map(s => s.history[23].temp));
  const diff = tempLast - yesterday;

  return `<div class="page-head">
    <div><div class="eyebrow">Ringkasan wilayah</div><h2>Jawa Timur hari ini</h2>
      <p class="sub">Pantauan 20 stasiun otomatis, diolah paralel di 3 node Chord dan disajikan dari cache edge.</p></div>
    <div class="page-actions">
      <a class="btn ghost" href="#/map"><svg class="ico"><use href="#i-map"/></svg><span>Buka peta</span></a>
    </div>
  </div>

  <div class="hero-grid">
    <section class="hero">
      <div class="hero-top">
        <div><div class="eyebrow">Rata-rata 20 stasiun</div>
          <div class="hero-loc"><span class="dot"></span>Jatim <span class="sep">·</span> <span id="heroUpdated">${fmtTime(new Date())}</span></div>
        </div>
        <div class="hero-badge"><svg class="ico" style="width:13px;height:13px"><use href="#i-alert"/></svg>${high} peringatan tinggi</div>
      </div>
      <div class="hero-big"><span class="num" id="heroTemp">${nf1.format(tempNow)}</span><span class="deg">°C</span></div>
      <div class="hero-sub">Rata-rata suhu <b>${diff >= 0 ? '+' : ''}${nf1.format(diff)}°C</b> dibanding jam yang sama kemarin · <b>${active.length} peringatan aktif</b></div>
      <div class="hero-metrics">
        <div class="hero-metric"><div class="lbl"><svg class="ico"><use href="#i-humidity"/></svg>Kelembapan</div><div class="val">${nf0.format(rhNow)}<small>%</small></div></div>
        <div class="hero-metric"><div class="lbl"><svg class="ico"><use href="#i-rain"/></svg>Hujan tertinggi</div><div class="val">${nf0.format(maxRain)}<small>mm/jam</small></div></div>
        <div class="hero-metric"><div class="lbl"><svg class="ico"><use href="#i-gauge"/></svg>Tekanan</div><div class="val">${nf0.format(pressNow)}<small>hPa</small></div></div>
      </div>
      <svg class="hero-spark" viewBox="0 0 160 46" aria-hidden="true">
        <path d="${sparkPath(data.temp, 160, 46)}" fill="none" stroke="#5FD3C4" stroke-width="1.8" opacity=".8"/>
      </svg>
    </section>

    <section class="card alert-summary">
      <div class="alert-summary-head"><span><svg class="ico"><use href="#i-alert"/></svg>Peringatan dini</span><span style="font-size:10.5px;font-weight:600;color:#6B4413">30 menit terakhir</span></div>
      <div class="as-count"><strong>${active.length}</strong><span>aktif · ${high} tinggi</span></div>
      <div class="as-list">
        ${active.slice(0, 3).map(a => `<div class="as-item"><span class="sev ${a.severity === 'medium' ? 'medium' : a.severity === 'low' ? 'low' : ''}"></span><span>${esc(a.title)}</span><time>${timeAgo(a.at)}</time></div>`).join('')}
      </div>
      <div class="as-foot"><a class="link" style="color:#6B4413" href="#/alerts">Lihat semua peringatan <svg class="ico"><use href="#i-arrow"/></svg></a></div>
    </section>
  </div>

  <div class="kpis">
    <div class="kpi card"><div class="kpi-top"><div class="kpi-ico"><svg class="ico"><use href="#i-stations"/></svg></div><span class="kpi-delta">95% online</span></div>
      <div class="kpi-val">${online.length}<small>/ ${STATIONS.length}</small></div><div class="kpi-lbl">Stasiun aktif</div></div>
    <div class="kpi card"><div class="kpi-top"><div class="kpi-ico"><svg class="ico"><use href="#i-layers"/></svg></div><span class="kpi-delta">+83/dtk</span></div>
      <div class="kpi-val" id="kpiReadings">${nf0.format(state.readings)}</div><div class="kpi-lbl">Pembacaan hari ini</div></div>
    <div class="kpi card"><div class="kpi-top"><div class="kpi-ico"><svg class="ico"><use href="#i-gauge"/></svg></div><span class="kpi-delta warm">MPI 16 rank</span></div>
      <div class="kpi-val">3<small>job</small></div><div class="kpi-lbl">Analitik berjalan</div></div>
    <div class="kpi card"><div class="kpi-top"><div class="kpi-ico" style="background:var(--danger-soft);color:var(--danger)"><svg class="ico"><use href="#i-bell"/></svg></div><span class="kpi-delta warm">${high} tinggi</span></div>
      <div class="kpi-val" id="kpiAlerts">${active.length}<small>aktif</small></div><div class="kpi-lbl">Peringatan dini</div></div>
  </div>

  <div class="charts">
    <section class="card chart-card">
      <div class="chart-head"><div><h3>Suhu rata-rata 24 jam</h3><p>Rata-rata seluruh stasiun online per jam</p></div>
        <div class="chart-total"><strong>${nf1.format(tempNow)}°</strong><span>saat ini</span></div></div>
      <div class="chart-body" id="tempChart">${lineChart(data.temp, data.times, { color: '#0F6B62', label: 'Suhu rata-rata 24 jam', fmtY: v => Math.round(v) + '°' })}</div>
      <div class="chart-legend"><span><i style="background:#0F6B62"></i>Rata-rata wilayah</span><span style="margin-left:auto">Sumber: 19 stasiun online</span></div>
    </section>

    <section class="card chart-card">
      <div class="chart-head"><div><h3>Curah hujan tertinggi</h3><p>Nilai maksimum antarstasiun per jam</p></div>
        <div class="chart-total"><strong>${nf0.format(totalRain)}<small style="font-size:11px"> mm</small></strong><span>puncak 24 jam</span></div></div>
      <div class="chart-body" id="rainChart">${barChart(data.rain, data.times, { unit: 'mm/jam', label: 'Curah hujan tertinggi 24 jam' })}</div>
      <div class="chart-legend"><span><i style="background:#2E8B7F"></i>Stasiun tertinggi</span><span><i style="background:#F2B13A"></i>Jam ini</span></div>
    </section>
  </div>

  <div class="lower">
    <section class="card list-card">
      <div class="card-head"><div><h3>Stasiun terpanas</h3><p>Diurutkan dari suhu terkini</p></div><a class="link" href="#/stations">Semua stasiun <svg class="ico"><use href="#i-arrow"/></svg></a></div>
      <div class="row-head"><span>Stasiun</span><span>Suhu</span><span>Hujan</span><span class="hide-sm">RH</span><span></span></div>
      <div class="station-rows">${stationRows(5)}</div>
    </section>

    <section class="card list-card">
      <div class="card-head"><div><h3>Peringatan aktif</h3><p>Butuh tindak lanjut lapangan</p></div><a class="link" href="#/alerts">Detail <svg class="ico"><use href="#i-arrow"/></svg></a></div>
      <div class="alerts-mini">${active.slice(0, 3).map(alertItem).join('')}</div>
    </section>
  </div>`;
}

function sparkPath(values, w, h) {
  const min = Math.min(...values), max = Math.max(...values);
  const pts = values.map((v, i) => [i / (values.length - 1) * w, h - ((v - min) / Math.max(1e-6, max - min) * (h - 6)) - 3]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i], mx = (p0[0] + p1[0]) / 2;
    d += ` C${mx.toFixed(1)},${p0[1].toFixed(1)} ${mx.toFixed(1)},${p1[1].toFixed(1)} ${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
  }
  return d;
}

function viewMap() {
  return `<div class="page-head">
    <div><div class="eyebrow">Peta interpolasi</div><h2>Sebaran cuaca Jawa Timur</h2>
      <p class="sub">Interpolasi IDW dari 20 stasiun; klik titik untuk melihat detail pembacaan.</p></div>
    <div class="page-actions"><a class="btn ghost" href="#/stations"><svg class="ico"><use href="#i-stations"/></svg><span>Data stasiun</span></a></div>
  </div>
  ${mapCardHTML()}
  <div class="mapfoot"><span><b>Metode:</b> inverse distance weighting (p=2,3) · grid 4 km · ${
    state.timeOffset === 0 ? 'observasi terkini' : `observasi −${state.timeOffset} jam`
  }</span><span>Kunci: <b>hash(station_id + jam)</b> · replikasi RF=3</span></div>`;
}

function viewAlerts() {
  const active = state.alerts.filter(a => a.status === 'active');
  const high = active.filter(a => a.severity === 'high').length;
  const medium = active.filter(a => a.severity === 'medium').length;
  const done = state.alerts.filter(a => a.status === 'done').length;
  return `<div class="page-head">
    <div><div class="eyebrow">Peringatan dini</div><h2>${active.length} peringatan aktif</h2>
      <p class="sub">${high} prioritas tinggi dan ${medium} sedang. Dihasilkan dari deteksi anomali ambang batas per stasiun.</p></div>
    <div class="page-actions"><a class="btn ghost" href="#/map"><svg class="ico"><use href="#i-map"/></svg><span>Lihat peta</span></a></div>
  </div>
  <div class="filter-bar">
    <div class="chips">
      <button class="chip ${state.alertFilter === 'all' ? 'active' : ''}" data-alert-filter="all">Semua <span class="n">${active.length}</span></button>
      <button class="chip ${state.alertFilter === 'high' ? 'active' : ''}" data-alert-filter="high">Tinggi <span class="n">${high}</span></button>
      <button class="chip ${state.alertFilter === 'medium' ? 'active' : ''}" data-alert-filter="medium">Sedang <span class="n">${medium}</span></button>
      <button class="chip ${state.alertFilter === 'done' ? 'active' : ''}" data-alert-filter="done">Selesai <span class="n">${done}</span></button>
    </div>
    <span class="muted" style="font-size:11px">Diperbarui ${fmtTime(new Date())} · cache edge 30 dtk</span>
  </div>
  <div class="alerts-grid">${alertCards()}</div>`;
}

function viewStations() {
  const online = STATIONS.filter(s => s.status === 'online').length;
  return `<div class="page-head">
    <div><div class="eyebrow">Jaringan stasiun</div><h2>20 stasiun otomatis</h2>
      <p class="sub">${online} online · 1 offline. Setiap stasiun mengirim satu batch pembacaan per menit.</p></div>
    <div class="page-actions"><a class="btn ghost" href="#/map"><svg class="ico"><use href="#i-map"/></svg><span>Buka peta</span></a></div>
  </div>
  <div class="filter-bar">
    <div class="search"><svg class="ico"><use href="#i-search"/></svg><input id="stationSearch" type="search" placeholder="Cari stasiun, kota, atau ID…" value="${esc(state.query)}" aria-label="Cari stasiun"></div>
    <div class="chips">
      <button class="chip ${state.stationFilter === 'all' ? 'active' : ''}" data-station-filter="all">Semua <span class="n">${STATIONS.length}</span></button>
      <button class="chip ${state.stationFilter === 'online' ? 'active' : ''}" data-station-filter="online">Online <span class="n">${online}</span></button>
      <button class="chip ${state.stationFilter === 'offline' ? 'active' : ''}" data-station-filter="offline">Offline <span class="n">${STATIONS.length - online}</span></button>
    </div>
  </div>
  <div class="station-grid" id="stationGrid">${stationGridHTML()}</div>`;
}

function stationGridHTML() {
  const q = state.query.toLowerCase().trim();
  let list = STATIONS.filter(s => state.stationFilter === 'all' || s.status === state.stationFilter);
  if (q) list = list.filter(s => (s.name + ' ' + s.area + ' ' + s.id + ' ' + s.kab).toLowerCase().includes(q));
  if (!list.length) return `<div class="card empty" style="grid-column:1/-1"><svg class="ico"><use href="#i-search"/></svg><div>Tidak ada stasiun yang cocok.</div></div>`;
  return list.map(s => {
    const t = s.values.temp;
    return `<article class="card station-card" data-station="${s.id}" tabindex="0" role="button" aria-label="Detail ${esc(s.name)}">
      <div class="st-top">
        <div class="st-title"><strong>${esc(s.name)}</strong><span>${esc(s.kab)} · ${s.id}</span></div>
        <span class="status-pill ${s.status === 'offline' ? 'off' : ''}"><span class="dotstatus ${s.status === 'offline' ? 'off' : ''}"></span>${s.status === 'offline' ? 'Offline' : 'Online'}</span>
      </div>
      <div class="st-main"><div class="st-temp" data-st="${s.id}-card-temp">${nf1.format(t)}<span class="u">°C</span></div>
        <div class="st-trend"><svg class="ico" style="width:12px;height:12px"><use href="#i-temp"/></svg>${s.elev} m dpl</div></div>
      <div class="st-metrics">
        <div class="st-metric">RH<b><svg class="ico"><use href="#i-humidity"/></svg><span data-st="${s.id}-card-rh">${nf0.format(s.values.rh)}%</span></b></div>
        <div class="st-metric">Hujan<b><svg class="ico"><use href="#i-rain"/></svg><span data-st="${s.id}-card-rain">${nf0.format(s.values.rain)}</span></b></div>
        <div class="st-metric">Angin<b><svg class="ico"><use href="#i-wind"/></svg><span data-st="${s.id}-card-wind">${nf0.format(s.values.wind)}</span></b></div>
      </div>
    </article>`;
  }).join('');
}

/* ============================== router / render ============================== */
const VIEWS = { dashboard: viewDashboard, map: viewMap, alerts: viewAlerts, stations: viewStations };
const TITLES = { dashboard: 'Dashboard', map: 'Peta interpolasi', alerts: 'Peringatan', stations: 'Stasiun' };

function route() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  state.view = VIEWS[raw] ? raw : 'dashboard';
  render();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function render() {
  const el = $('#view');
  el.innerHTML = VIEWS[state.view]();
  el.classList.remove('enter');
  void el.offsetWidth;
  el.classList.add('enter');
  document.title = `ClimaGrid — ${TITLES[state.view]}`;
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === state.view));
  updateAlertBadges();
  if (state.focusStation) {
    setTimeout(() => { state.focusStation = null; }, 2500);
  }
}

function updateAlertBadges() {
  const active = state.alerts.filter(a => a.status === 'active').length;
  const high = state.alerts.filter(a => a.status === 'active' && a.severity === 'high').length;
  const nb = $('#navAlertCount');
  if (nb) { nb.textContent = active; nb.hidden = active === 0; }
  const dot = $('#tabAlertDot');
  if (dot) dot.hidden = high === 0;
  const k = $('#kpiAlerts');
  if (k) k.innerHTML = `${active}<small>aktif</small>`;
}

/* ============================== sheet ============================== */
function openSheet(id) {
  const s = STATIONS.find(x => x.id === id);
  if (!s) return;
  state.selected = id;
  const sheet = $('#sheet');
  const data = s.history;
  const chart = lineChart(data.map(h => h.temp), data.map(h => h.t), { height: 160, color: '#F2B13A', label: 'Suhu 24 jam', fmtY: v => Math.round(v) + '°' });
  sheet.innerHTML = `
    <div class="sheet-head">
      <div><div class="eyebrow">${esc(s.kab)}</div><h3>${esc(s.name)}</h3>
        <p>${s.id} · ${s.elev} m dpl · ${esc(s.operator)}</p></div>
      <button class="sheet-close" data-action="close-sheet" aria-label="Tutup"><svg class="ico"><use href="#i-close"/></svg></button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <span class="status-pill ${s.status === 'offline' ? 'off' : ''}"><span class="dotstatus ${s.status === 'offline' ? 'off' : ''}"></span>${s.status === 'offline' ? 'Offline sejak 2 jam' : 'Online'}</span>
      <span class="status-pill" style="background:var(--mint-2);color:var(--teal)"><svg class="ico" style="width:11px;height:11px"><use href="#i-clock"/></svg>${timeAgo(s.values.at)}</span>
    </div>
    <div class="sheet-metrics">
      <div class="sheet-metric"><span><svg class="ico"><use href="#i-temp"/></svg>Suhu</span><strong>${nf1.format(s.values.temp)}<small>°C</small></strong></div>
      <div class="sheet-metric"><span><svg class="ico"><use href="#i-humidity"/></svg>Kelembapan</span><strong>${nf0.format(s.values.rh)}<small>%</small></strong></div>
      <div class="sheet-metric"><span><svg class="ico"><use href="#i-rain"/></svg>Curah hujan</span><strong>${nf1.format(s.values.rain)}<small>mm/jam</small></strong></div>
      <div class="sheet-metric"><span><svg class="ico"><use href="#i-wind"/></svg>Angin</span><strong>${nf0.format(s.values.wind)}<small>km/j</small></strong></div>
    </div>
    <div class="sheet-section">
      <h4>Suhu 24 jam terakhir</h4>
      ${chart}
      <div class="chart-legend"><span><i style="background:#F2B13A"></i>Observasi per jam</span><span style="margin-left:auto">${nf1.format(Math.min(...data.map(h => h.temp)))}–${nf1.format(Math.max(...data.map(h => h.temp)))}°C</span></div>
    </div>
    <div class="sheet-section">
      <h4>Atribut stasiun</h4>
      <div class="attr-grid">
        <div class="attr">Koordinat<b>${s.lat.toFixed(3)}°, ${s.lon.toFixed(3)}°</b></div>
        <div class="attr">Elevasi<b>${s.elev} m dpl</b></div>
        <div class="attr">Sensor<b>${esc(s.sensors)}</b></div>
        <div class="attr">Terpasang<b>${s.installed}</b></div>
        <div class="attr">Operator<b>${esc(s.operator)}</b></div>
        <div class="attr">Kunci DHT<b>hash(${s.id} + jam)</b></div>
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn primary" data-action="open-map" data-station="${s.id}"><svg class="ico"><use href="#i-map"/></svg>Lihat di peta</button>
      <button class="btn ghost" data-action="close-sheet">Tutup</button>
    </div>`;
  $('#backdrop').hidden = false;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  $('.sheet-close').focus();
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
  document.body.style.overflow = '';
  state.selected = null;
}

/* ============================== interactions ============================== */
document.addEventListener('click', e => {
  const stationEl = e.target.closest('[data-station]');
  if (stationEl && !e.target.closest('[data-action]')) {
    e.preventDefault();
    openSheet(stationEl.dataset.station);
    return;
  }
  const act = e.target.closest('[data-action]');
  if (act) {
    const a = act.dataset.action;
    if (a === 'close-sheet') return closeSheet();
    if (a === 'open-map') {
      const id = act.dataset.station;
      closeSheet();
      state.focusStation = id;
      state.variable = 'temp';
      location.hash = '#/map';
      render();
      return;
    }
    if (a === 'refresh') {
      state.tick += 4;
      refreshCurrent();
      state.alerts = buildAlerts();
      state.readings += 1600;
      render();
      showToast('Data diperbarui dari cache edge');
      return;
    }
    if (a === 'install') { installApp(); return; }
  }
  const varBtn = e.target.closest('[data-var]');
  if (varBtn) { state.variable = varBtn.dataset.var; render(); return; }
  const timeBtn = e.target.closest('[data-time]');
  if (timeBtn) { state.timeOffset = +timeBtn.dataset.time; render(); return; }
  const alertFilter = e.target.closest('[data-alert-filter]');
  if (alertFilter) { state.alertFilter = alertFilter.dataset.alertFilter; render(); return; }
  const stFilter = e.target.closest('[data-station-filter]');
  if (stFilter) { state.stationFilter = stFilter.dataset.stationFilter; render(); return; }
});

document.addEventListener('change', e => {
  if (e.target.matches('[data-interp]')) {
    state.interp = e.target.checked;
    render();
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'stationSearch') {
    state.query = e.target.value;
    const grid = $('#stationGrid');
    if (grid) grid.innerHTML = stationGridHTML();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSheet(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.station-card, .station-row, .map-station')) {
    e.preventDefault();
    openSheet(e.target.dataset.station);
  }
});

$('#backdrop').addEventListener('click', closeSheet);
$('#refreshBtn').addEventListener('click', () => {
  state.tick += 4; refreshCurrent(); state.alerts = buildAlerts(); state.readings += 1600;
  render(); showToast('Data diperbarui dari cache edge');
});
$('#installBtn').addEventListener('click', installApp);

window.addEventListener('hashchange', route);

/* ============================== live ============================== */
let toastTimer;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function updateLive() {
  state.tick++;
  state.readings += 380 + Math.round(rand('r' + state.tick) * 60);
  refreshCurrent();
  state.alerts = buildAlerts();
  updateAlertBadges();

  const online = STATIONS.filter(s => s.status === 'online');
  const t = avg(online.map(s => s.values.temp));
  const ht = $('#heroTemp');
  if (ht) ht.textContent = nf1.format(t);
  const hu = $('#heroUpdated');
  if (hu) hu.textContent = fmtTime(new Date());
  const kr = $('#kpiReadings');
  if (kr) kr.textContent = nf0.format(state.readings);

  // targeted station value refresh
  STATIONS.forEach(s => {
    const map = {
      temp: s.values.temp, rain: s.values.rain, rh: s.values.rh, wind: s.values.wind
    };
    $$(`[data-st="${s.id}-temp"]`).forEach(el => el.textContent = nf1.format(map.temp) + '°');
    $$(`[data-st="${s.id}-rain"]`).forEach(el => el.textContent = nf0.format(map.rain));
    $$(`[data-st="${s.id}-rh"]`).forEach(el => el.textContent = nf0.format(map.rh) + '%');
    $$(`[data-st="${s.id}-card-temp"]`).forEach(el => el.innerHTML = nf1.format(map.temp) + '<span class="u">°C</span>');
    $$(`[data-st="${s.id}-card-rh"]`).forEach(el => el.textContent = nf0.format(map.rh) + '%');
    $$(`[data-st="${s.id}-card-rain"]`).forEach(el => el.textContent = nf0.format(map.rain));
    $$(`[data-st="${s.id}-card-wind"]`).forEach(el => el.textContent = nf0.format(map.wind));
  });

  if (state.tick % 6 === 0) {
    if (state.view === 'dashboard') {
      const data = chartData();
      const tc = $('#tempChart'), rc = $('#rainChart');
      if (tc) tc.innerHTML = lineChart(data.temp, data.times, { color: '#0F6B62', label: 'Suhu rata-rata 24 jam', fmtY: v => Math.round(v) + '°' });
      if (rc) rc.innerHTML = barChart(data.rain, data.times, { unit: 'mm/jam', label: 'Curah hujan tertinggi 24 jam' });
    } else if (state.view === 'map') {
      const card = $('#mapCard');
      if (card) card.outerHTML = mapCardHTML();
    }
    if (state.selected) openSheet(state.selected);
  }
}

setInterval(updateLive, 5000);
setInterval(() => {
  const c = $('#clockText');
  if (c) c.textContent = fmtClock(new Date());
}, 1000);

/* ============================== init ============================== */
function initClock() {
  const d = new Date();
  $('#todayText').textContent = d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#clockText').textContent = fmtClock(d);
}

function updateOnline() {
  const bar = $('#offlineBar');
  if (bar) bar.hidden = navigator.onLine;
  const pill = $('#livePill');
  if (pill) pill.querySelector('span:nth-child(2)').textContent = navigator.onLine ? 'Live' : 'Offline';
}
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);

async function syncFromBackend() {
  try {
    const [stationResponse, healthResponse] = await Promise.all([
      fetch('/api/v1/stations', { headers: { Accept: 'application/json' } }),
      fetch('/api/v1/health', { headers: { Accept: 'application/json' } })
    ]);
    if (!stationResponse.ok || !healthResponse.ok) throw new Error('Backend unavailable');
    const stationData = await stationResponse.json();
    const health = await healthResponse.json();
    if (!Array.isArray(stationData.stations)) throw new Error('Invalid station response');

    const localById = new Map(STATIONS.map(s => [s.id, s]));
    const merged = stationData.stations.map(s => {
      const local = localById.get(s.id);
      return local ? { ...local, ...s } : s;
    });
    STATIONS.splice(0, STATIONS.length, ...merged);
    const now = new Date();
    STATIONS.forEach(s => {
      s._seed = hashStr(s.id);
      s.history = buildHistory(s, now);
    });
    refreshCurrent();
    state.alerts = buildAlerts();
    render();

    const sideStatus = $('.side-status-head');
    if (sideStatus) sideStatus.innerHTML = '<span class="pulse-dot"></span><span>Backend terhubung</span>';
    const sideText = $('.side-status p');
    if (sideText) sideText.innerHTML = `${health.dht.length} node Chord · RF=3<br>${STATIONS.filter(s => s.status === 'online').length} dari ${STATIONS.length} stasiun online`;
    showToast('Data dimuat dari API backend');
  } catch (_) {
    const sideStatus = $('.side-status-head');
    if (sideStatus) sideStatus.innerHTML = '<span class="pulse-dot" style="background:#B23A2B"></span><span>Backend tidak tersedia</span>';
    showToast('Backend tidak tersedia — PWA menampilkan data cache');
  }
}

/* PWA install */
let deferredPrompt = null;
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (standalone) {
  const b = $('#installBtn');
  if (b) b.hidden = true;
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  const b = $('#installBtn');
  if (b) b.hidden = false;
});
async function installApp() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    const b = $('#installBtn');
    if (b && outcome === 'accepted') b.hidden = true;
    showToast(outcome === 'accepted' ? 'ClimaGrid dipasang di perangkat' : 'Pemasangan dibatalkan');
  } else {
    const ua = navigator.userAgent;
    if (/iphone|ipad|ipod/i.test(ua)) showToast('Di Safari: Bagikan → Tambahkan ke Layar Utama');
    else showToast('Di Chrome: menu ⋮ → "Tambahkan ke layar utama"');
  }
}
window.addEventListener('appinstalled', () => {
  const b = $('#installBtn');
  if (b) b.hidden = true;
  showToast('Terima kasih! ClimaGrid siap digunakan offline.');
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

initClock();
updateOnline();
route();
syncFromBackend();
