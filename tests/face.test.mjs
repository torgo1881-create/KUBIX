/**
 * Тесты портретного режима: поиск лица, разбор на области, карта весов,
 * предобработка и режимы генерации.
 *
 * Изображения синтетические — в офлайне настоящих фотографий взять негде.
 * Зато они полностью управляемы: известно, где именно нарисованы глаза и рот,
 * и можно проверить, что детектор находит их там же.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeAverageGrid } from '../src/algorithms/gridAverage.ts';
import { mapGridToPalette } from '../src/algorithms/color/paletteMapping.ts';
import { detectFaces, isSkinPixel, mergeFaces } from '../src/algorithms/face/faceDetection.ts';
import { buildAllFaceRegions, buildFaceRegions } from '../src/algorithms/face/faceRegions.ts';
import { computeCellMaps, luminance } from '../src/algorithms/image/edges.ts';
import {
  adjustContrastSaturation,
  autoLevels,
  cloneImage,
  isPreprocessNeeded,
  preprocessImage,
  unsharpMask,
} from '../src/algorithms/image/preprocess.ts';
import { applyPieceLimits } from '../src/algorithms/optimization/pieceLimit.ts';
import { buildWeightMap, uniformWeightMap, REGION_LABELS } from '../src/algorithms/optimization/weightMap.ts';
import {
  MOSAIC_MODES,
  MOSAIC_MODE_IDS,
  REGION_WEIGHTS,
  getMode,
  getRegionWeights,
} from '../src/config/quality.ts';
import { parsePalettes } from '../src/config/palettes.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASIC = parsePalettes(JSON.parse(readFileSync(join(root, 'src/config/palettes.json'), 'utf8'))).byId.basic;

/* ------------------------------------------------------- рисовалка картинок */

function createImage(width, height, background = [120, 140, 165]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = background[0];
    data[i * 4 + 1] = background[1];
    data[i * 4 + 2] = background[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function setPixel(image, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const index = (Math.round(y) * image.width + Math.round(x)) * 4;
  image.data[index] = r;
  image.data[index + 1] = g;
  image.data[index + 2] = b;
  image.data[index + 3] = 255;
}

function fillEllipse(image, cx, cy, rx, ry, colorAt) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      setPixel(image, x, y, typeof colorAt === 'function' ? colorAt(x, y) : colorAt);
    }
  }
}

function fillRect(image, x0, y0, w, h, colorAt) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      setPixel(image, x, y, typeof colorAt === 'function' ? colorAt(x, y) : colorAt);
    }
  }
}

/** Синтетический портрет: волосы, лицо с лёгкой светотенью, глаза, рот. */
function drawFace(image, { cx, cy, rx, ry, skin = [224, 178, 148], hair = [58, 42, 36] }) {
  // Волосы — тёмная шапка над лицом.
  fillEllipse(image, cx, cy - ry * 0.45, rx * 1.12, ry * 0.78, hair);
  // Лицо с вертикальным градиентом, чтобы не было идеальной заливки.
  fillEllipse(image, cx, cy, rx, ry, (x, y) => {
    const shade = 1 - 0.12 * ((y - (cy - ry)) / (2 * ry)) - 0.06 * Math.abs((x - cx) / rx);
    return skin.map((c) => Math.round(c * shade));
  });

  const eyeY = cy - ry * 0.18;
  const eyeOffset = rx * 0.38;
  const eyeR = Math.max(2, rx * 0.15);
  for (const side of [-1, 1]) {
    fillEllipse(image, cx + side * eyeOffset, eyeY, eyeR, eyeR * 0.7, [246, 244, 240]);
    fillEllipse(image, cx + side * eyeOffset, eyeY, eyeR * 0.5, eyeR * 0.5, [34, 30, 32]);
  }

  const mouthY = cy + ry * 0.45;
  fillEllipse(image, cx, mouthY, rx * 0.3, ry * 0.09, [176, 78, 76]);

  return { cx, cy, rx, ry, eyeY, eyeOffset, mouthY };
}

function makePortrait() {
  const image = createImage(300, 400, [126, 148, 170]);
  const geometry = drawFace(image, { cx: 150, cy: 175, rx: 72, ry: 92 });
  fillRect(image, 90, 300, 120, 100, [64, 78, 120]); // плечи
  return { image, geometry };
}

