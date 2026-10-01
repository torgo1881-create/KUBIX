/**
 * Стоимость замены цвета одной ячейки.
 *
 * cost = colorDistance + structuralPenalty + edgePenalty
 *
 * Все три слагаемых измеряются в единицах ΔE, поэтому их можно складывать и
 * сравнивать между собой. Веса вынесены наружу: их можно настраивать, не трогая
 * оптимизатор.
 */

export interface CostWeights {
  /** Вес базовой цветовой ошибки. Больше — точнее цвет, меньше — важнее форма. */
  color: number;
  /** Насколько дороже портить детальные (текстурные) участки. */
  structure: number;
  /** Насколько дороже трогать контуры: глаза, рот, границы объектов. */
  edge: number;
  /** Насколько важно совпадать с соседями в ровных областях. */
  cohesion: number;
}

export const DEFAULT_COST_WEIGHTS: CostWeights = {
  color: 1,
  structure: 0.6,
  edge: 1.5,
  cohesion: 0.25,
};

export function resolveWeights(weights?: Partial<CostWeights>): CostWeights {
  return { ...DEFAULT_COST_WEIGHTS, ...weights };
}

export interface ReplacementContext {
  /** ΔE между истинным (средним) цветом ячейки и кандидатом. */
  colorDistance: number;
  /** ΔE между текущим назначенным цветом и кандидатом: насколько сильно меняется картинка. */
  currentDistance: number;
  /** Средняя ΔE между кандидатом и цветами соседних ячеек. */
  neighborDistance?: number;
  /** Сила границы в этой ячейке, 0..1. */
  edge?: number;
  /** Детальность в этой ячейке, 0..1. */
  structure?: number;
  /**
   * Важность ячейки из карты весов: 1 — обычная область, 1.5 — лицо,
   * 2.5 — глаза. Множитель для всей стоимости.
   */
  weight?: number;
  weights?: Partial<CostWeights> | CostWeights;
}

export interface ReplacementCost {
  total: number;
  colorDistance: number;
  structuralPenalty: number;
  edgePenalty: number;
  /** Применённый вес области. */
  weight: number;
}

/**
 * Считает цену замены. Чем меньше total, тем безболезненнее замена.
 *
 * - colorDistance — базовая ошибка: насколько кандидат далёк от настоящего цвета;
 * - structuralPenalty — та же ошибка, но умноженная на детальность участка,
 *   плюс штраф за разрыв с соседями в ровных областях;
 * - edgePenalty — штраф за изменение цвета там, где проходит контур.
 */
export function calculateReplacementCost(context: ReplacementContext): ReplacementCost {
  const weights = resolveWeights(context.weights as Partial<CostWeights> | undefined);
  const edge = clamp01(context.edge ?? 0);
  const structure = clamp01(context.structure ?? 0);
  const neighborDistance = context.neighborDistance ?? 0;

  const colorDistance = context.colorDistance * weights.color;

  const structuralPenalty =
    weights.structure * structure * context.colorDistance +
    weights.cohesion * (1 - edge) * neighborDistance;

  const edgePenalty = weights.edge * edge * context.currentDistance;

  // Вес области умножает всю стоимость: ячейку глаза сдвинуть в 2.5 раза дороже,
  // чем такую же ячейку фона.
  const weight = context.weight === undefined || !Number.isFinite(context.weight) ? 1 : Math.max(0, context.weight);

  return {
    total: (colorDistance + structuralPenalty + edgePenalty) * weight,
    colorDistance,
    structuralPenalty,
    edgePenalty,
    weight,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
