/**
 * Тесты продуктовых пресетов.
 *
 * Проверяется слой поверх существующего ядра: правильная сетка, палитра,
 * пропорции кадра, профиль обработки и запас деталей. Сам алгоритм здесь не
 * трогается — только то, какие параметры он получает от выбранного набора.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeMosaicCore } from '../src/algorithms/mosaicCore.ts';
import {
  buildPresetPalette,
  DEVELOPER_PALETTE_IDS,
  getPalette,
  isDeveloperPalette,
  isProductPalette,
  PRODUCT_PALETTE_IDS,
  presetPaletteSize,
  productPalettes,
} from '../src/config/paletteData.ts';
import { parsePalettes } from '../src/config/palettes.ts';
import { getProcessingProfile, getProfileMode, PROCESSING_PROFILES } from '../src/config/processingProfiles.ts';
import {
  BASE_COLOR_ID,
  DEFAULT_PRESET_ID,
  describePreset,
  getPreset,
  presetAspect,
  presetAspectLabel,
  presetsByCategory,
  PRODUCT_PRESETS,
  PRODUCT_PRESET_IDS,
} from '../src/config/productPresets.ts';
import { checkPresetCapacity, describeCapacity } from '../src/lib/capacity.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parsed = parsePalettes(JSON.parse(readFileSync(join(root, 'src/config/palettes.json'), 'utf8')));

/* ------------------------------------------------------------- пресеты */

test('доступны ровно пять наборов, Color L пока нет', () => {
  assert.deepEqual(PRODUCT_PRESET_IDS, ['classic-s', 'classic-m', 'classic-l', 'color-s', 'color-m']);
  assert.equal(PRODUCT_PRESETS.length, 5);
  assert.equal(
    PRODUCT_PRESETS.some((preset) => preset.id === 'color-l'),
    false,
    'Color L на этом этапе не создаём',
  );
  assert.equal(DEFAULT_PRESET_ID, 'classic-s');
  assert.equal(presetsByCategory('classic').length, 3);
  assert.equal(presetsByCategory('color').length, 2);
});

test('у каждого пресета есть все обязательные поля', () => {
  for (const preset of PRODUCT_PRESETS) {
    assert.deepEqual(
      Object.keys(preset).sort(),
      [
        'availablePieces',
        'baseColorEnabled',
        'category',
        'height',
        'id',
        'maxCells',
        'name',
        'paletteId',
        'physicalHeight',
        'physicalWidth',
        'processingProfile',
        'width',
      ],
      `${preset.id}: набор полей`,
    );
    assert.equal(preset.maxCells, preset.width * preset.height, `${preset.id}: maxCells совпадает с сеткой`);
  }
});

test('сетки, физические размеры и цвета — как в задании', () => {
  const expected = {
    'classic-s': { grid: [64, 64], cells: 4096, size: [51, 51], palette: 'classic', colors: 5, base: false },
    'classic-m': { grid: [64, 96], cells: 6144, size: [51, 76], palette: 'classic', colors: 5, base: false },
    'classic-l': { grid: [96, 96], cells: 9216, size: [76, 76], palette: 'classic', colors: 5, base: false },
    'color-s': { grid: [64, 64], cells: 4096, size: [51, 51], palette: 'color', colors: 7, base: true },
    'color-m': { grid: [64, 96], cells: 6144, size: [51, 76], palette: 'color', colors: 7, base: true },
  };

  for (const [id, want] of Object.entries(expected)) {
    const preset = getPreset(id);
    assert.deepEqual([preset.width, preset.height], want.grid, `${id}: сетка`);
    assert.equal(preset.maxCells, want.cells, `${id}: ячеек`);
    assert.deepEqual([preset.physicalWidth, preset.physicalHeight], want.size, `${id}: размер картины`);
    assert.equal(preset.paletteId, want.palette, `${id}: палитра`);
    assert.equal(preset.baseColorEnabled, want.base, `${id}: чёрная основа`);
    assert.equal(presetPaletteSize(preset), want.colors, `${id}: цветов в работе`);
  }
});

