/**
 * Тесты вариантов: оценка качества и отбор палитры.
 * Сама генерация варианта требует canvas и проверяется в браузерном тесте.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mapGridToPalette } from '../src/algorithms/color/paletteMapping.ts';
import { applyPieceLimits } from '../src/algorithms/optimization/pieceLimit.ts';
import { REGION_LABELS } from '../src/algorithms/optimization/weightMap.ts';
import { scoreMosaic } from '../src/algorithms/variants/qualityScore.ts';
import { parsePalettes } from '../src/config/palettes.ts';
import { QUALITY_WEIGHTS, VARIANT_PRESETS } from '../src/config/variants.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parsed = parsePalettes(JSON.parse(readFileSync(join(root, 'src/config/palettes.json'), 'utf8')));
const BASIC = parsed.byId.basic;

const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();

function makeGrid(cols, rows, colorAt) {
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const rgb = colorAt(x, y);
      cells.push({ x, y, rgb, hex: hex(rgb) });
    }
  }
  return { cols, rows, cells };
}

/** Карта весов, у которой заданные ячейки помечены как глаза. */
function makeWeightMap(cols, rows, eyeCells) {
  const region = new Uint8Array(cols * rows);
  const weight = new Float32Array(cols * rows).fill(1);
  for (const index of eyeCells) {
    region[index] = REGION_LABELS.indexOf('eyes');
    weight[index] = 2.5;
  }
  return {
    cols,
    rows,
    weight,
    region,
    counts: { base: cols * rows - eyeCells.length, edge: 0, hair: 0, face: 0, contour: 0, mouth: 0, eyes: eyeCells.length },
    faces: 1,
  };
}

/* -------------------------------------------------------- оценка качества */

test('идеальное совпадение даёт максимум по всем составляющим', () => {
  const grid = makeGrid(8, 8, (x, y) => [(x * 30) % 256, (y * 30) % 256, 120]);
  const score = scoreMosaic({ averageGrid: grid, mosaicGrid: grid });

  assert.equal(score.colorSimilarity, 1);
  assert.equal(score.edgePreservation, 1);
  assert.equal(score.quantityCompliance, 1);
  assert.equal(score.total, 1);
  assert.equal(score.averageDelta, 0);
  assert.equal(score.hasFace, false);
});

test('оценка не случайна: два вызова дают один результат', () => {
  const average = makeGrid(10, 10, (x, y) => [x * 20, y * 20, 90]);
  const mosaic = mapGridToPalette(average, BASIC).grid;

  const first = scoreMosaic({ averageGrid: average, mosaicGrid: mosaic });
  const second = scoreMosaic({ averageGrid: average, mosaicGrid: mosaic });
  assert.deepEqual(first, second);
});

test('чем дальше цвета, тем ниже colorSimilarity', () => {
  const average = makeGrid(6, 6, () => [200, 60, 40]);
  const close = makeGrid(6, 6, () => [196, 40, 27]);
  const far = makeGrid(6, 6, () => [30, 40, 200]);

  const good = scoreMosaic({ averageGrid: average, mosaicGrid: close });
  const bad = scoreMosaic({ averageGrid: average, mosaicGrid: far });

  assert.ok(good.colorSimilarity > 0.7, `похожий цвет: ${good.colorSimilarity}`);
  assert.equal(bad.colorSimilarity, 0, 'ΔE больше потолка — ноль');
  assert.ok(good.total > bad.total);
  for (const value of [good.total, bad.total, good.colorSimilarity, bad.edgePreservation]) {
    assert.ok(value >= 0 && value <= 1, `оценка вне 0..1: ${value}`);
  }
});

test('потерянные границы снижают edgePreservation', () => {
  const average = makeGrid(12, 12, (x) => (x < 6 ? [20, 20, 20] : [240, 240, 240]));
  const flat = makeGrid(12, 12, () => [130, 130, 130]);

  const kept = scoreMosaic({ averageGrid: average, mosaicGrid: average });
  const lost = scoreMosaic({ averageGrid: average, mosaicGrid: flat });

  assert.equal(kept.edgePreservation, 1);
  assert.equal(lost.edgePreservation, 0, 'контраст стёрт — границ не осталось');
});