function makeTwoPeople() {
  const image = createImage(420, 300, [200, 205, 210]);
  const left = drawFace(image, { cx: 120, cy: 140, rx: 52, ry: 66 });
  const right = drawFace(image, { cx: 300, cy: 150, rx: 48, ry: 62, skin: [206, 158, 130] });
  return { image, left, right };
}

function makeChild() {
  // У ребёнка голова круглее и меньше относительно кадра.
  const image = createImage(320, 320, [232, 226, 214]);
  const geometry = drawFace(image, { cx: 165, cy: 150, rx: 54, ry: 60, skin: [238, 196, 172] });
  return { image, geometry };
}

function makeAnimal() {
  // Рыжий кот: вытянутая морда, вертикальные зрачки, шерсть не проходит по геометрии.
  const image = createImage(320, 240, [96, 120, 84]);
  fillEllipse(image, 160, 130, 96, 58, [196, 128, 62]);
  fillEllipse(image, 120, 120, 8, 5, [40, 44, 30]);
  fillEllipse(image, 200, 120, 8, 5, [40, 44, 30]);
  fillEllipse(image, 160, 150, 10, 7, [120, 70, 70]);
  return image;
}

function makeLandscape() {
  const image = createImage(360, 240, [140, 180, 220]);
  fillRect(image, 0, 0, 360, 120, (x, y) => [130 + y, 170 + Math.round(y * 0.3), 225 - y]);
  fillRect(image, 0, 120, 360, 60, [176, 148, 96]); // песок — самая опасная для детектора полоса
  fillRect(image, 0, 180, 360, 60, [72, 112, 58]);
  return image;
}

/* ------------------------------------------------------------- детектор лиц */

test('правило кожи отделяет кожу от фона', () => {
  assert.equal(isSkinPixel(224, 178, 148), true, 'светлая кожа');
  assert.equal(isSkinPixel(150, 105, 84), true, 'смуглая кожа');
  assert.equal(isSkinPixel(120, 150, 180), false, 'небо');
  assert.equal(isSkinPixel(70, 110, 55), false, 'трава');
  assert.equal(isSkinPixel(240, 240, 240), false, 'белая стена');
});

test('портрет одного человека: лицо найдено там, где нарисовано', () => {
  const { image, geometry } = makePortrait();
  const result = detectFaces(image);

  assert.equal(result.faces.length, 1, 'ровно одно лицо');
  const face = result.faces[0];
  const centerX = face.x + face.width / 2;
  const centerY = face.y + face.height / 2;

  assert.ok(Math.abs(centerX - geometry.cx) < geometry.rx * 0.4, `центр по X: ${centerX} против ${geometry.cx}`);
  assert.ok(Math.abs(centerY - geometry.cy) < geometry.ry * 0.5, `центр по Y: ${centerY} против ${geometry.cy}`);
  assert.ok(face.width > geometry.rx, 'ширина сопоставима с лицом');
  assert.ok(face.confidence > 0.4);
  assert.equal(face.source, 'skin-heuristic');
});

test('двое в кадре: найдены оба лица', () => {
  const { image, left, right } = makeTwoPeople();
  const result = detectFaces(image);

  assert.equal(result.faces.length, 2, `ожидали два лица, нашли ${result.faces.length}`);
  const centers = result.faces.map((face) => face.x + face.width / 2).sort((a, b) => a - b);
  assert.ok(Math.abs(centers[0] - left.cx) < left.rx * 0.6);
  assert.ok(Math.abs(centers[1] - right.cx) < right.rx * 0.6);
});

test('фотография ребёнка: лицо найдено, черты на месте', () => {
  const { image, geometry } = makeChild();
  const result = detectFaces(image);
  assert.equal(result.faces.length, 1);

  const regions = buildFaceRegions(image, result.faces[0], { skin: result.skin });
  assert.equal(regions.eyes.length, 2, 'оба глаза');
  assert.ok(regions.mouth, 'рот найден');
  assert.ok(regions.featureConfidence >= 0.8);
});

test('животное: морда не принимается за лицо', () => {
  const image = makeAnimal();
  const result = detectFaces(image);
  assert.deepEqual(result.faces, [], `лиц быть не должно, нашли ${result.faces.length}`);
});

