import type { MosaicGrid, RGB } from './mosaic';

/** Цвет в CIE L*a*b* (D65). */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** Цвет физической палитры — ровно то, что лежит в config/palettes.json. */
export interface PaletteColor {
  id: string;
  name: string;
  hex: string;
  rgb: RGB;
  /** Сколько деталей есть в наличии. Пока только показывается, ничем не ограничивает. */
  availableQuantity: number;
}

export interface Palette {
  id: string;
  colors: PaletteColor[];
}

/** Палитра с посчитанным заранее Lab — так поиск ближайшего не пересчитывает одно и то же. */
export interface PreparedPaletteColor extends PaletteColor {
  lab: Lab;
  /** Индекс в массиве палитры. */
  index: number;
}

export interface PreparedPalette {
  id: string;
  colors: PreparedPaletteColor[];
}

/** Метрика перцептивного расстояния. */
export type ColorDistanceMetric = 'cie76' | 'cie94' | 'ciede2000';

export interface NearestColorMatch {
  color: PreparedPaletteColor;
  /** ΔE выбранной метрики. */
  distance: number;
}

export interface PaletteUsage {
  color: PaletteColor;
  count: number;
  /** Доля от всех ячеек, 0..1. */
  share: number;
}

/** Результат сопоставления сетки с палитрой. */
export interface PaletteMapping {
  paletteId: string;
  metric: ColorDistanceMetric;
  /** Сетка, в которой цвет каждой ячейки заменён цветом палитры. */
  grid: MosaicGrid;
  /** Индекс цвета палитры для каждой ячейки, в том же порядке, что grid.cells. */
  assignments: Uint16Array;
  /** Использованные цвета, от частых к редким. */
  usage: PaletteUsage[];
  averageDistance: number;
  maxDistance: number;
}