test('facePreservation считается по ячейкам лица', () => {
  const average = makeGrid(6, 6, () => [220, 180, 150]);
  const eyeCells = [7, 10];
  const weightMap = makeWeightMap(6, 6, eyeCells);

  // Вариант 1: лицо испорчено, фон точный.
  const brokenFace = makeGrid(6, 6, () => [220, 180, 150]);
  for (const index of eyeCells) {
    brokenFace.cells[index] = { ...brokenFace.cells[index], rgb: [20, 40, 200], hex: '#1428C8' };
  }

  const broken = scoreMosaic({ averageGrid: average, mosaicGrid: brokenFace, weightMap });
  assert.equal(broken.hasFace, true);
  assert.equal(broken.facePreservation, 0, 'глаза улетели в другой цвет');
  assert.ok(broken.colorSimilarity > broken.facePreservation, 'общая похожесть выше, чем по лицу');

  // Вариант 2: то же количество ошибок, но не на лице.
  const brokenBackground = makeGrid(6, 6, () => [220, 180, 150]);
  for (const index of [0, 35]) {
    brokenBackground.cells[index] = { ...brokenBackground.cells[index], rgb: [20, 40, 200], hex: '#1428C8' };
  }
  const spared = scoreMosaic({ averageGrid: average, mosaicGrid: brokenBackground, weightMap });

  assert.equal(spared.facePreservation, 1, 'лицо не тронуто');
  assert.ok(spared.total > broken.total, 'вариант, сохранивший лицо, оценивается выше');
});

test('без лица facePreservation берётся из общей похожести', () => {
  const average = makeGrid(4, 4, () => [200, 60, 40]);
  const mosaic = makeGrid(4, 4, () => [196, 40, 27]);
  const score = scoreMosaic({ averageGrid: average, mosaicGrid: mosaic });
  assert.equal(score.hasFace, false);
  assert.equal(score.facePreservation, score.colorSimilarity);
});

test('нарушение запаса деталей бьёт по оценке', () => {
  const grid = makeGrid(6, 6, () => [20, 20, 20]);
  const palette = {
    id: 'tiny',
    colors: [
      { id: 'black', name: 'Black', hex: '#141414', rgb: [20, 20, 20], availableQuantity: 10 },
      { id: 'white', name: 'White', hex: '#F0F0F0', rgb: [240, 240, 240], availableQuantity: 10 },
    ],
  };
  const mapping = mapGridToPalette(grid, palette);
  const limit = applyPieceLimits({ averageGrid: grid, mapping, palette });
  assert.equal(limit.feasible, false, '36 ячеек против 20 деталей');

  const withViolation = scoreMosaic({
    averageGrid: grid,
    mosaicGrid: limit.mapping.grid,
    pieceLimit: limit,
  });
  const withoutLimits = scoreMosaic({ averageGrid: grid, mosaicGrid: limit.mapping.grid });

  assert.ok(withViolation.quantityCompliance < 1, 'нарушение видно в оценке');
  assert.ok(withViolation.total < withoutLimits.total, 'несобираемый вариант проигрывает');
});

test('веса оценки лежат в конфиге и учитывают все четыре составляющие', () => {
  assert.ok(QUALITY_WEIGHTS.color > 0);
  assert.ok(QUALITY_WEIGHTS.edge > 0);
  assert.ok(QUALITY_WEIGHTS.face > 0);
  assert.ok(QUALITY_WEIGHTS.quantity > 0);

  const average = makeGrid(6, 6, (x) => (x < 3 ? [30, 30, 30] : [230, 230, 230]));
  const mosaic = mapGridToPalette(average, BASIC).grid;

  const colorHeavy = scoreMosaic({ averageGrid: average, mosaicGrid: mosaic, weights: { color: 10, edge: 0, face: 0, quantity: 0 } });
  const edgeHeavy = scoreMosaic({ averageGrid: average, mosaicGrid: mosaic, weights: { color: 0, edge: 10, face: 0, quantity: 0 } });

  assert.equal(colorHeavy.total, colorHeavy.colorSimilarity);
  assert.equal(edgeHeavy.total, edgeHeavy.edgePreservation);
});

