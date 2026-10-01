/**
 * Стенд этапа 11: превращение C9 в устойчивый кандидат.
 *
 * Проверяется три вещи:
 *   1. работает ли C9 без лица (fallback на область объекта);
 *   2. сколько тонального сдвига реально нужно;
 *   3. какая сила диффузии оптимальна для каждого пресета.
 *
 * Production не трогается. Запуск: npm run exp:11
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
import {
  grainShare,
  recognitionScore,
  structuralSimilarity,
  toneCoverage,
} from '../src/algorithms/experimental/recognition.ts';
import { detectSubjectRegion, dynamicRangeRatio } from '../src/algorithms/experimental/subjectRegion.ts';
import {
  applyToneLutMasked,
  buildToneLut,
  faceMaskFromRegions,
  paletteLuminanceLadder,
} from '../src/algorithms/experimental/toneMapping.ts';
import { LAB_DIFFUSION_ZONES, PERCEPTUAL_PRESETS } from '../src/config/experiments.ts';
import { buildPresetPalette } from '../src/config/paletteData.ts';
import { getPreset } from '../src/config/productPresets.ts';
import { getProcessingProfile } from '../src/config/processingProfiles.ts';
import { getMode } from '../src/config/quality.ts';
import { labChroma, rgbToLab } from '../src/algorithms/color/lab.ts';
import { buildSyntheticCases, loadRealCases } from './dataset.mjs';

const OUT = process.env.EXP_OUT ?? '/tmp/exp11';
const PRESETS = ['classic-s', 'color-s', 'color-m'];
mkdirSync(OUT, { recursive: true });

/* ---------------------------------------------------------- PNG (кратко) */

let crcTable = null;
const crc32 = (buffer) => {
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
};

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

/* ------------------------------------------------------------ контекст */

/** Порог уверенности детектора, ниже которого лицу не доверяем. */
const FACE_CONFIDENCE_MIN = 0.5;
/** Порог уверенности области объекта. */
const SUBJECT_CONFIDENCE_MIN = 0.35;

function analyse(testCase) {
  const preset = getPreset(testCase.preset);
  const profile = getProcessingProfile(preset.processingProfile);
  const mode = getMode(profile.modeId);
  const palette = buildPresetPalette(preset);

  const detection = detectFaces(testCase.image);
  const faces = buildAllFaceRegions(testCase.image, detection.faces, { skin: detection.skin });

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

  const referenceGrid = computeAverageGrid(reference, {
    cols: preset.width,
    rows: preset.height,
    colorSpace: mode.colorSpace,
  });

  const faceMask = faceMaskFromRegions(weightMap.region, REGION_LABELS, ['face', 'mouth', 'eyes', 'contour']);
  const faceCells = faceMask.reduce((sum, value) => sum + value, 0);
  const faceConfidence = faces.length
    ? Math.max(...faces.map((face) => face.face.confidence * (0.6 + 0.4 * face.featureConfidence)))
    : 0;

  const subject = detectSubjectRegion(referenceGrid, maps);
  const range = dynamicRangeRatio(referenceGrid, paletteLuminanceLadder(palette));

  /**
   * Решение, к какой области применять тональную коррекцию.
   * Порядок: уверенное лицо → область объекта → не применять вовсе.
   */
  let region = null;
  let regionSource = 'none';
  if (faceConfidence >= FACE_CONFIDENCE_MIN && faceCells > referenceGrid.cells.length * 0.03) {
    region = faceMask;
    regionSource = 'face';
  } else if (subject.confidence >= SUBJECT_CONFIDENCE_MIN) {
    region = subject.mask;
    regionSource = 'subject';
  }

  return {
    preset,
    profile,
    mode,
    palette,
    faces,
    maps,
    weightMap,
    referenceGrid,
    faceMask,
    faceConfidence: Math.round(faceConfidence * 100) / 100,
    subject,
    region,
    regionSource,
    dynamicRange: range,
  };
}

function buildGrid(testCase, ctx, options) {
  const working = cloneImage(testCase.image);
  preprocessImage(working, ctx.mode.preprocess);

  if (options.toneStrength > 0 && ctx.region) {
    const lut = buildToneLut(working, ctx.palette, {
      strength: options.toneStrength,
      mask: ctx.region,
      maskWidth: ctx.preset.width,
      maskHeight: ctx.preset.height,
      maxShift: options.maxShift,
    });
    applyToneLutMasked(working, lut, ctx.region, ctx.preset.width, ctx.preset.height);
  }

  return computeAverageGrid(working, {
    cols: ctx.preset.width,
    rows: ctx.preset.height,
    colorSpace: ctx.mode.colorSpace,
  });
}

