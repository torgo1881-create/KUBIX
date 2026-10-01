import { buildUsage, ensurePrepared } from '../color/paletteMapping';
import { rgbToLab } from '../color/lab';
import { resolveDistance } from './perceptualDistance';
import type { PerceptualWeights } from '../../config/experiments';
import { DIFFUSION_DEFAULTS, type DiffusionConfig, type DiffusionKernelId } from '../../config/experiments';
import { REGION_LABELS, type WeightMap } from '../optimization/weightMap';
import type { CellMaps } from '../image/edges';
import type { MosaicCell, MosaicGrid, RGB } from '../../types/mosaic';
import type { Palette, PaletteColor, PaletteMapping, PreparedPalette } from '../../types/palette';

/**
 * Диффузия ошибки (кандидаты C и D).
 *
 * Обычное сопоставление округляет каждую ячейку независимо, и на плавной
 * коже это даёт крупные плоские пятна со ступенями. Диффузия переносит
 * ошибку округления на соседей: вместо одного пятна получается смесь двух
 * соседних тонов, которая с расстояния читается как промежуточный оттенок.
 *
 * Адаптивная версия применяет её не везде: на глазах, губах, бровях,
 * контуре лица и волосах перенос ослабляется, иначе черты «сыплются».
 */

interface Kernel {
  /** [dx, dy, вес] — вес нормируется делителем. */
  taps: [number, number, number][];
  divisor: number;
}

const KERNELS: Record<DiffusionKernelId, Kernel> = {
  'floyd-steinberg': {
    taps: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
    divisor: 16,
  },
  jarvis: {
    taps: [
      [1, 0, 7],
      [2, 0, 5],
      [-2, 1, 3],
      [-1, 1, 5],
      [0, 1, 7],
      [1, 1, 5],
      [2, 1, 3],
      [-2, 2, 1],
      [-1, 2, 3],
      [0, 2, 5],
      [1, 2, 3],
      [2, 2, 1],
    ],
    divisor: 48,
  },
  stucki: {
    taps: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
      [-2, 2, 1],
      [-1, 2, 2],
      [0, 2, 4],
      [1, 2, 2],
      [2, 2, 1],
    ],
    divisor: 42,
  },
};

/** Ячейки, где диффузию нужно придержать. */
const PROTECTED_REGIONS = new Set(['eyes', 'mouth', 'contour', 'hair']);

/**
 * Карта силы диффузии — отдельная от карты весов piece-limit.
 *
 * Намеренно не переиспользуем weightMap оптимизатора: там веса означают
 * «как дорого перекрашивать», здесь — «насколько можно размешивать».
 * Это разные вопросы, и смешивать их значит потерять управление обоими.
 */
export function buildDiffusionMap(
  cols: number,
  rows: number,
  maps: CellMaps | null,
  weightMap: WeightMap | null,
  config: DiffusionConfig['adaptive'],
): Float32Array {
  const strength = new Float32Array(cols * rows).fill(config.flatStrength);
  if (!config.enabled) return strength.fill(1);

  for (let i = 0; i < strength.length; i++) {
    let value = config.flatStrength;

    // Контуры по Собелю: чем сильнее граница, тем меньше размешиваем.
    if (maps) {
      const edge = maps.edge[i];
      if (edge >= config.edgeThreshold) {
        const t = Math.min(1, (edge - config.edgeThreshold) / (1 - config.edgeThreshold));
        value = config.flatStrength + (config.protectedStrength - config.flatStrength) * t;
      }
      // Детальные участки (ресницы, борода) тоже придерживаем.
      value *= 1 - 0.35 * Math.min(1, maps.structure[i]);
    }

    // Черты лица защищаем сильнее всего.
    if (weightMap) {
      const label = REGION_LABELS[weightMap.region[i]];
      if (PROTECTED_REGIONS.has(label)) value = Math.min(value, config.protectedStrength);
    }

    strength[i] = Math.max(0, Math.min(1, value));
  }

  return strength;
}

