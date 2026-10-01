/**
 * Локальный контраст по ячейкам и «почерк» мозаики.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blurPlane, detailPasses, sharpenGrid } from '../src/algorithms/experimental/gridDetail.ts';
import { KIT_SIGNATURE, gridSignature, signatureDistance, toneIndices } from '../src/algorithms/experimental/signature.ts';
import { getPalette } from '../src/config/paletteData.ts';

function makeGrid(cols, rows, fill) {
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = fill(x, y);
      const rgb = Array.isArray(v) ? v : [v, v, v];
      cells.push({ x, y, rgb, hex: '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase() });
    }
  }
  return { cols, rows, cells };
}

test('размытие сохраняет ровное поле и усредняет ступень', () => {
  const flat = new Float32Array(16).fill(100);
  const blurred = blurPlane(flat, 4, 4, 1);
  for (const v of blurred) assert.ok(Math.abs(v - 100) < 1e-4);

  const step = new Float32Array(16);
  for (let i = 0; i < 16; i++) step[i] = i % 4 < 2 ? 0 : 200;
  const soft = blurPlane(step, 4, 4, 1);
  assert.ok(soft[1] > 0 && soft[1] < soft[2] && soft[2] < 200, 'на границе — промежуточные значения');
});

test('нерезкая маска: ровное поле не трогает, границу усиливает ореолами', () => {
  const flat = makeGrid(8, 8, () => 120);
  assert.equal(sharpenGrid(flat, detailPasses({ fine: 1.5 })), 0);
  for (const cell of flat.cells) assert.deepEqual(cell.rgb, [120, 120, 120]);

  const edge = makeGrid(8, 8, (x) => (x < 4 ? 80 : 160));
  const changed = sharpenGrid(edge, detailPasses({ fine: 1 }));
  assert.ok(changed > 0);
  const row = edge.cells.slice(0, 8).map((cell) => cell.rgb[0]);
  assert.ok(row[3] < 80, `тёмная сторона у границы темнее: ${row[3]}`);
  assert.ok(row[4] > 160, `светлая сторона у границы светлее: ${row[4]}`);
  assert.ok(row[0] >= 79 && row[0] <= 81, 'вдали от границы почти без изменений');
  assert.ok(edge.cells.every((cell) => cell.hex === '#' + cell.rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()), 'hex обновлён');
});

test('цветность сохраняется: RGB масштабируется отношением яркостей', () => {
  const grid = makeGrid(6, 1, (x) => (x < 3 ? [60, 40, 30] : [200, 150, 120]));
  sharpenGrid(grid, detailPasses({ fine: 1 }));
  const [r, g, b] = grid.cells[2].rgb;
  assert.ok(Math.abs(r / g - 60 / 40) < 0.1, 'соотношение каналов осталось');
  assert.ok(Math.abs(g / b - 40 / 30) < 0.1);
  for (const cell of grid.cells) for (const c of cell.rgb) assert.ok(c >= 0 && c <= 255 && Number.isInteger(c));
});

test('пустые и нулевые настройки не дают проходов', () => {
  assert.deepEqual(detailPasses(null), []);
  assert.deepEqual(detailPasses({ fine: 0, coarse: 0 }), []);
  assert.equal(detailPasses({ fine: 1, coarse: 0.5 }).length, 2);
  assert.equal(detailPasses({ fine: 1, coarse: 0.5 })[0].radius, 4, 'сначала объём, потом штрих');
});

test('почерк: ровное поле — без границ, шахматка — границы везде', () => {
  const palette = getPalette('classic');
  const flat = makeGrid(8, 8, () => 138);
  const s1 = gridSignature(flat, palette);
  assert.equal(s1.edgeDensity, 0);
  assert.equal(s1.largestRegion, 1);
  assert.equal(s1.diversity, 1);

  const checker = makeGrid(8, 8, (x, y) => ((x + y) % 2 ? 20 : 242));
  const s2 = gridSignature(checker, palette);
  assert.equal(s2.edgeDensity, 1);
  assert.equal(s2.jumps, 1, 'белый рядом с чёрным — скачок на четыре тона');
  // Края считаются с зажатыми соседями (как при снятии эталона), поэтому одиночные — только внутренние 6×6.
  assert.equal(s2.isolated, 36 / 64);
  assert.equal(s2.diversity, 2);
  assert.ok(s2.shares[0] > 0.49 && s2.shares[4] > 0.49);

  const tones = toneIndices(checker, palette);
  assert.equal(tones[0], 0, 'белый — самый светлый тон');
  assert.equal(tones[1], 4, 'чёрный — самый тёмный');
});

test('расстояние до подписи набора: ноль к себе, растёт с разницей', () => {
  assert.equal(signatureDistance(KIT_SIGNATURE, KIT_SIGNATURE), 0);
  const smooth = { ...KIT_SIGNATURE, edgeDensity: 0.18, jumps: 0.01 };
  const near = { ...KIT_SIGNATURE, edgeDensity: 0.33 };
  assert.ok(signatureDistance(smooth, KIT_SIGNATURE) > signatureDistance(near, KIT_SIGNATURE));
});
