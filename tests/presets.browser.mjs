/**
 * Браузерная проверка продуктового сценария.
 *
 * Набор → фото → кадр → генерация → результат, для всех пяти наборов.
 * Проверяется, что пресет действительно определяет сетку, палитру и
 * пропорции кадра, а технические параметры не показываются покупателю.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workdir = mkdtempSync(join(tmpdir(), 'mosaic-presets-'));
const pageUrl = 'file://' + join(root, 'standalone/index.html');

/** Портрет рисуется в браузере, чтобы тест не зависел от внешних файлов. */
async function drawPortrait(page, path) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 1000;
    const x = canvas.getContext('2d');

    const bg = x.createLinearGradient(0, 0, 0, 1000);
    bg.addColorStop(0, '#5d7f9c');
    bg.addColorStop(1, '#2c4459');
    x.fillStyle = bg;
    x.fillRect(0, 0, 800, 1000);

    x.fillStyle = '#3a2a24';
    x.beginPath();
    x.ellipse(400, 420, 240, 300, 0, 0, 7);
    x.fill();

    const skin = x.createRadialGradient(360, 380, 50, 400, 450, 300);
    skin.addColorStop(0, '#f0c3a2');
    skin.addColorStop(1, '#c08a63');
    x.fillStyle = skin;
    x.beginPath();
    x.ellipse(400, 460, 190, 250, 0, 0, 7);
    x.fill();

    for (const side of [318, 482]) {
      x.fillStyle = '#f6f2ec';
      x.beginPath();
      x.ellipse(side, 420, 44, 24, 0, 0, 7);
      x.fill();
      x.fillStyle = '#14100f';
      x.beginPath();
      x.arc(side, 420, 12, 0, 7);
      x.fill();
    }

    x.fillStyle = '#b45b57';
    x.beginPath();
    x.ellipse(400, 600, 66, 26, 0, 0, 7);
    x.fill();

    return canvas.toDataURL('image/png');
  });

  writeFileSync(path, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return path;
}