test('пейзаж: лиц нет и генерация идёт обычным путём', () => {
  const image = makeLandscape();
  const result = detectFaces(image);
  assert.deepEqual(result.faces, []);

  // Без лиц карта весов остаётся ровной — это и есть «обычный способ».
  const regions = buildAllFaceRegions(image, result.faces, { skin: result.skin });
  const map = buildWeightMap({ cols: 16, rows: 16, width: image.width, height: image.height, faces: regions });
  assert.ok([...map.weight].every((value) => value === 1));
  assert.equal(map.faces, 0);
});

test('пустой кадр не ломает детектор', () => {
  const image = createImage(64, 64, [255, 255, 255]);
  const result = detectFaces(image);
  assert.deepEqual(result.faces, []);
  assert.ok(result.durationMs >= 0);
});

test('обрезанное краем лицо не отбраковывается по пропорциям', () => {
  // Квадратный кадр обрезает портрет сверху и снизу: овал становится
  // прямоугольником, и старая оценка по пропорциям его отвергала.
  const width = 300;
  const height = 300;
  const image = createImage(width, height, [126, 148, 170]);
  drawFace(image, { cx: width / 2, cy: height / 2, rx: width * 0.34, ry: height * 0.52 });

  const tolerant = detectFaces(image);
  assert.equal(tolerant.faces.length >= 1, true, 'лицо у края кадра найдено');
  assert.ok(tolerant.faces[0].confidence >= 0.5, `уверенность ${tolerant.faces[0].confidence}`);

  // Со старым поведением та же находка отбраковывалась.
  const strict = detectFaces(image, { edgeTolerant: false, mergeOverlapping: false });
  assert.ok(
    strict.faces.length === 0 || strict.faces[0].confidence < tolerant.faces[0].confidence,
    'прежняя логика оценивала обрезанное лицо ниже',
  );
});

test('перекрывающиеся находки склеиваются в одну', () => {
  const overlapping = [
    { x: 0, y: 0, width: 100, height: 120, confidence: 0.6, source: 'skin-heuristic' },
    { x: 40, y: 30, width: 90, height: 110, confidence: 0.8, source: 'skin-heuristic' },
  ];
  const merged = mergeFaces(overlapping);

  assert.equal(merged.length, 1, 'два пятна одного лица стали одним');
  assert.equal(merged[0].confidence, 0.8, 'уверенность берётся лучшая');
  assert.equal(merged[0].x, 0);
  assert.equal(merged[0].width, 130, 'рамка охватывает оба пятна');

  // Разнесённые лица остаются раздельными.
  const apart = [
    { x: 0, y: 0, width: 60, height: 70, confidence: 0.7, source: 'skin-heuristic' },
    { x: 200, y: 0, width: 60, height: 70, confidence: 0.7, source: 'skin-heuristic' },
  ];
  assert.equal(mergeFaces(apart).length, 2, 'двое в кадре не склеиваются');
});

test('послабление для края не распространяется на мелкие пятна', () => {
  const image = createImage(300, 300, [126, 148, 170]);
  // Узкая полоска кожи у края: касается границы, но занимает ~1% кадра.
  fillRect(image, 0, 0, 18, 60, [224, 178, 148]);

  const tolerant = detectFaces(image);
  const strict = detectFaces(image, { edgeTolerant: false, mergeOverlapping: false });

  // Важно не то, найдено пятно или нет, а что послабление ничего не изменило:
  // порог по площади не пускает мелочь в «обрезанную» ветку.
  assert.deepEqual(
    tolerant.faces.map((face) => face.confidence),
    strict.faces.map((face) => face.confidence),
    'мелкое краевое пятно оценивается по обычным правилам',
  );
});

test('можно подключить свой детектор (MediaPipe, OpenCV, FaceDetector API)', () => {
  const image = createImage(100, 100);
  const external = () => [{ x: 10, y: 20, width: 30, height: 40, confidence: 0.99, source: 'mediapipe' }];
  const result = detectFaces(image, { detector: external });

  assert.equal(result.detector, 'external');
  assert.equal(result.faces[0].source, 'mediapipe');
  assert.equal(result.faces[0].width, 30);
});

