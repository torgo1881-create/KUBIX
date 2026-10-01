import type { Palette, PaletteColor } from '../types/palette';
import raw from './palettes.json';
import { parsePalettes } from './palettes';
import { BASE_COLOR_ID, type ProductPreset } from './productPresets';

/**
 * Единственное место, где читается config/palettes.json.
 * Всё остальное приложение получает палитру аргументом.
 */

const parsed = parsePalettes(raw);

export const PALETTES: Palette[] = parsed.palettes;
export const PALETTE_IDS: string[] = parsed.palettes.map((palette) => palette.id);
export const DEFAULT_PALETTE_ID = PALETTE_IDS.includes('basic') ? 'basic' : PALETTE_IDS[0];

if (parsed.warnings.length && typeof console !== 'undefined') {
  for (const warning of parsed.warnings) console.warn('[palettes]', warning);
}

export function getPalette(id: string): Palette {
  return parsed.byId[id] ?? parsed.palettes[0];
}

/** Подписи для переключателя палитр в интерфейсе. */
export const PALETTE_LABELS: Record<string, string> = {
  classic: 'Classic',
  color: 'Color',
  basic: 'Базовая',
  portrait: 'Портретная',
  grayscale: 'Серая',
};

export function getPaletteLabel(id: string): string {
  return PALETTE_LABELS[id] ?? id;
}

/**
 * Продуктовые палитры видит покупатель, остальные остаются для отладки.
 *
 * Экспериментальные палитры («Серая», «Базовая», «Портретная») никуда не
 * удалены — они по-прежнему доступны в разделе Advanced, чтобы можно было
 * вручную сравнивать поведение алгоритма.
 */
export const PRODUCT_PALETTE_IDS = ['classic', 'color'];

export const DEVELOPER_PALETTE_IDS = PALETTE_IDS.filter((id) => !PRODUCT_PALETTE_IDS.includes(id));

export function isProductPalette(id: string): boolean {
  return PRODUCT_PALETTE_IDS.includes(id);
}

export function isDeveloperPalette(id: string): boolean {
  return !isProductPalette(id);
}

/** Палитры, которые показываются в обычном пользовательском интерфейсе. */
export function productPalettes(): Palette[] {
  return PALETTES.filter((palette) => isProductPalette(palette.id));
}

/**
 * Палитра набора: те же цвета, но с реальным запасом деталей из коробки.
 *
 * Запас распределяется поровну между цветами. В palettes.json лежит
 * заглушка — настоящее количество деталей задаёт продуктовый пресет,
 * потому что один и тот же цвет в наборе S и L встречается в разном
 * количестве.
 */
export function buildPresetPalette(preset: ProductPreset): Palette {
  const source = getPalette(preset.paletteId);
  const usable = preset.baseColorEnabled
    ? source.colors
    : source.colors.filter((color) => color.id !== BASE_COLOR_ID);

  const perColor = Math.ceil(preset.availablePieces / usable.length);

  const colors: PaletteColor[] = usable.map((color) => ({
    ...color,
    availableQuantity: perColor,
  }));

  return { id: `${source.id}-${preset.id}`, colors };
}

/** Сколько цветов реально участвует в наборе. */
export function presetPaletteSize(preset: ProductPreset): number {
  return buildPresetPalette(preset).colors.length;
}
