/**
 * Тесты инструкции: разбиение на блоки и настоящий PDF.
 *
 * PDF проверяется не «на глаз»: файл разбирается pdfjs-dist — из него читаются
 * страницы, текст (в том числе русский) и встроенный шрифт.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mapGridToPalette } from '../src/algorithms/color/paletteMapping.ts';
import {
  DEFAULT_BLOCK_SIZE,
  blockCell,
  blockNumber,
  buildInstructionPlan,
  contrastInk,
} from '../src/algorithms/instruction/blockGenerator.ts';
import { parsePalettes } from '../src/config/palettes.ts';
import { parseTrueTypeFont, measureText } from '../src/services/pdfFont.ts';
import { buildInstructionPdf, countInstructionPages } from '../src/services/pdfGenerator.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASIC = parsePalettes(JSON.parse(readFileSync(join(root, 'src/config/palettes.json'), 'utf8'))).byId.basic;
const FONT_BYTES = new Uint8Array(readFileSync(join(root, 'public/fonts/DejaVuSansMono.ttf')));

const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();

function makeGrid(cols, rows, colorAt) {
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const rgb = colorAt(x, y);
      cells.push({ x, y, rgb, hex: hex(rgb) });
    }
  }
  return { cols, rows, cells };
}

/** Мозаика 64×64 в цветах палитры — как после настоящей генерации. */
function makeMosaic(cols = 64, rows = 64) {
  const source = makeGrid(cols, rows, (x, y) => {
    const inCircle = (x - cols * 0.4) ** 2 + (y - rows * 0.45) ** 2 < (cols * 0.2) ** 2;
    if (inCircle) return [20, 22, 28];
    return [Math.round(40 + (200 * x) / cols), Math.round(70 + (140 * y) / rows), 190];
  });
  return mapGridToPalette(source, BASIC).grid;
}

/* ------------------------------------------------------------------ блоки */

test('64×64 разбивается на 64 блока 8×8', () => {
  const plan = buildInstructionPlan(makeMosaic(), { palette: BASIC });

  assert.equal(plan.blockSize, DEFAULT_BLOCK_SIZE);
  assert.equal(plan.blocksX, 8);
  assert.equal(plan.blocksY, 8);
  assert.equal(plan.blocks.length, 64);
  assert.equal(plan.totalPieces, 4096);

  for (const block of plan.blocks) {
    assert.equal(block.width, 8);
    assert.equal(block.height, 8);
    assert.equal(block.cells.length, 64);
    assert.equal(block.numbers.length, 64);
  }
});

test('у блока есть всё, что просили хранить', () => {
  const plan = buildInstructionPlan(makeMosaic(), { palette: BASIC });
  const block = plan.blocks[9];

  assert.deepEqual(Object.keys(block).sort(), [
    'blockId',
    'cells',
    'column',
    'counts',
    'height',
    'index',
    'numbers',
    'row',
    'width',
    'x',
    'y',
  ]);
  assert.equal(block.blockId, 'BLOCK 10');
  assert.equal(block.index, 9);
  assert.equal(block.x, 8);
  assert.equal(block.y, 8);
  assert.equal(block.column, 1);
  assert.equal(block.row, 1);
});

test('порядок блоков — слева направо, сверху вниз', () => {
  const plan = buildInstructionPlan(makeMosaic(32, 32), { palette: BASIC });
  assert.equal(plan.blocks.length, 16);

  plan.blocks.forEach((block, index) => {
    assert.equal(block.index, index);
    assert.equal(block.blockId, `BLOCK ${String(index + 1).padStart(2, '0')}`);
    assert.equal(block.column, index % 4);
    assert.equal(block.row, Math.floor(index / 4));
    assert.equal(block.x, block.column * 8);
    assert.equal(block.y, block.row * 8);
  });

  // Первая ячейка первого блока — она же первая ячейка мозаики.
  assert.equal(plan.blocks[0].cells[0].x, 0);
  assert.equal(plan.blocks[0].cells[0].y, 0);
  assert.equal(plan.blocks[15].cells.at(-1).x, 31);
  assert.equal(plan.blocks[15].cells.at(-1).y, 31);
});

test('ячейки блока — те же самые, что в мозаике', () => {
  const grid = makeMosaic(16, 16);
  const plan = buildInstructionPlan(grid, { palette: BASIC, blockSize: 4 });

  for (const block of plan.blocks) {
    for (let dy = 0; dy < block.height; dy++) {
      for (let dx = 0; dx < block.width; dx++) {
        const fromBlock = blockCell(block, dx, dy);
        const fromGrid = grid.cells[(block.y + dy) * grid.cols + (block.x + dx)];
        assert.equal(fromBlock.hex, fromGrid.hex);
        assert.equal(fromBlock.x, fromGrid.x);
        assert.equal(fromBlock.y, fromGrid.y);
      }
    }
  }

  // Ни одна ячейка не потеряна и не продублирована.
  const total = plan.blocks.reduce((sum, block) => sum + block.cells.length, 0);
  assert.equal(total, 256);
});

