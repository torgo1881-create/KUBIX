import { buildUsage, ensurePrepared } from '../color/paletteMapping';
import { rgbToLab } from '../color/lab';
import { luminance } from '../image/edges';
import { resolveDistance } from './perceptualDistance';
import { SPATIAL_DEFAULTS, TONE_ZONES, type SpatialMappingConfig } from '../../config/experiments';
import type { CellMaps } from '../image/edges';
import type { MosaicCell, MosaicGrid, RGB } from '../../types/mosaic';
import type { Lab, Palette, PaletteColor, PaletteMapping, PreparedPalette } from '../../types/palette';

/**
 * Пространственно-осознанное сопоставление с палитрой (кандидат B).
 *
 * Отличие от production: цвет ячейки выбирается не изолированно, а с учётом
 * уже назначенных соседей и локального градиента исходника.
 *
 *   totalCost = colorError + neighborhoodPenalty + gradientPenalty + tonePenalty
 *
 * Важно: это не размытие. Соседский штраф отключается там, где проходит
 * настоящая граница (сила границы выше edgeRelease), поэтому контуры глаз,
 * губ, бровей и волос остаются резкими.
 */

export interface ToneZoneMap {
  /** Индекс тональной зоны для каждой ячейки лица, -1 вне лица. */
  zone: Int8Array;
  /** Пороги светлоты между зонами. */
  thresholds: number[];
  labels: string[];
}

export interface SpatialMappingInput {
  grid: MosaicGrid;
  palette: Palette | PaletteColor[] | PreparedPalette;
  maps?: CellMaps | null;
  /** Карта тональных зон лица — включает сохранение свет/полутон/тень. */
  tones?: ToneZoneMap | null;
  config?: Partial<SpatialMappingConfig>;
  /**
   * Необязательная диффузия ошибки поверх пространственного выбора
   * (кандидат D). Сила задаётся картой: на чертах лица — слабее.
   */
  diffusion?: { strengthMap?: Float32Array | null; strength?: number; clampError?: number } | null;
}

/**
 * Тональные зоны лица: не фиксированные цвета, а уровни относительной
 * светлоты внутри самого лица. Пороги считаются по перцентилям, поэтому
 * работают и на тёмной, и на светлой коже.
 */
export function buildToneZones(
  grid: MosaicGrid,
  faceCells: Uint8Array,
  percentiles: number[] = TONE_ZONES.percentiles,
): ToneZoneMap {
  const values: number[] = [];
  for (let i = 0; i < grid.cells.length; i++) {
    if (!faceCells[i]) continue;
    const [r, g, b] = grid.cells[i].rgb;
    values.push(luminance(r, g, b));
  }

  const zone = new Int8Array(grid.cells.length).fill(-1);
  if (values.length < 16) {
    return { zone, thresholds: [], labels: TONE_ZONES.labels };
  }

  values.sort((a, b) => a - b);
  const thresholds = percentiles.map((p) => values[Math.min(values.length - 1, Math.floor(p * values.length))]);

  for (let i = 0; i < grid.cells.length; i++) {
    if (!faceCells[i]) continue;
    const [r, g, b] = grid.cells[i].rgb;
    const value = luminance(r, g, b);
    let index = 0;
    while (index < thresholds.length && value > thresholds[index]) index++;
    zone[i] = index;
  }

  return { zone, thresholds, labels: TONE_ZONES.labels };
}

/** Ранг цвета палитры по светлоте: 0 — самый тёмный. */
function lightnessRanks(labs: Lab[]): number[] {
  const order = labs.map((lab, index) => ({ index, L: lab.L })).sort((a, b) => a.L - b.L);
  const ranks = new Array<number>(labs.length);
  order.forEach((item, position) => {
    ranks[item.index] = position;
  });
  return ranks;
}

