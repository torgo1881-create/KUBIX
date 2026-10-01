/**
 * Прогон автономной сборки в эмуляции телефона: экран 390×844, touch, dpr 3.
 *
 * Проверяет то, что десктопные тесты не видят: жесты кадрирования (сдвиг
 * одним пальцем, щипок двумя), отмену расчёта, размер превью вариантов,
 * память под canvas, показ PNG на экране и скачивание PDF. Скриншоты и
 * сохранённый PNG складываются в OUT.
 *
 * Запуск: PHOTO=path/to/photo.jpg npm run check:mobile
 *   PAGE=standalone/artifact-wrapped.html — проверить версию для публикации
 *   CANCEL_TEST=0 — пропустить проверку отмены
 */
import { chromium } from 'playwright';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.OUT ?? 'benchmark/mobile-check');
mkdirSync(out, { recursive: true });
if (!process.env.PHOTO) {
  console.error('Укажите фотографию: PHOTO=path/to/photo.jpg npm run check:mobile');
  process.exit(1);
}
const photo = resolve(root, process.env.PHOTO);
const productId = process.env.PRODUCT ?? 'color-m';
if (!existsSync(photo)) {
  console.error(`Фотография не найдена: ${photo}`);
  process.exit(1);
}

const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
});

const t0 = Date.now();
await page.goto('file://' + resolve(root, process.env.PAGE ?? 'standalone/index.html'));
await page.waitForFunction(() => window.__mosaic && document.querySelectorAll('#productCards button').length > 0);
console.log('loaded in', Date.now() - t0, 'ms');
console.log('device:', await page.evaluate(() => ({
  coarse: matchMedia('(pointer: coarse)').matches,
  inner: [innerWidth, innerHeight],
  screen: [screen.width, screen.height],
  scrollW: document.documentElement.scrollWidth,
})));
await page.screenshot({ path: `${out}/1-product.png`, fullPage: true });

// Шаг 1 — набор
const cards = await page.$$eval('#productCards button', (b) => b.map((x) => x.dataset.product ?? x.textContent.trim().slice(0, 20)));
console.log('cards:', cards);
const productNames = { 'classic-s': 'Classic S', 'classic-m': 'Classic M', 'classic-l': 'Classic L', 'color-s': 'Color S', 'color-m': 'Color M' };
const card = await page.$(`#productCards button:has-text("${productNames[productId] ?? 'Color M'}")`);
await card.tap();
await page.waitForSelector('#dropzone:not([hidden])');
await page.screenshot({ path: `${out}/2-photo.png`, fullPage: true });

// Шаг 2 — фото
const t1 = Date.now();
await page.setInputFiles('#file', photo);
await page.waitForSelector('#cropStage:not([hidden])');
await page.waitForFunction(() => window.__mosaic.image && document.getElementById('sourceInfo').textContent.length > 0);
console.log('decoded in', Date.now() - t1, 'ms;', await page.$eval('#sourceInfo', (e) => e.textContent));
await page.screenshot({ path: `${out}/3-crop.png`, fullPage: true });

// Жесты настоящими touch-событиями через CDP: один палец — сдвиг, два — щипок.
const cdp = await context.newCDPSession(page);
const box = await page.$eval('#crop', (c) => { const r = c.getBoundingClientRect(); return { left: r.left, top: r.top }; });
const touch = async (type, points) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x: box.left + x, y: box.top + y, id })) });
const before = await page.evaluate(() => ({ ...window.__mosaic.view }));
await touch('touchStart', [[150, 150]]);
await touch('touchMove', [[130, 140]]);
await touch('touchMove', [[110, 130]]);
await touch('touchEnd', []);
const afterDrag = await page.evaluate(() => ({ ...window.__mosaic.view }));
await touch('touchStart', [[150, 150], [200, 150]]);
await touch('touchMove', [[135, 150], [215, 150]]);
await touch('touchMove', [[120, 150], [240, 150]]);
await touch('touchEnd', []);
const afterPinch = await page.evaluate(() => ({ ...window.__mosaic.view }));
console.log('view before', before, 'drag', afterDrag, 'pinch', afterPinch);
await page.screenshot({ path: `${out}/4-crop-zoomed.png`, fullPage: true });