test('размер, не кратный блоку, даёт неполные блоки по краю', () => {
  const plan = buildInstructionPlan(makeMosaic(10, 6), { palette: BASIC, blockSize: 4 });

  assert.equal(plan.blocksX, 3);
  assert.equal(plan.blocksY, 2);
  assert.equal(plan.blocks.length, 6);
  assert.equal(plan.blocks[2].width, 2, 'правый край обрезан');
  assert.equal(plan.blocks[3].height, 2, 'нижний ряд обрезан');
  assert.equal(
    plan.blocks.reduce((sum, block) => sum + block.cells.length, 0),
    60,
  );
});

test('легенда нумерует цвета от самого массового', () => {
  const grid = makeGrid(8, 8, (x) => (x < 6 ? [27, 27, 27] : [244, 244, 244]));
  const plan = buildInstructionPlan(mapGridToPalette(grid, BASIC).grid, { palette: BASIC });

  assert.equal(plan.legend.length, 2);
  assert.equal(plan.legend[0].number, 1);
  assert.equal(plan.legend[0].name, 'Black');
  assert.equal(plan.legend[0].total, 48);
  assert.equal(plan.legend[1].number, 2);
  assert.equal(plan.legend[1].name, 'White');
  assert.equal(plan.legend[1].total, 16);

  // Сумма по легенде равна числу ячеек.
  assert.equal(
    plan.legend.reduce((sum, entry) => sum + entry.total, 0),
    plan.totalPieces,
  );
});

test('без палитры легенда всё равно строится по hex', () => {
  const plan = buildInstructionPlan(makeGrid(4, 4, () => [10, 20, 30]));
  assert.equal(plan.legend.length, 1);
  assert.equal(plan.legend[0].name, '#0A141E');
  assert.equal(plan.legend[0].number, 1);
});

test('количества в блоке сходятся с ячейками', () => {
  const plan = buildInstructionPlan(makeMosaic(), { palette: BASIC });

  for (const block of plan.blocks) {
    const sum = block.counts.reduce((total, count) => total + count.count, 0);
    assert.equal(sum, block.cells.length, `${block.blockId}: количества сходятся`);

    for (const count of block.counts) {
      const actual = block.cells.filter((cell) => cell.hex === count.hex).length;
      assert.equal(count.count, actual);
      const legendEntry = plan.legend.find((entry) => entry.hex === count.hex);
      assert.equal(count.number, legendEntry.number, 'номер тот же, что в общей легенде');
    }
  }

  // И по всем блокам сразу — ровно столько же, сколько в легенде.
  for (const entry of plan.legend) {
    const across = plan.blocks.reduce(
      (sum, block) => sum + (block.counts.find((count) => count.hex === entry.hex)?.count ?? 0),
      0,
    );
    assert.equal(across, entry.total, `${entry.name}: сумма по блокам`);
  }
});

test('номера и цвет подписи доступны по локальным координатам', () => {
  const plan = buildInstructionPlan(makeMosaic(16, 16), { palette: BASIC, blockSize: 8 });
  const block = plan.blocks[0];

  assert.equal(blockNumber(block, 0, 0), block.numbers[0]);
  assert.equal(blockNumber(block, 7, 7), block.numbers[63]);
  assert.equal(blockNumber(block, 8, 0), 0, 'за пределами блока — ноль');
  assert.equal(blockCell(block, -1, 0), undefined);

  assert.equal(contrastInk([255, 255, 255]), '#101318');
  assert.equal(contrastInk([10, 10, 10]), '#F4F4F4');
});

test('план строится по готовой сетке и не меняет её', () => {
  const grid = makeMosaic(16, 16);
  const before = grid.cells.map((cell) => cell.hex).join('');
  buildInstructionPlan(grid, { palette: BASIC });
  assert.equal(grid.cells.map((cell) => cell.hex).join(''), before);
});

/* -------------------------------------------------------------------- шрифт */

test('TrueType разбирается: кириллица есть, ширины считаются', () => {
  const font = parseTrueTypeFont(FONT_BYTES);

  assert.ok(font.numGlyphs > 100);
  assert.ok(font.unitsPerEm > 0);
  assert.ok(font.postScriptName.length > 0);

  for (const symbol of 'Инструкция по сборке ABC 123') {
    assert.ok(font.glyphFor(symbol.codePointAt(0)) > 0, `нет глифа для «${symbol}»`);
  }

  const encoded = font.encode('Блок');
  assert.equal(encoded.hex.length, 16, 'четыре символа по два байта');
  assert.ok(encoded.width > 0);
  assert.ok(measureText(font, 'Блок', 10) > 0);
  assert.ok(font.usedGlyphs.size > 1, 'использованные глифы копятся для массива W');
});

/* ---------------------------------------------------------------------- PDF */