export function spatialMapGrid(input: SpatialMappingInput): PaletteMapping {
  const config: SpatialMappingConfig = { ...SPATIAL_DEFAULTS, ...input.config };
  const prepared = ensurePrepared(input.palette);
  const distance = resolveDistance({ metric: config.metric, weights: config.perceptual });

  const { grid, maps = null, tones = null } = input;
  const { cols, rows } = grid;
  const total = grid.cells.length;
  const colorCount = prepared.colors.length;

  const paletteLabs = prepared.colors.map((color) => color.lab);
  const ranks = lightnessRanks(paletteLabs);
  const zoneCount = (tones?.thresholds.length ?? 0) + 1;

  // Расстояния между цветами палитры — для соседского штрафа.
  const colorToColor = new Float64Array(colorCount * colorCount);
  for (let a = 0; a < colorCount; a++) {
    for (let b = a + 1; b < colorCount; b++) {
      const value = distance(paletteLabs[a], paletteLabs[b]);
      colorToColor[a * colorCount + b] = value;
      colorToColor[b * colorCount + a] = value;
    }
  }

  // Накопитель ошибки округления: используется только если включена диффузия.
  const diffusion = input.diffusion ?? null;
  const carry = diffusion ? new Float32Array(total * 3) : null;
  const diffusionStrength = diffusion?.strength ?? 0.85;
  const diffusionClamp = diffusion?.clampError ?? 48;
  const clamp255 = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : value);

  const sourceLabs: Lab[] = grid.cells.map((cell) => rgbToLab(cell.rgb));
  const sourceLuma = grid.cells.map((cell) => luminance(cell.rgb[0], cell.rgb[1], cell.rgb[2]));

  const assignments = new Uint16Array(total);
  const counts = new Uint32Array(colorCount);
  const cells: MosaicCell[] = new Array(total);

  let distanceSum = 0;
  let maxDistance = 0;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x;

      // С диффузией цвет ячейки — исходный плюс перенесённая ошибка соседей.
      const effective: RGB = carry
        ? [
            clamp255(grid.cells[index].rgb[0] + carry[index * 3]),
            clamp255(grid.cells[index].rgb[1] + carry[index * 3 + 1]),
            clamp255(grid.cells[index].rgb[2] + carry[index * 3 + 2]),
          ]
        : grid.cells[index].rgb;

      const source = carry ? rgbToLab(effective) : sourceLabs[index];
      const edge = maps ? maps.edge[index] : 0;

      // На настоящей границе соседский штраф выключается — контур не смазываем.
      const cohesion = edge >= config.edgeRelease ? 0 : config.neighborWeight * (1 - edge / config.edgeRelease);

      // Уже назначенные соседи: слева, сверху и по диагоналям сверху.
      const neighbors: number[] = [];
      if (x > 0) neighbors.push(assignments[index - 1]);
      if (y > 0) neighbors.push(assignments[index - cols]);
      if (y > 0 && x > 0) neighbors.push(assignments[index - cols - 1]);
      if (y > 0 && x < cols - 1) neighbors.push(assignments[index - cols + 1]);

      // Локальный градиент исходника: куда светлеет картинка.
      const leftLuma = x > 0 ? sourceLuma[index - 1] : sourceLuma[index];
      const upLuma = y > 0 ? sourceLuma[index - cols] : sourceLuma[index];
      const wantBrighterThanLeft = sourceLuma[index] - leftLuma;
      const wantBrighterThanUp = sourceLuma[index] - upLuma;

      const leftColor = x > 0 ? assignments[index - 1] : -1;
      const upColor = y > 0 ? assignments[index - cols] : -1;

      let bestIndex = 0;
      let bestCost = Number.POSITIVE_INFINITY;
      let bestColorError = 0;

      for (let c = 0; c < colorCount; c++) {
        const colorError = distance(source, paletteLabs[c]) * config.colorWeight;

        // 1. Согласие с соседями: средняя разница с уже поставленными цветами.
        let neighborPenalty = 0;
        if (cohesion > 0 && neighbors.length > 0) {
          let sum = 0;
          for (const neighbor of neighbors) sum += colorToColor[c * colorCount + neighbor];
          neighborPenalty = cohesion * (sum / neighbors.length);
        }

        // 2. Сохранение направления градиента: если исходник светлеет,
        //    результат не должен темнеть, и наоборот.
        let gradientPenalty = 0;
        if (config.gradientWeight > 0) {
          if (leftColor >= 0) {
            const got = paletteLabs[c].L - paletteLabs[leftColor].L;
            if (Math.sign(got) !== 0 && Math.sign(wantBrighterThanLeft) !== 0 && Math.sign(got) !== Math.sign(wantBrighterThanLeft)) {
              gradientPenalty += Math.min(Math.abs(wantBrighterThanLeft), 24);
            }
          }
          if (upColor >= 0) {
            const got = paletteLabs[c].L - paletteLabs[upColor].L;
            if (Math.sign(got) !== 0 && Math.sign(wantBrighterThanUp) !== 0 && Math.sign(got) !== Math.sign(wantBrighterThanUp)) {
              gradientPenalty += Math.min(Math.abs(wantBrighterThanUp), 24);
            }
          }
          gradientPenalty *= config.gradientWeight;
        }

        // 3. Тональная зона лица: светлая зона должна получать светлую деталь.
        let tonePenalty = 0;
        if (tones && config.toneWeight > 0 && tones.zone[index] >= 0 && zoneCount > 1) {
          const wantRank = (tones.zone[index] / (zoneCount - 1)) * (colorCount - 1);
          tonePenalty = config.toneWeight * Math.abs(ranks[c] - wantRank);
        }

        const cost = colorError + neighborPenalty + gradientPenalty + tonePenalty;
        if (cost < bestCost) {
          bestCost = cost;
          bestIndex = c;
          // Ошибку меряем относительно истинного цвета ячейки, а не
          // накопленного: иначе метрики вариантов несопоставимы.
          bestColorError = distance(sourceLabs[index], paletteLabs[c]);
        }
      }

      const color = prepared.colors[bestIndex];
      assignments[index] = bestIndex;
      counts[bestIndex]++;
      cells[index] = { x: grid.cells[index].x, y: grid.cells[index].y, rgb: [...color.rgb] as RGB, hex: color.hex };

      distanceSum += bestColorError;
      if (bestColorError > maxDistance) maxDistance = bestColorError;

      // Перенос остатка на ещё не обработанных соседей (Floyd–Steinberg).
      if (carry) {
        const strength = (diffusion?.strengthMap ? diffusion.strengthMap[index] : 1) * diffusionStrength;
        if (strength > 0) {
          const error = [
            clampCarry(effective[0] - color.rgb[0], diffusionClamp),
            clampCarry(effective[1] - color.rgb[1], diffusionClamp),
            clampCarry(effective[2] - color.rgb[2], diffusionClamp),
          ];

          const taps: [number, number, number][] = [
            [1, 0, 7],
            [-1, 1, 3],
            [0, 1, 5],
            [1, 1, 1],
          ];

          for (const [dx, dy, weight] of taps) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const target = (ny * cols + nx) * 3;
            const share = (weight / 16) * strength;
            carry[target] += error[0] * share;
            carry[target + 1] += error[1] * share;
            carry[target + 2] += error[2] * share;
          }
        }
      }
    }
  }

  return {
    paletteId: prepared.id,
    metric: config.metric,
    grid: { cols, rows, cells },
    assignments,
    usage: buildUsage(prepared, counts, total),
    averageDistance: total ? distanceSum / total : 0,
    maxDistance,
  };
}

function clampCarry(value: number, limit: number): number {
  return value > limit ? limit : value < -limit ? -limit : value;
}
