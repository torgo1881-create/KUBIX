import type { FaceRegions } from '../algorithms/face/faceRegions';
import type { CostWeights } from '../algorithms/optimization/costFunction';
import type { WeightMap } from '../algorithms/optimization/weightMap';
import type { MosaicModeId } from '../config/quality';
import type { PieceLimitResult } from '../algorithms/optimization/pieceLimit';
import type {
  ColorDistanceMetric,
  Palette,
  PaletteColor,
  PaletteMapping,
  PreparedPalette,
} from './palette';

/**
 * Домейн-типы фотомозаики.
 * Здесь нет ни DOM-, ни React-зависимостей, кроме тех, что реально нужны
 * для описания результата рендера (HTMLCanvasElement).
 */

/** [r, g, b], каждый канал 0..255 */
export type RGB = [number, number, number];

/**
 * Одна ячейка мозаики.
 * x / y — координаты в сетке (не в пикселях): 0..cols-1 и 0..rows-1.
 */
export interface MosaicCell {
  x: number;
  y: number;
  rgb: RGB;
  hex: string;
}

/** Результат усреднения: сетка cols×rows со списком ячеек в row-major порядке. */
export interface MosaicGrid {
  cols: number;
  rows: number;
  cells: MosaicCell[];
}

/**
 * Минимальный контракт ImageData.
 * Совместим с настоящим ImageData браузера, но позволяет тестировать
 * алгоритм в Node без DOM.
 */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array | number[];
}

/** В каком пространстве усреднять цвета. */
export type ColorSpaceMode = 'srgb' | 'linear';

export interface GridAverageOptions {
  cols: number;
  rows: number;
  /**
   * 'srgb'   — простое арифметическое среднее по байтам (быстро, привычно);
   * 'linear' — усреднение в линейном свете (физически корректнее, мягче артефакты).
   */
  colorSpace?: ColorSpaceMode;
  /** Цвет подложки для полупрозрачных пикселей. По умолчанию белый. */
  background?: RGB;
  /** Прогресс усреднения, 0..1. Вызывается построчно по сетке. */
  onProgress?: (progress: number) => void;
}

/** Форма ячейки при отрисовке. */
export type CellShape = 'square' | 'circle' | 'brick';

export interface MosaicRenderOptions {
  /** Сторона ячейки в пикселях итогового canvas. */
  cellSize: number;
  shape?: CellShape;
  /** Отступ между ячейками в долях cellSize: 0 — без зазора, 0.2 — 20%. */
  gap?: number;
  /** Цвет фона итогового изображения. */
  background?: string;
  /** Тонкая сетка поверх ячеек. */
  showGrid?: boolean;
  gridColor?: string;
}

export interface MosaicOptions {
  cols: number;
  rows: number;
  colorSpace?: ColorSpaceMode;
  /**
   * Палитра физических деталей. Если задана, каждая ячейка получает
   * ближайший цвет палитры вместо усреднённого.
   */
  palette?: Palette | PaletteColor[] | PreparedPalette;
  /** Метрика перцептивного расстояния при сопоставлении с палитрой. */
  distanceMetric?: ColorDistanceMetric;
  /** Учитывать availableQuantity: перекрашивать лишние ячейки в доступные цвета. */
  enforcePieceLimits?: boolean;
  /** Веса штрафов оптимизатора (структура, границы, связность). */
  costWeights?: Partial<CostWeights>;
  /** Максимальная сторона рабочего (сэмплируемого) изображения в пикселях. */
  maxSampleSize?: number;
  /** Желаемая максимальная сторона итогового PNG. */
  targetOutputSize?: number;
  shape?: CellShape;
  gap?: number;
  background?: string;
  showGrid?: boolean;
  gridColor?: string;
}

/** Этапы пайплайна — используются и в UI-прогрессе. */
export type MosaicStage = 'idle' | 'loading' | 'processing' | 'generating' | 'done' | 'error';

export interface MosaicProgress {
  stage: MosaicStage;
  /** 0..1 внутри текущего этапа. */
  value: number;
  message?: string;
}

export interface MosaicResult {
  /** Сетка, которая нарисована: цвета палитры, если она задана, иначе средние. */
  grid: MosaicGrid;
  /** Средние цвета до сопоставления с палитрой. */
  averageGrid: MosaicGrid;
  /** Результат сопоставления с палитрой — есть только когда палитра задана. */
  palette?: PaletteMapping;
  /** Результат учёта запасов деталей — есть только когда включены лимиты. */
  pieceLimit?: PieceLimitResult;
  /** Режим генерации, которым получен результат. */
  mode: MosaicModeId;
  /** Найденные лица с областями. Пустой массив — лиц нет или поиск выключен. */
  faces: FaceRegions[];
  /** Карта важности ячеек. */
  weightMap: WeightMap;
  /** Готовое изображение мозаики. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  cellSize: number;
  /** Размер рабочего изображения, по которому считались средние. */
  sampleWidth: number;
  sampleHeight: number;
  options: Required<Pick<MosaicOptions, 'cols' | 'rows'>> & MosaicOptions;
  /** Сколько миллисекунд заняла генерация. */
  durationMs: number;
  createdAt: number;
}

/** Прямоугольник кадрирования в координатах исходного изображения. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceImage {
  file: File;
  /** objectURL, нужно освобождать через URL.revokeObjectURL. Пусто, если уже освобождён. */
  url: string;
  /** Картинка либо canvas — если исходник пришлось уменьшить. */
  element: HTMLImageElement | HTMLCanvasElement;
  width: number;
  height: number;
  sizeBytes: number;
  type: string;
  name: string;
  /** Исходные размеры, если снимок был уменьшен под лимиты. */
  downscaledFrom?: { width: number; height: number };
}
