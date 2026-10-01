import type { MosaicCell, MosaicGrid, RGB } from '../../types/mosaic';
import type {
  ColorDistanceMetric,
  Palette,
  PaletteColor,
  PaletteMapping,
  PreparedPalette,
} from '../../types/palette';
import { DEFAULT_DISTANCE_METRIC, getDistanceFn } from '../color/distance';
import { rgbToLab } from '../color/lab';
import { buildUsage, ensurePrepared } from '../color/paletteMapping';
import type { CellMaps } from '../image/edges';
import { calculateReplacementCost, resolveWeights, type CostWeights } from './costFunction';

/**
 * Учёт ограниченного запаса деталей.
 *
 * Первичное сопоставление с палитрой берёт для каждой ячейки ближайший цвет и
 * ничего не знает про остатки. Здесь мы забираем лишние ячейки у переполненных
 * цветов и отдаём их тем, у кого запас остался, выбирая для переноса **самые
 * дешёвые** ячейки: те, где замена меньше всего портит картинку.
 *
 * Перебора всех комбинаций нет. Для каждой ячейки переполненного цвета
 * считается цена лучшей альтернативы, кандидаты складываются в кучу и
 * разбираются от самых дешёвых. Если у выбранного цвета к моменту переноса
 * кончился запас, кандидат пересчитывается и возвращается в кучу — это
 * ленивая переоценка, а не повторный полный проход.
 */

export type PieceLimitStatus = 'ok' | 'corrected' | 'over';

export interface ColorRequirement {
  color: PaletteColor;
  /** Сколько деталей нужно после оптимизации. */
  required: number;
  /** Сколько было нужно сразу после palette mapping. */
  initialRequired: number;
  available: number;
  status: PieceLimitStatus;
}

export interface PieceLimitOptions {
  metric?: ColorDistanceMetric;
  weights?: Partial<CostWeights>;
  /** Карты границ и детальности. Без них оптимизация опирается только на цвет. */
  maps?: CellMaps | null;
  /**
   * Карта важности ячеек (weightMap): лицо, глаза, рот и контуры дороже.
   * Длина — cols × rows. Без неё все ячейки равны.
   */
  cellWeights?: Float32Array | null;
  /** Предохранитель от зацикливания. По умолчанию — четыре прохода по палитре. */
  maxIterations?: number;
  onProgress?: (progress: number) => void;
}

export interface PieceLimitResult {
  /** Обновлённое сопоставление: сетка, индексы, статистика. */
  mapping: PaletteMapping;
  requirements: ColorRequirement[];
  /** Хватает ли деталей в принципе (сумма запасов ≥ числа ячеек). */
  feasible: boolean;
  /** Соблюдены ли все ограничения после оптимизации. */
  satisfied: boolean;
  /** Сколько ячеек переназначено. */
  moved: number;
  iterations: number;
  totalCells: number;
  totalAvailable: number;
  /** На сколько выросла средняя ошибка ΔE из-за ограничений. */
  addedError: number;
  durationMs: number;
}

export interface PieceLimitInput {
  /** Сетка средних цветов — истинные цвета, от них считается ошибка. */
  averageGrid: MosaicGrid;
  /** Результат первичного сопоставления с палитрой. */
  mapping: PaletteMapping;
  palette: Palette | PaletteColor[] | PreparedPalette;
  options?: PieceLimitOptions;
}

/** Сводка «нужно / есть / статус» по каждому цвету. */
export function summarizeRequirements(
  palette: PreparedPalette,
  counts: ArrayLike<number>,
  initialCounts: ArrayLike<number>,
): ColorRequirement[] {
  const requirements: ColorRequirement[] = [];

  palette.colors.forEach((color, index) => {
    const required = counts[index] ?? 0;
    const initialRequired = initialCounts[index] ?? 0;
    if (required === 0 && initialRequired === 0) return;

    const { lab: _lab, index: _index, ...plain } = color;
    const status: PieceLimitStatus =
      required > color.availableQuantity
        ? 'over'
        : initialRequired > color.availableQuantity
          ? 'corrected'
          : 'ok';

    requirements.push({ color: plain, required, initialRequired, available: color.availableQuantity, status });
  });

  return requirements.sort((a, b) => b.required - a.required || a.color.name.localeCompare(b.color.name));
}

/** Куча минимумов на типизированных массивах: кандидаты «ячейка → цвет» по цене. */
class CandidateHeap {
  private deltas: number[] = [];
  private cells: number[] = [];
  private alternatives: number[] = [];

  get size(): number {
    return this.deltas.length;
  }

