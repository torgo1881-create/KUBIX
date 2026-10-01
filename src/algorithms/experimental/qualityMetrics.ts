import { getDistanceFn } from '../color/distance';
import { rgbToLab } from '../color/lab';
import { computeGridCellMaps, luminance, type CellMaps } from '../image/edges';
import { REGION_LABELS, type WeightMap } from '../optimization/weightMap';
import type { MosaicGrid } from '../../types/mosaic';

/**
 * Метрики для сравнения вариантов алгоритма.
 *
 * Главный критерий этапа — узнаваемость, а не попиксельная точность,
 * поэтому кроме ΔE считаются: сохранность градиентов, разнообразие цвета
 * внутри лица и размер сплошных областей.
 */

export interface VariantMetrics {
  /** Средняя ΔE00 между средним цветом ячейки и деталью. */
  deltaE: number;
  /** Доля сохранившихся границ, 0..1. */
  edgeScore: number;
  /** Средняя ошибка в ячейках лица (ΔE). */
  faceDeltaE: number;
  /** Сколько разных цветов реально попало в лицо. */
  faceColorDiversity: number;
  /** Эффективное число цветов лица (по энтропии) — устойчиво к «одному пикселю». */
  faceEffectiveColors: number;
  /** Крупнейшая связная одноцветная область, ячеек. */
  largestRegion: number;
  largestRegionShare: number;
  /** Доля площади в областях от 64 ячеек. */
  monolithShare: number;
  /** Среднее число цветов в окне 4×4. */
  diversity4x4: number;
  /** Сохранность направления локального градиента, 0..1. */
  gradientScore: number;
  /** Сколько цветов использовано всего. */
  colorsUsed: number;
}

export interface MetricsInput {
  averageGrid: MosaicGrid;
  mosaicGrid: MosaicGrid;
  /** Карты границ исходника. */
  maps?: CellMaps | null;
  /** Карта областей — из неё берутся ячейки лица. */
  weightMap?: WeightMap | null;
}

const FACE_LABELS = new Set(['eyes', 'mouth', 'contour', 'face', 'hair']);

export function computeVariantMetrics(input: MetricsInput): VariantMetrics {
  const { averageGrid, mosaicGrid } = input;
  const distance = getDistanceFn('ciede2000');
  const total = averageGrid.cells.length;
  const { cols, rows } = averageGrid;

  /* --- ошибка по цвету, в том числе на лице --- */
  let deltaSum = 0;
  let faceSum = 0;
  let faceCells = 0;
  const faceColorCounts = new Map<string, number>();

  for (let i = 0; i < total; i++) {
    const delta = distance(rgbToLab(averageGrid.cells[i].rgb), rgbToLab(mosaicGrid.cells[i].rgb));
    deltaSum += delta;

    const label = input.weightMap ? REGION_LABELS[input.weightMap.region[i]] : 'base';
    if (input.weightMap && FACE_LABELS.has(label)) {
      faceSum += delta;
      faceCells++;
      const hex = mosaicGrid.cells[i].hex;
      faceColorCounts.set(hex, (faceColorCounts.get(hex) ?? 0) + 1);
    }
  }

  /* --- сохранность границ --- */
  const sourceEdges = input.maps?.edge ?? computeGridCellMaps(averageGrid).edge;
  const mosaicEdges = computeGridCellMaps(mosaicGrid).edge;
  let overlap = 0;
  let reference = 0;
  for (let i = 0; i < sourceEdges.length; i++) {
    if (sourceEdges[i] <= 0) continue;
    reference += sourceEdges[i];
    overlap += Math.min(sourceEdges[i], mosaicEdges[i] ?? 0);
  }

  /* --- сохранность градиента: совпадает ли направление изменения светлоты --- */
  let gradientMatches = 0;
  let gradientTotal = 0;
  const lumaOf = (grid: MosaicGrid, index: number) => {
    const [r, g, b] = grid.cells[index].rgb;
    return luminance(r, g, b);
  };

  for (let y = 0; y < rows; y++) {
    for (let x = 1; x < cols; x++) {
      const index = y * cols + x;
      const want = lumaOf(averageGrid, index) - lumaOf(averageGrid, index - 1);
      // Учитываем только заметные перепады: шум ниже 2 единиц игнорируем.
      if (Math.abs(want) < 2) continue;
      gradientTotal++;
      const got = lumaOf(mosaicGrid, index) - lumaOf(mosaicGrid, index - 1);
      if (Math.sign(got) === Math.sign(want) || (got === 0 && Math.abs(want) < 6)) gradientMatches++;
    }
  }

  /* --- связные области --- */
  const seen = new Uint8Array(total);
  const blobs: number[] = [];
  const stack: number[] = [];

  for (let start = 0; start < total; start++) {
    if (seen[start]) continue;
    const hex = mosaicGrid.cells[start].hex;
    stack.push(start);
    seen[start] = 1;
    let size = 0;

    while (stack.length) {
      const cell = stack.pop() as number;
      size++;
      const x = cell % cols;
      const y = (cell - x) / cols;
      const neighbors = [
        x > 0 ? cell - 1 : -1,
        x < cols - 1 ? cell + 1 : -1,
        y > 0 ? cell - cols : -1,
        y < rows - 1 ? cell + cols : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || seen[neighbor]) continue;
        if (mosaicGrid.cells[neighbor].hex !== hex) continue;
        seen[neighbor] = 1;
        stack.push(neighbor);
      }
    }
    blobs.push(size);
  }

  blobs.sort((a, b) => b - a);
  const monolith = blobs.filter((size) => size >= 64).reduce((sum, size) => sum + size, 0);

  /* --- локальное разнообразие --- */
  let diversitySum = 0;
  let windows = 0;
  for (let y = 0; y + 4 <= rows; y += 4) {
    for (let x = 0; x + 4 <= cols; x += 4) {
      const unique = new Set<string>();
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) unique.add(mosaicGrid.cells[(y + dy) * cols + (x + dx)].hex);
      }
      diversitySum += unique.size;
      windows++;
    }
  }

  /* --- разнообразие внутри лица --- */
  let entropy = 0;
  for (const count of faceColorCounts.values()) {
    const p = count / Math.max(1, faceCells);
    entropy -= p * Math.log(p);
  }

  const usedColors = new Set(mosaicGrid.cells.map((cell) => cell.hex)).size;

  return {
    deltaE: round(deltaSum / total),
    edgeScore: round(reference > 0 ? Math.min(1, overlap / reference) : 1),
    faceDeltaE: round(faceCells ? faceSum / faceCells : 0),
    faceColorDiversity: faceColorCounts.size,
    faceEffectiveColors: round(Math.exp(entropy)),
    largestRegion: blobs[0] ?? 0,
    largestRegionShare: round((100 * (blobs[0] ?? 0)) / total),
    monolithShare: round((100 * monolith) / total),
    diversity4x4: round(windows ? diversitySum / windows : 0),
    gradientScore: round(gradientTotal ? gradientMatches / gradientTotal : 1),
    colorsUsed: usedColors,
  };
}

