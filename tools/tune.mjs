/**
 * Автоподбор параметров варианта по бенчмарку.
 *
 *   npm run tune                              — вариант I, параметры по умолчанию
 *   npm run tune -- --variant B               — другой стартовый вариант
 *   npm run tune -- --params contrast,dithering
 *   npm run tune -- --params faceExposure,levels,contrast — тональные переключатели только явно
 *   npm run tune -- --category classic        — только кадры Classic
 *   npm run tune -- --frames 24 --budget 60   — подвыборка для поиска, бюджет оценок
 *   npm run tune -- --jobs 4                  — потоков (по умолчанию все ядра)
 *   npm run tune -- --apply                   — записать результат в src/config/tuned.json
 *
 * Как работает. Берёт настройки встроенного варианта как старт и ходит
 * покоординатным спуском (src/algorithms/experimental/tuning.ts): по
 * одному параметру, шаг вниз и шаг вверх, принимается только шаг, который
 * улучшает среднюю узнаваемость и не нарушает ограничения — запас деталей
 * на каждом кадре и рябь не выше стартовой плюс допуск. Та же метрика, что
 * в npm run bench, поэтому результат согласован со шлюзом регрессий.
 *
 * Если поиск шёл на подвыборке, в конце найденное проверяется на всех
 * кадрах: улучшение, которое не подтвердилось на полном наборе, не
 * записывается. С --apply вариант попадает в ленту отдельным пунктом
 * «Автоподбор» — встроенные варианты не меняются; выигрывает ли он у них,
 * покажет сводка выборов (npm run choices).
 *
 * Кадры: python3 tools/prepare-benchmark.py <папка с фото>.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import { VARIANT_PRESETS, normalizeVariantSettings } from '../src/config/variants.ts';
import { getPreset } from '../src/config/productPresets.ts';
import {
  TUNABLE_PARAMS,
  coordinateDescent,
  defaultTunableKeys,
  describeChange,
  settingsToVector,
  vectorToSettings,
} from '../src/algorithms/experimental/tuning.ts';

/* --- аргументы --------------------------------------------------------- */

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const FRAMES_DIR = process.env.BENCH_FRAMES ?? 'benchmark/frames';
const OUT_DIR = option('out', 'benchmark/tune');
const VARIANT_ID = String(option('variant', 'I'));
const CATEGORY = option('category', null);
const PARAMS = option('params', null) ? String(option('params')).split(',').map((s) => s.trim()).filter(Boolean) : null;
const SUBSET = Number(option('frames', 0)) || 0;
const BUDGET = Number(option('budget', 60)) || 60;
const ROUNDS = Number(option('rounds', 3)) || 3;
const JOBS = Math.max(1, Number(option('jobs', availableParallelism())) || 1);
const APPLY = args.includes('--apply');
/** Насколько рябь (в процентах ячеек) может вырасти относительно старта. */
const GRAIN_ALLOWANCE = Number(option('grain', 2)) || 2;
/** Минимальный прирост на полном наборе, чтобы считать подбор подтверждённым. */
const CONFIRM_MIN = 0.002;

const start = VARIANT_PRESETS.find((preset) => preset.id === VARIANT_ID);
if (!start) {
  console.error(`Нет варианта ${VARIANT_ID}. Есть: ${VARIANT_PRESETS.map((p) => p.id).join(', ')}`);
  process.exit(2);
}
if (PARAMS) {
  const unknown = PARAMS.filter((key) => !TUNABLE_PARAMS.some((param) => param.key === key));
  if (unknown.length) {
    console.error(`Неизвестные параметры: ${unknown.join(', ')}. Доступны: ${TUNABLE_PARAMS.map((p) => p.key).join(', ')}`);
    process.exit(2);
  }
}
if (!existsSync(FRAMES_DIR) || readdirSync(FRAMES_DIR).length === 0) {
  console.error(`Нет кадров в ${FRAMES_DIR}. Сначала: python3 tools/prepare-benchmark.py <папка с фото>`);
  process.exit(2);
}

/* --- кадры -------------------------------------------------------------- */

const allKeys = readdirSync(FRAMES_DIR)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/, ''))
  .filter((key) => {
    if (!CATEGORY) return true;
    const meta = JSON.parse(readFileSync(`${FRAMES_DIR}/${key}.json`, 'utf8'));
    return getPreset(meta.preset).category === CATEGORY;
  })
  .sort();

