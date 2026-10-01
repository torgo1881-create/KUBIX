import { LIMITS } from '../config/limits';
import { MOSAIC_SIZES } from '../config/mosaic';
import { MOSAIC_MODE_IDS } from '../config/quality';
import { clientKey, rateLimitHeaders, validationLimiter, type RateLimiter } from './rateLimiter';
import { validateGenerationRequest } from './validation';

/**
 * Обработчики API в чистом виде: Request на входе, простой объект ответа на
 * выходе. Роуты Next только оборачивают их — благодаря этому всю серверную
 * логику можно прогонять обычными тестами, без поднятия сервера.
 */

export interface HandlerResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface HandlerDeps {
  allowedPaletteIds: string[];
  limiter?: RateLimiter;
}

export async function handleValidateRequest(request: Request, deps: HandlerDeps): Promise<HandlerResponse> {
  const limiter = deps.limiter ?? validationLimiter;
  const limit = limiter.check(clientKey(request.headers));
  const headers = rateLimitHeaders(limit);

  if (!limit.allowed) {
    return {
      status: 429,
      headers,
      body: { ok: false, error: 'rate_limited', message: 'Слишком много запросов. Попробуйте чуть позже.' },
    };
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return {
      status: 400,
      headers,
      body: { ok: false, error: 'invalid_json', message: 'Тело запроса не является JSON.' },
    };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      status: 400,
      headers,
      body: { ok: false, error: 'invalid_payload', message: 'Ожидался объект с параметрами.' },
    };
  }

  const result = validateGenerationRequest(payload, deps.allowedPaletteIds);
  if (!result.ok) {
    return { status: 422, headers, body: { ok: false, error: 'validation_failed', issues: result.issues } };
  }

  return { status: 200, headers, body: { ok: true, value: result.value } };
}

export function handleLimitsRequest(request: Request, deps: HandlerDeps): HandlerResponse {
  const limiter = deps.limiter ?? validationLimiter;
  const limit = limiter.check(clientKey(request.headers));
  const headers = rateLimitHeaders(limit);

  if (!limit.allowed) {
    return { status: 429, headers, body: { ok: false, error: 'rate_limited' } };
  }

  return {
    status: 200,
    headers,
    body: {
      ok: true,
      limits: {
        maxFileBytes: LIMITS.maxFileBytes,
        maxImageSide: LIMITS.maxImageSide,
        maxImagePixels: LIMITS.maxImagePixels,
        maxCells: LIMITS.maxCells,
        rateLimit: LIMITS.rateLimit,
      },
      sizes: MOSAIC_SIZES.map((size) => ({ id: size.id, cols: size.cols, rows: size.rows })),
      modes: MOSAIC_MODE_IDS,
      palettes: deps.allowedPaletteIds,
    },
  };
}
