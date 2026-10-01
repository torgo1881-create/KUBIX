import type { CellShape, ColorSpaceMode } from '../types/mosaic';

/**
 * Единственный источник правды по размерам мозаики.
 * Чтобы добавить 128×128 — добавьте запись сюда, менять компоненты не нужно.
 */
export interface MosaicSizePreset {
  id: string;
  label: string;
  cols: number;
  rows: number;
  /** Короткая подсказка в UI. */
  hint: string;
}

export const MOSAIC_SIZES: readonly MosaicSizePreset[] = [
  { id: '32', label: '32 × 32', cols: 32, rows: 32, hint: '1 024 ячейки' },
  { id: '48', label: '48 × 48', cols: 48, rows: 48, hint: '2 304 ячейки' },
  { id: '64', label: '64 × 64', cols: 64, rows: 64, hint: '4 096 ячеек' },
  { id: '96', label: '96 × 96', cols: 96, rows: 96, hint: '9 216 ячеек' },
] as const;

export const DEFAULT_SIZE_ID = '64';

export function getSizePreset(id: string): MosaicSizePreset {
  return MOSAIC_SIZES.find((s) => s.id === id) ?? MOSAIC_SIZES[0];
}

/** Форматы, которые принимает загрузчик. */
export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'] as const;
export const ACCEPTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;
export const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(',');

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 МБ

/**
 * Ограничение на рабочее изображение, по которому считаются средние цвета.
 * Итог: сторона примерно MAX_SAMPLE_SIZE, но всегда кратна числу ячеек,
 * поэтому на каждую ячейку приходится ровно k×k пикселей.
 */
export const MAX_SAMPLE_SIZE = 1536;

/** Максимальное число пикселей источника на одну ячейку по стороне. */
export const MAX_SAMPLES_PER_CELL = 32;

/** Желаемая максимальная сторона итогового PNG. */
export const TARGET_OUTPUT_SIZE = 2048;

export const DEFAULT_COLOR_SPACE: ColorSpaceMode = 'srgb';
export const DEFAULT_CELL_SHAPE: CellShape = 'square';
export const DEFAULT_GAP = 0;
export const DEFAULT_BACKGROUND = '#ffffff';
export const DEFAULT_GRID_COLOR = 'rgba(0,0,0,0.08)';

/** Ограничения зума в кроппере и в просмотре результата. */
export const CROP_MAX_ZOOM = 8;
export const VIEW_MIN_ZOOM = 1;
export const VIEW_MAX_ZOOM = 12;

export const OUTPUT_FILENAME_PREFIX = 'mosaic';
