import type { ColorDistanceMetric } from '../types/palette';

/**
 * Параметры экспериментов этапа 9B.
 *
 * Ничего из этого пока не участвует в production: конфигурация нужна, чтобы
 * варианты алгоритма можно было сравнивать, меняя числа в одном месте.
 */

/* ------------------------------------------------ взвешенное расстояние */

export interface PerceptualWeights {
  /** Вес разницы по светлоте. */
  lightness: number;
  /** Вес разницы по насыщенности. */
  chroma: number;
  /** Вес разницы по тону. */
  hue: number;
}

/**
 * Базовый вариант повторяет обычную ΔE00 (все веса единичные).
 * «portrait» усиливает тон и насыщенность: именно они отличают кожу от
 * стены и одежды, когда светлота у них похожая.
 */
export const PERCEPTUAL_PRESETS: Record<string, PerceptualWeights> = {
  neutral: { lightness: 1, chroma: 1, hue: 1 },
  portrait: { lightness: 1, chroma: 1.35, hue: 1.6 },
  lightnessFirst: { lightness: 1.5, chroma: 0.8, hue: 0.8 },
};

/* --------------------------------------------- пространственное сопоставление */

export interface SpatialMappingConfig {
  /** Вес цветовой ошибки — база. */
  colorWeight: number;
  /**
   * Штраф за несогласие с соседями: удерживает от одиночных «пятен»,
   * но не размывает — считается только по уже назначенным соседям.
   */
  neighborWeight: number;
  /**
   * Штраф за нарушение локального градиента: если исходник светлеет слева
   * направо, результат тоже должен светлеть.
   */
  gradientWeight: number;
  /** Сила границы, выше которой соседский штраф выключается. */
  edgeRelease: number;
  /** Вес удержания тональной зоны лица (свет → полутон → тень). */
  toneWeight: number;
  /** Метрика расстояния. */
  metric: ColorDistanceMetric;
  /** Веса перцептивного расстояния. */
  perceptual: PerceptualWeights;
}

export const SPATIAL_DEFAULTS: SpatialMappingConfig = {
  colorWeight: 1,
  neighborWeight: 0.35,
  gradientWeight: 0.45,
  edgeRelease: 0.45,
  toneWeight: 0.9,
  metric: 'ciede2000',
  perceptual: PERCEPTUAL_PRESETS.neutral,
};

/* ------------------------------------------------------- error diffusion */

export type DiffusionKernelId = 'floyd-steinberg' | 'jarvis' | 'stucki';

export interface DiffusionConfig {
  kernel: DiffusionKernelId;
  /** Общая сила переноса ошибки, 0..1. */
  strength: number;
  /** Змейкой по строкам — убирает направленные полосы. */
  serpentine: boolean;
  /** Ограничение переносимой ошибки, чтобы не появлялись «искры». */
  clampError: number;
  /** Адаптивная сила: минимум на защищённых участках. */
  adaptive: {
    enabled: boolean;
    /** Сила на глазах, губах, бровях, контуре и волосах. */
    protectedStrength: number;
    /** Сила на ровной коже и плавных градиентах. */
    flatStrength: number;
    /** Порог силы границы, после которого участок считается контуром. */
    edgeThreshold: number;
  };
}

export const DIFFUSION_DEFAULTS: DiffusionConfig = {
  kernel: 'floyd-steinberg',
  strength: 0.85,
  serpentine: true,
  clampError: 48,
  adaptive: {
    enabled: false,
    protectedStrength: 0.15,
    flatStrength: 1,
    edgeThreshold: 0.4,
  },
};

/* ------------------------------------------------------- тональные зоны */

export interface ToneZoneConfig {
  /** Границы зон в перцентилях светлоты внутри лица. */
  percentiles: number[];
  /** Названия зон от тени к свету. */
  labels: string[];
}

export const TONE_ZONES: ToneZoneConfig = {
  percentiles: [0.08, 0.28, 0.55, 0.82],
  labels: ['deep-shadow', 'shadow', 'mid', 'light', 'highlight'],
};

/* ------------------------------------------------- диффузия ошибки в Lab */

export interface LabDiffusionZoneStrength {
  /** Обычные области: фон, одежда, всё вне лица. */
  base: number;
  face: number;
  eyes: number;
  mouth: number;
  contour: number;
  hair: number;
}

export interface LabDiffusionConfig {
  /** Общая сила переноса. В адаптивном режиме умножается на зональную. */
  strength: number;
  /** Зональные силы — включаются, когда adaptive = true. */
  adaptive: boolean;
  zones: LabDiffusionZoneStrength;
  /** Змейкой по строкам: убирает направленные полосы. */
  serpentine: boolean;
  /** Ограничение переносимой ошибки по каждой оси Lab. */
  clampL: number;
  clampAb: number;
  /** Веса перцептивного расстояния при выборе цвета. */
  perceptual: PerceptualWeights;
}

/**
 * Зональные силы из задания 9C: чем важнее деталь, тем меньше её
 * «размешиваем». Обычные области получают больше всего, глаза и контуры —
 * почти ничего.
 */
export const LAB_DIFFUSION_ZONES: LabDiffusionZoneStrength = {
  base: 0.55,
  face: 0.35,
  eyes: 0.15,
  mouth: 0.2,
  contour: 0.15,
  hair: 0.25,
};

export const LAB_DIFFUSION_DEFAULTS: LabDiffusionConfig = {
  strength: 0.55,
  adaptive: false,
  zones: LAB_DIFFUSION_ZONES,
  serpentine: true,
  clampL: 18,
  clampAb: 14,
  perceptual: PERCEPTUAL_PRESETS.portrait,
};
