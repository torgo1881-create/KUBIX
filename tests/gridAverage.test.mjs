/**
 * Тесты ядра усреднения. Запуск:
 *   npm test
 *   (node --experimental-strip-types tests/gridAverage.test.mjs)
 *
 * DOM не нужен: computeAverageGrid работает с любым объектом
 * { width, height, data } — в том числе с настоящим ImageData.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cellBounds,
  computeAverageGrid,
  extractPalette,
  getCell,
  hexToRgb,
  rgbToHex,
} from '../src/algorithms/gridAverage.ts';

/** Утилита: собрать ImageData-подобный объект из функции цвета. */
function makeImage(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = colorAt(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

test('rgbToHex / hexToRgb — формат из ТЗ', () => {
  assert.equal(rgbToHex([120, 80, 60]), '#78503C');
  assert.equal(rgbToHex([0, 0, 0]), '#000000');
  assert.equal(rgbToHex([255, 255, 255]), '#FFFFFF');
  assert.deepEqual(hexToRgb('#78503C'), [120, 80, 60]);
});

test('одна ячейка = среднее по всему изображению', () => {
  // 2×2: 0, 10, 20, 30 -> среднее 15
  const image = makeImage(2, 2, (x, y) => {
    const v = (y * 2 + x) * 10;
    return [v, v, v];
  });
  const grid = computeAverageGrid(image, { cols: 1, rows: 1 });
  assert.equal(grid.cells.length, 1);
  assert.deepEqual(grid.cells[0], { x: 0, y: 0, rgb: [15, 15, 15], hex: '#0F0F0F' });
});

test('квадранты попадают в свои ячейки, порядок row-major', () => {
  const quad = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  const image = makeImage(8, 8, (x, y) => quad[(y < 4 ? 0 : 2) + (x < 4 ? 0 : 1)]);
  const grid = computeAverageGrid(image, { cols: 2, rows: 2 });

  assert.equal(grid.cells.length, 4);
  assert.deepEqual(getCell(grid, 0, 0).rgb, [255, 0, 0]);
  assert.deepEqual(getCell(grid, 1, 0).rgb, [0, 255, 0]);
  assert.deepEqual(getCell(grid, 0, 1).rgb, [0, 0, 255]);
  assert.deepEqual(getCell(grid, 1, 1).rgb, [255, 255, 0]);
  // row-major: cells[1] это (x=1, y=0)
  assert.deepEqual({ x: grid.cells[1].x, y: grid.cells[1].y }, { x: 1, y: 0 });
});

test('это среднее, а не центральный пиксель', () => {
  // Одна ячейка 3×3: центр чёрный, остальные белые.
  // Центральный пиксель дал бы #000000, среднее даёт 8/9 * 255 = 227.
  const image = makeImage(3, 3, (x, y) => (x === 1 && y === 1 ? [0, 0, 0] : [255, 255, 255]));
  const grid = computeAverageGrid(image, { cols: 1, rows: 1 });
  assert.deepEqual(grid.cells[0].rgb, [227, 227, 227]);
  assert.notEqual(grid.cells[0].hex, '#000000');
});

test('градиент: ячейка получает среднее своей области', () => {
  // 100×1, значение = x*2 (0..198). Сетка 2×1.
  // Левая ячейка: среднее x=0..49 -> (0+98)/2 = 49
  // Правая ячейка: среднее x=50..99 -> (100+198)/2 = 149
  const image = makeImage(100, 1, (x) => [x * 2, x * 2, x * 2]);
  const grid = computeAverageGrid(image, { cols: 2, rows: 1 });
  assert.deepEqual(grid.cells[0].rgb, [49, 49, 49]);
  assert.deepEqual(grid.cells[1].rgb, [149, 149, 149]);
});

test('границы ячеек покрывают изображение без дыр и пересечений', () => {
  for (const [size, count] of [
    [100, 7],
    [37, 5],
    [64, 64],
    [3, 4], // ячеек больше, чем пикселей
  ]) {
    const covered = new Map();
    for (let i = 0; i < count; i++) {
      const [start, end] = cellBounds(i, count, size);
      assert.ok(start < end, 'ячейка не должна быть пустой');
      for (let p = start; p < end; p++) covered.set(p, (covered.get(p) ?? 0) + 1);
    }
    if (count <= size) {
      assert.equal(covered.size, size, `покрыты все ${size} пикселей`);
      for (const times of covered.values()) assert.equal(times, 1, 'без пересечений');
    }
  }
});

test('размер сетки, не кратный размеру изображения, не ломает алгоритм', () => {
  const image = makeImage(37, 11, (x, y) => [(x * 7) % 256, (y * 13) % 256, 128]);
  const grid = computeAverageGrid(image, { cols: 5, rows: 3 });
  assert.equal(grid.cells.length, 15);
  for (const cell of grid.cells) {
    for (const channel of cell.rgb) {
      assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255);
    }
    assert.match(cell.hex, /^#[0-9A-F]{6}$/);
  }
});

test('полупрозрачность композитится на подложку', () => {
  const image = makeImage(4, 4, () => [0, 0, 0, 128]);
  // alpha = 128/255 ≈ 0.502 -> 255 * (1 - 0.502) ≈ 127
  const onWhite = computeAverageGrid(image, { cols: 1, rows: 1 });
  assert.deepEqual(onWhite.cells[0].rgb, [127, 127, 127]);

  const onBlack = computeAverageGrid(image, { cols: 1, rows: 1, background: [0, 0, 0] });
  assert.deepEqual(onBlack.cells[0].rgb, [0, 0, 0]);
});

test('linear colorSpace даёт другой (более светлый) результат на контрасте', () => {
  const image = makeImage(2, 1, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
  const srgb = computeAverageGrid(image, { cols: 1, rows: 1, colorSpace: 'srgb' });
  const linear = computeAverageGrid(image, { cols: 1, rows: 1, colorSpace: 'linear' });
  assert.deepEqual(srgb.cells[0].rgb, [128, 128, 128]);
  assert.ok(linear.cells[0].rgb[0] > 180, `ожидали ~188, получили ${linear.cells[0].rgb[0]}`);
});

test('onProgress доходит до 1', () => {
  const image = makeImage(16, 16, () => [10, 20, 30]);
  const values = [];
  computeAverageGrid(image, { cols: 4, rows: 4, onProgress: (v) => values.push(v) });
  assert.equal(values.length, 4);
  assert.equal(values.at(-1), 1);
});

test('некорректный ввод отклоняется', () => {
  const image = makeImage(4, 4, () => [0, 0, 0]);
  assert.throws(() => computeAverageGrid(image, { cols: 0, rows: 4 }), /размер сетки/);
  assert.throws(() => computeAverageGrid({ width: 4, height: 4, data: new Uint8ClampedArray(8) }, { cols: 2, rows: 2 }), /data/);
});

test('extractPalette возвращает доминирующие цвета', () => {
  const image = makeImage(8, 8, (x) => (x < 6 ? [200, 30, 30] : [30, 30, 200]));
  const grid = computeAverageGrid(image, { cols: 8, rows: 8 });
  const palette = extractPalette(grid, 2);
  assert.equal(palette.length, 2);
  assert.deepEqual(palette[0].rgb, [200, 30, 30]);
});

test('64×64 из фото 1600×1600 считается быстро', () => {
  const image = makeImage(1600, 1600, (x, y) => [x % 256, y % 256, (x + y) % 256]);
  const t0 = performance.now();
  const grid = computeAverageGrid(image, { cols: 64, rows: 64 });
  const ms = performance.now() - t0;
  assert.equal(grid.cells.length, 4096);
  assert.ok(ms < 2000, `усреднение заняло ${ms.toFixed(0)} мс`);
  console.log(`    ↳ 1600×1600 → 64×64 за ${ms.toFixed(0)} мс`);
});
