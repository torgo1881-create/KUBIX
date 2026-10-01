/**
 * Тесты производственной обвязки: хранилище проектов, ссылки, проверка
 * файлов, серверная валидация, ограничение частоты, защита памяти и
 * контракт воркера.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeAverageGrid } from '../src/algorithms/gridAverage.ts';
import { computeMosaicCore, CancelledError, isCancelled } from '../src/algorithms/mosaicCore.ts';
import { LIMITS } from '../src/config/limits.ts';
import { parsePalettes } from '../src/config/palettes.ts';
import {
  planDownscale,
  sniffImageFormat,
  validateFileBytes,
  validateFileMeta,
  validateImageSize,
} from '../src/lib/fileValidation.ts';
import { downscaleFactorFor, ensureJobFits, estimateJobMemory, ResourceLimitError } from '../src/lib/memoryGuard.ts';
import { handleLimitsRequest, handleValidateRequest } from '../src/server/handlers.ts';
import { RateLimiter, clientKey, rateLimitHeaders } from '../src/server/rateLimiter.ts';
import { validateGenerationRequest } from '../src/server/validation.ts';
import { ProjectStore } from '../src/services/projectStorage.ts';
import { buildShareUrl, decodeSharePayload, encodeSharePayload, readShareUrl } from '../src/services/shareLink.ts';
import { handleWorkerRequest } from '../src/workers/mosaicWorker.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASIC = parsePalettes(JSON.parse(readFileSync(join(root, 'src/config/palettes.json'), 'utf8'))).byId.basic;
const PALETTE_IDS = ['basic', 'portrait', 'grayscale'];

/** Простейшая замена localStorage с настраиваемым лимитом. */
function fakeStorage(limitBytes = Infinity) {
  const map = new Map();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (value.length * 2 > limitBytes) {
        const error = new Error('quota');
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(key, value);
    },
    removeItem: (key) => map.delete(key),
  };
}

const settings = {
  modeId: 'portrait',
  sizeId: '64',
  paletteId: 'portrait',
  distanceMetric: 'ciede2000',
  enforcePieceLimits: true,
  shape: 'square',
  gap: 0,
  showGrid: false,
  colorSpace: 'srgb',
};

const stats = { cols: 64, rows: 64, pieces: 4096, colors: 12, faces: 1, durationMs: 420 };

