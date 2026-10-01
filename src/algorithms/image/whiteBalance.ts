import type { ImageDataLike } from '../../types/mosaic';

/**
 * Автоматический баланс белого.
 *
 * Зачем он здесь. Снимки при свете экрана или лампы получают сильный
 * цветовой сдвиг: кожа становится фиолетово-розовой, и детектор кожи её не
 * узнаёт. Без лица отключается всё, что делает портрет портретом —
 * экспозиция, глаза, объём. Поэтому баланс идёт первым, ещё до детекции.
 *
 * Метод — «серый мир» с предосторожностями:
 *   - считаем только по средним тонам: тёмный фон и блики не должны решать,
 *     какой цвет считать нейтральным;
 *   - коэффициенты ограничены, чтобы тёплый вечерний свет не превращался
 *     в стерильно-нейтральный;
 *   - сила частичная — убираем сдвиг, а не характер снимка.
 */

export interface WhiteBalanceOptions {
  /** Доля коррекции, 0..1. */
  strength: number;
  /** Пределы усиления канала. */
  minGain: number;
  maxGain: number;
  /** Диапазон яркости пикселей, по которым оценивается сдвиг. */
  lowCut: number;
  highCut: number;
  /**
   * Править только холодный или магентовый сдвиг — когда синий канал выше
   * зелёного. Тёплый свет (закат, лампа накаливания) для кожи естественен,
   * и его «исправление» уводит кожу в серые детали.
   */
  onlyCoolCast: boolean;
}

export const WHITE_BALANCE_DEFAULTS: WhiteBalanceOptions = {
  strength: 0.8,
  minGain: 0.72,
  maxGain: 1.4,
  lowCut: 28,
  highCut: 235,
  onlyCoolCast: true,
};

export interface WhiteBalanceReport {
  /** Усиление по каналам, которое было применено. */
  gains: [number, number, number];
  /** Насколько сильным был сдвиг: 0 — нейтральный кадр. */
  cast: number;
  applied: boolean;
}

/** Оценивает сдвиг по средним тонам и возвращает усиление каналов. */
export function estimateWhiteBalance(
  image: ImageDataLike,
  options: Partial<WhiteBalanceOptions> = {},
): WhiteBalanceReport {
  const settings = { ...WHITE_BALANCE_DEFAULTS, ...options };
  const { data } = image;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  // Шаг по пикселям: для оценки среднего вся картинка не нужна.
  const step = Math.max(1, Math.floor(data.length / 4 / 60000)) * 4;
  for (let p = 0; p < data.length; p += step) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma < settings.lowCut || luma > settings.highCut) continue;
    sumR += r;
    sumG += g;
    sumB += b;
    count++;
  }

  if (count < 100) return { gains: [1, 1, 1], cast: 0, applied: false };

  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;
  const gray = (meanR + meanG + meanB) / 3;

  const raw: [number, number, number] = [gray / meanR, gray / meanG, gray / meanB];
  const cast = Math.max(...raw.map((gain) => Math.abs(gain - 1)));

  // Тёплый кадр (синий ниже зелёного) не трогаем: это не сдвиг, а свет.
  if (settings.onlyCoolCast && meanB < meanG * 1.02) {
    return { gains: [1, 1, 1], cast: Math.round(cast * 1000) / 1000, applied: false };
  }

  const gains = raw.map((gain) => {
    const limited = Math.max(settings.minGain, Math.min(settings.maxGain, gain));
    return 1 + (limited - 1) * settings.strength;
  }) as [number, number, number];

  return { gains, cast: Math.round(cast * 1000) / 1000, applied: cast > 0.04 };
}

/** Применяет усиление каналов на месте. */
export function applyWhiteBalance(image: ImageDataLike, gains: [number, number, number]): void {
  const data = image.data as Uint8ClampedArray;
  const [gr, gg, gb] = gains;
  if (Math.abs(gr - 1) < 0.005 && Math.abs(gg - 1) < 0.005 && Math.abs(gb - 1) < 0.005) return;

  const lutR = new Uint8ClampedArray(256);
  const lutG = new Uint8ClampedArray(256);
  const lutB = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lutR[v] = Math.min(255, Math.round(v * gr));
    lutG[v] = Math.min(255, Math.round(v * gg));
    lutB[v] = Math.min(255, Math.round(v * gb));
  }

  for (let p = 0; p < data.length; p += 4) {
    data[p] = lutR[data[p]];
    data[p + 1] = lutG[data[p + 1]];
    data[p + 2] = lutB[data[p + 2]];
  }
}

/** Оценка и применение за один вызов. */
export function autoWhiteBalance(image: ImageDataLike, options: Partial<WhiteBalanceOptions> = {}): WhiteBalanceReport {
  const report = estimateWhiteBalance(image, options);
  if (report.applied) applyWhiteBalance(image, report.gains);
  return report;
}

/**
 * Баланс белого с якорем по коже.
 *
 * «Серый мир» на портрете крупным планом делает кожу серой: кожа и есть
 * среднее кадра. Здесь опора другая — сама кожа. Средний цвет пикселей,
 * похожих на кожу (с ослабленным порогом, чтобы поймать и сдвинутую),
 * приводится к типичному соотношению каналов кожи. Синий гасится, красный
 * остаётся — ровно то, что нужно при свете экрана.
 */
export interface SkinBalanceOptions {
  strength: number;
  minGain: number;
  maxGain: number;
  /** Минимальная доля кадра, похожая на кожу, чтобы якорь считался надёжным. */
  minCoverage: number;
}

export const SKIN_BALANCE_DEFAULTS: SkinBalanceOptions = {
  strength: 0.65,
  minGain: 0.7,
  maxGain: 1.3,
  minCoverage: 0.05,
};

/** Типичное соотношение каналов кожи относительно красного. */
const SKIN_RATIO_G = 0.8;
const SKIN_RATIO_B = 0.7;

export function skinAnchoredBalance(
  image: ImageDataLike,
  isSkin: (r: number, g: number, b: number) => boolean,
  options: Partial<SkinBalanceOptions> = {},
): WhiteBalanceReport {
  const settings = { ...SKIN_BALANCE_DEFAULTS, ...options };
  const { data } = image;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  let total = 0;

  const step = Math.max(1, Math.floor(data.length / 4 / 60000)) * 4;
  for (let p = 0; p < data.length; p += step) {
    total++;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    if (!isSkin(r, g, b)) continue;
    sumR += r;
    sumG += g;
    sumB += b;
    count++;
  }

  if (count === 0 || count / total < settings.minCoverage) {
    return { gains: [1, 1, 1], cast: 0, applied: false };
  }

  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;

  const raw: [number, number, number] = [1, (SKIN_RATIO_G * meanR) / meanG, (SKIN_RATIO_B * meanR) / meanB];
  const cast = Math.max(...raw.map((gain) => Math.abs(gain - 1)));

  // Тёплая кожа (синий уже ниже нормы) — не трогаем: это свет, а не сдвиг.
  if (raw[2] >= 0.97) return { gains: [1, 1, 1], cast: Math.round(cast * 1000) / 1000, applied: false };

  const gains = raw.map((gain) => {
    const limited = Math.max(settings.minGain, Math.min(settings.maxGain, gain));
    return 1 + (limited - 1) * settings.strength;
  }) as [number, number, number];

  applyWhiteBalance(image, gains);
  return { gains, cast: Math.round(cast * 1000) / 1000, applied: true };
}
