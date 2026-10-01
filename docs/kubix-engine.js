(function () {
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmt = (n) => n.toLocaleString('ru-RU');
function blobUrl(c, type, q) { const d = c.toDataURL(type || 'image/png', q), b = atob(d.slice(d.indexOf(',') + 1)), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return URL.createObjectURL(new Blob([a], { type: type || 'image/png' })); }
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const fl = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function lab(r, g, b) {
  r = lin(r); g = lin(g); b = lin(b);
  const X = fl((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), Y = fl(r * 0.2126 + g * 0.7152 + b * 0.0722), Z = fl((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mkPal = (list) => list.map(([name, hex]) => { const rgb = hex2rgb(hex); return { name, hex, rgb, lab: lab(...rgb) }; });

// Palettes and presets mirror src/config/palettes.json + productPresets.ts
const PALS = {
  classic: mkPal([['Чёрный', '#14161A'], ['Тёмно-серый', '#4A4F57'], ['Средне-серый', '#8A9098'], ['Светло-серый', '#C3C7CC'], ['Белый', '#F2F3F5']]),
  color: mkPal([['Светлый тёплый', '#F2D9C0'], ['Средний тёплый', '#D9A87C'], ['Глубокий тёплый', '#A9724B'], ['Светлый нейтральный', '#E8E6E1'], ['Средний холодный', '#7A7F86'], ['Тёмный холодный', '#3B3F46'], ['Чёрная основа', '#14161A']]),
};
const P = (id, name, cat, w, h, cw, ch) => ({ id, name, cat, w, h, cw, ch, pal: cat, pieces: Math.round((w * h * 1.55) / 100) * 100 });
const PRESETS = [
  P('classic-s', 'Classic S', 'classic', 64, 64, 51, 51),
  P('classic-m', 'Classic M', 'classic', 64, 96, 51, 76),
  P('classic-l', 'Classic L', 'classic', 96, 96, 76, 76),
  P('color-s', 'Color S', 'color', 64, 64, 51, 51),
  P('color-m', 'Color M', 'color', 64, 96, 51, 76),
];
const VARIANTS = [
  { id: 'G', name: 'Как в наборе', desc: 'Чёткие черты и фактура, как у готовых наборов: светлые ореолы вдоль тёмных линий.', s: { levels: 1, lift: 0.35, contrast: 1.08, sat: 0.96, detail: 1.4 } },
  { id: 'A', name: 'Как на фото', desc: 'Минимум обработки — ближе всего к тонам твоего снимка.', s: { contrast: 1.08, sat: 0.96 } },
  { id: 'I', name: 'Светлое лицо', desc: 'Лицо светлее и отделяется от волос и фона. Обычно лучший выбор для портрета.', s: { levels: 1, lift: 0.7, contrast: 1.1, detail: 0.6 } },
  { id: 'C', name: 'Мягкие переходы', desc: 'Соседние тона смешаны: кожа объёмнее, без резких ступеней.', s: { contrast: 1.05, dither: 0.4 } },
];

function ell(x, cx, cy, rx, ry, rot) { x.beginPath(); x.ellipse(cx, cy, rx, ry, rot || 0, 0, Math.PI * 2); x.fill(); }
function sample() {
  const W = 480, H = 720, c = mk(W, H), x = c.getContext('2d');
  let g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#dfe3e6'); g.addColorStop(1, '#6f7a84'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.filter = 'blur(16px)';
  x.fillStyle = '#26303b'; ell(x, 240, 780, 260, 210);
  x.fillStyle = '#b98060'; x.fillRect(196, 420, 88, 150);
  x.fillStyle = '#33241d'; ell(x, 240, 300, 170, 215);
  x.filter = 'blur(5px)';
  g = x.createRadialGradient(200, 280, 20, 240, 320, 175); g.addColorStop(0, '#f6d4b4'); g.addColorStop(0.55, '#dba580'); g.addColorStop(1, '#9c6646'); x.fillStyle = g; ell(x, 240, 322, 112, 150);
  x.fillStyle = '#33241d'; ell(x, 222, 190, 140, 66, -0.25);
  x.filter = 'blur(2px)';
  x.fillStyle = '#4a3226'; ell(x, 193, 278, 30, 7, -0.08); ell(x, 287, 278, 30, 7, 0.08);
  x.fillStyle = '#fbefe6'; ell(x, 195, 308, 21, 10); ell(x, 285, 308, 21, 10);
  x.fillStyle = '#22160f'; ell(x, 196, 308, 10, 10); ell(x, 284, 308, 10, 10);
  x.fillStyle = 'rgba(120,64,40,.4)'; ell(x, 252, 362, 13, 32);
  x.fillStyle = '#a9564b'; ell(x, 240, 414, 36, 12);
  x.filter = 'none';
  return c;
}

function load(file) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(file), im = new Image();
    im.onload = () => { const k = Math.min(1, 1400 / Math.max(im.width, im.height)); const c = mk(Math.round(im.width * k), Math.round(im.height * k)); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(u); res(c); };
    im.onerror = rej; im.src = u;
  });
}

function crop(src, a, z, cx, cy, outW) {
  const sw = src.width, sh = src.height;
  let cw, ch; if (sw / sh > a) { ch = sh; cw = sh * a; } else { cw = sw; ch = sw / a; }
  cw /= z; ch /= z;
  const x = clamp(cx * sw - cw / 2, 0, sw - cw), y = clamp(cy * sh - ch / 2, 0, sh - ch);
  const o = mk(outW, Math.round(outW / a)); const ox = o.getContext('2d'); ox.imageSmoothingQuality = 'high'; ox.drawImage(src, x, y, cw, ch, 0, 0, o.width, o.height);
  return { canvas: o, cx: (x + cw / 2) / sw, cy: (y + ch / 2) / sh, x0: x / sw, y0: y / sh, fw: cw / sw, fh: ch / sh };
}

function mosaic(src, cols, rows, pal, s) {
  s = s || {};
  const m = mk(cols * 4, rows * 4), mx = m.getContext('2d'); mx.imageSmoothingQuality = 'high'; mx.drawImage(src, 0, 0, m.width, m.height);
  const c = mk(cols, rows), cx = c.getContext('2d', { willReadFrequently: true }); cx.imageSmoothingQuality = 'high'; cx.drawImage(m, 0, 0, cols, rows);
  const d = cx.getImageData(0, 0, cols, rows).data, n = cols * rows;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), L0 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { R[i] = d[i * 4] / 255; G[i] = d[i * 4 + 1] / 255; B[i] = d[i * 4 + 2] / 255; const l = lab(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); L0[i * 3] = l[0]; L0[i * 3 + 1] = l[1]; L0[i * 3 + 2] = l[2]; }
  const lum = (i) => 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  if (s.levels) {
    const ys = new Float32Array(n); for (let i = 0; i < n; i++) ys[i] = lum(i); ys.sort();
    const lo = ys[Math.floor(n * 0.02)], hi = ys[Math.floor(n * 0.98)], k = 1 / Math.max(0.08, hi - lo);
    for (let i = 0; i < n; i++) { R[i] = (R[i] - lo) * k; G[i] = (G[i] - lo) * k; B[i] = (B[i] - lo) * k; }
  }
  if (s.lift) {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = y * cols + x, dx = (x + 0.5) / cols - 0.5, dy = (y + 0.5) / rows - 0.45, w = Math.exp(-(dx * dx / 0.05 + dy * dy / 0.07)), g = 1 / (1 + s.lift * w);
      R[i] = Math.pow(clamp(R[i], 0, 1), g); G[i] = Math.pow(clamp(G[i], 0, 1), g); B[i] = Math.pow(clamp(B[i], 0, 1), g);
    }
  }
  const ct = s.contrast || 1, sat = s.sat == null ? 1 : s.sat;
  for (let i = 0; i < n; i++) {
    const r = (R[i] - 0.5) * ct + 0.5, g = (G[i] - 0.5) * ct + 0.5, b = (B[i] - 0.5) * ct + 0.5, y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    R[i] = y + (r - y) * sat; G[i] = y + (g - y) * sat; B[i] = y + (b - y) * sat;
  }
  if (s.detail) {
    const Y = new Float32Array(n); for (let i = 0; i < n; i++) Y[i] = lum(i);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      let sum = 0, cnt = 0;
      for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) { const yy = y + j, xx = x + k; if (yy < 0 || xx < 0 || yy >= rows || xx >= cols) continue; sum += Y[yy * cols + xx]; cnt++; }
      const i = y * cols + x, dl = (Y[i] - sum / cnt) * s.detail; R[i] += dl; G[i] += dl; B[i] += dl;
    }
  }
  const idx = new Uint8Array(n), counts = new Array(pal.length).fill(0), dith = s.dither || 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = y * cols + x, r = clamp(R[i], 0, 1), g = clamp(G[i], 0, 1), b = clamp(B[i], 0, 1), l = lab(r * 255, g * 255, b * 255);
    let bi = 0, bd = 1e9;
    for (let k = 0; k < pal.length; k++) { const q = pal[k].lab, e = (l[0] - q[0]) ** 2 + (l[1] - q[1]) ** 2 + (l[2] - q[2]) ** 2; if (e < bd) { bd = e; bi = k; } }
    idx[i] = bi; counts[bi]++;
    if (dith) {
      const q = pal[bi].rgb, er = (r - q[0] / 255) * dith, eg = (g - q[1] / 255) * dith, eb = (b - q[2] / 255) * dith;
      const push = (xx, yy, f) => { if (xx < 0 || xx >= cols || yy >= rows) return; const j = yy * cols + xx; R[j] += er * f; G[j] += eg * f; B[j] += eb * f; };
      push(x + 1, y, 7 / 16); push(x - 1, y + 1, 3 / 16); push(x, y + 1, 5 / 16); push(x + 1, y + 1, 1 / 16);
    }
  }
  let de = 0;
  for (let i = 0; i < n; i++) { const q = pal[idx[i]].lab; de += Math.sqrt((L0[i * 3] - q[0]) ** 2 + (L0[i * 3 + 1] - q[1]) ** 2 + (L0[i * 3 + 2] - q[2]) ** 2); }
  const avg = de / n, colorSim = clamp(1 - avg / 40, 0, 1);
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, m2 = 0;
  for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
    const i = y * cols + x;
    for (const j of [i + 1, i + cols]) { const a = L0[i * 3] - L0[j * 3], b = pal[idx[i]].lab[0] - pal[idx[j]].lab[0]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; m2++; }
  }
  const cov = sab / m2 - (sa / m2) * (sb / m2), va = saa / m2 - (sa / m2) ** 2, vb = sbb / m2 - (sb / m2) ** 2;
  const corr = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
  return { cols, rows, idx, pal, counts, score: Math.round(100 * (0.5 * colorSim + 0.5 * clamp(corr, 0, 1))), used: counts.filter(Boolean).length };
}

