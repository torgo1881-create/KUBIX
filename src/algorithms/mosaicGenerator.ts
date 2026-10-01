import {
  DEFAULT_BACKGROUND,
  DEFAULT_CELL_SHAPE,
  DEFAULT_COLOR_SPACE,
  DEFAULT_GAP,
  DEFAULT_GRID_COLOR,
  MAX_SAMPLES_PER_CELL,
  MAX_SAMPLE_SIZE,
  TARGET_OUTPUT_SIZE,
} from '../config/mosaic';
import type { PaletteMapping } from '../types/palette';
import type {
  MosaicGrid,
  MosaicOptions,
  MosaicProgress,
  MosaicRenderOptions,
  MosaicResult,
} from '../types/mosaic';
import { computeMosaicCore, type MosaicCoreOptions } from './mosaicCore';
import { getMode, type MosaicMode, type MosaicModeId, type PreprocessSettings } from '../config/quality';

/**
 * Единственная ответственность модуля: собрать результат.
 * Он сэмплирует источник в рабочий canvas, зовёт gridAverage
 * и рисует итоговое изображение.
 */

export type MosaicSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export function getSourceSize(source: MosaicSource): { width: number; height: number } {
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  }
  return { width: source.width, height: source.height };
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function get2d(canvas: HTMLCanvasElement, alpha = true): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha, willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D недоступен в этом браузере');
  return ctx;
}

/**
 * Размер рабочего изображения. Всегда кратен числу ячеек, чтобы на каждую
 * ячейку приходилось ровно samplesPerCell × samplesPerCell пикселей —
 * усреднение получается честным, без краевого смещения.
 */
export function getSampleSize(
  cols: number,
  rows: number,
  sourceWidth: number,
  sourceHeight: number,
  maxSampleSize = MAX_SAMPLE_SIZE,
): { width: number; height: number; samplesPerCell: number } {
  const byBudget = Math.floor(maxSampleSize / Math.max(cols, rows));
  const bySource = Math.round(Math.min(sourceWidth / cols, sourceHeight / rows));
  const samplesPerCell = Math.max(
    1,
    Math.min(byBudget || 1, Math.max(1, bySource), MAX_SAMPLES_PER_CELL),
  );
  return {
    width: cols * samplesPerCell,
    height: rows * samplesPerCell,
    samplesPerCell,
  };
}

