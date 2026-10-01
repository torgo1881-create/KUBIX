import { measureText, type EmbeddedFont } from './pdfFont';

/**
 * Минимальный писатель PDF без внешних зависимостей.
 *
 * Умеет ровно то, что нужно инструкции: страницы, прямоугольники, линии,
 * текст встроенным TrueType-шрифтом (кириллица включена) и JPEG-картинки
 * через DCTDecode. Это настоящий PDF с объектами и таблицей xref, а не
 * скриншот страницы.
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface TextOptions {
  size?: number;
  color?: string | RgbColor;
  /** Имитация полужирного обводкой — второго файла шрифта не требуется. */
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Ширина области для выравнивания. */
  width?: number;
}

export interface RectOptions {
  fill?: string | RgbColor | null;
  stroke?: string | RgbColor | null;
  lineWidth?: number;
}

export interface JpegImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
} as const;

export type PageSize = keyof typeof PAGE_SIZES;

function toRgb(color: string | RgbColor): RgbColor {
  if (typeof color !== 'string') return color;
  const clean = color.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** Экранирование для обычных PDF-строк (используется в метаданных). */
function pdfString(text: string): string {
  // Метаданные пишем как UTF-16BE с BOM: так кириллица корректно видна в свойствах файла.
  let hex = 'FEFF';
  for (const symbol of text) {
    const code = symbol.codePointAt(0) ?? 32;
    if (code > 0xffff) {
      const value = code - 0x10000;
      hex += (0xd800 + (value >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (value & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

/** Размеры JPEG из маркера SOF. */
export function readJpegSize(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    // SOF0..SOF15, кроме DHT (C4), JPG (C8) и DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
    }
    offset += 2 + length;
  }
  throw new Error('Не удалось прочитать размеры JPEG');
}

export class PdfPage {
  readonly operations: string[] = [];
  readonly images: { name: string; image: JpegImage }[] = [];
  readonly width: number;
  readonly height: number;
  private readonly document: PdfDocument;

  constructor(width: number, height: number, document: PdfDocument) {
    this.width = width;
    this.height = height;
    this.document = document;
  }

  /** Координаты снаружи — от левого верхнего угла, как в вебе. */
  private flip(y: number): number {
    return this.height - y;
  }

  rect(x: number, y: number, width: number, height: number, options: RectOptions = {}): void {
    const { fill = null, stroke = null, lineWidth = 0.5 } = options;
    if (!fill && !stroke) return;

    if (fill) {
      const color = toRgb(fill);
      this.operations.push(`${num(color.r)} ${num(color.g)} ${num(color.b)} rg`);
    }
    if (stroke) {
      const color = toRgb(stroke);
      this.operations.push(`${num(color.r)} ${num(color.g)} ${num(color.b)} RG`, `${num(lineWidth)} w`);
    }

    this.operations.push(`${num(x)} ${num(this.flip(y + height))} ${num(width)} ${num(height)} re`);
    this.operations.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
  }

  line(x1: number, y1: number, x2: number, y2: number, color: string | RgbColor = '#000', lineWidth = 0.5): void {
    const rgb = toRgb(color);
    this.operations.push(
      `${num(rgb.r)} ${num(rgb.g)} ${num(rgb.b)} RG`,
      `${num(lineWidth)} w`,
      `${num(x1)} ${num(this.flip(y1))} m`,
      `${num(x2)} ${num(this.flip(y2))} l`,
      'S',
    );
  }

  /** Текст с базовой линией в точке (x, y). */
  text(x: number, y: number, value: string, options: TextOptions = {}): void {
    const { size = 10, color = '#101318', bold = false, align = 'left', width = 0 } = options;
    const font = this.document.font;
    if (!font) throw new Error('Для текста нужен встроенный шрифт');

    const { hex } = font.encode(value);
    const textWidth = measureText(font, value, size);

    let left = x;
    if (align === 'center') left = x + (width - textWidth) / 2;
    else if (align === 'right') left = x + width - textWidth;

    const rgb = toRgb(color);
    this.operations.push('BT');
    if (bold) {
      // Режим 2: залить и обвести — визуально даёт полужирное начертание.
      this.operations.push(`2 Tr ${num(size * 0.035)} w`, `${num(rgb.r)} ${num(rgb.g)} ${num(rgb.b)} RG`);
    } else {
      this.operations.push('0 Tr');
    }
    this.operations.push(
      `${num(rgb.r)} ${num(rgb.g)} ${num(rgb.b)} rg`,
      `/F1 ${num(size)} Tf`,
      `1 0 0 1 ${num(left)} ${num(this.flip(y))} Tm`,
      `<${hex}> Tj`,
      'ET',
    );
    return;
  }

  /** Картинка JPEG, вписанная в прямоугольник с сохранением пропорций. */
  image(x: number, y: number, boxWidth: number, boxHeight: number, image: JpegImage): { width: number; height: number } {
    const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const left = x + (boxWidth - width) / 2;
    const top = y + (boxHeight - height) / 2;

    const name = this.document.registerImage(image);
    this.images.push({ name, image });
    this.operations.push(
      'q',
      `${num(width)} 0 0 ${num(height)} ${num(left)} ${num(this.flip(top + height))} cm`,
      `/${name} Do`,
      'Q',
    );
    return { width, height };
  }

  get content(): string {
    return this.operations.join('\n');
  }
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
}

export class PdfDocument {
  readonly pages: PdfPage[] = [];
  readonly font: EmbeddedFont | null;
  private readonly metadata: PdfMetadata;
  private readonly imageRegistry = new Map<JpegImage, string>();
  private imageCounter = 0;
  private pendingToUnicode: (() => void) | null = null;

  constructor(font: EmbeddedFont | null, metadata: PdfMetadata = {}) {
    this.font = font;
    this.metadata = metadata;
  }

  addPage(size: PageSize | { width: number; height: number } = 'a4'): PdfPage {
    const dimensions = typeof size === 'string' ? PAGE_SIZES[size] : size;
    const page = new PdfPage(dimensions.width, dimensions.height, this);
    this.pages.push(page);
    return page;
  }

  registerImage(image: JpegImage): string {
    const existing = this.imageRegistry.get(image);
    if (existing) return existing;
    const name = `Im${++this.imageCounter}`;
    this.imageRegistry.set(image, name);
    return name;
  }

  /** Собирает готовый файл. */
  build(): Uint8Array {
    const objects: (string | Uint8Array)[] = [];
    const reserve = () => {
      objects.push('');
      return objects.length; // номера объектов с 1
    };
    const put = (id: number, body: string | Uint8Array) => {
      objects[id - 1] = body;
    };

    const catalogId = reserve();
    const pagesId = reserve();
    const infoId = reserve();

    /* --- шрифт ------------------------------------------------------------ */
    let fontId = 0;
    if (this.font) {
      const fileId = reserve();
      const descriptorId = reserve();
      const cidFontId = reserve();
      fontId = reserve();

      put(fileId, withStream(`<< /Length ${this.font.data.length} /Length1 ${this.font.data.length} >>`, this.font.data));

      put(
        descriptorId,
        `<< /Type /FontDescriptor /FontName /${this.font.postScriptName} /Flags 4 ` +
          `/FontBBox [${this.font.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${this.font.ascent} ` +
          `/Descent ${this.font.descent} /CapHeight ${this.font.capHeight} /StemV 80 /FontFile2 ${fileId} 0 R >>`,
      );

      // ToUnicode: чтобы кириллицу можно было выделить, скопировать и найти.
      const toUnicodeId = reserve();
      put(toUnicodeId, withStream(`<< /Length ${0} >>`, new Uint8Array(0)));

      const widths = [...this.font.usedGlyphs]
        .filter((glyph) => glyph > 0)
        .sort((a, b) => a - b)
        .map((glyph) => `${glyph} [${this.font!.widthOf(glyph)}]`)
        .join(' ');

      put(
        cidFontId,
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${this.font.postScriptName} ` +
          `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
          `/FontDescriptor ${descriptorId} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`,
      );

      put(
        fontId,
        `<< /Type /Font /Subtype /Type0 /BaseFont /${this.font.postScriptName} ` +
          `/Encoding /Identity-H /DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`,
      );

      // Заполняем после отрисовки страниц: к этому моменту известны все глифы.
      this.pendingToUnicode = () => {
        const cmap = new TextEncoder().encode(buildToUnicodeCMap(this.font as EmbeddedFont));
        put(toUnicodeId, withStream(`<< /Length ${cmap.length} >>`, cmap));
      };
    }

    /* --- страницы ---------------------------------------------------------- */
    const pageIds: number[] = [];

    for (const page of this.pages) {
      const contentId = reserve();
      const pageId = reserve();
      pageIds.push(pageId);

      const content = new TextEncoder().encode(page.content);
      put(contentId, withStream(`<< /Length ${content.length} >>`, content));

      const imageEntries: string[] = [];
      const seen = new Set<string>();
      for (const { name, image } of page.images) {
        if (seen.has(name)) continue;
        seen.add(name);
        const imageId = reserve();
        put(
          imageId,
          withStream(
            `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
              `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>`,
            image.bytes,
          ),
        );
        imageEntries.push(`/${name} ${imageId} 0 R`);
      }

      const resources =
        `<< ${fontId ? `/Font << /F1 ${fontId} 0 R >> ` : ''}` +
        `${imageEntries.length ? `/XObject << ${imageEntries.join(' ')} >> ` : ''}>>`;

      put(
        pageId,
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources ${resources} /Contents ${contentId} 0 R >>`,
      );
    }

    this.pendingToUnicode?.();

    put(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    put(
      pagesId,
      `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
    );
    put(
      infoId,
      `<< /Title ${pdfString(this.metadata.title ?? 'Mosaic instruction')} ` +
        `/Author ${pdfString(this.metadata.author ?? 'Mosaic')} ` +
        `/Subject ${pdfString(this.metadata.subject ?? '')} /Producer ${pdfString('mosaic-app')} >>`,
    );

    /* --- сборка файла ------------------------------------------------------ */
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();
    let position = 0;
    const push = (data: Uint8Array | string) => {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data;
      chunks.push(bytes);
      position += bytes.length;
    };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets[index] = position;
      push(`${index + 1} 0 obj\n`);
      if (typeof body === 'string') push(body);
      else push(body);
      push('\nendobj\n');
    });

    const xrefPosition = position;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    push(xref);
    push(
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
        `startxref\n${xrefPosition}\n%%EOF\n`,
    );

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      output.set(chunk, cursor);
      cursor += chunk.length;
    }
    return output;
  }
}

/** CMap «глиф → символ Unicode» для копирования и поиска текста. */
function buildToUnicodeCMap(font: EmbeddedFont): string {
  const entries = [...font.toUnicode.entries()].sort((a, b) => a[0] - b[0]);

  let body = '';
  for (let start = 0; start < entries.length; start += 100) {
    const chunk = entries.slice(start, start + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [glyph, code] of chunk) {
      const target =
        code > 0xffff
          ? (() => {
              const value = code - 0x10000;
              return (
                (0xd800 + (value >> 10)).toString(16).padStart(4, '0') +
                (0xdc00 + (value & 0x3ff)).toString(16).padStart(4, '0')
              );
            })()
          : code.toString(16).padStart(4, '0');
      body += `<${glyph.toString(16).padStart(4, '0')}> <${target.toUpperCase()}>\n`;
    }
    body += 'endbfchar\n';
  }

  return (
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    body +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
  );
}

/** Объект-поток: словарь, stream ... endstream. */
function withStream(dictionary: string, data: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const head = encoder.encode(`${dictionary}\nstream\n`);
  const tail = encoder.encode('\nendstream');
  const output = new Uint8Array(head.length + data.length + tail.length);
  output.set(head, 0);
  output.set(data, head.length);
  output.set(tail, head.length + data.length);
  return output;
}