function render(r, cell, o) {
  o = o || {};
  const c = mk(r.cols * cell, r.rows * cell), x = c.getContext('2d'); x.fillStyle = o.base || '#000'; x.fillRect(0, 0, c.width, c.height);
  const g = cell * (o.gap || 0);
  for (let y = 0; y < r.rows; y++) for (let xx = 0; xx < r.cols; xx++) {
    const p = r.pal[r.idx[y * r.cols + xx]], px = xx * cell, py = y * cell; x.fillStyle = p.hex;
    if (o.shape === 'round') {
      const cx = px + cell / 2, cy = py + cell / 2, rad = cell / 2 - g / 2;
      x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill();
      if (o.shine) { x.fillStyle = 'rgba(255,255,255,.22)'; x.beginPath(); x.arc(cx - rad * 0.28, cy - rad * 0.28, rad * 0.38, 0, Math.PI * 2); x.fill(); }
    } else {
      const s = cell - g; x.fillRect(px + g / 2, py + g / 2, s, s);
      if (o.bevel) { x.fillStyle = 'rgba(255,255,255,.10)'; x.fillRect(px + g / 2, py + g / 2, s, s * 0.18); x.fillStyle = 'rgba(0,0,0,.2)'; x.fillRect(px + g / 2, py + g / 2 + s * 0.82, s, s * 0.18); }
    }
  }
  return blobUrl(c);
}

