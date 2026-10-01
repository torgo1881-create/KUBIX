import type { ColorSpaceMode } from '../types/mosaic';
import type { ColorDistanceMetric } from '../types/palette';

/**
 * Веса важности участков и режимы генерации.
 * Всё, что можно крутить, лежит здесь — алгоритмы читают конфиг, а не наоборот.
 */

export interface RegionWeights {
  /** Обычная область. */
  base: number;
  /** Овал лица. */
  face: number;
  /** Глаза. */
  eyes: number;
  /** Рот. */
  mouth: number;
  /** Контур лица. */
  contour: number;
  /** Волосы. */
  hair: number;
  /** Границы объектов (по карте Собеля). */
  edge: number;
}

export const REGION_WEIGHTS: RegionWeights = {
  base: 1,
  face: 1.5,
  eyes: 2.5,
  mouth: 2,
  contour: 2,
  hair: 1.6,
  edge: 2,
};

/** Максимальный вес, чтобы одна ячейка не перевесила всё остальное. */
export const MAX_REGION_WEIGHT = 3;

export interface PreprocessSettings {
  /** Контраст: 1 — без изменений. */
  contrast: number;
  /** Насыщенность: 1 — без изменений. */
  saturation: number;
  /** Нерезкая маска: 0 — выключена, 0.5 — заметная. */
  sharpen: number;
  /** Автоматическое растягивание гистограммы по перцентилям. */
  autoLevels: boolean;
  /** Сглаживание перед усреднением: 0 — выключено, 0.35 — заметное. */
  smooth: number;
}

export type MosaicModeId = 'standard' | 'portrait' | 'highContrast' | 'artistic';

export interface MosaicMode {
  id: MosaicModeId;
  label: string;
  description: string;
  /** Искать ли лица и строить ли карту весов. */
  faceDetection: boolean;
  colorSpace: ColorSpaceMode;
  distanceMetric: ColorDistanceMetric;
  shape: 'square' | 'circle';
  gap: number;
  preprocess: PreprocessSettings;
  /** Веса штрафов в функции стоимости. */
  costWeights: { color: number; structure: number; edge: number; cohesion: number };
  /** Множители к весам областей: режим может усилить или ослабить защиту лица. */
  regionScale: Partial<Record<keyof RegionWeights, number>>;
}

const NO_PREPROCESS: PreprocessSettings = {
  contrast: 1,
  saturation: 1,
  sharpen: 0,
  autoLevels: false,
  smooth: 0,
};

/**
 * Режимы отличаются параметрами алгоритма, а не фильтрами поверх картинки:
 * другая предобработка пикселей, другое пространство усреднения, другая
 * метрика близости, другие веса в функции стоимости и другая форма ячеек.
 */
export const MOSAIC_MODES: Record<MosaicModeId, MosaicMode> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    description: 'Ровное усреднение без предобработки. Базовая точность цвета.',
    faceDetection: false,
    colorSpace: 'srgb',
    distanceMetric: 'ciede2000',
    shape: 'square',
    gap: 0,
    preprocess: NO_PREPROCESS,
    costWeights: { color: 1, structure: 0.6, edge: 1.5, cohesion: 0.25 },
    regionScale: {},
  },

  portrait: {
    id: 'portrait',
    label: 'Portrait',
    description:
      'Ищет лицо, защищает глаза, рот и контуры. Лёгкая нерезкая маска возвращает чертам резкость, потерянную при усреднении.',
    faceDetection: true,
    colorSpace: 'srgb',
    distanceMetric: 'ciede2000',
    shape: 'square',
    gap: 0,
    preprocess: { contrast: 1.08, saturation: 0.96, sharpen: 0.45, autoLevels: false, smooth: 0 },
    costWeights: { color: 1, structure: 0.9, edge: 2.2, cohesion: 0.15 },
    regionScale: { eyes: 1.15, mouth: 1.1, contour: 1.1 },
  },

  highContrast: {
    id: 'highContrast',
    label: 'High Contrast',
    description:
      'Растягивает гистограмму и усиливает контраст до усреднения: черты читаются издалека, полутона огрубляются.',
    faceDetection: true,
    colorSpace: 'linear',
    distanceMetric: 'ciede2000',
    shape: 'square',
    gap: 0,
    preprocess: { contrast: 1.55, saturation: 1.12, sharpen: 0.25, autoLevels: true, smooth: 0 },
    costWeights: { color: 1.15, structure: 0.5, edge: 2.6, cohesion: 0.1 },
    regionScale: { edge: 1.2, contour: 1.15 },
  },

  artistic: {
    id: 'artistic',
    label: 'Artistic',
    description:
      'Круглые ячейки с зазором, усреднение в линейном свете и повышенная связность соседей: крупные плоские пятна вместо мелкой ряби.',
    faceDetection: false,
    colorSpace: 'linear',
    distanceMetric: 'cie94',
    shape: 'circle',
    gap: 0.16,
    preprocess: { contrast: 1.12, saturation: 1.3, sharpen: 0, autoLevels: false, smooth: 0.35 },
    costWeights: { color: 0.85, structure: 0.35, edge: 0.9, cohesion: 0.7 },
    regionScale: { face: 1.1 },
  },
};

export const MOSAIC_MODE_IDS: MosaicModeId[] = ['standard', 'portrait', 'highContrast', 'artistic'];
export const DEFAULT_MODE_ID: MosaicModeId = 'standard';

/** Режимы, которые сравниваются в A/B-превью рядом с оригиналом. */
export const AB_PREVIEW_MODES: MosaicModeId[] = ['standard', 'portrait', 'highContrast'];

export function getMode(id: MosaicModeId | string | null | undefined): MosaicMode {
  return MOSAIC_MODES[(id ?? DEFAULT_MODE_ID) as MosaicModeId] ?? MOSAIC_MODES[DEFAULT_MODE_ID];
}

/** Веса областей с учётом множителей режима. */
export function getRegionWeights(mode: MosaicMode, overrides?: Partial<RegionWeights>): RegionWeights {
  const scaled = { ...REGION_WEIGHTS };
  for (const key of Object.keys(scaled) as (keyof RegionWeights)[]) {
    const scale = mode.regionScale[key];
    if (scale) scaled[key] = Math.min(MAX_REGION_WEIGHT, scaled[key] * scale);
  }
  return { ...scaled, ...overrides };
}
