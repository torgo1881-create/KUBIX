import { luminance } from '../image/edges';
import type { ImageDataLike, RGB } from '../../types/mosaic';
import type { Palette, PaletteColor, PreparedPalette } from '../../types/palette';

/**
 * Согласование тона фотографии с тональной лестницей палитры.
 *
 * Гипотеза этапа 10. Плоские пятна и «ступени» на коже возникают не потому,
 * что округление цвета плохое, а потому что яркости снимка и яркости
 * доступных деталей живут в разных диапазонах. Если лицо занимает узкую
 * полосу яркости, а палитра раскидана по всей шкале, то вся кожа сваливается
 * в один-два уровня — сколько цветов ни дай.
 *
 * Здесь мы двигаем не палитру (она физическая и неприкосновенна), а тон
 * снимка: так, чтобы уровни палитры попадали в реально занятые фотографией
 * участки гистограммы.
 *
 * Работаем в яркости Rec. 709 и масштабируем RGB отношением: тон меняется,
 * цветность остаётся.
 */

export interface ToneMapOptions {
  /**
   * Сила согласования: 0 — исходный тон, 1 — полное выравнивание по
   * уровням палитры. Промежуточные значения безопаснее — полное
   * выравнивание выглядит как передержанная гистограмма.
   */
  strength: number;
  /**
   * Считать гистограмму только по этой маске (например, по лицу).
   * Тогда лестница подгоняется под лицо, а не под фон.
   */
  mask?: Uint8Array | null;
  /** Ширина маски в пикселях, если она задана в другом разрешении. */
  maskWidth?: number;
  maskHeight?: number;
  /** Не выводить яркость за эти пределы. */
  minOutput?: number;
  maxOutput?: number;
  /**
   * Максимальный сдвиг яркости в единицах 0..255.
   *
   * Без ограничения коррекция свободно двигает тон и заметно портит ΔE.
   * Лимит оставляет ровно столько свободы, сколько нужно для рельефа.
   */
  maxShift?: number;
}

function tonePaletteColors(palette: Palette | PaletteColor[] | PreparedPalette): PaletteColor[] {
  return Array.isArray(palette) ? palette : palette.colors;
}

/** Яркости деталей палитры по возрастанию. */
export function paletteLuminanceLadder(palette: Palette | PaletteColor[] | PreparedPalette): number[] {
  return tonePaletteColors(palette)
    .map((color) => luminance(color.rgb[0], color.rgb[1], color.rgb[2]))
    .sort((a, b) => a - b);
}

/** Гистограмма яркости, опционально только внутри маски. */
function luminanceHistogram(image: ImageDataLike, options: ToneMapOptions): Uint32Array {
  const histogram = new Uint32Array(256);
  const { width, height, data } = image;
  const mask = options.mask ?? null;
  const maskWidth = options.maskWidth ?? width;
  const maskHeight = options.maskHeight ?? height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask) {
        const mx = Math.min(maskWidth - 1, Math.floor((x / width) * maskWidth));
        const my = Math.min(maskHeight - 1, Math.floor((y / height) * maskHeight));
        if (!mask[my * maskWidth + mx]) continue;
      }
      const index = (y * width + x) * 4;
      histogram[Math.round(luminance(data[index], data[index + 1], data[index + 2]))]++;
    }
  }

  return histogram;
}

/**
 * Строит таблицу 256 → 256, которая тянет яркости снимка к уровням палитры.
 *
 * Для каждого уровня палитры берётся перцентиль (i + 0.5) / K: значение
 * яркости, ниже которого лежит эта доля пикселей. Оно и становится якорем,
 * который переезжает точно на уровень палитры. Между якорями — линейная
 * интерполяция, поэтому монотонность сохраняется: что было светлее,
 * останется светлее.
 */
