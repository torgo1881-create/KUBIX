import { luminance, type CellMaps } from '../image/edges';
import { labChroma, rgbToLab } from '../color/lab';
import type { MosaicGrid } from '../../types/mosaic';

/**
 * Область главного объекта — замена маске лица, когда лица нет.
 *
 * C9 из этапа 10 умел править тон только внутри найденного лица. На
 * животных, предметах и неудачных ракурсах он просто выключался. Здесь
 * область интереса ищется без детектора: по тому, где в кадре сосредоточены
 * детали, контраст и необычный для этого снимка цвет.
 *
 * Это не семантическая сегментация и не претендует на неё. Задача скромнее:
 * отделить «то, ради чего снимали» от фона, чтобы тональную коррекцию можно
 * было ограничить объектом.
 */

export interface SubjectRegion {
  /** Маска в разрешении сетки: 1 — объект. */
  mask: Uint8Array;
  /** Доля кадра, занятая объектом. */
  coverage: number;
  /**
   * Насколько выражен объект: отношение средней заметности внутри маски к
   * средней снаружи. Около 1 — объекта фактически нет, кадр однородный.
   */
  contrastRatio: number;
  /** Уверенность 0..1: годится ли маска для тональной коррекции. */
  confidence: number;
  source: 'saliency';
}

export interface SubjectOptions {
  /** Какую долю кадра максимум считать объектом. */
  maxCoverage?: number;
  /** Минимальная доля, ниже которой маска бессмысленна. */
  minCoverage?: number;
  /** Вес центральной подсказки: объект съёмки обычно ближе к центру. */
  centerBias?: number;
}

const DEFAULTS: Required<SubjectOptions> = {
  maxCoverage: 0.55,
  minCoverage: 0.06,
  centerBias: 0.35,
};

/**
 * Карта заметности по сетке.
 *
 * Три слагаемых, все считаются по уже готовым данным:
 *   - структура и границы (объект детальнее фона);
 *   - отличие цвета ячейки от среднего цвета кадра;
 *   - центральная подсказка.
 */
export function saliencyMap(grid: MosaicGrid, maps: CellMaps | null, options: SubjectOptions = {}): Float32Array {
  const settings = { ...DEFAULTS, ...options };
  const { cols, rows } = grid;
  const total = grid.cells.length;
  const saliency = new Float32Array(total);

  // Средний цвет кадра — точка отсчёта для «необычности».
  let meanL = 0;
  let meanA = 0;
  let meanB = 0;
  const labs = grid.cells.map((cell) => rgbToLab(cell.rgb));
  for (const lab of labs) {
    meanL += lab.L;
    meanA += lab.a;
    meanB += lab.b;
  }
  meanL /= total;
  meanA /= total;
  meanB /= total;

  let maxColorDistance = 1e-6;
  const colorDistance = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const lab = labs[i];
    // Хроматическое отличие весомее, чем разница по светлоте: тень на стене
    // не должна выглядеть объектом.
    const distance =
      Math.abs(lab.L - meanL) * 0.5 + Math.hypot(lab.a - meanA, lab.b - meanB) * 1.2 + labChroma(lab) * 0.35;
    colorDistance[i] = distance;
    if (distance > maxColorDistance) maxColorDistance = distance;
  }

  const centerX = (cols - 1) / 2;
  const centerY = (rows - 1) / 2;
  const maxRadius = Math.hypot(centerX, centerY) || 1;

  for (let i = 0; i < total; i++) {
    const x = i % cols;
    const y = (i - x) / cols;

    const structure = maps ? 0.6 * maps.edge[i] + 0.4 * maps.structure[i] : 0;
    const distinct = colorDistance[i] / maxColorDistance;
    const center = 1 - Math.hypot(x - centerX, y - centerY) / maxRadius;

    saliency[i] = 0.45 * structure + 0.4 * distinct + settings.centerBias * center;
  }

  return blur(saliency, cols, rows, 2);
}

