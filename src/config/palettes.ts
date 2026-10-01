import type { Palette, PaletteColor } from '../types/palette';

/**
 * Разбор и проверка config/palettes.json.
 *
 * Файл — единственное место, где живут цвета. Здесь только валидация:
 * ни один цвет в коде не зашит.
 */

export interface ParsedPalettes {
  palettes: Palette[];
  byId: Record<string, Palette>;
  /** Замечания, которые не мешают работе (например, HEX и RGB разошлись). */
  warnings: string[];
}

const HEX_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeHex(hex: string): string {
  const clean = hex.trim().replace(/^#/, '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  return '#' + full.toUpperCase();
}

export function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = normalizeHex(hex).slice(1);
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function fail(path: string, message: string): never {
  throw new Error(`palettes.json → ${path}: ${message}`);
}

/**
 * Проверяет структуру и приводит цвета к нормальному виду.
 * Если RGB не совпадает с HEX, побеждает HEX, а расхождение попадает в warnings —
 * так опечатка при ручном редактировании не превращается в тихо неверный цвет.
 */
export function parsePalettes(raw: unknown): ParsedPalettes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('корень', 'ожидался объект вида { "basic": [ ... ] }');
  }

  const warnings: string[] = [];
  const palettes: Palette[] = [];
  const byId: Record<string, Palette> = {};

  for (const [paletteId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) fail(paletteId, 'палитра должна быть массивом цветов');
    if (value.length === 0) fail(paletteId, 'палитра пустая');

    const seen = new Set<string>();
    const colors: PaletteColor[] = value.map((entry, index) => {
      const path = `${paletteId}[${index}]`;
      if (!entry || typeof entry !== 'object') fail(path, 'ожидался объект цвета');

      const { id, name, hex, rgb, availableQuantity } = entry as Record<string, unknown>;

      if (typeof id !== 'string' || !id.trim()) fail(path, 'нужен непустой id');
      if (seen.has(id)) fail(path, `id «${id}» уже использован в этой палитре`);
      seen.add(id);

      if (typeof name !== 'string' || !name.trim()) fail(path, 'нужно непустое name');
      if (typeof hex !== 'string' || !HEX_PATTERN.test(hex)) fail(path, `hex «${String(hex)}» не похож на цвет`);

      const normalizedHex = normalizeHex(hex);
      const fromHex = hexToRgbTuple(normalizedHex);

      let finalRgb = fromHex;
      if (rgb !== undefined) {
        if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some((c) => typeof c !== 'number')) {
          fail(path, 'rgb должен быть массивом из трёх чисел');
        }
        const tuple = rgb as number[];
        if (tuple.some((c) => c < 0 || c > 255)) fail(path, 'значения rgb выходят за 0..255');
        if (tuple.some((c, i) => Math.round(c) !== fromHex[i])) {
          warnings.push(
            `${path}: rgb [${tuple.join(', ')}] не совпадает с hex ${normalizedHex} — взят hex`,
          );
        }
      }

      const quantity = availableQuantity ?? 0;
      if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
        fail(path, 'availableQuantity должен быть неотрицательным числом');
      }

      return {
        id,
        name: name.trim(),
        hex: normalizedHex,
        rgb: finalRgb,
        availableQuantity: Math.round(quantity),
      };
    });

    const palette: Palette = { id: paletteId, colors };
    palettes.push(palette);
    byId[paletteId] = palette;
  }

  if (palettes.length === 0) fail('корень', 'не найдено ни одной палитры');

  return { palettes, byId, warnings };
}
