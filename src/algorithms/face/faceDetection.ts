import type { ImageDataLike } from '../../types/mosaic';

/**
 * Поиск лиц без генеративных моделей и без внешних зависимостей.
 *
 * Работает классическая связка: сегментация кожи в YCbCr + RGB-правилах,
 * морфологическая чистка маски, разметка связных компонент и отбор по
 * геометрии. Ни один пиксель изображения при этом не меняется — детектор
 * только читает.
 *
 * Детектор подключаемый: если в проект добавят MediaPipe Face Detector,
 * OpenCV или браузерный FaceDetector API, достаточно передать свою функцию
 * в options.detector — остальной конвейер не изменится.
 */

export interface FaceBox {
  /** Координаты в пикселях исходного изображения. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..1, насколько уверенно область похожа на лицо. */
  confidence: number;
  /** Кто нашёл: встроенная эвристика или подключённый детектор. */
  source: string;
}

export interface FaceDetectionResult {
  faces: FaceBox[];
  /** Маска кожи в уменьшенном разрешении — переиспользуется при поиске областей. */
  skin: SkinMask | null;
  detector: string;
  durationMs: number;
}

export interface SkinMask {
  width: number;
  height: number;
  /** 1 — кожа, 0 — нет. */
  data: Uint8Array;
  /** Во сколько раз маска меньше исходного изображения. */
  scale: number;
}

export interface FaceDetectionOptions {
  /** Максимальная сторона рабочей маски. Меньше — быстрее, грубее. */
  maxSide?: number;
  /** Минимальная доля площади кадра, которую должно занимать лицо. */
  minAreaRatio?: number;
  /** Сколько лиц максимум вернуть. */
  maxFaces?: number;
  /** Порог уверенности, ниже которого находка отбрасывается. */
  minConfidence?: number;
  /** Свой детектор: MediaPipe, OpenCV, FaceDetector API. */
  detector?: FaceDetector | null;
  /**
   * Учитывать, что лицо обрезано краем кадра.
   *
   * В квадратном кропе портрет почти всегда упирается в верх и низ: овал
   * превращается в прямоугольник, и оценка по пропорциям перестаёт работать.
   * С этим флагом к таким находкам применяются свои допуски.
   */
  edgeTolerant?: boolean;
  /** Склеивать перекрывающиеся находки — иначе одно лицо даёт два «лица». */
  mergeOverlapping?: boolean;
}

export type FaceDetector = (image: ImageDataLike) => FaceBox[];

export const DEFAULT_FACE_OPTIONS: Required<Omit<FaceDetectionOptions, 'detector'>> = {
  maxSide: 192,
  minAreaRatio: 0.004,
  maxFaces: 6,
  minConfidence: 0.42,
  edgeTolerant: true,
  mergeOverlapping: true,
};

/** Обрезанному лицу разрешены другие пропорции — от узкой полосы до широкой. */
const CROPPED_ASPECT_RANGE: [number, number] = [0.45, 2];
/** И оно должно быть крупным: мелкое пятно у края лицом не считается. */
const CROPPED_MIN_AREA_RATIO = 0.06;
/** Пропорции, при которых обрезанное лицо не штрафуется вовсе. */
const CROPPED_COMFORT_RANGE: [number, number] = [0.6, 1.5];

/** Правила «похоже на кожу»: RGB + YCbCr, классика Kovac / Chai-Ngan. */
/** Верхний порог Cb для обычного и ослабленного прохода. */
export const SKIN_CB_MAX = 129;
/**
 * При свете экрана или холодной лампы синяя компонента кожи поднимается на
 * 5–10 единиц, и лицо перестаёт проходить порог. Ослабленный порог
 * применяется только вторым проходом, когда обычный ничего не нашёл.
 */
export const SKIN_CB_MAX_RELAXED = 141;

export function isSkinPixel(r: number, g: number, b: number, cbMax = SKIN_CB_MAX): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);

  const rgbRule =
    r > 80 &&
    g > 30 &&
    b > 15 &&
    max - min > 12 &&
    r > g &&
    r > b &&
    Math.abs(r - g) > 8;

  if (!rgbRule) return false;

  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

  return cb >= 76 && cb <= cbMax && cr >= 133 && cr <= 178;
}

