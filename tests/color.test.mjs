/**
 * Тесты цветовой системы: RGB → LAB, перцептивное расстояние, поиск ближайшего
 * цвета палитры. Запуск: npm run test:color (или npm test — там всё сразу).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  D65,
  labToRgb,
  linearToSrgbChannel,
  rgbToLab,
  rgbToXyz,
  srgbChannelToLinear,
} from '../src/algorithms/color/lab.ts';
import {
  deltaE76,
  deltaE76Squared,
  deltaE94,
  deltaE2000,
  getDistanceFn,
} from '../src/algorithms/color/distance.ts';
import {
  buildUsage,
  countUsage,
  ensurePrepared,
  findNearestPaletteColor,
  mapGridToPalette,
  preparePalette,
} from '../src/algorithms/color/paletteMapping.ts';
import { parsePalettes } from '../src/config/palettes.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parsed = parsePalettes(JSON.parse(readFileSync(join(root, 'src/config/palettes.json'), 'utf8')));
const BASIC = parsed.byId.basic;
const lab = (L, a, b) => ({ L, a, b });
const close = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ожидали ${expected} ± ${tolerance}, получили ${actual}`,
  );

/* ------------------------------------------------------------------ RGB → LAB */

test('палитра из JSON проходит валидацию', () => {
  assert.deepEqual(parsed.warnings, [], 'hex и rgb должны совпадать во всех записях');
  assert.ok(parsed.palettes.length >= 1);
  assert.equal(BASIC.colors.length, 12, 'демонстрационная палитра — 12 цветов');
  for (const color of BASIC.colors) {
    assert.match(color.hex, /^#[0-9A-F]{6}$/);
    assert.equal(color.rgb.length, 3);
    assert.ok(color.availableQuantity >= 0);
  }
});

test('гамма-кривая sRGB обратима', () => {
  for (const byte of [0, 1, 17, 64, 128, 200, 254, 255]) {
    assert.equal(linearToSrgbChannel(srgbChannelToLinear(byte)), byte);
  }
});

test('белый переводится в точку белого D65', () => {
  const xyz = rgbToXyz([255, 255, 255]);
  close(xyz.X, D65.X, 0.01, 'X');
  close(xyz.Y, D65.Y, 0.01, 'Y');
  close(xyz.Z, D65.Z, 0.01, 'Z');
});

test('RGB → LAB даёт справочные значения', () => {
  const cases = [
    { rgb: [255, 255, 255], lab: [100, 0, 0], name: 'белый' },
    { rgb: [0, 0, 0], lab: [0, 0, 0], name: 'чёрный' },
    { rgb: [128, 128, 128], lab: [53.585, 0, 0], name: 'средний серый' },
    { rgb: [255, 0, 0], lab: [53.2408, 80.0925, 67.2032], name: 'красный' },
    { rgb: [0, 255, 0], lab: [87.7347, -86.1827, 83.1793], name: 'зелёный' },
    { rgb: [0, 0, 255], lab: [32.297, 79.1875, -107.8602], name: 'синий' },
    { rgb: [255, 255, 0], lab: [97.1393, -21.5537, 94.478], name: 'жёлтый' },
    { rgb: [0, 255, 255], lab: [91.1132, -48.0875, -14.1312], name: 'голубой' },
    { rgb: [255, 0, 255], lab: [60.3242, 98.2343, -60.8249], name: 'пурпурный' },
  ];

  for (const { rgb, lab: expected, name } of cases) {
    const got = rgbToLab(rgb);
    close(got.L, expected[0], 0.001, `${name}: L`);
    close(got.a, expected[1], 0.001, `${name}: a`);
    close(got.b, expected[2], 0.001, `${name}: b`);
  }
});

test('LAB → RGB возвращает исходный цвет (20+ проверок)', () => {
  const colors = [];
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % 256;
  };
  for (let i = 0; i < 30; i++) colors.push([random(), random(), random()]);
  colors.push([0, 0, 0], [255, 255, 255], [17, 17, 17], [124, 80, 58]);

  for (const rgb of colors) {
    assert.deepEqual(labToRgb(rgbToLab(rgb)), rgb, `круговой перевод для ${rgb}`);
  }
});

