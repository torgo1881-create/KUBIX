/**
 * Стенд экспериментов этапа 9B.
 *
 * Гоняет на одних и тех же пикселях четыре варианта сопоставления с палитрой
 * и считает метрики. Production-код не трогается: baseline вызывает ровно те
 * же функции, что и приложение.
 *
 * Запуск: npm run exp:9b
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
import { buildToneZones, spatialMapGrid } from '../src/algorithms/experimental/spatialMapping.ts';
import { buildDiffusionMap, diffusionMapGrid } from '../src/algorithms/experimental/errorDiffusion.ts';
import { colorLeakage, computeVariantMetrics } from '../src/algorithms/experimental/qualityMetrics.ts';
import { PERCEPTUAL_PRESETS } from '../src/config/experiments.ts';
import { buildPresetPalette } from '../src/config/paletteData.ts';
import { getPreset } from '../src/config/productPresets.ts';
import { getProcessingProfile } from '../src/config/processingProfiles.ts';
import { getMode } from '../src/config/quality.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.EXP_OUT ?? '/tmp/exp';
const CASES = ['classic-s', 'color-s', 'color-m'];

/* ------------------------------------------------------------ PNG-писатель */

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

  let table = null;
  const crc32 = (buffer) => {
    if (!table) {
      table = new Int32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
      }
    }
    let crc = -1;
    for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  };

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

/** Мозаика в PNG с увеличением, чтобы ячейки были видны. */
function renderGrid(grid, path, targetSide = 768) {
  const cell = Math.max(1, Math.floor(targetSide / Math.max(grid.cols, grid.rows)));
  writePng(path, grid.cols * cell, grid.rows * cell, (x, y) => grid.cells[Math.floor(y / cell) * grid.cols + Math.floor(x / cell)].rgb);
}

/* ------------------------------------------------------------- подготовка */

function loadCase(id) {
  const meta = JSON.parse(readFileSync(join(OUT, `${id}.json`), 'utf8'));
  const data = new Uint8ClampedArray(readFileSync(join(OUT, `${id}.raw`)));
  return { ...meta, image: { width: meta.w, height: meta.h, data } };
}

/** Всё, что одинаково для всех вариантов: предобработка, лицо, карты, средние цвета. */
function prepare(testCase) {
  const preset = getPreset(testCase.id);
  const profile = getProcessingProfile(preset.processingProfile);
  const mode = getMode(profile.modeId);
  const palette = buildPresetPalette(preset);

  // Лицо ищем по исходным пикселям — как в production.
  const detection = detectFaces(testCase.image);
  const faces = buildAllFaceRegions(testCase.image, detection.faces, { skin: detection.skin });

  const working = cloneImage(testCase.image);
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
    width: testCase.w,
    height: testCase.h,
    faces,
    edge: maps.edge,
  });

  const faceCells = new Uint8Array(averageGrid.cells.length);
  for (let i = 0; i < faceCells.length; i++) {
    const label = REGION_LABELS[weightMap.region[i]];
    if (label === 'face' || label === 'contour' || label === 'mouth' || label === 'eyes') faceCells[i] = 1;
  }

  return { preset, profile, mode, palette, faces, averageGrid, maps, weightMap, faceCells, detection };
}

/** Приводим вариант к запасу деталей — как это делает production. */
function withLimits(context, mapping) {
  return applyPieceLimits({
    averageGrid: context.averageGrid,
    mapping,
    palette: context.palette,
    options: {
      metric: context.profile.distanceMetric,
      weights: context.mode.costWeights,
      maps: context.maps,
      cellWeights: context.weightMap.weight,
    },
  });
}

function measure(context, mapping, limit, label, ms) {
  const metrics = computeVariantMetrics({
    averageGrid: context.averageGrid,
    mosaicGrid: limit.mapping.grid,
    maps: context.maps,
    weightMap: context.weightMap,
  });

  const skinHexes = context.palette.colors
    .filter((color) => /skin|color-a|color-b|color-c/i.test(color.id))
    .map((color) => color.hex);

  return {
    label,
    ms: Math.round(ms),
    ...metrics,
    moved: limit.moved,
    satisfied: limit.satisfied,
    leakage: colorLeakage(limit.mapping.grid, context.weightMap, skinHexes).share,
    grid: limit.mapping.grid,
  };
}

/* --------------------------------------------------------------- варианты */

const results = {};

