import { LIMITS } from '../config/limits';

/**
 * Ограничение частоты запросов — скользящее окно в памяти процесса.
 *
 * Этого достаточно для одного инстанса; при нескольких репликах нужен общий
 * счётчик (Redis) — об этом честно написано в отчёте о готовности.
 */

export interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  /** Своя функция времени — удобно в тестах. */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Сколько запросов ещё можно сделать в текущем окне. */
  remaining: number;
  limit: number;
  /** Когда окно освободится, в миллисекундах эпохи. */
  resetAt: number;
  /** Сколько ждать до следующей попытки, в секундах. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions = {}) {
    this.windowMs = options.windowMs ?? LIMITS.rateLimit.windowMs;
    this.maxRequests = options.maxRequests ?? LIMITS.rateLimit.maxRequests;
    this.now = options.now ?? (() => Date.now());
  }

  check(key: string): RateLimitResult {
    const current = this.now();
    const windowStart = current - this.windowMs;

    const timestamps = (this.hits.get(key) ?? []).filter((time) => time > windowStart);

    if (timestamps.length >= this.maxRequests) {
      this.hits.set(key, timestamps);
      const resetAt = timestamps[0] + this.windowMs;
      return {
        allowed: false,
        remaining: 0,
        limit: this.maxRequests,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - current) / 1000)),
      };
    }

    timestamps.push(current);
    this.hits.set(key, timestamps);

    return {
      allowed: true,
      remaining: this.maxRequests - timestamps.length,
      limit: this.maxRequests,
      resetAt: current + this.windowMs,
      retryAfterSeconds: 0,
    };
  }

  /** Убирает протухшие записи, чтобы карта не росла бесконечно. */
  cleanup(): number {
    const windowStart = this.now() - this.windowMs;
    let removed = 0;

    for (const [key, timestamps] of this.hits) {
      const alive = timestamps.filter((time) => time > windowStart);
      if (alive.length === 0) {
        this.hits.delete(key);
        removed++;
      } else if (alive.length !== timestamps.length) {
        this.hits.set(key, alive);
      }
    }

    return removed;
  }

  reset(key?: string): void {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Ключ клиента: сначала заголовки прокси, потом прямой адрес. */
export function clientKey(headers: Headers, fallback = 'unknown'): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return headers.get('x-real-ip') ?? fallback;
}

/** Общие ограничители приложения. */
export const validationLimiter = new RateLimiter();
export const heavyLimiter = new RateLimiter({ maxRequests: LIMITS.rateLimit.heavyMaxRequests });

/** Заголовки ответа по соглашению RateLimit-*. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000))),
  };
  if (!result.allowed) headers['Retry-After'] = String(result.retryAfterSeconds);
  return headers;
}
