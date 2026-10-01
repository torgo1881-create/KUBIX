import { luminance } from './edges';
import type { FaceRegions } from '../face/faceRegions';
import type { ImageDataLike } from '../../types/mosaic';

/**
 * Усиление глаз перед усреднением.
 *
 * Почему это вообще нужно. При сетке 64×96 ячейка — примерно 8 мм, и если
 * лицо занимает половину кадра, глаз по ширине укладывается в три ячейки, а
 * зрачок — в одну. Всё решает, попадёт зрачок в ячейку целиком или
 * размажется между двумя: в первом случае деталь будет чёрной, во втором —
 * серой, и глаз «слепнет».
 *
 * Поэтому работаем до усреднения и только внутри маски глаз:
 *   1. локальный контраст — разница между зрачком и веком становится больше
 *      шага палитры и переживает округление;
 *   2. смещение к тёмному — тёмные пиксели тянутся ещё темнее, поэтому при
 *      усреднении зрачок «выигрывает» ячейку, а не разбавляется белком.
 *
 * Мы не дорисовываем глаза и не красим зрачок принудительно: всё, что
 * усиливается, уже есть на снимке. Если глаза закрыты или размыты, эффект
 * будет слабым — и это правильно.
 */

export interface EyeBoostSettings {
  /** Усиление локального контраста внутри маски, 0..2. */
  contrast: number;
  /** Смещение тёмных пикселей к чёрному, 0..1. */
  darkBias: number;
  /** Во сколько раз область вокруг глаза больше самого глаза. */
  radiusScale: number;
  /** Захватывать ли брови: они держат «взгляд» не меньше самих глаз. */
  includeBrows: boolean;
}

export const EYE_BOOST_DEFAULTS: EyeBoostSettings = {
  contrast: 0.9,
  darkBias: 0.35,
  radiusScale: 1.6,
  includeBrows: true,
};

/**
 * Мягкая маска вокруг глаз. Значение 1 — центр глаза, 0 — вне области.
 * Края сглажены, иначе на границе появится видимая ступень.
 */
export function buildEyeMask(
  width: number,
  height: number,
  faces: FaceRegions[],
  settings: Pick<EyeBoostSettings, 'radiusScale' | 'includeBrows'> = EYE_BOOST_DEFAULTS,
): Float32Array | null {
  const mask = new Float32Array(width * height);
  let painted = 0;

  const stamp = (cx: number, cy: number, rx: number, ry: number, strength: number) => {
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(width - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(height - 1, Math.ceil(cy + ry));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 1) continue;

        // Плавный спад к краю: 1 в центре, 0 на границе эллипса.
        const value = strength * (1 - distance * distance);
        const index = y * width + x;
        if (value > mask[index]) mask[index] = value;
        painted++;
      }
    }
  };

  for (const face of faces) {
    const faceHeight = face.face.height;

    for (const eye of face.eyes) {
      // Детектор уже дал геометрию глаза — расширяем её, чтобы захватить
      // веко и ресницы, которые и держат форму взгляда.
      const rx = Math.max(2, eye.rx * settings.radiusScale);
      const ry = Math.max(2, eye.ry * settings.radiusScale);
      stamp(eye.cx, eye.cy, rx, ry, 1);

      if (settings.includeBrows) {
        // Бровь чуть выше глаза и шире его.
        stamp(eye.cx, eye.cy - faceHeight * 0.075, rx * 1.15, ry * 0.8, 0.75);
      }
    }
  }

  return painted > 0 ? mask : null;
}

/**
 * Локальное среднее по яркости — опора для усиления контраста.
 * Считается через интегральное изображение, поэтому радиус не влияет на цену.
 */
function localMeanPlane(image: ImageDataLike, radius: number): Float32Array {
  const { width, height, data } = image;
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = luminance(data[p], data[p + 1], data[p + 2]);
  }

  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += luma[y * width + x];
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
    }
  }

  const mean = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      const area = (right - left) * (bottom - top);
      const sum =
        integral[bottom * stride + right] -
        integral[top * stride + right] -
        integral[bottom * stride + left] +
        integral[top * stride + left];
      mean[y * width + x] = area > 0 ? sum / area : luma[y * width + x];
    }
  }

  return mean;
}

/**
 * Применяет усиление внутри маски. Меняет сами пиксели, поэтому усреднение
 * увидит уже результат.
 */
