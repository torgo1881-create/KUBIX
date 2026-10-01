/**
 * Стенд этапа 13: «почерк» готовых наборов — локальный контраст по сетке.
 *
 * Сравнение одной и той же фотографии у нас и у готового набора дало
 * измеримую подпись их результата (64×96, 5 тонов):
 *
 *   границ между соседями      0,36   (у нас 0,18)
 *   скачков на 2+ тона         10,8 % (у нас 0,9 %)
 *   одиночных ячеек            5,9 %  (у нас 1,0 %)
 *   тонов в блоке 4×4          3,0    (у нас 2,0)
 *   доли тонов, белый → чёрный 22 / 17 / 18 / 13 / 29 % (у нас 11 / 14 / 22 / 25 / 28)
 *
 * Здесь кандидаты с нерезкой маской по ячейкам (detail / localContrast)
 * гоняются по кадрам бенчмарка, для каждого считается та же подпись и
 * расстояние до эталонной, плюс наши обычные метрики. Картинки — рядом,
 * плоскими квадратами, чтобы судить глазами.
 *
 *   npm run exp:13                       — кадры Classic из benchmark/frames
 *   npm run exp:13 -- --frames IMG_0443  — фильтр по имени
 *   OUT=... — куда писать (по умолчанию benchmark/exp-13)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { computeMosaicCore } from '../src/algorithms/mosaicCore.ts';
import { computeAverageGrid } from '../src/algorithms/gridAverage.ts';
import { computeCellMaps } from '../src/algorithms/image/edges.ts';
import { cloneImage, preprocessImage } from '../src/algorithms/image/preprocess.ts';
import { computeVariantMetrics } from '../src/algorithms/experimental/qualityMetrics.ts';
import { grainShare, recognitionScore, structuralSimilarity, toneCoverage } from '../src/algorithms/experimental/recognition.ts';
import { gridSignature, signatureDistance, KIT_SIGNATURE } from '../src/algorithms/experimental/signature.ts';
import { VARIANT_PRESETS } from '../src/config/variants.ts';
import { buildPresetPalette } from '../src/config/paletteData.ts';
import { getPreset } from '../src/config/productPresets.ts';
import { getMode } from '../src/config/quality.ts';

let crcTable;
const FRAMES = process.env.BENCH_FRAMES ?? 'benchmark/frames';
const OUT = process.env.OUT ?? 'benchmark/exp-13';
const args = process.argv.slice(2);
const filterIndex = args.indexOf('--frames');
const FILTER = filterIndex >= 0 ? args[filterIndex + 1] : null;
const CATEGORY = args.includes('--color') ? 'color' : 'classic';

const A = VARIANT_PRESETS.find((p) => p.id === 'A').settings;
const base = { ...A, levels: true };

/** Кандидаты: от «как есть» к подписи наборов. */
const CANDIDATES = [
  { id: 'A', name: 'A как есть', settings: A },
  { id: 'E', name: 'E контрастный', settings: VARIANT_PRESETS.find((p) => p.id === 'E').settings },
  { id: 'L0', name: 'levels', settings: base },
  { id: 'D1', name: 'levels + detail 0.75', settings: { ...base, detail: 0.75 } },
  { id: 'D2', name: 'levels + detail 1.25', settings: { ...base, detail: 1.25 } },
  { id: 'D3', name: 'levels + detail 1 + volume 0.4', settings: { ...base, detail: 1, localContrast: 0.4 } },
  { id: 'D4', name: 'levels + detail 1.5 + volume 0.6', settings: { ...base, detail: 1.5, localContrast: 0.6 } },
  { id: 'D5', name: 'levels + contrast 1.25 + detail 1 + volume 0.4', settings: { ...base, contrast: 1.25, detail: 1, localContrast: 0.4 } },
  { id: 'D6', name: 'face lift + levels + detail 1 + volume 0.4', settings: { ...base, faceExposure: true, detail: 1, localContrast: 0.4 } },
  { id: 'D7', name: 'levels + detail 1 + volume 0.4 + tone 0.4', settings: { ...base, detail: 1, localContrast: 0.4, toneBalance: 0.4 } },
  { id: 'D8', name: 'levels + detail 1 + volume 0.8', settings: { ...base, detail: 1, localContrast: 0.8 } },
  { id: 'D9', name: 'levels + detail 2 + volume 0.6', settings: { ...base, detail: 2, localContrast: 0.6 } },
  { id: 'D10', name: 'levels + detail 1.5 + volume 1.0', settings: { ...base, detail: 1.5, localContrast: 1.0 } },
  { id: 'D11', name: 'levels + contrast 1.25 + detail 1.5 + volume 0.6', settings: { ...base, contrast: 1.25, detail: 1.5, localContrast: 0.6 } },
];