if (!allKeys.length) {
  console.error(`Нет кадров${CATEGORY ? ` категории ${CATEGORY}` : ''} в ${FRAMES_DIR}`);
  process.exit(2);
}

/** Детерминированная подвыборка: равномерный шаг по отсортированному списку. */
function subsample(keys, count) {
  if (!count || count >= keys.length) return keys;
  const picked = [];
  for (let i = 0; i < count; i++) picked.push(keys[Math.floor((i * keys.length) / count)]);
  return picked;
}

const searchKeys = subsample(allKeys, SUBSET);

/* --- пул потоков -------------------------------------------------------- */

const jobs = Math.min(JOBS, allKeys.length);
const partitions = Array.from({ length: jobs }, () => []);
allKeys.forEach((key, index) => partitions[index % jobs].push(key));

const workers = partitions.map((frames) => {
  const worker = new Worker(new URL('./tune-worker.mjs', import.meta.url), { workerData: { framesDir: FRAMES_DIR, frames } });
  return { worker, frames, ready: new Promise((resolve) => worker.once('message', (m) => m.type === 'ready' && resolve())) };
});
await Promise.all(workers.map((entry) => entry.ready));

let jobCounter = 0;
function evaluateOn(keys, settings) {
  const wanted = new Set(keys);
  return Promise.all(
    workers.map(({ worker, frames }) => {
      const mine = frames.filter((key) => wanted.has(key));
      if (!mine.length) return Promise.resolve({});
      const jobId = ++jobCounter;
      return new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message.type !== 'result' || message.jobId !== jobId) return;
          worker.off('message', onMessage);
          worker.off('error', onError);
          resolve(message.results);
        };
        const onError = (error) => {
          worker.off('message', onMessage);
          reject(error);
        };
        worker.on('message', onMessage);
        worker.once('error', onError);
        worker.postMessage({ type: 'evaluate', jobId, frames: mine, settings });
      });
    }),
  ).then((parts) => Object.assign({}, ...parts));
}

function aggregate(results) {
  const entries = Object.values(results);
  const errors = entries.filter((entry) => entry.error);
  if (errors.length) throw new Error(`Ошибка расчёта: ${errors[0].error}`);
  const mean = (key) => entries.reduce((sum, entry) => sum + entry[key], 0) / (entries.length || 1);
  return {
    frames: entries.length,
    recognition: mean('recognition'),
    grain: mean('grain'),
    contrast: mean('contrast'),
    ssim: mean('ssim'),
    limits: entries.every((entry) => entry.limits),
  };
}

/* --- поиск -------------------------------------------------------------- */

const startVector = settingsToVector(start.settings);
const startedAt = Date.now();
const startAggregate = aggregate(await evaluateOn(searchKeys, start.settings));
const grainCeiling = startAggregate.grain + GRAIN_ALLOWANCE;

console.log(`Автоподбор от варианта ${start.id} «${start.name}»${CATEGORY ? `, кадры ${CATEGORY}` : ''}`);
console.log(`Кадров для поиска: ${searchKeys.length} из ${allKeys.length}; потоков: ${jobs}; бюджет: ${BUDGET} оценок`);
console.log(`Параметры: ${(PARAMS ?? defaultTunableKeys()).join(', ')}`);
console.log(`Старт: узнаваемость ${startAggregate.recognition.toFixed(4)}, рябь ${startAggregate.grain.toFixed(1)}%, рельеф ${startAggregate.contrast.toFixed(2)}`);
console.log(`Ограничения: запас деталей на каждом кадре, рябь не выше ${grainCeiling.toFixed(1)}%\n`);

const evaluate = async (vector) => {
  const settings = vectorToSettings(vector, start.settings);
  const summary = aggregate(await evaluateOn(searchKeys, settings));
  return {
    objective: summary.recognition,
    feasible: summary.limits && summary.grain <= grainCeiling + 1e-9,
    details: { grain: summary.grain, contrast: summary.contrast, ssim: summary.ssim, limits: summary.limits },
  };
};

const result = await coordinateDescent(startVector, evaluate, {
  params: PARAMS ?? undefined,
  budget: BUDGET,
  rounds: ROUNDS,
  onProgress: ({ evaluations, budget, round, param, best }) => {
    process.stdout.write(`\r  оценка ${String(evaluations).padStart(3)}/${budget}  раунд ${round}  ${param.padEnd(20)}  лучшее ${best.toFixed(4)}   `);
  },
});
process.stdout.write('\n\n');