/* --------------------------------------------------------- области лица */

test('глаза, рот, волосы и контур находятся там, где нарисованы', () => {
  const { image, geometry } = makePortrait();
  const detection = detectFaces(image);
  const regions = buildFaceRegions(image, detection.faces[0], { skin: detection.skin });

  assert.equal(regions.eyes.length, 2);
  const [leftEye, rightEye] = [...regions.eyes].sort((a, b) => a.cx - b.cx);

  assert.ok(Math.abs(leftEye.cx - (geometry.cx - geometry.eyeOffset)) < geometry.rx * 0.35, 'левый глаз');
  assert.ok(Math.abs(rightEye.cx - (geometry.cx + geometry.eyeOffset)) < geometry.rx * 0.35, 'правый глаз');
  assert.ok(Math.abs(leftEye.cy - geometry.eyeY) < geometry.ry * 0.25, 'глаза на своей высоте');
  assert.ok(Math.abs(leftEye.cy - rightEye.cy) < geometry.ry * 0.18, 'глаза на одной высоте');

  assert.ok(regions.mouth, 'рот найден');
  const mouthCenter = regions.mouth.y + regions.mouth.height / 2;
  assert.ok(mouthCenter > leftEye.cy, 'рот ниже глаз');
  assert.ok(Math.abs(mouthCenter - geometry.mouthY) < geometry.ry * 0.3, 'рот на своей высоте');

  assert.ok(regions.hair, 'волосы найдены');
  assert.ok(regions.hair.y < detection.faces[0].y, 'волосы выше лица');
  assert.ok(regions.featureConfidence > 0.8);
});

/* ------------------------------------------------------------ карта весов */

test('веса областей берутся из конфига', () => {
  assert.equal(REGION_WEIGHTS.base, 1);
  assert.equal(REGION_WEIGHTS.face, 1.5);
  assert.equal(REGION_WEIGHTS.eyes, 2.5);
  assert.equal(REGION_WEIGHTS.mouth, 2);
  assert.equal(REGION_WEIGHTS.edge, 2);
  assert.ok(REGION_WEIGHTS.hair > REGION_WEIGHTS.base, 'волосам тоже повышенный вес');
});

test('карта весов расставляет 1 / 1.5 / 2.0 / 2.5 по областям', () => {
  const { image } = makePortrait();
  const detection = detectFaces(image);
  const faces = buildAllFaceRegions(image, detection.faces, { skin: detection.skin });
  const cols = 32;
  const rows = 42;

  const map = buildWeightMap({ cols, rows, width: image.width, height: image.height, faces });
  const at = (x, y) => map.weight[Math.floor((y / image.height) * rows) * cols + Math.floor((x / image.width) * cols)];
  const labelAt = (x, y) =>
    REGION_LABELS[map.region[Math.floor((y / image.height) * rows) * cols + Math.floor((x / image.width) * cols)]];

  const eye = faces[0].eyes[0];
  assert.equal(at(eye.cx, eye.cy), REGION_WEIGHTS.eyes, 'глаз');
  assert.equal(labelAt(eye.cx, eye.cy), 'eyes');

  const mouth = faces[0].mouth;
  assert.equal(at(mouth.x + mouth.width / 2, mouth.y + mouth.height / 2), REGION_WEIGHTS.mouth, 'рот');

  // Щека: внутри овала, но не глаз и не рот.
  const cheekX = faces[0].oval.cx + faces[0].oval.rx * 0.45;
  const cheekY = faces[0].oval.cy + faces[0].oval.ry * 0.1;
  assert.equal(at(cheekX, cheekY), REGION_WEIGHTS.face, 'щека — вес лица');

  assert.equal(at(4, image.height - 4), REGION_WEIGHTS.base, 'угол кадра — обычная область');
  assert.equal(map.counts.eyes > 0 && map.counts.face > 0 && map.counts.base > 0, true);
  assert.equal(map.faces, 1);
});