  push(delta: number, cell: number, alternative: number): void {
    this.deltas.push(delta);
    this.cells.push(cell);
    this.alternatives.push(alternative);
    this.siftUp(this.deltas.length - 1);
  }

  pop(): { delta: number; cell: number; alternative: number } | null {
    if (this.deltas.length === 0) return null;
    const top = { delta: this.deltas[0], cell: this.cells[0], alternative: this.alternatives[0] };
    const lastIndex = this.deltas.length - 1;
    if (lastIndex > 0) {
      this.deltas[0] = this.deltas[lastIndex];
      this.cells[0] = this.cells[lastIndex];
      this.alternatives[0] = this.alternatives[lastIndex];
    }
    this.deltas.pop();
    this.cells.pop();
    this.alternatives.pop();
    if (this.deltas.length > 1) this.siftDown(0);
    return top;
  }

  private swap(a: number, b: number): void {
    [this.deltas[a], this.deltas[b]] = [this.deltas[b], this.deltas[a]];
    [this.cells[a], this.cells[b]] = [this.cells[b], this.cells[a]];
    [this.alternatives[a], this.alternatives[b]] = [this.alternatives[b], this.alternatives[a]];
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.deltas[parent] <= this.deltas[index]) break;
      this.swap(parent, index);
      index = parent;
    }
  }

  private siftDown(start: number): void {
    const length = this.deltas.length;
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < length && this.deltas[left] < this.deltas[smallest]) smallest = left;
      if (right < length && this.deltas[right] < this.deltas[smallest]) smallest = right;
      if (smallest === index) break;
      this.swap(index, smallest);
      index = smallest;
    }
  }
}

/**
 * Главная функция: приводит мозаику к наличным запасам деталей.
 * Исходное сопоставление не меняется — возвращается новое.
 */
