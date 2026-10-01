import type { ImageDataLike } from '../../types/mosaic';
import { luminance } from '../image/edges';
import type { FaceBox, SkinMask } from './faceDetection';

/**
 * Разбор найденного лица на области: глаза, рот, овал лица, контур и волосы.
 *
 * Никаких обученных моделей: глаза ищутся как две тёмные впадины в верхней
 * половине лица, рот — как самая «красная» и контрастная полоса в нижней трети,
 * волосы — как тёмная не-кожа над лицом. Если что-то не нашлось, поле остаётся
 * пустым, и вес просто не назначается.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface FaceRegions {
  face: FaceBox;
  /** Овал лица — им ограничивается область с весом «лицо». */
  oval: Ellipse;
  /** Ноль, один или два глаза. */
  eyes: Ellipse[];
  mouth: Rect | null;
  /** Полоса волос над лицом, если сверху действительно темно. */
  hair: Rect | null;
  /** Насколько уверенно найдены черты лица, 0..1. */
  featureConfidence: number;
}

export interface FaceRegionOptions {
  /** Маска кожи из детектора — уточняет границу лица и волосы. */
  skin?: SkinMask | null;
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(rect.width))),
    height: Math.max(1, Math.min(height - y, Math.round(rect.height))),
  };
}

/** Средняя яркость прямоугольника. */
function meanLuma(image: ImageDataLike, rect: Rect): number {
  const { width, data } = image;
  let sum = 0;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const index = (y * width + x) * 4;
      sum += luminance(data[index], data[index + 1], data[index + 2]);
      count++;
    }
  }
  return count ? sum / count : 0;
}

/**
 * Самая тёмная точка области — центр глаза.
 * Ищем по сглаженной яркости, чтобы не поймать одиночный шумный пиксель.
 */
function darkestPoint(image: ImageDataLike, rect: Rect): { x: number; y: number; luma: number } {
  const { width, data } = image;
  let best = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, luma: 255 };

  for (let y = rect.y + 1; y < rect.y + rect.height - 1; y++) {
    for (let x = rect.x + 1; x < rect.x + rect.width - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const index = ((y + dy) * width + (x + dx)) * 4;
          sum += luminance(data[index], data[index + 1], data[index + 2]);
        }
      }
      const value = sum / 9;
      if (value < best.luma) best = { x, y, luma: value };
    }
  }

  return best;
}

/** «Краснота» строки: у губ Cr заметно выше, чем у кожи вокруг. */
function rowRedness(image: ImageDataLike, rect: Rect, y: number): number {
  const { width, data } = image;
  let sum = 0;
  let count = 0;
  for (let x = rect.x; x < rect.x + rect.width; x++) {
    const index = (y * width + x) * 4;
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    sum += cr - luminance(r, g, b) * 0.35;
    count++;
  }
  return count ? sum / count : 0;
}

/**
 * Собирает области лица. Координаты — в пикселях исходного изображения.
 */
export function buildFaceRegions(
  image: ImageDataLike,
  face: FaceBox,
  options: FaceRegionOptions = {},
): FaceRegions {
  const { width, height } = image;
  const box = clampRect(face, width, height);

  const oval: Ellipse = {
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
    rx: box.width / 2,
    ry: box.height / 2,
  };

  const faceLuma = meanLuma(image, box);

  /* --- глаза: две тёмные впадины в верхней половине --------------------- */

  const eyeBand = clampRect(
    { x: box.x, y: box.y + box.height * 0.22, width: box.width, height: box.height * 0.32 },
    width,
    height,
  );
  const halfWidth = Math.max(1, Math.floor(eyeBand.width / 2));
  const eyeRadius = Math.max(1, box.width * 0.11);

  const eyes: Ellipse[] = [];
  let eyeScore = 0;

  for (const side of [0, 1]) {
    const region = clampRect(
      {
        x: eyeBand.x + side * halfWidth + eyeBand.width * 0.04,
        y: eyeBand.y,
        width: halfWidth - eyeBand.width * 0.08,
        height: eyeBand.height,
      },
      width,
      height,
    );
    const darkest = darkestPoint(image, region);
    // Глаз должен быть заметно темнее окружающей кожи.
    if (darkest.luma < faceLuma * 0.72) {
      eyes.push({ cx: darkest.x, cy: darkest.y, rx: eyeRadius, ry: eyeRadius * 0.75 });
      eyeScore += 0.5;
    }
  }

  // Если нашлись оба глаза, но они на разной высоте — скорее всего это не глаза.
  if (eyes.length === 2 && Math.abs(eyes[0].cy - eyes[1].cy) > box.height * 0.18) {
    eyes.length = 0;
    eyeScore = 0;
  }

  /* --- рот: самая красная строка в нижней трети -------------------------- */

  const mouthBand = clampRect(
    { x: box.x + box.width * 0.18, y: box.y + box.height * 0.6, width: box.width * 0.64, height: box.height * 0.3 },
    width,
    height,
  );

  let mouthY = -1;
  let bestRedness = -Infinity;
  const bandRedness: number[] = [];
  for (let y = mouthBand.y; y < mouthBand.y + mouthBand.height; y++) {
    const value = rowRedness(image, mouthBand, y);
    bandRedness.push(value);
    if (value > bestRedness) {
      bestRedness = value;
      mouthY = y;
    }
  }

  const meanRedness = bandRedness.reduce((sum, value) => sum + value, 0) / (bandRedness.length || 1);
  const mouthFound = mouthY >= 0 && bestRedness > meanRedness + 1.5;

  const mouth: Rect | null = mouthFound
    ? clampRect(
        {
          x: box.x + box.width * 0.24,
          y: mouthY - box.height * 0.07,
          width: box.width * 0.52,
          height: box.height * 0.15,
        },
        width,
        height,
      )
    : null;

  /* --- волосы: тёмная не-кожа над лицом ---------------------------------- */

  const hairBand = clampRect(
    { x: box.x - box.width * 0.12, y: box.y - box.height * 0.42, width: box.width * 1.24, height: box.height * 0.5 },
    width,
    height,
  );
  const hairLuma = meanLuma(image, hairBand);
  const skin = options.skin ?? null;
  const hairIsSkin = skin ? skinRatio(skin, hairBand) > 0.6 : false;
  const hair: Rect | null = !hairIsSkin && hairBand.height > 2 && hairLuma < faceLuma * 0.92 ? hairBand : null;

  const featureConfidence = Math.min(1, eyeScore + (mouth ? 0.3 : 0) + (hair ? 0.1 : 0));

  return { face, oval, eyes, mouth, hair, featureConfidence };
}

function skinRatio(skin: SkinMask, rect: Rect): number {
  let count = 0;
  let total = 0;
  const x0 = Math.floor(rect.x / skin.scale);
  const y0 = Math.floor(rect.y / skin.scale);
  const x1 = Math.min(skin.width, Math.ceil((rect.x + rect.width) / skin.scale));
  const y1 = Math.min(skin.height, Math.ceil((rect.y + rect.height) / skin.scale));

  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) {
      total++;
      if (skin.data[y * skin.width + x]) count++;
    }
  }
  return total ? count / total : 0;
}

/** Области для всех найденных лиц. */
export function buildAllFaceRegions(
  image: ImageDataLike,
  faces: FaceBox[],
  options: FaceRegionOptions = {},
): FaceRegions[] {
  return faces.map((face) => buildFaceRegions(image, face, options));
}