test('границы поднимают вес и без лица', () => {
  const cols = 8;
  const rows = 8;
  const edge = new Float32Array(cols * rows);
  edge[10] = 1;
  edge[11] = 0.5;

  const map = buildWeightMap({ cols, rows, width: 80, height: 80, faces: [], edge });
  assert.equal(map.weight[10], REGION_WEIGHTS.edge);
  assert.ok(map.weight[11] > 1 && map.weight[11] < REGION_WEIGHTS.edge, 'вес растёт плавно');
  assert.equal(map.weight[0], 1);
  assert.equal(REGION_LABELS[map.region[10]], 'edge');
});

test('веса ограничены сверху и uniformWeightMap ровная', () => {
  const map = buildWeightMap({
    cols: 4,
    rows: 4,
    width: 40,
    height: 40,
    faces: [],
    edge: new Float32Array(16).fill(1),
    weights: { edge: 99 },
  });
  assert.ok([...map.weight].every((value) => value <= 3), 'MAX_REGION_WEIGHT соблюдён');

  const uniform = uniformWeightMap(3, 3);
  assert.equal(uniform.counts.base, 9);
  assert.ok([...uniform.weight].every((value) => value === 1));
});

/* ---------------------------------------------------------------- режимы */

test('четыре режима и все меняют параметры алгоритма', () => {
  assert.deepEqual(MOSAIC_MODE_IDS, ['standard', 'portrait', 'highContrast', 'artistic']);

  const standard = getMode('standard');
  const portrait = getMode('portrait');
  const contrast = getMode('highContrast');
  const artistic = getMode('artistic');

  assert.equal(standard.faceDetection, false);
  assert.equal(portrait.faceDetection, true);
  assert.ok(portrait.preprocess.sharpen > standard.preprocess.sharpen, 'портрет резче');
  assert.ok(portrait.costWeights.edge > standard.costWeights.edge, 'портрет бережёт контуры');

  assert.ok(contrast.preprocess.contrast > 1.4, 'контрастный режим действительно тянет контраст');
  assert.equal(contrast.preprocess.autoLevels, true);
  assert.equal(contrast.colorSpace, 'linear');

  assert.equal(artistic.shape, 'circle');
  assert.ok(artistic.gap > 0);
  assert.ok(artistic.costWeights.cohesion > standard.costWeights.cohesion, 'художественный режим склеивает пятна');
  assert.notEqual(artistic.distanceMetric, standard.distanceMetric);

  // Ни один режим не отличается только внешне: у всех разный набор параметров.
  const signatures = MOSAIC_MODE_IDS.map((id) => JSON.stringify(getMode(id)).replace(/"(label|description|id)":"[^"]*",?/g, ''));
  assert.equal(new Set(signatures).size, 4);
});

test('режим масштабирует веса областей, но не выходит за потолок', () => {
  const portrait = getRegionWeights(getMode('portrait'));
  assert.ok(portrait.eyes > REGION_WEIGHTS.eyes, 'портрет усиливает глаза');
  assert.ok(portrait.eyes <= 3);
  assert.equal(getRegionWeights(getMode('standard')).eyes, REGION_WEIGHTS.eyes);
  assert.equal(getRegionWeights(getMode('standard'), { eyes: 9 }).eyes, 9, 'ручное переопределение работает');
});

/* --------------------------------------------------------- предобработка */

const stdev = (image) => {
  let sum = 0;
  let squares = 0;
  const count = image.width * image.height;
  for (let p = 0; p < image.data.length; p += 4) {
    const value = luminance(image.data[p], image.data[p + 1], image.data[p + 2]);
    sum += value;
    squares += value * value;
  }
  return Math.sqrt(squares / count - (sum / count) ** 2);
};

const chroma = (image) => {
  let sum = 0;
  for (let p = 0; p < image.data.length; p += 4) {
    const max = Math.max(image.data[p], image.data[p + 1], image.data[p + 2]);
    const min = Math.min(image.data[p], image.data[p + 1], image.data[p + 2]);
    sum += max - min;
  }
  return sum / (image.width * image.height);
};

test('контраст и насыщенность меняют пиксели, а не показ', () => {
  const { image } = makePortrait();
  const before = { stdev: stdev(image), chroma: chroma(image) };

  const contrasted = cloneImage(image);
  adjustContrastSaturation(contrasted, 1.6, 1);
  assert.ok(stdev(contrasted) > before.stdev * 1.2, 'разброс яркости вырос');

  const saturated = cloneImage(image);
  adjustContrastSaturation(saturated, 1, 1.5);
  assert.ok(chroma(saturated) > before.chroma * 1.2, 'цвет стал насыщеннее');

  const untouched = cloneImage(image);
  adjustContrastSaturation(untouched, 1, 1);
  assert.deepEqual([...untouched.data], [...image.data], 'нейтральные параметры ничего не портят');
});

test('нерезкая маска усиливает границы', () => {
  const { image } = makePortrait();
  const sharpened = cloneImage(image);
  unsharpMask(sharpened, 0.6);

  const edgeEnergy = (source) => {
    const maps = computeCellMaps(source, 24, 32);
    return maps.edge.reduce((sum, value) => sum + value, 0);
  };

  assert.ok(edgeEnergy(sharpened) > edgeEnergy(image), 'после нерезкой маски границ больше');
});

test('autoLevels растягивает гистограмму', () => {
  const image = createImage(40, 40, [110, 112, 115]);
  fillRect(image, 0, 0, 40, 20, [130, 132, 135]);
  const before = stdev(image);
  autoLevels(image);
  assert.ok(stdev(image) > before * 2, 'узкий диапазон растянулся');
});

test('preprocessImage применяет настройки режима целиком', () => {
  const { image } = makePortrait();
  const processed = cloneImage(image);
  preprocessImage(processed, MOSAIC_MODES.highContrast.preprocess);

  assert.ok(stdev(processed) > stdev(image), 'контрастный режим повышает разброс');
  assert.equal(isPreprocessNeeded(MOSAIC_MODES.standard.preprocess), false);
  assert.equal(isPreprocessNeeded(MOSAIC_MODES.portrait.preprocess), true);
});

/* ------------------------------------- главное: лицо переживает ограничения */

test('при дефиците деталей веса сохраняют глаза и рот', () => {
  const { image } = makePortrait();
  const cols = 48;
  const rows = 64;

  const grid = computeAverageGrid(image, { cols, rows });
  const detection = detectFaces(image);
  const faces = buildAllFaceRegions(image, detection.faces, { skin: detection.skin });
  assert.equal(faces.length, 1, 'лицо для этого теста обязательно');

  const maps = computeCellMaps(image, cols, rows);
  const weightMap = buildWeightMap({
    cols,
    rows,
    width: image.width,
    height: image.height,
    faces,
    edge: maps.edge,
  });

  // Жёсткий дефицит: запаса чуть больше, чем ячеек.
  const perColor = Math.ceil((cols * rows) / BASIC.colors.length);
  const palette = { id: 'tight', colors: BASIC.colors.map((color) => ({ ...color, availableQuantity: perColor })) };
  const mapping = mapGridToPalette(grid, palette);

  const withWeights = applyPieceLimits({
    averageGrid: grid,
    mapping,
    palette,
    options: { maps, cellWeights: weightMap.weight },
  });
  const withoutWeights = applyPieceLimits({
    averageGrid: grid,
    mapping,
    palette,
    options: { maps },
  });

  assert.equal(withWeights.satisfied, true);
  assert.equal(withoutWeights.satisfied, true);

  // Считаем, сколько важных ячеек изменило цвет по сравнению с исходным подбором.
  const changedIn = (result, labels) => {
    let changed = 0;
    let total = 0;
    for (let i = 0; i < weightMap.weight.length; i++) {
      if (!labels.includes(REGION_LABELS[weightMap.region[i]])) continue;
      total++;
      if (result.mapping.assignments[i] !== mapping.assignments[i]) changed++;
    }
    return { changed, total, share: total ? changed / total : 0 };
  };

  const important = ['eyes', 'mouth', 'contour'];
  const guarded = changedIn(withWeights, important);
  const blind = changedIn(withoutWeights, important);

  assert.ok(guarded.total > 0, 'важные ячейки в кадре есть');
  assert.ok(
    guarded.share < blind.share,
    `с весами испорчено ${(guarded.share * 100).toFixed(1)}% важных ячеек, без весов ${(blind.share * 100).toFixed(1)}%`,
  );

  console.log(
    `    ↳ важные ячейки (глаза, рот, контур): с весами изменено ${(guarded.share * 100).toFixed(1)}%, без весов ${(blind.share * 100).toFixed(1)}%`,
  );
});
