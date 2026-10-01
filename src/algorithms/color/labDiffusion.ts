import { buildUsage, ensurePrepared } from './paletteMapping';
import { labToRgb, rgbToLab } from './lab';
import { resolveDistance } from '../experimental/perceptualDistance';
import { LAB_DIFFUSION_DEFAULTS, type LabDiffusionConfig } from '../../config/experiments';
import { REGION_LABELS, type WeightMap } from '../optimization/weightMap';
import type { MosaicCell, MosaicGrid, RGB } from '../../types/mosaic';
import type { Lab, Palette, PaletteColor, PaletteMapping, PreparedPalette } from '../../types/palette';

/**
 * Диффузия ошибки в перцептивном пространстве Lab.
 *
 * Отличие от эксперимента 9B: ошибка округления не считается в RGB и не
 * переводится потом в Lab — она с самого начала живёт в Lab. Это важно,
 * потому что выбор цвета тоже идёт по перцептивной метрике: обе половины
 * алгоритма наконец работают в одних единицах.
 *
 * Порядок на каждой ячейке:
 *   1. к истинному Lab прибавляется накопленная соседями ошибка;
 *   2. по взвешенному расстоянию выбирается ближайшая деталь;
 *   3. разница «что хотели минус что поставили» считается в Lab;
 *   4. она раздаётся ещё не обработанным соседям по ядру Флойда–Стейнберга.
 *
 * Пространственных штрафов здесь нет намеренно: эксперимент 9B показал, что
 * они ухудшают контуры и градиенты, а мы изолируем эффект самой диффузии.
 */

export interface LabDiffusionInput {
  grid: MosaicGrid;
  palette: Palette | PaletteColor[] | PreparedPalette;
  config?: Partial<LabDiffusionConfig>;
  /**
   * Карта областей: из неё берутся зональные силы в адаптивном режиме.
   * Это отдельная от piece-limit трактовка — здесь веса значат
   * «насколько можно размешивать», а не «как дорого перекрашивать».
   */
  weightMap?: WeightMap | null;
}

/** Сила диффузии для каждой ячейки по её области. */
export function buildLabDiffusionStrength(
  cellCount: number,
  weightMap: WeightMap | null,
  config: LabDiffusionConfig,
): Float32Array {
  const strength = new Float32Array(cellCount).fill(config.strength);
  if (!config.adaptive) return strength;

  const zones = config.zones;
  for (let i = 0; i < cellCount; i++) {
    if (!weightMap) {
      strength[i] = zones.base;
      continue;
    }

    const label = REGION_LABELS[weightMap.region[i]];
    switch (label) {
      case 'eyes':
        strength[i] = zones.eyes;
        break;
      case 'mouth':
        strength[i] = zones.mouth;
        break;
      case 'contour':
        strength[i] = zones.contour;
        break;
      case 'hair':
        strength[i] = zones.hair;
        break;
      case 'face':
        strength[i] = zones.face;
        break;
      // Границы объектов вне лица тоже придерживаем — иначе контур сыплется.
      case 'edge':
        strength[i] = Math.min(zones.contour * 1.4, zones.base);
        break;
      default:
        strength[i] = zones.base;
    }
  }

  return strength;
}

const FS_TAPS: [number, number, number][] = [
  [1, 0, 7],
  [-1, 1, 3],
  [0, 1, 5],
  [1, 1, 1],
];

export function labDiffusionMapGrid(input: LabDiffusionInput): PaletteMapping {
  const config: LabDiffusionConfig = {
    ...LAB_DIFFUSION_DEFAULTS,
    ...input.config,
    zones: { ...LAB_DIFFUSION_DEFAULTS.zones, ...input.config?.zones },
  };

  const prepared = ensurePrepared(input.palette);
  const distance = resolveDistance({ metric: 'ciede2000', weights: config.perceptual });

  const { grid } = input;
  const { cols, rows } = grid;
  const total = grid.cells.length;
  const colorCount = prepared.colors.length;

  const strengthMap = buildLabDiffusionStrength(total, input.weightMap ?? null, config);

  // Истинные цвета ячеек в Lab — эталон, от него же считаются метрики.
  const sourceLab: Lab[] = grid.cells.map((cell) => rgbToLab(cell.rgb));

  // Накопленная ошибка, тоже в Lab.
  const carryL = new Float32Array(total);
  const carryA = new Float32Array(total);
  const carryB = new Float32Array(total);

  const assignments = new Uint16Array(total);
  const counts = new Uint32Array(colorCount);
  const cells: MosaicCell[] = new Array(total);

  let distanceSum = 0;
  let maxDistance = 0;

  const clamp = (value: number, limit: number) => (value > limit ? limit : value < -limit ? -limit : value);

  for (let y = 0; y < rows; y++) {
    const leftToRight = !config.serpentine || y % 2 === 0;

    for (let step = 0; step < cols; step++) {
      const x = leftToRight ? step : cols - 1 - step;
      const index = y * cols + x;

      // 1. Цель = истинный цвет плюс то, что не смогли передать соседи.
      const target: Lab = {
        L: Math.max(0, Math.min(100, sourceLab[index].L + carryL[index])),
        a: Math.max(-128, Math.min(127, sourceLab[index].a + carryA[index])),
        b: Math.max(-128, Math.min(127, sourceLab[index].b + carryB[index])),
      };

      // 2. Ближайшая деталь по взвешенной перцептивной метрике.
      let bestIndex = 0;
      let bestCost = Number.POSITIVE_INFINITY;
      for (let c = 0; c < colorCount; c++) {
        const cost = distance(target, prepared.colors[c].lab);
        if (cost < bestCost) {
          bestCost = cost;
          bestIndex = c;
        }
      }

      const color = prepared.colors[bestIndex];
      assignments[index] = bestIndex;
      counts[bestIndex]++;
      cells[index] = { x: grid.cells[index].x, y: grid.cells[index].y, rgb: [...color.rgb] as RGB, hex: color.hex };

      // Ошибку для отчёта меряем относительно истинного цвета, а не цели:
      // иначе варианты нельзя сравнивать между собой.
      const trueError = distance(sourceLab[index], color.lab);
      distanceSum += trueError;
      if (trueError > maxDistance) maxDistance = trueError;

      // 3. Остаток в Lab.
      const strength = strengthMap[index];
      if (strength <= 0) continue;

      const errorL = clamp(target.L - color.lab.L, config.clampL);
      const errorA = clamp(target.a - color.lab.a, config.clampAb);
      const errorB = clamp(target.b - color.lab.b, config.clampAb);

      // 4. Раздача ещё не обработанным соседям.
      for (const [dx, dy, weight] of FS_TAPS) {
        const nx = x + (leftToRight ? dx : -dx);
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;

        const neighbor = ny * cols + nx;
        const share = (weight / 16) * strength;
        carryL[neighbor] += errorL * share;
        carryA[neighbor] += errorA * share;
        carryB[neighbor] += errorB * share;
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

/** Проверочная утилита: Lab → RGB, чтобы убедиться в согласованности единиц. */
export function labRoundTrip(rgb: RGB): RGB {
  return labToRgb(rgbToLab(rgb));
}