function block(r, size, index) {
  const nx = Math.ceil(r.cols / size), ny = Math.ceil(r.rows / size), total = nx * ny, i = clamp(index, 0, total - 1);
  const bx = i % nx, by = Math.floor(i / nx), x0 = bx * size, y0 = by * size, w = Math.min(size, r.cols - x0), h = Math.min(size, r.rows - y0);
  const cells = [], cnt = new Array(r.pal.length).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = r.idx[(y0 + y) * r.cols + x0 + x], p = r.pal[k]; cells.push({ hex: p.hex, num: k + 1, ink: p.lab[0] > 58 ? '#15140f' : '#ffffff' }); cnt[k]++; }
  const counts = r.pal.map((p, k) => ({ hex: p.hex, num: k + 1, name: p.name, count: cnt[k] })).filter((c) => c.count);
  return { total, index: i, bx, by, x0, y0, w, h, cells, counts, id: String.fromCharCode(65 + by) + (bx + 1) };
}

/* ---- prototype controller shared by all design directions ---- */
const STEPS = ['Набор', 'Фото', 'Кадр', 'Вариант', 'Сборка'];
const TITLES = ['Выбери набор', 'Загрузи фото', 'Подгони кадр', 'Выбери вариант', 'Собирай по блокам'];
const SUBS = [
  'От набора зависят размер картины, сетка и цвета деталей.',
  'Лучше всего подходит портрет при дневном свете, лицо крупно.',
  'Перетаскивай рамку и меняй масштаб. Справа видно, как это будет выглядеть в деталях.',
  'Одна фотография, четыре обработки. Выбирай глазами: оценка только подсказка.',
  'Иди блок за блоком. Цифра в клетке — номер цвета из легенды.',
];
const NEXT = ['Дальше: фото', 'Дальше: кадр', 'Показать варианты', 'Собирать этот вариант', ''];