function makeImage(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

/* -------------------------------------------------------- проекты */

test('проект сохраняется, читается и переименовывается', () => {
  const store = new ProjectStore(fakeStorage());
  assert.equal(store.available, true);
  assert.deepEqual(store.list(), []);

  const saved = store.save({ name: 'Портрет мамы', settings, stats, photoName: 'mom.jpg' });
  assert.equal(saved.ok, true);
  assert.ok(saved.project.id);
  assert.equal(saved.project.createdAt, saved.project.updatedAt);

  assert.equal(store.list().length, 1);
  assert.equal(store.get(saved.project.id).name, 'Портрет мамы');

  const renamed = store.rename(saved.project.id, '  Новое имя  ');
  assert.equal(renamed.name, 'Новое имя');
  assert.equal(store.get(saved.project.id).name, 'Новое имя');

  assert.equal(store.rename('нет-такого', 'x'), null);
  assert.equal(store.remove(saved.project.id), true);
  assert.equal(store.list().length, 0);
});

test('история хранит последние проекты, новые сверху', () => {
  let time = 1000;
  const store = new ProjectStore(fakeStorage(), () => (time += 1000));

  for (let index = 0; index < LIMITS.maxProjects + 4; index++) {
    store.save({ name: `Проект ${index}`, settings, stats });
  }

  const list = store.list();
  assert.equal(list.length, LIMITS.maxProjects, 'лишние вытеснены');
  assert.equal(list[0].name, `Проект ${LIMITS.maxProjects + 3}`, 'самый свежий первый');
  assert.ok(list[0].updatedAt > list[1].updatedAt);
});

test('обновление существующего проекта не плодит копии', () => {
  let time = 5000;
  const store = new ProjectStore(fakeStorage(), () => (time += 100));
  const first = store.save({ name: 'Один', settings, stats });
  const second = store.save({ id: first.project.id, name: 'Один', settings, stats });

  assert.equal(store.list().length, 1);
  assert.equal(second.project.createdAt, first.project.createdAt, 'дата создания сохраняется');
  assert.ok(second.project.updatedAt > first.project.updatedAt);
});

test('нехватка места не ломает сохранение: старое вытесняется', () => {
  const storage = fakeStorage(2600);
  let time = 1;
  const store = new ProjectStore(storage, () => (time += 10));

  const results = [];
  for (let index = 0; index < 6; index++) {
    results.push(store.save({ name: `Проект ${index}`, settings, stats }));
  }

  assert.ok(results.every((result) => result.ok), 'все сохранения успешны');
  assert.ok(results.some((result) => result.evicted > 0), 'место освобождалось вытеснением');
  assert.ok(store.list().length >= 1);
  assert.ok(store.usedBytes() <= 2600);
});

test('автоматическая уборка выкидывает просроченные проекты', () => {
  const storage = fakeStorage();
  const day = 24 * 60 * 60 * 1000;
  let now = 1_000_000_000;
  const store = new ProjectStore(storage, () => now);

  store.save({ name: 'Старый', settings, stats });
  assert.equal(store.list().length, 1);

  // Проект пролежал дольше срока хранения — уборка его выносит.
  now += (LIMITS.projectTtlDays + 5) * day;
  const result = store.cleanup();
  assert.equal(result.removed, 1);
  assert.deepEqual(store.list(), []);

  // А сохранение нового проекта заодно подчищает протухшие само.
  now -= (LIMITS.projectTtlDays + 5) * day;
  store.save({ name: 'Старый', settings, stats });
  now += (LIMITS.projectTtlDays + 5) * day;
  store.save({ name: 'Свежий', settings, stats });
  assert.deepEqual(
    store.list().map((project) => project.name),
    ['Свежий'],
  );
});

test('битые данные в хранилище не роняют приложение', () => {
  const storage = fakeStorage();
  storage.setItem('mosaic.projects.v1', '{это не массив}');
  const store = new ProjectStore(storage);
  assert.deepEqual(store.list(), []);

  storage.setItem('mosaic.projects.v1', JSON.stringify([{ nonsense: true }, null, 42]));
  assert.deepEqual(new ProjectStore(storage).list(), []);
});

test('недоступное хранилище (приватный режим) не ломает работу', () => {
  const store = new ProjectStore(null);
  assert.equal(store.available, false);
  assert.deepEqual(store.list(), []);
  assert.equal(store.save({ name: 'x', settings, stats }).ok, false);
  assert.equal(store.rename('x', 'y'), null);
  assert.deepEqual(store.cleanup(), { removed: 0, bytes: 0 });
});

/* ------------------------------------------------------------ ссылки */

test('ссылка кодирует настройки и читается обратно', () => {
  const url = buildShareUrl('https://example.com/', { version: 1, name: 'Портрет', settings });
  assert.ok(url.includes('#p='));
  assert.ok(!url.includes('data:'), 'фотография в ссылку не попадает');

  const decoded = readShareUrl(url);
  assert.equal(decoded.name, 'Портрет');
  assert.deepEqual(decoded.settings, settings);
});

test('чужая ссылка проверяется, а не применяется на веру', () => {
  assert.equal(decodeSharePayload('не-base64!!'), null);
  assert.equal(decodeSharePayload(encodeSharePayload({ version: 2, name: 'x', settings })), null);
  assert.equal(
    decodeSharePayload(encodeSharePayload({ version: 1, name: 'x', settings: { ...settings, sizeId: '999' } })),
    null,
    'неизвестный размер отклонён',
  );
  assert.equal(
    decodeSharePayload(encodeSharePayload({ version: 1, name: 'x', settings: { ...settings, modeId: 'hack' } })),
    null,
    'неизвестный режим отклонён',
  );

  const clamped = decodeSharePayload(
    encodeSharePayload({ version: 1, name: 'и'.repeat(200), settings: { ...settings, gap: 99 } }),
  );
  assert.equal(clamped.name.length, 80, 'имя обрезано');
  assert.equal(clamped.settings.gap, 0.4, 'зазор приведён к допустимому');
  assert.equal(readShareUrl('https://example.com/'), null);
});

/* ------------------------------------------------- проверка файлов */

test('сигнатуры файлов распознаются', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const text = new TextEncoder().encode('это просто текстовый файл!!!');

  assert.equal(sniffImageFormat(png), 'png');
  assert.equal(sniffImageFormat(jpeg), 'jpeg');
  assert.equal(sniffImageFormat(webp), 'webp');
  assert.equal(sniffImageFormat(text), 'unknown');
});

