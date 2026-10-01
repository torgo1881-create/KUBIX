/**
 * Тесты ограничения по количеству деталей: поиск границ, функция стоимости,
 * сам оптимизатор. Запуск: npm run test:limits (или npm test).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mapGridToPalette } from '../src/algorithms/color/paletteMapping.ts';
import {
  blur3x3,
  computeCellMaps,
  computeGridCellMaps,
  luminance,
  normalizeInPlace,
  sobel,
  toLumaPlane,
} from '../src/algorithms/image/edges.ts';
import {
  DEFAULT_COST_WEIGHTS,
  calculateReplacementCost,
  resolveWeights,
} from '../src/algorithms/optimization/costFunction.ts';
import { applyPieceLimits } from '../src/algorithms/optimization/pieceLimit.ts';
import { parsePalettes } from '../src/config/palettes.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASIC = parsePalettes(JSON.parse(readFileSync(join(root, 'src/config/palettes.json'), 'utf8'))).byId.basic;

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

function makeImage(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Палитра с произвольными лимитами — ничего не зашито. */
function paletteWithLimits(entries) {
  return {
    id: 'test',
    colors: entries.map(([id, name, rgb, availableQuantity]) => ({
      id,
      name,
      hex: hex(rgb),
      rgb,
      availableQuantity,
    })),
  };
}

/* ------------------------------------------------------------------ границы */

test('Sobel находит вертикальную границу и молчит на заливке', () => {
  const width = 9;
  const height = 9;
  const flat = new Float32Array(width * height).fill(120);
  const flatEdges = sobel(flat, width, height).magnitude;
  assert.ok(Math.max(...flatEdges) < 1e-6, 'на ровной заливке границ нет');

  const split = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) split[y * width + x] = x < 4 ? 0 : 255;
  }
  const { magnitude } = sobel(split, width, height);
  const onEdge = magnitude[4 * width + 4];
  const inside = magnitude[4 * width + 1];
  assert.ok(onEdge > 500, `на границе градиент большой, получили ${onEdge}`);
  assert.ok(inside < 1e-6, 'вдали от границы пусто');
});

test('яркость и размытие работают ожидаемо', () => {
  assert.equal(Math.round(luminance(255, 255, 255)), 255);
  assert.ok(luminance(0, 255, 0) > luminance(255, 0, 0), 'зелёный светлее красного');

  const image = makeImage(3, 3, (x, y) => (x === 1 && y === 1 ? [255, 255, 255] : [0, 0, 0]));
  const luma = toLumaPlane(image);
  assert.equal(Math.round(luma[4]), 255);
  const blurred = blur3x3(luma, 3, 3);
  assert.ok(blurred[4] < 255 && blurred[4] > 0, 'центр размылся');
  assert.ok(blurred[0] > 0, 'соседи получили часть яркости');
});

test('normalizeInPlace приводит значения к 0..1', () => {
  const values = Float32Array.from([0, 1, 2, 5, 100]);
  normalizeInPlace(values, 0.75);
  for (const value of values) assert.ok(value >= 0 && value <= 1);
  assert.equal(values[values.length - 1], 1, 'выброс обрезан до 1');
});

test('карты по ячейкам: контур квадрата ярче, чем его заливка', () => {
  // Чёрный квадрат на белом фоне, 64×64 пикселя, сетка 8×8.
  // Границы квадрата намеренно не совпадают с границами ячеек.
  const image = makeImage(64, 64, (x, y) =>
    x >= 18 && x < 46 && y >= 18 && y < 46 ? [10, 10, 10] : [245, 245, 245],
  );
  const maps = computeCellMaps(image, 8, 8);

  assert.equal(maps.edge.length, 64);
  for (const value of maps.edge) assert.ok(value >= 0 && value <= 1);

  const at = (x, y) => maps.edge[y * 8 + x];
  assert.ok(at(2, 2) > 0.5, `угол квадрата — сильная граница, получили ${at(2, 2)}`);
  assert.ok(at(3, 3) < 0.05, `внутри квадрата ровно, получили ${at(3, 3)}`);
  assert.ok(at(0, 0) < 0.05, 'фон ровный');
  assert.ok(maps.structure[2 * 8 + 2] > maps.structure[3 * 8 + 3], 'на границе детальность выше');
});