export function enhanceEyes(
  image: ImageDataLike,
  mask: Float32Array,
  settings: EyeBoostSettings = EYE_BOOST_DEFAULTS,
  eyeRadius = 0,
): void {
  const { width, data } = image;

  /*
   * Радиус опоры соотносится с размером самого глаза, а не кадра.
   * Это принципиально: при опоре в 10 пикселей на глаз шириной 180
   * локальное среднее почти совпадает с пикселем, и усиление вырождается
   * в ноль — именно так первая версия ничего и не давала.
   */
  const radius = Math.max(3, Math.round((eyeRadius > 0 ? eyeRadius : Math.min(width, image.height) * 0.05) * 0.7));
  const mean = localMeanPlane(image, radius);

  for (let index = 0; index < mask.length; index++) {
    const weight = mask[index];
    if (weight <= 0.01) continue;

    const p = index * 4;
    const value = luminance(data[p], data[p + 1], data[p + 2]);
    if (value < 1) continue;

    // 1. Локальный контраст: отклонение от окрестности усиливается.
    let target = mean[index] + (value - mean[index]) * (1 + settings.contrast * weight);

    // 2. Смещение к тёмному — только для пикселей темнее окрестности.
    if (settings.darkBias > 0 && value < mean[index]) {
      const depth = Math.min(1, (mean[index] - value) / Math.max(1, mean[index]));
      target -= target * settings.darkBias * weight * depth;
    }

    const clamped = Math.max(0, Math.min(255, target));
    const ratio = clamped / value;

    data[p] = Math.max(0, Math.min(255, data[p] * ratio));
    data[p + 1] = Math.max(0, Math.min(255, data[p + 1] * ratio));
    data[p + 2] = Math.max(0, Math.min(255, data[p + 2] * ratio));
  }
}

/** Собирает маску и применяет усиление. Возвращает число затронутых глаз. */
export function boostEyes(
  image: ImageDataLike,
  faces: FaceRegions[],
  settings: Partial<EyeBoostSettings> = {},
): number {
  const resolved = { ...EYE_BOOST_DEFAULTS, ...settings };
  const eyes = faces.reduce((sum, face) => sum + face.eyes.length, 0);
  if (eyes === 0) return 0;

  const mask = buildEyeMask(image.width, image.height, faces, resolved);
  if (!mask) return 0;

  // Средний радиус глаза по кадру — опора для локального контраста.
  let radiusSum = 0;
  let radiusCount = 0;
  for (const face of faces) {
    for (const eye of face.eyes) {
      radiusSum += eye.rx;
      radiusCount++;
    }
  }

  enhanceEyes(image, mask, resolved, radiusCount ? radiusSum / radiusCount : 0);
  return eyes;
}

/**
 * Объём лица: локальный контраст только внутри овала лица.
 *
 * Глобальный локальный контраст (этап 10) уменьшал плоские пятна, но давал
 * ореолы на предметах и фоне. Здесь та же операция ограничена лицом, где
 * ей и место: скулы, надбровные дуги и тень под губой получают рельеф,
 * а стена за спиной остаётся ровной.
 */
export function boostFaceVolume(image: ImageDataLike, faces: FaceRegions[], amount: number): number {
  if (amount <= 0 || faces.length === 0) return 0;

  const { width, height } = image;
  const mask = new Float32Array(width * height);
  let radiusSum = 0;

  for (const face of faces) {
    const { cx, cy, rx, ry } = face.oval;
    radiusSum += rx;
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(width - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(height - 1, Math.ceil(cy + ry));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 1) continue;
        // Плавный край: в центре полная сила, к границе овала — ноль.
        const value = Math.min(1, (1 - distance) * 3);
        const index = y * width + x;
        if (value > mask[index]) mask[index] = value;
      }
    }
  }

  // Опора — четверть лица: крупнее — уходит в общую светотень, мельче — в шум.
  enhanceEyes(image, mask, { contrast: amount, darkBias: 0, radiusScale: 1, includeBrows: false }, (radiusSum / faces.length) * 0.35);
  return faces.length;
}

/**
 * Губы: то же усиление, что для глаз, по области рта.
 * Линия губ — вторая после глаз черта, которая теряется первой.
 */
export function boostMouth(
  image: ImageDataLike,
  faces: FaceRegions[],
  settings: { contrast: number; darkBias: number },
): number {
  const { width, height } = image;
  const mask = new Float32Array(width * height);
  let count = 0;
  let radiusSum = 0;

  for (const face of faces) {
    if (!face.mouth) continue;
    count++;
    const cx = face.mouth.x + face.mouth.width / 2;
    const cy = face.mouth.y + face.mouth.height / 2;
    const rx = face.mouth.width * 0.75;
    const ry = face.mouth.height * 1.1;
    radiusSum += rx;

    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(height - 1, Math.ceil(cy + ry)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(width - 1, Math.ceil(cx + rx)); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 1) continue;
        const value = 1 - distance * distance;
        const index = y * width + x;
        if (value > mask[index]) mask[index] = value;
      }
    }
  }

  if (count === 0) return 0;
  enhanceEyes(image, mask, { ...settings, radiusScale: 1, includeBrows: false }, (radiusSum / count) * 0.5);
  return count;
}
