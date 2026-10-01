import { computeMosaicCore, CancelledError, type MosaicCoreOptions, type MosaicCoreResult } from '../algorithms/mosaicCore';
import {
  createCanvas,
  getCellSize,
  getSampleSize,
  getSourceSize,
  renderMosaicToCanvas,
  sampleImageData,
  type MosaicSource,
} from '../algorithms/mosaicGenerator';
import {
  DEFAULT_BACKGROUND,
  DEFAULT_GRID_COLOR,
  MAX_SAMPLE_SIZE,
  TARGET_OUTPUT_SIZE,
} from '../config/mosaic';
import { getMode, type MosaicMode, type MosaicModeId } from '../config/quality';
import { ensureJobFits } from '../lib/memoryGuard';
import type { MosaicOptions, MosaicProgress, MosaicResult } from '../types/mosaic';
import type { MosaicWorkerRequest, MosaicWorkerResponse } from '../workers/mosaicWorker';

/**
 * Запуск генерации так, чтобы интерфейс оставался живым.
 *
 * Пиксели снимаются на главном потоке (это быстро), тяжёлый расчёт уезжает в
 * Web Worker, отрисовка возвращается на главный поток. Если воркеры
 * недоступны — например, в старом браузере или в тесте — всё считается на
 * месте, тем же кодом.
 */

export interface RunMosaicParams extends MosaicOptions {
  source: MosaicSource;
  mode?: MosaicModeId | MosaicMode;
  preprocess?: MosaicCoreOptions['preprocess'];
  faceExposure?: boolean | number;
  levels?: boolean;
  dithering?: number;
  /** Приведение тона к целевому распределению по палитре, 0..1. */
  toneBalance?: number;
  /** Усиление глаз до усреднения. */
  eyeBoost?: MosaicCoreOptions['eyeBoost'];
  /** Локальный контраст внутри овала лица, 0..1. */
  faceVolume?: number;
  /** Локальный контраст по ячейкам сетки: штрих (fine) и объём (coarse). */
  gridDetail?: MosaicCoreOptions['gridDetail'];
  onProgress?: (progress: MosaicProgress) => void;
  /** Отмена: прерывает расчёт и завершает воркер. */
  signal?: AbortSignal;
  /** Принудительно считать на главном потоке. */
  disableWorker?: boolean;
}

let workerFactory: (() => Worker) | null = null;

/**
 * Как создавать воркер. В Next это `new Worker(new URL(...))`, в автономной
 * сборке — Blob URL. Задаётся приложением, чтобы сервис не зависел от сборщика.
 */
export function setWorkerFactory(factory: (() => Worker) | null): void {
  workerFactory = factory;
}

export function isWorkerAvailable(): boolean {
  return typeof Worker !== 'undefined' && workerFactory !== null;
}

/** Полный путь: пиксели → ядро (в воркере) → canvas. */
export async function runMosaic(params: RunMosaicParams): Promise<MosaicResult> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const mode = typeof params.mode === 'object' ? params.mode : getMode(params.mode);

  const {
    source,
    cols,
    rows,
    maxSampleSize = MAX_SAMPLE_SIZE,
    targetOutputSize = TARGET_OUTPUT_SIZE,
    shape = mode.shape,
    gap = mode.gap,
    background = DEFAULT_BACKGROUND,
    showGrid = false,
    gridColor = DEFAULT_GRID_COLOR,
    palette,
    colorSpace,
    distanceMetric,
    enforcePieceLimits = false,
    costWeights,
    onProgress,
    signal,
  } = params;

  if (signal?.aborted) throw new CancelledError();

  const { width: srcW, height: srcH } = getSourceSize(source);
  if (!srcW || !srcH) throw new Error('Изображение ещё не загружено');

  const sample = getSampleSize(cols, rows, srcW, srcH, maxSampleSize);

  // Проверка бюджета памяти до того, как что-то выделено.
  ensureJobFits({
    cols,
    rows,
    sampleWidth: sample.width,
    sampleHeight: sample.height,
    outputSize: getCellSize(cols, rows, targetOutputSize) * Math.max(cols, rows),
  });

  onProgress?.({ stage: 'processing', value: 0.15, message: 'Читаю пиксели' });
  const imageData = sampleImageData(source, sample.width, sample.height, background);

  const coreOptions = {
    cols,
    rows,
    mode: mode.id,
    colorSpace,
    distanceMetric,
    palette,
    enforcePieceLimits,
    costWeights,
    preprocess: params.preprocess,
    faceExposure: params.faceExposure,
    levels: params.levels,
    dithering: params.dithering,
    toneBalance: params.toneBalance,
    eyeBoost: params.eyeBoost,
    faceVolume: params.faceVolume,
    gridDetail: params.gridDetail,
    sampleWidth: sample.width,
    sampleHeight: sample.height,
  };

  const computeHere = () =>
    computeMosaicCore(imageData, {
      ...coreOptions,
      onProgress,
      shouldCancel: () => Boolean(signal?.aborted),
    });

  let core: MosaicCoreResult;
  if (!params.disableWorker && isWorkerAvailable()) {
    try {
      core = await computeInWorker(imageData, coreOptions, onProgress, signal);
    } catch (cause) {
      if (!(cause instanceof WorkerUnavailableError)) throw cause;
      // Воркер не поднялся (политика безопасности страницы, старый браузер):
      // считаем на главном потоке тем же кодом и больше воркер не пробуем.
      workerFactory = null;
      onProgress?.({ stage: 'processing', value: 0.2, message: 'Считаю без фонового потока' });
      core = computeHere();
    }
  } else {
    core = computeHere();
  }

  if (signal?.aborted) throw new CancelledError();

  onProgress?.({ stage: 'generating', value: 0.9, message: 'Рисую мозаику' });

  const cellSize = getCellSize(cols, rows, targetOutputSize);
  const canvas = renderMosaicToCanvas(core.grid, { cellSize, shape, gap, background, showGrid, gridColor });

  onProgress?.({ stage: 'done', value: 1, message: 'Готово' });

  return {
    grid: core.grid,
    averageGrid: core.averageGrid,
    palette: core.mapping,
    pieceLimit: core.pieceLimit,
    mode: core.mode,
    faces: core.faces,
    weightMap: core.weightMap,
    canvas,
    width: canvas.width,
    height: canvas.height,
    cellSize,
    sampleWidth: sample.width,
    sampleHeight: sample.height,
    options: { ...params, palette, cols, rows },
    durationMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started),
    createdAt: Date.now(),
  };
}

