import type {
  GridAverageOptions,
  ImageDataLike,
  MosaicCell,
  MosaicGrid,
  RGB,
} from '../types/mosaic';

/**
 * Единственная ответственность модуля: получить сетку СРЕДНИХ цветов.
 * Никакого рендера, никакого DOM, никакого React — только числа.
 *
 * Ключевая идея: для ячейки (gx, gy) берётся ВСЯ соответствующая область
 * исходного изображения и усредняется попиксельно. Центральный пиксель
 * не используется никогда.
 */

const WHITE: RGB = [255, 255, 255];

export function clampByte(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

/** [120, 80, 60] -> "#78503C" */
export function rgbToHex(rgb: RGB): string {
  const r = Math.round(clampByte(rgb[0]));
  const g = Math.round(clampByte(rgb[1]));
  const b = Math.round(clampByte(rgb[2]));
  return (
    '#' +
    r.toString(16).padStart(2, '0') +
    g.toString(16).padStart(2, '0') +
    b.toString(16).padStart(2, '0')
  ).toUpperCase();
}

export function hexToRgb(hex: string): RGB {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

/** Таблица sRGB -> линейный свет (строится один раз). */
const SRGB_TO_LINEAR = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return table;
})();

function linearToSrgbByte(value: number): number {
  const v = value <= 0 ? 0 : value >= 1 ? 1 : value;
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

/**
 * Границы ячейки по одной оси. Использует floor от точной доли, поэтому
 * области соседних ячеек не пересекаются и покрывают изображение целиком.
 */
export function cellBounds(index: number, count: number, size: number): [number, number] {
  const start = Math.floor((index * size) / count);
  const end = Math.floor(((index + 1) * size) / count);
  return [start, Math.max(start + 1, end)];
}

/**
 * Главная функция модуля.
 *
 * @param image  пиксели источника (реальный ImageData или совместимый объект)
 * @param options cols/rows и параметры усреднения
 * @returns сетка ячеек { x, y, rgb, hex } в row-major порядке
 */
export function computeAverageGrid(image: ImageDataLike, options: GridAverageOptions): MosaicGrid {
  const cols = Math.floor(options.cols);
  const rows = Math.floor(options.rows);

  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
    throw new Error(`gridAverage: некорректный размер сетки ${options.cols}×${options.rows}`);
  }
  const { width, height, data } = image;
  if (width < 1 || height < 1) {
    throw new Error('gridAverage: пустое изображение');
  }
  if (data.length < width * height * 4) {
    throw new Error('gridAverage: длина data не соответствует width × height × 4');
  }

  const linear = options.colorSpace === 'linear';
  const bg = options.background ?? WHITE;
  const bgR = linear ? SRGB_TO_LINEAR[clampByte(Math.round(bg[0]))] : bg[0];
  const bgG = linear ? SRGB_TO_LINEAR[clampByte(Math.round(bg[1]))] : bg[1];
  const bgB = linear ? SRGB_TO_LINEAR[clampByte(Math.round(bg[2]))] : bg[2];

  const cells: MosaicCell[] = new Array(cols * rows);

  for (let gy = 0; gy < rows; gy++) {
    const [y0, y1] = cellBounds(gy, rows, height);

    for (let gx = 0; gx < cols; gx++) {
      const [x0, x1] = cellBounds(gx, cols, width);

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;

      for (let y = y0; y < y1; y++) {
        let idx = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const a = data[idx + 3];

          if (linear) {
            const lr = SRGB_TO_LINEAR[r];
            const lg = SRGB_TO_LINEAR[g];
            const lb = SRGB_TO_LINEAR[b];
            if (a === 255) {
              sumR += lr;
              sumG += lg;
              sumB += lb;
            } else {
              // композитим пиксель поверх подложки
              const alpha = a / 255;
              const inv = 1 - alpha;
              sumR += lr * alpha + bgR * inv;
              sumG += lg * alpha + bgG * inv;
              sumB += lb * alpha + bgB * inv;
            }
          } else if (a === 255) {
            sumR += r;
            sumG += g;
            sumB += b;
          } else {
            const alpha = a / 255;
            const inv = 1 - alpha;
            sumR += r * alpha + bgR * inv;
            sumG += g * alpha + bgG * inv;
            sumB += b * alpha + bgB * inv;
          }
          count++;
        }
      }

      let rgb: RGB;
      if (count === 0) {
        rgb = [Math.round(bg[0]), Math.round(bg[1]), Math.round(bg[2])];
      } else if (linear) {
        rgb = [
          linearToSrgbByte(sumR / count),
          linearToSrgbByte(sumG / count),
          linearToSrgbByte(sumB / count),
        ];
      } else {
        rgb = [
          Math.round(clampByte(sumR / count)),
          Math.round(clampByte(sumG / count)),
          Math.round(clampByte(sumB / count)),
        ];
      }

      cells[gy * cols + gx] = { x: gx, y: gy, rgb, hex: rgbToHex(rgb) };
    }

    options.onProgress?.((gy + 1) / rows);
  }

  return { cols, rows, cells };
}

/** Быстрый доступ к ячейке по координатам сетки. */
export function getCell(grid: MosaicGrid, x: number, y: number): MosaicCell | undefined {
  if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return undefined;
  return grid.cells[y * grid.cols + x];
}

/**
 * Топ-N цветов сетки по частоте (цвета квантуются, чтобы близкие оттенки
 * не размазывались по разным корзинам). Используется для палитры в UI.
 */
export function extractPalette(grid: MosaicGrid, limit = 6, quantStep = 24): MosaicCell[] {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();

  for (const cell of grid.cells) {
    const key =
      Math.round(cell.rgb[0] / quantStep) +
      ':' +
      Math.round(cell.rgb[1] / quantStep) +
      ':' +
      Math.round(cell.rgb[2] / quantStep);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++;
      bucket.r += cell.rgb[0];
      bucket.g += cell.rgb[1];
      bucket.b += cell.rgb[2];
    } else {
      buckets.set(key, { count: 1, r: cell.rgb[0], g: cell.rgb[1], b: cell.rgb[2] });
    }
  }

  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((bucket) => {
      const rgb: RGB = [
        Math.round(bucket.r / bucket.count),
        Math.round(bucket.g / bucket.count),
        Math.round(bucket.b / bucket.count),
      ];
      return { x: -1, y: -1, rgb, hex: rgbToHex(rgb) };
    });
}
