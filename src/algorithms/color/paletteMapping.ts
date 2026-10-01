import type { MosaicCell, MosaicGrid, RGB } from '../../types/mosaic';
import type {
  ColorDistanceMetric,
  NearestColorMatch,
  Palette,
  PaletteColor,
  PaletteMapping,
  PaletteUsage,
  PreparedPalette,
  PreparedPaletteColor,
} from '../../types/palette';
import { DEFAULT_DISTANCE_METRIC, getDistanceFn } from './distance';
import { rgbToLab } from './lab';

/**
 * Сопоставление цветов изображения с цветами физической палитры.
 *
 * Ни один цвет здесь не зашит: палитра всегда приходит аргументом.
 * Поменять название, HEX, RGB или количество можно прямо в
 * config/palettes.json, пересобирать код не нужно.
 */

function normalizePaletteHex(hex: string): string {
  const clean = hex.trim().replace(/^#/, '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  return '#' + full.toUpperCase();
}

/** Считает Lab для каждого цвета палитры один раз. */
export function preparePalette(source: Palette | PaletteColor[], fallbackId = 'custom'): PreparedPalette {
  const colors = Array.isArray(source) ? source : source.colors;
  const id = Array.isArray(source) ? fallbackId : source.id;

  if (!colors.length) {
    throw new Error('Палитра пустая: нужен хотя бы один цвет');
  }

  return {
    id,
    colors: colors.map((color, index) => ({
      ...color,
      hex: normalizePaletteHex(color.hex),
      lab: rgbToLab(color.rgb),
      index,
    })),
  };
}

function isPrepared(palette: Palette | PaletteColor[] | PreparedPalette): palette is PreparedPalette {
  return (
    !Array.isArray(palette) &&
    Array.isArray((palette as PreparedPalette).colors) &&
    (palette as PreparedPalette).colors.every((color) => 'lab' in color)
  );
}

export function ensurePrepared(palette: Palette | PaletteColor[] | PreparedPalette): PreparedPalette {
  return isPrepared(palette) ? palette : preparePalette(palette);
}

/**
 * Ближайший цвет палитры для произвольного RGB.
 * Сравнение идёт в Lab выбранной метрикой, а не по RGB.
 */
export function findNearestPaletteColor(
  rgb: RGB,
  palette: Palette | PaletteColor[] | PreparedPalette,
  metric: ColorDistanceMetric = DEFAULT_DISTANCE_METRIC,
): NearestColorMatch {
  const prepared = ensurePrepared(palette);
  const distanceFn = getDistanceFn(metric);
  const lab = rgbToLab(rgb);

  let best: PreparedPaletteColor = prepared.colors[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const color of prepared.colors) {
    const distance = distanceFn(lab, color.lab);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = color;
      if (distance === 0) break;
    }
  }

  return { color: best, distance: bestDistance };
}

/** Ключ кэша: три байта в одном числе. */
function packRgb(rgb: RGB): number {
  return ((rgb[0] & 255) << 16) | ((rgb[1] & 255) << 8) | (rgb[2] & 255);
}

export interface MapToPaletteOptions {
  metric?: ColorDistanceMetric;
  /** Прогресс сопоставления, 0..1. */
  onProgress?: (progress: number) => void;
}

/**
 * Каждая ячейка сетки получает ближайший цвет палитры.
 * Возвращается новая сетка (исходные средние цвета не портятся),
 * индексы цветов и статистика использования.
 */
export function mapGridToPalette(
  grid: MosaicGrid,
  palette: Palette | PaletteColor[] | PreparedPalette,
  options: MapToPaletteOptions = {},
): PaletteMapping {
  const prepared = ensurePrepared(palette);
  const metric = options.metric ?? DEFAULT_DISTANCE_METRIC;
  const distanceFn = getDistanceFn(metric);

  const total = grid.cells.length;
  const cells: MosaicCell[] = new Array(total);
  const assignments = new Uint16Array(total);
  const counts = new Uint32Array(prepared.colors.length);

  // Изображения содержат много повторяющихся цветов — кэш экономит поиск.
  const cache = new Map<number, number>();
  const distanceCache = new Map<number, number>();

  let distanceSum = 0;
  let maxDistance = 0;
  const progressStep = Math.max(1, Math.floor(total / 20));

  for (let i = 0; i < total; i++) {
    const cell = grid.cells[i];
    const key = packRgb(cell.rgb);

    let index = cache.get(key);
    let distance: number;

    if (index === undefined) {
      const lab = rgbToLab(cell.rgb);
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const color of prepared.colors) {
        const d = distanceFn(lab, color.lab);
        if (d < bestDistance) {
          bestDistance = d;
          best = color.index;
          if (d === 0) break;
        }
      }
      index = best;
      distance = bestDistance;
      cache.set(key, index);
      distanceCache.set(key, distance);
    } else {
      distance = distanceCache.get(key) ?? 0;
    }

    const color = prepared.colors[index];
    assignments[i] = index;
    counts[index]++;
    distanceSum += distance;
    if (distance > maxDistance) maxDistance = distance;

    cells[i] = { x: cell.x, y: cell.y, rgb: [...color.rgb] as RGB, hex: color.hex };

    if (options.onProgress && (i % progressStep === 0 || i === total - 1)) {
      options.onProgress((i + 1) / total);
    }
  }

  return {
    paletteId: prepared.id,
    metric,
    grid: { cols: grid.cols, rows: grid.rows, cells },
    assignments,
    usage: buildUsage(prepared, counts, total),
    averageDistance: total ? distanceSum / total : 0,
    maxDistance,
  };
}

/** Использованные цвета от частых к редким. Неиспользованные не попадают в список. */
export function buildUsage(
  palette: PreparedPalette,
  counts: Uint32Array | number[],
  total: number,
): PaletteUsage[] {
  const usage: PaletteUsage[] = [];

  palette.colors.forEach((color, index) => {
    const count = counts[index] ?? 0;
    if (count === 0) return;
    const { lab: _lab, index: _index, ...plain } = color;
    usage.push({ color: plain, count, share: total ? count / total : 0 });
  });

  return usage.sort((a, b) => b.count - a.count || a.color.name.localeCompare(b.color.name));
}

/** Пересчёт статистики по уже готовому назначению — например, после ручной правки. */
export function countUsage(
  assignments: ArrayLike<number>,
  palette: Palette | PaletteColor[] | PreparedPalette,
): PaletteUsage[] {
  const prepared = ensurePrepared(palette);
  const counts = new Uint32Array(prepared.colors.length);
  for (let i = 0; i < assignments.length; i++) {
    const index = assignments[i];
    if (index >= 0 && index < counts.length) counts[index]++;
  }
  return buildUsage(prepared, counts, assignments.length);
}