export function applyPieceLimits({ averageGrid, mapping, palette, options = {} }: PieceLimitInput): PieceLimitResult {
  const started = now();

  const prepared = ensurePrepared(palette);
  const colorCount = prepared.colors.length;
  const cellCount = averageGrid.cells.length;

  const metric = options.metric ?? mapping.metric ?? DEFAULT_DISTANCE_METRIC;
  const distanceFn = getDistanceFn(metric);
  const weights = resolveWeights(options.weights);
  const maps = options.maps ?? null;
  const cellWeights = options.cellWeights ?? null;
  const maxIterations = options.maxIterations ?? colorCount * 4;

  const assignments = Uint16Array.from(mapping.assignments);
  const initialCounts = new Uint32Array(colorCount);
  const counts = new Uint32Array(colorCount);
  for (let i = 0; i < assignments.length; i++) {
    initialCounts[assignments[i]]++;
    counts[assignments[i]]++;
  }

  const available = new Float64Array(colorCount);
  let totalAvailable = 0;
  prepared.colors.forEach((color, index) => {
    available[index] = color.availableQuantity;
    totalAvailable += color.availableQuantity;
  });

  // Расстояния между цветами палитры — маленькая матрица, считается один раз.
  const colorToColor = new Float64Array(colorCount * colorCount);
  for (let a = 0; a < colorCount; a++) {
    for (let b = a + 1; b < colorCount; b++) {
      const value = distanceFn(prepared.colors[a].lab, prepared.colors[b].lab);
      colorToColor[a * colorCount + b] = value;
      colorToColor[b * colorCount + a] = value;
    }
  }

  // Расстояния «ячейка → цвет» считаются лениво: для большинства ячеек они не нужны.
  const cellToColor = new Float32Array(cellCount * colorCount);
  const cellReady = new Uint8Array(cellCount);
  const cellRow = (cell: number): number => {
    const offset = cell * colorCount;
    if (!cellReady[cell]) {
      const lab = rgbToLab(averageGrid.cells[cell].rgb);
      for (let c = 0; c < colorCount; c++) {
        cellToColor[offset + c] = distanceFn(lab, prepared.colors[c].lab);
      }
      cellReady[cell] = 1;
    }
    return offset;
  };

  const cols = averageGrid.cols;
  const rows = averageGrid.rows;

  /** Средняя ΔE между цветом-кандидатом и цветами соседей по текущим назначениям. */
  const neighborDistance = (cell: number, candidate: number): number => {
    const x = cell % cols;
    const y = (cell - x) / cols;
    let sum = 0;
    let count = 0;
    if (x > 0) {
      sum += colorToColor[candidate * colorCount + assignments[cell - 1]];
      count++;
    }
    if (x < cols - 1) {
      sum += colorToColor[candidate * colorCount + assignments[cell + 1]];
      count++;
    }
    if (y > 0) {
      sum += colorToColor[candidate * colorCount + assignments[cell - cols]];
      count++;
    }
    if (y < rows - 1) {
      sum += colorToColor[candidate * colorCount + assignments[cell + cols]];
      count++;
    }
    return count ? sum / count : 0;
  };

  const costOf = (cell: number, candidate: number, current: number): number => {
    const offset = cellRow(cell);
    return calculateReplacementCost({
      colorDistance: cellToColor[offset + candidate],
      currentDistance: colorToColor[current * colorCount + candidate],
      neighborDistance: neighborDistance(cell, candidate),
      edge: maps ? maps.edge[cell] : 0,
      structure: maps ? maps.structure[cell] : 0,
      weight: cellWeights ? cellWeights[cell] : 1,
      weights,
    }).total;
  };

  /** Лучшая альтернатива среди цветов, у которых остался запас. */
  const bestAlternative = (cell: number, current: number): { alternative: number; delta: number } | null => {
    const stay = costOf(cell, current, current);
    let bestIndex = -1;
    let bestCost = Number.POSITIVE_INFINITY;

    for (let c = 0; c < colorCount; c++) {
      if (c === current) continue;
      if (counts[c] >= available[c]) continue; // запас исчерпан
      const cost = costOf(cell, c, current);
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = c;
      }
    }

    return bestIndex === -1 ? null : { alternative: bestIndex, delta: bestCost - stay };
  };

  const feasible = totalAvailable >= cellCount;
  let moved = 0;
  let iterations = 0;

  if (feasible) {
    for (;;) {
      // Самый переполненный цвет — первым: он создаёт больше всего проблем.
      let target = -1;
      let worstExcess = 0;
      for (let c = 0; c < colorCount; c++) {
        const excess = counts[c] - available[c];
        if (excess > worstExcess) {
          worstExcess = excess;
          target = c;
        }
      }
      if (target === -1) break;

      iterations++;
      if (iterations > maxIterations) break;

      const heap = new CandidateHeap();
      for (let cell = 0; cell < cellCount; cell++) {
        if (assignments[cell] !== target) continue;
        const best = bestAlternative(cell, target);
        if (best) heap.push(best.delta, cell, best.alternative);
      }

      let excess = counts[target] - available[target];
      while (excess > 0) {
        const candidate = heap.pop();
        if (!candidate) break;
        if (assignments[candidate.cell] !== target) continue;

        // Пока кандидат ждал в очереди, выбранный цвет мог закончиться.
        if (counts[candidate.alternative] >= available[candidate.alternative]) {
          const refreshed = bestAlternative(candidate.cell, target);
          if (refreshed) heap.push(refreshed.delta, candidate.cell, refreshed.alternative);
          continue;
        }

        assignments[candidate.cell] = candidate.alternative;
        counts[target]--;
        counts[candidate.alternative]++;
        moved++;
        excess--;
      }

      options.onProgress?.(Math.min(1, iterations / Math.max(1, colorCount)));
      if (excess > 0) break; // свободных мест не осталось — дальше двигать некуда
    }
  }

  options.onProgress?.(1);

  // Собираем новую сетку и статистику.
  const cells: MosaicCell[] = new Array(cellCount);
  let errorAfter = 0;
  let errorBefore = 0;
  let maxDistance = 0;

  for (let i = 0; i < cellCount; i++) {
    const source = averageGrid.cells[i];
    const color = prepared.colors[assignments[i]];
    cells[i] = { x: source.x, y: source.y, rgb: [...color.rgb] as RGB, hex: color.hex };

    const offset = cellRow(i);
    const after = cellToColor[offset + assignments[i]];
    errorAfter += after;
    errorBefore += cellToColor[offset + mapping.assignments[i]];
    if (after > maxDistance) maxDistance = after;
  }

  const averageDistance = cellCount ? errorAfter / cellCount : 0;
  const requirements = summarizeRequirements(prepared, counts, initialCounts);

  return {
    mapping: {
      paletteId: prepared.id,
      metric,
      grid: { cols, rows, cells },
      assignments,
      usage: buildUsage(prepared, counts, cellCount),
      averageDistance,
      maxDistance,
    },
    requirements,
    feasible,
    satisfied: feasible && requirements.every((requirement) => requirement.status !== 'over'),
    moved,
    iterations,
    totalCells: cellCount,
    totalAvailable,
    addedError: cellCount ? (errorAfter - errorBefore) / cellCount : 0,
    durationMs: Math.round(now() - started),
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
