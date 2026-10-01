import { getDistanceFn } from '../color/distance';
import { rgbToLab } from '../color/lab';
import { computeGridCellMaps, type CellMaps } from '../image/edges';
import type { PieceLimitResult } from '../optimization/pieceLimit';
import { REGION_LABELS, type WeightMap } from '../optimization/weightMap';
import { QUALITY_WEIGHTS, QUALITY_LIMITS, type QualityWeights } from '../../config/variants';
import type { MosaicGrid } from '../../types/mosaic';
import type { ColorDistanceMetric } from '../../types/palette';

/**
 * Оценка качества варианта.
 *
 * Ничего случайного: все четыре составляющие считаются по пикселям и по
 * фактическим назначениям цветов. Один и тот же вариант всегда получает
 * одну и ту же оценку.
 */

export interface QualityScore {
  /** Насколько цвета мозаики близки к средним цветам снимка, 0..1. */
  colorSimilarity: number;
  /** Сколько границ дожило до результата, 0..1. */
  edgePreservation: number;
  /** Насколько сохранились глаза, рот, контур и лицо, 0..1. */
  facePreservation: number;
  /** Соблюдены ли запасы деталей, 0..1. */
  quantityCompliance: number;
  /** Взвешенная сумма, 0..1. */
  total: number;
  /** Было ли вообще лицо: без него facePreservation берётся из общей похожести. */
  hasFace: boolean;
  /** Средняя ошибка ΔE — полезно показать рядом со счётом. */
  averageDelta: number;
}

export interface QualityScoreInput {
  /** Средние цвета — эталон, с которым сравниваем. */
  averageGrid: MosaicGrid;
  /** Итоговая сетка в цветах палитры. */
  mosaicGrid: MosaicGrid;
  /** Карты границ исходника в разрешении сетки. */
  maps?: CellMaps | null;
  /** Карта важности: по ней понятно, где лицо. */
  weightMap?: WeightMap | null;
  /** Результат приведения к запасам — источник данных о превышениях. */
  pieceLimit?: PieceLimitResult | null;
  metric?: ColorDistanceMetric;
  weights?: Partial<QualityWeights>;
}

const FACE_LABELS = new Set(['eyes', 'mouth', 'contour', 'face', 'hair']);

function similarityFromDelta(delta: number): number {
  const value = 1 - delta / QUALITY_LIMITS.maxAcceptableDelta;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function scoreMosaic(input: QualityScoreInput): QualityScore {
  const { averageGrid, mosaicGrid } = input;
  const distanceFn = getDistanceFn(input.metric ?? 'ciede2000');
  const weights: QualityWeights = { ...QUALITY_WEIGHTS, ...input.weights };
  const weightMap = input.weightMap ?? null;

  /* --- 1. Похожесть цвета ------------------------------------------------ */

  let deltaSum = 0;
  let faceDeltaSum = 0;
  let faceCells = 0;

  for (let i = 0; i < averageGrid.cells.length; i++) {
    const delta = distanceFn(rgbToLab(averageGrid.cells[i].rgb), rgbToLab(mosaicGrid.cells[i].rgb));
    deltaSum += delta;

    if (weightMap && FACE_LABELS.has(REGION_LABELS[weightMap.region[i]])) {
      faceDeltaSum += delta;
      faceCells++;
    }
  }

  const cellCount = averageGrid.cells.length || 1;
  const averageDelta = deltaSum / cellCount;
  const colorSimilarity = similarityFromDelta(averageDelta);

  /* --- 2. Сохранность границ --------------------------------------------- */

  // Сравниваем силу границ исходника и результата в одних и тех же ячейках:
  // сумма min(источник, результат) / сумма источника — «сколько контура дожило».
  const sourceEdges = input.maps?.edge ?? computeGridCellMaps(averageGrid).edge;
  const mosaicEdges = computeGridCellMaps(mosaicGrid).edge;

  let overlap = 0;
  let reference = 0;
  for (let i = 0; i < sourceEdges.length; i++) {
    const source = sourceEdges[i];
    if (source <= 0) continue;
    reference += source;
    overlap += Math.min(source, mosaicEdges[i] ?? 0);
  }
  const edgePreservation = reference > 0 ? Math.min(1, overlap / reference) : 1;

  /* --- 3. Сохранность лица ------------------------------------------------ */

  const hasFace = Boolean(weightMap && weightMap.faces > 0 && faceCells > 0);
  const facePreservation = hasFace ? similarityFromDelta(faceDeltaSum / faceCells) : colorSimilarity;

  /* --- 4. Соблюдение запасов ---------------------------------------------- */

  let quantityCompliance = 1;
  if (input.pieceLimit) {
    const limit = input.pieceLimit;
    const overflow = limit.requirements.reduce(
      (sum, requirement) => sum + Math.max(0, requirement.required - requirement.available),
      0,
    );
    quantityCompliance = limit.totalCells > 0 ? Math.max(0, 1 - overflow / limit.totalCells) : 1;
    if (!limit.feasible) quantityCompliance = Math.min(quantityCompliance, QUALITY_LIMITS.infeasiblePenalty);
  }

  /* --- Итог ---------------------------------------------------------------- */

  const weightSum = weights.color + weights.edge + weights.face + weights.quantity;
  const total =
    (colorSimilarity * weights.color +
      edgePreservation * weights.edge +
      facePreservation * weights.face +
      quantityCompliance * weights.quantity) /
    (weightSum || 1);

  return {
    colorSimilarity: round(colorSimilarity),
    edgePreservation: round(edgePreservation),
    facePreservation: round(facePreservation),
    quantityCompliance: round(quantityCompliance),
    // Нарушение лимитов бьёт по всей оценке, а не только по своей доле:
    // вариант, который нельзя собрать, не должен побеждать.
    total: round(total * quantityCompliance),
    hasFace,
    averageDelta: Math.round(averageDelta * 100) / 100,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Оценка в процентах — для интерфейса. */
export function formatScore(score: QualityScore): string {
  return `${Math.round(score.total * 100)}`;
}