if (!result.steps.length) {
  console.log('Улучшений не найдено: стартовые настройки — локальный максимум по этой метрике.');
}
for (const step of result.steps) {
  const param = TUNABLE_PARAMS.find((p) => p.key === step.param);
  console.log(`  раунд ${step.round}: ${param.label} ${step.from} → ${step.to}  ⇒ ${step.objective.toFixed(4)}`);
}
if (result.exhausted) console.log('  (бюджет оценок исчерпан — поиск мог не дойти до конца; увеличьте --budget)');

/* --- подтверждение на полном наборе ------------------------------------ */

const bestSettings = normalizeVariantSettings(vectorToSettings(result.best, start.settings), start.settings);
let fullStart = startAggregate;
let fullBest = { ...startAggregate, ...result.bestEvaluation.details, recognition: result.bestEvaluation.objective };
let confirmed = result.steps.length > 0;

if (result.steps.length && searchKeys.length < allKeys.length) {
  console.log(`\nПроверка на всех ${allKeys.length} кадрах…`);
  fullStart = aggregate(await evaluateOn(allKeys, start.settings));
  fullBest = aggregate(await evaluateOn(allKeys, bestSettings));
  const gain = fullBest.recognition - fullStart.recognition;
  confirmed = fullBest.limits && gain >= CONFIRM_MIN && fullBest.grain <= fullStart.grain + GRAIN_ALLOWANCE;
  console.log(`  старт ${fullStart.recognition.toFixed(4)} → найдено ${fullBest.recognition.toFixed(4)} (${gain >= 0 ? '+' : ''}${gain.toFixed(4)}), ` +
    `рябь ${fullStart.grain.toFixed(1)}% → ${fullBest.grain.toFixed(1)}%, лимиты ${fullBest.limits ? 'ok' : 'НАРУШЕНЫ'}`);
  console.log(confirmed ? '  подтверждено' : '  не подтвердилось на полном наборе — результат не записывается');
}

/* --- отчёт -------------------------------------------------------------- */

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const reportPath = `${OUT_DIR}/${start.id}${CATEGORY ? `-${CATEGORY}` : ''}-${stamp}.json`;
const report = {
  variant: start.id,
  category: CATEGORY,
  params: PARAMS ?? defaultTunableKeys(),
  frames: { search: searchKeys.length, total: allKeys.length },
  budget: BUDGET,
  evaluations: result.evaluations,
  durationSec: Math.round((Date.now() - startedAt) / 1000),
  start: { settings: start.settings, search: startAggregate, full: fullStart },
  best: { settings: bestSettings, search: { ...result.bestEvaluation.details, recognition: result.bestEvaluation.objective }, full: fullBest },
  steps: result.steps,
  changes: describeChange(startVector, result.best),
  confirmed,
};
writeFileSync(reportPath, JSON.stringify(report, null, 1));

console.log(`\nИтог (${report.durationSec} с, ${result.evaluations} оценок): узнаваемость ${fullStart.recognition.toFixed(4)} → ${fullBest.recognition.toFixed(4)}`);
for (const line of report.changes) console.log('  ' + line);
console.log(`Отчёт: ${reportPath}`);

/* --- запись в tuned.json ------------------------------------------------ */

if (APPLY && confirmed) {
  const path = 'src/config/tuned.json';
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { variants: [] };
  const id = CATEGORY === 'classic' ? 'TC' : CATEGORY === 'color' ? 'TO' : 'T';
  const record = {
    id,
    name: CATEGORY ? `Автоподбор (${CATEGORY === 'classic' ? 'Classic' : 'Color'})` : 'Автоподбор',
    description: `Настройки варианта «${start.name}», подобранные по бенчмарку из ${allKeys.length} кадров.`,
    base: start.id,
    ...(CATEGORY ? { categories: [CATEGORY] } : {}),
    settings: bestSettings,
    tunedAt: new Date().toISOString().slice(0, 10),
    objective: { frames: allKeys.length, start: round4(fullStart.recognition), best: round4(fullBest.recognition) },
  };
  current.variants = [...(current.variants ?? []).filter((item) => item && item.id !== id), record];
  writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
  console.log(`\nЗаписано в ${path} как вариант ${id} «${record.name}». Дальше: npm run bench, npm run build:standalone.`);
} else if (APPLY) {
  console.log('\n--apply пропущен: нечего записывать.');
}

for (const { worker } of workers) await worker.terminate();

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
