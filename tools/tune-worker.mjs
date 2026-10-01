/**
 * Рабочий поток автоподбора: держит у себя часть кадров бенчмарка и
 * считает по ним метрики для присланных настроек. Эталонные сетки и карты
 * считаются один раз на кадр и кэшируются — именно они дорогие.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

import { computeMosaicCore } from '../src/algorithms/mosaicCore.ts';
import { computeAverageGrid } from '../src/algorithms/gridAverage.ts';
import { computeCellMaps } from '../src/algorithms/image/edges.ts';
import { cloneImage, preprocessImage } from '../src/algorithms/image/preprocess.ts';
import { computeVariantMetrics } from '../src/algorithms/experimental/qualityMetrics.ts';
import { grainShare, recognitionScore, structuralSimilarity, toneCoverage } from '../src/algorithms/experimental/recognition.ts';
import { buildPresetPalette } from '../src/config/paletteData.ts';
import { getPreset } from '../src/config/productPresets.ts';
import { getMode } from '../src/config/quality.ts';

const { framesDir, frames } = workerData;
const cache = new Map();

function loadFrame(key) {
  const cached = cache.get(key);
  if (cached) return cached;

  const meta = JSON.parse(readFileSync(`${framesDir}/${key}.json`, 'utf8'));
  const image = {
    width: meta.w,
    height: meta.h,
    data: new Uint8ClampedArray(readFileSync(`${framesDir}/${key}.raw`)),
  };
  const preset = getPreset(meta.preset);
  const palette = buildPresetPalette(preset);
  const mode = getMode('portrait');

  const reference = cloneImage(image);
  preprocessImage(reference, mode.preprocess);
  const referenceGrid = computeAverageGrid(reference, { cols: preset.width, rows: preset.height, colorSpace: mode.colorSpace });
  const maps = computeCellMaps(reference, preset.width, preset.height);

  const frame = { image, preset, palette, referenceGrid, maps, category: preset.category };
  cache.set(key, frame);
  return frame;
}

/** Та же формула, что в tools/benchmark.mjs — иначе подбор и шлюз разойдутся. */
function evaluateFrame(frame, settings) {
  const core = computeMosaicCore(frame.image, {
    cols: frame.preset.width,
    rows: frame.preset.height,
    mode: 'portrait',
    palette: frame.palette,
    enforcePieceLimits: true,
    faceExposure: settings.faceExposure,
    levels: settings.levels,
    dithering: settings.dithering,
    toneBalance: settings.toneBalance,
    eyeBoost: settings.eyeBoost,
    faceVolume: settings.faceVolume,
    gridDetail: { fine: settings.detail ?? 0, coarse: settings.localContrast ?? 0 },
    preprocess: { contrast: settings.contrast, saturation: settings.saturation, sharpen: settings.sharpen, smooth: settings.smoothing },
    sampleWidth: frame.image.width,
    sampleHeight: frame.image.height,
  });

  const metrics = computeVariantMetrics({ averageGrid: frame.referenceGrid, mosaicGrid: core.grid, maps: frame.maps, weightMap: core.weightMap });
  const tone = toneCoverage(frame.referenceGrid, core.grid, core.weightMap);
  const ssim = structuralSimilarity(frame.referenceGrid, core.grid);
  const grain = grainShare(core.grid);

  return {
    recognition: recognitionScore({ ssim, edgeScore: metrics.edgeScore, contrastRatio: tone.contrastRatio, grain, deltaE: metrics.deltaE }),
    ssim,
    grain,
    contrast: tone.contrastRatio,
    limits: core.pieceLimit?.satisfied ?? true,
    faces: core.faces.length,
  };
}

parentPort.on('message', (message) => {
  if (message.type !== 'evaluate') return;
  const keys = message.frames ?? frames;
  const results = {};
  for (const key of keys) {
    try {
      results[key] = evaluateFrame(loadFrame(key), message.settings);
    } catch (error) {
      results[key] = { error: error && error.message ? error.message : String(error) };
    }
  }
  parentPort.postMessage({ type: 'result', jobId: message.jobId, results });
});

parentPort.postMessage({ type: 'ready' });