test('подделанное расширение не проходит', () => {
  const fake = { name: 'photo.png', type: 'image/png', size: 1024 };
  assert.equal(validateFileMeta(fake).ok, true, 'по метаданным всё честно');

  const checked = validateFileBytes(fake, new TextEncoder().encode('MZ\u0000\u0000исполняемый файл'));
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'not_an_image');
});

test('лимиты размеров файла и изображения', () => {
  assert.equal(validateFileMeta({ name: 'a.png', type: 'image/png', size: 0 }).code, 'empty_file');
  assert.equal(
    validateFileMeta({ name: 'a.png', type: 'image/png', size: LIMITS.maxFileBytes + 1 }).code,
    'file_too_large',
  );
  assert.equal(validateFileMeta({ name: 'a.txt', type: 'text/plain', size: 10 }).code, 'unsupported_type');

  assert.equal(validateImageSize(4000, 3000).ok, true);
  assert.equal(validateImageSize(10, 10).code, 'image_too_small');
  assert.equal(validateImageSize(LIMITS.maxImageSide + 1, 100).code, 'image_side_too_large');
  assert.equal(validateImageSize(7000, 7000).code, 'too_many_pixels');
});

test('огромное изображение уменьшается, а не отвергается', () => {
  const plan = planDownscale(12000, 9000);
  assert.equal(plan.needed, true);
  assert.ok(plan.width <= LIMITS.maxImageSide && plan.height <= LIMITS.maxImageSide);
  assert.ok(plan.width * plan.height <= LIMITS.maxImagePixels * 1.01);
  assert.ok(Math.abs(plan.width / plan.height - 12000 / 9000) < 0.01, 'пропорции сохранены');

  const small = planDownscale(1200, 900);
  assert.equal(small.needed, false);
  assert.equal(downscaleFactorFor(1200, 900), 1);
});

/* ------------------------------------------------------ защита памяти */

test('бюджет памяти оценивается и защищает от неподъёмных задач', () => {
  const normal = estimateJobMemory({ cols: 64, rows: 64, sampleWidth: 1536, sampleHeight: 1536, outputSize: 2048 });
  assert.equal(normal.withinBudget, true);
  assert.ok(normal.bytes > 0);
  assert.ok(normal.breakdown.samplePixels > 0 && normal.breakdown.grids > 0);

  assert.doesNotThrow(() => ensureJobFits({ cols: 128, rows: 128, sampleWidth: 1536, sampleHeight: 1536 }));

  assert.throws(
    () => ensureJobFits({ cols: 512, rows: 512, sampleWidth: 4000, sampleHeight: 4000 }),
    (error) => error instanceof ResourceLimitError && error.code === 'too_many_cells',
  );

  assert.throws(
    () => ensureJobFits({ cols: 128, rows: 128, sampleWidth: 12000, sampleHeight: 12000, outputSize: 8192 }),
    (error) => error instanceof ResourceLimitError && error.code === 'memory_budget',
  );
});

/* ------------------------------------------------- серверная валидация */

const validPayload = {
  sizeId: '64',
  modeId: 'portrait',
  paletteId: 'basic',
  enforcePieceLimits: true,
  imageBytes: 2_000_000,
  imageWidth: 1200,
  imageHeight: 1600,
  mimeType: 'image/jpeg',
};

test('корректный запрос проходит валидацию и нормализуется', () => {
  const result = validateGenerationRequest(validPayload, PALETTE_IDS);
  assert.equal(result.ok, true);
  assert.equal(result.value.cols, 64);
  assert.equal(result.value.rows, 64);
  assert.equal(result.value.modeId, 'portrait');
  assert.ok(result.value.estimatedMemoryBytes > 0);
});

