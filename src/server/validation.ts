import { LIMITS } from '../config/limits';
import { MOSAIC_SIZES } from '../config/mosaic';
import { MOSAIC_MODE_IDS } from '../config/quality';
import { estimateJobMemory } from '../lib/memoryGuard';

/**
 * Серверная проверка запроса на генерацию.
 *
 * Клиент уже всё проверил — но клиенту нельзя верить: запрос может прийти
 * из curl. Здесь те же лимиты применяются заново, поверх whitelist-подхода:
 * разрешено только то, что перечислено в конфиге.
 */

export interface GenerationRequest {
  sizeId?: unknown;
  modeId?: unknown;
  paletteId?: unknown;
  enforcePieceLimits?: unknown;
  imageBytes?: unknown;
  imageWidth?: unknown;
  imageHeight?: unknown;
  mimeType?: unknown;
}

export interface NormalizedRequest {
  sizeId: string;
  cols: number;
  rows: number;
  modeId: string;
  paletteId: string | null;
  enforcePieceLimits: boolean;
  imageBytes: number;
  imageWidth: number;
  imageHeight: number;
  mimeType: string;
  estimatedMemoryBytes: number;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: NormalizedRequest }
  | { ok: false; issues: ValidationIssue[] };

export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateGenerationRequest(
  input: GenerationRequest,
  allowedPaletteIds: string[],
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (field: string, code: string, message: string) => issues.push({ field, code, message });

  /* --- размер сетки: только из белого списка --------------------------- */
  const preset = MOSAIC_SIZES.find((size) => size.id === input.sizeId);
  if (!preset) {
    add('sizeId', 'unknown_size', `Допустимые размеры: ${MOSAIC_SIZES.map((size) => size.id).join(', ')}`);
  }

  /* --- режим ------------------------------------------------------------ */
  const modeId = typeof input.modeId === 'string' ? input.modeId : 'standard';
  if (!MOSAIC_MODE_IDS.includes(modeId as (typeof MOSAIC_MODE_IDS)[number])) {
    add('modeId', 'unknown_mode', `Допустимые режимы: ${MOSAIC_MODE_IDS.join(', ')}`);
  }

  /* --- палитра ---------------------------------------------------------- */
  const paletteId = input.paletteId === null || input.paletteId === undefined ? null : input.paletteId;
  if (paletteId !== null && (typeof paletteId !== 'string' || !allowedPaletteIds.includes(paletteId))) {
    add('paletteId', 'unknown_palette', `Допустимые палитры: ${allowedPaletteIds.join(', ')}`);
  }

  /* --- файл ------------------------------------------------------------- */
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.toLowerCase() : '';
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    add('mimeType', 'unsupported_type', 'Подойдут JPG, JPEG, PNG или WEBP.');
  }

  if (!isFiniteNumber(input.imageBytes) || input.imageBytes <= 0) {
    add('imageBytes', 'invalid', 'Не указан размер файла.');
  } else if (input.imageBytes > LIMITS.maxFileBytes) {
    add('imageBytes', 'file_too_large', `Файл больше ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)} МБ.`);
  }

  /* --- размеры изображения --------------------------------------------- */
  const width = isFiniteNumber(input.imageWidth) ? input.imageWidth : 0;
  const height = isFiniteNumber(input.imageHeight) ? input.imageHeight : 0;

  if (width < LIMITS.minImageSide || height < LIMITS.minImageSide) {
    add('imageWidth', 'too_small', `Минимальный размер — ${LIMITS.minImageSide} px по стороне.`);
  }
  if (width > LIMITS.maxImageSide || height > LIMITS.maxImageSide) {
    add('imageWidth', 'side_too_large', `Максимальная сторона — ${LIMITS.maxImageSide} px.`);
  }
  if (width * height > LIMITS.maxImagePixels) {
    add('imageWidth', 'too_many_pixels', `Максимум — ${Math.round(LIMITS.maxImagePixels / 1_000_000)} Мп.`);
  }

  if (issues.length > 0 || !preset) return { ok: false, issues };

  /* --- бюджет памяти ---------------------------------------------------- */
  const estimate = estimateJobMemory({
    cols: preset.cols,
    rows: preset.rows,
    sampleWidth: Math.min(width, 1536),
    sampleHeight: Math.min(height, 1536),
    outputSize: 2048,
  });

  if (!estimate.withinBudget) {
    return {
      ok: false,
      issues: [{ field: 'sizeId', code: 'memory_budget', message: 'Задача не помещается в бюджет памяти.' }],
    };
  }

  return {
    ok: true,
    value: {
      sizeId: preset.id,
      cols: preset.cols,
      rows: preset.rows,
      modeId,
      paletteId: (paletteId as string | null) ?? null,
      enforcePieceLimits: input.enforcePieceLimits !== false,
      imageBytes: input.imageBytes as number,
      imageWidth: width,
      imageHeight: height,
      mimeType,
      estimatedMemoryBytes: estimate.bytes,
    },
  };
}
