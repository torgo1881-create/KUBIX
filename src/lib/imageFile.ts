import {
  planDownscale,
  readFileHead,
  validateFileBytes,
  validateFileMeta,
  validateImageSize,
} from './fileValidation';
import type { SourceImage } from '../types/mosaic';

export interface FileCheck {
  ok: boolean;
  error?: string;
}

/**
 * Быстрая проверка по метаданным. Полная проверка (включая сигнатуру файла)
 * выполняется в loadImageFile — там уже есть содержимое.
 */
export function checkFile(file: File): FileCheck {
  const result = validateFileMeta(file);
  return { ok: result.ok, error: result.error };
}

/** Первый подходящий файл из drop-события (включая случай с DataTransferItem). */
export function pickFileFromDataTransfer(dataTransfer: DataTransfer): File | null {
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return dataTransfer.files[0];
  }
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/**
 * Загружает файл и приводит его к безопасному виду.
 *
 * Порядок важен: сначала метаданные, потом сигнатура первых байтов (чтобы
 * .png с исполняемым файлом внутри не дошёл до декодера), потом размеры, и
 * только потом — уменьшение слишком больших снимков. Так браузер не пытается
 * держать в памяти 40-мегапиксельную картинку целиком дольше необходимого.
 */
export async function loadImageFile(file: File): Promise<SourceImage> {
  const head = await readFileHead(file);
  const validation = validateFileBytes(file, head);
  if (!validation.ok) throw new Error(validation.error ?? 'Файл не подходит.');

  const url = URL.createObjectURL(file);

  try {
    const element = await decodeImage(url);
    const naturalWidth = element.naturalWidth;
    const naturalHeight = element.naturalHeight;

    const sizeCheck = validateImageSize(naturalWidth, naturalHeight);
    // Слишком мелкое отклоняем, слишком крупное — уменьшаем.
    if (!sizeCheck.ok && sizeCheck.code === 'image_too_small') {
      throw new Error(sizeCheck.error ?? 'Изображение слишком мелкое.');
    }

    const plan = planDownscale(naturalWidth, naturalHeight);
    let source: HTMLImageElement | HTMLCanvasElement = element;
    let width = naturalWidth;
    let height = naturalHeight;

    if (plan.needed) {
      const canvas = document.createElement('canvas');
      canvas.width = plan.width;
      canvas.height = plan.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D недоступен в этом браузере');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(element, 0, 0, plan.width, plan.height);
      source = canvas;
      width = plan.width;
      height = plan.height;
      // Исходный объект больше не нужен: держать его в памяти незачем.
      URL.revokeObjectURL(url);
    }

    return {
      file,
      url: plan.needed ? '' : url,
      element: source,
      width,
      height,
      sizeBytes: file.size,
      type: file.type || `image/${validation.format}`,
      name: file.name,
      downscaledFrom: plan.needed ? { width: naturalWidth, height: naturalHeight } : undefined,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.decoding = 'async';
    element.onload = () => {
      if (!element.naturalWidth || !element.naturalHeight) {
        reject(new Error('Не удалось прочитать размеры изображения.'));
        return;
      }
      resolve(element);
    };
    element.onerror = () => reject(new Error('Файл не открывается как изображение. Возможно, он повреждён.'));
    element.src = url;
  });
}

export function releaseImage(image: SourceImage | null | undefined): void {
  if (image?.url) URL.revokeObjectURL(image.url);
}
