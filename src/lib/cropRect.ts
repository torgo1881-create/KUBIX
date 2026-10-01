import type { CropRect } from '../types/mosaic';

/**
 * Геометрия кадра без интерфейса: кадр по умолчанию и вырезка в canvas.
 * Кроппер редактирует прямоугольник, а всё остальное приложение работает
 * с ним как с данными.
 */

/**
 * Наибольший прямоугольник нужных пропорций, который помещается в снимок.
 * focusX / focusY — желаемый центр в долях 0..1; кадр прижимается к краям.
 */
export function coverCropRect(
  imageWidth: number,
  imageHeight: number,
  aspect: number,
  focusX = 0.5,
  focusY = 0.5,
): CropRect {
  let width = imageWidth;
  let height = width / aspect;
  if (height > imageHeight) {
    height = imageHeight;
    width = height * aspect;
  }
  const x = Math.min(imageWidth - width, Math.max(0, focusX * imageWidth - width / 2));
  const y = Math.min(imageHeight - height, Math.max(0, focusY * imageHeight - height / 2));
  return { x, y, width, height };
}

/** Одинаковы ли два кадра с точностью до долей пикселя. */
export function sameCropRect(a: CropRect, b: CropRect, tolerance = 0.5): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/** Вырезает кадр в отдельный canvas, уменьшая до maxSize по длинной стороне. */
export function cropToCanvas(
  source: CanvasImageSource,
  crop: CropRect,
  maxSize = 2048,
): HTMLCanvasElement {
  const scale = Math.min(1, maxSize / Math.max(crop.width, crop.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.width * scale));
  canvas.height = Math.max(1, Math.round(crop.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D недоступен в этом браузере');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
