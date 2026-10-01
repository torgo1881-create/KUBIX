/**
 * Сквозной тест всего пути в настоящем браузере (Chromium через Playwright):
 * открыть → загрузить → кадрировать → выбрать размер → создать → скачать PNG.
 *
 * Проверяется автономная сборка standalone/index.html, в которой работает
 * ровно то же ядро, что и в Next-приложении (оно вклеено скриптом
 * tools/build-standalone.mjs из src/).
 *
 * Запуск: npm run build:standalone && npm run test:browser
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workdir = mkdtempSync(join(tmpdir(), 'mosaic-e2e-'));
const pageUrl = 'file://' + join(root, 'standalone/index.html');

const RED = [220, 40, 40];
const GREEN = [40, 190, 90];
const BLUE = [40, 80, 220];
const YELLOW = [240, 200, 60];

/** Тестовое фото 512×512: четыре квадранта + чёрная точка в левом верхнем. */
function writeTestPng(path) {
  const size = 512;
  const png = makePng(size, size, (x, y) => {
    if (x === 3 && y === 3) return [0, 0, 0]; // одиночный пиксель: среднее его «размоет»
    const top = y < size / 2;
    const left = x < size / 2;
    return top ? (left ? RED : GREEN) : left ? BLUE : YELLOW;
  });
  writeFileSync(path, png);
  return path;
}