export interface DiffusionInput {
  grid: MosaicGrid;
  palette: Palette | PaletteColor[] | PreparedPalette;
  config?: Partial<DiffusionConfig>;
  /** Карта силы: длина cols × rows. Без неё сила одинакова везде. */
  strengthMap?: Float32Array | null;
  /** Веса перцептивного расстояния — для эксперимента части 7. */
  perceptual?: PerceptualWeights | null;
}

export function diffusionMapGrid(input: DiffusionInput): PaletteMapping {
  const config: DiffusionConfig = {
    ...DIFFUSION_DEFAULTS,
    ...input.config,
    adaptive: { ...DIFFUSION_DEFAULTS.adaptive, ...input.config?.adaptive },
  };

  const prepared = ensurePrepared(input.palette);
  const distance = resolveDistance({ metric: 'ciede2000', weights: input.perceptual ?? undefined });
  const kernel = KERNELS[config.kernel];

  const { grid } = input;
  const { cols, rows } = grid;
  const total = grid.cells.length;

  // Ошибка копится в RGB: так перенос остаётся линейным и предсказуемым.
  const working = new Float32Array(total * 3);
  for (let i = 0; i < total; i++) {
    working[i * 3] = grid.cells[i].rgb[0];
    working[i * 3 + 1] = grid.cells[i].rgb[1];
    working[i * 3 + 2] = grid.cells[i].rgb[2];
  }

  const assignments = new Uint16Array(total);
  const counts = new Uint32Array(prepared.colors.length);
  const cells: MosaicCell[] = new Array(total);

  let distanceSum = 0;
  let maxDistance = 0;

  const clamp255 = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : value);

  for (let y = 0; y < rows; y++) {
    const leftToRight = !config.serpentine || y % 2 === 0;
    const xs: number[] = [];
    for (let x = 0; x < cols; x++) xs.push(leftToRight ? x : cols - 1 - x);

    for (const x of xs) {
      const index = y * cols + x;
      const current: RGB = [
        clamp255(working[index * 3]),
        clamp255(working[index * 3 + 1]),
        clamp255(working[index * 3 + 2]),
      ];

      const lab = rgbToLab(current);
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let c = 0; c < prepared.colors.length; c++) {
        const value = distance(lab, prepared.colors[c].lab);
        if (value < bestDistance) {
          bestDistance = value;
          bestIndex = c;
        }
      }

      const color = prepared.colors[bestIndex];
      assignments[index] = bestIndex;
      counts[bestIndex]++;
      cells[index] = { x: grid.cells[index].x, y: grid.cells[index].y, rgb: [...color.rgb] as RGB, hex: color.hex };

      // Ошибка меряется относительно истинного цвета ячейки, а не накопленного:
      // так метрика остаётся сопоставимой с другими вариантами.
      const trueLab = rgbToLab(grid.cells[index].rgb);
      const trueError = distance(trueLab, color.lab);
      distanceSum += trueError;
      if (trueError > maxDistance) maxDistance = trueError;

      const strength = (input.strengthMap ? input.strengthMap[index] : 1) * config.strength;
      if (strength <= 0) continue;

      const error = [
        clampError(current[0] - color.rgb[0], config.clampError),
        clampError(current[1] - color.rgb[1], config.clampError),
        clampError(current[2] - color.rgb[2], config.clampError),
      ];

      for (const [dx, dy, weight] of kernel.taps) {
        const nx = x + (leftToRight ? dx : -dx);
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;

        const target = (ny * cols + nx) * 3;
        const share = (weight / kernel.divisor) * strength;
        working[target] += error[0] * share;
        working[target + 1] += error[1] * share;
        working[target + 2] += error[2] * share;
      }
    }
  }

  return {
    paletteId: prepared.id,
    metric: 'ciede2000',
    grid: { cols, rows, cells },
    assignments,
    usage: buildUsage(prepared, counts, total),
    averageDistance: total ? distanceSum / total : 0,
    maxDistance,
  };
}

function clampError(value: number, limit: number): number {
  return value > limit ? limit : value < -limit ? -limit : value;
}
