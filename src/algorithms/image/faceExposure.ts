import { luminance } from './edges';
import type { FaceBox } from '../face/faceDetection';
import type { ImageDataLike } from '../../types/mosaic';

/**
 * Экспозиция лица.
 *
 * Сравнение с готовыми наборами показало главную причину вялого результата:
 * на снимках в помещении медиана яркости лица опускается до 90–110 из 255,
 * кожа садится на тёмный уровень палитры и сливается с волосами. Силуэт
 * пропадает.
 *
 * Здесь тёмное лицо подтягивается к нижней границе комфортного диапазона.
 * Светлое не трогается вовсе: на снимках, где лицо и так яркое, коррекция
 * только выбивает света.
 */

/** Ниже этого значения лицо считается тёмным и поднимается. */
export const FACE_LUMINANCE_FLOOR = 132;

/** Медиана яркости внутри найденных лиц. Ноль — лиц нет. */
export function faceLuminanceMedian(image: ImageDataLike, faces: FaceBox[]): number {
  if (faces.length === 0) return 0;

  const values: number[] = [];
  const { width, height, data } = image;

  for (const face of faces) {
    // Берём центральную часть рамки: края захватывают волосы и фон.
    const x0 = Math.max(0, Math.round(face.x + face.width * 0.2));
    const x1 = Math.min(width, Math.round(face.x + face.width * 0.8));
    const y0 = Math.max(0, Math.round(face.y + face.height * 0.25));
    const y1 = Math.min(height, Math.round(face.y + face.height * 0.85));

    // Шаг по сетке: полное сканирование лица здесь избыточно.
    const step = Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) / 48));
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const index = (y * width + x) * 4;
        values.push(luminance(data[index], data[index + 1], data[index + 2]));
      }
    }
  }

  if (values.length < 50) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

/**
 * Поднимает яркость гамма-кривой так, чтобы медиана переехала на цель.
 *
 * Именно кривой, а не умножением: умножение выбивает света, а степенная
 * кривая поднимает тени и середину, оставляя белое белым.
 */
export function liftExposure(image: ImageDataLike, median: number, target: number): void {
  if (median <= 0 || target <= 0 || median >= target) return;

  const power = Math.log(Math.min(0.98, target / 255)) / Math.log(Math.max(0.02, median / 255));
  const lut = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value++) {
    lut[value] = Math.round(255 * Math.min(1, Math.pow(value / 255, power)));
  }

  const data = image.data as Uint8ClampedArray;
  for (let p = 0; p < data.length; p += 4) {
    data[p] = lut[data[p]];
    data[p + 1] = lut[data[p + 1]];
    data[p + 2] = lut[data[p + 2]];
  }
}

/** Подтягивает тёмное лицо. Возвращает применённую медиану или 0. */
export function liftDarkFace(
  image: ImageDataLike,
  faces: FaceBox[],
  floor = FACE_LUMINANCE_FLOOR,
): number {
  const median = faceLuminanceMedian(image, faces);
  if (median <= 0 || median >= floor) return 0;
  liftExposure(image, median, floor);
  return median;
}
