import { luminance } from '../image/edges';
import type { MosaicGrid } from '../../types/mosaic';
import type { Palette, PaletteColor, PreparedPalette } from '../../types/palette';

/**
 * «Почерк» мозаики — статистика сетки, которая отличает одну манеру от
 * другой независимо от сюжета: сколько границ между соседями, как часто
 * сосед отличается сразу на два тона, сколько одиночных ячеек, сколько
 * тонов умещается в блоке 4×4 и как распределены сами тона.
 *
 * Эталон KIT_SIGNATURE снят с результата готового набора на той же
 * фотографии, что и наш (64×96, 5 тонов), по скриншотам: обе мозаики были
 * выровнены по решётке ячеек и квантованы в пять тонов. Это не «истина»,
 * а ориентир: в нём есть и вклад сюжета (у портрета крупным планом границ
 * больше, чем у пейзажа), поэтому расстояние до него сравнивают между
 * кандидатами на одном кадре, а не судят по абсолютной величине.
 */

export interface GridSignature {
  /** Доля пар соседних ячеек (по горизонтали и вертикали) с разными тонами. */
  edgeDensity: number;
  /** Доля пар соседей, отличающихся на два и более тона. */
  jumps: number;
  /** Доля ячеек, отличающихся от всех четырёх соседей. */
  isolated: number;
  /** Среднее число разных тонов в блоке 4×4. */
  diversity: number;
  /** Доли тонов от самого светлого к самому тёмному. */
  shares: number[];
  /** Доля самой большой связной области одного тона. */
  largestRegion: number;
}

/** Подпись результата готового набора, 64×96, пять тонов (белый → чёрный). */
export const KIT_SIGNATURE: GridSignature = {
  edgeDensity: 0.363,
  jumps: 0.108,
  isolated: 0.059,
  diversity: 2.98,
  shares: [0.218, 0.175, 0.184, 0.131, 0.292],
  largestRegion: 0.211,
};

function colorsOf(palette: Palette | PaletteColor[] | PreparedPalette): PaletteColor[] {
  return Array.isArray(palette) ? palette : palette.colors;
}

/**
 * Индекс тона каждой ячейки: 0 — самый светлый цвет палитры. Ячейка
 * относится к ближайшему по яркости цвету, поэтому работает и для цветных
 * палитр — там «тон» означает ступень светлоты.
 */
export function toneIndices(grid: MosaicGrid, palette: Palette | PaletteColor[] | PreparedPalette): Uint8Array {
  const ladder = colorsOf(palette)
    .map((color) => luminance(color.rgb[0], color.rgb[1], color.rgb[2]))
    .sort((a, b) => b - a);
  const out = new Uint8Array(grid.cells.length);
  for (let i = 0; i < grid.cells.length; i++) {
    const [r, g, b] = grid.cells[i].rgb;
    const l = luminance(r, g, b);
    let best = 0;
    let bestDistance = Infinity;
    for (let k = 0; k < ladder.length; k++) {
      const distance = Math.abs(ladder[k] - l);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    out[i] = best;
  }
  return out;
}

export function gridSignature(grid: MosaicGrid, palette: Palette | PaletteColor[] | PreparedPalette): GridSignature {
  const { cols, rows } = grid;
  const tones = toneIndices(grid, palette);
  const levels = colorsOf(palette).length;

  let pairs = 0;
  let different = 0;
  let jumps = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = tones[y * cols + x];
      if (x + 1 < cols) {
        const d = Math.abs(t - tones[y * cols + x + 1]);
        pairs++;
        if (d > 0) different++;
        if (d >= 2) jumps++;
      }
      if (y + 1 < rows) {
        const d = Math.abs(t - tones[(y + 1) * cols + x]);
        pairs++;
        if (d > 0) different++;
        if (d >= 2) jumps++;
      }
    }
  }

  let isolated = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = tones[y * cols + x];
      const up = tones[Math.max(0, y - 1) * cols + x];
      const down = tones[Math.min(rows - 1, y + 1) * cols + x];
      const left = tones[y * cols + Math.max(0, x - 1)];
      const right = tones[y * cols + Math.min(cols - 1, x + 1)];
      if (t !== up && t !== down && t !== left && t !== right) isolated++;
    }
  }

  let blocks = 0;
  let diversitySum = 0;
  for (let y = 0; y < rows; y += 4) {
    for (let x = 0; x < cols; x += 4) {
      const seen = new Set<number>();
      for (let dy = 0; dy < 4 && y + dy < rows; dy++) {
        for (let dx = 0; dx < 4 && x + dx < cols; dx++) seen.add(tones[(y + dy) * cols + x + dx]);
      }
      diversitySum += seen.size;
      blocks++;
    }
  }

  const counts = new Array(levels).fill(0);
  for (const t of tones) counts[t]++;

  return {
    edgeDensity: pairs ? different / pairs : 0,
    jumps: pairs ? jumps / pairs : 0,
    isolated: tones.length ? isolated / tones.length : 0,
    diversity: blocks ? diversitySum / blocks : 0,
    shares: counts.map((count) => count / Math.max(1, tones.length)),
    largestRegion: largestRegionShare(tones, cols, rows),
  };
}

function largestRegionShare(tones: Uint8Array, cols: number, rows: number): number {
  const seen = new Uint8Array(tones.length);
  const stack: number[] = [];
  let best = 0;
  for (let start = 0; start < tones.length; start++) {
    if (seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let size = 0;
    while (stack.length) {
      const index = stack.pop() as number;
      size++;
      const x = index % cols;
      const y = (index - x) / cols;
      const tone = tones[index];
      const neighbours = [index - 1, index + 1, index - cols, index + cols];
      for (let k = 0; k < 4; k++) {
        const next = neighbours[k];
        if (next < 0 || next >= tones.length) continue;
        if (k === 0 && x === 0) continue;
        if (k === 1 && x === cols - 1) continue;
        if (k === 2 && y === 0) continue;
        if (k === 3 && y === rows - 1) continue;
        if (seen[next] || tones[next] !== tone) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    if (size > best) best = size;
  }
  return tones.length ? best / tones.length : 0;
}

/**
 * Расстояние между подписями: каждая составляющая нормирована на масштаб,
 * в котором разница уже видна глазами. Доли тонов сравниваются по L1.
 */
export function signatureDistance(a: GridSignature, b: GridSignature): number {
  const shares = a.shares.length === b.shares.length
    ? a.shares.reduce((sum, value, index) => sum + Math.abs(value - b.shares[index]), 0)
    : 1;
  return (
    Math.abs(a.edgeDensity - b.edgeDensity) / 0.1 +
    Math.abs(a.jumps - b.jumps) / 0.05 +
    Math.abs(a.isolated - b.isolated) / 0.03 +
    Math.abs(a.diversity - b.diversity) / 0.5 +
    shares / 0.4
  );
}
