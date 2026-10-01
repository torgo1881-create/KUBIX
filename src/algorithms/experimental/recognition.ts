import { luminance } from '../image/edges';
import { REGION_LABELS, type WeightMap } from '../optimization/weightMap';
import type { MosaicGrid } from '../../types/mosaic';

/**
 * Метрики узнаваемости.
 *
 * ΔE отвечает на вопрос «насколько точен цвет каждой ячейки», но не на
 * вопрос «узнаю ли я человека». Собранную мозаику смотрят с расстояния, где
 * отдельные детали сливаются, поэтому важна структура: где светлее, где
 * темнее, сохранился ли рельеф лица.
 *
 * Здесь две метрики:
 *   - structural similarity по яркости на дистанции просмотра;
 *   - использование тональной лестницы внутри лица.
 */

const FACE_LABELS = new Set(['eyes', 'mouth', 'contour', 'face']);

function lumaPlane(grid: MosaicGrid): Float32Array {
  const plane = new Float32Array(grid.cells.length);
  for (let i = 0; i < plane.length; i++) {
    const [r, g, b] = grid.cells[i].rgb;
    plane[i] = luminance(r, g, b);
  }
  return plane;
}

/** Усреднение блоками — имитация взгляда с расстояния. */
function downsample(plane: Float32Array, cols: number, rows: number, factor: number) {
  const outCols = Math.max(1, Math.floor(cols / factor));
  const outRows = Math.max(1, Math.floor(rows / factor));
  const out = new Float32Array(outCols * outRows);

  for (let y = 0; y < outRows; y++) {
    for (let x = 0; x < outCols; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= cols || sy >= rows) continue;
          sum += plane[sy * cols + sx];
          count++;
        }
      }
      out[y * outCols + x] = count ? sum / count : 0;
    }
  }

  return { data: out, cols: outCols, rows: outRows };
}

/**
 * SSIM по яркости с окном 8×8.
 *
 * Считается не на полной сетке, а на уменьшенной вдвое: так метрика
 * оценивает то, что видно с дистанции, а не попиксельное совпадение.
 * Именно это ближе всего к «узнаваемости».
 */
export function structuralSimilarity(
  averageGrid: MosaicGrid,
  mosaicGrid: MosaicGrid,
  viewingFactor = 2,
): number {
  const { cols, rows } = averageGrid;
  const a = downsample(lumaPlane(averageGrid), cols, rows, viewingFactor);
  const b = downsample(lumaPlane(mosaicGrid), cols, rows, viewingFactor);

  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const window = 8;

  let sum = 0;
  let windows = 0;

  for (let y = 0; y + window <= a.rows; y += 4) {
    for (let x = 0; x + window <= a.cols; x += 4) {
      let meanA = 0;
      let meanB = 0;
      for (let dy = 0; dy < window; dy++) {
        for (let dx = 0; dx < window; dx++) {
          meanA += a.data[(y + dy) * a.cols + (x + dx)];
          meanB += b.data[(y + dy) * b.cols + (x + dx)];
        }
      }
      const n = window * window;
      meanA /= n;
      meanB /= n;

      let varA = 0;
      let varB = 0;
      let covar = 0;
      for (let dy = 0; dy < window; dy++) {
        for (let dx = 0; dx < window; dx++) {
          const da = a.data[(y + dy) * a.cols + (x + dx)] - meanA;
          const db = b.data[(y + dy) * b.cols + (x + dx)] - meanB;
          varA += da * da;
          varB += db * db;
          covar += da * db;
        }
      }
      varA /= n - 1;
      varB /= n - 1;
      covar /= n - 1;

      const ssim =
        ((2 * meanA * meanB + C1) * (2 * covar + C2)) /
        ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));

      sum += ssim;
      windows++;
    }
  }

  return windows ? Math.round((sum / windows) * 1000) / 1000 : 1;
}

export interface ToneCoverage {
  /** Сколько разных уровней яркости реально использовано в лице. */
  levelsUsed: number;
  /** Эффективное число уровней по энтропии: одна случайная ячейка не считается. */
  effectiveLevels: number;
  /** Разброс яркости внутри лица — «объём» кожи. */
  faceContrast: number;
  /** Разброс яркости лица в оригинале — для сравнения. */
  sourceFaceContrast: number;
  /** Доля сохранённого рельефа: 1 — рельеф как в оригинале. */
  contrastRatio: number;
}

