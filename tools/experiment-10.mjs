/**
 * Исследовательский стенд этапа 10.
 *
 * Сравнивает baseline с кандидатами на одном и том же входе. Production не
 * трогается: baseline — те же функции, что в приложении.
 *
 * Запуск: npm run exp:10
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

import { computeAverageGrid } from '../src/algorithms/gridAverage.ts';
import { mapGridToPalette } from '../src/algorithms/color/paletteMapping.ts';
import { detectFaces } from '../src/algorithms/face/faceDetection.ts';
import { buildAllFaceRegions } from '../src/algorithms/face/faceRegions.ts';
import { computeCellMaps } from '../src/algorithms/image/edges.ts';
import { cloneImage, preprocessImage } from '../src/algorithms/image/preprocess.ts';
import { applyPieceLimits } from '../src/algorithms/optimization/pieceLimit.ts';
import { buildWeightMap, REGION_LABELS } from '../src/algorithms/optimization/weightMap.ts';
import { labDiffusionMapGrid } from '../src/algorithms/color/labDiffusion.ts';
import { computeVariantMetrics, leakageBreakdown } from '../src/algorithms/experimental/qualityMetrics.ts';
import { structuralSimilarity, toneCoverage } from '../src/algorithms/experimental/recognition.ts';
import {
  applyToneLut,
  applyToneLutMasked,
  buildToneLut,
  enhanceLocalContrast,
  faceMaskFromRegions,
} from '../src/algorithms/experimental/toneMapping.ts';
import { LAB_DIFFUSION_ZONES, PERCEPTUAL_PRESETS } from '../src/config/experiments.ts';
import { buildPresetPalette } from '../src/config/paletteData.ts';
import { getPreset } from '../src/config/productPresets.ts';
import { getProcessingProfile } from '../src/config/processingProfiles.ts';
import { getMode } from '../src/config/quality.ts';
import { labChroma, rgbToLab } from '../src/algorithms/color/lab.ts';
import { buildSyntheticCases, loadRealCases } from './dataset.mjs';

const OUT = process.env.EXP_OUT ?? '/tmp/exp10';
const PRESETS = ['classic-s', 'color-s', 'color-m'];
mkdirSync(OUT, { recursive: true });

/* --------------------------------------------------------- PNG-писатель */

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

function renderGrid(grid, path, cell) {
  writePng(path, grid.cols * cell, grid.rows * cell, (x, y) =>
    grid.cells[Math.floor(y / cell) * grid.cols + Math.floor(x / cell)].rgb,
  );
}

function renderImage(image, path, width, height) {
  writePng(path, width, height, (x, y) => {
    const sx = Math.floor((x / width) * image.width);
    const sy = Math.floor((y / height) * image.height);
    const index = (sy * image.width + sx) * 4;
    return [image.data[index], image.data[index + 1], image.data[index + 2]];
  });
}

/* ------------------------------------------------------------ подготовка */

/** Общая часть: лицо, карты, палитра. Считается один раз на изображение. */
function analyse(testCase) {
  const preset = getPreset(testCase.preset);
  const profile = getProcessingProfile(preset.processingProfile);
  const mode = getMode(profile.modeId);
  const palette = buildPresetPalette(preset);

  const detection = detectFaces(testCase.image);
  const faces = buildAllFaceRegions(testCase.image, detection.faces, { skin: detection.skin });

  // Карты строим по предобработанной копии — как в production.
  const reference = cloneImage(testCase.image);
  preprocessImage(reference, mode.preprocess);
  const maps = computeCellMaps(reference, preset.width, preset.height);
  const weightMap = buildWeightMap({
    cols: preset.width,
    rows: preset.height,
    width: testCase.image.width,
    height: testCase.image.height,
    faces,
    edge: maps.edge,
  });

  const faceMask = faceMaskFromRegions(weightMap.region, REGION_LABELS, ['face', 'mouth', 'eyes', 'contour']);

  return { preset, profile, mode, palette, faces, maps, weightMap, faceMask };
}

/**
 * Строит сетку средних цветов по своей предобработке.
 * Кандидаты отличаются именно этим шагом.
 */