test('карты можно посчитать и по самой сетке', () => {
  const grid = makeGrid(8, 8, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
  const maps = computeGridCellMaps(grid);
  assert.equal(maps.edge.length, 64);
  assert.ok(maps.edge[3] > 0.5, 'ячейка у перехода — граница');
  assert.ok(maps.edge[0] < 0.05, 'слева от перехода ровно');
});

/* ------------------------------------------------------- функция стоимости */

test('cost = colorDistance + structuralPenalty + edgePenalty', () => {
  const cost = calculateReplacementCost({
    colorDistance: 10,
    currentDistance: 4,
    neighborDistance: 8,
    edge: 0.5,
    structure: 0.5,
    weights: { structure: 0.6, edge: 1.5, cohesion: 0.25 },
  });

  const structural = 0.6 * 0.5 * 10 + 0.25 * (1 - 0.5) * 8;
  const edge = 1.5 * 0.5 * 4;
  assert.equal(cost.structuralPenalty, structural);
  assert.equal(cost.edgePenalty, edge);
  assert.equal(cost.total, 10 + structural + edge);
});

test('на границе замена дороже, чем в ровной заливке', () => {
  const base = { colorDistance: 12, currentDistance: 12, neighborDistance: 0, structure: 0 };
  const flat = calculateReplacementCost({ ...base, edge: 0 });
  const contour = calculateReplacementCost({ ...base, edge: 1 });
  assert.ok(contour.total > flat.total * 2, `${contour.total} должно быть заметно больше ${flat.total}`);
  assert.equal(flat.edgePenalty, 0);
});

test('детальный участок дороже ровного, а веса можно переопределить', () => {
  const base = { colorDistance: 10, currentDistance: 0, edge: 0, neighborDistance: 0 };
  assert.ok(
    calculateReplacementCost({ ...base, structure: 1 }).total >
      calculateReplacementCost({ ...base, structure: 0 }).total,
  );

  const ignored = calculateReplacementCost({ ...base, structure: 1, weights: { structure: 0 } });
  assert.equal(ignored.total, 10);
  assert.deepEqual(resolveWeights({ edge: 9 }), { ...DEFAULT_COST_WEIGHTS, edge: 9 });
});

test('стоимость растёт вместе с цветовой ошибкой', () => {
  let previous = -1;
  for (const colorDistance of [0, 5, 10, 40]) {
    const { total } = calculateReplacementCost({ colorDistance, currentDistance: 3, edge: 0.2, structure: 0.2 });
    assert.ok(total > previous, 'монотонность по colorDistance');
    previous = total;
  }
});

/* ------------------------------------------------ оптимизатор: базовый случай */

test('палитра из 3 цветов и искусственный лимит: итог не превышает запас', () => {
  // 8×8 = 64 ячейки. Почти всё изображение просится в красный.
  const grid = makeGrid(8, 8, (x, y) => (y < 6 ? [230, 30, 25] : [20, 20, 20]));
  const palette = paletteWithLimits([
    ['red', 'Red', [220, 40, 40], 20],
    ['black', 'Black', [20, 20, 20], 30],
    ['grey', 'Grey', [150, 150, 150], 40],
  ]);

  const mapping = mapGridToPalette(grid, palette);
  const before = mapping.usage.find((item) => item.color.id === 'red');
  assert.ok(before.count > 20, `до оптимизации красного нужно ${before.count} при запасе 20`);

  const result = applyPieceLimits({
    averageGrid: grid,
    mapping,
    palette,
    options: { maps: computeGridCellMaps(grid) },
  });

  assert.equal(result.feasible, true);
  assert.equal(result.satisfied, true);

  // Главное условие задачи.
  for (const requirement of result.requirements) {
    assert.ok(
      requirement.required <= requirement.available,
      `${requirement.color.name}: нужно ${requirement.required}, есть ${requirement.available}`,
    );
  }

  // Ни одна ячейка не потерялась и все цвета — из палитры.
  const total = result.mapping.usage.reduce((sum, item) => sum + item.count, 0);
  assert.equal(total, 64);
  assert.equal(result.mapping.assignments.length, 64);
  const allowed = new Set(palette.colors.map((color) => hex(color.rgb)));
  for (const cell of result.mapping.grid.cells) assert.ok(allowed.has(cell.hex));

  // Статусы: красный исправлен, серый просто принял на себя лишнее.
  const red = result.requirements.find((item) => item.color.id === 'red');
  assert.equal(red.status, 'corrected');
  assert.ok(red.initialRequired > red.required);
  assert.ok(result.moved > 0);
});

test('если лимиты уже соблюдены, ничего не двигается', () => {
  const grid = makeGrid(6, 6, (x) => (x < 3 ? [20, 20, 20] : [244, 244, 244]));
  const palette = paletteWithLimits([
    ['black', 'Black', [27, 27, 27], 100],
    ['white', 'White', [244, 244, 244], 100],
  ]);
  const mapping = mapGridToPalette(grid, palette);
  const result = applyPieceLimits({ averageGrid: grid, mapping, palette });

  assert.equal(result.moved, 0);
  assert.equal(result.iterations, 0);
  assert.equal(result.satisfied, true);
  assert.equal(result.addedError, 0);
  assert.deepEqual([...result.mapping.assignments], [...mapping.assignments]);
  for (const requirement of result.requirements) assert.equal(requirement.status, 'ok');
});

test('деталей физически не хватает — честно сообщаем', () => {
  const grid = makeGrid(4, 4, () => [10, 10, 10]);
  const palette = paletteWithLimits([
    ['black', 'Black', [20, 20, 20], 5],
    ['white', 'White', [240, 240, 240], 5],
  ]);
  const mapping = mapGridToPalette(grid, palette);
  const result = applyPieceLimits({ averageGrid: grid, mapping, palette });

  assert.equal(result.feasible, false, '16 ячеек против 10 деталей');
  assert.equal(result.satisfied, false);
  assert.equal(result.moved, 0, 'бессмысленную перекраску не делаем');
  assert.equal(result.requirements.find((item) => item.color.id === 'black').status, 'over');
});

/* --------------------------------------- оптимизатор: выбор, а не случайность */

test('переносятся ячейки с наименьшей ценой, а не первые попавшиеся', () => {
  // Все четыре ячейки уходят в красный, но две из них заметно теплее.
  const grid = makeGrid(4, 1, (x) => (x < 2 ? [220, 40, 40] : [230, 80, 44]));
  const palette = paletteWithLimits([
    ['red', 'Red', [220, 40, 40], 2],
    ['orange', 'Orange', [240, 120, 40], 4],
  ]);

  const mapping = mapGridToPalette(grid, palette);
  assert.equal([...mapping.assignments].filter((index) => index === 0).length, 4, 'сначала все красные');

  const result = applyPieceLimits({ averageGrid: grid, mapping, palette });
  assert.deepEqual([...result.mapping.assignments], [0, 0, 1, 1], 'уехали именно оранжевые по духу ячейки');
  assert.ok(result.addedError > 0);
});

test('контур защищён: при равной цене цвета уступают ровные участки', () => {
  const grid = makeGrid(2, 2, () => [220, 40, 40]);
  const palette = paletteWithLimits([
    ['red', 'Red', [220, 40, 40], 2],
    ['orange', 'Orange', [240, 120, 40], 4],
  ]);
  const mapping = mapGridToPalette(grid, palette);

  // Верхние две ячейки объявляем контуром, нижние — ровной заливкой.
  const maps = {
    cols: 2,
    rows: 2,
    edge: Float32Array.from([1, 1, 0, 0]),
    structure: Float32Array.from([1, 1, 0, 0]),
  };

  const result = applyPieceLimits({ averageGrid: grid, mapping, palette, options: { maps } });
  assert.deepEqual([...result.mapping.assignments], [0, 0, 1, 1], 'контур остался красным');

  // Без карт выбор произвольный, но лимит всё равно соблюдён.
  const blind = applyPieceLimits({ averageGrid: grid, mapping, palette });
  assert.equal([...blind.mapping.assignments].filter((index) => index === 0).length, 2);
});

test('веса влияют на выбор: с нулевым edge-весом контур больше не защищён', () => {
  const grid = makeGrid(2, 2, () => [220, 40, 40]);
  const palette = paletteWithLimits([
    ['red', 'Red', [220, 40, 40], 2],
    ['orange', 'Orange', [240, 120, 40], 4],
  ]);
  const mapping = mapGridToPalette(grid, palette);
  const maps = {
    cols: 2,
    rows: 2,
    edge: Float32Array.from([1, 1, 0, 0]),
    structure: Float32Array.from([0, 0, 0, 0]),
  };

  const protectedRun = applyPieceLimits({ averageGrid: grid, mapping, palette, options: { maps } });
  const ignoredRun = applyPieceLimits({
    averageGrid: grid,
    mapping,
    palette,
    options: { maps, weights: { edge: 0, structure: 0, cohesion: 0 } },
  });

  assert.deepEqual([...protectedRun.mapping.assignments], [0, 0, 1, 1]);
  assert.notDeepEqual([...ignoredRun.mapping.assignments], [...protectedRun.mapping.assignments]);
});

test('результат воспроизводим', () => {
  const grid = makeGrid(16, 16, (x, y) => [(x * 15) % 256, (y * 11) % 256, 128]);
  const palette = { id: 'basic', colors: BASIC.colors.map((color) => ({ ...color, availableQuantity: 30 })) };
  const mapping = mapGridToPalette(grid, palette);
  const maps = computeGridCellMaps(grid);

  const first = applyPieceLimits({ averageGrid: grid, mapping, palette, options: { maps } });
  const second = applyPieceLimits({ averageGrid: grid, mapping, palette, options: { maps } });
  assert.deepEqual([...first.mapping.assignments], [...second.mapping.assignments]);
  assert.equal(first.moved, second.moved);
});

test('исходное сопоставление не портится', () => {
  const grid = makeGrid(8, 8, (x) => (x < 6 ? [230, 30, 25] : [20, 20, 20]));
  const palette = paletteWithLimits([
    ['red', 'Red', [220, 40, 40], 10],
    ['black', 'Black', [20, 20, 20], 30],
    ['grey', 'Grey', [150, 150, 150], 40],
  ]);
  const mapping = mapGridToPalette(grid, palette);
  const before = [...mapping.assignments];
  const beforeHex = mapping.grid.cells.map((cell) => cell.hex);

  const result = applyPieceLimits({ averageGrid: grid, mapping, palette });

  assert.deepEqual([...mapping.assignments], before, 'assignments исходника не тронуты');
  assert.deepEqual(mapping.grid.cells.map((cell) => cell.hex), beforeHex, 'сетка исходника не тронута');
  assert.notDeepEqual([...result.mapping.assignments], before, 'а результат — новый');
  assert.equal(result.mapping.grid.cells[0].x, 0, 'координаты на месте');
});

test('статистика после оптимизации сходится с назначениями', () => {
  const grid = makeGrid(10, 10, (x, y) => [(x * 25) % 256, (y * 25) % 256, 90]);
  const palette = { id: 'basic', colors: BASIC.colors.map((color) => ({ ...color, availableQuantity: 12 })) };
  const mapping = mapGridToPalette(grid, palette);
  const result = applyPieceLimits({
    averageGrid: grid,
    mapping,
    palette,
    options: { maps: computeGridCellMaps(grid) },
  });

  const fromAssignments = new Map();
  for (const index of result.mapping.assignments) {
    fromAssignments.set(index, (fromAssignments.get(index) ?? 0) + 1);
  }

  for (const item of result.mapping.usage) {
    const index = palette.colors.findIndex((color) => color.id === item.color.id);
    assert.equal(item.count, fromAssignments.get(index), `${item.color.name}: usage совпадает с assignments`);
  }
  for (const requirement of result.requirements) {
    assert.ok(requirement.required <= requirement.available);
  }
  assert.equal(
    result.requirements.reduce((sum, item) => sum + item.required, 0),
    100,
  );
});

/* ---------------------------------------------------------------- скорость */

test('64×64, 96×96 и 128×128 укладываются в бюджет времени', () => {
  for (const size of [64, 96, 128]) {
    const grid = makeGrid(size, size, (x, y) => [
      Math.round((x / size) * 255),
      Math.round((y / size) * 255),
      (x * y) % 256,
    ]);
    const perColor = Math.ceil((grid.cells.length / BASIC.colors.length) * 1.05);
    const palette = { id: 'bench', colors: BASIC.colors.map((color) => ({ ...color, availableQuantity: perColor })) };

    const started = performance.now();
    const mapping = mapGridToPalette(grid, palette);
    const maps = computeGridCellMaps(grid);
    const result = applyPieceLimits({ averageGrid: grid, mapping, palette, options: { maps } });
    const ms = performance.now() - started;

    assert.equal(result.satisfied, true, `${size}×${size}: лимиты соблюдены`);
    assert.ok(ms < 3000, `${size}×${size} заняло ${ms.toFixed(0)} мс`);
    console.log(
      `    ↳ ${size}×${size}: ${ms.toFixed(0)} мс, перенесено ${result.moved} из ${grid.cells.length}, +ΔE ${result.addedError.toFixed(2)}`,
    );
  }
});