test('сервер не верит клиенту: всё вне белого списка отклоняется', () => {
  const cases = [
    [{ sizeId: '999' }, 'unknown_size'],
    [{ modeId: '../../etc/passwd' }, 'unknown_mode'],
    [{ paletteId: 'my-own-palette' }, 'unknown_palette'],
    [{ mimeType: 'application/x-msdownload' }, 'unsupported_type'],
    [{ imageBytes: LIMITS.maxFileBytes + 1 }, 'file_too_large'],
    [{ imageWidth: 10, imageHeight: 10 }, 'too_small'],
    [{ imageWidth: 20000, imageHeight: 20000 }, 'side_too_large'],
  ];

  for (const [patch, code] of cases) {
    const result = validateGenerationRequest({ ...validPayload, ...patch }, PALETTE_IDS);
    assert.equal(result.ok, false, `${code}: запрос должен быть отклонён`);
    assert.ok(
      result.issues.some((issue) => issue.code === code),
      `${code}: ожидали такую причину, получили ${JSON.stringify(result.issues)}`,
    );
  }
});

/* -------------------------------------------------- ограничение частоты */

test('скользящее окно пропускает лимит и блокирует лишнее', () => {
  let now = 0;
  const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3, now: () => now });

  assert.equal(limiter.check('ip-1').allowed, true);
  assert.equal(limiter.check('ip-1').allowed, true);
  const third = limiter.check('ip-1');
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);

  const blocked = limiter.check('ip-1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);

  // Другой клиент не страдает.
  assert.equal(limiter.check('ip-2').allowed, true);

  // Окно уехало — снова можно.
  now += 1001;
  assert.equal(limiter.check('ip-1').allowed, true);
});

test('уборка не даёт таблице лимитов расти бесконечно', () => {
  let now = 0;
  const limiter = new RateLimiter({ windowMs: 100, maxRequests: 5, now: () => now });
  for (let index = 0; index < 50; index++) limiter.check(`ip-${index}`);
  assert.equal(limiter.size, 50);

  now += 200;
  assert.equal(limiter.cleanup(), 50);
  assert.equal(limiter.size, 0);
});