/* ------------------------------------------------------- отбор палитры */

test('двенадцать вариантов и все отличаются обработкой', () => {
  assert.equal(VARIANT_PRESETS.length, 12);
  assert.deepEqual(
    VARIANT_PRESETS.map((preset) => preset.id),
    ['G', 'N', 'A', 'B', 'K', 'C', 'D', 'E', 'F', 'H', 'I', 'J'],
  );

  const signatures = VARIANT_PRESETS.map((preset) => JSON.stringify(preset.settings));
  assert.equal(new Set(signatures).size, 12, 'наборы настроек различны');

  // Почерк готовых наборов: сильная версия только для Classic, мягкая — для всех.
  const kit = VARIANT_PRESETS.find((preset) => preset.id === 'G');
  assert.deepEqual(kit.categories, ['classic'], 'вариант «Как в наборе» не показывается на Color');
  assert.ok(kit.settings.detail > 0 && kit.settings.localContrast > 0, 'штрих и объём по ячейкам заданы');
  const crisp = VARIANT_PRESETS.find((preset) => preset.id === 'N');
  assert.equal(crisp.categories, undefined, 'мягкая версия показывается везде');
  assert.ok(crisp.settings.detail < kit.settings.detail);
  assert.ok(VARIANT_PRESETS.find((preset) => preset.id === 'K').settings.faceVolume > 0, 'объём лица задан');

  // Три последних варианта усиливают глаза, остальные — нет.
  const withEyes = VARIANT_PRESETS.filter((preset) => preset.settings.eyeBoost);
  assert.equal(withEyes.length, 3, 'ровно три варианта с акцентом на глаза');
  for (const preset of withEyes) {
    assert.ok(preset.settings.eyeBoost.contrast > 0, `${preset.id}: усиление контраста задано`);
    assert.ok(preset.settings.eyeBoost.darkBias >= 0 && preset.settings.eyeBoost.darkBias <= 1);
    assert.ok(preset.settings.eyeBoost.radiusScale >= 1, `${preset.id}: область не уже самого глаза`);
  }

  // Каждый рычаг обработки где-то действительно меняется.
  const differs = (key) => new Set(VARIANT_PRESETS.map((preset) => preset.settings[key])).size > 1;
  for (const key of ['faceExposure', 'levels', 'dithering', 'contrast', 'detail']) {
    assert.ok(differs(key), `параметр ${key} должен различаться между вариантами`);
  }

  // Варианты не выбирают палитру: она приходит из набора.
  for (const preset of VARIANT_PRESETS) {
    assert.equal(preset.settings.paletteId, undefined, 'палитру задаёт набор, а не вариант');
    assert.ok(preset.name.length > 0 && preset.description.length > 0);
    assert.ok(preset.settings.dithering >= 0 && preset.settings.dithering <= 1);
  }

  // Первым идёт почерк наборов — без смешивания; есть и вариант без обработки.
  assert.equal(VARIANT_PRESETS[0].settings.dithering, 0, 'первый вариант без смешивания');
  const plain = VARIANT_PRESETS.find((preset) => preset.id === 'A');
  assert.ok(!plain.settings.levels && !plain.settings.faceExposure && !plain.settings.detail, 'A — минимум вмешательства');
  assert.ok(
    VARIANT_PRESETS.some((preset) => preset.settings.faceExposure && preset.settings.dithering > 0),
    'есть вариант, сочетающий экспозицию и смешивание',
  );
});
