import type { ProcessingProfileId } from './processingProfiles';

/**
 * Продуктовые наборы.
 *
 * Это единственное место, где описаны наборы, которые видит покупатель.
 * Интерфейс не знает ни про сетки, ни про палитры — он берёт список отсюда,
 * поэтому новый набор добавляется одной записью, без правок приложения.
 */

export type ProductCategory = 'classic' | 'color';

export interface ProductPreset {
  id: string;
  name: string;
  category: ProductCategory;
  /** Ячеек по горизонтали. */
  width: number;
  /** Ячеек по вертикали. */
  height: number;
  /** Размер готовой картины, см. */
  physicalWidth: number;
  physicalHeight: number;
  /** Палитра из palettes.json. */
  paletteId: string;
  /** Всего ячеек в мозаике. */
  maxCells: number;
  /** Сколько деталей физически лежит в коробке. */
  availablePieces: number;
  /**
   * Лежит ли в коробке чёрная основа — дополнительный тёмный цвет.
   *
   * Это состав набора, а не настройка генерации: основа либо есть в коробке,
   * либо нет. Пользоваться ею в схеме или обойтись без неё — отдельный
   * выбор, см. resolveBaseColor.
   */
  baseColorEnabled: boolean;
  processingProfile: ProcessingProfileId;
}

/**
 * Запаса деталей в наборе больше, чем ячеек: иначе любой перекос по одному
 * цвету делал бы картину несобираемой. Коэффициент общий для всех наборов.
 */
export const PIECE_GENEROSITY = 1.55;

/** Id цвета, который считается чёрной основой. */
export const BASE_COLOR_ID = 'color-base';

/**
 * Участвует ли основа в генерации.
 *
 * Выбор есть только там, где основа физически лежит в коробке: в наборах
 * Classic её нет, и «с основой» для них ничего не значит. `undefined` и
 * `null` означают «как в наборе» — так ведут себя все старые вызовы.
 */
export function resolveBaseColor(preset: ProductPreset, withBase?: boolean | null): boolean {
  return preset.baseColorEnabled && (withBase ?? true);
}

/** Можно ли для этого набора выбирать «с основой / без основы». */
export function baseColorIsOptional(preset: ProductPreset): boolean {
  return preset.baseColorEnabled;
}

function pieces(cells: number): number {
  return Math.round((cells * PIECE_GENEROSITY) / 100) * 100;
}

export const PRODUCT_PRESETS: ProductPreset[] = [
  {
    id: 'classic-s',
    name: 'Classic S',
    category: 'classic',
    width: 64,
    height: 64,
    physicalWidth: 51,
    physicalHeight: 51,
    paletteId: 'classic',
    maxCells: 64 * 64,
    availablePieces: pieces(64 * 64),
    baseColorEnabled: false,
    processingProfile: 'portrait-balanced',
  },
  {
    id: 'classic-m',
    name: 'Classic M',
    category: 'classic',
    width: 64,
    height: 96,
    physicalWidth: 51,
    physicalHeight: 76,
    paletteId: 'classic',
    maxCells: 64 * 96,
    availablePieces: pieces(64 * 96),
    baseColorEnabled: false,
    processingProfile: 'portrait-balanced',
  },
  {
    id: 'classic-l',
    name: 'Classic L',
    category: 'classic',
    width: 96,
    height: 96,
    physicalWidth: 76,
    physicalHeight: 76,
    paletteId: 'classic',
    maxCells: 96 * 96,
    availablePieces: pieces(96 * 96),
    baseColorEnabled: false,
    processingProfile: 'portrait-balanced',
  },
  {
    id: 'color-s',
    name: 'Color S',
    category: 'color',
    width: 64,
    height: 64,
    physicalWidth: 51,
    physicalHeight: 51,
    paletteId: 'color',
    maxCells: 64 * 64,
    availablePieces: pieces(64 * 64),
    baseColorEnabled: true,
    processingProfile: 'color-portrait',
  },
  {
    id: 'color-m',
    name: 'Color M',
    category: 'color',
    width: 64,
    height: 96,
    physicalWidth: 51,
    physicalHeight: 76,
    paletteId: 'color',
    maxCells: 64 * 96,
    availablePieces: pieces(64 * 96),
    baseColorEnabled: true,
    processingProfile: 'color-portrait',
  },
];

export const PRODUCT_PRESET_IDS = PRODUCT_PRESETS.map((preset) => preset.id);
export const DEFAULT_PRESET_ID = 'classic-s';

export const CATEGORY_LABELS: Record<ProductCategory, string> = {
  classic: 'Classic',
  color: 'Color',
};

export function getPreset(id: string | null | undefined): ProductPreset {
  return PRODUCT_PRESETS.find((preset) => preset.id === id) ?? PRODUCT_PRESETS[0];
}

export function presetsByCategory(category: ProductCategory): ProductPreset[] {
  return PRODUCT_PRESETS.filter((preset) => preset.category === category);
}

/** Пропорции кадра: 64×64 → 1, 64×96 → 2/3. */
export function presetAspect(preset: ProductPreset): number {
  return preset.width / preset.height;
}

/** «1:1» или «2:3» — для подписи в интерфейсе. */
export function presetAspectLabel(preset: ProductPreset): string {
  const divisor = greatestCommonDivisor(preset.width, preset.height);
  return `${preset.width / divisor}:${preset.height / divisor}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/** Карточка набора для интерфейса — без единого технического параметра. */
export interface ProductSummary {
  id: string;
  name: string;
  category: ProductCategory;
  size: string;
  grid: string;
  cells: number;
  colors: number;
  colorsLabel: string;
  /** Участвует ли чёрная основа в этой схеме. */
  withBase: boolean;
  pieces: number;
  aspect: string;
}

export function describePreset(
  preset: ProductPreset,
  paletteColors: number,
  withBase: boolean = preset.baseColorEnabled,
): ProductSummary {
  // paletteColors — сколько цветов реально в работе. Основа среди них не
  // «цвет набора», поэтому в подписи она идёт отдельной строкой.
  const base = resolveBaseColor(preset, withBase);
  const visibleColors = base ? paletteColors - 1 : paletteColors;
  return {
    id: preset.id,
    name: preset.name,
    category: preset.category,
    size: `${preset.physicalWidth}×${preset.physicalHeight} см`,
    grid: `${preset.width}×${preset.height}`,
    cells: preset.maxCells,
    colors: visibleColors,
    colorsLabel: base
      ? `${visibleColors} + чёрная основа`
      : preset.baseColorEnabled
        ? `${visibleColors} без основы`
        : String(visibleColors),
    withBase: base,
    pieces: preset.availablePieces,
    aspect: presetAspectLabel(preset),
  };
}