test('пропорции кадра соответствуют набору', () => {
  assert.equal(presetAspectLabel(getPreset('classic-s')), '1:1');
  assert.equal(presetAspectLabel(getPreset('classic-m')), '2:3');
  assert.equal(presetAspectLabel(getPreset('classic-l')), '1:1');
  assert.equal(presetAspectLabel(getPreset('color-s')), '1:1');
  assert.equal(presetAspectLabel(getPreset('color-m')), '2:3');

  assert.equal(presetAspect(getPreset('classic-s')), 1);
  assert.ok(Math.abs(presetAspect(getPreset('color-m')) - 2 / 3) < 1e-9);
});

test('неизвестный id не роняет приложение', () => {
  assert.equal(getPreset('нет-такого').id, 'classic-s');
  assert.equal(getPreset(null).id, 'classic-s');
  assert.equal(getPreset(undefined).id, 'classic-s');
});

/* ------------------------------------------------------------- палитры */

test('Classic — 5 цветов, Color — 6 цветов плюс чёрная основа', () => {
  const classic = getPalette('classic');
  assert.equal(classic.colors.length, 5);
  assert.equal(
    classic.colors.some((color) => color.id === BASE_COLOR_ID),
    false,
    'в Classic основы нет',
  );

  const color = getPalette('color');
  assert.equal(color.colors.length, 7, '6 цветов + основа');
  const base = color.colors.find((item) => item.id === BASE_COLOR_ID);
  assert.ok(base, 'чёрная основа на месте');
  assert.equal(color.colors.filter((item) => item.id !== BASE_COLOR_ID).length, 6);
});

test('названия цветов не выдают себя за официальные оттенки', () => {
  const forbidden = /mozabrick|pantone|ral/i;
  for (const palette of parsed.palettes) {
    for (const color of palette.colors) {
      assert.doesNotMatch(color.name, forbidden, `${palette.id}/${color.id}: рабочее название, не официальное`);
      assert.doesNotMatch(color.id, forbidden);
    }
  }
});

test('тестовые палитры сохранены, но спрятаны от покупателя', () => {
  // «Серая (4)» и другие экспериментальные палитры никуда не делись.
  assert.ok(parsed.byId.grayscale, 'Серая палитра на месте');
  assert.ok(parsed.byId.basic, 'Базовая палитра на месте');
  assert.ok(parsed.byId.portrait, 'Портретная палитра на месте');

  assert.deepEqual(PRODUCT_PALETTE_IDS, ['classic', 'color']);
  assert.deepEqual(
    productPalettes().map((palette) => palette.id),
    ['classic', 'color'],
    'покупатель видит только продуктовые палитры',
  );

  for (const id of ['grayscale', 'basic', 'portrait']) {
    assert.equal(isDeveloperPalette(id), true, `${id}: только для отладки`);
    assert.equal(isProductPalette(id), false);
    assert.ok(DEVELOPER_PALETTE_IDS.includes(id));
  }
});

test('палитра набора получает реальный запас деталей', () => {
  for (const preset of PRODUCT_PRESETS) {
    const palette = buildPresetPalette(preset);
    const total = palette.colors.reduce((sum, color) => sum + color.availableQuantity, 0);

    assert.ok(total >= preset.maxCells, `${preset.id}: деталей ${total} на ${preset.maxCells} ячеек`);
    assert.ok(total >= preset.availablePieces, `${preset.id}: распределён весь запас набора`);

    for (const color of palette.colors) {
      assert.ok(color.availableQuantity > 0, `${preset.id}/${color.id}: запас положительный`);
    }

    // Основа участвует только там, где она есть в наборе.
    const hasBase = palette.colors.some((color) => color.id === BASE_COLOR_ID);
    assert.equal(hasBase, preset.baseColorEnabled, `${preset.id}: чёрная основа`);
  }
});

test('запас деталей больше числа ячеек — иначе набор не собрать', () => {
  for (const preset of PRODUCT_PRESETS) {
    assert.ok(
      preset.availablePieces > preset.maxCells,
      `${preset.id}: ${preset.availablePieces} деталей на ${preset.maxCells} ячеек`,
    );
  }
});

/* ------------------------------------------------------------- профили */

