import { luminance } from '../image/edges';
import type { MosaicGrid, RGB } from '../../types/mosaic';

/**
 * Локальный контраст на уровне сетки — нерезкая маска по ячейкам.
 *
 * Откуда это. Сравнение с готовыми наборами на одной и той же фотографии
 * показало, чем их мозаика отличается от нашей не «вкусом», а числами:
 * у них вдвое больше границ между соседними ячейками (0,36 против 0,18),
 * в двенадцать раз чаще сосед отличается на два и более тона (11 % против
 * 1 %), в блоке 4×4 — три тона вместо двух. Светлая ячейка рядом с тёмной
 * чертой — брови, крылья носа, пряди волос — это ореол нерезкой маски,
 * применённой уже к сетке, а не к пикселям: резкость на 1536-пиксельном
 * снимке усреднение почти целиком съедает.
 *
 * Здесь то же самое делается честно: яркость каждой ячейки сравнивается с
 * размытой окрестностью, разница усиливается. Мелкий радиус (1 ячейка)
 * даёт штрих и фактуру, крупный (3–4 ячейки) — объём: лицо перестаёт быть
 * одним пятном. Цветность не меняется: RGB масштабируется отношением
 * яркостей, поэтому для цветных наборов это тоже безопасно.
 */

export interface GridDetailPass {
  /** Радиус размытия в ячейках (σ гауссианы). */
  radius: number;
  /** Сила: 0 — ничего, 1 — разница с окрестностью добавляется целиком. */
  amount: number;
}

export interface GridDetailOptions {
  /** Мелкий радиус (1 ячейка): штрих, фактура, ореолы вдоль черт. */
  fine?: number;
  /** Крупный радиус (4 ячейки): объём больших форм. */
  coarse?: number;
}

export const FINE_RADIUS = 1;
export const COARSE_RADIUS = 4;

/** Пары радиус/сила из короткой записи настроек варианта. */
export function detailPasses(options: GridDetailOptions | undefined | null): GridDetailPass[] {
  if (!options) return [];
  const passes: GridDetailPass[] = [];
  if (options.coarse && options.coarse > 0) passes.push({ radius: COARSE_RADIUS, amount: options.coarse });
  if (options.fine && options.fine > 0) passes.push({ radius: FINE_RADIUS, amount: options.fine });
  return passes;
}

function gaussianKernel(sigma: number): Float32Array {
  const half = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(half * 2 + 1);
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + half] = value;
    sum += value;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

/** Разделимое размытие с зажатыми краями: за границей сетки — крайняя ячейка. */
export function blurPlane(plane: Float32Array, cols: number, rows: number, sigma: number): Float32Array {
  const kernel = gaussianKernel(sigma);
  const half = (kernel.length - 1) / 2;
  const temp = new Float32Array(plane.length);
  const out = new Float32Array(plane.length);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let sum = 0;
      for (let k = -half; k <= half; k++) {
        const sx = Math.min(cols - 1, Math.max(0, x + k));
        sum += plane[y * cols + sx] * kernel[k + half];
      }
      temp[y * cols + x] = sum;
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let sum = 0;
      for (let k = -half; k <= half; k++) {
        const sy = Math.min(rows - 1, Math.max(0, y + k));
        sum += temp[sy * cols + x] * kernel[k + half];
      }
      out[y * cols + x] = sum;
    }
  }
  return out;
}

function toHex(rgb: RGB): string {
  return '#' + rgb.map((channel) => channel.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * Усиливает локальный контраст яркости ячеек на месте.
 *
 * Каждый проход считает разницу с размытой окрестностью по исходной
 * яркости и складывает усиленные разницы; потом яркость зажимается в
 * 0..255 и переносится на RGB отношением. Возвращает долю ячеек, у которых
 * яркость изменилась заметно (> 2), — удобно для отчётов.
 */
export function sharpenGrid(grid: MosaicGrid, passes: GridDetailPass[]): number {
  const active = passes.filter((pass) => pass.amount > 0 && pass.radius > 0);
  if (!active.length || !grid.cells.length) return 0;

  const { cols, rows, cells } = grid;
  const plane = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const [r, g, b] = cells[i].rgb;
    plane[i] = luminance(r, g, b);
  }

  const delta = new Float32Array(cells.length);
  for (const pass of active) {
    const blurred = blurPlane(plane, cols, rows, pass.radius);
    for (let i = 0; i < cells.length; i++) delta[i] += pass.amount * (plane[i] - blurred[i]);
  }

  let changed = 0;
  for (let i = 0; i < cells.length; i++) {
    if (Math.abs(delta[i]) < 1e-6) continue;
    const before = plane[i];
    const after = Math.min(255, Math.max(0, before + delta[i]));
    if (Math.abs(after - before) > 2) changed++;

    const cell = cells[i];
    let rgb: RGB;
    if (before > 1) {
      const ratio = after / before;
      rgb = [cell.rgb[0] * ratio, cell.rgb[1] * ratio, cell.rgb[2] * ratio] as RGB;
      // Светлые цвета при усилении упираются в 255 по одному каналу —
      // остаток добавляем поровну, чтобы тон не уходил в цветной.
      const over = Math.max(rgb[0], rgb[1], rgb[2]) - 255;
      if (over > 0) rgb = rgb.map((channel) => Math.min(255, channel + over * 0.5)) as RGB;
    } else {
      const shift = after - before;
      rgb = [cell.rgb[0] + shift, cell.rgb[1] + shift, cell.rgb[2] + shift] as RGB;
    }
    cell.rgb = rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel)))) as RGB;
    cell.hex = toHex(cell.rgb);
  }

  return changed / cells.length;
}