test('LAB реагирует на яркость, а не только на числа RGB', () => {
  // Одинаковый шаг в RGB даёт разный шаг в L: тёмные оттенки различимее.
  const darkStep = rgbToLab([40, 40, 40]).L - rgbToLab([20, 20, 20]).L;
  const lightStep = rgbToLab([235, 235, 235]).L - rgbToLab([215, 215, 215]).L;
  assert.ok(darkStep > lightStep, `${darkStep} должен быть больше ${lightStep}`);
});

/* --------------------------------------------------------------- расстояния */

test('ΔE76 — евклидово расстояние в LAB', () => {
  assert.equal(deltaE76(lab(50, 10, -20), lab(50, 10, -20)), 0);
  close(deltaE76(lab(100, 0, 0), lab(0, 0, 0)), 100, 1e-9, 'белый ↔ чёрный');
  close(deltaE76(lab(50, 0, 0), lab(50, 3, 4)), 5, 1e-9, 'катеты 3-4-5');
  assert.equal(deltaE76Squared(lab(50, 0, 0), lab(50, 3, 4)), 25);
});

test('ΔE94 мягче к разнице насыщенных цветов', () => {
  const neutral = deltaE94(lab(50, 0, 0), lab(50, 5, 0));
  const saturated = deltaE94(lab(50, 60, 0), lab(50, 65, 0));
  assert.ok(saturated < neutral, `${saturated} должно быть меньше ${neutral}`);
  assert.equal(deltaE94(lab(50, 2, 3), lab(50, 2, 3)), 0);
});

test('ΔE00 совпадает со справочными данными Sharma et al.', () => {
  // Контрольный набор из статьи «The CIEDE2000 Color-Difference Formula» (2005).
  const cases = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];

  for (const [a, b, expected] of cases) {
    const got = deltaE2000(lab(a[0], a[1], a[2]), lab(b[0], b[1], b[2]));
    close(got, expected, 0.0001, `ΔE00 ${a} ↔ ${b}`);
  }
});

test('ΔE00 симметрична и равна нулю для одинаковых цветов', () => {
  const pairs = [
    [lab(50, 2.5, 0), lab(73, 25, -18)],
    [lab(22, 20, -46), lab(23, 15, -42)],
    [lab(90, -0.5, -0.9), lab(88, -0.9, -0.7)],
  ];
  for (const [a, b] of pairs) {
    close(deltaE2000(a, b), deltaE2000(b, a), 1e-9, 'симметрия');
  }
  assert.equal(deltaE2000(lab(37, 12, -8), lab(37, 12, -8)), 0);
});

test('getDistanceFn отдаёт нужную метрику и ругается на неизвестную', () => {
  assert.equal(getDistanceFn('cie76'), deltaE76);
  assert.equal(getDistanceFn('cie94'), deltaE94);
  assert.equal(getDistanceFn(), deltaE2000, 'по умолчанию CIEDE2000');
  assert.throws(() => getDistanceFn('rgb'), /Неизвестная метрика/);
});

/* ------------------------------------------------------- ближайший цвет */

test('пример из задачи: RGB(127, 84, 71) → Brown', () => {
  const match = findNearestPaletteColor([127, 84, 71], BASIC);
  assert.equal(match.color.name, 'Brown');
  assert.equal(match.color.hex, '#7C503A');
  assert.ok(match.distance < 6, `ΔE ${match.distance} должен быть небольшим`);
});

test('цвет из палитры находит сам себя с нулевым расстоянием', () => {
  for (const color of BASIC.colors) {
    const match = findNearestPaletteColor(color.rgb, BASIC);
    assert.equal(match.color.id, color.id, `${color.name} должен найти себя`);
    assert.equal(match.distance, 0);
  }
});