function run(testCase, ctx, candidate, skinHexes) {
  const started = performance.now();
  const grid = buildGrid(testCase, ctx, candidate);

  const mapping =
    candidate.diffusion > 0
      ? labDiffusionMapGrid({
          grid,
          palette: ctx.palette,
          weightMap: ctx.weightMap,
          config: {
            adaptive: true,
            strength: candidate.diffusion,
            zones: scaleZones(candidate.diffusion),
            perceptual: PERCEPTUAL_PRESETS.portrait,
          },
        })
      : mapGridToPalette(grid, ctx.palette, { metric: ctx.profile.distanceMetric });

  const limit = applyPieceLimits({
    averageGrid: grid,
    mapping,
    palette: ctx.palette,
    options: {
      metric: ctx.profile.distanceMetric,
      weights: ctx.mode.costWeights,
      maps: ctx.maps,
      cellWeights: ctx.weightMap.weight,
    },
  });
  const ms = performance.now() - started;

  const result = limit.mapping.grid;
  const metrics = computeVariantMetrics({
    averageGrid: ctx.referenceGrid,
    mosaicGrid: result,
    maps: ctx.maps,
    weightMap: ctx.weightMap,
  });
  const tone = toneCoverage(ctx.referenceGrid, result, ctx.weightMap);
  const ssim = structuralSimilarity(ctx.referenceGrid, result);
  const grain = grainShare(result);
  const leak = leakageBreakdown(result, ctx.weightMap, skinHexes, ctx.preset.height);

  return {
    id: candidate.id,
    ms: Math.round(ms),
    recognition: recognitionScore({
      ssim,
      edgeScore: metrics.edgeScore,
      contrastRatio: tone.contrastRatio,
      grain,
      deltaE: metrics.deltaE,
    }),
    ssim,
    grain,
    ...metrics,
    faceLevels: tone.effectiveLevels,
    contrastRatio: tone.contrastRatio,
    leakage: leak.outsideFace,
    satisfied: limit.satisfied,
    grid: result,
  };
}