/**
 * Утечка цвета: сколько ячеек ВНЕ лица получили «кожаные» детали.
 * Это прямая проверка проблемы из аудита 9A.
 */
export function colorLeakage(
  mosaicGrid: MosaicGrid,
  weightMap: WeightMap | null,
  skinColorHexes: string[],
): { outsideFaceSkinCells: number; outsideFaceCells: number; share: number } {
  if (!weightMap) return { outsideFaceSkinCells: 0, outsideFaceCells: 0, share: 0 };

  const skin = new Set(skinColorHexes.map((hex) => hex.toUpperCase()));
  let outside = 0;
  let leaked = 0;

  for (let i = 0; i < mosaicGrid.cells.length; i++) {
    const label = REGION_LABELS[weightMap.region[i]];
    if (FACE_LABELS.has(label)) continue;
    outside++;
    if (skin.has(mosaicGrid.cells[i].hex.toUpperCase())) leaked++;
  }

  return {
    outsideFaceSkinCells: leaked,
    outsideFaceCells: outside,
    share: round(outside ? (100 * leaked) / outside : 0),
  };
}

/**
 * Детальная утечка: отдельно по фону и по одежде.
 *
 * Одежда определяется геометрически — ячейки ниже нижней границы лица.
 * Точной сегментации одежды у нас нет, но для сравнения вариантов между
 * собой этого достаточно: граница одна и та же во всех прогонах.
 */
export interface LeakageBreakdown {
  overall: number;
  outsideFace: number;
  background: number;
  clothes: number;
}

export function leakageBreakdown(
  mosaicGrid: MosaicGrid,
  weightMap: WeightMap | null,
  skinColorHexes: string[],
  faceBottomRow: number,
): LeakageBreakdown {
  const skin = new Set(skinColorHexes.map((hex) => hex.toUpperCase()));
  const { cols } = mosaicGrid;

  let all = 0;
  let allSkin = 0;
  let outside = 0;
  let outsideSkin = 0;
  let background = 0;
  let backgroundSkin = 0;
  let clothes = 0;
  let clothesSkin = 0;

  for (let i = 0; i < mosaicGrid.cells.length; i++) {
    const isSkin = skin.has(mosaicGrid.cells[i].hex.toUpperCase());
    all++;
    if (isSkin) allSkin++;

    const label = weightMap ? REGION_LABELS[weightMap.region[i]] : 'base';
    if (weightMap && FACE_LABELS.has(label)) continue;

    outside++;
    if (isSkin) outsideSkin++;

    const row = Math.floor(i / cols);
    if (row > faceBottomRow) {
      clothes++;
      if (isSkin) clothesSkin++;
    } else {
      background++;
      if (isSkin) backgroundSkin++;
    }
  }

  return {
    overall: round(all ? (100 * allSkin) / all : 0),
    outsideFace: round(outside ? (100 * outsideSkin) / outside : 0),
    background: round(background ? (100 * backgroundSkin) / background : 0),
    clothes: round(clothes ? (100 * clothesSkin) / clothes : 0),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
