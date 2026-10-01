import { MOSAIC_SIZES } from '../config/mosaic';
import { MOSAIC_MODE_IDS } from '../config/quality';
import type { ProjectSettingsSnapshot } from './projectStorage';

/**
 * Ссылка «поделиться проектом».
 *
 * В ссылку уезжают только настройки и название — фотография остаётся у
 * пользователя. Это и вопрос приватности, и вопрос длины: снимок в URL не
 * помещается. Получатель открывает ссылку, видит те же параметры и
 * подставляет свою фотографию.
 */

export interface SharePayload {
  version: 1;
  name: string;
  settings: ProjectSettingsSnapshot;
}

const PARAM = 'p';

/** Base64url без выравнивания — безопасен для URL. */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function' ? btoa(binary) : nodeBase64Encode(bytes);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return nodeBase64Decode(padded);
}

/** Запасной путь для Node: btoa/atob там есть не всегда. */
function nodeBase64Encode(bytes: Uint8Array): string {
  const buffer = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (!buffer) throw new Error('Нет base64-кодировщика');
  return buffer.from(bytes).toString('base64');
}

function nodeBase64Decode(base64: string): string {
  const buffer = (globalThis as {
    Buffer?: { from(data: string, encoding: string): { toString(encoding: string): string } };
  }).Buffer;
  if (!buffer) throw new Error('Нет base64-декодировщика');
  return buffer.from(base64, 'base64').toString('utf8');
}

export function encodeSharePayload(payload: SharePayload): string {
  return toBase64Url(JSON.stringify(payload));
}

/** Разбор параметра ссылки. Возвращает null на любом мусоре — без исключений. */
export function decodeSharePayload(encoded: string): SharePayload | null {
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(encoded));
    if (!parsed || typeof parsed !== 'object') return null;

    const payload = parsed as Partial<SharePayload>;
    if (payload.version !== 1 || !payload.settings || typeof payload.settings !== 'object') return null;

    const settings = payload.settings as ProjectSettingsSnapshot;

    // Принимаем только известные значения: ссылка приходит извне.
    if (!MOSAIC_SIZES.some((size) => size.id === settings.sizeId)) return null;
    if (!MOSAIC_MODE_IDS.includes(settings.modeId as (typeof MOSAIC_MODE_IDS)[number])) return null;

    return {
      version: 1,
      name: typeof payload.name === 'string' ? payload.name.slice(0, 80) : 'Проект',
      settings: {
        modeId: settings.modeId,
        sizeId: settings.sizeId,
        paletteId: typeof settings.paletteId === 'string' ? settings.paletteId : null,
        distanceMetric: settings.distanceMetric ?? 'ciede2000',
        enforcePieceLimits: settings.enforcePieceLimits !== false,
        shape: settings.shape ?? 'square',
        gap: typeof settings.gap === 'number' ? Math.min(0.4, Math.max(0, settings.gap)) : 0,
        showGrid: Boolean(settings.showGrid),
        colorSpace: settings.colorSpace ?? 'srgb',
      },
    };
  } catch {
    return null;
  }
}

/** Полная ссылка для кнопки «Поделиться». */
export function buildShareUrl(base: string, payload: SharePayload): string {
  const url = new URL(base);
  url.hash = `${PARAM}=${encodeSharePayload(payload)}`;
  return url.toString();
}

/** Достаёт настройки из адреса страницы. */
export function readShareUrl(href: string): SharePayload | null {
  try {
    const url = new URL(href);
    const hash = url.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const encoded = params.get(PARAM);
    return encoded ? decodeSharePayload(encoded) : null;
  } catch {
    return null;
  }
}

/**
 * Отдаёт ссылку пользователю: системное окно «Поделиться», а если его нет —
 * буфер обмена.
 */
export async function shareProject(url: string, title: string): Promise<'shared' | 'copied' | 'failed'> {
  const nav = globalThis.navigator as Navigator | undefined;

  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share({ title, url });
      return 'shared';
    } catch (error) {
      // Пользователь мог просто закрыть окно — это не ошибка.
      if (error instanceof Error && error.name === 'AbortError') return 'failed';
    }
  }

  try {
    if (nav?.clipboard) {
      await nav.clipboard.writeText(url);
      return 'copied';
    }
  } catch {
    // падаем ниже
  }

  return 'failed';
}
