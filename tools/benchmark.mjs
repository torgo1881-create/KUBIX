/**
 * Регрессионный бенчмарк алгоритма.
 *
 * Зачем. Каждое улучшение до сих пор проверялось вручную, и каждое второе
 * что-то ломало незаметно — параметр силы дизеринга, детектор в квадратном
 * кадре, баланс белого. Этот скрипт делает проверку автоматической: гоняет
 * ключевые варианты по всем кадрам, считает метрики и сравнивает с
 * сохранённым эталоном. Ухудшение — видно сразу, до того как попадёт в
 * production.
 *
 *   npm run bench            — сравнить с эталоном
 *   npm run bench -- --update — принять текущий результат как эталон
 *
 * Кадры готовятся отдельно: python3 tools/prepare-benchmark.py <папка с фото>.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { computeMosaicCore } from '../src/algorithms/mosaicCore.ts';
import { computeAverageGrid } from '../src/algorithms/gridAverage.ts';
import { computeCellMaps } from '../src/algorithms/image/edges.ts';
import { cloneImage, preprocessImage } from '../src/algorithms/image/preprocess.ts';
import { computeVariantMetrics } from '../src/algorithms/experimental/qualityMetrics.ts';
import { grainShare, recognitionScore, structuralSimilarity, toneCoverage } from '../src/algorithms/experimental/recognition.ts';
import { VARIANT_PRESETS } from '../src/config/variants.ts';
import { buildPresetPalette } from '../src/config/paletteData.ts';
import { getPreset } from '../src/config/productPresets.ts';
import { getMode } from '../src/config/quality.ts';

const FRAMES = process.env.BENCH_FRAMES ?? 'benchmark/frames';
const BASELINE = 'benchmark/baseline.json';
const LATEST = 'benchmark/latest.json';
const UPDATE = process.argv.includes('--update');

/** Какие варианты сторожим: самый консервативный и три рабочих портретных. */
const WATCHED = ['A', 'B', 'K', 'I', 'G'];

/** Допуски: ниже этого — регрессия, о которой стоит знать. */
const TOLERANCE = { recognition: 0.01, detection: 0 };

if (!existsSync(FRAMES) || readdirSync(FRAMES).length === 0) {
  console.error(`Нет кадров в ${FRAMES}. Сначала: python3 tools/prepare-benchmark.py <папка с фото>`);
  process.exit(2);
}

const files = readdirSync(FRAMES).filter((f) => f.endsWith('.json')).sort();
const results = {};

for (const file of files) {
  const meta = JSON.parse(readFileSync(`${FRAMES}/${file}`, 'utf8'));
  const image = { width: meta.w, height: meta.h, data: new Uint8ClampedArray(readFileSync(`${FRAMES}/${file.replace('.json', '.raw')}`)) };
  const preset = getPreset(meta.preset);
  const palette = buildPresetPalette(preset);
  const mode = getMode('portrait');

  const reference = cloneImage(image);
  preprocessImage(reference, mode.preprocess);
  const referenceGrid = computeAverageGrid(reference, { cols: preset.width, rows: preset.height, colorSpace: mode.colorSpace });
  const maps = computeCellMaps(reference, preset.width, preset.height);

  const entry = { detection: null, variants: {} };

  for (const id of WATCHED) {
    const s = VARIANT_PRESETS.find((v) => v.id === id).settings;
    const core = computeMosaicCore(image, {
      cols: preset.width, rows: preset.height, mode: 'portrait', palette, enforcePieceLimits: true,
      faceExposure: s.faceExposure, levels: s.levels, dithering: s.dithering, toneBalance: s.toneBalance,
      eyeBoost: s.eyeBoost, faceVolume: s.faceVolume, gridDetail: { fine: s.detail ?? 0, coarse: s.localContrast ?? 0 },
      preprocess: { contrast: s.contrast, saturation: s.saturation, sharpen: s.sharpen, smooth: s.smoothing },
      sampleWidth: meta.w, sampleHeight: meta.h,
    });

    if (!entry.detection) {
      const best = core.faces.length ? Math.max(...core.faces.map((f) => f.face.confidence * (0.6 + 0.4 * f.featureConfidence))) : 0;
      entry.detection = { faces: core.faces.length, eyes: core.faces.reduce((n, f) => n + f.eyes.length, 0), confident: best >= 0.5 ? 1 : 0 };
    }

    const metrics = computeVariantMetrics({ averageGrid: referenceGrid, mosaicGrid: core.grid, maps, weightMap: core.weightMap });
    const tone = toneCoverage(referenceGrid, core.grid, core.weightMap);
    const ssim = structuralSimilarity(referenceGrid, core.grid);
    const grain = grainShare(core.grid);
    entry.variants[id] = {
      recognition: recognitionScore({ ssim, edgeScore: metrics.edgeScore, contrastRatio: tone.contrastRatio, grain, deltaE: metrics.deltaE }),
      ssim, grain, contrast: tone.contrastRatio, monolith: metrics.monolithShare,
      limits: core.pieceLimit?.satisfied ?? true,
    };
  }
  results[file.replace('.json', '')] = entry;
}

/* --- сводка --- */
const keys = Object.keys(results);
const summary = {
  frames: keys.length,
  detected: keys.reduce((n, k) => n + results[k].detection.confident, 0),
  variants: Object.fromEntries(WATCHED.map((id) => [id, {
    recognition: avg(keys.map((k) => results[k].variants[id].recognition)),
    grain: avg(keys.map((k) => results[k].variants[id].grain)),
    contrast: avg(keys.map((k) => results[k].variants[id].contrast)),
    limits: keys.every((k) => results[k].variants[id].limits),
  }])),
  date: new Date().toISOString().slice(0, 10),
};

writeFileSync(LATEST, JSON.stringify({ summary, results }, null, 1));

console.log(`\nБенчмарк: ${summary.frames} кадров, лицо найдено на ${summary.detected}`);
console.log('вариант   recog   рябь  рельеф  лимиты');
for (const id of WATCHED) {
  const v = summary.variants[id];
  console.log(`${id.padEnd(9)}${v.recognition.toFixed(3).padStart(6)}${(v.grain.toFixed(1) + '%').padStart(7)}${v.contrast.toFixed(2).padStart(8)}${(v.limits ? 'ok' : 'НЕТ').padStart(8)}`);
}

/* --- сравнение с эталоном --- */
if (UPDATE || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify({ summary, results }, null, 1));
  console.log(`\nЭталон ${UPDATE ? 'обновлён' : 'создан'}: ${BASELINE}`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const problems = [];

if (summary.detected < base.summary.detected - TOLERANCE.detection) {
  problems.push(`детекция: было ${base.summary.detected}, стало ${summary.detected}`);
}
for (const id of WATCHED) {
  const was = base.summary.variants[id]?.recognition;
  const now = summary.variants[id].recognition;
  if (was !== undefined && now < was - TOLERANCE.recognition) {
    problems.push(`вариант ${id}: узнаваемость ${was.toFixed(3)} → ${now.toFixed(3)}`);
  }
  if (!summary.variants[id].limits) problems.push(`вариант ${id}: нарушен запас деталей`);
}
// Кадры, на которых лицо перестало находиться.
for (const k of keys) {
  const wasFound = base.results[k]?.detection?.confident;
  if (wasFound === 1 && results[k].detection.confident === 0) problems.push(`лицо потеряно на ${k}`);
}

console.log(`\nСравнение с эталоном от ${base.summary.date}:`);
if (problems.length === 0) {
  console.log('  регрессий нет');
} else {
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}

function avg(values) { return values.reduce((s, v) => s + v, 0) / (values.length || 1); }
