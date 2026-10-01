import type { ColorDistanceMetric, Lab } from '../../types/palette';

/**
 * Перцептивные расстояния между цветами в CIE L*a*b*.
 * Простое сравнение RGB здесь не используется нигде: евклидово расстояние в RGB
 * не соответствует тому, как глаз видит разницу.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** ΔE*ab (CIE 1976) — евклидово расстояние в Lab. */
export function deltaE76(a: Lab, b: Lab): number {
  return Math.sqrt(deltaE76Squared(a, b));
}

/** Квадрат ΔE76 — без корня, для быстрого поиска минимума. */
export function deltaE76Squared(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dL * dL + da * da + db * db;
}

/**
 * ΔE*94 (графические искусства: kL = 1, K1 = 0.045, K2 = 0.015).
 * Учитывает, что глаз менее чувствителен к разнице насыщенных цветов.
 */
export function deltaE94(reference: Lab, sample: Lab): number {
  const dL = reference.L - sample.L;
  const C1 = Math.sqrt(reference.a * reference.a + reference.b * reference.b);
  const C2 = Math.sqrt(sample.a * sample.a + sample.b * sample.b);
  const dC = C1 - C2;

  const da = reference.a - sample.a;
  const db = reference.b - sample.b;
  const dH2 = da * da + db * db - dC * dC;
  const dH = dH2 > 0 ? Math.sqrt(dH2) : 0;

  const sL = 1;
  const sC = 1 + 0.045 * C1;
  const sH = 1 + 0.015 * C1;

  return Math.sqrt((dL / sL) ** 2 + (dC / sC) ** 2 + (dH / sH) ** 2);
}

/**
 * ΔE00 (CIEDE2000) — текущий стандарт перцептивной разницы.
 * Формулировка по Sharma, Wu, Dalal (2005).
 */
export function deltaE2000(reference: Lab, sample: Lab, kL = 1, kC = 1, kH = 1): number {
  const { L: L1, a: a1, b: b1 } = reference;
  const { L: L2, a: a2, b: b2 } = sample;

  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;

  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);

  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else if (Math.abs(h2p - h1p) <= 180) {
    dhp = h2p - h1p;
  } else if (h2p - h1p > 180) {
    dhp = h2p - h1p - 360;
  } else {
    dhp = h2p - h1p + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG_TO_RAD);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp: number;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2;
  } else {
    hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG_TO_RAD) +
    0.24 * Math.cos(2 * hbarp * DEG_TO_RAD) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG_TO_RAD) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG_TO_RAD);

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7));
  const Rt = -Rc * Math.sin(2 * dTheta * DEG_TO_RAD);

  const Lbarp50 = (Lbarp - 50) ** 2;
  const Sl = 1 + (0.015 * Lbarp50) / Math.sqrt(20 + Lbarp50);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;

  const termL = dLp / (kL * Sl);
  const termC = dCp / (kC * Sc);
  const termH = dHp / (kH * Sh);

  return Math.sqrt(termL * termL + termC * termC + termH * termH + Rt * termC * termH);
}

function hueAngle(b: number, ap: number): number {
  if (ap === 0 && b === 0) return 0;
  const degrees = Math.atan2(b, ap) * RAD_TO_DEG;
  return degrees >= 0 ? degrees : degrees + 360;
}

export type ColorDistanceFn = (reference: Lab, sample: Lab) => number;

export const DISTANCE_FUNCTIONS: Record<ColorDistanceMetric, ColorDistanceFn> = {
  cie76: deltaE76,
  cie94: deltaE94,
  ciede2000: deltaE2000,
};

export const DEFAULT_DISTANCE_METRIC: ColorDistanceMetric = 'ciede2000';

export function getDistanceFn(metric: ColorDistanceMetric = DEFAULT_DISTANCE_METRIC): ColorDistanceFn {
  const fn = DISTANCE_FUNCTIONS[metric];
  if (!fn) throw new Error(`Неизвестная метрика расстояния: ${metric}`);
  return fn;
}

/**
 * Насколько разница заметна человеку.
 * Пороги общепринятые: <1 — незаметно, <2 — заметно тренированному глазу и т.д.
 */
export function describeDelta(delta: number): string {
  if (delta < 1) return 'неразличимо';
  if (delta < 2) return 'едва заметно';
  if (delta < 10) return 'заметно';
  if (delta < 50) return 'разные цвета';
  return 'противоположные цвета';
}
