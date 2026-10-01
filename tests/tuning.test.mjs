/**
 * Автоподбор: кодирование настроек, соседи, покоординатный спуск и запись
 * результата как варианта. Метрики по кадрам здесь не считаются — поиск
 * проверяется на синтетической целевой функции, за миллисекунды.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TUNABLE_PARAMS,
  coordinateDescent,
  describeChange,
  neighbourValues,
  settingsToVector,
  vectorKey,
  vectorToSettings,
} from '../src/algorithms/experimental/tuning.ts';
import {
  ALL_VARIANT_PRESETS,
  VARIANT_PRESETS,
  normalizeVariantSettings,
  orderByRanking,
  parseTunedVariants,
  parseVariantRanking,
  rankingKey,
} from '../src/config/variants.ts';

const I = VARIANT_PRESETS.find((preset) => preset.id === 'I');
const A = VARIANT_PRESETS.find((preset) => preset.id === 'A');

test('настройки ↔ вектор: обход туда и обратно сохраняет значения', () => {
  for (const preset of VARIANT_PRESETS) {
    const vector = settingsToVector(preset.settings);
    for (const param of TUNABLE_PARAMS) assert.ok(param.key in vector, `${preset.id}: нет ${param.key}`);
    const back = vectorToSettings(vector, preset.settings);
    assert.equal(back.faceExposure, preset.settings.faceExposure);
    assert.equal(back.levels, preset.settings.levels);
    assert.equal(back.dithering, preset.settings.dithering);
    assert.equal(back.contrast, preset.settings.contrast);
    assert.equal(back.faceVolume ?? 0, preset.settings.faceVolume ?? 0);
    if (preset.settings.eyeBoost) {
      assert.equal(back.eyeBoost.contrast, preset.settings.eyeBoost.contrast);
      assert.equal(back.eyeBoost.radiusScale, preset.settings.eyeBoost.radiusScale, 'радиус берётся из базы');
    } else {
      assert.equal(back.eyeBoost, null);
    }
  }
});

test('нулевое усиление глаз превращается в его отсутствие', () => {
  const vector = { ...settingsToVector(I.settings), 'eyeBoost.contrast': 0, 'eyeBoost.darkBias': 0 };
  assert.equal(vectorToSettings(vector, I.settings).eyeBoost, null);
  const partly = { ...vector, 'eyeBoost.darkBias': 0.3 };
  assert.deepEqual(vectorToSettings(partly, I.settings).eyeBoost, {
    contrast: 0,
    darkBias: 0.3,
    radiusScale: I.settings.eyeBoost.radiusScale,
    includeBrows: true,
  });
});

test('соседи параметра не выходят за границы и не повторяют текущее', () => {
  const contrast = TUNABLE_PARAMS.find((param) => param.key === 'contrast');
  assert.deepEqual(neighbourValues(contrast, 1.0), [0.9, 1.1]);
  assert.deepEqual(neighbourValues(contrast, contrast.min), [contrast.min + contrast.step]);
  assert.deepEqual(neighbourValues(contrast, contrast.max), [contrast.max - contrast.step]);
  const levels = TUNABLE_PARAMS.find((param) => param.key === 'levels');
  assert.deepEqual(neighbourValues(levels, 0), [1]);
  assert.deepEqual(neighbourValues(levels, 1), [0]);
});

test('покоординатный спуск находит максимум и объясняет шаги', async () => {
  // Гладкая цель с максимумом в контрасте 1.28 и дизеринге 0.2; остальное не влияет.
  const target = { contrast: 1.28, dithering: 0.2 }; // на сетке шага 0.1 от старта 1.08
  let calls = 0;
  const evaluate = async (vector) => {
    calls++;
    const objective = 1 - (vector.contrast - target.contrast) ** 2 - (vector.dithering - target.dithering) ** 2;
    return { objective, feasible: true };
  };

  const result = await coordinateDescent(settingsToVector(A.settings), evaluate, {
    params: ['contrast', 'dithering'],
    budget: 40,
    rounds: 4,
  });

  assert.ok(Math.abs(result.best.contrast - 1.28) < 1e-9, `контраст ${result.best.contrast}`);
  assert.ok(Math.abs(result.best.dithering - 0.2) < 1e-9, `дизеринг ${result.best.dithering}`);
  assert.ok(result.bestEvaluation.objective > result.startEvaluation.objective);
  assert.ok(result.steps.length >= 2, 'каждый принятый шаг записан');
  assert.ok(result.steps.every((step) => step.param === 'contrast' || step.param === 'dithering'));
  assert.equal(result.evaluations, calls, 'оценки считаются честно');
  assert.ok(!result.exhausted);

  const lines = describeChange(result.start, result.best);
  assert.ok(lines.some((line) => line.includes('контраст')), lines.join('\n'));
});

test('недопустимые точки не принимаются, даже если цель выше', async () => {
  const evaluate = async (vector) => ({
    // Чем выше контраст, тем лучше цель, но выше 1.2 — нарушение лимитов.
    objective: vector.contrast,
    feasible: vector.contrast <= 1.2 + 1e-9,
  });
  const result = await coordinateDescent({ ...settingsToVector(A.settings), contrast: 1.0 }, evaluate, {
    params: ['contrast'],
    budget: 20,
    rounds: 5,
  });
  assert.ok(Math.abs(result.best.contrast - 1.2) < 1e-9, `остановился на границе: ${result.best.contrast}`);
});

test('бюджет оценок соблюдается, кэш не тратит бюджет', async () => {
  let calls = 0;
  const evaluate = async (vector) => {
    calls++;
    return { objective: vector.contrast + vector.sharpen, feasible: true };
  };
  const result = await coordinateDescent(settingsToVector(A.settings), evaluate, { budget: 5, rounds: 3 });
  assert.equal(calls, 5);
  assert.equal(result.evaluations, 5);
  assert.ok(result.exhausted, 'поиск сообщает, что упёрся в бюджет');
  assert.equal(vectorKey(result.start), vectorKey(settingsToVector(A.settings)));
});

test('тональные переключатели подбираются только по явному списку', async () => {
  const touched = new Set();
  const evaluate = async (vector) => {
    for (const key of Object.keys(vector)) if (vector[key] !== start[key]) touched.add(key);
    return { objective: 0, feasible: true };
  };
  const start = settingsToVector(I.settings);
  await coordinateDescent(start, evaluate, { budget: 100, rounds: 1 });
  assert.ok(!touched.has('faceExposure') && !touched.has('levels'), [...touched].join(','));
  assert.ok(touched.has('contrast'));

  touched.clear();
  await coordinateDescent(start, evaluate, { budget: 100, rounds: 1, params: ['faceExposure'] });
  assert.deepEqual([...touched], ['faceExposure']);
});

test('нет улучшений — старт остаётся лучшим, шагов нет', async () => {
  const start = settingsToVector(A.settings);
  const evaluate = async (vector) => ({ objective: vectorKey(vector) === vectorKey(start) ? 1 : 0, feasible: true });
  const result = await coordinateDescent(start, evaluate, { params: ['contrast', 'levels'], budget: 10 });
  assert.deepEqual(result.steps, []);
  assert.deepEqual(result.best, start);
});

test('tuned.json: корректные записи становятся вариантами, кривые пропускаются', () => {
  const presets = parseTunedVariants({
    variants: [
      { id: 'T', name: 'Автоподбор', base: 'I', settings: { ...I.settings, contrast: 1.2 } },
      { id: 'A', name: 'подмена встроенного', settings: I.settings },
      { id: 'T', name: 'дубликат', settings: I.settings },
      { id: '', name: 'без id', settings: I.settings },
      { id: 'X', settings: I.settings },
      { id: 'TC', name: 'Classic', categories: ['classic', 'nope'], settings: { contrast: 99, dithering: -1, eyeBoost: { contrast: 0 } } },
      'мусор',
      null,
    ],
  });
  assert.deepEqual(presets.map((preset) => preset.id), ['T', 'TC']);
  assert.equal(presets[0].settings.contrast, 1.2);
  assert.equal(presets[0].settings.eyeBoost.contrast, I.settings.eyeBoost.contrast, 'остальное из записи');
  assert.deepEqual(presets[1].categories, ['classic']);
  assert.equal(presets[1].settings.contrast, 2.5, 'контраст ограничен сверху');
  assert.equal(presets[1].settings.dithering, 0, 'дизеринг ограничен снизу');
  assert.equal(presets[1].settings.eyeBoost, null, 'нулевое усиление глаз — null');
  assert.deepEqual(parseTunedVariants(null), []);
  assert.deepEqual(parseTunedVariants({ variants: 'нет' }), []);
});

test('нормализация настроек подставляет базу вместо пропусков', () => {
  const normalized = normalizeVariantSettings({ contrast: 1.3, faceExposure: 'да' }, I.settings);
  assert.equal(normalized.contrast, 1.3);
  assert.equal(normalized.faceExposure, I.settings.faceExposure, 'строка вместо булева — база');
  assert.deepEqual(normalized.eyeBoost, null, 'усиление глаз не задано — нет');
  assert.equal(normalized.sharpen, I.settings.sharpen);
});

test('все варианты = встроенные + автоподобранные, без пересечений id', () => {
  assert.ok(ALL_VARIANT_PRESETS.length >= VARIANT_PRESETS.length);
  assert.equal(new Set(ALL_VARIANT_PRESETS.map((preset) => preset.id)).size, ALL_VARIANT_PRESETS.length);
  for (const preset of VARIANT_PRESETS) assert.ok(ALL_VARIANT_PRESETS.includes(preset));
});

test('порядок по выбору людей: ранжированные вперёд, остальные как были', () => {
  const items = ['A', 'B', 'C', 'D'].map((id) => ({ id }));
  assert.deepEqual(orderByRanking(items, ['C', 'Z', 'A']).map((item) => item.id), ['C', 'A', 'B', 'D']);
  assert.deepEqual(orderByRanking(items, []).map((item) => item.id), ['A', 'B', 'C', 'D']);
  assert.deepEqual(orderByRanking(items, undefined).map((item) => item.id), ['A', 'B', 'C', 'D']);
});

test('variantRanking.json разбирается терпимо', () => {
  const ranking = parseVariantRanking({ updatedAt: '2026-10-01', minSessions: 20, rankings: { 'classic|face': ['I', 'I', 'B', 3], 'color|noface': 'нет' } });
  assert.deepEqual(ranking.rankings, { 'classic|face': ['I', 'B'] });
  assert.equal(ranking.minSessions, 20);
  assert.equal(rankingKey('classic', true), 'classic|face');
  assert.equal(rankingKey(undefined, false), 'any|noface');
  assert.deepEqual(parseVariantRanking(undefined).rankings, {});
});
