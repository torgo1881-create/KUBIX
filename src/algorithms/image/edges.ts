import type { ImageDataLike, MosaicGrid } from '../../types/mosaic';

/**
 * Поиск границ и «детальности» изображения.
 *
 * Нужен оптимизатору количества деталей: замена цвета на контуре глаза или на
 * границе объекта разрушает картинку сильнее, чем такая же замена внутри
 * ровной заливки. Поэтому обе карты считаются заранее и попадают в стоимость
 * замены как edgePenalty и structuralPenalty.
 */

/** Карты по ячейкам сетки, значения 0..1. */
export interface CellMaps {
  cols: number;
  rows: number;
  /** Сила границы: контуры лица, глаз, рта, предметов. */
  edge: Float32Array;
  /** Детальность: разброс яркости внутри ячейки (текстура, мелкие элементы). */
  structure: Float32Array;
}

export interface EdgeOptions {
  /** Сгладить перед Sobel — меньше реакции на шум. По умолчанию true. */
  blur?: boolean;
  /**
   * Подавление немаксимумов (первый шаг Canny): контуры становятся тонкими,
   * а не размазанными полосами. По умолчанию true.
   */
  thin?: boolean;
  /** Перцентиль для нормировки, чтобы одиночный выброс не «съел» шкалу. */
  normalizePercentile?: number;
}

/** Яркость по Rec. 709. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Массив яркостей изображения. */
export function toLumaPlane(image: ImageDataLike): Float32Array {
  const { width, height, data } = image;
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = luminance(data[p], data[p + 1], data[p + 2]);
  }
  return luma;
}

/** Усредняющее размытие 3×3. */
export function blur3x3(source: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          sum += source[sy * width + sx];
          count++;
        }
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

export interface SobelResult {
  magnitude: Float32Array;
  /** Направление градиента в радианах, -π..π. */
  direction: Float32Array;
}

/** Оператор Собеля: |∇| и направление градиента. */
export function sobel(source: Float32Array, width: number, height: number): SobelResult {
  const magnitude = new Float32Array(source.length);
  const direction = new Float32Array(source.length);

  const at = (x: number, y: number) => {
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
    return source[cy * width + cx];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = at(x - 1, y - 1);
      const tc = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const ml = at(x - 1, y);
      const mr = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const bc = at(x, y + 1);
      const br = at(x + 1, y + 1);

      const gx = tl + 2 * ml + bl - (tr + 2 * mr + br);
      const gy = tl + 2 * tc + tr - (bl + 2 * bc + br);

      const index = y * width + x;
      magnitude[index] = Math.hypot(gx, gy);
      direction[index] = Math.atan2(gy, gx);
    }
  }

  return { magnitude, direction };
}

/**
 * Подавление немаксимумов вдоль градиента — контур в один пиксель толщиной.
 * Это первый шаг Canny; порогов с гистерезисом здесь нет намеренно:
 * оптимизатору нужна непрерывная величина, а не бинарная маска.
 */
export function thinEdges(
  magnitude: Float32Array,
  direction: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(magnitude.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const value = magnitude[index];
      if (value === 0) continue;

      // Округляем направление до одного из четырёх секторов.
      let angle = ((direction[index] * 180) / Math.PI + 180) % 180;
      let dx = 1;
      let dy = 0;
      if (angle >= 22.5 && angle < 67.5) {
        dx = 1;
        dy = 1;
      } else if (angle >= 67.5 && angle < 112.5) {
        dx = 0;
        dy = 1;
      } else if (angle >= 112.5 && angle < 157.5) {
        dx = -1;
        dy = 1;
      }

      const before = sample(magnitude, width, height, x - dx, y - dy);
      const after = sample(magnitude, width, height, x + dx, y + dy);
      out[index] = value >= before && value >= after ? value : value * 0.35;
    }
  }

  return out;
}

function sample(source: Float32Array, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return source[y * width + x];
}

/** Делит значения на перцентиль и обрезает в 0..1. */
export function normalizeInPlace(values: Float32Array, percentile = 0.98): Float32Array {
  if (values.length === 0) return values;
  const sorted = Float32Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(percentile * (sorted.length - 1))));
  const scale = sorted[index];
  if (scale <= 0) return values;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] / scale;
    values[i] = v > 1 ? 1 : v;
  }
  return values;
}

/**
 * Основная функция: из пикселей источника получаем карты границ и детальности
 * в разрешении сетки мозаики.
 */
export function computeCellMaps(
  image: ImageDataLike,
  cols: number,
  rows: number,
  options: EdgeOptions = {},
): CellMaps {
  const { width, height } = image;
  const { blur = true, thin = true, normalizePercentile = 0.98 } = options;

  const luma = toLumaPlane(image);
  const prepared = blur ? blur3x3(luma, width, height) : luma;
  const { magnitude, direction } = sobel(prepared, width, height);
  const edges = thin ? thinEdges(magnitude, direction, width, height) : magnitude;

  const edge = new Float32Array(cols * rows);
  const structure = new Float32Array(cols * rows);

  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor((gy * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / rows));

    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / cols));

      let edgeSum = 0;
      let edgeMax = 0;
      let lumaSum = 0;
      let lumaSquares = 0;
      let count = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const index = y * width + x;
          const value = edges[index];
          edgeSum += value;
          if (value > edgeMax) edgeMax = value;
          const l = luma[index];
          lumaSum += l;
          lumaSquares += l * l;
          count++;
        }
      }

      const cell = gy * cols + gx;
      // Максимум ловит тонкий контур внутри ячейки, среднее — общую активность.
      edge[cell] = count ? 0.65 * edgeMax + 0.35 * (edgeSum / count) : 0;
      const mean = count ? lumaSum / count : 0;
      const variance = count ? Math.max(0, lumaSquares / count - mean * mean) : 0;
      structure[cell] = Math.sqrt(variance);
    }
  }

  normalizeInPlace(edge, normalizePercentile);
  normalizeInPlace(structure, normalizePercentile);

  return { cols, rows, edge, structure };
}

/**
 * Запасной вариант: карты считаются по самой сетке, если пикселей источника
 * под рукой нет. Точность ниже, зато работает от одной готовой мозаики.
 */
export function computeGridCellMaps(grid: MosaicGrid, options: EdgeOptions = {}): CellMaps {
  const { cols, rows } = grid;
  const luma = new Float32Array(cols * rows);
  for (let i = 0; i < grid.cells.length; i++) {
    const [r, g, b] = grid.cells[i].rgb;
    luma[i] = luminance(r, g, b);
  }

  const { blur = false, thin = false, normalizePercentile = 0.98 } = options;
  const prepared = blur ? blur3x3(luma, cols, rows) : luma;
  const { magnitude, direction } = sobel(prepared, cols, rows);
  const edge = Float32Array.from(thin ? thinEdges(magnitude, direction, cols, rows) : magnitude);

  const structure = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const index = y * cols + x;
      let sum = 0;
      let squares = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const l = luma[ny * cols + nx];
          sum += l;
          squares += l * l;
          count++;
        }
      }
      const mean = sum / count;
      structure[index] = Math.sqrt(Math.max(0, squares / count - mean * mean));
    }
  }

  normalizeInPlace(edge, normalizePercentile);
  normalizeInPlace(structure, normalizePercentile);

  return { cols, rows, edge, structure };
}