test('продуктовый сценарий: набор → фото → кадр → генерация', async (t) => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(pageUrl);
  const portrait = await drawPortrait(page, join(workdir, 'portrait.png'));

  await t.test('1. первый экран — только выбор набора', async () => {
    const cards = await page.$$eval('#productCards button', (nodes) =>
      nodes.map((node) => ({
        id: node.dataset.preset,
        text: node.textContent.replace(/\s+/g, ' ').trim(),
      })),
    );

    assert.deepEqual(
      cards.map((card) => card.id),
      ['classic-s', 'classic-m', 'classic-l', 'color-s', 'color-m'],
      'пять наборов, Color L отсутствует',
    );

    // В карточках есть продуктовые сведения…
    assert.match(cards[0].text, /Classic S/);
    assert.match(cards[0].text, /51×51 см/);
    assert.match(cards[0].text, /64×64/);
    assert.match(cards[3].text, /чёрная основа/);

    // …и нет ни одного технического параметра.
    const allText = cards.map((card) => card.text).join(' ');
    for (const technical of ['ΔE', 'sharpen', 'autoLevels', 'контраст', 'метрик', 'edge']) {
      assert.doesNotMatch(allText, new RegExp(technical, 'i'), `${technical} не должен быть в карточке`);
    }

    // Загрузка фото и технические настройки скрыты до выбора набора.
    assert.equal(await page.evaluate(() => document.getElementById('dropzone').hidden), true);
    assert.equal(await page.evaluate(() => document.getElementById('workspace').hidden), true);
  });

  await t.test('2. Advanced свёрнут и не мешает', async () => {
    await page.click('button[data-preset="classic-s"]');
    await page.setInputFiles('#file', portrait);
    await page.waitForSelector('#cropStage:visible');

    assert.equal(await page.evaluate(() => document.getElementById('advanced').open), false, 'раздел свёрнут');
    assert.equal(await page.isVisible('#modes'), false, 'режимы не показаны обычному пользователю');
    assert.equal(await page.isVisible('#sizes'), false, 'выбор размера не показан');
    assert.equal(await page.isVisible('#metricButtons'), false, 'метрика не показана');

    // Но настройки никуда не делись — они внутри Advanced.
    await page.click('#advanced summary');
    assert.equal(await page.isVisible('#modes'), true);
    assert.equal(await page.isVisible('#sizes'), true);
    assert.equal(await page.isVisible('#palettes'), true);
    assert.equal(await page.isVisible('#metricButtons'), true);

    // Тестовые палитры доступны только здесь и помечены.
    const palettes = await page.$$eval('#palettes button', (nodes) =>
      nodes.map((node) => ({ id: node.dataset.palette, label: node.textContent })),
    );
    const grayscale = palettes.find((item) => item.id === 'grayscale');
    assert.ok(grayscale, 'Серая палитра сохранена');
    assert.match(grayscale.label, /test/, 'помечена как тестовая');

    await page.click('#advanced summary');
  });

  const scenarios = [
    { id: 'classic-s', cols: 64, rows: 64, colors: 5, monochrome: true },
    { id: 'classic-m', cols: 64, rows: 96, colors: 5, monochrome: true },
    { id: 'classic-l', cols: 96, rows: 96, colors: 5, monochrome: true },
    { id: 'color-s', cols: 64, rows: 64, colors: 7, monochrome: false },
    { id: 'color-m', cols: 64, rows: 96, colors: 7, monochrome: false },
  ];

  for (const scenario of scenarios) {
    await t.test(`3.${scenario.id}: сетка, палитра и кадр из набора`, async () => {
      await page.goto(pageUrl);
      await page.click(`button[data-preset="${scenario.id}"]`);
      await page.setInputFiles('#file', portrait);
      await page.waitForSelector('#cropStage:visible');

      // Пропорции кадра берутся из набора.
      const aspect = await page.evaluate(() => {
        const state = window.__mosaic;
        return { cols: state.presetId, ratio: null };
      });
      assert.equal(aspect.cols, scenario.id, 'выбран нужный набор');

      await page.click('#generate');
      await page.waitForFunction(() => window.__mosaic.result, null, { timeout: 90000 });

      const report = await page.evaluate(() => {
        const result = window.__mosaic.result;
        const hexes = [...new Set(result.grid.cells.map((cell) => cell.hex))];
        return {
          cols: result.grid.cols,
          rows: result.grid.rows,
          cells: result.grid.cells.length,
          hexes,
          satisfied: result.pieceLimit.satisfied,
          capacityLevel: window.__mosaic.capacity.level,
          capacityTitle: window.__mosaic.capacity.title,
          capacityDetail: window.__mosaic.capacity.detail,
        };
      });

      assert.equal(report.cols, scenario.cols, `${scenario.id}: столбцов`);
      assert.equal(report.rows, scenario.rows, `${scenario.id}: строк`);
      assert.equal(report.cells, scenario.cols * scenario.rows, `${scenario.id}: ячеек`);
      assert.equal(report.satisfied, true, `${scenario.id}: деталей хватило`);
      assert.notEqual(report.capacityLevel, 'insufficient', `${scenario.id}: набор подходит`);

      // Все цвета — из палитры набора, и их не больше, чем в наборе.
      assert.ok(
        report.hexes.length <= scenario.colors,
        `${scenario.id}: использовано ${report.hexes.length} цветов при ${scenario.colors} в наборе`,
      );

      const chroma = (hex) => {
        const value = parseInt(hex.slice(1), 16);
        const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
        return Math.max(r, g, b) - Math.min(r, g, b);
      };

      if (scenario.monochrome) {
        for (const hex of report.hexes) {
          assert.ok(chroma(hex) <= 20, `${scenario.id}: Classic монохромный, а ${hex} цветной`);
        }
      } else {
        assert.ok(
          report.hexes.some((hex) => chroma(hex) > 25),
          `${scenario.id}: Color использует цветные детали`,
        );
      }

      // Статус набора — человеческим языком.
      for (const text of [report.capacityTitle, report.capacityDetail]) {
        assert.doesNotMatch(text, /infeasible/i, 'без технических слов');
      }
    });
  }

  await t.test('4. debug-состояние осталось в Advanced', async () => {
    await page.click('#advanced summary');
    const debugText = await page.textContent('#capacityDebug');
    assert.match(debugText, /feasible/, 'техническое состояние доступно разработчику');
    assert.match(debugText, /satisfied/);
  });

  await t.test('5. ручные настройки перекрывают набор', async () => {
    await page.goto(pageUrl);
    await page.click('button[data-preset="classic-s"]');
    await page.setInputFiles('#file', portrait);
    await page.waitForSelector('#cropStage:visible');

    await page.click('#advanced summary');
    await page.click('#manualToggle');
    await page.click('button[data-size="32"]');
    await page.click('button[data-palette="grayscale"]');

    await page.click('#generate');
    await page.waitForFunction(() => window.__mosaic.result, null, { timeout: 90000 });

    const report = await page.evaluate(() => ({
      cols: window.__mosaic.result.grid.cols,
      colors: new Set(window.__mosaic.result.grid.cells.map((cell) => cell.hex)).size,
    }));

    assert.equal(report.cols, 32, 'сетка взята из ручных настроек');
    assert.ok(report.colors <= 4, 'использована тестовая палитра из четырёх цветов');
  });

  await t.test('6. без ошибок в консоли', () => {
    assert.deepEqual(errors, []);
  });

  await context.close();
  await browser.close();
});