function makeAverageGrid(testCase, ctx, options) {
  const working = cloneImage(testCase.image);
  preprocessImage(working, ctx.mode.preprocess);

  if (options.localContrast > 0) {
    enhanceLocalContrast(working, options.localContrast);
  }

  // Региональная коррекция: LUT строится по лицу и применяется только к нему.
  if (options.regionalTone > 0 && ctx.faces.length) {
    const lut = buildToneLut(working, ctx.palette, {
      strength: options.regionalTone,
      mask: ctx.faceMask,
      maskWidth: ctx.preset.width,
      maskHeight: ctx.preset.height,
    });
    applyToneLutMasked(working, lut, ctx.faceMask, ctx.preset.width, ctx.preset.height);
  }

  if (options.toneStrength > 0) {
    const lut = buildToneLut(working, ctx.palette, {
      strength: options.toneStrength,
      // Лестницу подгоняем под лицо, если оно найдено: фон не должен решать,
      // как распределятся тона на коже.
      mask: options.toneOnFace && ctx.faces.length ? ctx.faceMask : null,
      maskWidth: ctx.preset.width,
      maskHeight: ctx.preset.height,
    });
    applyToneLut(working, lut);
  }

  return computeAverageGrid(working, {
    cols: ctx.preset.width,
    rows: ctx.preset.height,
    colorSpace: ctx.mode.colorSpace,
  });
}

