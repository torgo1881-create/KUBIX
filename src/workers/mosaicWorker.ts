import { computeMosaicCore, isCancelled, type MosaicCoreOptions } from '../algorithms/mosaicCore';
import type { ImageDataLike, MosaicProgress } from '../types/mosaic';

/**
 * Воркер расчёта мозаики.
 *
 * Сюда уезжает всё, что раньше подвешивало интерфейс на сотни миллисекунд:
 * усреднение, сопоставление с палитрой, поиск лица и оптимизация запаса.
 * Canvas остаётся на главном потоке — воркер получает готовые пиксели и
 * возвращает данные.
 */

export interface MosaicWorkerRequest {
  type: 'compute';
  jobId: string;
  image: { width: number; height: number; data: ArrayBuffer };
  options: Omit<MosaicCoreOptions, 'onProgress' | 'shouldCancel'>;
}

export type MosaicWorkerResponse =
  | { type: 'progress'; jobId: string; progress: MosaicProgress }
  | { type: 'done'; jobId: string; result: unknown; durationMs: number }
  | { type: 'error'; jobId: string; message: string; cancelled: boolean };

/** Обработчик вынесен отдельно, чтобы его можно было проверить тестом без воркера. */
export function handleWorkerRequest(
  request: MosaicWorkerRequest,
  post: (response: MosaicWorkerResponse) => void,
): void {
  const started = Date.now();
  try {
    const image: ImageDataLike = {
      width: request.image.width,
      height: request.image.height,
      data: new Uint8ClampedArray(request.image.data),
    };

    const result = computeMosaicCore(image, {
      ...request.options,
      onProgress: (progress) => post({ type: 'progress', jobId: request.jobId, progress }),
    });

    post({ type: 'done', jobId: request.jobId, result, durationMs: Date.now() - started });
  } catch (cause) {
    post({
      type: 'error',
      jobId: request.jobId,
      message: cause instanceof Error ? cause.message : 'Ошибка расчёта',
      cancelled: isCancelled(cause),
    });
  }
}

// В самом воркере — тонкая обвязка над обработчиком.
if (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function') {
  self.onmessage = (event: MessageEvent<MosaicWorkerRequest>) => {
    if (event.data?.type !== 'compute') return;
    handleWorkerRequest(event.data, (response) => (self as unknown as Worker).postMessage(response));
  };
}