// Ориентация: набор M собирается и горизонтально — сетка 96×64, деталей столько же.
if (await page.$('#orientation:not([hidden])')) {
  await page.tap('#orientation');
  await page.waitForTimeout(200);
  const flipped = await page.evaluate(() => ({
    text: document.getElementById('orientation').textContent,
    summary: document.getElementById('productSummary').textContent.replace(/\s+/g, ' '),
  }));
  console.log('orientation →', flipped.text, '|', flipped.summary);
  await page.tap('#orientation');
  await page.waitForTimeout(200);
  console.log('orientation ←', await page.$eval('#orientation', (b) => b.textContent));
}

// Шаг 4 — генерация (по тапу)
const t2 = Date.now();
await page.tap('#generate');
await page.waitForSelector('#cancel:not([hidden])');
// Отмена на середине и повторный запуск — воркер должен подняться заново.
if (process.env.CANCEL_TEST !== '0') {
  await page.waitForTimeout(2500);
  await page.tap('#cancel');
  await page.waitForFunction(() => document.getElementById('cancel').hidden, null, { timeout: 20000 });
  const st = await page.evaluate(() => ({ cancelled: window.__mosaic.cancelled, variants: window.__mosaic.variants, err: document.getElementById('error').textContent }));
  console.log('after cancel:', st, 'at', Date.now() - t2, 'ms');
  await page.tap('#generate');
}
const t3 = Date.now();
await page.waitForFunction(() => window.__mosaic.variants && window.__mosaic.variants.length > 0 && !document.getElementById('result').hidden, null, { timeout: 600000 });
const info = await page.evaluate(() => {
  const s = window.__mosaic;
  const canvases = [...document.querySelectorAll('canvas')];
  const domPixels = canvases.reduce((a, c) => a + c.width * c.height, 0);
  const variantPixels = s.variants.reduce((a, v) => a + v.image.width * v.image.height, 0);
  return {
    variants: s.variants.map((v) => `${v.id}:${v.image.width}x${v.image.height}:${v.statistics.durationMs}ms`),
    count: s.variants.length,
    domCanvasMb: (domPixels * 4 / 1048576).toFixed(1),
    variantCanvasMb: (variantPixels * 4 / 1048576).toFixed(1),
    faces: s.result.faces.length,
    scrollW: document.documentElement.scrollWidth,
    innerW: innerWidth,
    stripCount: document.querySelectorAll('#variantStrip figure').length,
    error: document.getElementById('error').textContent,
  };
});
console.log('generated in', Date.now() - t3, 'ms', info);
await page.screenshot({ path: `${out}/5-result.png`, fullPage: true });
await page.screenshot({ path: `${out}/5-result-viewport.png` });

// Выбор варианта из ленты
const figures = await page.$$('#variantStrip figure');
await figures[Math.min(4, figures.length - 1)].tap();
await page.waitForTimeout(300);
console.log('selected:', await page.evaluate(() => window.__mosaic.selectedVariant));
await page.screenshot({ path: `${out}/6-variant.png` });

// Скачать PNG — на телефоне это картинка на экране (сохраняется долгим нажатием)
await page.tap('#download');
await page.waitForFunction(() => !document.getElementById('pngOverlay').hidden && document.getElementById('pngImage').naturalWidth > 0);
console.log('png overlay:', await page.evaluate(() => ({ w: document.getElementById('pngImage').naturalWidth, h: document.getElementById('pngImage').naturalHeight })));
await page.screenshot({ path: `${out}/7-png.png` });
const dataUrl = await page.$eval('#pngImage', (img) => img.src);
const { writeFileSync } = await import('node:fs');
writeFileSync(`${out}/download.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
// Кнопка «Сохранить файлом» без window.claude идёт обычной ссылкой — ждём загрузку
const [pngDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.tap('#pngSave')]);
console.log('png saved as file:', pngDl.suggestedFilename());
await page.tap('#pngClose');

// PDF
if (await page.$('#downloadPdf')) {
  const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.tap('#downloadPdf')]);
  await pdf.saveAs(`${out}/instruction.pdf`);
  console.log('pdf:', pdf.suggestedFilename());
}

console.log('errors:', errors);
await browser.close();