function init(self) { self._src = sample(); }
const preset = (self) => PRESETS.find((p) => p.id === self.state.presetId) || PRESETS[1];
function cropOf(self) {
  const p = preset(self), c = self.state.crop, key = [self.state.v, p.id, c.z, c.x, c.y].join('|');
  if (self._ck !== key) { self._ck = key; self._crop = crop(self._src, p.w / p.h, c.z, c.x, c.y, 360); self._res = VARIANTS.map((v) => ({ ...v })); self._best = null; }
  return self._crop;
}
function res(self, v) { if (!v.r) { const p = preset(self); v.r = mosaic(self._crop.canvas, p.w, p.h, PALS[p.pal], v.s); } return v.r; }
function url(self, v, cell) { const k = 'u' + (cell || 8); if (!v[k]) v[k] = render(res(self, v), cell || 8, self.R); return v[k]; }
function hero(self) {
  if (self._hv !== self.state.v) {
    self._hv = self.state.v;
    const a = crop(self._src, 2 / 3, 1, 0.5, 0.42, 360);
    self._hero = { photo: blobUrl(a.canvas, 'image/jpeg', 0.85), mono: render(mosaic(a.canvas, 64, 96, PALS.classic, VARIANTS[0].s), 10, self.R), color: render(mosaic(a.canvas, 64, 96, PALS.color, VARIANTS[0].s), 10, self.R) };
    self._srcUrl = blobUrl(self._src, 'image/jpeg', 0.85);
  }
  return self._hero;
}
function prev(self, q) {
  if (self._pv !== self.state.v) { self._pv = self.state.v; self._pvs = {}; }
  if (!self._pvs[q.id]) { const a = crop(self._src, q.w / q.h, 1, 0.5, 0.42, 240); self._pvs[q.id] = render(mosaic(a.canvas, q.w, q.h, PALS[q.pal], VARIANTS[0].s), 4, self.R); }
  return self._pvs[q.id];
}
function toast(self, msg) { self.setState({ toast: msg }); clearTimeout(self._tt); self._tt = setTimeout(() => self.setState({ toast: '' }), 2800); }
function loadInto(self, f) {
  if (!/^image\//.test(f.type)) { toast(self, 'Нужна картинка: JPG, PNG или WEBP'); return; }
  load(f).then((c) => { self._src = c; self.setState((st) => ({ v: st.v + 1, photoName: f.name, crop: { z: 1, x: 0.5, y: 0.45 }, step: 3 })); window.scrollTo({ top: 0 }); })
    .catch(() => toast(self, 'Не получилось открыть файл'));
}

function vals(self) {
  const s = self.state, T = self.T, set = (o) => self.setState(o);
  const p = preset(self), cr = cropOf(self), list = self._res, h = hero(self);
  const cur = list.find((v) => v.id === s.variantId) || list[0];
  const top = () => window.scrollTo({ top: 0 });
  const setStep = (n) => { set({ step: n }); top(); };
  const inApp = s.screen === 'app';
  const card = (q) => {
    const on = q.id === p.id;
    return {
      id: q.id, name: q.name, cat: q.cat === 'classic' ? 'Classic' : 'Color', size: q.cw + '×' + q.ch + ' см', grid: q.w + '×' + q.h, aspect: q.w === q.h ? '1:1' : '2:3',
      colors: q.cat === 'classic' ? '5 тонов' : '6 тонов + чёрная основа', cells: fmt(q.w * q.h), pieces: '≈ ' + fmt(q.pieces),
      swatches: PALS[q.pal].map((c) => ({ hex: c.hex })), active: on, preview: self.wantPreviews ? prev(self, q) : '', aspect: q.w + ' / ' + q.h, bd: on ? T.selBd : T.bd, bg: on ? T.selBg : T.bg,
      onPick: () => set({ presetId: q.id, block: -1 }),
      onStart: () => { set({ presetId: q.id, block: -1, screen: 'app', step: 2 }); top(); },
    };
  };
  const out = {
    ready: true, isLanding: !inApp, isApp: inApp,
    goApp: () => { set({ screen: 'app', step: 1 }); top(); },
    goUpload: () => { set({ screen: 'app', step: 2 }); top(); },
    goLanding: () => { set({ screen: 'landing' }); top(); },
    heroPhoto: h.photo, heroMono: h.mono, heroColor: h.color, srcUrl: self._srcUrl,
    presetsAll: PRESETS.map(card), presetsClassic: PRESETS.filter((q) => q.cat === 'classic').map(card), presetsColor: PRESETS.filter((q) => q.cat === 'color').map(card),
    toast: s.toast, hasToast: !!s.toast, photoName: s.photoName,
    step: s.step, isStep1: s.step === 1, isStep2: s.step === 2, isStep3: s.step === 3, isStep4: s.step === 4, isStep5: s.step === 5,
    stepTitle: TITLES[s.step - 1], stepSub: SUBS[s.step - 1], stepNum: String(s.step).padStart(2, '0'),
    steps: STEPS.map((l, i) => { const n = i + 1, st = n === s.step ? 'on' : n < s.step ? 'done' : 'todo'; return { n, num: String(n).padStart(2, '0'), label: l, bg: T.step[st].bg, ink: T.step[st].ink, bd: T.step[st].bd, onClick: () => setStep(n) }; }),
    hasBack: s.step > 1, hasNext: s.step < 5, nextLabel: NEXT[s.step - 1],
    onBack: () => setStep(Math.max(1, s.step - 1)), onNext: () => setStep(Math.min(5, s.step + 1)),
    sumSet: p.name, sumSize: p.cw + '×' + p.ch + ' см', sumGrid: p.w + '×' + p.h, sumColors: p.cat === 'classic' ? '5' : '6 + основа', sumAspect: p.w === p.h ? '1:1' : '2:3',
    sumCells: fmt(p.w * p.h), sumPieces: '≈ ' + fmt(p.pieces), aspect: p.w + ' / ' + p.h,
    onFile: (e) => { const f = e.target.files && e.target.files[0]; if (f) loadInto(self, f); e.target.value = ''; },
    onDrop: (e) => { e.preventDefault(); set({ drag: false }); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadInto(self, f); },
    onDragOver: (e) => { e.preventDefault(); if (!self.state.drag) set({ drag: true }); },
    onDragLeave: () => set({ drag: false }),
    dropBd: s.drag ? T.selBd : T.dashed, dropBg: s.drag ? T.selBg : T.bg,
    useSample: () => { self._src = sample(); self.setState((st) => ({ v: st.v + 1, photoName: 'Пример фото', crop: { z: 1, x: 0.5, y: 0.42 }, step: 3 })); top(); },
    srcAspect: self._src.width + ' / ' + self._src.height,
    frameL: cr.x0 * 100 + '%', frameT: cr.y0 * 100 + '%', frameW: cr.fw * 100 + '%', frameH: cr.fh * 100 + '%',
    zoom: s.crop.z, zoomLabel: Math.round(s.crop.z * 100) + '%',
    onZoom: (e) => { const z = +e.target.value; self.setState((st) => ({ crop: { ...st.crop, z } })); },
    onDown: (e) => { const r = e.currentTarget.getBoundingClientRect(), c = cropOf(self); self._drag = { x: e.clientX, y: e.clientY, cx: c.cx, cy: c.cy, w: r.width, h: r.height }; if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); },
    onMove: (e) => { const d = self._drag; if (!d) return; const x = clamp(d.cx + (e.clientX - d.x) / d.w, 0, 1), y = clamp(d.cy + (e.clientY - d.y) / d.h, 0, 1); self.setState((st) => ({ crop: { ...st.crop, x, y } })); },
    onUp: () => { if (!self._drag) return; self._drag = null; const c = cropOf(self); self.setState((st) => ({ crop: { ...st.crop, x: c.cx, y: c.cy } })); },
    curName: cur.name, curId: cur.id,
  };
  if (inApp && s.step >= 3) { out.curUrl = url(self, cur); out.curScore = res(self, cur).score; }
  if (inApp && s.step === 4) {
    if (!self._best) self._best = list.reduce((a, b) => (res(self, b).score > res(self, a).score ? b : a)).id;
    out.variants = list.map((v) => {
      const on = v.id === cur.id, r = res(self, v);
      return { id: v.id, name: v.name, desc: v.desc, url: url(self, v), score: r.score, colors: r.used, best: v.id === self._best, active: on, bd: on ? T.selBd : T.bd, bg: on ? T.selBg : T.bg, btn: on ? 'Выбран' : 'Выбрать', btnBg: on ? T.on : 'transparent', btnInk: on ? T.onInk : T.offInk, onPick: () => set({ variantId: v.id, block: -1 }) };
    });
  } else out.variants = [];
  if (inApp && s.step === 5) {
    const r = res(self, cur), nx = Math.ceil(r.cols / s.blockSize), ny = Math.ceil(r.rows / s.blockSize), b = block(r, s.blockSize, s.block < 0 ? Math.floor(ny * 0.4) * nx + Math.floor(nx / 2) - 1 : s.block);
    Object.assign(out, {
      blockSizes: [4, 8, 16].map((n) => ({ label: n + '×' + n, bg: n === s.blockSize ? T.on : 'transparent', ink: n === s.blockSize ? T.onInk : T.offInk, onClick: () => set({ blockSize: n, block: -1 }) })),
      blockCells: b.cells, blockCols: 'repeat(' + b.w + ', minmax(0, 1fr))', blockId: 'Блок ' + b.id, blockPos: 'строка ' + (b.by + 1) + ', столбец ' + (b.bx + 1),
      blockStep: 'Шаг ' + (b.index + 1) + ' из ' + b.total, blockCounts: b.counts, progress: ((b.index + 1) / b.total) * 100 + '%',
      hlL: (b.x0 / r.cols) * 100 + '%', hlT: (b.y0 / r.rows) * 100 + '%', hlW: (b.w / r.cols) * 100 + '%', hlH: (b.h / r.rows) * 100 + '%',
      legend: r.pal.map((c, k) => ({ num: k + 1, hex: c.hex, name: c.name, total: fmt(r.counts[k]) })),
      onPrev: () => set({ block: Math.max(0, b.index - 1) }), onNext5: () => set({ block: Math.min(b.total - 1, b.index + 1) }),
      prevOp: b.index === 0 ? 0.4 : 1, nextOp: b.index >= b.total - 1 ? 0.4 : 1,
      onPdf: () => toast(self, 'В прототипе PDF не собирается. В приложении здесь скачается инструкция на ' + (b.total + 2) + ' стр.'),
    });
  } else Object.assign(out, { blockSizes: [], blockCells: [], blockCounts: [], legend: [] });
  return out;
}

window.Kubix = { toast, PALS, PRESETS, VARIANTS, sample, load, crop, mosaic, render, block, init, vals };
})();
