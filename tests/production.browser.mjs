/**
 * Браузерные тесты производственной обвязки: мобильная вёрстка, воркер,
 * отмена, проекты, ссылки и разные типы фотографий.
 *
 * Проверяется автономная сборка — в ней то же ядро и те же сервисы, что и в
 * Next-приложении.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workdir = mkdtempSync(join(tmpdir(), 'mosaic-prod-'));
const pageUrl = 'file://' + join(root, 'standalone/index.html');

/** Рисует тестовое изображение прямо в браузере и сохраняет на диск. */
async function drawImage(page, kind, path) {
  const dataUrl = await page.evaluate((kind) => {
    const sizes = {
      portrait: [600, 800],
      landscape: [900, 600],
      dark: [600, 600],
      bright: [600, 600],
      lowres: [64, 48],
      huge: [5200, 3400],
      twoFaces: [900, 500],
      animal: [600, 500],
    };
    const [width, height] = sizes[kind];
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const x = canvas.getContext('2d');

    const face = (cx, cy, rx, ry, skin) => {
      x.fillStyle = '#3a2a24';
      x.beginPath();
      x.ellipse(cx, cy - ry * 0.45, rx * 1.12, ry * 0.8, 0, 0, 7);
      x.fill();
      const gradient = x.createRadialGradient(cx - rx * 0.2, cy - ry * 0.2, rx * 0.2, cx, cy, ry);
      gradient.addColorStop(0, skin[0]);
      gradient.addColorStop(1, skin[1]);
      x.fillStyle = gradient;
      x.beginPath();
      x.ellipse(cx, cy, rx, ry, 0, 0, 7);
      x.fill();
      for (const side of [-1, 1]) {
        x.fillStyle = '#f6f2ec';
        x.beginPath();
        x.ellipse(cx + side * rx * 0.38, cy - ry * 0.18, rx * 0.22, ry * 0.1, 0, 0, 7);
        x.fill();
        x.fillStyle = '#14100f';
        x.beginPath();
        x.arc(cx + side * rx * 0.38, cy - ry * 0.18, rx * 0.09, 0, 7);
        x.fill();
      }
      x.fillStyle = '#b45b57';
      x.beginPath();
      x.ellipse(cx, cy + ry * 0.45, rx * 0.32, ry * 0.09, 0, 0, 7);
      x.fill();
    };

    if (kind === 'portrait' || kind === 'huge' || kind === 'lowres') {
      const sky = x.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, '#5d7f9c');
      sky.addColorStop(1, '#324a63');
      x.fillStyle = sky;
      x.fillRect(0, 0, width, height);
      face(width / 2, height * 0.45, width * 0.24, height * 0.27, ['#f0c3a2', '#c98f68']);
    } else if (kind === 'twoFaces') {
      x.fillStyle = '#c8cdd2';
      x.fillRect(0, 0, width, height);
      face(width * 0.28, height * 0.45, width * 0.12, height * 0.22, ['#f0c3a2', '#c98f68']);
      face(width * 0.72, height * 0.48, width * 0.11, height * 0.2, ['#e0b189', '#b47f5c']);
    } else if (kind === 'landscape') {
      const sky = x.createLinearGradient(0, 0, 0, height * 0.6);
      sky.addColorStop(0, '#4f8ec4');
      sky.addColorStop(1, '#cfe4f2');
      x.fillStyle = sky;
      x.fillRect(0, 0, width, height * 0.6);
      x.fillStyle = '#6f8f4e';
      x.fillRect(0, height * 0.6, width, height * 0.4);
      x.fillStyle = '#8d7a52';
      x.beginPath();
      x.moveTo(0, height * 0.6);
      x.lineTo(width * 0.35, height * 0.22);
      x.lineTo(width * 0.7, height * 0.6);
      x.fill();
    } else if (kind === 'dark') {
      x.fillStyle = '#0b0d12';
      x.fillRect(0, 0, width, height);
      x.fillStyle = '#1d2430';
      x.beginPath();
      x.arc(width * 0.5, height * 0.5, width * 0.3, 0, 7);
      x.fill();
      x.fillStyle = '#2b3444';
      x.fillRect(0, height * 0.8, width, height * 0.2);
    } else if (kind === 'bright') {
      x.fillStyle = '#fdfcf8';
      x.fillRect(0, 0, width, height);
      x.fillStyle = '#f2ece0';
      x.beginPath();
      x.arc(width * 0.45, height * 0.45, width * 0.28, 0, 7);
      x.fill();
      x.fillStyle = '#e8e3d6';
      x.fillRect(0, height * 0.75, width, height * 0.25);
    } else if (kind === 'animal') {
      x.fillStyle = '#60784f';
      x.fillRect(0, 0, width, height);
      x.fillStyle = '#c4803e';
      x.beginPath();
      x.ellipse(width / 2, height / 2, width * 0.32, height * 0.22, 0, 0, 7);
      x.fill();
    }

    return canvas.toDataURL(kind === 'huge' ? 'image/jpeg' : 'image/png', 0.85);
  }, kind);

  writeFileSync(path, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return path;
}

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