/** Минимальный кодировщик PNG (без внешних зависимостей). */
function makePng(width, height, colorAt) {
  const { deflateSync } = require('node:zlib');
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** Цвет ячейки из мозаики, прочитанный прямо из canvas на странице. */
/**
 * Открывает приложение и доводит его до рабочего экрана.
 *
 * После появления продуктовых наборов технические настройки живут в разделе
 * Advanced: тесты алгоритма выбирают набор, включают ручной режим и дальше
 * работают с теми же элементами, что и раньше.
 */
async function openApp(page, { manual = true } = {}) {
  await page.goto(pageUrl);
  await page.waitForSelector('#productCards button');
  await page.click('button[data-preset="classic-s"]');
  if (manual) {
    await page.click('#advanced summary');
    await page.click('#manualToggle');
  }
}

async function readCellColor(page, gx, gy) {
  // Превью по умолчанию рисует детали с объёмом — цвет ячейки читаем с плоского вида.
  if ((await page.getAttribute('#brickView', 'aria-pressed')) === 'true') await page.click('#brickView');
  return page.evaluate(([gx, gy]) => {
    const canvas = document.getElementById('mosaicView');
    const grid = window.__mosaic.result.grid;
    const cell = canvas.width / grid.cols;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(Math.round((gx + 0.5) * cell), Math.round((gy + 0.5) * cell), 1, 1).data;
    return [data[0], data[1], data[2]];
  }, [gx, gy]);
}

/**
 * Первым в ленте идёт вариант «Как в наборе» с обработкой; проверки точных
 * цветов делаются на варианте A «Как на фото» — минимум вмешательства.
 */
async function pickPlainVariant(page) {
  await page.waitForFunction(() => window.__mosaic.variants && window.__mosaic.variants.length > 0, null, { timeout: 120000 });
  await page.click('#variantStrip figure[data-variant="A"]');
  await page.waitForFunction(() => window.__mosaic.selectedVariant === 'A');
}

function near(actual, expected, tolerance = 6) {
  return actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}


/** Рисует «портрет» в canvas страницы и сохраняет как PNG. */
async function writeDrawnImage(page, path, kind) {
  const dataUrl = await page.evaluate((kind) => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 760;
    const x = canvas.getContext('2d');

    if (kind === 'landscape') {
      const sky = x.createLinearGradient(0, 0, 0, 400);
      sky.addColorStop(0, '#5f9fd0');
      sky.addColorStop(1, '#cfe4f2');
      x.fillStyle = sky;
      x.fillRect(0, 0, 600, 400);
      x.fillStyle = '#6f8f4e';
      x.fillRect(0, 400, 600, 360);
      x.fillStyle = '#8d7a52';
      x.fillRect(0, 380, 600, 40);
      return canvas.toDataURL('image/png');
    }

    const bg = x.createLinearGradient(0, 0, 0, 760);
    bg.addColorStop(0, '#5d7f9c');
    bg.addColorStop(1, '#324a63');
    x.fillStyle = bg;
    x.fillRect(0, 0, 600, 760);
    x.fillStyle = '#2f3f56';
    x.beginPath();
    x.ellipse(300, 760, 260, 180, 0, 0, 7);
    x.fill();
    x.fillStyle = '#3a2a24';
    x.beginPath();
    x.ellipse(300, 300, 180, 220, 0, 0, 7);
    x.fill();
    x.fillStyle = '#c9906f';
    x.fillRect(250, 420, 100, 140);
    const skin = x.createRadialGradient(280, 300, 40, 300, 340, 220);
    skin.addColorStop(0, '#f0c3a2');
    skin.addColorStop(1, '#c98f68');
    x.fillStyle = skin;
    x.beginPath();
    x.ellipse(300, 330, 145, 185, 0, 0, 7);
    x.fill();
    for (const sx of [238, 362]) {
      x.fillStyle = '#f6f2ec';
      x.beginPath();
      x.ellipse(sx, 300, 34, 18, 0, 0, 7);
      x.fill();
      x.fillStyle = '#4a6b52';
      x.beginPath();
      x.arc(sx, 300, 15, 0, 7);
      x.fill();
      x.fillStyle = '#14100f';
      x.beginPath();
      x.arc(sx, 300, 7, 0, 7);
      x.fill();
      x.strokeStyle = '#3a2a24';
      x.lineWidth = 8;
      x.beginPath();
      x.arc(sx, 268, 32, Math.PI * 1.15, Math.PI * 1.85);
      x.stroke();
    }
    x.fillStyle = '#b45b57';
    x.beginPath();
    x.ellipse(300, 440, 52, 20, 0, 0, 7);
    x.fill();
    return canvas.toDataURL('image/png');
  }, kind);

  writeFileSync(path, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return path;
}

test('полный путь: загрузка → кадр → 64×64 → результат → PNG', async (t) => {
  const imagePath = writeTestPng(join(workdir, 'source.png'));
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await t.test('1. страница открывается', async () => {
    await openApp(page);
    // Набор уже выбран хелпером, поэтому загрузка фотографии доступна.
    await page.waitForSelector('#dropzone');
    assert.equal(await page.isVisible('#workspace'), false);
  });

  await t.test('2. изображение загружается и показывается кадр', async () => {
    await page.setInputFiles('#file', imagePath);
    await page.waitForSelector('#cropStage:visible');
    const info = await page.textContent('#sourceInfo');
    assert.match(info, /512×512/);
    assert.equal(await page.getAttribute('body', 'data-stage'), 'processing');
  });

  await t.test('3. кадрирование работает: масштаб и границы', async () => {
    await page.locator('#zoom').fill('2');
    const zoomed = await page.evaluate(() => window.__mosaic.view.zoom);
    assert.equal(zoomed, 2);
    await page.click('#fit');
    const crop = await page.evaluate(() => window.__mosaic.view.zoom);
    assert.equal(crop, 1, 'после «Вписать» масштаб возвращается к 1');
  });

  await t.test('4. выбор размера 64×64', async () => {
    await page.click('button[data-size="64"]');
    assert.equal(await page.getAttribute('button[data-size="64"]', 'aria-pressed'), 'true');
  });

  await t.test('5. генерация даёт корректную сетку', async () => {
    await page.click('button[data-palette=""]'); // сначала без палитры: чистые средние цвета
    await page.click('#generate');
    await page.waitForFunction(() => window.__mosaic.result !== null, null, { timeout: 15000 });
    await page.waitForSelector('#result:visible');
    await pickPlainVariant(page);

    const grid = await page.evaluate(() => {
      const g = window.__mosaic.result.grid;
      return {
        cols: g.cols,
        rows: g.rows,
        count: g.cells.length,
        first: g.cells[0],
        corners: [
          g.cells[0],
          g.cells[g.cols - 1],
          g.cells[(g.rows - 1) * g.cols],
          g.cells[g.cells.length - 1],
        ],
      };
    });

    assert.equal(grid.cols, 64);
    assert.equal(grid.rows, 64);
    assert.equal(grid.count, 4096);

    // структура ячейки строго { x, y, rgb, hex }
    assert.deepEqual(Object.keys(grid.first).sort(), ['hex', 'rgb', 'x', 'y']);
    assert.equal(grid.first.x, 0);
    assert.equal(grid.first.y, 0);
    assert.match(grid.first.hex, /^#[0-9A-F]{6}$/);

    const [topLeft, topRight, bottomLeft, bottomRight] = grid.corners;
    assert.ok(near(topLeft.rgb, RED, 12), `слева сверху ожидали красный, получили ${topLeft.hex}`);
    assert.ok(near(topRight.rgb, GREEN, 12), `справа сверху ожидали зелёный, получили ${topRight.hex}`);
    assert.ok(near(bottomLeft.rgb, BLUE, 12), `слева снизу ожидали синий, получили ${bottomLeft.hex}`);
    assert.ok(near(bottomRight.rgb, YELLOW, 12), `справа снизу ожидали жёлтый, получили ${bottomRight.hex}`);
  });

  await t.test('6. на canvas нарисовано то же, что в сетке', async () => {
    assert.ok(near(await readCellColor(page, 0, 0), RED, 12));
    assert.ok(near(await readCellColor(page, 63, 0), GREEN, 12));
    assert.ok(near(await readCellColor(page, 0, 63), BLUE, 12));
    assert.ok(near(await readCellColor(page, 63, 63), YELLOW, 12));

    // Мозаика — это canvas, а не 4096 элементов. Схема блока (64 ячейки)
    // рисуется элементами намеренно: там нужны номера и подсказки.
    const viewerNodes = await page.evaluate(() => document.querySelectorAll('#compareBox *').length);
    assert.ok(viewerNodes < 20, `просмотрщик рисует мозаику на canvas (${viewerNodes} элементов)`);

    const totalNodes = await page.evaluate(() => document.querySelectorAll('*').length);
    assert.ok(totalNodes < 1000, `на странице ${totalNodes} элементов при 4096 ячейках`);
  });

  await t.test('7. шторка и зум сравнения', async () => {
    await page.locator('#split').fill('20');
    assert.match(await page.evaluate(() => document.getElementById('clip').style.clipPath), /20%/);
    await page.locator('#viewZoom').fill('3');
    assert.match(
      await page.evaluate(() => document.getElementById('mosaicLayer').style.transform),
      /scale\(3\)/,
    );
    await page.locator('#viewZoom').fill('1');
  });

  await t.test('8. кнопка скачивает настоящий PNG', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    const suggested = download.suggestedFilename();
    assert.match(suggested, /^mosaic-64x64\.png$/);

    const saved = join(workdir, suggested);
    await download.saveAs(saved);

    const { readFileSync, statSync } = require('node:fs');
    const bytes = readFileSync(saved);
    assert.ok(statSync(saved).size > 1000, 'файл не пустой');
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'сигнатура PNG');
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.equal(width, 2048);
    assert.equal(height, 2048);
    console.log(`    ↳ скачан ${suggested}: ${width}×${height}, ${(bytes.length / 1024).toFixed(0)} КБ`);
  });

  await t.test('8.5. палитра: каждая ячейка становится цветом детали', async () => {
    await page.click('button[data-palette="basic"]');
    await page.click('#limits'); // сначала без учёта запаса — чистое сопоставление
    assert.equal(await page.getAttribute('#limits', 'aria-pressed'), 'false');
    await page.click('#regenerate');
    await page.waitForFunction(() => window.__mosaic.result?.palette !== undefined, null, { timeout: 15000 });
    await pickPlainVariant(page);

    const report = await page.evaluate(() => {
      const result = window.__mosaic.result;
      const palette = result.palette;
      const allowed = new Set(palette.usage.map((item) => item.color.hex));
      const grid = result.grid;
      return {
        paletteId: palette.paletteId,
        metric: palette.metric,
        outsidePalette: grid.cells.filter((cell) => !allowed.has(cell.hex)).length,
        corners: [
          grid.cells[0],
          grid.cells[grid.cols - 1],
          grid.cells[(grid.rows - 1) * grid.cols],
          grid.cells[grid.cells.length - 1],
        ].map((cell) => cell.hex),
        names: palette.usage.map((item) => item.color.name),
        counts: palette.usage.map((item) => item.count),
        averageDistance: palette.averageDistance,
        // средние цвета сохранены отдельно и не совпадают с палитрой
        averageFirst: result.averageGrid.cells[0].hex,
      };
    });

    assert.equal(report.paletteId, 'basic');
    assert.equal(report.metric, 'ciede2000');
    assert.equal(report.outsidePalette, 0, 'все ячейки — цвета палитры');
    assert.equal(report.counts.reduce((sum, count) => sum + count, 0), 4096);
    assert.ok(report.averageDistance < 12, `средняя ошибка ΔE ${report.averageDistance}`);
    assert.deepEqual(report.corners, ['#C4281B', '#58AB41', '#0055BF', '#F5CD2F']);
    assert.deepEqual(report.names.slice().sort(), ['Blue', 'Green', 'Red', 'Yellow'].sort());
    assert.notEqual(report.averageFirst, '#C4281B', 'средние цвета не затёрты палитрой');
  });

  await t.test('8.6. таблица статистики и легенда', async () => {
    await page.waitForSelector('#paletteReport:visible');
    const rows = await page.$$eval('#paletteStats tbody tr', (nodes) =>
      nodes.map((row) => ({
        color: row.dataset.color,
        cells: [...row.querySelectorAll('td')].map((td) => td.textContent.trim()),
      })),
    );
    assert.equal(rows.length, 4, 'четыре использованных цвета');
    assert.deepEqual(
      rows.map((row) => row.color).sort(),
      ['blue', 'green', 'red', 'yellow'],
    );
    for (const row of rows) {
      assert.match(row.cells[1], /^#[0-9A-F]{6}$/, 'колонка HEX');
      assert.match(row.cells[2], /^[\d\s\u00a0]+$/, 'колонка Количество');
    }
    const total = await page.textContent('#paletteStats tfoot [data-total]');
    assert.equal(total.replace(/[^\d]/g, ''), '4096');

    const legend = await page.$$eval('#legendBar span', (nodes) => nodes.length);
    assert.equal(legend, 4, 'в легенде столько же цветов');
  });

  await t.test('8.7. цвет ячейки на canvas совпадает с цветом детали', async () => {
    const hexOf = (rgb) =>
      '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
    assert.equal(hexOf(await readCellColor(page, 0, 0)), '#C4281B');
    assert.equal(hexOf(await readCellColor(page, 63, 63)), '#F5CD2F');
  });

  await t.test('8.75. запас деталей: ни один цвет не превышает лимит', async () => {
    // В демо-палитре у красного 300 деталей, а квадрант требует больше 1000.
    await page.click('#limits');
    assert.equal(await page.getAttribute('#limits', 'aria-pressed'), 'true');
    await page.click('#regenerate');
    await page.waitForFunction(() => window.__mosaic.result?.pieceLimit !== undefined, null, {
      timeout: 20000,
    });

    const limits = await page.evaluate(() => {
      const result = window.__mosaic.result;
      const limit = result.pieceLimit;
      return {
        feasible: limit.feasible,
        satisfied: limit.satisfied,
        moved: limit.moved,
        addedError: limit.addedError,
        cells: result.grid.cells.length,
        pieces: limit.requirements.reduce((sum, item) => sum + item.required, 0),
        violations: limit.requirements
          .filter((item) => item.required > item.available)
          .map((item) => `${item.color.name} ${item.required}/${item.available}`),
        corrected: limit.requirements.filter((item) => item.status === 'corrected').map((item) => item.color.name),
        redBefore: limit.requirements.find((item) => item.color.name === 'Red')?.initialRequired,
      };
    });

    assert.equal(limits.feasible, true);
    assert.equal(limits.satisfied, true);
    assert.deepEqual(limits.violations, [], 'required ≤ available для всех цветов');
    assert.equal(limits.pieces, limits.cells, 'ни одна ячейка не потерялась');
    assert.ok(limits.moved > 0, 'переназначения были');
    assert.ok(limits.redBefore > 300, `красного просили ${limits.redBefore} при запасе 300`);
    assert.ok(limits.corrected.includes('Red'), 'красный получил статус corrected');
    assert.ok(limits.addedError < 15, `ошибка выросла на ΔE ${limits.addedError}`);
  });

  await t.test('8.76. таблица показывает Required / Available / Status', async () => {
    const rows = await page.$$eval('#paletteStats tbody tr', (nodes) =>
      nodes.map((row) => ({
        color: row.dataset.color,
        required: Number(row.querySelector('[data-count]').textContent.replace(/[^\d]/g, '')),
        available: Number(row.querySelector('[data-available]').textContent.replace(/[^\d]/g, '')),
        status: row.querySelector('[data-status]').dataset.status,
      })),
    );

    assert.ok(rows.length >= 4);
    for (const row of rows) {
      assert.ok(row.required <= row.available, `${row.color}: ${row.required} ≤ ${row.available}`);
      assert.ok(['ok', 'corrected'].includes(row.status), `${row.color}: статус ${row.status}`);
    }
    assert.ok(rows.some((row) => row.status === 'corrected'), 'есть исправленные цвета');
    assert.match(await page.textContent('#limitSummary'), /Запас деталей учтён/);
  });

  await t.test('8.8. смена метрики пересобирает мозаику', async () => {
    await page.click('button[data-metric="cie76"]');
    await page.click('#regenerate');
    await page.waitForFunction(() => window.__mosaic.result?.palette?.metric === 'cie76', null, {
      timeout: 15000,
    });
    await page.click('button[data-metric="ciede2000"]');
  });

  await t.test('9. regenerate с другим размером', async () => {
    await page.click('button[data-size="32"]');
    await page.click('#regenerate');
    await page.waitForFunction(() => window.__mosaic.result.grid.cols === 32, null, { timeout: 15000 });
    const info = await page.evaluate(() => ({
      cols: window.__mosaic.result.grid.cols,
      count: window.__mosaic.result.grid.cells.length,
      width: window.__mosaic.result.width,
      pieces: window.__mosaic.result.palette.usage.reduce((sum, item) => sum + item.count, 0),
    }));
    assert.deepEqual(info, { cols: 32, count: 1024, width: 2048, pieces: 1024 });
  });

  await t.test('10. возврат к кадру и сброс', async () => {
    await page.click('#back');
    await page.waitForSelector('#cropStage:visible');
    assert.equal(await page.isVisible('#result'), false);
    // Сброс теперь возвращает к первому шагу — выбору набора.
    await page.click('#reset');
    await page.waitForSelector('#productStep:visible');
    assert.equal(await page.isVisible('#workspace'), false);
    assert.equal(await page.isVisible('#dropzone'), false, 'до выбора набора фото не загрузить');
  });

  await t.test('11. неподходящий файл отклоняется', async () => {
    const badPath = join(workdir, 'notes.txt');
    writeFileSync(badPath, 'это не картинка');
    // Возвращаемся на рабочий экран: файл проверяется на шаге загрузки.
    await page.click('button[data-preset="classic-s"]');
    await page.setInputFiles('#file', badPath);
    await page.waitForSelector('#error:visible');
    assert.match(await page.textContent('#error'), /JPG/);
  });

  await t.test('13. портрет: лицо найдено, глаза и рот защищены', async () => {
    const portraitPath = await writeDrawnImage(page, join(workdir, 'portrait.png'), 'portrait');
    await page.setInputFiles('#file', portraitPath);
    await page.waitForSelector('#cropStage:visible');

    await page.click('button[data-mode="portrait"]');
    await page.click('button[data-size="64"]');
    await page.click('button[data-palette="portrait"]');
    await page.click('#generate');
    await page.waitForFunction(() => window.__mosaic.result?.faces !== undefined, null, { timeout: 25000 });

    const report = await page.evaluate(() => {
      const result = window.__mosaic.result;
      return {
        mode: result.mode,
        faces: result.faces.length,
        eyes: result.faces[0]?.eyes.length ?? 0,
        mouth: Boolean(result.faces[0]?.mouth),
        hair: Boolean(result.faces[0]?.hair),
        confidence: result.faces[0]?.face.confidence ?? 0,
        counts: result.weightMap.counts,
        maxWeight: Math.max(...result.weightMap.weight),
      };
    });

    assert.equal(report.mode, 'portrait');
    assert.equal(report.faces, 1, 'ровно одно лицо');
    assert.equal(report.eyes, 2, 'оба глаза');
    assert.equal(report.mouth, true, 'рот найден');
    assert.equal(report.hair, true, 'волосы найдены');
    assert.ok(report.confidence > 0.5);
    assert.ok(report.counts.eyes > 0 && report.counts.mouth > 0 && report.counts.contour > 0);
    assert.ok(report.maxWeight >= 2.5, `максимальный вес ${report.maxWeight}`);
    assert.match(await page.textContent('#faceInfo'), /глаза: 2/);
  });

  await t.test('13.5. лента вариантов: параметры, лимиты и оценки', async () => {
    // Варианты считаются вместе с результатом — отдельной кнопки нет.
    await page.waitForFunction(() => window.__mosaic.variants?.length >= 8, null, { timeout: 120000 });
    await page.waitForSelector('#variantStrip figure canvas');

    const cards = await page.evaluate(() =>
      window.__mosaic.variants.map((variant) => ({
        id: variant.id,
        pieces: variant.statistics.pieces,
        colors: variant.statistics.colors,
        score: variant.qualityScore.total,
        withinLimits: variant.statistics.withinLimits,
        hasFigure: Boolean(document.querySelector(`#variantStrip figure[data-variant="${variant.id}"] canvas`)),
      })),
    );

    assert.ok(cards.map((card) => card.id).includes('A') && cards.map((card) => card.id).includes('B'));
    for (const card of cards) {
      assert.equal(card.pieces, 4096, `${card.id}: деталей столько же, сколько ячеек`);
      assert.ok(card.colors > 0 && card.colors <= 14, `${card.id}: цветов ${card.colors}`);
      assert.ok(card.score >= 0 && card.score <= 100, `${card.id}: score ${card.score}`);
      assert.equal(card.withinLimits, true, `${card.id}: запас деталей не нарушен`);
      assert.ok(card.hasFigure, `${card.id}: миниатюра в ленте`);
    }

    // Ни один вариант не выпущен с нарушенными лимитами — проверяем и по данным.
    const violations = await page.evaluate(() =>
      window.__mosaic.variants.flatMap((variant) =>
        (variant.statistics.requirements ?? [])
          .filter((item) => item.required > item.available)
          .map((item) => `${variant.id}:${item.color.name}`),
      ),
    );
    assert.deepEqual(violations, []);

    // Варианты отличаются параметрами, а не шумом: разные настройки → разные картинки.
    const settings = await page.evaluate(() =>
      window.__mosaic.variants.map((variant) => JSON.stringify(variant.settings)),
    );
    assert.equal(new Set(settings).size, settings.length, 'у каждого варианта свои настройки');

    const digests = await page.$$eval('#variantStrip figure canvas', (nodes) =>
      nodes.map((canvas) => {
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        let hash = 0;
        for (let i = 0; i < data.length; i += 61) hash = (hash * 31 + data[i]) % 1000000007;
        return hash;
      }),
    );
    assert.ok(new Set(digests).size >= digests.length - 1, 'миниатюры различаются');

    assert.ok(new Set(cards.map((card) => card.score)).size > 1, 'оценки не совпадают у всех подряд');
  });

  await t.test('13.6. оценка воспроизводима, а не случайна', async () => {
    const before = await page.evaluate(() =>
      window.__mosaic.variants.map((variant) => variant.qualityScore.total),
    );

    // Обнуляем список, иначе условие ожидания выполнилось бы на старых данных.
    await page.evaluate(() => {
      window.__mosaic.variants = null;
    });
    await page.click('#regenerate');
    await page.waitForFunction((count) => window.__mosaic.variants?.length === count, before.length, {
      timeout: 120000,
    });
    const after = await page.evaluate(() => window.__mosaic.variants.map((variant) => variant.qualityScore.total));
    assert.deepEqual(after, before, 'повторный расчёт даёт те же оценки');
  });

  await t.test('13.7. выбранный вариант становится главным результатом', async () => {
    await page.click('#variantStrip figure[data-variant="B"]');
    await page.waitForFunction(() => window.__mosaic.selectedVariant === 'B');

    const state = await page.evaluate(() => ({
      selected: window.__mosaic.selectedVariant,
      mode: window.__mosaic.result.mode,
      cells: window.__mosaic.result.grid.cells.length,
      sameCanvas:
        window.__mosaic.result.canvas ===
        window.__mosaic.variants.find((variant) => variant.id === 'B').mosaic.canvas,
    }));

    assert.equal(state.selected, 'B');
    assert.equal(state.mode, 'portrait', 'вариант B собран портретным режимом');
    assert.equal(state.cells, 4096);
    assert.equal(state.sameCanvas, true, 'главный результат — это и есть вариант B');

    assert.equal(await page.getAttribute('#variantStrip figure[data-variant="B"]', 'aria-selected'), 'true');
  });

  await t.test('14. A/B: четыре плитки и все разные', async () => {
    await page.click('#compare');
    await page.waitForSelector('#abPreview figure canvas');
    await page.waitForFunction(() => document.querySelectorAll('#abPreview figure').length === 4, null, {
      timeout: 30000,
    });

    const labels = await page.$$eval('#abPreview figure', (nodes) => nodes.map((node) => node.dataset.preview));
    assert.deepEqual(labels, ['original', 'standard', 'portrait', 'highContrast']);

    // Плитки должны отличаться пикселями, а не подписями.
    const digests = await page.$$eval('#abPreview figure canvas', (nodes) =>
      nodes.map((canvas) => {
        const ctx = canvas.getContext('2d');
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let hash = 0;
        for (let i = 0; i < data.length; i += 97) hash = (hash * 31 + data[i]) % 1000000007;
        return hash;
      }),
    );
    assert.equal(new Set(digests).size, 4, 'все четыре превью различаются');
  });

  await t.test('15. пейзаж: лиц нет, генерация идёт обычным путём', async () => {
    const landscapePath = await writeDrawnImage(page, join(workdir, 'landscape.png'), 'landscape');
    await page.setInputFiles('#file', landscapePath);
    await page.waitForSelector('#cropStage:visible');
    await page.click('#generate');
    await page.waitForFunction(() => window.__mosaic.result?.faces !== undefined, null, { timeout: 25000 });

    const report = await page.evaluate(() => ({
      faces: window.__mosaic.result.faces.length,
      cells: window.__mosaic.result.grid.cells.length,
      weights: new Set(Array.from(window.__mosaic.result.weightMap.weight)).size,
    }));

    assert.equal(report.faces, 0, 'лиц в пейзаже нет');
    assert.equal(report.cells, 4096, 'мозаика всё равно построена');
    assert.match(await page.textContent('#faceInfo'), /Лиц не найдено/);
  });

  await t.test('16. build mode: шаги, прогресс и подсветка блока', async () => {
    await page.waitForSelector('#buildMode');

    const initial = await page.evaluate(() => ({
      step: document.getElementById('stepLabel').textContent,
      blocks: window.__mosaic.plan.blocks.length,
      cells: document.querySelectorAll('#blockGrid div').length,
      prevDisabled: document.getElementById('prevBlock').disabled,
      highlight: document.getElementById('highlight').style.left,
    }));

    assert.equal(initial.blocks, 64, '64×64 разбито на 64 блока 8×8');
    assert.equal(initial.step, 'Шаг 1 / 64');
    assert.equal(initial.cells, 64, 'в схеме блока 64 ячейки');
    assert.equal(initial.prevDisabled, true, 'на первом шаге Previous недоступен');
    assert.equal(initial.highlight, '0%');

    await page.click('#nextBlock');
    await page.click('#nextBlock');
    const moved = await page.evaluate(() => ({
      step: document.getElementById('stepLabel').textContent,
      meta: document.getElementById('blockMeta').textContent,
      highlight: document.getElementById('highlight').style.left,
      progress: document.querySelector('#blockProgress span').style.width,
      numbers: [...document.querySelectorAll('#blockGrid div')].map((cell) => Number(cell.dataset.cellNumber)),
    }));

    assert.equal(moved.step, 'Шаг 3 / 64');
    assert.match(moved.meta, /BLOCK 03/);
    assert.notEqual(moved.highlight, '0%', 'подсветка переехала');
    assert.match(moved.progress, /4\.6875%/);
    assert.ok(moved.numbers.every((number) => number >= 1), 'у каждой ячейки есть номер легенды');

    await page.click('#prevBlock');
    assert.equal(await page.textContent('#stepLabel'), 'Шаг 2 / 64');

    // Смена размера блока пересобирает план.
    await page.click('button[data-block-size="16"]');
    const bigger = await page.evaluate(() => ({
      blocks: window.__mosaic.plan.blocks.length,
      cells: document.querySelectorAll('#blockGrid div').length,
      step: document.getElementById('stepLabel').textContent,
    }));
    assert.equal(bigger.blocks, 16);
    assert.equal(bigger.cells, 256);
    assert.equal(bigger.step, 'Шаг 1 / 16');

    await page.click('button[data-block-size="8"]');
    assert.equal(await page.evaluate(() => window.__mosaic.plan.blocks.length), 64);
  });

  await t.test('17. PDF реально скачивается и открывается', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120000 }),
      page.click('#downloadPdf'),
    ]);

    assert.match(download.suggestedFilename(), /^mosaic-instruction-64x64\.pdf$/);
    const saved = join(workdir, download.suggestedFilename());
    await download.saveAs(saved);

    const { readFileSync } = require('node:fs');
    const bytes = new Uint8Array(readFileSync(saved));
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), '%PDF-1.4');
    assert.ok(bytes.length > 200000, `PDF подозрительно мал: ${bytes.length} байт`);

    const sizeMb = bytes.length / 1024 / 1024;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // pdfjs забирает буфер себе, поэтому отдаём копию.
    const document = await pdfjs.getDocument({ data: bytes.slice(), disableWorker: true }).promise;

    assert.equal(document.numPages, 5 + 64, 'обложка, фото, мозаика, палитра, статистика и 64 блока');

    const textOf = async (pageNumber) => {
      const pdfPage = await document.getPage(pageNumber);
      const content = await pdfPage.getTextContent();
      return content.items
        .map((item) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    assert.match(await textOf(1), /Инструкция по сборке/, 'русский текст в PDF');
    assert.match(await textOf(2), /Исходная фотография/);
    assert.match(await textOf(3), /Готовая мозаика/);
    assert.match(await textOf(4), /Палитра и легенда/);
    assert.match(await textOf(5), /Статистика/);
    assert.match(await textOf(6), /BLOCK 01/);
    assert.match(await textOf(69), /BLOCK 64/);

    // Страницы с фотографиями действительно содержат изображения.
    const photoPage = await document.getPage(2);
    const operators = await photoPage.getOperatorList();
    assert.ok(operators.fnArray.includes(pdfjs.OPS.paintImageXObject), 'JPEG вставлен как XObject');

    console.log(`    ↳ PDF из браузера: ${document.numPages} страниц, ${sizeMb.toFixed(2)} МБ`);
  });

  await t.test('12. без ошибок в консоли', () => {
    assert.deepEqual(consoleErrors, []);
  });

  await context.close();
  await browser.close();
});