export function buildToneLut(
  image: ImageDataLike,
  palette: Palette | PaletteColor[] | PreparedPalette,
  options: ToneMapOptions,
): Uint8ClampedArray {
  const ladder = paletteLuminanceLadder(palette);
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = i;

  const strength = Math.max(0, Math.min(1, options.strength));
  if (strength === 0 || ladder.length < 2) return lut;

  const histogram = luminanceHistogram(image, options);
  const total = histogram.reduce((sum, value) => sum + value, 0);
  if (total === 0) return lut;

  // Перцентильные якоря исходника.
  const cdf = new Float64Array(256);
  let running = 0;
  for (let i = 0; i < 256; i++) {
    running += histogram[i];
    cdf[i] = running / total;
  }

  const anchorsFrom: number[] = [];
  const anchorsTo: number[] = [];

  for (let level = 0; level < ladder.length; level++) {
    const percentile = (level + 0.5) / ladder.length;
    let value = 0;
    while (value < 255 && cdf[value] < percentile) value++;
    anchorsFrom.push(value);
    anchorsTo.push(ladder[level]);
  }

  // Края шкалы фиксируем, чтобы чёрное осталось чёрным, а белое — белым.
  anchorsFrom.unshift(0);
  anchorsTo.unshift(Math.min(ladder[0], anchorsFrom[1]));
  anchorsFrom.push(255);
  anchorsTo.push(Math.max(ladder[ladder.length - 1], anchorsFrom[anchorsFrom.length - 2]));

  const minOutput = options.minOutput ?? 0;
  const maxOutput = options.maxOutput ?? 255;

  for (let value = 0; value < 256; value++) {
    // Ищем отрезок между якорями.
    let segment = 0;
    while (segment < anchorsFrom.length - 2 && value > anchorsFrom[segment + 1]) segment++;

    const fromA = anchorsFrom[segment];
    const fromB = anchorsFrom[segment + 1];
    const toA = anchorsTo[segment];
    const toB = anchorsTo[segment + 1];

    const t = fromB === fromA ? 0 : (value - fromA) / (fromB - fromA);
    const mapped = toA + (toB - toA) * t;
    let blended = value + (mapped - value) * strength;

    // Ограничение сдвига: коррекция не может увести тон дальше, чем разрешено.
    if (options.maxShift !== undefined) {
      const shift = blended - value;
      const limited = Math.max(-options.maxShift, Math.min(options.maxShift, shift));
      blended = value + limited;
    }

    lut[value] = Math.max(minOutput, Math.min(maxOutput, blended));
  }

  return lut;
}

/** Применяет тональную таблицу, сохраняя цветность (масштабированием RGB). */
export function applyToneLut(image: ImageDataLike, lut: Uint8ClampedArray): void {
  const data = image.data as Uint8ClampedArray;

  for (let p = 0; p < data.length; p += 4) {
    const y = luminance(data[p], data[p + 1], data[p + 2]);
    if (y < 1) continue;

    const target = lut[Math.round(y)];
    const ratio = target / y;

    data[p] = Math.max(0, Math.min(255, data[p] * ratio));
    data[p + 1] = Math.max(0, Math.min(255, data[p + 1] * ratio));
    data[p + 2] = Math.max(0, Math.min(255, data[p + 2] * ratio));
  }
}

/**
 * Локальный контраст: усиление отличия пикселя от местного среднего.
 *
 * Гипотеза: крупные плоские области возникают там, где перепад яркости
 * меньше шага палитры. Подняв локальный контраст до усреднения, мы даём
 * округлению повод выбрать разные детали — без диффузии ошибки и без
 * «крупы», потому что решение остаётся детерминированным.
 *
 * Радиус берётся крупным (доля кадра): мелкий радиус даёт ореолы.
 */
export function enhanceLocalContrast(image: ImageDataLike, amount: number, radiusFraction = 0.12): void {
  if (amount <= 0) return;

  const { width, height, data } = image;
  const radius = Math.max(2, Math.round(Math.min(width, height) * radiusFraction));

  // Яркость и её интегральное изображение — чтобы локальное среднее считалось за O(1).
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = luminance(data[p], data[p + 1], data[p + 2]);
  }

  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += luma[y * width + x];
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }

  const areaMean = (x0: number, y0: number, x1: number, y1: number) => {
    const left = Math.max(0, x0);
    const top = Math.max(0, y0);
    const right = Math.min(width, x1);
    const bottom = Math.min(height, y1);
    const count = (right - left) * (bottom - top);
    if (count <= 0) return 0;

    const stride = width + 1;
    const sum =
      integral[bottom * stride + right] -
      integral[top * stride + right] -
      integral[bottom * stride + left] +
      integral[top * stride + left];
    return sum / count;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const local = areaMean(x - radius, y - radius, x + radius + 1, y + radius + 1);
      const value = luma[index];
      const boosted = value + amount * (value - local);

      const p = index * 4;
      if (value < 1) continue;
      const ratio = Math.max(0, Math.min(255, boosted)) / value;

      data[p] = Math.max(0, Math.min(255, data[p] * ratio));
      data[p + 1] = Math.max(0, Math.min(255, data[p + 1] * ratio));
      data[p + 2] = Math.max(0, Math.min(255, data[p + 2] * ratio));
    }
  }
}