async function generate(page, { size = '48', palette = 'basic' } = {}) {
  await page.click(`button[data-size="${size}"]`);
  if (palette) await page.click(`button[data-palette="${palette}"]`);
  await page.click('#generate');
  await page.waitForFunction(() => window.__mosaic.result !== null, null, { timeout: 90000 });
}

test('production: интерфейс, воркер, проекты и разные фотографии', async (t) => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await openApp(page);
  const portrait = await drawImage(page, 'portrait', join(workdir, 'portrait.png'));

  await t.test('1. расчёт уходит в Web Worker', async () => {
    await page.setInputFiles('#file', portrait);
    await page.waitForSelector('#cropStage:visible');

    const report = await page.evaluate(async () => {
      // Замеряем самую длинную паузу главного потока во время генерации.
      let worst = 0;
      let last = performance.now();
      let running = true;
      const tick = () => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      const started = performance.now();
      document.querySelector('button[data-size="64"]').click();
      document.querySelector('button[data-palette="basic"]').click();
      document.getElementById('generate').click();

      await new Promise((resolve) => {
        const check = () => (window.__mosaic.result ? resolve() : setTimeout(check, 20));
        check();
      });

      running = false;
      return { worstFrameGap: worst, totalMs: performance.now() - started };
    });

    assert.ok(report.totalMs > 0);
    // Если бы расчёт шёл на главном потоке, пауза была бы соизмерима с ним целиком.
    assert.ok(
      report.worstFrameGap < report.totalMs * 0.5,
      `главный поток замирал на ${report.worstFrameGap.toFixed(0)} мс из ${report.totalMs.toFixed(0)} мс`,
    );
    console.log(
      `    ↳ генерация ${report.totalMs.toFixed(0)} мс, максимальная пауза интерфейса ${report.worstFrameGap.toFixed(0)} мс`,
    );
  });

  await t.test('2. генерацию можно отменить', async () => {
    // Начинаем с чистой страницы: после первого теста интерфейс уже в режиме результата.
    await openApp(page);
    await page.setInputFiles('#file', portrait);
    await page.waitForSelector('#cropStage:visible');
    await page.click('button[data-size="96"]');
    await page.click('button[data-palette="basic"]');

    await page.click('#generate');
    await page.waitForSelector('#cancel:visible');
    await page.click('#cancel');
    await page.waitForFunction(() => window.__mosaic.cancelled === true, null, { timeout: 30000 });

    assert.equal(await page.evaluate(() => window.__mosaic.result), null, 'результат не появился');
    assert.equal(await page.isVisible('#cancel'), false, 'кнопка отмены спряталась');
    assert.equal(await page.isVisible('#result'), false, 'экран результата не открылся');

    // После отмены можно спокойно запустить снова — состояние не сломалось.
    await page.click('#generate');
    await page.waitForFunction(() => window.__mosaic.result !== null, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__mosaic.result.grid.cells.length), 9216);
  });

  await t.test('3. проекты: сохранение, история, переименование, удаление', async () => {
    // На странице уже есть результат из предыдущего шага.
    assert.notEqual(await page.evaluate(() => window.__mosaic.result), null);
    await page.fill('#projectName', 'Портрет мамы');
    await page.click('#saveProject');
    await page.waitForSelector('#projectsList li');

    let names = await page.$$eval('#projectsList [data-name]', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(names, ['Портрет мамы']);

    // Второй проект встаёт в начало истории.
    await page.evaluate(() => {
      window.__mosaic.projectId = null;
    });
    await page.fill('#projectName', 'Второй');
    await page.click('#saveProject');
    names = await page.$$eval('#projectsList [data-name]', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(names, ['Второй', 'Портрет мамы']);

    // Переименование.
    page.once('dialog', (dialog) => dialog.accept('Переименованный'));
    await page.click('#projectsList li:first-child button[data-action="rename"]');
    await page.waitForFunction(
      () => document.querySelector('#projectsList [data-name]').textContent === 'Переименованный',
      null,
      { timeout: 5000 },
    );

    // История переживает перезагрузку страницы.
    // После перезагрузки набор выбирается заново — история появляется вместе с ним.
    await page.reload();
    await page.waitForSelector('#productCards button');
    await page.click('button[data-preset="classic-s"]');
    await page.waitForSelector('#projectsList li:visible');
    names = await page.$$eval('#projectsList [data-name]', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(names, ['Переименованный', 'Портрет мамы'], 'проекты сохранились в localStorage');

    // Удаление.
    await page.click('#projectsList li:first-child button[data-action="delete"]');
    names = await page.$$eval('#projectsList [data-name]', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(names, ['Портрет мамы']);
  });

  await t.test('4. ссылка «поделиться» переносит настройки, но не фотографию', async () => {
    await page.setInputFiles('#file', portrait);
    await page.waitForSelector('#cropStage:visible');
    // Технические настройки живут в Advanced — открываем и включаем ручной режим.
    await page.click('#advanced summary');
    await page.click('#manualToggle');
    await page.click('button[data-size="96"]');
    await page.click('button[data-palette="portrait"]');
    await page.click('button[data-mode="portrait"]');
    await page.fill('#projectName', 'Для друга');

    const url = await page.evaluate(async () => {
      document.getElementById('shareProject').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return window.__mosaic.shareUrl;
    });

    assert.match(url, /#p=/);
    assert.ok(url.length < 600, `ссылка должна быть короткой, а не ${url.length} символов`);
    assert.ok(!url.includes('data:'), 'фотография в ссылку не попадает');

    const shared = await context.newPage();
    await shared.goto(url);
    // Ссылка открывается на первом шаге: набор ещё не выбран, но настройки уже применены.
    await shared.waitForSelector('#productCards button');

    const applied = await shared.evaluate(() => ({
      size: window.__mosaic.sizeId,
      palette: window.__mosaic.paletteId,
      mode: window.__mosaic.modeId,
      name: document.getElementById('projectName').value,
      hasImage: window.__mosaic.image !== null,
    }));

    assert.deepEqual(applied, {
      size: '96',
      palette: 'portrait',
      mode: 'portrait',
      name: 'Для друга',
      hasImage: false,
    });
    assert.match(await shared.textContent('#notice'), /исходник не передаётся/);
    await shared.close();
  });

  await t.test('5. подделанный файл не проходит проверку', async () => {
    const fake = join(workdir, 'fake.png');
    writeFileSync(fake, Buffer.from('MZ\u0000\u0000это исполняемый файл, а не картинка'));

    await openApp(page);
    await page.setInputFiles('#file', fake);
    await page.waitForSelector('#error:visible');
    assert.match(await page.textContent('#error'), /не похоже/);
  });

  await t.test('6. огромное изображение уменьшается, а не роняет вкладку', async () => {
    const huge = await drawImage(page, 'huge', join(workdir, 'huge.jpg'));
    await page.setInputFiles('#file', huge);
    await page.waitForSelector('#cropStage:visible');

    const info = await page.evaluate(() => ({
      width: window.__mosaic.image.width,
      height: window.__mosaic.image.height,
      downscaled: window.__mosaic.image.downscaled,
      label: document.getElementById('sourceInfo').textContent,
    }));

    assert.ok(info.width <= 8000 && info.height <= 8000);
    assert.ok(info.width * info.height <= 40_000_000);
    if (info.downscaled) assert.match(info.label, /уменьшено с/);

    await generate(page, { size: '48' });
    assert.equal(await page.evaluate(() => window.__mosaic.result.grid.cells.length), 2304);
  });

  await t.test('7. разные типы фотографий проходят целиком', async () => {
    const scenarios = [
      { kind: 'landscape', faces: 0 },
      { kind: 'dark', faces: 0 },
      { kind: 'bright', faces: 0 },
      { kind: 'lowres', faces: null },
      { kind: 'twoFaces', faces: 2 },
      { kind: 'animal', faces: 0 },
    ];

    const summary = [];

    for (const scenario of scenarios) {
      const path = await drawImage(page, scenario.kind, join(workdir, `${scenario.kind}.png`));
      await openApp(page);
      await page.setInputFiles('#file', path);
      await page.waitForSelector('#cropStage:visible');
      await page.click('button[data-mode="portrait"]');
      await generate(page, { size: '48', palette: 'portrait' });

      const report = await page.evaluate(() => ({
        cells: window.__mosaic.result.grid.cells.length,
        faces: window.__mosaic.result.faces.length,
        colors: window.__mosaic.result.palette.usage.length,
        satisfied: window.__mosaic.result.pieceLimit.satisfied,
        ms: window.__mosaic.result.durationMs,
      }));

      assert.equal(report.cells, 2304, `${scenario.kind}: мозаика построена`);
      assert.ok(report.colors > 0, `${scenario.kind}: цвета подобраны`);
      assert.equal(report.satisfied, true, `${scenario.kind}: запас деталей соблюдён`);
      if (scenario.faces !== null) {
        assert.equal(report.faces, scenario.faces, `${scenario.kind}: лиц ${report.faces}, ожидали ${scenario.faces}`);
      }

      summary.push(`${scenario.kind}: лиц ${report.faces}, цветов ${report.colors}, ${report.ms} мс`);
    }

    console.log('    ↳ ' + summary.join('\n    ↳ '));
  });

  await t.test('8. мобильный экран: одна колонка, без горизонтальной прокрутки', async () => {
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const mobilePage = await mobile.newPage();
    await openApp(mobilePage);
    await mobilePage.setInputFiles('#file', portrait);
    await mobilePage.waitForSelector('#cropStage:visible');
    await generate(mobilePage, { size: '48' });

    const layout = await mobilePage.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      smallButtons: [...document.querySelectorAll('button')].filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height < 36;
      }).length,
      buildColumns: getComputedStyle(document.querySelector('.build')).gridTemplateColumns.split(' ').length,
    }));

    assert.equal(layout.overflow, 0, 'горизонтальной прокрутки нет');
    assert.equal(layout.smallButtons, 0, 'все кнопки достаточно крупные для пальца');
    assert.equal(layout.buildColumns, 1, 'инструкция складывается в одну колонку');

    await mobile.close();
  });

  await t.test('9. сквозной путь: загрузка → … → PDF и PNG', async () => {
    await openApp(page);

    // 1. Загрузка.
    await page.setInputFiles('#file', portrait);
    await page.waitForSelector('#cropStage:visible');

    // 2. Кадрирование: приблизить и вернуть в кадр.
    await page.locator('#zoom').fill('1.6');
    assert.equal(await page.evaluate(() => window.__mosaic.view.zoom), 1.6);
    await page.click('#fit');

    // 3. Настройка.
    await page.click('button[data-mode="portrait"]');
    await page.click('button[data-size="64"]');
    await page.click('button[data-palette="portrait"]');
    assert.equal(await page.getAttribute('#limits', 'aria-pressed'), 'true', 'запас деталей учитывается');

    // 4-5. Генерация и оптимизация под запас деталей.
    await page.click('#generate');
    await page.waitForFunction(() => window.__mosaic.result?.pieceLimit, null, { timeout: 90000 });

    const generated = await page.evaluate(() => ({
      cells: window.__mosaic.result.grid.cells.length,
      faces: window.__mosaic.result.faces.length,
      satisfied: window.__mosaic.result.pieceLimit.satisfied,
      violations: window.__mosaic.result.pieceLimit.requirements.filter((item) => item.required > item.available).length,
    }));
    assert.equal(generated.cells, 4096);
    assert.equal(generated.faces, 1, 'лицо найдено');
    assert.equal(generated.satisfied, true);
    assert.equal(generated.violations, 0);

    // 6. Варианты считаются вместе с результатом; выбор — из ленты.
    await page.waitForFunction(() => window.__mosaic.variants?.length >= 8, null, { timeout: 180000 });
    await page.click('#variantStrip figure[data-variant="B"]');
    await page.waitForFunction(() => window.__mosaic.selectedVariant === 'B');

    // 7. Просмотр результата.
    await page.locator('#split').fill('30');
    assert.match(await page.evaluate(() => document.getElementById('clip').style.clipPath), /30%/);

    // 8. Статистика.
    const rows = await page.$$eval('#paletteStats tbody tr', (nodes) =>
      nodes.map((node) => ({
        required: Number(node.querySelector('[data-count]').textContent.replace(/[^\d]/g, '')),
        available: Number(node.querySelector('[data-available]').textContent.replace(/[^\d]/g, '')),
      })),
    );
    assert.ok(rows.length > 0);
    for (const row of rows) assert.ok(row.required <= row.available, 'в статистике нет превышений');

    // 9. Режим сборки.
    await page.click('#nextBlock');
    await page.click('#nextBlock');
    assert.equal(await page.textContent('#stepLabel'), 'Шаг 3 / 64');

    // 10. PDF.
    const [pdf] = await Promise.all([
      page.waitForEvent('download', { timeout: 180000 }),
      page.click('#downloadPdf'),
    ]);
    const pdfPath = join(workdir, 'e2e-instruction.pdf');
    await pdf.saveAs(pdfPath);

    const { readFileSync } = await import('node:fs');
    const pdfBytes = new Uint8Array(readFileSync(pdfPath));
    assert.equal(new TextDecoder().decode(pdfBytes.subarray(0, 8)), '%PDF-1.4');

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({ data: pdfBytes.slice(), disableWorker: true }).promise;
    assert.equal(document.numPages, 5 + 64);

    // 11. PNG.
    const [png] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click('#download'),
    ]);
    const pngPath = join(workdir, 'e2e-mosaic.png');
    await png.saveAs(pngPath);
    const pngBytes = new Uint8Array(readFileSync(pngPath));
    assert.deepEqual([...pngBytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'сигнатура PNG');
    const pngWidth = new DataView(pngBytes.buffer, pngBytes.byteOffset).getUint32(16);
    assert.equal(pngWidth, 2048, 'PNG нужного размера');

    // 12. И проект со всем этим сохраняется.
    await page.fill('#projectName', 'Итоговый проект');
    await page.click('#saveProject');
    await page.waitForSelector('#projectsList li');
    assert.equal(await page.textContent('#projectsList [data-name]'), 'Итоговый проект');

    console.log(
      `    ↳ сквозной путь пройден: ${generated.cells} ячеек, PDF ${document.numPages} стр. (${(pdfBytes.length / 1024 / 1024).toFixed(2)} МБ), PNG 2048×2048`,
    );
  });

  await t.test('10. без ошибок в консоли', () => {
    assert.deepEqual(errors, []);
  });

  await context.close();
  await browser.close();
});
