/**
 * Разбор TrueType-шрифта для встраивания в PDF.
 *
 * Нужен ради кириллицы: встроенные в PDF базовые шрифты (Helvetica и прочие)
 * знают только WinAnsi, и русский текст в них превращается в мусор. Поэтому
 * шрифт встраивается целиком как CIDFontType2 с кодировкой Identity-H, а
 * здесь мы достаём из файла то, что для этого нужно: таблицу символов,
 * ширины глифов и метрики.
 */

export interface EmbeddedFont {
  /** Байты шрифта — уедут в PDF как FontFile2. */
  data: Uint8Array;
  postScriptName: string;
  unitsPerEm: number;
  numGlyphs: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  /** Глиф для кодовой точки, 0 — если символа нет. */
  glyphFor(codePoint: number): number;
  /** Ширина глифа в тысячных долях em — единицы PDF. */
  widthOf(glyph: number): number;
  /** Текст → строка глифов для Identity-H и её ширина в тысячных em. */
  encode(text: string): { hex: string; width: number };
  /** Все использованные глифы — для массива W. */
  usedGlyphs: Set<number>;
  /**
   * Глиф → кодовая точка. Нужна для ToUnicode: без неё текст в PDF
   * рисуется правильно, но не копируется и не ищется.
   */
  toUnicode: Map<number, number>;
}

class Reader {
  private view: DataView;

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  u8(offset: number): number {
    return this.view.getUint8(offset);
  }
  u16(offset: number): number {
    return this.view.getUint16(offset);
  }
  i16(offset: number): number {
    return this.view.getInt16(offset);
  }
  u32(offset: number): number {
    return this.view.getUint32(offset);
  }
  tag(offset: number): string {
    return String.fromCharCode(this.u8(offset), this.u8(offset + 1), this.u8(offset + 2), this.u8(offset + 3));
  }
}

function readTables(reader: Reader): Map<string, { offset: number; length: number }> {
  const tables = new Map<string, { offset: number; length: number }>();
  const numTables = reader.u16(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    tables.set(reader.tag(record), { offset: reader.u32(record + 8), length: reader.u32(record + 12) });
  }
  return tables;
}

/** cmap формата 4 (BMP) и 12 (полный Unicode). */
function readCmap(reader: Reader, offset: number): Map<number, number> {
  const map = new Map<number, number>();
  const numTables = reader.u16(offset + 2);

  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < numTables; i++) {
    const record = offset + 4 + i * 8;
    const platform = reader.u16(record);
    const encoding = reader.u16(record + 2);
    const subtable = offset + reader.u32(record + 4);
    const format = reader.u16(subtable);

    let score = -1;
    if (platform === 3 && encoding === 10 && format === 12) score = 4;
    else if (platform === 3 && encoding === 1 && format === 4) score = 3;
    else if (platform === 0 && format === 12) score = 2;
    else if (platform === 0 && format === 4) score = 1;

    if (score > bestScore) {
      bestScore = score;
      best = subtable;
    }
  }

  if (best < 0) return map;
  const format = reader.u16(best);

  if (format === 4) {
    const segCountX2 = reader.u16(best + 6);
    const segCount = segCountX2 / 2;
    const endBase = best + 14;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;

    for (let segment = 0; segment < segCount; segment++) {
      const end = reader.u16(endBase + segment * 2);
      const start = reader.u16(startBase + segment * 2);
      const delta = reader.i16(deltaBase + segment * 2);
      const rangeOffset = reader.u16(rangeBase + segment * 2);
      if (start === 0xffff) continue;

      for (let code = start; code <= end && code !== 0x10000; code++) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const glyphOffset = rangeBase + segment * 2 + rangeOffset + (code - start) * 2;
          glyph = reader.u16(glyphOffset);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph) map.set(code, glyph);
      }
    }
  } else if (format === 12) {
    const groups = reader.u32(best + 12);
    for (let i = 0; i < groups; i++) {
      const group = best + 16 + i * 12;
      const start = reader.u32(group);
      const end = reader.u32(group + 4);
      const startGlyph = reader.u32(group + 8);
      for (let code = start; code <= end; code++) map.set(code, startGlyph + (code - start));
    }
  }

  return map;
}