async function loadPdfJs() {
  // В Node читаем PDF без воркера — так проще и достаточно для проверки.
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

test('PDF собирается и открывается: страницы, порядок блоков, русский текст', async () => {
  const grid = makeMosaic(32, 32);
  const plan = buildInstructionPlan(grid, { palette: BASIC });
  const font = parseTrueTypeFont(FONT_BYTES);

  const bytes = buildInstructionPdf({
    plan,
    font,
    meta: {
      title: 'Инструкция по сборке',
      photoName: 'портрет.jpg',
      paletteLabel: 'Базовая',
      modeLabel: 'Портрет',
      qualityScore: 0.66,
      createdAt: new Date('2026-08-21T10:00:00Z'),
    },
    usage: mapGridToPalette(grid, BASIC).usage,
  });

  // Файл действительно PDF.
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), '%PDF-1.4');
  assert.match(new TextDecoder('latin1').decode(bytes.subarray(-16)), /%%EOF/);
  assert.ok(bytes.length > 20000, `файл подозрительно мал: ${bytes.length} байт`);

  const path = join(tmpdir(), 'mosaic-instruction.pdf');
  writeFileSync(path, bytes);

  const pdfjs = await loadPdfJs();
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableWorker: true,
    isEvalSupported: false,
  }).promise;

  const expectedPages = countInstructionPages(plan);
  assert.equal(expectedPages, 5 + 16);
  assert.equal(document.numPages, expectedPages, 'обложка, фото, мозаика, палитра, статистика и блоки');

  const textOf = async (pageNumber) => {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    // pdfjs отдаёт пробелы отдельными фрагментами — схлопываем.
    return content.items
      .map((item) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const cover = await textOf(1);
  assert.match(cover, /ИНСТРУКЦИЯ ПО СБОРКЕ/, 'русский текст на обложке читается');
  assert.match(cover, /Всего деталей/);
  assert.match(cover, /1 024/, 'числа отформатированы по-русски');
  assert.match(cover, /портрет\.jpg/);

  assert.match(await textOf(2), /Исходная фотография/);
  assert.match(await textOf(3), /Готовая мозаика/);

  const palette = await textOf(4);
  assert.match(palette, /Палитра и легенда/);
  assert.match(palette, /Black/);

  assert.match(await textOf(5), /Статистика/);

  // Блоки идут по порядку и с правильными подписями.
  const firstBlock = await textOf(6);
  assert.match(firstBlock, /BLOCK 01/);
  assert.match(firstBlock, /ДЕТАЛЕЙ В ЭТОМ БЛОКЕ/);
  assert.match(firstBlock, /Строка 1, столбец 1/);

  const lastBlock = await textOf(expectedPages);
  assert.match(lastBlock, /BLOCK 16/);
  assert.match(lastBlock, /Строка 4, столбец 4/);

  for (let index = 0; index < plan.blocks.length; index++) {
    const text = await textOf(6 + index);
    assert.match(text, new RegExp(plan.blocks[index].blockId), `страница ${6 + index}: ${plan.blocks[index].blockId}`);
  }

  // Шрифт действительно встроен, а не подставлен читалкой.
  const raw = new TextDecoder('latin1').decode(bytes);
  assert.match(raw, /\/Subtype \/Type0/, 'составной шрифт');
  assert.match(raw, /\/Encoding \/Identity-H/, 'кодировка Identity-H');
  assert.match(raw, /\/FontFile2/, 'файл шрифта внутри PDF');

  console.log(`    ↳ PDF: ${document.numPages} страниц, ${(bytes.length / 1024).toFixed(0)} КБ → ${path}`);
});

test('PDF с большими изображениями остаётся валидным', async () => {
  const plan = buildInstructionPlan(makeMosaic(16, 16), { palette: BASIC, blockSize: 8 });
  const font = parseTrueTypeFont(FONT_BYTES);

  // Настоящий JPEG 1400×1400 берём из pdfjs-независимого источника — рисуем сами.
  const jpeg = makeJpeg(1400, 1400);

  const bytes = buildInstructionPdf({
    plan,
    font,
    original: jpeg,
    mosaic: jpeg,
    meta: { title: 'С картинками' },
  });

  assert.ok(bytes.length > jpeg.bytes.length, 'картинки попали в файл');

  const pdfjs = await loadPdfJs();
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
  assert.equal(document.numPages, 5 + 4);

  const page = await document.getPage(2);
  const operators = await page.getOperatorList();
  assert.ok(operators.fnArray.length > 0, 'страница с фотографией не пустая');
});

/** Мини-JPEG нужного размера: заголовок собирается вручную, без canvas. */
function makeJpeg(width, height) {
  // Берём готовый однопиксельный JPEG и подменяем размеры в маркере SOF0.
  const base64 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  const binary = Buffer.from(base64, 'base64');
  const bytes = new Uint8Array(binary);

  for (let offset = 2; offset < bytes.length - 9; offset++) {
    if (bytes[offset] === 0xff && bytes[offset + 1] === 0xc0) {
      bytes[offset + 5] = (height >> 8) & 0xff;
      bytes[offset + 6] = height & 0xff;
      bytes[offset + 7] = (width >> 8) & 0xff;
      bytes[offset + 8] = width & 0xff;
      break;
    }
  }

  return { bytes, width, height };
}