test('каждому набору назначен профиль обработки', () => {
  assert.equal(getPreset('classic-s').processingProfile, 'portrait-balanced');
  assert.equal(getPreset('classic-m').processingProfile, 'portrait-balanced');
  assert.equal(getPreset('classic-l').processingProfile, 'portrait-balanced');
  assert.equal(getPreset('color-s').processingProfile, 'color-portrait');
  assert.equal(getPreset('color-m').processingProfile, 'color-portrait');

  for (const preset of PRODUCT_PRESETS) {
    assert.ok(PROCESSING_PROFILES[preset.processingProfile], `${preset.id}: профиль существует`);
  }
});

test('профиль — это слой поверх существующих режимов, а не новый алгоритм', () => {
  const balanced = getProcessingProfile('portrait-balanced');
  assert.equal(balanced.modeId, 'portrait');
  assert.equal(balanced.enforcePieceLimits, true);
  assert.equal(balanced.distanceMetric, 'ciede2000');

  // Под профилем лежит существующий режим со своими параметрами — не тронутыми.
  const mode = getProfileMode('color-portrait');
  assert.equal(mode.id, 'portrait');
  assert.equal(mode.faceDetection, true);
  assert.equal(mode.preprocess.sharpen, 0.45, 'параметры режима не изменены');

  assert.equal(getProcessingProfile('нет-такого').id, 'portrait-balanced', 'запасной профиль');
});

/* ------------------------------------------------------------ capacity */

test('до генерации набор сообщает, что он подходит', () => {
  for (const preset of PRODUCT_PRESETS) {
    const status = checkPresetCapacity(preset);
    assert.equal(status.level, 'ok', `${preset.id}: набор подходит`);
    assert.match(status.title, /подходит/);
  }
});

test('статус для покупателя без технических слов', () => {
  const preset = getPreset('classic-s');

  const good = describeCapacity(preset, {
    feasible: true,
    satisfied: true,
    moved: 0,
    totalCells: preset.maxCells,
    requirements: [{ color: { name: 'Classic 1 — чёрный' }, required: 1000, available: 1270, status: 'ok' }],
  });
  assert.equal(good.level, 'ok');
  assert.match(good.title, /подходит/);

  const corrected = describeCapacity(preset, {
    feasible: true,
    satisfied: true,
    moved: 300,
    totalCells: preset.maxCells,
    requirements: [{ color: { name: 'Classic 1 — чёрный' }, required: 1270, available: 1270, status: 'corrected' }],
  });
  assert.equal(corrected.level, 'adjusted');

  const bad = describeCapacity(preset, {
    feasible: false,
    satisfied: false,
    moved: 0,
    totalCells: preset.maxCells,
    requirements: [{ color: { name: 'Classic 1 — чёрный' }, required: 3000, available: 1270, status: 'over' }],
  });
  assert.equal(bad.level, 'insufficient');
  assert.match(bad.title, /слишком много деталей одного цвета/);
  assert.match(bad.detail, /Classic 1/);

  // Ни в одном пользовательском тексте нет технических слов.
  for (const status of [good, corrected, bad]) {
    for (const text of [status.title, status.detail]) {
      assert.doesNotMatch(text, /infeasible|feasible|satisfied/i, `в тексте для покупателя: «${text}»`);
    }
  }
  // А в отладочных данных техническое состояние осталось.
  assert.equal(bad.debug.feasible, false);
  assert.deepEqual(bad.debug.overflowColors, ['Classic 1 — чёрный']);
});

/* --------------------------------------- пресет реально доходит до ядра */