test('20+ разных цветов сопоставляются с ожидаемыми деталями', () => {
  const expectations = [
    { rgb: [0, 0, 0], name: 'Black' },
    { rgb: [20, 20, 20], name: 'Black' },
    { rgb: [60, 60, 60], name: 'Black' },
    { rgb: [255, 255, 255], name: 'White' },
    { rgb: [240, 238, 235], name: 'White' },
    { rgb: [200, 200, 200], name: 'White' },
    { rgb: [163, 162, 164], name: 'Light Grey' },
    { rgb: [128, 128, 128], name: 'Dark Grey' },
    { rgb: [112, 128, 144], name: 'Dark Grey' },
    { rgb: [255, 0, 0], name: 'Red' },
    { rgb: [178, 34, 34], name: 'Red' },
    { rgb: [120, 20, 20], name: 'Dark Red' },
    { rgb: [90, 10, 12], name: 'Dark Red' },
    { rgb: [255, 128, 0], name: 'Orange' },
    { rgb: [230, 120, 40], name: 'Orange' },
    { rgb: [255, 255, 0], name: 'Yellow' },
    { rgb: [240, 230, 140], name: 'Yellow' },
    { rgb: [0, 255, 0], name: 'Green' },
    { rgb: [88, 171, 65], name: 'Green' },
    { rgb: [0, 100, 0], name: 'Dark Green' },
    { rgb: [46, 139, 87], name: 'Dark Green' },
    { rgb: [0, 0, 255], name: 'Blue' },
    { rgb: [25, 25, 112], name: 'Blue' },
    { rgb: [128, 0, 128], name: 'Blue' },
    { rgb: [127, 84, 71], name: 'Brown' },
    { rgb: [139, 69, 19], name: 'Brown' },
  ];

  assert.ok(expectations.length >= 20);
  for (const { rgb, name } of expectations) {
    const match = findNearestPaletteColor(rgb, BASIC);
    assert.equal(match.color.name, name, `rgb(${rgb}) → ожидали ${name}, получили ${match.color.name}`);
  }
});

test('поиск действительно возвращает минимум по метрике', () => {
  const prepared = ensurePrepared(BASIC);
  let seed = 987654321;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % 256;
  };

  for (const metric of ['cie76', 'cie94', 'ciede2000']) {
    const distanceFn = getDistanceFn(metric);
    for (let i = 0; i < 150; i++) {
      const rgb = [random(), random(), random()];
      const source = rgbToLab(rgb);
      const match = findNearestPaletteColor(rgb, prepared, metric);
      const bruteForce = Math.min(...prepared.colors.map((color) => distanceFn(source, color.lab)));
      close(match.distance, bruteForce, 1e-12, `${metric}: перебор для rgb(${rgb})`);
    }
  }
});

test('метрика влияет на выбор', () => {
  // Пурпурный не представлен в палитре: метрики расходятся, и это нормально.
  const magenta = [255, 0, 255];
  const byRgbDistance = findNearestPaletteColor(magenta, BASIC, 'cie76').color.name;
  const byPerceptual = findNearestPaletteColor(magenta, BASIC, 'ciede2000').color.name;
  assert.notEqual(byRgbDistance, byPerceptual);
});

test('серая палитра не подмешивает цвет', () => {
  const grayscale = parsed.byId.grayscale;
  for (const rgb of [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [200, 150, 50],
  ]) {
    const match = findNearestPaletteColor(rgb, grayscale);
    const [r, g, b] = match.color.rgb;
    assert.ok(r === g && g === b, `${match.color.hex} должен быть нейтральным`);
  }
});

test('пустая палитра отклоняется', () => {
  assert.throws(() => preparePalette([]), /пустая/);
});

/* ----------------------------------------------------- сопоставление сетки */

function makeGrid(cols, rows, colorAt) {
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const rgb = colorAt(x, y);
      cells.push({
        x,
        y,
        rgb,
        hex:
          '#' +
          rgb
            .map((c) => c.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase(),
      });
    }
  }
  return { cols, rows, cells };
}

