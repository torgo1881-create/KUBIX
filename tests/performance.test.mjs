/**
 * Замеры производительности ядра на всех размерах сетки.
 *
 * Смысл не в красивых числах, а в ответе на вопрос «блокирует ли это
 * интерфейс». Всё, что дольше кадра (16 мс), обязано уезжать в Web Worker —
 * тест фиксирует это и проверяет, что бюджеты не разъезжаются со временем.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeMosaicCore } from '../src/algorithms/mosaicCore.ts';
import { buildInstructionPlan } from '../src/algorithms/instruction/blockGenerator.ts';
import { scoreMosaic } from '../src/algorithms/variants/qualityScore.ts';
import { parsePalettes } from '../src/config/palettes.ts';
import { parseTrueTypeFont } from '../src/services/pdfFont.ts';
import { buildInstructionPdf } from '../src/services/pdfGenerator.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const palettes = parsePalettes(JSON.parse(readFileSync(join(root, 'src/config/palettes.json'), 'utf8')));
const BASIC = palettes.byId.basic;
const PORTRAIT = palettes.byId.portrait;

const SIZES = [32, 48, 64, 96, 128];
const FRAME_MS = 16;

/** Синтетический «портрет»: кожа, волосы, глаза, фон — как в реальной работе. */
function makePhoto(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const put = (x, y, [r, g, b]) => {
    const index = (y * width + x) * 4;
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
    data[index + 3] = 255;
  };

  const cx = width * 0.5;
  const cy = height * 0.45;
  const rx = width * 0.26;
  const ry = height * 0.3;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const inFace = dx * dx + dy * dy <= 1;
      const inHair = (x - cx) ** 2 / (rx * 1.15) ** 2 + (y - (cy - ry * 0.5)) ** 2 / (ry * 0.8) ** 2 <= 1;

      if (inFace) {
        const shade = 1 - 0.15 * (y / height);
        put(x, y, [Math.round(226 * shade), Math.round(180 * shade), Math.round(150 * shade)]);
      } else if (inHair) {
        put(x, y, [58, 42, 36]);
      } else {
        put(x, y, [90 + Math.round((120 * x) / width), 120, 180 - Math.round((60 * y) / height)]);
      }
    }
  }

  // Глаза и рот — мелкие тёмные детали, на них уходит время поиска лица.
  const eyeY = Math.round(cy - ry * 0.2);
  for (const side of [-1, 1]) {
    const eyeX = Math.round(cx + side * rx * 0.38);
    for (let y = eyeY - 3; y <= eyeY + 3; y++) {
      for (let x = eyeX - 5; x <= eyeX + 5; x++) {
        if (x >= 0 && y >= 0 && x < width && y < height) put(x, y, [30, 28, 32]);
      }
    }
  }

  return { width, height, data };
}