function readPostScriptName(reader: Reader, offset: number): string {
  const count = reader.u16(offset + 2);
  const stringOffset = offset + reader.u16(offset + 4);

  for (let i = 0; i < count; i++) {
    const record = offset + 6 + i * 12;
    const nameId = reader.u16(record + 6);
    if (nameId !== 6) continue;

    const platform = reader.u16(record);
    const length = reader.u16(record + 8);
    const stringStart = stringOffset + reader.u16(record + 10);

    let name = '';
    if (platform === 3) {
      for (let p = 0; p < length; p += 2) name += String.fromCharCode(reader.u16(stringStart + p));
    } else {
      for (let p = 0; p < length; p++) name += String.fromCharCode(reader.u8(stringStart + p));
    }
    const clean = name.replace(/[^A-Za-z0-9-]/g, '');
    if (clean) return clean;
  }

  return 'EmbeddedFont';
}

/** Читает TTF и отдаёт всё, что нужно PDF-писателю. */
export function parseTrueTypeFont(data: Uint8Array): EmbeddedFont {
  const reader = new Reader(data);
  const tables = readTables(reader);

  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const maxp = tables.get('maxp');
  const cmapTable = tables.get('cmap');
  if (!head || !hhea || !hmtx || !maxp || !cmapTable) {
    throw new Error('Шрифт не похож на TrueType: не хватает обязательных таблиц');
  }

  const unitsPerEm = reader.u16(head.offset + 18) || 1000;
  const bbox: [number, number, number, number] = [
    reader.i16(head.offset + 36),
    reader.i16(head.offset + 38),
    reader.i16(head.offset + 40),
    reader.i16(head.offset + 42),
  ];

  const ascent = reader.i16(hhea.offset + 4);
  const descent = reader.i16(hhea.offset + 6);
  const numberOfHMetrics = reader.u16(hhea.offset + 34);
  const numGlyphs = reader.u16(maxp.offset + 4);

  const advances = new Uint16Array(numGlyphs);
  let last = 0;
  for (let glyph = 0; glyph < numGlyphs; glyph++) {
    if (glyph < numberOfHMetrics) {
      last = reader.u16(hmtx.offset + glyph * 4);
    }
    advances[glyph] = last;
  }

  const cmap = readCmap(reader, cmapTable.offset);
  const os2 = tables.get('OS/2');
  const capHeight = os2 && os2.length >= 90 ? reader.i16(os2.offset + 88) : Math.round(ascent * 0.7);
  const postScriptName = tables.has('name')
    ? readPostScriptName(reader, (tables.get('name') as { offset: number }).offset)
    : 'EmbeddedFont';

  const scale = 1000 / unitsPerEm;
  const usedGlyphs = new Set<number>([0]);
  const toUnicode = new Map<number, number>();

  const font: EmbeddedFont = {
    data,
    postScriptName,
    unitsPerEm,
    numGlyphs,
    ascent: Math.round(ascent * scale),
    descent: Math.round(descent * scale),
    capHeight: Math.round(capHeight * scale),
    bbox: [
      Math.round(bbox[0] * scale),
      Math.round(bbox[1] * scale),
      Math.round(bbox[2] * scale),
      Math.round(bbox[3] * scale),
    ],
    usedGlyphs,
    toUnicode,
    glyphFor(codePoint: number): number {
      return cmap.get(codePoint) ?? 0;
    },
    widthOf(glyph: number): number {
      return Math.round((advances[glyph] ?? 0) * scale);
    },
    encode(text: string): { hex: string; width: number } {
      let hex = '';
      let width = 0;
      for (const symbol of text) {
        const code = symbol.codePointAt(0) ?? 32;
        let glyph = cmap.get(code) ?? 0;
        if (!glyph) glyph = cmap.get(63) ?? 0; // '?' вместо неизвестного символа
        usedGlyphs.add(glyph);
        if (glyph) toUnicode.set(glyph, code);
        hex += glyph.toString(16).padStart(4, '0');
        width += font.widthOf(glyph);
      }
      return { hex, width };
    },
  };

  return font;
}

/** Ширина строки в пунктах при заданном кегле. */
export function measureText(font: EmbeddedFont, text: string, size: number): number {
  let width = 0;
  for (const symbol of text) {
    width += font.widthOf(font.glyphFor(symbol.codePointAt(0) ?? 32));
  }
  return (width * size) / 1000;
}