test('каждая ячейка сетки получает цвет палитры', () => {
  const grid = makeGrid(4, 3, (x, y) => (x < 2 ? [250, 10, 10] : y === 0 ? [10, 10, 250] : [130, 90, 70]));
  const mapping = mapGridToPalette(grid, BASIC);

  assert.equal(mapping.grid.cells.length, 12);
  assert.equal(mapping.assignments.length, 12);
  assert.equal(mapping.paletteId, 'basic');
  assert.equal(mapping.metric, 'ciede2000');

  const allowed = new Set(BASIC.colors.map((color) => color.hex));
  for (const cell of mapping.grid.cells) {
    assert.ok(allowed.has(cell.hex), `${cell.hex} должен быть цветом палитры`);
    assert.deepEqual(Object.keys(cell).sort(), ['hex', 'rgb', 'x', 'y']);
  }

  // координаты сохраняются
  assert.deepEqual(
    mapping.grid.cells.map((cell) => [cell.x, cell.y]),
    grid.cells.map((cell) => [cell.x, cell.y]),
  );

  // исходная сетка не изменилась
  assert.deepEqual(grid.cells[0].rgb, [250, 10, 10]);
});

test('статистика: суммы сходятся, доли считаются, порядок по убыванию', () => {
  const grid = makeGrid(10, 10, (x) => (x < 7 ? [17, 17, 17] : [244, 244, 244]));
  const mapping = mapGridToPalette(grid, BASIC);

  const total = mapping.usage.reduce((sum, item) => sum + item.count, 0);
  assert.equal(total, 100, 'сумма количеств равна числу ячеек');

  assert.equal(mapping.usage.length, 2, 'использованы только два цвета');
  assert.equal(mapping.usage[0].color.name, 'Black');
  assert.equal(mapping.usage[0].count, 70);
  close(mapping.usage[0].share, 0.7, 1e-9, 'доля чёрного');
  assert.equal(mapping.usage[1].count, 30);
  assert.ok(mapping.usage[0].count >= mapping.usage[1].count, 'от частых к редким');

  // в статистику попадают только использованные цвета
  assert.ok(!mapping.usage.some((item) => item.color.name === 'Blue'));

  // и availableQuantity доезжает до статистики нетронутым
  assert.equal(mapping.usage[0].color.availableQuantity, 1200);
});

test('countUsage пересчитывает статистику по индексам', () => {
  const prepared = ensurePrepared(BASIC);
  const usage = countUsage([0, 0, 0, 4, 4, 11], prepared);
  assert.equal(usage[0].color.id, 'black');
  assert.equal(usage[0].count, 3);
  assert.equal(usage.length, 3);
  assert.equal(buildUsage(prepared, new Uint32Array(prepared.colors.length), 0).length, 0);
});

test('средняя и максимальная ошибка считаются', () => {
  const grid = makeGrid(2, 1, () => [124, 80, 58]); // точное попадание в Brown
  const mapping = mapGridToPalette(grid, BASIC);
  assert.equal(mapping.averageDistance, 0);
  assert.equal(mapping.maxDistance, 0);

  const off = mapGridToPalette(makeGrid(2, 1, () => [255, 0, 255]), BASIC);
  assert.ok(off.averageDistance > 10, 'пурпурного в палитре нет — ошибка большая');
});

test('прогресс сопоставления доходит до 1', () => {
  const grid = makeGrid(8, 8, (x, y) => [x * 30, y * 30, 128]);
  const values = [];
  mapGridToPalette(grid, BASIC, { onProgress: (value) => values.push(value) });
  assert.ok(values.length > 1);
  assert.equal(values.at(-1), 1);
});

test('сопоставление 96×96 укладывается в разумное время', () => {
  const grid = makeGrid(96, 96, (x, y) => [(x * 5) % 256, (y * 7) % 256, (x * y) % 256]);
  const started = performance.now();
  const mapping = mapGridToPalette(grid, BASIC);
  const ms = performance.now() - started;
  assert.equal(mapping.grid.cells.length, 9216);
  assert.ok(ms < 2000, `сопоставление заняло ${ms.toFixed(0)} мс`);
  console.log(`    ↳ 9 216 ячеек × 12 цветов за ${ms.toFixed(0)} мс`);
});