/** Рисует источник в рабочий canvas нужного размера и отдаёт пиксели. */
export function sampleImageData(
  source: MosaicSource,
  width: number,
  height: number,
  background = DEFAULT_BACKGROUND,
): ImageData {
  const canvas = createCanvas(width, height);
  const ctx = get2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Сторона ячейки в пикселях итогового изображения. */
export function getCellSize(cols: number, rows: number, targetOutputSize = TARGET_OUTPUT_SIZE): number {
  return Math.max(1, Math.floor(targetOutputSize / Math.max(cols, rows)));
}

/**
 * Отрисовка сетки в canvas. Тысячи DOM-элементов не создаются —
 * всё рисуется прямоугольниками в одном canvas.
 */
/**
 * Рисует одну деталь с объёмом: плоскость, круглый выступ, блик сверху-слева
 * и тень снизу-справа. Это только показ — сетка цветов не меняется.
 */
function drawBrick(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  hex: string,
): void {
  ctx.fillStyle = hex;
  ctx.fillRect(x, y, size, size);

  // Зазор между деталями: тень справа и снизу, светлая кромка сверху и слева.
  const seam = Math.max(1, size * 0.06);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.fillRect(x + size - seam, y, seam, size);
  ctx.fillRect(x, y + size - seam, size, seam);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.fillRect(x, y, size, seam * 0.7);
  ctx.fillRect(x, y, seam * 0.7, size);

  // Круглый выступ по центру со светом сверху-слева.
  const radius = size * 0.29;
  const cx = x + size / 2;
  const cy = y + size / 2;

  const shade = ctx.createRadialGradient(cx - radius * 0.4, cy - radius * 0.4, radius * 0.15, cx, cy, radius);
  shade.addColorStop(0, 'rgba(255, 255, 255, 0.30)');
  shade.addColorStop(0.55, 'rgba(255, 255, 255, 0.05)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.20)');

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = shade;
  ctx.fill();

  // Кромка выступа — тонкая тёмная окружность.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
  ctx.lineWidth = Math.max(0.5, size * 0.03);
  ctx.stroke();
}

export function renderMosaicToCanvas(
  grid: MosaicGrid,
  options: MosaicRenderOptions,
  target?: HTMLCanvasElement,
): HTMLCanvasElement {
  const cellSize = Math.max(1, Math.round(options.cellSize));
  const gap = Math.min(0.5, Math.max(0, options.gap ?? DEFAULT_GAP));
  const shape = options.shape ?? DEFAULT_CELL_SHAPE;
  const background = options.background ?? DEFAULT_BACKGROUND;

  const width = grid.cols * cellSize;
  const height = grid.rows * cellSize;

  const canvas = target ?? createCanvas(width, height);
  canvas.width = width;
  canvas.height = height;

  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const inset = (cellSize * gap) / 2;
  const size = cellSize - inset * 2;
  const radius = size / 2;

  for (const cell of grid.cells) {
    const px = cell.x * cellSize + inset;
    const py = cell.y * cellSize + inset;
    ctx.fillStyle = cell.hex;
    if (shape === 'brick') {
      drawBrick(ctx, px, py, size, cell.hex);
      continue;
    }

    if (shape === 'circle') {
      ctx.beginPath();
      ctx.arc(px + radius, py + radius, radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // +0.5 к размеру убирает светлые швы между ячейками при дробном масштабе
      ctx.fillRect(px, py, size + (gap === 0 ? 0.5 : 0), size + (gap === 0 ? 0.5 : 0));
    }
  }

  if (options.showGrid && cellSize >= 4) {
    ctx.strokeStyle = options.gridColor ?? DEFAULT_GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < grid.cols; x++) {
      ctx.moveTo(x * cellSize + 0.5, 0);
      ctx.lineTo(x * cellSize + 0.5, height);
    }
    for (let y = 1; y < grid.rows; y++) {
      ctx.moveTo(0, y * cellSize + 0.5);
      ctx.lineTo(width, y * cellSize + 0.5);
    }
    ctx.stroke();
  }

  return canvas;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export interface GenerateMosaicParams extends MosaicOptions {
  source: MosaicSource;
  /** Режим генерации: standard, portrait, highContrast, artistic. */
  mode?: MosaicModeId | MosaicMode;
  /** Точечные правки предобработки поверх режима: контраст, насыщенность, сглаживание. */
  preprocess?: Partial<PreprocessSettings>;
  /** Подтянуть тёмное лицо к комфортной яркости. */
  faceExposure?: boolean | number;
  /** Растянуть гистограмму. */
  levels?: boolean;
  /** Сила диффузии ошибки, 0..1. */
  dithering?: number;
  /** Приведение тона к целевому распределению по палитре, 0..1. */
  toneBalance?: number;
  /** Усиление глаз до усреднения. */
  eyeBoost?: MosaicCoreOptions['eyeBoost'];
  /** Локальный контраст внутри овала лица, 0..1. */
  faceVolume?: number;
  /** Локальный контраст по ячейкам сетки: штрих (fine) и объём (coarse). */
  gridDetail?: MosaicCoreOptions['gridDetail'];
  onProgress?: (progress: MosaicProgress) => void;
  /** Кооперативная отмена: проверяется между шагами ядра. */
  shouldCancel?: () => boolean;
  /** Переиспользуемый canvas, чтобы не плодить новые при regenerate. */
  target?: HTMLCanvasElement;
}

/**
 * Полный пайплайн: источник → рабочие пиксели → средние цвета → картинка.
 */
export async function generateMosaic(params: GenerateMosaicParams): Promise<MosaicResult> {
  const started = performance.now();
  const mode = typeof params.mode === 'object' ? params.mode : getMode(params.mode);
  const {
    source,
    cols,
    rows,
    // Режим задаёт значения по умолчанию, явные параметры их перекрывают.
    colorSpace = mode.colorSpace,
    maxSampleSize = MAX_SAMPLE_SIZE,
    targetOutputSize = TARGET_OUTPUT_SIZE,
    shape = mode.shape,
    gap = mode.gap,
    background = DEFAULT_BACKGROUND,
    showGrid = false,
    gridColor = DEFAULT_GRID_COLOR,
    palette,
    distanceMetric = mode.distanceMetric,
    enforcePieceLimits = false,
    costWeights = mode.costWeights,
    onProgress,
    target,
  } = params;

  const { width: srcW, height: srcH } = getSourceSize(source);
  if (!srcW || !srcH) throw new Error('Изображение ещё не загружено');

  onProgress?.({ stage: 'processing', value: 0.1, message: 'Читаю пиксели' });
  await nextFrame();

  const sample = getSampleSize(cols, rows, srcW, srcH, maxSampleSize);
  const sampled = sampleImageData(source, sample.width, sample.height, background);

  onProgress?.({ stage: 'processing', value: 0.4, message: 'Пиксели прочитаны' });
  await nextFrame();

  // Вся тяжёлая математика живёт в чистом ядре — том же, что крутится в Web Worker.
  const core = computeMosaicCore(sampled, {
    cols,
    rows,
    mode,
    colorSpace,
    distanceMetric,
    palette,
    enforcePieceLimits,
    costWeights,
    preprocess: params.preprocess,
    faceExposure: params.faceExposure,
    levels: params.levels,
    dithering: params.dithering,
    toneBalance: params.toneBalance,
    eyeBoost: params.eyeBoost,
    faceVolume: params.faceVolume,
    gridDetail: params.gridDetail,
    sampleWidth: sample.width,
    sampleHeight: sample.height,
    onProgress,
    shouldCancel: params.shouldCancel,
  });

  const { averageGrid, faces, weightMap } = core;
  const mapping = core.mapping;
  const pieceLimit = core.pieceLimit;

  const grid = mapping?.grid ?? averageGrid;

  onProgress?.({ stage: 'generating', value: 0.85, message: 'Рисую мозаику' });
  await nextFrame();

  const cellSize = getCellSize(cols, rows, targetOutputSize);
  const canvas = renderMosaicToCanvas(
    grid,
    { cellSize, shape, gap, background, showGrid, gridColor },
    target,
  );

  onProgress?.({ stage: 'done', value: 1, message: 'Готово' });

  return {
    grid,
    averageGrid,
    palette: mapping,
    pieceLimit,
    mode: mode.id,
    faces,
    weightMap,
    canvas,
    width: canvas.width,
    height: canvas.height,
    cellSize,
    sampleWidth: sample.width,
    sampleHeight: sample.height,
    options: {
      cols,
      rows,
      colorSpace,
      maxSampleSize,
      targetOutputSize,
      shape,
      gap,
      background,
      showGrid,
      gridColor,
      palette,
      distanceMetric,
      enforcePieceLimits,
      costWeights,
    },
    durationMs: Math.round(performance.now() - started),
    createdAt: Date.now(),
  };
}

/** Сетка в JSON — тот самый массив ячеек { x, y, rgb, hex }. */
export function gridToJson(grid: MosaicGrid): string {
  return JSON.stringify(grid.cells, null, 2);
}