let jobCounter = 0;

/** Воркер не запустился или упал целиком — это не ошибка алгоритма. */
export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

interface PendingJob {
  resolve: (result: MosaicCoreResult) => void;
  reject: (cause: Error) => void;
  onProgress?: (progress: MosaicProgress) => void;
}

/**
 * Один воркер на всё время работы страницы. Раньше воркер создавался на
 * каждую задачу: для одиннадцати вариантов это одиннадцать разборов
 * полумегабайтного скрипта, на телефоне — секунды впустую. Ответы
 * разводятся по jobId, поэтому задачи могут и ждать очереди.
 */
let sharedWorker: Worker | null = null;
const pendingJobs = new Map<string, PendingJob>();

function releaseWorker(): void {
  if (!sharedWorker) return;
  sharedWorker.onmessage = null;
  sharedWorker.onerror = null;
  sharedWorker.terminate();
  sharedWorker = null;
}

function failAllJobs(cause: Error): void {
  const jobs = [...pendingJobs.values()];
  pendingJobs.clear();
  for (const job of jobs) job.reject(cause);
}

function acquireWorker(): Worker {
  if (sharedWorker) return sharedWorker;

  let worker: Worker;
  try {
    worker = (workerFactory as () => Worker)();
  } catch (cause) {
    throw new WorkerUnavailableError(cause instanceof Error ? cause.message : 'воркер не создан');
  }

  worker.onmessage = (event: MessageEvent<MosaicWorkerResponse>) => {
    const message = event.data;
    const job = pendingJobs.get(message.jobId);
    if (!job) return;

    if (message.type === 'progress') {
      job.onProgress?.(message.progress);
      return;
    }
    pendingJobs.delete(message.jobId);
    if (message.type === 'done') {
      job.resolve(message.result as MosaicCoreResult);
      return;
    }
    job.reject(message.cancelled ? new CancelledError() : new Error(message.message));
  };

  // Сюда попадает только сбой самого воркера: скрипт не загрузился или
  // упал вне обработчика. Ошибки расчёта приходят сообщением 'error'.
  worker.onerror = (event) => {
    releaseWorker();
    failAllJobs(new WorkerUnavailableError(event.message ?? 'воркер остановился'));
  };

  sharedWorker = worker;
  return worker;
}

function computeInWorker(
  image: ImageData,
  options: Omit<MosaicCoreOptions, 'onProgress' | 'shouldCancel'>,
  onProgress?: (progress: MosaicProgress) => void,
  signal?: AbortSignal,
): Promise<MosaicCoreResult> {
  return new Promise((resolve, reject) => {
    // Сигнал мог сработать, пока снимались пиксели: addEventListener на уже
    // прерванный сигнал ничего не вызовет, поэтому проверяем явно.
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    let worker: Worker;
    try {
      worker = acquireWorker();
    } catch (cause) {
      reject(cause as Error);
      return;
    }

    const jobId = `job-${++jobCounter}`;

    const onAbort = () => {
      // Прервать расчёт посреди цикла можно только убив воркер; следующая
      // задача поднимет новый.
      pendingJobs.delete(jobId);
      releaseWorker();
      failAllJobs(new CancelledError());
      reject(new CancelledError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    pendingJobs.set(jobId, {
      resolve: (result) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      },
      reject: (cause) => {
        signal?.removeEventListener('abort', onAbort);
        reject(cause);
      },
      onProgress,
    });

    // Буфер передаётся, а не копируется — на 96×96 это экономит мегабайты.
    const buffer = image.data.buffer.slice(0);
    const request: MosaicWorkerRequest = {
      type: 'compute',
      jobId,
      image: { width: image.width, height: image.height, data: buffer },
      options,
    };
    try {
      worker.postMessage(request, [buffer]);
    } catch (cause) {
      pendingJobs.delete(jobId);
      signal?.removeEventListener('abort', onAbort);
      releaseWorker();
      reject(new WorkerUnavailableError(cause instanceof Error ? cause.message : 'воркер не принял задачу'));
    }
  });
}

/** Останавливает общий воркер — например, при выгрузке страницы. */
export function shutdownWorker(): void {
  releaseWorker();
  failAllJobs(new CancelledError());
}

/** Пустой canvas нужного размера — используется при очистке результата. */
export function blankCanvas(width: number, height: number): HTMLCanvasElement {
  return createCanvas(width, height);
}

export { CancelledError };