/**
 * Применяет тональную таблицу только внутри маски, с мягким краем.
 *
 * Зачем: подгонка тона под лицо (C7) улучшала рельеф кожи, но пересвечивала
 * фон — LUT строился по лицу, а применялся ко всему кадру. Здесь коррекция
 * ограничена лицом, поэтому фон остаётся таким же точным, как в baseline.
 *
 * Край размывается, иначе на границе лица появляется видимая ступень.
 */
export function applyToneLutMasked(
  image: ImageDataLike,
  lut: Uint8ClampedArray,
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  feather = 1.5,
): void {
  const { width, height, data } = image as { width: number; height: number; data: Uint8ClampedArray };

  // Размываем маску в её собственном разрешении: дёшево и достаточно.
  const soft = new Float32Array(mask.length);
  const radius = Math.max(1, Math.round(feather));
  for (let y = 0; y < maskHeight; y++) {
    for (let x = 0; x < maskWidth; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= maskWidth || ny >= maskHeight) continue;
          sum += mask[ny * maskWidth + nx];
          count++;
        }
      }
      soft[y * maskWidth + x] = count ? sum / count : 0;
    }
  }

  for (let y = 0; y < height; y++) {
    const my = Math.min(maskHeight - 1, Math.floor((y / height) * maskHeight));
    for (let x = 0; x < width; x++) {
      const mx = Math.min(maskWidth - 1, Math.floor((x / width) * maskWidth));
      const weight = soft[my * maskWidth + mx];
      if (weight <= 0) continue;

      const p = (y * width + x) * 4;
      const value = luminance(data[p], data[p + 1], data[p + 2]);
      if (value < 1) continue;

      const target = lut[Math.round(value)];
      // Смешиваем пропорционально мягкой маске — край получается плавным.
      const ratio = (value + (target - value) * weight) / value;

      data[p] = Math.max(0, Math.min(255, data[p] * ratio));
      data[p + 1] = Math.max(0, Math.min(255, data[p + 1] * ratio));
      data[p + 2] = Math.max(0, Math.min(255, data[p + 2] * ratio));
    }
  }
}

/** Маска лица в разрешении сетки — по областям карты весов. */
export function faceMaskFromRegions(region: Uint8Array, labels: readonly string[], wanted: string[]): Uint8Array {
  const mask = new Uint8Array(region.length);
  const set = new Set(wanted);
  for (let i = 0; i < region.length; i++) {
    if (set.has(labels[region[i]])) mask[i] = 1;
  }
  return mask;
}

/**
 * Целевые доли уровней палитры, снятые с готового набора.
 *
 * Сравнение с реальной инструкцией показало, что коммерческая мозаика
 * распределяет детали иначе, чем наш конвейер: у нас больше половины
 * площади уходит в два тёмных уровня, у эталона — треть, а основная масса
 * приходится на светлые полутона. Из-за этого лицо у нас проваливается в
 * тень и сливается с волосами.
 *
 * Доли идут от самого светлого уровня к самому тёмному.
 */
export const REFERENCE_TONE_SHARES = [0.149, 0.276, 0.256, 0.165, 0.153];

/**
 * Приведение яркостей снимка к целевому распределению по уровням палитры
 * (histogram specification).
 *
 * Для каждой границы между уровнями находим перцентиль исходной гистограммы,
 * который должен на неё попасть, и тянем его к середине уровня. Между
 * границами — линейная интерполяция, поэтому порядок яркостей сохраняется:
 * что было светлее, останется светлее.
 */
