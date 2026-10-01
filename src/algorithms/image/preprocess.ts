import type { ImageDataLike } from '../../types/mosaic';
import type { PreprocessSettings } from '../../config/quality';
import { luminance } from './edges';

/**
 * Предобработка пикселей перед усреднением.
 *
 * Это не CSS-фильтр поверх картинки: значения меняются до того, как считаются
 * средние цвета ячеек, поэтому меняется сам результат — какие детали доживут
 * до сетки и в какие цвета палитры они попадут.
 */

function clampChannel(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/** Копия пикселей: исходный ImageData не портим. */
export function cloneImage(image: ImageDataLike): { width: number; height: number; data: Uint8ClampedArray } {
  return {
    width: image.width,
    height: image.height,
    data: Uint8ClampedArray.from(image.data as ArrayLike<number>),
  };
}

/**
 * Растягивание гистограммы по перцентилям: тени уходят в чёрное,
 * света — в белое, средние тона распрямляются.
 */
export function autoLevels(image: ImageDataLike, lowPercentile = 0.01, highPercentile = 0.99): void {
  const { data } = image;
  const histogram = new Uint32Array(256);
  const pixels = data.length / 4;

  for (let p = 0; p < data.length; p += 4) {
    histogram[Math.round(luminance(data[p], data[p + 1], data[p + 2]))]++;
  }

  const lowTarget = pixels * lowPercentile;
  const highTarget = pixels * highPercentile;
  let low = 0;
  let high = 255;
  let accumulated = 0;

  for (let value = 0; value < 256; value++) {
    accumulated += histogram[value];
    if (accumulated >= lowTarget) {
      low = value;
      break;
    }
  }
  accumulated = 0;
  for (let value = 255; value >= 0; value--) {
    accumulated += histogram[value];
    if (accumulated >= pixels - highTarget) {
      high = value;
      break;
    }
  }

  if (high - low < 16) return; // почти монотонная картинка — не трогаем

  const scale = 255 / (high - low);
  const table = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value++) {
    table[value] = clampChannel(Math.round((value - low) * scale));
  }

  for (let p = 0; p < data.length; p += 4) {
    data[p] = table[data[p]];
    data[p + 1] = table[data[p + 1]];
    data[p + 2] = table[data[p + 2]];
  }
}

/** Контраст вокруг средней точки и насыщенность относительно яркости. */
export function adjustContrastSaturation(image: ImageDataLike, contrast: number, saturation: number): void {
  if (contrast === 1 && saturation === 1) return;
  const { data } = image;

  for (let p = 0; p < data.length; p += 4) {
    let r = data[p];
    let g = data[p + 1];
    let b = data[p + 2];

    if (contrast !== 1) {
      r = 128 + (r - 128) * contrast;
      g = 128 + (g - 128) * contrast;
      b = 128 + (b - 128) * contrast;
    }

    if (saturation !== 1) {
      const luma = luminance(r, g, b);
      r = luma + (r - luma) * saturation;
      g = luma + (g - luma) * saturation;
      b = luma + (b - luma) * saturation;
    }

    data[p] = clampChannel(r);
    data[p + 1] = clampChannel(g);
    data[p + 2] = clampChannel(b);
  }
}

/**
 * Нерезкая маска: к пикселю добавляется его отличие от размытой копии.
 * Возвращает резкость чертам, которые иначе размажет усреднение по ячейке.
 */
export function unsharpMask(image: ImageDataLike, amount: number): void {
  if (amount <= 0) return;
  const { width, height, data } = image;
  const source = Uint8ClampedArray.from(data as ArrayLike<number>);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;

      for (let dy = -1; dy <= 1; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          const index = (sy * width + sx) * 4;
          sumR += source[index];
          sumG += source[index + 1];
          sumB += source[index + 2];
          count++;
        }
      }

      const index = (y * width + x) * 4;
      data[index] = clampChannel(source[index] + amount * (source[index] - sumR / count));
      data[index + 1] = clampChannel(source[index + 1] + amount * (source[index + 1] - sumG / count));
      data[index + 2] = clampChannel(source[index + 2] + amount * (source[index + 2] - sumB / count));
    }
  }
}

/**
 * Коробочное размытие: убирает мелкую рябь до усреднения, из-за чего мозаика
 * получается спокойнее, а крупные формы — чище.
 */
export function boxBlur(image: ImageDataLike, radius: number): void {
  const steps = Math.round(radius);
  if (steps < 1) return;
  const { width, height, data } = image;

  for (let step = 0; step < steps; step++) {
    const source = Uint8ClampedArray.from(data as ArrayLike<number>);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const sy = y + dy;
          if (sy < 0 || sy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx;
            if (sx < 0 || sx >= width) continue;
            const index = (sy * width + sx) * 4;
            r += source[index];
            g += source[index + 1];
            b += source[index + 2];
            count++;
          }
        }
        const index = (y * width + x) * 4;
        data[index] = r / count;
        data[index + 1] = g / count;
        data[index + 2] = b / count;
      }
    }
  }
}

/** Полная предобработка по настройкам режима. Меняет переданные пиксели. */
export function preprocessImage(image: ImageDataLike, settings: PreprocessSettings): void {
  if (settings.autoLevels) autoLevels(image);
  boxBlur(image, (settings.smooth ?? 0) * 3);
  adjustContrastSaturation(image, settings.contrast, settings.saturation);
  unsharpMask(image, settings.sharpen);
}

/** Есть ли вообще что делать — чтобы не копировать пиксели зря. */
export function isPreprocessNeeded(settings: PreprocessSettings): boolean {
  return (
    settings.autoLevels ||
    settings.contrast !== 1 ||
    settings.saturation !== 1 ||
    settings.sharpen > 0 ||
    (settings.smooth ?? 0) > 0
  );
}