/** Уменьшенная копия изображения: коробочная выборка, без сглаживания браузера. */
export function downscale(image: ImageDataLike, maxSide: number): ImageDataLike & { scale: number } {
  const { width, height, data } = image;
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  if (scale === 1) return { width, height, data, scale: 1 };

  const outWidth = Math.max(1, Math.floor(width / scale));
  const outHeight = Math.max(1, Math.floor(height / scale));
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let dy = 0; dy < scale; dy++) {
        const sy = y * scale + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < scale; dx++) {
          const sx = x * scale + dx;
          if (sx >= width) break;
          const index = (sy * width + sx) * 4;
          r += data[index];
          g += data[index + 1];
          b += data[index + 2];
          count++;
        }
      }
      const out_index = (y * outWidth + x) * 4;
      out[out_index] = r / count;
      out[out_index + 1] = g / count;
      out[out_index + 2] = b / count;
      out[out_index + 3] = 255;
    }
  }

  return { width: outWidth, height: outHeight, data: out, scale };
}

/** Маска кожи с морфологической чисткой: сначала убрать крапины, потом залатать дыры. */
export function buildSkinMask(image: ImageDataLike, scale = 1, cbMax = SKIN_CB_MAX): SkinMask {
  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    mask[i] = isSkinPixel(data[p], data[p + 1], data[p + 2], cbMax) ? 1 : 0;
  }

  const opened = dilate(erode(mask, width, height), width, height);
  const closed = erode(dilate(opened, width, height), width, height);

  return { width, height, data: closed, scale };
}

function erode(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!mask[index]) continue;
      let keep = 1;
      for (let dy = -1; dy <= 1 && keep; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!mask[ny * width + nx]) {
            keep = 0;
            break;
          }
        }
      }
      out[index] = keep;
    }
  }
  return out;
}

function dilate(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

interface Component {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
}

/** Касается ли находка края кадра — значит, лицо, скорее всего, обрезано. */
function touchesEdge(component: Component, width: number, height: number): boolean {
  return component.minX === 0 || component.minY === 0 || component.maxX === width - 1 || component.maxY === height - 1;
}

/** Разметка связных компонент, 8-связность, без рекурсии. */
export function findComponents(mask: SkinMask): Component[] {
  const { width, height, data } = mask;
  const labels = new Int32Array(width * height).fill(-1);
  const components: Component[] = [];
  const stack: number[] = [];

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start] !== -1) continue;

    const label = components.length;
    const component: Component = { minX: width, minY: height, maxX: 0, maxY: 0, area: 0 };
    stack.push(start);
    labels[start] = label;

    while (stack.length) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;

      component.area++;
      if (x < component.minX) component.minX = x;
      if (x > component.maxX) component.maxX = x;
      if (y < component.minY) component.minY = y;
      if (y > component.maxY) component.maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (data[neighbor] && labels[neighbor] === -1) {
            labels[neighbor] = label;
            stack.push(neighbor);
          }
        }
      }
    }

    components.push(component);
  }

  return components;
}

/**
 * Основная функция. Если лицо не найдено — возвращается пустой список,
 * и генерация продолжается обычным способом.
 */
export function detectFaces(image: ImageDataLike, options: FaceDetectionOptions = {}): FaceDetectionResult {
  const started = timestamp();
  const settings = { ...DEFAULT_FACE_OPTIONS, ...options };

  // Подключённый детектор (MediaPipe, OpenCV, FaceDetector API) имеет приоритет.
  if (options.detector) {
    const faces = options.detector(image).slice(0, settings.maxFaces);
    return { faces, skin: null, detector: 'external', durationMs: Math.round(timestamp() - started) };
  }

  const small = downscale(image, settings.maxSide);

  /*
   * Два прохода. Первый — с обычным порогом кожи. Если он не дал уверенного
   * лица, второй — с ослабленным порогом по Cb: так ловятся снимки при свете
   * экрана, где кожа уходит в розово-фиолетовый. На обычных фотографиях
   * второй проход не запускается вовсе, поэтому их результат не меняется.
   */
  let pass = detectPass(small, settings, SKIN_CB_MAX);
  // Уверенное лицо — не только по оценке, но и по размеру: обрывок руки в
  // 1 % кадра не должен отменять второй проход.
  const frameArea = small.width * small.height;
  const confident = pass.faces.some(
    (face) => face.confidence >= 0.5 && ((face.width / small.scale) * (face.height / small.scale)) / frameArea >= 0.03,
  );
  if (!confident) {
    const relaxed = detectPass(small, settings, SKIN_CB_MAX_RELAXED);
    const relaxedBest = relaxed.faces.length ? Math.max(...relaxed.faces.map((face) => face.confidence)) : 0;
    const strictBest = pass.faces.length ? Math.max(...pass.faces.map((face) => face.confidence)) : 0;
    if (relaxedBest > strictBest) pass = relaxed;
  }

  return {
    faces: pass.faces.slice(0, settings.maxFaces),
    skin: pass.skin,
    detector: 'skin-heuristic',
    durationMs: Math.round(timestamp() - started),
  };
}

