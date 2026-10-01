import { getMode, type MosaicMode, type MosaicModeId } from './quality';
import type { ColorDistanceMetric } from '../types/palette';

/**
 * Слой абстракции между продуктом и алгоритмом.
 *
 *   Product preset → Processing profile → существующий режим генерации
 *
 * Профиль ничего не вычисляет и не меняет параметры режимов: он лишь
 * называет набор настроек по-продуктовому и указывает, какой из уже
 * существующих режимов (Standard / Portrait / High Contrast / Artistic)
 * под ним лежит. Сами режимы остаются на месте и доступны в Advanced.
 */

export type ProcessingProfileId = 'portrait-balanced' | 'color-portrait';

export interface ProcessingProfile {
  id: ProcessingProfileId;
  /** Короткое имя для отладки и Advanced-панели. */
  label: string;
  description: string;
  /** Какой существующий режим используется под капотом. */
  modeId: MosaicModeId;
  /** Метрика перцептивного расстояния. */
  distanceMetric: ColorDistanceMetric;
  /** Учитывать ли запас деталей набора. */
  enforcePieceLimits: boolean;
}

export const PROCESSING_PROFILES: Record<ProcessingProfileId, ProcessingProfile> = {
  'portrait-balanced': {
    id: 'portrait-balanced',
    label: 'Портретный сбалансированный',
    description:
      'Ищет лицо и бережёт глаза, рот и контуры. Используется для монохромных наборов Classic.',
    modeId: 'portrait',
    distanceMetric: 'ciede2000',
    enforcePieceLimits: true,
  },

  'color-portrait': {
    id: 'color-portrait',
    label: 'Цветной портретный',
    description:
      'Тот же портретный режим, но для цветной палитры: тона кожи распределяются по цветным деталям.',
    modeId: 'portrait',
    distanceMetric: 'ciede2000',
    enforcePieceLimits: true,
  },
};

export const PROCESSING_PROFILE_IDS = Object.keys(PROCESSING_PROFILES) as ProcessingProfileId[];

export function getProcessingProfile(id: ProcessingProfileId | string): ProcessingProfile {
  return PROCESSING_PROFILES[id as ProcessingProfileId] ?? PROCESSING_PROFILES['portrait-balanced'];
}

/** Режим генерации, стоящий за профилем. */
export function getProfileMode(id: ProcessingProfileId | string): MosaicMode {
  return getMode(getProcessingProfile(id).modeId);
}
