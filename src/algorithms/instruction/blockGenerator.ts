import type { MosaicCell, MosaicGrid, RGB } from '../../types/mosaic';
import type { Palette, PaletteColor } from '../../types/palette';

/**
 * Разбиение готовой мозаики на блоки для сборки.
 *
 * Алгоритм генерации здесь не участвует: на вход приходит уже посчитанная
 * сетка, а на выходе — план сборки. Ничего не пересчитывается и не меняется.
 */

export const DEFAULT_BLOCK_SIZE = 8;

/** Запись легенды: номер, которым деталь обозначается в схемах. */
export interface LegendEntry {
  /** Порядковый номер, с 1. */
  number: number;
  colorId: string;
  name: string;
  hex: string;
  rgb: RGB;
  /** Сколько деталей этого цвета нужно на всю мозаику. */
  total: number;
}

export interface BlockColorCount {
  number: number;
  colorId: string;
  name: string;
  hex: string;
  count: number;
}

export interface InstructionBlock {
  /** Человекочитаемый номер: BLOCK 01. */
  blockId: string;
  /** Порядковый индекс с 0. */
  index: number;
  /** Позиция блока в сетке (в ячейках). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Ячейки блока, row-major, с глобальными координатами. */
  cells: MosaicCell[];
  /** Номера легенды для каждой ячейки, в том же порядке. */
  numbers: number[];
  /** Сколько деталей каждого цвета в этом блоке. */
  counts: BlockColorCount[];
  /** Позиция блока в решётке блоков. */
  column: number;
  row: number;
}

export interface InstructionPlan {
  cols: number;
  rows: number;
  blockSize: number;
  blocksX: number;
  blocksY: number;
  blocks: InstructionBlock[];
  legend: LegendEntry[];
  /** Всего деталей = число ячеек. */
  totalPieces: number;
}

export interface BlockOptions {
  /** Сторона блока в ячейках. По умолчанию 8×8. */
  blockSize?: number;
  /** Палитра — из неё берутся названия цветов. */
  palette?: Palette | PaletteColor[] | null;
}

function paletteColors(palette: BlockOptions['palette']): PaletteColor[] {
  if (!palette) return [];
  return Array.isArray(palette) ? palette : palette.colors;
}

function normalizeCellHex(hex: string): string {
  return hex.trim().toUpperCase();
}

/**
 * Строит план сборки: блоки, легенду и количества.
 *
 * Номера легенды раздаются по убыванию количества деталей: №1 — самый
 * массовый цвет. При равенстве порядок стабилен (по hex), поэтому один и тот
 * же результат всегда даёт одну и ту же инструкцию.
 */
export function buildInstructionPlan(grid: MosaicGrid, options: BlockOptions = {}): InstructionPlan {
  const blockSize = Math.max(1, Math.floor(options.blockSize ?? DEFAULT_BLOCK_SIZE));
  const names = new Map<string, PaletteColor>();
  for (const color of paletteColors(options.palette)) names.set(normalizeCellHex(color.hex), color);

  /* --- легенда: считаем цвета по всей мозаике ---------------------------- */

  const totals = new Map<string, { count: number; rgb: RGB }>();
  for (const cell of grid.cells) {
    const key = normalizeCellHex(cell.hex);
    const entry = totals.get(key);
    if (entry) entry.count++;
    else totals.set(key, { count: 1, rgb: cell.rgb });
  }

  const legend: LegendEntry[] = [...totals.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([hex, entry], index) => {
      const known = names.get(hex);
      return {
        number: index + 1,
        colorId: known?.id ?? hex.replace('#', '').toLowerCase(),
        name: known?.name ?? hex,
        hex,
        rgb: entry.rgb,
        total: entry.count,
      };
    });

  const numberByHex = new Map<string, LegendEntry>();
  for (const entry of legend) numberByHex.set(entry.hex, entry);

  /* --- блоки -------------------------------------------------------------- */

  const blocksX = Math.ceil(grid.cols / blockSize);
  const blocksY = Math.ceil(grid.rows / blockSize);
  const blocks: InstructionBlock[] = [];

  for (let row = 0; row < blocksY; row++) {
    for (let column = 0; column < blocksX; column++) {
      const x = column * blockSize;
      const y = row * blockSize;
      const width = Math.min(blockSize, grid.cols - x);
      const height = Math.min(blockSize, grid.rows - y);

      const cells: MosaicCell[] = [];
      const numbers: number[] = [];
      const counts = new Map<string, BlockColorCount>();

      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const cell = grid.cells[(y + dy) * grid.cols + (x + dx)];
          const entry = numberByHex.get(normalizeCellHex(cell.hex));
          const number = entry?.number ?? 0;

          cells.push(cell);
          numbers.push(number);

          const key = normalizeCellHex(cell.hex);
          const existing = counts.get(key);
          if (existing) existing.count++;
          else
            counts.set(key, {
              number,
              colorId: entry?.colorId ?? key,
              name: entry?.name ?? key,
              hex: key,
              count: 1,
            });
        }
      }

      const index = blocks.length;
      blocks.push({
        blockId: `BLOCK ${String(index + 1).padStart(2, '0')}`,
        index,
        x,
        y,
        width,
        height,
        cells,
        numbers,
        counts: [...counts.values()].sort((a, b) => b.count - a.count || a.number - b.number),
        column,
        row,
      });
    }
  }

  return {
    cols: grid.cols,
    rows: grid.rows,
    blockSize,
    blocksX,
    blocksY,
    blocks,
    legend,
    totalPieces: grid.cells.length,
  };
}

/** Ячейка блока по локальным координатам. */
export function blockCell(block: InstructionBlock, localX: number, localY: number): MosaicCell | undefined {
  if (localX < 0 || localY < 0 || localX >= block.width || localY >= block.height) return undefined;
  return block.cells[localY * block.width + localX];
}

/** Номер легенды по локальным координатам. */
export function blockNumber(block: InstructionBlock, localX: number, localY: number): number {
  if (localX < 0 || localY < 0 || localX >= block.width || localY >= block.height) return 0;
  return block.numbers[localY * block.width + localX];
}

/** Подходящий цвет текста поверх детали: тёмный на светлом и наоборот. */
export function contrastInk(rgb: RGB): string {
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return luma > 140 ? '#101318' : '#F4F4F4';
}
