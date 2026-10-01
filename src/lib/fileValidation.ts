import { LIMITS } from '../config/limits';
import { ACCEPTED_EXTENSIONS, ACCEPTED_MIME_TYPES } from '../config/mosaic';
import { downscaleFactorFor } from './memoryGuard';
import { formatBytes } from './format';

/**
 * Проверка загружаемого файла.
 *
 * Расширение и MIME-тип приходят от клиента и легко подделываются, поэтому
 * дополнительно читаются первые байты: PNG, JPEG и WebP имеют характерные
 * сигнатуры. Файл с расширением .png, внутри которого не PNG, до генерации
 * не доходит.
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'unknown';

export interface FileValidation {
  ok: boolean;
  code?: string;
  error?: string;
  format?: ImageFormat;
}

/** Определяет формат по сигнатуре первых байтов. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return 'unknown';
}

/** Быстрые проверки по метаданным файла — без чтения содержимого. */
export function validateFileMeta(file: { name: string; type: string; size: number }): FileValidation {
  const type = (file.type ?? '').toLowerCase();
  const name = (file.name ?? '').toLowerCase();
  const typeOk = (ACCEPTED_MIME_TYPES as readonly string[]).includes(type);
  const extensionOk = ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension));

  if (!typeOk && !extensionOk) {
    return { ok: false, code: 'unsupported_type', error: 'Подойдут JPG, JPEG, PNG или WEBP. Выберите другой файл.' };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, code: 'empty_file', error: 'Файл пустой.' };
  }
  if (file.size > LIMITS.maxFileBytes) {
    return {
      ok: false,
      code: 'file_too_large',
      error: `Файл ${formatBytes(file.size)} — это больше лимита в ${formatBytes(LIMITS.maxFileBytes)}.`,
    };
  }
  return { ok: true };
}

/** Полная проверка: метаданные плюс сигнатура содержимого. */
export function validateFileBytes(
  file: { name: string; type: string; size: number },
  head: Uint8Array,
): FileValidation {
  const meta = validateFileMeta(file);
  if (!meta.ok) return meta;

  const format = sniffImageFormat(head);
  if (format === 'unknown') {
    return {
      ok: false,
      code: 'not_an_image',
      error: 'Содержимое файла не похоже на JPG, PNG или WEBP — возможно, он повреждён.',
    };
  }

  return { ok: true, format };
}

/** Проверка уже декодированного изображения. */
export function validateImageSize(width: number, height: number): FileValidation {
  if (!width || !height) {
    return { ok: false, code: 'no_dimensions', error: 'Не удалось прочитать размеры изображения.' };
  }
  if (width < LIMITS.minImageSide || height < LIMITS.minImageSide) {
    return {
      ok: false,
      code: 'image_too_small',
      error: `Изображение ${width}×${height} слишком мелкое: нужно хотя бы ${LIMITS.minImageSide} px по стороне.`,
    };
  }
  if (width > LIMITS.maxImageSide || height > LIMITS.maxImageSide) {
    return {
      ok: false,
      code: 'image_side_too_large',
      error: `Сторона ${Math.max(width, height)} px больше лимита ${LIMITS.maxImageSide} px.`,
    };
  }
  if (width * height > LIMITS.maxImagePixels) {
    return {
      ok: false,
      code: 'too_many_pixels',
      error: `${(width * height / 1_000_000).toFixed(1)} Мп больше лимита ${LIMITS.maxImagePixels / 1_000_000} Мп.`,
    };
  }
  return { ok: true };
}

/** Нужно ли уменьшать изображение и во сколько раз. */
export function planDownscale(width: number, height: number): { needed: boolean; width: number; height: number } {
  const factor = downscaleFactorFor(width, height);
  return {
    needed: factor < 1,
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/** Первые байты файла — для сигнатуры достаточно двенадцати. */
export async function readFileHead(file: Blob, length = 16): Promise<Uint8Array> {
  const slice = file.slice(0, length);
  return new Uint8Array(await slice.arrayBuffer());
}
