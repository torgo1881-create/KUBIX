import type { PieceLimitResult } from '../algorithms/optimization/pieceLimit';
import type { ProductPreset } from '../config/productPresets';
import { formatNumber } from './format';

/**
 * Проверка «хватает ли деталей в наборе» на человеческом языке.
 *
 * Технические состояния (feasible / satisfied / over) остаются в данных и в
 * отладочной панели, а покупателю показывается понятная фраза без слова
 * «infeasible».
 */

export type CapacityLevel = 'ok' | 'adjusted' | 'tight' | 'insufficient';

export interface CapacityStatus {
  level: CapacityLevel;
  /** Короткая фраза для интерфейса. */
  title: string;
  /** Пояснение и что делать. */
  detail: string;
  requiredPieces: number;
  availablePieces: number;
  /** Сколько ячеек пришлось перекрасить ради запаса. */
  reassigned: number;
  /** Техническое состояние — только для Advanced/Debug. */
  debug: {
    feasible: boolean;
    satisfied: boolean;
    overflowColors: string[];
  };
}

/** Проверка до генерации: помещается ли фотография в набор в принципе. */
export function checkPresetCapacity(preset: ProductPreset): CapacityStatus {
  const fits = preset.availablePieces >= preset.maxCells;

  return {
    level: fits ? 'ok' : 'insufficient',
    title: fits ? 'Набор подходит для этой сетки' : 'В наборе меньше деталей, чем ячеек',
    detail: fits
      ? `${formatNumber(preset.maxCells)} ячеек, в наборе ${formatNumber(preset.availablePieces)} деталей.`
      : `Для картины нужно ${formatNumber(preset.maxCells)} деталей, а в наборе ${formatNumber(
          preset.availablePieces,
        )}. Выберите набор побольше.`,
    requiredPieces: preset.maxCells,
    availablePieces: preset.availablePieces,
    reassigned: 0,
    debug: { feasible: fits, satisfied: fits, overflowColors: [] },
  };
}

/** Статус после генерации — уже по фактическому расходу деталей. */
export function describeCapacity(preset: ProductPreset, limit?: PieceLimitResult | null): CapacityStatus {
  if (!limit) return checkPresetCapacity(preset);

  const overflow = limit.requirements.filter((requirement) => requirement.required > requirement.available);
  const corrected = limit.requirements.filter((requirement) => requirement.status === 'corrected');
  const required = limit.requirements.reduce((sum, requirement) => sum + requirement.required, 0);

  const debug = {
    feasible: limit.feasible,
    satisfied: limit.satisfied,
    overflowColors: overflow.map((requirement) => requirement.color.name),
  };

  if (!limit.feasible || overflow.length > 0) {
    const names = overflow.map((requirement) => requirement.color.name).join(', ');
    return {
      level: 'insufficient',
      title: 'Для этой фотографии требуется слишком много деталей одного цвета',
      detail: names
        ? `Не хватает деталей: ${names}. Попробуйте кадрировать иначе, выбрать другой снимок или набор побольше.`
        : 'Попробуйте кадрировать иначе, выбрать другой снимок или набор побольше.',
      requiredPieces: required,
      availablePieces: preset.availablePieces,
      reassigned: limit.moved,
      debug,
    };
  }

  if (corrected.length > 0) {
    const share = limit.totalCells > 0 ? limit.moved / limit.totalCells : 0;
    return {
      level: share > 0.35 ? 'tight' : 'adjusted',
      title: 'Этот набор подходит для выбранной фотографии',
      detail:
        share > 0.35
          ? `Деталей хватает, но впритык: ${formatNumber(limit.moved)} ячеек подобрано другим цветом. ` +
            'На наборе побольше снимок получится точнее.'
          : `Деталей хватает. Несколько цветов подобраны заново — это нормально для плотных снимков.`,
      requiredPieces: required,
      availablePieces: preset.availablePieces,
      reassigned: limit.moved,
      debug,
    };
  }

  return {
    level: 'ok',
    title: 'Этот набор подходит для выбранной фотографии',
    detail: `Деталей хватает с запасом: нужно ${formatNumber(required)} из ${formatNumber(preset.availablePieces)}.`,
    requiredPieces: required,
    availablePieces: preset.availablePieces,
    reassigned: limit.moved,
    debug,
  };
}