test('ключ клиента берётся из заголовков прокси', () => {
  assert.equal(clientKey(new Headers({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2' })), '10.0.0.1');
  assert.equal(clientKey(new Headers({ 'x-real-ip': '10.0.0.9' })), '10.0.0.9');
  assert.equal(clientKey(new Headers()), 'unknown');

  const headers = rateLimitHeaders({ allowed: false, remaining: 0, limit: 5, resetAt: Date.now() + 1000, retryAfterSeconds: 1 });
  assert.equal(headers['RateLimit-Limit'], '5');
  assert.equal(headers['Retry-After'], '1');
});

/* ------------------------------------------------------- API-обработчики */

function jsonRequest(body, headers = { 'x-forwarded-for': '1.2.3.4' }) {
  return new Request('https://example.com/api/mosaic/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('API: корректный запрос — 200, мусор — 4xx', async () => {
  const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 100 });
  const deps = { allowedPaletteIds: PALETTE_IDS, limiter };

  const ok = await handleValidateRequest(jsonRequest(validPayload), deps);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.ok(ok.headers['RateLimit-Limit']);

  const broken = await handleValidateRequest(jsonRequest('{не json'), deps);
  assert.equal(broken.status, 400);
  assert.equal(broken.body.error, 'invalid_json');

  const array = await handleValidateRequest(jsonRequest([1, 2, 3]), deps);
  assert.equal(array.status, 400);

  const invalid = await handleValidateRequest(jsonRequest({ ...validPayload, sizeId: 'huge' }), deps);
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error, 'validation_failed');
});

test('API: превышение лимита частоты даёт 429 с Retry-After', async () => {
  const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
  const deps = { allowedPaletteIds: PALETTE_IDS, limiter };

  await handleValidateRequest(jsonRequest(validPayload), deps);
  await handleValidateRequest(jsonRequest(validPayload), deps);
  const limited = await handleValidateRequest(jsonRequest(validPayload), deps);

  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(limited.headers['Retry-After']);

  // Другой адрес не заблокирован.
  const other = await handleValidateRequest(jsonRequest(validPayload, { 'x-forwarded-for': '9.9.9.9' }), deps);
  assert.equal(other.status, 200);
});

test('API: лимиты отдаются клиенту', () => {
  const response = handleLimitsRequest(new Request('https://example.com/api/limits'), {
    allowedPaletteIds: PALETTE_IDS,
    limiter: new RateLimiter({ maxRequests: 10 }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.limits.maxCells, LIMITS.maxCells);
  assert.deepEqual(response.body.palettes, PALETTE_IDS);
  assert.ok(response.body.sizes.length >= 4);
});

/* --------------------------------------------------------- ядро и воркер */

test('ядро даёт тот же результат, что и раньше, и отменяется', () => {
  const image = makeImage(256, 256, (x, y) => [x % 256, y % 256, 120]);

  const core = computeMosaicCore(image, {
    cols: 32,
    rows: 32,
    sampleWidth: 256,
    sampleHeight: 256,
    palette: BASIC,
    enforcePieceLimits: true,
    whiteBalance: false,
  });

  assert.equal(core.grid.cells.length, 1024);
  assert.equal(core.mapping.usage.length > 0, true);
  assert.equal(core.pieceLimit.satisfied, true);

  // Средние цвета совпадают с прямым вызовом усреднения — алгоритм не поехал.
  const direct = computeAverageGrid(image, { cols: 32, rows: 32 });
  assert.deepEqual(
    core.averageGrid.cells.map((cell) => cell.hex),
    direct.cells.map((cell) => cell.hex),
  );

  assert.throws(
    () =>
      computeMosaicCore(image, {
        cols: 32,
        rows: 32,
        sampleWidth: 256,
        sampleHeight: 256,
        shouldCancel: () => true,
      }),
    (error) => isCancelled(error) && error instanceof CancelledError,
  );
});

test('контракт воркера: прогресс, результат и ошибки', () => {
  const image = makeImage(128, 128, (x) => [x % 256, 90, 200]);
  const messages = [];

  handleWorkerRequest(
    {
      type: 'compute',
      jobId: 'job-1',
      image: { width: 128, height: 128, data: image.data.buffer },
      options: { cols: 16, rows: 16, sampleWidth: 128, sampleHeight: 128, palette: BASIC },
    },
    (message) => messages.push(message),
  );

  const done = messages.find((message) => message.type === 'done');
  assert.ok(done, 'воркер вернул результат');
  assert.equal(done.jobId, 'job-1');
  assert.equal(done.result.grid.cells.length, 256);
  assert.ok(messages.some((message) => message.type === 'progress'), 'прогресс приходит');

  // Ошибка не роняет воркер, а возвращается сообщением.
  const failures = [];
  handleWorkerRequest(
    {
      type: 'compute',
      jobId: 'job-2',
      image: { width: 0, height: 0, data: new ArrayBuffer(0) },
      options: { cols: 8, rows: 8, sampleWidth: 0, sampleHeight: 0 },
    },
    (message) => failures.push(message),
  );

  const error = failures.find((message) => message.type === 'error');
  assert.ok(error, 'ошибка вернулась сообщением');
  assert.equal(error.cancelled, false);
  assert.ok(error.message.length > 0);
});

test('результат ядра переживает structuredClone — значит, пройдёт через воркер', () => {
  const image = makeImage(64, 64, (x, y) => [x * 4, y * 4, 60]);
  const core = computeMosaicCore(image, {
    cols: 8,
    rows: 8,
    sampleWidth: 64,
    sampleHeight: 64,
    palette: BASIC,
    enforcePieceLimits: true,
  });

  const cloned = structuredClone(core);
  assert.deepEqual(
    cloned.grid.cells.map((cell) => cell.hex),
    core.grid.cells.map((cell) => cell.hex),
  );
  assert.equal(cloned.weightMap.weight.length, core.weightMap.weight.length);
  assert.equal(cloned.pieceLimit.satisfied, core.pieceLimit.satisfied);
});