export function buildDistributionLut(
  image: ImageDataLike,
  palette: Palette | PaletteColor[] | PreparedPalette,
  shares: number[] = REFERENCE_TONE_SHARES,
  strength = 1,
): Uint8ClampedArray {
  const ladder = paletteLuminanceLadder(palette); // по возрастанию яркости
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = i;

  if (ladder.length < 2 || strength <= 0) return lut;

  // Доли приходят от светлого к тёмному — разворачиваем под лестницу.
  const ordered = [...shares].reverse().slice(0, ladder.length);
  const total = ordered.reduce((sum, value) => sum + value, 0) || 1;
  const normalized = ordered.map((value) => value / total);

  const histogram = luminanceHistogram(image, { strength: 0, mask: null });
  const pixels = histogram.reduce((sum, value) => sum + value, 0);
  if (pixels === 0) return lut;

  const cdf = new Float64Array(256);
  let running = 0;
  for (let i = 0; i < 256; i++) {
    running += histogram[i];
    cdf[i] = running / pixels;
  }

  // Якоря: середина каждой целевой доли переезжает на свой уровень палитры.
  const from: number[] = [0];
  const to: number[] = [0];
  let cumulative = 0;

  for (let level = 0; level < ladder.length; level++) {
    const target = cumulative + normalized[level] / 2;
    cumulative += normalized[level];

    let value = 0;
    while (value < 255 && cdf[value] < target) value++;

    // Якоря обязаны идти по возрастанию, иначе кривая перестанет быть монотонной.
    if (value <= from[from.length - 1]) value = Math.min(255, from[from.length - 1] + 1);
    from.push(value);
    to.push(ladder[level]);
  }

  from.push(255);
  to.push(255);

  for (let value = 0; value < 256; value++) {
    let segment = 0;
    while (segment < from.length - 2 && value > from[segment + 1]) segment++;

    const spanFrom = from[segment + 1] - from[segment];
    const t = spanFrom === 0 ? 0 : (value - from[segment]) / spanFrom;
    const mapped = to[segment] + (to[segment + 1] - to[segment]) * t;

    lut[value] = value + (mapped - value) * strength;
  }

  return lut;
}

/**
 * Тональный баланс на уровне сетки.
 *
 * Кривая, построенная по гистограмме пикселей, не даёт нужного результата:
 * усреднение по ячейкам меняет распределение, и до квантования доходит уже
 * другая гистограмма. Поэтому баланс считается ровно по тем значениям,
 * которые будут округляться до деталей, — по средним цветам ячеек.
 */
export function balanceGridTone(
  grid: { cells: { rgb: RGB; hex: string }[] },
  palette: Palette | PaletteColor[] | PreparedPalette,
  shares: number[] = REFERENCE_TONE_SHARES,
  strength = 1,
): void {
  const ladder = paletteLuminanceLadder(palette);
  if (ladder.length < 2 || strength <= 0) return;

  const ordered = [...shares].reverse().slice(0, ladder.length);
  const total = ordered.reduce((sum, value) => sum + value, 0) || 1;
  const normalized = ordered.map((value) => value / total);

  const histogram = new Uint32Array(256);
  for (const cell of grid.cells) {
    histogram[Math.round(luminance(cell.rgb[0], cell.rgb[1], cell.rgb[2]))]++;
  }

  const count = grid.cells.length;
  const cdf = new Float64Array(256);
  let running = 0;
  for (let i = 0; i < 256; i++) {
    running += histogram[i];
    cdf[i] = running / count;
  }

  const from: number[] = [0];
  const to: number[] = [0];
  let cumulative = 0;

  for (let level = 0; level < ladder.length; level++) {
    const target = cumulative + normalized[level] / 2;
    cumulative += normalized[level];

    let value = 0;
    while (value < 255 && cdf[value] < target) value++;
    if (value <= from[from.length - 1]) value = Math.min(255, from[from.length - 1] + 1);

    from.push(value);
    to.push(ladder[level]);
  }
  from.push(255);
  to.push(255);

  const lut = new Float32Array(256);
  for (let value = 0; value < 256; value++) {
    let segment = 0;
    while (segment < from.length - 2 && value > from[segment + 1]) segment++;
    const span = from[segment + 1] - from[segment];
    const t = span === 0 ? 0 : (value - from[segment]) / span;
    const mapped = to[segment] + (to[segment + 1] - to[segment]) * t;
    lut[value] = value + (mapped - value) * strength;
  }

  const hex = (rgb: RGB) =>
    '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase();

  for (const cell of grid.cells) {
    const y = luminance(cell.rgb[0], cell.rgb[1], cell.rgb[2]);
    if (y < 1) continue;
    const ratio = lut[Math.round(y)] / y;
    cell.rgb = [
      Math.max(0, Math.min(255, cell.rgb[0] * ratio)),
      Math.max(0, Math.min(255, cell.rgb[1] * ratio)),
      Math.max(0, Math.min(255, cell.rgb[2] * ratio)),
    ] as RGB;
    cell.hex = hex(cell.rgb);
  }
}
