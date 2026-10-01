import type { InstructionBlock, InstructionPlan } from '../algorithms/instruction/blockGenerator';
import { contrastInk } from '../algorithms/instruction/blockGenerator';
import type { ColorRequirement } from '../algorithms/optimization/pieceLimit';
import type { PaletteUsage } from '../types/palette';
import { measureText, parseTrueTypeFont, type EmbeddedFont } from './pdfFont';
import { PdfDocument, readJpegSize, type JpegImage, type PdfPage } from './pdfWriter';

/**
 * Инструкция по сборке в PDF.
 *
 * Документ собирается объект за объектом: настоящие страницы, встроенный
 * шрифт с кириллицей, схемы блоков — векторные прямоугольники с номерами,
 * фотографии — JPEG внутри файла. Никаких скриншотов страницы.
 */

export interface InstructionMeta {
  title?: string;
  photoName?: string;
  modeLabel?: string;
  paletteLabel?: string;
  qualityScore?: number | null;
  createdAt?: Date;
}

export interface InstructionPdfInput {
  plan: InstructionPlan;
  font: EmbeddedFont;
  /** Исходная фотография, JPEG. */
  original?: JpegImage | null;
  /** Готовая мозаика, JPEG. */
  mosaic?: JpegImage | null;
  usage?: PaletteUsage[];
  requirements?: ColorRequirement[];
  meta?: InstructionMeta;
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

const INK = '#101318';
const MUTED = '#6E7480';
const LINE = '#D8DAE1';
const ACCENT = '#1B44E0';

function formatPdfNumber(value: number): string {
  return value.toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

function pageHeader(page: PdfPage, eyebrow: string, title: string): number {
  page.text(MARGIN, MARGIN + 8, eyebrow.toUpperCase(), { size: 8, color: MUTED });
  page.text(MARGIN, MARGIN + 30, title, { size: 18, bold: true, color: INK });
  page.line(MARGIN, MARGIN + 42, PAGE.width - MARGIN, MARGIN + 42, LINE, 0.7);
  return MARGIN + 66;
}

function pageFooter(page: PdfPage, left: string, right: string): void {
  const y = PAGE.height - MARGIN + 4;
  page.line(MARGIN, y - 14, PAGE.width - MARGIN, y - 14, LINE, 0.5);
  page.text(MARGIN, y, left, { size: 8, color: MUTED });
  page.text(MARGIN, y, right, { size: 8, color: MUTED, align: 'right', width: CONTENT_WIDTH });
}

/** Строка «подпись — значение». */
function metaRow(page: PdfPage, x: number, y: number, label: string, value: string, width = 240): void {
  page.text(x, y, label, { size: 9, color: MUTED });
  page.text(x, y, value, { size: 10, color: INK, align: 'right', width });
}

function swatch(page: PdfPage, x: number, y: number, size: number, hex: string): void {
  page.rect(x, y, size, size, { fill: hex, stroke: LINE, lineWidth: 0.4 });
}

/* ------------------------------------------------------------------ страницы */

function coverPage(document: PdfDocument, input: InstructionPdfInput): void {
  const { plan, meta = {} } = input;
  const page = document.addPage();
  const created = meta.createdAt ?? new Date();

  page.rect(0, 0, PAGE.width, 6, { fill: ACCENT });

  page.text(MARGIN, 120, 'ИНСТРУКЦИЯ ПО СБОРКЕ', { size: 9, color: MUTED });
  page.text(MARGIN, 160, meta.title ?? 'Фотомозаика', { size: 30, bold: true, color: INK });
  if (meta.photoName) {
    page.text(MARGIN, 184, meta.photoName, { size: 11, color: MUTED });
  }

  if (input.mosaic) {
    page.image(MARGIN, 210, CONTENT_WIDTH, 300, input.mosaic);
  }

  let y = 560;
  const rows: [string, string][] = [
    ['Размер мозаики', `${plan.cols} × ${plan.rows}`],
    ['Всего деталей', formatPdfNumber(plan.totalPieces)],
    ['Цветов в работе', String(plan.legend.length)],
    ['Блоков', `${plan.blocks.length} (${plan.blockSize} × ${plan.blockSize})`],
  ];
  if (meta.paletteLabel) rows.push(['Палитра', meta.paletteLabel]);
  if (meta.modeLabel) rows.push(['Режим', meta.modeLabel]);
  if (meta.qualityScore != null) rows.push(['Оценка качества', `${Math.round(meta.qualityScore * 100)} / 100`]);
  rows.push(['Дата', formatDate(created)]);

  for (const [label, value] of rows) {
    metaRow(page, MARGIN, y, label, value, CONTENT_WIDTH);
    page.line(MARGIN, y + 6, PAGE.width - MARGIN, y + 6, LINE, 0.4);
    y += 26;
  }

  page.text(MARGIN, PAGE.height - 70, 'Собирайте блок за блоком слева направо и сверху вниз.', {
    size: 10,
    color: MUTED,
  });
  pageFooter(page, 'Фотомозаика', 'стр. 1');
}

function photoPage(document: PdfDocument, input: InstructionPdfInput, kind: 'original' | 'mosaic', pageNumber: number): void {
  const image = kind === 'original' ? input.original : input.mosaic;
  const page = document.addPage();
  const title = kind === 'original' ? 'Исходная фотография' : 'Готовая мозаика';
  const top = pageHeader(page, kind === 'original' ? 'Original photo' : 'Final mosaic', title);

  if (image) {
    page.image(MARGIN, top + 10, CONTENT_WIDTH, 560, image);
  } else {
    page.text(MARGIN, top + 30, 'Изображение недоступно.', { size: 10, color: MUTED });
  }

  const caption =
    kind === 'original'
      ? input.meta?.photoName ?? 'Фотография, из которой построена мозаика'
      : `${input.plan.cols} × ${input.plan.rows}, ${formatPdfNumber(input.plan.totalPieces)} деталей`;
  page.text(MARGIN, top + 590, caption, { size: 9, color: MUTED });

  pageFooter(page, title, `стр. ${pageNumber}`);
}

function palettePage(document: PdfDocument, input: InstructionPdfInput, pageNumber: number): void {
  const page = document.addPage();
  const top = pageHeader(page, 'Palette', 'Палитра и легенда');

  page.text(MARGIN, top, 'Номер на схеме соответствует цвету детали.', { size: 9, color: MUTED });

  let y = top + 30;
  page.text(MARGIN, y, '№', { size: 8, color: MUTED });
  page.text(MARGIN + 30, y, 'ЦВЕТ', { size: 8, color: MUTED });
  page.text(MARGIN + 250, y, 'HEX', { size: 8, color: MUTED });
  page.text(MARGIN, y, 'ДЕТАЛЕЙ', { size: 8, color: MUTED, align: 'right', width: CONTENT_WIDTH });
  page.line(MARGIN, y + 6, PAGE.width - MARGIN, y + 6, LINE, 0.6);
  y += 26;

  for (const entry of input.plan.legend) {
    page.text(MARGIN, y, String(entry.number), { size: 11, bold: true, color: INK });
    swatch(page, MARGIN + 28, y - 9, 12, entry.hex);
    page.text(MARGIN + 48, y, entry.name, { size: 10, color: INK });
    page.text(MARGIN + 250, y, entry.hex, { size: 10, color: MUTED });
    page.text(MARGIN, y, formatPdfNumber(entry.total), { size: 10, color: INK, align: 'right', width: CONTENT_WIDTH });
    page.line(MARGIN, y + 6, PAGE.width - MARGIN, y + 6, LINE, 0.3);
    y += 22;
    if (y > PAGE.height - 90) break;
  }

  pageFooter(page, 'Палитра', `стр. ${pageNumber}`);
}

function statisticsPage(document: PdfDocument, input: InstructionPdfInput, pageNumber: number): void {
  const { plan, requirements = [], usage = [], meta = {} } = input;
  const page = document.addPage();
  const top = pageHeader(page, 'Statistics', 'Статистика');

  let y = top + 4;
  const summary: [string, string][] = [
    ['Ячеек в мозаике', formatPdfNumber(plan.totalPieces)],
    ['Блоков', String(plan.blocks.length)],
    ['Размер блока', `${plan.blockSize} × ${plan.blockSize}`],
    ['Цветов использовано', String(plan.legend.length)],
    ['Самый массовый цвет', `${plan.legend[0]?.name ?? '—'} · ${formatPdfNumber(plan.legend[0]?.total ?? 0)}`],
  ];
  if (meta.qualityScore != null) summary.push(['Оценка качества', `${Math.round(meta.qualityScore * 100)} / 100`]);

  for (const [label, value] of summary) {
    metaRow(page, MARGIN, y, label, value, CONTENT_WIDTH);
    page.line(MARGIN, y + 6, PAGE.width - MARGIN, y + 6, LINE, 0.3);
    y += 24;
  }

  y += 20;
  page.text(MARGIN, y, 'РАСХОД ДЕТАЛЕЙ', { size: 8, color: MUTED });
  y += 20;

  const withLimits = requirements.length > 0;
  page.text(MARGIN, y, 'ЦВЕТ', { size: 8, color: MUTED });
  page.text(MARGIN + 220, y, withLimits ? 'REQUIRED' : 'ДЕТАЛЕЙ', { size: 8, color: MUTED });
  if (withLimits) {
    page.text(MARGIN + 320, y, 'AVAILABLE', { size: 8, color: MUTED });
    page.text(MARGIN + 430, y, 'STATUS', { size: 8, color: MUTED });
  }
  page.line(MARGIN, y + 6, PAGE.width - MARGIN, y + 6, LINE, 0.6);
  y += 22;

  const rows = withLimits
    ? requirements.map((requirement) => ({
        hex: requirement.color.hex,
        name: requirement.color.name,
        required: requirement.required,
        available: requirement.available,
        status: requirement.status,
      }))
    : usage.map((item) => ({
        hex: item.color.hex,
        name: item.color.name,
        required: item.count,
        available: item.color.availableQuantity,
        status: '',
      }));

  for (const row of rows) {
    swatch(page, MARGIN, y - 9, 12, row.hex);
    page.text(MARGIN + 20, y, row.name, { size: 10, color: INK });
    page.text(MARGIN + 220, y, formatPdfNumber(row.required), { size: 10, color: INK });
    if (withLimits) {
      page.text(MARGIN + 320, y, formatPdfNumber(row.available), { size: 10, color: MUTED });
      page.text(MARGIN + 430, y, row.status, {
        size: 9,
        color: row.status === 'over' ? '#B3261E' : row.status === 'corrected' ? ACCENT : MUTED,
      });
    }
    page.line(MARGIN, y + 6, PAGE.width - MARGIN, y + 6, LINE, 0.3);
    y += 22;
    if (y > PAGE.height - 90) break;
  }

  pageFooter(page, 'Статистика', `стр. ${pageNumber}`);
}

/** Страница одного блока: схема, легенда, количества. */
function blockPage(
  document: PdfDocument,
  input: InstructionPdfInput,
  block: InstructionBlock,
  pageNumber: number,
): void {
  const { plan } = input;
  const page = document.addPage();
  const top = pageHeader(
    page,
    `Блок ${block.index + 1} из ${plan.blocks.length}`,
    block.blockId,
  );

  page.text(
    MARGIN,
    top,
    `Строка ${block.row + 1}, столбец ${block.column + 1} · ячейки ${block.x + 1}–${block.x + block.width} по горизонтали, ` +
      `${block.y + 1}–${block.y + block.height} по вертикали`,
    { size: 9, color: MUTED },
  );

  /* --- увеличенная схема --------------------------------------------------- */

  const schemeSize = 340;
  const schemeX = MARGIN + 16;
  const schemeY = top + 26;
  const cellSize = schemeSize / Math.max(block.width, block.height);

  // Подписи координат.
  for (let dx = 0; dx < block.width; dx++) {
    page.text(schemeX + dx * cellSize, schemeY - 6, String(block.x + dx + 1), {
      size: 7,
      color: MUTED,
      align: 'center',
      width: cellSize,
    });
  }
  for (let dy = 0; dy < block.height; dy++) {
    page.text(schemeX - 22, schemeY + dy * cellSize + cellSize / 2 + 3, String(block.y + dy + 1), {
      size: 7,
      color: MUTED,
      align: 'right',
      width: 18,
    });
  }

  for (let dy = 0; dy < block.height; dy++) {
    for (let dx = 0; dx < block.width; dx++) {
      const cell = block.cells[dy * block.width + dx];
      const number = block.numbers[dy * block.width + dx];
      const x = schemeX + dx * cellSize;
      const y = schemeY + dy * cellSize;

      page.rect(x, y, cellSize, cellSize, { fill: cell.hex, stroke: '#FFFFFF', lineWidth: 0.6 });
      page.text(x, y + cellSize / 2 + cellSize * 0.16, String(number), {
        size: cellSize * 0.42,
        color: contrastInk(cell.rgb),
        align: 'center',
        width: cellSize,
      });
    }
  }

  page.rect(schemeX, schemeY, block.width * cellSize, block.height * cellSize, {
    stroke: INK,
    lineWidth: 1,
  });

  /* --- легенда блока ------------------------------------------------------- */

  const legendX = schemeX + schemeSize + 26;
  let legendY = schemeY + 10;
  page.text(legendX, legendY, 'ЛЕГЕНДА', { size: 8, color: MUTED });
  legendY += 18;

  for (const count of block.counts) {
    swatch(page, legendX, legendY - 9, 12, count.hex);
    page.text(legendX + 18, legendY, `${count.number} = ${count.name}`, { size: 9, color: INK });
    legendY += 18;
    if (legendY > schemeY + schemeSize) break;
  }

  /* --- количества ---------------------------------------------------------- */

  let y = schemeY + schemeSize + 46;
  page.text(MARGIN, y, 'ДЕТАЛЕЙ В ЭТОМ БЛОКЕ', { size: 8, color: MUTED });
  y += 20;

  page.text(MARGIN, y, '№', { size: 8, color: MUTED });
  page.text(MARGIN + 30, y, 'ЦВЕТ', { size: 8, color: MUTED });
  page.text(MARGIN + 250, y, 'HEX', { size: 8, color: MUTED });
  page.text(MARGIN, y, 'ШТУК', { size: 8, color: MUTED, align: 'right', width: CONTENT_WIDTH });
  page.line(MARGIN, y + 6, PAGE.width - MARGIN, y + 6, LINE, 0.6);
  y += 20;

  for (const count of block.counts) {
    page.text(MARGIN, y, String(count.number), { size: 10, bold: true, color: INK });
    swatch(page, MARGIN + 28, y - 9, 12, count.hex);
    page.text(MARGIN + 48, y, count.name, { size: 10, color: INK });
    page.text(MARGIN + 250, y, count.hex, { size: 10, color: MUTED });
    page.text(MARGIN, y, formatPdfNumber(count.count), { size: 10, color: INK, align: 'right', width: CONTENT_WIDTH });
    page.line(MARGIN, y + 6, PAGE.width - MARGIN, y + 6, LINE, 0.3);
    y += 20;
    if (y > PAGE.height - 80) break;
  }

  const total = block.counts.reduce((sum, count) => sum + count.count, 0);
  pageFooter(page, `${block.blockId} · ${formatPdfNumber(total)} деталей`, `стр. ${pageNumber}`);
}

/* --------------------------------------------------------------- сборка */

/** Собирает весь документ и возвращает байты PDF. */
export function buildInstructionPdf(input: InstructionPdfInput): Uint8Array {
  const document = new PdfDocument(input.font, {
    title: input.meta?.title ?? 'Инструкция по сборке мозаики',
    author: 'Фотомозаика',
    subject: `Мозаика ${input.plan.cols} × ${input.plan.rows}, ${input.plan.blocks.length} блоков`,
  });

  coverPage(document, input);
  let pageNumber = 2;
  photoPage(document, input, 'original', pageNumber++);
  photoPage(document, input, 'mosaic', pageNumber++);
  palettePage(document, input, pageNumber++);
  statisticsPage(document, input, pageNumber++);

  for (const block of input.plan.blocks) {
    blockPage(document, input, block, pageNumber++);
  }

  return document.build();
}

/** Сколько страниц получится — удобно показать до генерации. */
export function countInstructionPages(plan: InstructionPlan): number {
  return 5 + plan.blocks.length;
}

/* ------------------------------------------------------- браузерные хелперы */

/** Canvas → JPEG для встраивания в PDF. */
export async function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.85, maxSide = 1400): Promise<JpegImage> {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  let source = canvas;

  if (scale < 1) {
    const resized = document.createElement('canvas');
    resized.width = Math.round(canvas.width * scale);
    resized.height = Math.round(canvas.height * scale);
    const ctx = resized.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, resized.width, resized.height);
      ctx.drawImage(canvas, 0, 0, resized.width, resized.height);
    }
    source = resized;
  }

  const dataUrl = source.toDataURL('image/jpeg', quality);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const size = readJpegSize(bytes);
  return { bytes, width: size.width, height: size.height };
}

let fontCache: EmbeddedFont | null = null;

/**
 * Загружает шрифт для PDF. В автономной сборке он уже лежит в
 * window.__MOSAIC_PDF_FONT (base64), в приложении — берётся из /fonts.
 */
export async function loadPdfFont(url = '/fonts/DejaVuSansMono.ttf'): Promise<EmbeddedFont> {
  if (fontCache) return fontCache;

  const inlined = (globalThis as { __MOSAIC_PDF_FONT?: string }).__MOSAIC_PDF_FONT;
  if (inlined) {
    const binary = atob(inlined);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    fontCache = parseTrueTypeFont(bytes);
    return fontCache;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось загрузить шрифт для PDF: ${response.status}`);
  fontCache = parseTrueTypeFont(new Uint8Array(await response.arrayBuffer()));
  return fontCache;
}

/** Ширина строки — вынесено, чтобы вёрстка могла считать переносы. */
export { measureText };