function measure(label, run, runs = 3) {
  const samples = [];
  let result;
  for (let index = 0; index < runs; index++) {
    const started = performance.now();
    result = run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { label, ms: samples[Math.floor(samples.length / 2)], result };
}

test('время генерации на 32 / 48 / 64 / 96 / 128', () => {
  const rows = [];

  for (const size of SIZES) {
    const image = makePhoto(size * 12, size * 12);

    const plain = measure(`${size} без палитры`, () =>
      computeMosaicCore(image, { cols: size, rows: size, sampleWidth: image.width, sampleHeight: image.height }),
    );

    const full = measure(`${size} полный путь`, () =>
      computeMosaicCore(image, {
        cols: size,
        rows: size,
        mode: 'portrait',
        palette: PORTRAIT,
        enforcePieceLimits: true,
        sampleWidth: image.width,
        sampleHeight: image.height,
      }),
    );

    const core = full.result;
    const score = measure(`${size} оценка`, () =>
      scoreMosaic({ averageGrid: core.averageGrid, mosaicGrid: core.grid, weightMap: core.weightMap }),
    );
    const instruction = measure(`${size} инструкция`, () =>
      buildInstructionPlan(core.grid, { blockSize: 8, palette: PORTRAIT }),
    );

    rows.push({
      size,
      cells: size * size,
      plain: plain.ms,
      full: full.ms,
      score: score.ms,
      instruction: instruction.ms,
      feasible: core.pieceLimit.feasible,
    });

    assert.equal(core.grid.cells.length, size * size);

    // Лимиты обязаны соблюдаться там, где деталей в принципе хватает.
    // 128×128 — 16 384 ячейки против 11 100 деталей демо-палитры: физически
    // не собрать, и оптимизатор честно об этом сообщает.
    if (core.pieceLimit.feasible) {
      assert.equal(core.pieceLimit.satisfied, true, `${size}: лимиты соблюдены`);
    } else {
      assert.equal(core.pieceLimit.satisfied, false, `${size}: деталей не хватает и это видно`);
    }
  }

  console.log('\n    размер   ячеек   усреднение   полный путь   оценка   инструкция   блокировал бы UI   деталей хватает');
  for (const row of rows) {
    console.log(
      `    ${String(row.size + '×' + row.size).padEnd(9)}${String(row.cells).padStart(5)} ` +
        `${row.plain.toFixed(0).padStart(9)}мс ${row.full.toFixed(0).padStart(11)}мс ` +
        `${row.score.toFixed(0).padStart(7)}мс ${row.instruction.toFixed(0).padStart(10)}мс   ` +
        `${(row.full > FRAME_MS ? 'да → воркер' : 'нет').padEnd(18)}${row.feasible ? 'да' : 'нет'}`,
    );
  }
  console.log('');

  // Бюджеты: если что-то станет вдвое медленнее, тест это заметит.
  const budget = { 32: 400, 48: 600, 64: 900, 96: 1600, 128: 2600 };
  for (const row of rows) {
    assert.ok(row.full < budget[row.size], `${row.size}×${row.size}: ${row.full.toFixed(0)} мс при бюджете ${budget[row.size]}`);
  }

  // И главный вывод: на любом размере это дольше кадра, поэтому работа ушла в воркер.
  assert.ok(rows.every((row) => row.full > FRAME_MS), 'генерация не помещается в кадр — воркер обязателен');
});

test('PDF: время сборки и размер файла', () => {
  const image = makePhoto(768, 768);
  const core = computeMosaicCore(image, {
    cols: 64,
    rows: 64,
    palette: BASIC,
    enforcePieceLimits: true,
    sampleWidth: 768,
    sampleHeight: 768,
  });

  const plan = buildInstructionPlan(core.grid, { blockSize: 8, palette: BASIC });
  const font = parseTrueTypeFont(new Uint8Array(readFileSync(join(root, 'public/fonts/DejaVuSansMono.ttf'))));

  const started = performance.now();
  const bytes = buildInstructionPdf({ plan, font, meta: { title: 'Замер' } });
  const ms = performance.now() - started;

  console.log(`    ↳ PDF на 69 страниц: ${ms.toFixed(0)} мс, ${(bytes.length / 1024).toFixed(0)} КБ (без фотографий)`);
  assert.ok(ms < 3000, `сборка PDF заняла ${ms.toFixed(0)} мс`);
  assert.ok(bytes.length > 20000);
});

test('память: оценка растёт линейно по ячейкам и остаётся в бюджете', async () => {
  const { estimateJobMemory } = await import('../src/lib/memoryGuard.ts');

  const small = estimateJobMemory({ cols: 32, rows: 32, sampleWidth: 512, sampleHeight: 512, outputSize: 2048 });
  const large = estimateJobMemory({ cols: 128, rows: 128, sampleWidth: 1536, sampleHeight: 1536, outputSize: 2048 });

  assert.ok(large.bytes > small.bytes);
  assert.equal(large.withinBudget, true, 'самая большая штатная задача помещается в бюджет');
  console.log(
    `    ↳ пиковая память: 32×32 ≈ ${(small.bytes / 1024 / 1024).toFixed(0)} МБ, 128×128 ≈ ${(large.bytes / 1024 / 1024).toFixed(0)} МБ`,
  );
});