function makePhoto(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const inFace = (x - width * 0.5) ** 2 / (width * 0.28) ** 2 + (y - height * 0.45) ** 2 / (height * 0.3) ** 2 <= 1;
      const [r, g, b] = inFace
        ? [226 - Math.round((40 * y) / height), 180, 150]
        : [90 + Math.round((100 * x) / width), 120, 170];
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

test('каждый набор проходит через ядро и укладывается в запас', () => {
  const rows = [];

  for (const preset of PRODUCT_PRESETS) {
    const palette = buildPresetPalette(preset);
    const profile = getProcessingProfile(preset.processingProfile);
    const image = makePhoto(preset.width * 8, preset.height * 8);

    const core = computeMosaicCore(image, {
      cols: preset.width,
      rows: preset.height,
      mode: profile.modeId,
      distanceMetric: profile.distanceMetric,
      palette,
      enforcePieceLimits: profile.enforcePieceLimits,
      sampleWidth: image.width,
      sampleHeight: image.height,
    });

    assert.equal(core.grid.cols, preset.width, `${preset.id}: столбцов`);
    assert.equal(core.grid.rows, preset.height, `${preset.id}: строк`);
    assert.equal(core.grid.cells.length, preset.maxCells, `${preset.id}: ячеек`);
    assert.equal(core.mode, profile.modeId, `${preset.id}: режим из профиля`);
    assert.equal(core.pieceLimit.satisfied, true, `${preset.id}: запас деталей соблюдён`);

    // Все цвета мозаики — из палитры набора, и их не больше, чем в наборе.
    const allowed = new Set(palette.colors.map((color) => color.hex));
    for (const cell of core.grid.cells) {
      assert.ok(allowed.has(cell.hex), `${preset.id}: цвет ${cell.hex} есть в наборе`);
    }
    assert.ok(core.mapping.usage.length <= palette.colors.length, `${preset.id}: цветов не больше, чем в наборе`);

    const status = describeCapacity(preset, core.pieceLimit);
    assert.notEqual(status.level, 'insufficient', `${preset.id}: набор подходит`);

    rows.push(
      `${preset.name.padEnd(10)} ${String(preset.width + '×' + preset.height).padEnd(7)} ` +
        `${String(core.mapping.usage.length).padStart(2)} цветов, перекрашено ${String(core.pieceLimit.moved).padStart(4)}`,
    );
  }

  console.log('    ↳ ' + rows.join('\n    ↳ '));
});

test('Color использует цветные детали, Classic — монохромные', () => {
  const image = makePhoto(512, 512);

  const run = (presetId) => {
    const preset = getPreset(presetId);
    const palette = buildPresetPalette(preset);
    const profile = getProcessingProfile(preset.processingProfile);
    return computeMosaicCore(image, {
      cols: preset.width,
      rows: preset.height,
      mode: profile.modeId,
      distanceMetric: profile.distanceMetric,
      palette,
      enforcePieceLimits: profile.enforcePieceLimits,
      sampleWidth: image.width,
      sampleHeight: image.height,
    });
  };

  const classic = run('classic-s');
  const color = run('color-s');

  // Classic — монохромный набор: у деталей почти нет насыщенности.
  // Лёгкий холодный оттенок допустим, это ближе к реальному пластику.
  for (const cell of classic.grid.cells) {
    const [r, g, b] = cell.rgb;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(chroma <= 20, `Classic должен быть монохромным, а ${cell.hex} даёт насыщенность ${chroma}`);
  }

  // В Color есть хотя бы одна заметно цветная деталь.
  const colorful = color.grid.cells.some((cell) => {
    const [r, g, b] = cell.rgb;
    return Math.max(r, g, b) - Math.min(r, g, b) > 25;
  });
  assert.equal(colorful, true, 'Color-набор использует цветные детали');
});

/* ----------------------------------------------- описание для интерфейса */

test('карточка набора содержит только продуктовые сведения', () => {
  const classic = describePreset(getPreset('classic-s'), presetPaletteSize(getPreset('classic-s')));
  assert.equal(classic.name, 'Classic S');
  assert.equal(classic.size, '51×51 см');
  assert.equal(classic.grid, '64×64');
  assert.equal(classic.cells, 4096);
  assert.equal(classic.colors, 5);
  assert.equal(classic.colorsLabel, '5');
  assert.equal(classic.aspect, '1:1');
  assert.ok(classic.pieces > 4096);

  const color = describePreset(getPreset('color-s'), presetPaletteSize(getPreset('color-s')));
  assert.equal(color.colors, 6, 'основа не считается цветом набора');
  assert.equal(color.colorsLabel, '6 + чёрная основа');

  // В карточке нет ни одного технического параметра алгоритма.
  const serialized = JSON.stringify(classic) + JSON.stringify(color);
  for (const technical of ['ciede2000', 'sharpen', 'autoLevels', 'edgeWeight', 'contrast', 'metric']) {
    assert.doesNotMatch(serialized, new RegExp(technical, 'i'), `${technical} не должен попадать в карточку`);
  }
});