/** Один проход детекции с заданным порогом кожи. */
function detectPass(
  small: ImageDataLike & { scale: number },
  settings: Required<Omit<FaceDetectionOptions, 'detector'>>,
  cbMax: number,
): { faces: FaceBox[]; skin: SkinMask } {
  const skin = buildSkinMask(small, small.scale, cbMax);
  const components = findComponents(skin);

  const frameArea = skin.width * skin.height;
  const faces: FaceBox[] = [];

  for (const component of components) {
    const width = component.maxX - component.minX + 1;
    const height = component.maxY - component.minY + 1;
    const boxArea = width * height;
    const areaRatio = component.area / frameArea;

    if (areaRatio < settings.minAreaRatio) continue;
    if (width < 6 || height < 6) continue;

    const fill = component.area / boxArea;
    const aspect = width / height;

    // Лицо у края кадра обрезано: овал становится прямоугольником, и
    // обычные допуски по пропорциям к нему неприменимы.
    const cropped =
      settings.edgeTolerant && touchesEdge(component, skin.width, skin.height) && areaRatio >= CROPPED_MIN_AREA_RATIO;

    const minFill = cropped ? 0.45 : 0.5;
    const [minAspect, maxAspect] = cropped ? CROPPED_ASPECT_RANGE : [0.5, 1.45];

    if (fill < minFill) continue;
    if (aspect < minAspect || aspect > maxAspect) continue;

    // Для обрезанного лица «правильных» пропорций нет — есть допустимый
    // коридор, внутри которого штрафа быть не должно.
    let aspectScore: number;
    if (cropped) {
      const [comfortMin, comfortMax] = CROPPED_COMFORT_RANGE;
      if (aspect >= comfortMin && aspect <= comfortMax) {
        aspectScore = 1;
      } else {
        const distance = aspect < comfortMin ? comfortMin - aspect : aspect - comfortMax;
        aspectScore = Math.max(0, 1 - distance / 0.6);
      }
    } else {
      aspectScore = 1 - Math.min(1, Math.abs(aspect - 0.78) / 0.5);
    }

    const fillScore = Math.min(1, (fill - minFill) / 0.35);
    // Крупная находка заслуживает больше доверия, чем мелкое пятно.
    const sizeScore = Math.min(1, areaRatio / 0.25);

    const confidence = cropped
      ? 0.3 * fillScore + 0.45 * aspectScore + 0.25 * sizeScore
      : 0.35 * fillScore + 0.65 * aspectScore;

    if (confidence < settings.minConfidence) continue;

    faces.push({
      x: component.minX * skin.scale,
      y: component.minY * skin.scale,
      width: width * skin.scale,
      height: height * skin.scale,
      confidence: Number(confidence.toFixed(3)),
      source: 'skin-heuristic',
    });
  }

  faces.sort((a, b) => b.width * b.height - a.width * a.height);

  const merged = settings.mergeOverlapping ? mergeFaces(faces) : faces;
  return { faces: merged, skin };
}

/**
 * Склейка перекрывающихся находок.
 *
 * Одно лицо часто распадается на несколько пятен кожи — лоб отдельно от
 * щеки, если между ними прядь волос. Без склейки это выглядит как «двое в
 * кадре» и портит карту весов.
 */
export function mergeFaces(faces: FaceBox[], overlapThreshold = 0.2): FaceBox[] {
  const result: FaceBox[] = [];

  for (const face of faces) {
    let mergedInto = false;

    for (let i = 0; i < result.length; i++) {
      const other = result[i];
      if (overlapRatio(face, other) < overlapThreshold) continue;

      // Объединяем в общий прямоугольник, уверенность берём лучшую.
      const x = Math.min(face.x, other.x);
      const y = Math.min(face.y, other.y);
      const right = Math.max(face.x + face.width, other.x + other.width);
      const bottom = Math.max(face.y + face.height, other.y + other.height);

      result[i] = {
        x,
        y,
        width: right - x,
        height: bottom - y,
        confidence: Math.max(face.confidence, other.confidence),
        source: other.source,
      };
      mergedInto = true;
      break;
    }

    if (!mergedInto) result.push({ ...face });
  }

  return result;
}

/** Доля пересечения относительно меньшей из двух рамок. */
function overlapRatio(a: FaceBox, b: FaceBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) return 0;

  const intersection = (right - left) * (bottom - top);
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? intersection / smaller : 0;
}

function timestamp(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