for (const id of CASES) {
  const testCase = loadCase(id);
  const context = prepare(testCase);
  const variants = [];

  // A — baseline: ровно production.
  let started = performance.now();
  const baseMapping = mapGridToPalette(context.averageGrid, context.palette, { metric: context.profile.distanceMetric });
  let limit = withLimits(context, baseMapping);
  variants.push(measure(context, baseMapping, limit, 'A baseline', performance.now() - started));

  // B — пространственное сопоставление с тональными зонами лица.
  const tones = buildToneZones(context.averageGrid, context.faceCells);
  started = performance.now();
  const spatialMapping = spatialMapGrid({
    grid: context.averageGrid,
    palette: context.palette,
    maps: context.maps,
    tones,
    config: { perceptual: PERCEPTUAL_PRESETS.portrait },
  });
  limit = withLimits(context, spatialMapping);
  variants.push(measure(context, spatialMapping, limit, 'B spatial', performance.now() - started));

  // C — Floyd–Steinberg, одинаковая сила по всему кадру.
  started = performance.now();
  const ditherMapping = diffusionMapGrid({
    grid: context.averageGrid,
    palette: context.palette,
    config: { kernel: 'floyd-steinberg' },
  });
  limit = withLimits(context, ditherMapping);
  variants.push(measure(context, ditherMapping, limit, 'C dither-FS', performance.now() - started));

  // D — пространственное сопоставление + адаптивная диффузия.
  const strengthMap = buildDiffusionMap(context.preset.width, context.preset.height, context.maps, context.weightMap, {
    enabled: true,
    protectedStrength: 0.15,
    flatStrength: 1,
    edgeThreshold: 0.4,
  });
  started = performance.now();
  const hybridMapping = spatialMapGrid({
    grid: context.averageGrid,
    palette: context.palette,
    maps: context.maps,
    tones,
    config: { perceptual: PERCEPTUAL_PRESETS.portrait, neighborWeight: 0.2 },
    diffusion: { strengthMap, strength: 0.8 },
  });
  limit = withLimits(context, hybridMapping);
  variants.push(measure(context, hybridMapping, limit, 'D adaptive', performance.now() - started));

  // E/F — диффузия поверх обычного сопоставления, с защитой черт лица.
  // Проверяем отдельно от пространственного слоя: в B он ухудшил результат.
  for (const [label, strength] of [['E adapt-0.7', 0.7], ['F adapt-0.45', 0.45]]) {
    started = performance.now();
    const mapping = diffusionMapGrid({
      grid: context.averageGrid,
      palette: context.palette,
      config: { kernel: 'floyd-steinberg', strength: 1 },
      strengthMap: strengthMap.map((value) => value * strength),
    });
    const l = withLimits(context, mapping);
    variants.push(measure(context, mapping, l, label, performance.now() - started));
  }

  // G — F плюс взвешенная перцептивная метрика (часть 7).
  started = performance.now();
  const weightedMapping = diffusionMapGrid({
    grid: context.averageGrid,
    palette: context.palette,
    config: { kernel: 'floyd-steinberg', strength: 1 },
    strengthMap: strengthMap.map((value) => value * 0.45),
    perceptual: PERCEPTUAL_PRESETS.portrait,
  });
  limit = withLimits(context, weightedMapping);
  variants.push(measure(context, weightedMapping, limit, 'G adapt+weighted', performance.now() - started));

  // Дополнительно: другие ядра диффузии и метрика расстояния — для отчёта.
  const extras = [];
  for (const kernel of ['jarvis', 'stucki']) {
    const mapping = diffusionMapGrid({ grid: context.averageGrid, palette: context.palette, config: { kernel } });
    const l = withLimits(context, mapping);
    extras.push(measure(context, mapping, l, `dither-${kernel}`, 0));
  }
  for (const [name, weights] of Object.entries(PERCEPTUAL_PRESETS)) {
    const mapping = spatialMapGrid({
      grid: context.averageGrid,
      palette: context.palette,
      maps: context.maps,
      tones,
      config: { perceptual: weights },
    });
    const l = withLimits(context, mapping);
    extras.push(measure(context, mapping, l, `spatial/${name}`, 0));
  }

  for (const variant of [...variants, ...extras]) {
    const file = `${id}-${variant.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    renderGrid(variant.grid, join(OUT, file));
    delete variant.grid;
  }

  results[id] = {
    preset: `${context.preset.width}×${context.preset.height}`,
    palette: context.palette.colors.length,
    faces: context.faces.length,
    faceCells: context.faceCells.reduce((sum, value) => sum + value, 0),
    toneThresholds: tones.thresholds.map((value) => Math.round(value)),
    variants,
    extras,
  };

  console.log(`\n=== ${id} (${context.preset.width}×${context.preset.height}, ${context.palette.colors.length} цветов, лиц ${context.faces.length}) ===`);
  console.log('вариант        ΔE    лицоΔE  границы  градиент  divers  цветлица  монолиты  макс.область  цветов  перекр.');
  for (const v of variants) {
    console.log(
      `${v.label.padEnd(13)} ${String(v.deltaE).padStart(5)} ${String(v.faceDeltaE).padStart(8)} ` +
        `${String(v.edgeScore).padStart(8)} ${String(v.gradientScore).padStart(9)} ${String(v.diversity4x4).padStart(7)} ` +
        `${String(v.faceColorDiversity).padStart(9)} ${String(v.monolithShare + '%').padStart(9)} ` +
        `${String(v.largestRegionShare + '%').padStart(13)} ${String(v.colorsUsed).padStart(7)} ${String(v.moved).padStart(8)}`,
    );
  }
}

writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
console.log(`\nPNG и results.json — в ${OUT}`);
