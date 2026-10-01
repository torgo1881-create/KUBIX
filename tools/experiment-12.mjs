/**
 * Стенд этапа 12: все продуктовые варианты и два кандидата на улучшение,
 * прогнанные на реальных фотографиях.
 *
 * Кандидаты:
 *   K — «объём лица»: локальный контраст только внутри овала лица;
 *   L — «губы»: то же усиление, что для глаз, но по области рта.
 *
 * Запуск: npm run exp:12
 */
import { readFileSync, readdirSync } from 'node:fs';

import { computeMosaicCore } from '../src/algorithms/mosaicCore.ts';
import { computeAverageGrid } from '../src/algorithms/gridAverage.ts';
import { detectFaces } from '../src/algorithms/face/faceDetection.ts';
import { buildAllFaceRegions } from '../src/algorithms/face/faceRegions.ts';
import { computeCellMaps } from '../src/algorithms/image/edges.ts';
import { cloneImage, preprocessImage } from '../src/algorithms/image/preprocess.ts';
import { buildWeightMap } from '../src/algorithms/optimization/weightMap.ts';
import { computeVariantMetrics } from '../src/algorithms/experimental/qualityMetrics.ts';
import { grainShare, recognitionScore, structuralSimilarity, toneCoverage } from '../src/algorithms/experimental/recognition.ts';
import { VARIANT_PRESETS } from '../src/config/variants.ts';
import { buildPresetPalette } from '../src/config/paletteData.ts';
import { getPreset } from '../src/config/productPresets.ts';
import { getMode } from '../src/config/quality.ts';

const DIR = process.env.DS_DIR ?? '/tmp/ds';
const PRESETS = (process.env.PRESETS ?? 'classic-m,color-m').split(',');

/** Кандидаты поверх существующих вариантов — те же настройки плюс одна добавка. */
const CANDIDATES = [];

function loadCase(file) {
  const meta = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'));
  return {
    id: file.replace('.json', ''),
    preset: meta.preset,
    image: { width: meta.w, height: meta.h, data: new Uint8ClampedArray(readFileSync(`${DIR}/${file.replace('.json', '.raw')}`)) },
  };
}

function run(testCase, settings, extra = {}) {
  const preset = getPreset(testCase.preset);
  const palette = buildPresetPalette(preset);
  const mode = getMode('portrait');

  const core = computeMosaicCore(testCase.image, {
    cols: preset.width,
    rows: preset.height,
    mode: 'portrait',
    palette,
    enforcePieceLimits: true,
    faceExposure: settings.faceExposure,
    levels: settings.levels,
    dithering: extra.dithering ?? settings.dithering,
    toneBalance: settings.toneBalance,
    eyeBoost: extra.eyeBoost ?? settings.eyeBoost,
    faceVolume: extra.faceVolume ?? settings.faceVolume,
    mouthBoost: extra.mouthBoost,
    preprocess: { contrast: settings.contrast, saturation: settings.saturation, sharpen: settings.sharpen, smooth: settings.smoothing },
    sampleWidth: testCase.image.width,
    sampleHeight: testCase.image.height,
  });

  // Эталон для метрик — сетка без какой-либо обработки, одна на все варианты.
  const reference = cloneImage(testCase.image);
  preprocessImage(reference, mode.preprocess);
  const referenceGrid = computeAverageGrid(reference, { cols: preset.width, rows: preset.height, colorSpace: mode.colorSpace });
  const maps = computeCellMaps(reference, preset.width, preset.height);

  const metrics = computeVariantMetrics({ averageGrid: referenceGrid, mosaicGrid: core.grid, maps, weightMap: core.weightMap });
  const tone = toneCoverage(referenceGrid, core.grid, core.weightMap);
  const ssim = structuralSimilarity(referenceGrid, core.grid);
  const grain = grainShare(core.grid);

  return {
    recognition: recognitionScore({ ssim, edgeScore: metrics.edgeScore, contrastRatio: tone.contrastRatio, grain, deltaE: metrics.deltaE }),
    ssim,
    grain,
    contrast: tone.contrastRatio,
    levels: tone.effectiveLevels,
    monolith: metrics.monolithShare,
    ok: core.pieceLimit?.satisfied ?? true,
  };
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.json') && PRESETS.some((p) => name.endsWith(`-${p}.json`))).sort();
const totals = new Map();
const add = (key, r) => {
  const t = totals.get(key) ?? { n: 0, recognition: 0, ssim: 0, grain: 0, contrast: 0, levels: 0, monolith: 0, ok: 0 };
  t.n++;
  for (const k of ['recognition', 'ssim', 'grain', 'contrast', 'levels', 'monolith']) t[k] += r[k];
  t.ok += r.ok ? 1 : 0;
  totals.set(key, t);
};

for (const file of files) {
  const testCase = loadCase(file);
  for (const preset of VARIANT_PRESETS) add(`${preset.id} ${preset.name}`, run(testCase, preset.settings));
  for (const candidate of CANDIDATES) {
    const base = VARIANT_PRESETS.find((p) => p.id === candidate.base);
    add(`${candidate.id} ${candidate.name}`, run(testCase, base.settings, candidate.extra));
  }
}

console.log(`\n${files.length} кадров (${PRESETS.join(', ')})`);
console.log('вариант                        recog   SSIM   рябь  рельеф  уровни  монолит  лимиты');
const rows = [...totals.entries()].map(([id, t]) => ({ id, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, k === 'n' ? v : v / t.n])) }));
rows.sort((a, b) => b.recognition - a.recognition);
for (const r of rows) {
  console.log(
    `${r.id.padEnd(30)}${r.recognition.toFixed(3).padStart(6)}${r.ssim.toFixed(3).padStart(7)}` +
      `${(r.grain.toFixed(1) + '%').padStart(7)}${r.contrast.toFixed(2).padStart(8)}${r.levels.toFixed(2).padStart(8)}` +
      `${(r.monolith.toFixed(1) + '%').padStart(9)}${(Math.round(r.ok * files.length / files.length * 100) / 100 * 100).toFixed(0).padStart(6)}%`,
  );
}
