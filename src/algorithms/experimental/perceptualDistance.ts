import { deltaE2000, getDistanceFn } from '../color/distance';
import { labChroma, labHue } from '../color/lab';
import type { PerceptualWeights } from '../../config/experiments';
import type { ColorDistanceMetric, Lab } from '../../types/palette';

/**
 * Расстояние между цветами с раздельными весами светлоты, насыщенности и тона.
 *
 * Зачем: в аудите 9A видно, что тёплые «кожаные» детали садятся на стену и
 * одежду. Обычная ΔE00 считает такую подмену дешёвой, если светлота совпала.
 * Здесь можно поднять цену ошибки по тону и насыщенности, не трогая
 * production-метрику.
 */

export interface WeightedDistanceOptions {
  metric?: ColorDistanceMetric;
  weights?: PerceptualWeights;
}

/**
 * ΔE00 раскладывается на три составляющие, каждая берётся со своим весом.
 *
 * Считаем не «настоящую» ΔE00 с её перекрёстным членом, а её покомпонентное
 * приближение: для сравнения кандидатов этого достаточно, а веса становятся
 * прозрачными и настраиваемыми.
 */
export function weightedDistance(a: Lab, b: Lab, weights: PerceptualWeights): number {
  const dL = a.L - b.L;

  const chromaA = labChroma(a);
  const chromaB = labChroma(b);
  const dC = chromaA - chromaB;

  // Разница по тону в единицах длины дуги — так она сопоставима с ΔL и ΔC.
  const da = a.a - b.a;
  const db = a.b - b.b;
  const dH2 = Math.max(0, da * da + db * db - dC * dC);
  const dH = Math.sqrt(dH2);

  // Компенсация: у почти серых цветов тон не определён, штрафовать за него нельзя.
  const chromaFloor = Math.min(chromaA, chromaB);
  const hueReliability = Math.min(1, chromaFloor / 12);

  const sL = 1 + (0.015 * (((a.L + b.L) / 2 - 50) ** 2)) / Math.sqrt(20 + ((a.L + b.L) / 2 - 50) ** 2);
  const sC = 1 + 0.045 * ((chromaA + chromaB) / 2);
  const sH = 1 + 0.015 * ((chromaA + chromaB) / 2);

  const termL = (weights.lightness * dL) / sL;
  const termC = (weights.chroma * dC) / sC;
  const termH = (weights.hue * dH * hueReliability) / sH;

  return Math.sqrt(termL * termL + termC * termC + termH * termH);
}

/** Готовая функция расстояния: либо штатная метрика, либо взвешенная. */
export function resolveDistance(options: WeightedDistanceOptions = {}) {
  const weights = options.weights;
  const neutral = !weights || (weights.lightness === 1 && weights.chroma === 1 && weights.hue === 1);

  if (neutral) {
    return options.metric ? getDistanceFn(options.metric) : deltaE2000;
  }
  return (a: Lab, b: Lab) => weightedDistance(a, b, weights);
}

/** Насколько два цвета различаются именно по тону — для диагностики утечки. */
export function hueSeparation(a: Lab, b: Lab): number {
  const chromaA = labChroma(a);
  const chromaB = labChroma(b);
  if (Math.min(chromaA, chromaB) < 6) return 0;

  const diff = Math.abs(labHue(a) - labHue(b));
  return diff > 180 ? 360 - diff : diff;
}