/** Зональные силы масштабируются вместе с общей — пропорции сохраняются. */
function scaleZones(strength) {
  const factor = strength / LAB_DIFFUSION_ZONES.base;
  const zones = {};
  for (const [key, value] of Object.entries(LAB_DIFFUSION_ZONES)) zones[key] = value * factor;
  return zones;
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

/* --------------------------------------------------------- кандидаты */

const ONLY_REAL = process.env.ONLY_REAL === '1';
const SHORT = process.env.SHORT === '1';

const CANDIDATES = (SHORT
  ? [
      { id: 'baseline', toneStrength: 0, diffusion: 0 },
      { id: 'tone-only', toneStrength: 0.7, maxShift: 14, diffusion: 0 },
      { id: 'diff-0.15', toneStrength: 0.7, maxShift: 14, diffusion: 0.15 },
    ]
  : [
  { id: 'baseline', toneStrength: 0, diffusion: 0 },
  { id: 'C9', toneStrength: 0.7, diffusion: 0.55 },

  // Ограничение тонального сдвига.
  { id: 'shift-8', toneStrength: 0.7, maxShift: 8, diffusion: 0.55 },
  { id: 'shift-14', toneStrength: 0.7, maxShift: 14, diffusion: 0.55 },
  { id: 'shift-20', toneStrength: 0.7, maxShift: 20, diffusion: 0.55 },
  { id: 'shift-30', toneStrength: 0.7, maxShift: 30, diffusion: 0.55 },

  // Сила диффузии при фиксированном сдвиге.
  { id: 'diff-0.15', toneStrength: 0.7, maxShift: 14, diffusion: 0.15 },
  { id: 'diff-0.25', toneStrength: 0.7, maxShift: 14, diffusion: 0.25 },
  { id: 'diff-0.35', toneStrength: 0.7, maxShift: 14, diffusion: 0.35 },
  { id: 'diff-0.45', toneStrength: 0.7, maxShift: 14, diffusion: 0.45 },
  { id: 'diff-0.70', toneStrength: 0.7, maxShift: 14, diffusion: 0.7 },

  // Только тон / только диффузия — чтобы видеть вклад каждой половины.
  { id: 'tone-only', toneStrength: 0.7, maxShift: 14, diffusion: 0 },
  { id: 'diff-only', toneStrength: 0, diffusion: 0.35 },
]);

/* --------------------------------------------------------------- прогон */

const realCases = loadRealCases();
const report = {};

for (const presetId of PRESETS) {
  const preset = getPreset(presetId);
  const cases = ONLY_REAL
    ? realCases.filter((item) => item.preset === presetId)
    : [
        ...realCases.filter((item) => item.preset === presetId),
        ...buildSyntheticCases(presetId, preset.width * 12, preset.height * 12),
      ];

  const perCase = [];
  const byKind = new Map();
  const regionStats = new Map();

  for (const testCase of cases) {
    const ctx = analyse(testCase);
    const baseGrid = buildGrid(testCase, ctx, { toneStrength: 0, diffusion: 0 });
    const baseMapping = mapGridToPalette(baseGrid, ctx.palette, { metric: ctx.profile.distanceMetric });
    const skinHexes = skinColorsOf(ctx, baseMapping.grid);

    const results = CANDIDATES.map((candidate) => run(testCase, ctx, candidate, skinHexes));

    const SAVE = (process.env.SAVE ?? '').split(',').filter(Boolean);
    if (testCase.kind === 'real' && (SAVE.length === 0 || SAVE.some((tag) => testCase.id.includes(tag)))) {
      for (const result of results) {
        renderGrid(result.grid, join(OUT, `${testCase.id}-${result.id}.png`), 6);
        renderGrid(result.grid, join(OUT, `${testCase.id}-${result.id}-physical.png`), 2);
      }
    }

    const kind = testCase.kind === 'real' ? 'real' : testCase.id.replace(/-\d+$/, '');
    regionStats.set(kind, regionStats.get(kind) ?? { face: 0, subject: 0, none: 0, n: 0, range: 0 });
    const stat = regionStats.get(kind);
    stat[ctx.regionSource]++;
    stat.n++;
    stat.range += ctx.dynamicRange;

    for (const result of results) {
      delete result.grid;
      const key = `${kind}|${result.id}`;
      const bucket = byKind.get(key) ?? { n: 0, recognition: 0, ssim: 0, deltaE: 0, edge: 0, monolith: 0, grain: 0, levels: 0, contrast: 0, ok: 0 };
      bucket.n++;
      bucket.recognition += result.recognition;
      bucket.ssim += result.ssim;
      bucket.deltaE += result.deltaE;
      bucket.edge += result.edgeScore;
      bucket.monolith += result.monolithShare;
      bucket.grain += result.grain;
      bucket.levels += result.faceLevels;
      bucket.contrast += result.contrastRatio;
      bucket.ok += result.satisfied ? 1 : 0;
      byKind.set(key, bucket);
    }

    perCase.push({
      id: testCase.id,
      kind: testCase.kind,
      regionSource: ctx.regionSource,
      faceConfidence: ctx.faceConfidence,
      subjectConfidence: ctx.subject.confidence,
      dynamicRange: ctx.dynamicRange,
      results,
    });
  }

  report[presetId] = {
    perCase,
    byKind: [...byKind.entries()].map(([key, bucket]) => {
      const [kind, id] = key.split('|');
      return {
        kind,
        id,
        n: bucket.n,
        recognition: round(bucket.recognition / bucket.n),
        ssim: round(bucket.ssim / bucket.n),
        deltaE: round(bucket.deltaE / bucket.n),
        edgeScore: round(bucket.edge / bucket.n),
        monolithShare: round(bucket.monolith / bucket.n),
        grain: round(bucket.grain / bucket.n),
        faceLevels: round(bucket.levels / bucket.n),
        contrastRatio: round(bucket.contrast / bucket.n),
        compliance: `${bucket.ok}/${bucket.n}`,
      };
    }),
    regions: [...regionStats.entries()].map(([kind, stat]) => ({
      kind,
      n: stat.n,
      face: stat.face,
      subject: stat.subject,
      none: stat.none,
      dynamicRange: round(stat.range / stat.n),
    })),
  };

  console.log(`\n=== ${presetId} — выбор области ===`);
  for (const row of report[presetId].regions) {
    console.log(
      `${row.kind.padEnd(12)} n=${String(row.n).padStart(2)}  лицо ${row.face}  объект ${row.subject}  нет ${row.none}  ` +
        `динамич.диапазон ${row.dynamicRange} шага`,
    );
  }
}

writeFileSync(join(OUT, 'results-11.json'), JSON.stringify(report, null, 1));
console.log(`\nГотово: ${OUT}`);

function round(value) {
  return Math.round(value * 1000) / 1000;
}
