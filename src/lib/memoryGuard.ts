import { LIMITS } from '../config/limits';

/**
 * Защита памяти: до того, как выделить массивы, оцениваем аппетит задачи и
 * отказываем, если она заведомо не влезет. Лучше честная ошибка, чем
 * вкладка, которую убил браузер.
 */

export interface JobShape {
  cols: number;
  rows: number;
  sampleWidth: number;
  sampleHeight: number;
  /** Сторона итогового PNG. */
  outputSize?: number;
}

export interface MemoryEstimate {
  /** Байты, которые задача займёт в пике. */
  bytes: number;
  breakdown: {
    samplePixels: number;
    grids: number;
    optimizer: number;
    output: number;
  };
  withinBudget: boolean;
  budget: number;
}

export class ResourceLimitError extends Error {
  readonly code: string;

  constructor(message: string, code = 'resource_limit') {
    super(message);
    this.name = 'ResourceLimitError';
    this.code = code;
  }
}

/** Оценка пиковой памяти. Цифры приблизительные, но консервативные. */
export function estimateJobMemory(job: JobShape): MemoryEstimate {
  const cells = job.cols * job.rows;

  // RGBA-пиксели рабочего изображения плюс копия под предобработку.
  const samplePixels = job.sampleWidth * job.sampleHeight * 4 * 2;
  // Сетки: средние цвета, палитра, ячейки как объекты (щедрая оценка).
  const grids = cells * 220;
  // Оптимизатор держит матрицу «ячейка × цвет» во Float32.
  const optimizer = cells * LIMITS.maxPaletteColors * 4;
  // Итоговый canvas.
  const side = job.outputSize ?? 0;
  const output = side * side * 4;

  const bytes = samplePixels + grids + optimizer + output;
  return {
    bytes,
    breakdown: { samplePixels, grids, optimizer, output },
    withinBudget: bytes <= LIMITS.memoryBudgetBytes,
    budget: LIMITS.memoryBudgetBytes,
  };
}

/** Бросает ResourceLimitError, если задача не помещается в бюджет. */
export function ensureJobFits(job: JobShape): MemoryEstimate {
  if (job.cols * job.rows > LIMITS.maxCells) {
    throw new ResourceLimitError(
      `Слишком крупная сетка: ${job.cols}×${job.rows}. Максимум — ${LIMITS.maxCells} ячеек.`,
      'too_many_cells',
    );
  }

  const estimate = estimateJobMemory(job);
  if (!estimate.withinBudget) {
    throw new ResourceLimitError(
      `Задаче нужно около ${formatMb(estimate.bytes)} МБ, а бюджет — ${formatMb(estimate.budget)} МБ. ` +
        'Выберите сетку помельче или изображение поменьше.',
      'memory_budget',
    );
  }

  return estimate;
}

/** Во сколько раз нужно уменьшить изображение, чтобы влезть в лимиты. */
export function downscaleFactorFor(width: number, height: number): number {
  const byPixels = Math.sqrt(LIMITS.maxImagePixels / Math.max(1, width * height));
  const bySide = LIMITS.maxImageSide / Math.max(width, height);
  return Math.min(1, byPixels, bySide);
}

export function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
