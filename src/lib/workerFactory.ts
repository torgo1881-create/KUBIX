/**
 * Создание воркера расчёта. Вынесено отдельно: путь к файлу знает только
 * сборщик приложения, а сервис mosaicRunner остаётся независимым.
 */
export function createMosaicWorker(): Worker {
  return new Worker(new URL('../workers/mosaicWorker.ts', import.meta.url), { type: 'module' });
}
