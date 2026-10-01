'use client';

import * as React from 'react';

interface Wanted<T> {
  key: string | null;
  ids: string[];
  run: (id: string) => Promise<T>;
}

const EMPTY: ReadonlyMap<string, never> = new Map<string, never>();

/**
 * Очередь расчётов с кэшем по ключу.
 *
 * Ключ описывает вход (фото, набор, кадр), ids — что по нему нужно
 * посчитать. Задачи идут по одной; уже посчитанное не пересчитывается, пока
 * ключ тот же. Если ключ сменился посреди расчёта, текущая задача спокойно
 * досчитывается и её результат отбрасывается: прерывание убило бы общий
 * воркер вместе с чужими задачами.
 */
export function useKeyedJobs<T>(
  key: string | null,
  ids: string[],
  run: (id: string) => Promise<T>,
  onError?: (message: string) => void,
): { results: ReadonlyMap<string, T>; busy: boolean } {
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  const wanted = React.useRef<Wanted<T>>({ key, ids, run });
  const cache = React.useRef<{ key: string | null; done: Map<string, T>; failed: Set<string> }>({
    key: null,
    done: new Map(),
    failed: new Set(),
  });
  const running = React.useRef(false);
  const mounted = React.useRef(true);
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  wanted.current = { key, ids, run };

  const pump = React.useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (mounted.current) {
        const job = wanted.current;
        if (job.key === null) break;
        if (cache.current.key !== job.key) {
          cache.current = { key: job.key, done: new Map(), failed: new Set() };
        }
        const { done, failed } = cache.current;
        const id = job.ids.find((candidate) => !done.has(candidate) && !failed.has(candidate));
        if (id === undefined) break;

        try {
          const value = await job.run(id);
          // Новая Map на каждый результат: по её смене React видит обновление.
          if (cache.current.key === job.key) {
            cache.current.done = new Map(cache.current.done).set(id, value);
          }
        } catch (cause) {
          if (cache.current.key === job.key) {
            cache.current.failed.add(id);
            onErrorRef.current?.(cause instanceof Error ? cause.message : 'Расчёт не удался.');
          }
        }
        if (mounted.current) rerender();
      }
    } finally {
      running.current = false;
    }
  }, []);

  const idsKey = ids.join('|');
  React.useEffect(() => {
    mounted.current = true;
    void pump();
    return () => {
      mounted.current = false;
    };
  }, [key, idsKey, pump]);

  const current = cache.current.key === key && key !== null ? cache.current : null;
  const results: ReadonlyMap<string, T> = current ? current.done : EMPTY;
  const busy =
    key !== null && ids.some((id) => !results.has(id) && !(current?.failed.has(id) ?? false));

  return { results, busy };
}