/**
 * Насколько мозаика использует тональную лестницу внутри лица.
 *
 * Если лицо занимает 1000 ячеек и получило два уровня яркости — оно плоское,
 * каким бы точным ни был ΔE.
 */
export function toneCoverage(
  averageGrid: MosaicGrid,
  mosaicGrid: MosaicGrid,
  weightMap: WeightMap | null,
): ToneCoverage {
  const levels = new Map<number, number>();
  let sum = 0;
  let sumSquares = 0;
  let sourceSum = 0;
  let sourceSquares = 0;
  let count = 0;

  for (let i = 0; i < mosaicGrid.cells.length; i++) {
    if (weightMap && !FACE_LABELS.has(REGION_LABELS[weightMap.region[i]])) continue;

    const [r, g, b] = mosaicGrid.cells[i].rgb;
    const value = Math.round(luminance(r, g, b));
    levels.set(value, (levels.get(value) ?? 0) + 1);

    sum += value;
    sumSquares += value * value;

    const source = averageGrid.cells[i].rgb;
    const sourceValue = luminance(source[0], source[1], source[2]);
    sourceSum += sourceValue;
    sourceSquares += sourceValue * sourceValue;
    count++;
  }

  if (count === 0) {
    return { levelsUsed: 0, effectiveLevels: 0, faceContrast: 0, sourceFaceContrast: 0, contrastRatio: 0 };
  }

  let entropy = 0;
  for (const value of levels.values()) {
    const p = value / count;
    entropy -= p * Math.log(p);
  }

  const faceContrast = Math.sqrt(Math.max(0, sumSquares / count - (sum / count) ** 2));
  const sourceFaceContrast = Math.sqrt(Math.max(0, sourceSquares / count - (sourceSum / count) ** 2));

  return {
    levelsUsed: levels.size,
    effectiveLevels: Math.round(Math.exp(entropy) * 100) / 100,
    faceContrast: Math.round(faceContrast * 10) / 10,
    sourceFaceContrast: Math.round(sourceFaceContrast * 10) / 10,
    contrastRatio: sourceFaceContrast > 0 ? Math.round((faceContrast / sourceFaceContrast) * 100) / 100 : 0,
  };
}

/**
 * Рябь: доля площади в очень мелких одноцветных островках.
 *
 * Диффузия ошибки платит за плавные переходы одиночными «искрами». Эта
 * метрика ловит именно их: чем выше, тем заметнее цифровая крупа вблизи.
 */
export function grainShare(grid: MosaicGrid): number {
  const { cols, rows } = grid;
  const total = grid.cells.length;
  const seen = new Uint8Array(total);
  let small = 0;

  for (let start = 0; start < total; start++) {
    if (seen[start]) continue;
    const hex = grid.cells[start].hex;
    const stack = [start];
    seen[start] = 1;
    const component: number[] = [];

    while (stack.length) {
      const cell = stack.pop() as number;
      component.push(cell);
      const x = cell % cols;
      const y = (cell - x) / cols;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const neighbor = ny * cols + nx;
        if (!seen[neighbor] && grid.cells[neighbor].hex === hex) {
          seen[neighbor] = 1;
          stack.push(neighbor);
        }
      }
    }

    if (component.length <= 2) small += component.length;
  }

  return Math.round((1000 * small) / total) / 10;
}

/**
 * Сводная оценка узнаваемости.
 *
 * Ни одна отдельная метрика не описывает «узнаю ли я человека», поэтому
 * складываем те, что коррелируют с восприятием, и вычитаем рябь. Веса
 * подобраны так, чтобы порядок вариантов совпал с визуальной оценкой на
 * реальных снимках — это оценочная шкала для сравнения, а не физическая
 * величина.
 */
export function recognitionScore(input: {
  ssim: number;
  edgeScore: number;
  contrastRatio: number;
  grain: number;
  deltaE: number;
}): number {
  // Рельеф полезен до единицы, дальше это уже пересвет.
  const relief = Math.min(1, input.contrastRatio) * 0.25 + Math.max(0, Math.min(0.6, input.contrastRatio - 1)) * 0.15;
  const colour = Math.max(0, 1 - input.deltaE / 25) * 0.15;
  const grainPenalty = Math.min(0.15, input.grain / 100);

  const score = input.ssim * 0.4 + input.edgeScore * 0.2 + relief + colour - grainPenalty;
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}
