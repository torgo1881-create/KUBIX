import { MAX_REGION_WEIGHT, REGION_WEIGHTS, type RegionWeights } from '../../config/quality';
import type { Ellipse, FaceRegions, Rect } from '../face/faceRegions';

/**
 * Карта важности ячеек: во сколько раз замена цвета в этой ячейке
 * «дороже» обычной.
 *
 * Обычная область — 1, лицо — 1.5, глаза — 2.5, рот — 2.0, границы — 2.0.
 * Числа берутся из config/quality.ts, здесь ничего не зашито.
 */

/** Что именно попало в ячейку — для подписи в интерфейсе и для тестов. */
export const REGION_LABELS = ['base', 'edge', 'hair', 'face', 'contour', 'mouth', 'eyes'] as const;
export type RegionLabel = (typeof REGION_LABELS)[number];

export interface WeightMap {
  cols: number;
  rows: number;
  /** Итоговый вес каждой ячейки, ≥ 1. */
  weight: Float32Array;
  /** Индекс в REGION_LABELS — какая область оказалась главной. */
  region: Uint8Array;
  /** Сколько ячеек попало в каждую область. */
  counts: Record<RegionLabel, number>;
  /** Учитывались ли лица. */
  faces: number;
}

export interface WeightMapInput {
  cols: number;
  rows: number;
  /** Размер изображения, в координатах которого заданы области лиц. */
  width: number;
  height: number;
  faces?: FaceRegions[];
  /** Карта границ из edges.ts, значения 0..1. */
  edge?: Float32Array | null;
  weights?: Partial<RegionWeights>;
  /** Порог, начиная с которого ячейка считается границей. */
  edgeThreshold?: number;
}

function labelIndex(label: RegionLabel): number {
  return REGION_LABELS.indexOf(label);
}

function insideEllipse(ellipse: Ellipse, x: number, y: number, scale = 1): boolean {
  const rx = ellipse.rx * scale;
  const ry = ellipse.ry * scale;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (x - ellipse.cx) / rx;
  const dy = (y - ellipse.cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function insideRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Кольцо вокруг овала лица — тот самый контур, который нельзя разрушать. */
function onFaceContour(oval: Ellipse, x: number, y: number): boolean {
  return insideEllipse(oval, x, y, 1.12) && !insideEllipse(oval, x, y, 0.88);
}

export function buildWeightMap(input: WeightMapInput): WeightMap {
  const { cols, rows, width, height, faces = [], edge = null } = input;
  const weights: RegionWeights = { ...REGION_WEIGHTS, ...input.weights };
  const edgeThreshold = input.edgeThreshold ?? 0.35;

  const weight = new Float32Array(cols * rows).fill(weights.base);
  const region = new Uint8Array(cols * rows);
  const counts: Record<RegionLabel, number> = {
    base: 0,
    edge: 0,
    hair: 0,
    face: 0,
    contour: 0,
    mouth: 0,
    eyes: 0,
  };

  const cellWidth = width / cols;
  const cellHeight = height / rows;

  for (let gy = 0; gy < rows; gy++) {
    const cy = (gy + 0.5) * cellHeight;

    for (let gx = 0; gx < cols; gx++) {
      const cx = (gx + 0.5) * cellWidth;
      const index = gy * cols + gx;

      let best = weights.base;
      let bestLabel: RegionLabel = 'base';

      // Границы объектов: вес растёт плавно вместе с силой границы.
      if (edge && edge[index] >= edgeThreshold) {
        const strength = Math.min(1, (edge[index] - edgeThreshold) / (1 - edgeThreshold));
        const value = weights.base + (weights.edge - weights.base) * strength;
        if (value > best) {
          best = value;
          bestLabel = 'edge';
        }
      }

      for (const face of faces) {
        if (face.hair && insideRect(face.hair, cx, cy) && weights.hair > best) {
          best = weights.hair;
          bestLabel = 'hair';
        }
        if (insideEllipse(face.oval, cx, cy) && weights.face > best) {
          best = weights.face;
          bestLabel = 'face';
        }
        if (onFaceContour(face.oval, cx, cy) && weights.contour > best) {
          best = weights.contour;
          bestLabel = 'contour';
        }
        if (face.mouth && insideRect(face.mouth, cx, cy) && weights.mouth > best) {
          best = weights.mouth;
          bestLabel = 'mouth';
        }
        for (const eye of face.eyes) {
          // Глаз маленький: расширяем радиус, чтобы он занял хотя бы ячейку.
          const rx = Math.max(eye.rx, cellWidth * 0.6);
          const ry = Math.max(eye.ry, cellHeight * 0.6);
          if (insideEllipse({ ...eye, rx, ry }, cx, cy) && weights.eyes > best) {
            best = weights.eyes;
            bestLabel = 'eyes';
          }
        }
      }

      weight[index] = Math.min(MAX_REGION_WEIGHT, best);
      region[index] = labelIndex(bestLabel);
      counts[bestLabel]++;
    }
  }

  return { cols, rows, weight, region, counts, faces: faces.length };
}

/** Пустая карта: все ячейки равны. Используется, когда лицо не найдено. */
export function uniformWeightMap(cols: number, rows: number): WeightMap {
  return {
    cols,
    rows,
    weight: new Float32Array(cols * rows).fill(1),
    region: new Uint8Array(cols * rows),
    counts: { base: cols * rows, edge: 0, hair: 0, face: 0, contour: 0, mouth: 0, eyes: 0 },
    faces: 0,
  };
}