/** Мягкое усреднение: заметность должна быть областью, а не отдельными точками. */
function blur(values: Float32Array, cols: number, rows: number, radius: number): Float32Array {
  const out = new Float32Array(values.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          sum += values[ny * cols + nx];
          count++;
        }
      }
      out[y * cols + x] = sum / count;
    }
  }
  return out;
}

/**
 * Область объекта: берём самые заметные ячейки, оставляем крупнейший
 * связный кусок и слегка расширяем его.
 */
export function detectSubjectRegion(
  grid: MosaicGrid,
  maps: CellMaps | null,
  options: SubjectOptions = {},
): SubjectRegion {
  const settings = { ...DEFAULTS, ...options };
  const { cols, rows } = grid;
  const total = grid.cells.length;
  const saliency = saliencyMap(grid, maps, settings);

  // Порог — по перцентилю: доля объекта задаётся, а не гадается.
  const sorted = Float32Array.from(saliency).sort();
  const threshold = sorted[Math.floor((1 - settings.maxCoverage) * (total - 1))];

  const seed = new Uint8Array(total);
  for (let i = 0; i < total; i++) seed[i] = saliency[i] >= threshold ? 1 : 0;

  // Крупнейшая связная область — объект, остальное отбрасываем.
  const mask = largestComponent(seed, cols, rows);
  const dilated = dilate(mask, cols, rows);

  let inside = 0;
  let insideSum = 0;
  let outsideSum = 0;
  for (let i = 0; i < total; i++) {
    if (dilated[i]) {
      inside++;
      insideSum += saliency[i];
    } else {
      outsideSum += saliency[i];
    }
  }

  const coverage = inside / total;
  const meanInside = inside ? insideSum / inside : 0;
  const meanOutside = total - inside ? outsideSum / (total - inside) : 0;
  const contrastRatio = meanOutside > 0 ? meanInside / meanOutside : 0;

  // Уверенность: объект должен быть и заметным, и разумного размера.
  const separation = Math.max(0, Math.min(1, (contrastRatio - 1) / 0.6));
  const sizeFit =
    coverage < settings.minCoverage
      ? 0
      : coverage > settings.maxCoverage
        ? 0.4
        : Math.min(1, (coverage - settings.minCoverage) / 0.15);

  return {
    mask: dilated,
    coverage: Math.round(coverage * 1000) / 1000,
    contrastRatio: Math.round(contrastRatio * 100) / 100,
    confidence: Math.round(separation * sizeFit * 100) / 100,
    source: 'saliency',
  };
}

function largestComponent(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const seen = new Uint8Array(mask.length);
  let best: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    const component: number[] = [];
    seen[start] = 1;

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
        if (mask[neighbor] && !seen[neighbor]) {
          seen[neighbor] = 1;
          stack.push(neighbor);
        }
      }
    }

    if (component.length > best.length) best = component;
  }

  const out = new Uint8Array(mask.length);
  for (const cell of best) out[cell] = 1;
  return out;
}

function dilate(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = Uint8Array.from(mask);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!mask[y * cols + x]) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        out[ny * cols + nx] = 1;
      }
    }
  }
  return out;
}

/**
 * Динамический диапазон кадра относительно шага палитры.
 *
 * Если весь снимок укладывается в один-два шага лестницы, никакая
 * коррекция тона внутри объекта не спасёт: разделять просто нечего.
 * Эта величина объясняет провал на низкоконтрастных фотографиях.
 */
export function dynamicRangeRatio(grid: MosaicGrid, paletteLadder: number[]): number {
  let min = 255;
  let max = 0;
  for (const cell of grid.cells) {
    const value = luminance(cell.rgb[0], cell.rgb[1], cell.rgb[2]);
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const steps: number[] = [];
  for (let i = 1; i < paletteLadder.length; i++) steps.push(paletteLadder[i] - paletteLadder[i - 1]);
  const medianStep = steps.length ? steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 1;

  return medianStep > 0 ? Math.round(((max - min) / medianStep) * 100) / 100 : 0;
}
