import type { RGB } from '../../types/mosaic';
import type { Lab } from '../../types/palette';

/**
 * Перевод sRGB ↔ CIE L*a*b* через XYZ, точка белого D65, наблюдатель 2°.
 * Модуль ничего не знает ни о палитрах, ни о мозаике — только цветовая математика.
 */

/** D65, 2° — та же точка белого, что подразумевает sRGB. */
export const D65 = { X: 95.047, Y: 100.0, Z: 108.883 } as const;

const EPSILON = 216 / 24389; // 0.008856
const KAPPA = 24389 / 27; // 903.3

/** Байт sRGB → линейное значение 0..1. */
export function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Линейное значение 0..1 → байт sRGB. */
export function linearToSrgbChannel(value: number): number {
  const v = value <= 0 ? 0 : value >= 1 ? 1 : value;
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

export interface XYZ {
  X: number;
  Y: number;
  Z: number;
}

/** sRGB (0..255) → XYZ (0..100). */
export function rgbToXyz(rgb: RGB): XYZ {
  const r = srgbChannelToLinear(rgb[0]) * 100;
  const g = srgbChannelToLinear(rgb[1]) * 100;
  const b = srgbChannelToLinear(rgb[2]) * 100;

  return {
    X: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    Y: r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    Z: r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  };
}

function pivot(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/** XYZ (0..100) → Lab. */
export function xyzToLab(xyz: XYZ): Lab {
  const fx = pivot(xyz.X / D65.X);
  const fy = pivot(xyz.Y / D65.Y);
  const fz = pivot(xyz.Z / D65.Z);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/** Главная функция модуля: sRGB → Lab. */
export function rgbToLab(rgb: RGB): Lab {
  return xyzToLab(rgbToXyz(rgb));
}

/** Lab → XYZ (0..100). */
export function labToXyz(lab: Lab): XYZ {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;

  const fx3 = fx * fx * fx;
  const fz3 = fz * fz * fz;

  const xr = fx3 > EPSILON ? fx3 : (116 * fx - 16) / KAPPA;
  const yr = lab.L > KAPPA * EPSILON ? Math.pow((lab.L + 16) / 116, 3) : lab.L / KAPPA;
  const zr = fz3 > EPSILON ? fz3 : (116 * fz - 16) / KAPPA;

  return { X: xr * D65.X, Y: yr * D65.Y, Z: zr * D65.Z };
}

/** Lab → sRGB (0..255), с отсечением за пределами охвата. */
export function labToRgb(lab: Lab): RGB {
  const { X, Y, Z } = labToXyz(lab);
  const x = X / 100;
  const y = Y / 100;
  const z = Z / 100;

  const r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const g = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const b = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  return [linearToSrgbChannel(r), linearToSrgbChannel(g), linearToSrgbChannel(b)];
}

/** Насыщенность (chroma) и тон — пригодятся метрикам расстояния. */
export function labChroma(lab: Lab): number {
  return Math.sqrt(lab.a * lab.a + lab.b * lab.b);
}

/** Тон в градусах, 0..360. */
export function labHue(lab: Lab): number {
  if (lab.a === 0 && lab.b === 0) return 0;
  const degrees = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  return degrees >= 0 ? degrees : degrees + 360;
}