function withLimits(ctx, averageGrid, mapping) {
  return applyPieceLimits({
    averageGrid,
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

/* --------------------------------------------------------- кандидаты */

/**
 * Каждый кандидат — набор параметров. Сознательно не добавляю сложность
 * ради сложности: отличия минимальны и проверяемы по отдельности.
 */
const CANDIDATES = [
  { id: 'baseline', toneStrength: 0, localContrast: 0, diffusion: null },
  { id: 'C1-tone-0.5', toneStrength: 0.5, localContrast: 0, diffusion: null },
  { id: 'C2-tone-0.8', toneStrength: 0.8, localContrast: 0, diffusion: null },
  { id: 'C3-contrast', toneStrength: 0, localContrast: 0.45, diffusion: null },
  { id: 'C4-tone+contrast', toneStrength: 0.6, localContrast: 0.35, diffusion: null },
  { id: 'C5-tone+diff', toneStrength: 0.6, localContrast: 0, diffusion: 'adaptive' },
  { id: 'C6-full', toneStrength: 0.6, localContrast: 0.35, diffusion: 'adaptive' },
  { id: 'C7-tone-face', toneStrength: 0.6, localContrast: 0.35, diffusion: null, toneOnFace: true },
  // C8/C9 — коррекция тона ограничена лицом: фон остаётся как в baseline.
  { id: 'C8-regional', toneStrength: 0, localContrast: 0, diffusion: null, regionalTone: 0.7 },
  { id: 'C9-regional+diff', toneStrength: 0, localContrast: 0, diffusion: 'adaptive', regionalTone: 0.7 },
];

function runCandidate(testCase, ctx, candidate, skinHexes) {
  const started = performance.now();

  const averageGrid = makeAverageGrid(testCase, ctx, {
    toneStrength: candidate.toneStrength,
    localContrast: candidate.localContrast,
    toneOnFace: candidate.toneOnFace ?? false,
    regionalTone: candidate.regionalTone ?? 0,
  });

  const mapping =
    candidate.diffusion === 'adaptive'
      ? labDiffusionMapGrid({
          grid: averageGrid,
          palette: ctx.palette,
          weightMap: ctx.weightMap,
          config: { adaptive: true, zones: LAB_DIFFUSION_ZONES, perceptual: PERCEPTUAL_PRESETS.portrait },
        })
      : mapGridToPalette(averageGrid, ctx.palette, { metric: ctx.profile.distanceMetric });

  const limit = withLimits(ctx, averageGrid, mapping);
  const ms = performance.now() - started;

  // ВАЖНО: метрики считаем против ИСХОДНОЙ сетки (без тонального сдвига).
  // Иначе кандидат, который изменил тон, сравнивался бы сам с собой.
  const referenceGrid = makeAverageGrid(testCase, ctx, { toneStrength: 0, localContrast: 0, regionalTone: 0 });

  const metrics = computeVariantMetrics({
    averageGrid: referenceGrid,
    mosaicGrid: limit.mapping.grid,
    maps: ctx.maps,
    weightMap: ctx.weightMap,
  });
  const tone = toneCoverage(referenceGrid, limit.mapping.grid, ctx.weightMap);
  const ssim = structuralSimilarity(referenceGrid, limit.mapping.grid);
  const leak = leakageBreakdown(limit.mapping.grid, ctx.weightMap, skinHexes, ctx.preset.height);

  return {
    id: candidate.id,
    ms: Math.round(ms),
    ssim,
    ...metrics,
    faceLevels: tone.levelsUsed,
    faceEffectiveLevels: tone.effectiveLevels,
    contrastRatio: tone.contrastRatio,
    leakage: leak.outsideFace,
    satisfied: limit.satisfied,
    grid: limit.mapping.grid,
  };
}

function skinColorsOf(ctx, grid) {
  const counts = new Map();
  for (let i = 0; i < grid.cells.length; i++) {
    const label = REGION_LABELS[ctx.weightMap.region[i]];
    if (label !== 'face' && label !== 'mouth') continue;
    counts.set(grid.cells[i].hex, (counts.get(grid.cells[i].hex) ?? 0) + 1);
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

/* --------------------------------------------------------------- прогон */

const realCases = loadRealCases();
const report = {};

for (const presetId of PRESETS) {
  const preset = getPreset(presetId);
  const cases = [
    ...realCases.filter((item) => item.preset === presetId),
    ...buildSyntheticCases(presetId, preset.width * 12, preset.height * 12),
  ];

  const totals = new Map();
  const perCase = [];

  for (const testCase of cases) {
    const ctx = analyse(testCase);
    const baseGrid = makeAverageGrid(testCase, ctx, { toneStrength: 0, localContrast: 0, regionalTone: 0 });
    const baseMapping = mapGridToPalette(baseGrid, ctx.palette, { metric: ctx.profile.distanceMetric });
    const skinHexes = skinColorsOf(ctx, withLimits(ctx, baseGrid, baseMapping).mapping.grid);

    const results = CANDIDATES.map((candidate) => runCandidate(testCase, ctx, candidate, skinHexes));

    // Реальные фотографии сохраняем как изображения — по ним судим глазами.
    if (testCase.kind === 'real') {
      renderImage(testCase.image, join(OUT, `${testCase.id}-original.png`), preset.width * 6, preset.height * 6);
      for (const result of results) {
        renderGrid(result.grid, join(OUT, `${testCase.id}-${result.id}.png`), 6);
        renderGrid(result.grid, join(OUT, `${testCase.id}-${result.id}-physical.png`), 2);
      }
    }

    for (const result of results) {
      delete result.grid;
      const bucket = totals.get(result.id) ?? { n: 0, ssim: 0, deltaE: 0, faceDeltaE: 0, edge: 0, monolith: 0, levels: 0, contrast: 0, leak: 0, ok: 0 };
      bucket.n++;
      bucket.ssim += result.ssim;
      bucket.deltaE += result.deltaE;
      bucket.faceDeltaE += result.faceDeltaE;
      bucket.edge += result.edgeScore;
      bucket.monolith += result.monolithShare;
      bucket.levels += result.faceEffectiveLevels;
      bucket.contrast += result.contrastRatio;
      bucket.leak += result.leakage;
      bucket.ok += result.satisfied ? 1 : 0;
      totals.set(result.id, bucket);
    }

    perCase.push({ id: testCase.id, kind: testCase.kind, results });
  }

  const summary = [...totals.entries()].map(([id, bucket]) => ({
    id,
    ssim: round(bucket.ssim / bucket.n),
    deltaE: round(bucket.deltaE / bucket.n),
    faceDeltaE: round(bucket.faceDeltaE / bucket.n),
    edgeScore: round(bucket.edge / bucket.n),
    monolithShare: round(bucket.monolith / bucket.n),
    faceLevels: round(bucket.levels / bucket.n),
    contrastRatio: round(bucket.contrast / bucket.n),
    leakage: round(bucket.leak / bucket.n),
    compliance: `${bucket.ok}/${bucket.n}`,
  }));

  report[presetId] = { cases: cases.length, summary, perCase };

  console.log(`\n=== ${presetId} (${preset.width}×${preset.height}, ${cases.length} изображений) ===`);
  console.log('кандидат            SSIM    ΔE  лицоΔE  границы  монолиты  уровниЛица  рельеф  утечка  лимиты');
  for (const row of summary) {
    console.log(
      `${row.id.padEnd(18)}${String(row.ssim).padStart(6)}${String(row.deltaE).padStart(6)}` +
        `${String(row.faceDeltaE).padStart(8)}${String(row.edgeScore).padStart(9)}` +
        `${String(row.monolithShare + '%').padStart(10)}${String(row.faceLevels).padStart(12)}` +
        `${String(row.contrastRatio).padStart(8)}${String(row.leakage + '%').padStart(8)}${String(row.compliance).padStart(8)}`,
    );
  }
}

writeFileSync(join(OUT, 'results-10.json'), JSON.stringify(report, null, 1));
console.log(`\nИзображения и results-10.json — в ${OUT}`);

function round(value) {
  return Math.round(value * 1000) / 1000;
}
