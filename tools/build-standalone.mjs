/**
 * Собирает standalone/index.html: компилирует ядро из src/ и вклеивает его
 * в шаблон. Никакого дублирования логики — в автономной странице работает
 * ровно тот же алгоритм, что и в Next-приложении.
 *
 * Запуск: npm run build:standalone
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'mosaic-core-'));

const ENTRIES = [
  'src/config/mosaic.ts',
  'src/config/limits.ts',
  'src/config/experiments.ts',
  'src/config/productPresets.ts',
  'src/config/processingProfiles.ts',
  'src/lib/capacity.ts',
  'src/lib/format.ts',
  'src/lib/fileValidation.ts',
  'src/services/mosaicRunner.ts',
  'src/services/projectStorage.ts',
  'src/services/shareLink.ts',
  'src/config/paletteData.ts',
  'src/config/quality.ts',
  'src/config/variants.ts',
  'src/algorithms/gridAverage.ts',
  'src/algorithms/experimental/toneMapping.ts',
  'src/algorithms/mosaicGenerator.ts',
  'src/algorithms/variants/variantGenerator.ts',
  'src/algorithms/instruction/blockGenerator.ts',
  'src/services/pdfGenerator.ts',
];

// Порядок склейки = порядок зависимостей.
const ORDER = [
  'config/mosaic.js',
  'config/palettes.js',
  'config/paletteData.js',
  'config/quality.js',
  'config/limits.js',
  'config/experiments.js',
  'config/processingProfiles.js',
  'config/productPresets.js',
  'lib/format.js',
  'lib/memoryGuard.js',
  'lib/fileValidation.js',
  'lib/capacity.js',
  'config/variants.js',
  'algorithms/color/lab.js',
  'algorithms/color/distance.js',
  'algorithms/color/paletteMapping.js',
  'algorithms/experimental/perceptualDistance.js',
  'algorithms/color/labDiffusion.js',
  'algorithms/experimental/toneMapping.js',
  'algorithms/image/edges.js',
  'algorithms/experimental/gridDetail.js',
  'algorithms/image/preprocess.js',
  'algorithms/image/whiteBalance.js',
  'algorithms/image/faceExposure.js',
  'algorithms/image/eyeEnhancement.js',
  'algorithms/face/faceDetection.js',
  'algorithms/face/faceRegions.js',
  'algorithms/optimization/weightMap.js',
  'algorithms/optimization/costFunction.js',
  'algorithms/optimization/pieceLimit.js',
  'algorithms/gridAverage.js',
  'algorithms/mosaicCore.js',
  'algorithms/mosaicGenerator.js',
  'services/mosaicRunner.js',
  'services/projectStorage.js',
  'services/shareLink.js',
  'algorithms/variants/qualityScore.js',
  'algorithms/variants/variantGenerator.js',
  'algorithms/instruction/blockGenerator.js',
  'services/pdfFont.js',
  'services/pdfWriter.js',
  'services/pdfGenerator.js',
];

function compile() {
  const local = join(root, 'node_modules/.bin/tsc');
  const tsc = existsSync(local) ? local : 'tsc';
  const configPath = join(outDir, 'tsconfig.core.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        target: 'es2020',
        module: 'esnext',
        moduleResolution: 'bundler',
        lib: ['dom', 'dom.iterable', 'esnext'],
        strict: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        types: [],
        rootDir: join(root, 'src'),
        outDir,
      },
      files: ENTRIES.map((entry) => join(root, entry)),
    }),
  );
  execFileSync(tsc, ['-p', configPath], { cwd: root, stdio: 'inherit' });
}

/**
 * JSON-импорты нельзя просто выбросить: подставляем содержимое файла
 * константой с тем же именем, что было у импорта.
 */
function inlineJsonImports(code, sourceDir) {
  const pattern = /import\s+(\w+)\s+from\s+['"]([^'"]+\.json)['"];?/g;
  const constants = [];
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const [, name, specifier] = match;
    const jsonPath = resolve(sourceDir, specifier);
    constants.push(`const ${name} = ${readFileSync(jsonPath, 'utf8').trim()};`);
  }
  return constants;
}

/** Убирает import/export, чтобы модули можно было склеить в один скоуп. */
function flatten(code) {
  return code
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s+\{[\s\S]*?\};\s*$/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

compile();

const core = ORDER.map((file) => {
  const source = readFileSync(join(outDir, file), 'utf8');
  const sourceDir = dirname(join(root, 'src', file));
  const constants = inlineJsonImports(source, sourceDir);
  const body = [...constants, flatten(source)].filter(Boolean).join('\n\n');
  return `// ---- ${file} ----\n${body}`;
}).join('\n\n');

// Модули склеиваются в одну область видимости, поэтому имена не должны совпадать.
assertNoDuplicateDeclarations(core);

function assertNoDuplicateDeclarations(code) {
  const seen = new Map();
  const duplicates = [];
  const pattern = /^(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const name = match[1];
    if (seen.has(name)) duplicates.push(name);
    else seen.set(name, true);
  }
  if (duplicates.length) {
    throw new Error(
      `Имена повторяются в склеенном ядре: ${[...new Set(duplicates)].join(', ')}. ` +
        'Переименуйте их в исходниках — иначе автономная сборка сломается.',
    );
  }
}

const template = readFileSync(join(root, 'tools/standalone-template.html'), 'utf8');

// Шрифт для PDF вклеивается в страницу: без сети и без отдельных файлов
// автономная сборка всё равно должна уметь печатать кириллицу.
const fontBase64 = readFileSync(join(root, 'public/fonts/DejaVuSansMono.ttf')).toString('base64');

// Воркер собирается из того же ядра и вклеивается строкой: Blob-воркер
// работает даже при открытии файла с диска, без сервера.
const workerGlue = `
self.onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== 'compute') return;
  try {
    const image = {
      width: request.image.width,
      height: request.image.height,
      data: new Uint8ClampedArray(request.image.data),
    };
    const result = computeMosaicCore(image, Object.assign({}, request.options, {
      onProgress: (progress) => self.postMessage({ type: 'progress', jobId: request.jobId, progress }),
    }));
    self.postMessage({ type: 'done', jobId: request.jobId, result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      jobId: request.jobId,
      message: error && error.message ? error.message : 'Ошибка расчёта',
      cancelled: Boolean(error && error.name === 'CancelledError'),
    });
  }
};
`;

const workerSource = `${core}\n${workerGlue}`;

const html = template
  .replace('/* @CORE@ */', core.replace(/\$/g, '$$$$'))
  .replace('/* @WORKER@ */', `const WORKER_SOURCE = ${JSON.stringify(workerSource)};`)
  .replace('/* @FONT@ */', `globalThis.__MOSAIC_PDF_FONT = ${JSON.stringify(fontBase64)};`);

// Проверяем и склейку с кодом страницы: у шаблона свои функции в том же скоупе.
const inlineScript = html.slice(html.indexOf('<script type="module">'), html.lastIndexOf('</script>'));
assertNoDuplicateDeclarations(inlineScript);

mkdirSync(join(root, 'standalone'), { recursive: true });
writeFileSync(join(root, 'standalone/index.html'), html);
rmSync(outDir, { recursive: true, force: true });

console.log(`standalone/index.html собран (${(html.length / 1024).toFixed(0)} КБ)`);
