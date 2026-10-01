/**
 * Стенд эксперимента 9C: диффузия ошибки в Lab и взвешенная перцептивная
 * метрика на одних и тех же пикселях.
 *
 * Production не трогается: baseline вызывает те же функции, что приложение.
 * Запуск: npm run exp:9c
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeAverageGrid } from '../src/algorithms/gridAverage.ts';
import { mapGridToPalette } from '../src/algorithms/color/paletteMapping.ts';
import { detectFaces } from '../src/algorithms/face/faceDetection.ts';
import { buildAllFaceRegions } from '../src/algorithms/face/faceRegions.ts';
import { computeCellMaps } from '../src/algorithms/image/edges.ts';
import { cloneImage, preprocessImage } from '../src/algorithms/image/preprocess.ts';
import { applyPieceLimits } from '../src/algorithms/optimization/pieceLimit.ts';
import { buildWeightMap, REGION_LABELS } from '../src/algorithms/optimization/weightMap.ts';
import { labDiffusionMapGrid } from '../src/algorithms/color/labDiffusion.ts';
import { spatialMapGrid } from '../src/algorithms/experimental/spatialMapping.ts';
import { computeVariantMetrics, leakageBreakdown } from '../src/algorithms/experimental/qualityMetrics.ts';
import { labChroma, rgbToLab } from '../src/algorithms/color/lab.ts';
import { LAB_DIFFUSION_ZONES, PERCEPTUAL_PRESETS } from '../src/config/experiments.ts';
import { buildPresetPalette } from '../src/config/paletteData.ts';
import { getPreset } from '../src/config/productPresets.ts';
import { getProcessingProfile } from '../src/config/processingProfiles.ts';
import { getMode } from '../src/config/quality.ts';

const OUT = process.env.EXP_OUT ?? '/tmp/exp9c';
const IN = process.env.EXP_IN ?? '/tmp/exp';
const CASES = ['color-s', 'color-m', 'classic-s'];

/* ------------------------------------------------------------ PNG-писатель */

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function writePng(path, width, height, rgbAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Мозаика с заданным размером ячейки. cell = 1 даёт физический масштаб. */
function renderGrid(grid, path, cell) {
  writePng(path, grid.cols * cell, grid.rows * cell, (x, y) =>
    grid.cells[Math.floor(y / cell) * grid.cols + Math.floor(x / cell)].rgb,
  );
}

/** Исходный кадр в том же размере — для сравнения «оригинал / мозаика». */
function renderOriginal(image, path, width, height) {
  writePng(path, width, height, (x, y) => {
    const sx = Math.floor((x / width) * image.width);
    const sy = Math.floor((y / height) * image.height);
    const index = (sy * image.width + sx) * 4;
    return [image.data[index], image.data[index + 1], image.data[index + 2]];
  });
}

/* ------------------------------------------------------------- подготовка */

function prepare(id) {
  const meta = JSON.parse(readFileSync(join(IN, `${id}.json`), 'utf8'));
  const image = { width: meta.w, height: meta.h, data: new Uint8ClampedArray(readFileSync(join(IN, `${id}.raw`))) };

  const preset = getPreset(id);
  const profile = getProcessingProfile(preset.processingProfile);
  const mode = getMode(profile.modeId);
  const palette = buildPresetPalette(preset);

  const detection = detectFaces(image);
  const faces = buildAllFaceRegions(image, detection.faces, { skin: detection.skin });

  const working = cloneImage(image);
  preprocessImage(working, mode.preprocess);

  const averageGrid = computeAverageGrid(working, {
    cols: preset.width,
    rows: preset.height,
    colorSpace: mode.colorSpace,
  });
  const maps = computeCellMaps(working, preset.width, preset.height);
  const weightMap = buildWeightMap({
    cols: preset.width,
    rows: preset.height,
    width: meta.w,
    height: meta.h,
    faces,
    edge: maps.edge,
  });

  // Нижняя граница лица в строках сетки — по ней отделяем одежду от фона.
  const faceBottomRow = faces.length
    ? Math.min(preset.height - 1, Math.round(((faces[0].face.y + faces[0].face.height) / meta.h) * preset.height))
    : Math.round(preset.height * 0.75);

  return { id, image, meta, preset, profile, mode, palette, faces, averageGrid, maps, weightMap, faceBottomRow };
}

function withLimits(ctx, mapping) {
  return applyPieceLimits({
    averageGrid: ctx.averageGrid,
    mapping,
    palette: ctx.palette,
    options: {
      metric: ctx.profile.distanceMetric,
      weights: ctx.mode.costWeights,
      maps: ctx.maps,
      cellWeights: ctx.weightMap.weight,
    },
  });
}

/**
 * «Кожаные» цвета — те, что baseline кладёт в лицо, но только окрашенные.
 *
 * Нейтральные тёмные детали (борода, тень) исключаются: они законно
 * встречаются и на одежде, и в волосах, и считать их утечкой неправильно.
 * В монохромной палитре окрашенных цветов нет вовсе — тогда метрика утечки
 * к набору неприменима, и это честнее, чем показывать бессмысленные проценты.
 */
function skinColorsOf(ctx, baselineGrid) {
  const counts = new Map();
  for (let i = 0; i < baselineGrid.cells.length; i++) {
    const label = REGION_LABELS[ctx.weightMap.region[i]];
    if (label !== 'face' && label !== 'mouth') continue;
    const hex = baselineGrid.cells[i].hex;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  const chromaOf = (hex) => {
    const color = ctx.palette.colors.find((item) => item.hex === hex);
    return color ? labChroma(rgbToLab(color.rgb)) : 0;
  };

  return [...counts.entries()]
    .filter(([hex]) => chromaOf(hex) > 8)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([hex]) => hex);
}

function measure(ctx, mapping, limit, label, skinHexes, ms) {
  const metrics = computeVariantMetrics({
    averageGrid: ctx.averageGrid,
    mosaicGrid: limit.mapping.grid,
    maps: ctx.maps,
    weightMap: ctx.weightMap,
  });
  const leak = leakageBreakdown(limit.mapping.grid, ctx.weightMap, skinHexes, ctx.faceBottomRow);

  return { label, ms: Math.round(ms), ...metrics, leak, moved: limit.moved, satisfied: limit.satisfied, grid: limit.mapping.grid };
}

/* --------------------------------------------------------------- прогон */

const results = {};

for (const id of CASES) {
  const ctx = prepare(id);
  const variants = [];

  // 1. BASELINE — production как есть.
  let t = performance.now();
  const baseline = mapGridToPalette(ctx.averageGrid, ctx.palette, { metric: ctx.profile.distanceMetric });
  const baseLimit = withLimits(ctx, baseline);
  const skinHexes = skinColorsOf(ctx, baseLimit.mapping.grid);
  variants.push(measure(ctx, baseline, baseLimit, 'Baseline', skinHexes, performance.now() - t));

  // 2. WEIGHTED — только взвешенная метрика, без диффузии.
  //    Пространственных штрафов нет: neighborWeight и gradientWeight обнулены.
  t = performance.now();
  const weighted = spatialMapGrid({
    grid: ctx.averageGrid,
    palette: ctx.palette,
    maps: ctx.maps,
    config: { perceptual: PERCEPTUAL_PRESETS.portrait, neighborWeight: 0, gradientWeight: 0, toneWeight: 0 },
  });
  variants.push(measure(ctx, weighted, withLimits(ctx, weighted), 'Weighted', skinHexes, performance.now() - t));

  // 3. LabDiff с фиксированной силой.
  for (const strength of [0.25, 0.4, 0.55, 0.7]) {
    t = performance.now();
    const mapping = labDiffusionMapGrid({
      grid: ctx.averageGrid,
      palette: ctx.palette,
      config: { strength, adaptive: false, perceptual: PERCEPTUAL_PRESETS.portrait },
    });
    variants.push(
      measure(ctx, mapping, withLimits(ctx, mapping), `LabDiff-${strength.toFixed(2)}`, skinHexes, performance.now() - t),
    );
  }

  // 4. AdaptiveLab — зональные силы из задания.
  t = performance.now();
  const adaptive = labDiffusionMapGrid({
    grid: ctx.averageGrid,
    palette: ctx.palette,
    weightMap: ctx.weightMap,
    config: { adaptive: true, zones: LAB_DIFFUSION_ZONES, perceptual: PERCEPTUAL_PRESETS.portrait },
  });
  variants.push(measure(ctx, adaptive, withLimits(ctx, adaptive), 'AdaptiveLab', skinHexes, performance.now() - t));

  // Визуалы: физический масштаб (1 ячейка = 1 px, затем ×3 без сглаживания
  // для читаемости) и умеренное увеличение — без «шахматной сетки».
  renderOriginal(ctx.image, join(OUT, `${id}-original.png`), ctx.preset.width * 6, ctx.preset.height * 6);
  for (const variant of variants) {
    const slug = variant.label.replace(/[^a-z0-9.]+/gi, '-').toLowerCase();
    renderGrid(variant.grid, join(OUT, `${id}-${slug}.png`), 6);
    renderGrid(variant.grid, join(OUT, `${id}-${slug}-physical.png`), 2);
    delete variant.grid;
  }

  results[id] = {
    preset: `${ctx.preset.width}×${ctx.preset.height}`,
    colors: ctx.palette.colors.length,
    faces: ctx.faces.length,
    skinColors: skinHexes,
    faceBottomRow: ctx.faceBottomRow,
    variants,
  };

  console.log(`\n=== ${id} (${ctx.preset.width}×${ctx.preset.height}, ${ctx.palette.colors.length} цветов) ===`);
  console.log(
    'кожа =',
    skinHexes.length ? skinHexes.join(' ') : 'нет окрашенных (монохромный набор — утечка неприменима)',
    '| граница одежды: строка',
    ctx.faceBottomRow,
  );
  console.log(
    'вариант        ΔE   лицоΔE  границ  градиент  divers  эффЦв  монолит  макс.обл  утечка(общ/вне/фон/одежда)  мс',
  );
  for (const v of variants) {
    console.log(
      `${v.label.padEnd(14)}${String(v.deltaE).padStart(5)}${String(v.faceDeltaE).padStart(8)}` +
        `${String(v.edgeScore).padStart(8)}${String(v.gradientScore).padStart(10)}${String(v.diversity4x4).padStart(8)}` +
        `${String(v.faceEffectiveColors).padStart(7)}${String(v.monolithShare + '%').padStart(9)}` +
        `${String(v.largestRegionShare + '%').padStart(10)}` +
        `${String(`${v.leak.overall}/${v.leak.outsideFace}/${v.leak.background}/${v.leak.clothes}`).padStart(28)}` +
        `${String(v.ms).padStart(5)}`,
    );
  }
}

writeFileSync(join(OUT, 'results-9c.json'), JSON.stringify(results, null, 1));
console.log(`\nИзображения и results-9c.json — в ${OUT}`);