if (!existsSync(FRAMES)) {
  console.error(`Нет кадров в ${FRAMES}`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const keys = readdirSync(FRAMES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((key) => !FILTER || key.includes(FILTER))
  .filter((key) => getPreset(JSON.parse(readFileSync(`${FRAMES}/${key}.json`, 'utf8')).preset).category === CATEGORY)
  .sort();

if (!keys.length) {
  console.error('Нет подходящих кадров');
  process.exit(2);
}

const totals = {};
const rowsOut = [];

for (const key of keys) {
  const meta = JSON.parse(readFileSync(`${FRAMES}/${key}.json`, 'utf8'));
  const image = { width: meta.w, height: meta.h, data: new Uint8ClampedArray(readFileSync(`${FRAMES}/${key}.raw`)) };
  const preset = getPreset(meta.preset);
  const palette = buildPresetPalette(preset);
  const mode = getMode('portrait');

  const reference = cloneImage(image);
  preprocessImage(reference, mode.preprocess);
  const referenceGrid = computeAverageGrid(reference, { cols: preset.width, rows: preset.height, colorSpace: mode.colorSpace });
  const maps = computeCellMaps(reference, preset.width, preset.height);

  const tiles = [{ label: 'фото', rgb: downsampleImage(image, preset.width, preset.height) }];
  console.log(`\n${key} (${preset.width}×${preset.height})`);
  console.log('кандидат  границы  2+тона  одиноч  4×4   доли (белый→чёрный)         дистанц  recog   рябь');

  for (const candidate of CANDIDATES) {
    const s = candidate.settings;
    const core = computeMosaicCore(image, {
      cols: preset.width, rows: preset.height, mode: 'portrait', palette, enforcePieceLimits: true,
      faceExposure: s.faceExposure, levels: s.levels, dithering: s.dithering, toneBalance: s.toneBalance,
      eyeBoost: s.eyeBoost, faceVolume: s.faceVolume,
      gridDetail: { fine: s.detail ?? 0, coarse: s.localContrast ?? 0 },
      preprocess: { contrast: s.contrast, saturation: s.saturation, sharpen: s.sharpen, smooth: s.smoothing },
      sampleWidth: meta.w, sampleHeight: meta.h,
    });

    const signature = gridSignature(core.grid, palette);
    const distance = signatureDistance(signature, KIT_SIGNATURE);
    const metrics = computeVariantMetrics({ averageGrid: referenceGrid, mosaicGrid: core.grid, maps, weightMap: core.weightMap });
    const tone = toneCoverage(referenceGrid, core.grid, core.weightMap);
    const ssim = structuralSimilarity(referenceGrid, core.grid);
    const grain = grainShare(core.grid);
    const recognition = recognitionScore({ ssim, edgeScore: metrics.edgeScore, contrastRatio: tone.contrastRatio, grain, deltaE: metrics.deltaE });

    const t = (totals[candidate.id] ??= { distance: 0, recognition: 0, edge: 0, jumps: 0, n: 0, limits: true });
    t.distance += distance; t.recognition += recognition; t.edge += signature.edgeDensity; t.jumps += signature.jumps; t.n++;
    t.limits = t.limits && (core.pieceLimit?.satisfied ?? true);

    console.log(
      `${candidate.id.padEnd(9)}${signature.edgeDensity.toFixed(3).padStart(8)}${(signature.jumps * 100).toFixed(1).padStart(7)}%${(signature.isolated * 100).toFixed(1).padStart(7)}%` +
      `${signature.diversity.toFixed(2).padStart(6)}   ${signature.shares.map((v) => (v * 100).toFixed(0).padStart(3)).join(' ')}` +
      `   ${distance.toFixed(2).padStart(7)}${recognition.toFixed(3).padStart(8)}${grain.toFixed(1).padStart(6)}%`,
    );
    tiles.push({ label: candidate.id, rgb: gridToRgb(core.grid) });
    rowsOut.push({ frame: key, candidate: candidate.id, signature, distance, recognition, grain, limits: core.pieceLimit?.satisfied ?? true });
  }

  writePng(`${OUT}/${key}.png`, tileSheet(tiles, preset.width, preset.height, 5));
}

console.log('\nСреднее по кадрам:');
console.log('кандидат  дистанция  границы  2+тона  recog   лимиты  — описание');
for (const candidate of CANDIDATES) {
  const t = totals[candidate.id];
  console.log(
    `${candidate.id.padEnd(9)}${(t.distance / t.n).toFixed(2).padStart(9)}${(t.edge / t.n).toFixed(3).padStart(9)}${((t.jumps / t.n) * 100).toFixed(1).padStart(7)}%${(t.recognition / t.n).toFixed(3).padStart(8)}${(t.limits ? 'ok' : 'НЕТ').padStart(8)}  — ${candidate.name}`,
  );
}
writeFileSync(`${OUT}/results.json`, JSON.stringify({ target: KIT_SIGNATURE, candidates: CANDIDATES, rows: rowsOut }, null, 1));
console.log(`\nКартинки и results.json — в ${OUT}/`);

/* --- картинки ------------------------------------------------------------ */

function gridToRgb(grid) {
  const out = new Uint8Array(grid.cols * grid.rows * 3);
  for (let i = 0; i < grid.cells.length; i++) {
    const [r, g, b] = grid.cells[i].rgb;
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  return out;
}

function downsampleImage(image, cols, rows) {
  const out = new Uint8Array(cols * rows * 3);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const x0 = Math.floor((x * image.width) / cols), x1 = Math.floor(((x + 1) * image.width) / cols);
      const y0 = Math.floor((y * image.height) / rows), y1 = Math.floor(((y + 1) * image.height) / rows);
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * image.width + xx) * 4; r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; n++;
      }
      const o = (y * cols + x) * 3; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

/** Плитки в ряд, каждая ячейка — квадрат scale×scale, между плитками зазор. */
function tileSheet(tiles, cols, rows, scale) {
  const gap = 6;
  const width = tiles.length * (cols * scale + gap) - gap;
  const height = rows * scale;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  tiles.forEach((tile, index) => {
    const ox = index * (cols * scale + gap);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const s = (y * cols + x) * 3;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const o = ((y * scale + dy) * width + ox + x * scale + dx) * 3;
        rgb[o] = tile.rgb[s]; rgb[o + 1] = tile.rgb[s + 1]; rgb[o + 2] = tile.rgb[s + 2];
      }
    }
  });
  return { width, height, rgb };
}

function writePng(path, { width, height, rgb }) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
