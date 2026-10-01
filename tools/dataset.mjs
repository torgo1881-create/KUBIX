/**
 * Датасет для сравнения алгоритмов.
 *
 * Реальные фотографии — источник истины: по ним принимается визуальное
 * решение. Синтетические сцены нужны для регрессии: они покрывают случаи,
 * которых у нас физически нет под рукой (несколько людей, животные,
 * пейзажи, низкий контраст), и позволяют увидеть, не разваливается ли
 * кандидат за пределами портрета.
 *
 * Честная оговорка: синтетика не заменяет реальные снимки. Она проверяет
 * устойчивость, а не красоту.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REAL_DIR = process.env.DS_DIR ?? '/tmp/ds';

/* --------------------------------------------------------- рисовалка */

function createImage(width, height, fill = [128, 128, 128]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function put(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const index = (Math.round(y) * image.width + Math.round(x)) * 4;
  image.data[index] = color[0];
  image.data[index + 1] = color[1];
  image.data[index + 2] = color[2];
}

function ellipse(image, cx, cy, rx, ry, colorAt) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      put(image, x, y, typeof colorAt === 'function' ? colorAt(x, y) : colorAt);
    }
  }
}

function rect(image, x0, y0, w, h, colorAt) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) put(image, x, y, typeof colorAt === 'function' ? colorAt(x, y) : colorAt);
  }
}

/** Детерминированный генератор — датасет должен быть воспроизводимым. */
function rng(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** Портрет со светотенью: свет слева, тень справа, волосы, глаза, рот. */
function drawPortrait(image, options) {
  const { cx, cy, rx, ry, skin, hair, light = 1, shade = 0.75 } = options;

  ellipse(image, cx, cy - ry * 0.42, rx * 1.14, ry * 0.85, hair);

  ellipse(image, cx, cy, rx, ry, (x, y) => {
    // Боковой свет: слева ярче, справа темнее — это и есть «объём».
    const side = (x - (cx - rx)) / (2 * rx);
    const vertical = 1 - 0.18 * ((y - (cy - ry)) / (2 * ry));
    const gain = (light - (light - shade) * side) * vertical;
    return skin.map((channel) => Math.round(channel * gain));
  });

  const eyeY = cy - ry * 0.16;
  const eyeR = Math.max(2, rx * 0.14);
  for (const side of [-1, 1]) {
    ellipse(image, cx + side * rx * 0.36, eyeY, eyeR, eyeR * 0.62, [242, 238, 232]);
    ellipse(image, cx + side * rx * 0.36, eyeY, eyeR * 0.44, eyeR * 0.44, [38, 30, 28]);
    ellipse(image, cx + side * rx * 0.36, eyeY - eyeR * 0.9, eyeR * 1.15, eyeR * 0.28, hair);
  }

  ellipse(image, cx, cy + ry * 0.44, rx * 0.3, ry * 0.085, [168, 82, 80]);
  ellipse(image, cx, cy + ry * 0.16, rx * 0.12, ry * 0.1, skin.map((c) => Math.round(c * 0.88)));
}

/* ------------------------------------------------------ синтетические сцены */

const SKINS = [
  [238, 205, 178],
  [226, 180, 148],
  [198, 148, 112],
  [154, 106, 74],
  [110, 74, 54],
];

const HAIRS = [
  [42, 32, 28],
  [86, 58, 38],
  [22, 20, 22],
  [140, 118, 92],
];

function syntheticPortrait(index, width, height) {
  const random = rng(1000 + index);
  const background = [
    Math.round(90 + random() * 120),
    Math.round(90 + random() * 120),
    Math.round(100 + random() * 120),
  ];
  const image = createImage(width, height, background);

  // Фон с плавным градиентом — на нём хорошо видно «полосы» алгоритма.
  rect(image, 0, 0, width, height, (x, y) =>
    background.map((channel, axis) => Math.round(channel * (0.85 + 0.3 * (axis === 0 ? x / width : y / height)))),
  );

  drawPortrait(image, {
    cx: width * (0.42 + random() * 0.16),
    cy: height * (0.42 + random() * 0.1),
    rx: width * (0.2 + random() * 0.07),
    ry: height * (0.24 + random() * 0.08),
    skin: SKINS[index % SKINS.length],
    hair: HAIRS[index % HAIRS.length],
    light: 1.02 + random() * 0.1,
    shade: 0.6 + random() * 0.2,
  });

  // Плечи.
  rect(image, width * 0.15, height * 0.82, width * 0.7, height * 0.2, [
    Math.round(60 + random() * 80),
    Math.round(70 + random() * 80),
    Math.round(90 + random() * 70),
  ]);

  return image;
}

function syntheticGroup(index, width, height) {
  const random = rng(2000 + index);
  const image = createImage(width, height, [196, 198, 202]);
  rect(image, 0, 0, width, height, (x, y) => [
    Math.round(180 + 40 * (y / height)),
    Math.round(184 + 36 * (y / height)),
    Math.round(190 + 30 * (y / height)),
  ]);

  const count = 2 + Math.floor(random() * 2);
  for (let person = 0; person < count; person++) {
    drawPortrait(image, {
      cx: (width * (person + 0.5)) / count,
      cy: height * (0.42 + random() * 0.08),
      rx: (width / count) * 0.3,
      ry: height * 0.2,
      skin: SKINS[(index + person) % SKINS.length],
      hair: HAIRS[(index + person) % HAIRS.length],
      light: 1.05,
      shade: 0.7,
    });
  }
  return image;
}

function syntheticAnimal(index, width, height) {
  const random = rng(3000 + index);
  const image = createImage(width, height, [92, 118, 76]);
  rect(image, 0, 0, width, height, (x, y) => [
    Math.round(70 + 40 * (y / height)),
    Math.round(100 + 50 * (1 - y / height)),
    Math.round(60 + 30 * random()),
  ]);

  const fur = [
    [186, 128, 62],
    [70, 62, 58],
    [212, 200, 180],
  ][index % 3];

  ellipse(image, width * 0.5, height * 0.55, width * 0.3, height * 0.24, (x, y) =>
    fur.map((channel) => Math.round(channel * (0.85 + 0.3 * (1 - y / height)))),
  );
  // Уши и глаза — мелкие тёмные детали.
  ellipse(image, width * 0.35, height * 0.3, width * 0.07, height * 0.1, fur);
  ellipse(image, width * 0.65, height * 0.3, width * 0.07, height * 0.1, fur);
  ellipse(image, width * 0.42, height * 0.5, width * 0.035, height * 0.03, [24, 24, 26]);
  ellipse(image, width * 0.58, height * 0.5, width * 0.035, height * 0.03, [24, 24, 26]);
  return image;
}

function syntheticObject(index, width, height) {
  const image = createImage(width, height, [235, 233, 228]);
  const palette = [
    [198, 62, 48],
    [56, 96, 170],
    [232, 186, 64],
    [64, 148, 106],
    [128, 96, 168],
  ][index % 5];

  rect(image, 0, height * 0.65, width, height * 0.35, [206, 200, 190]);
  rect(image, width * 0.28, height * 0.3, width * 0.44, height * 0.4, (x, y) =>
    palette.map((channel) => Math.round(channel * (0.75 + 0.45 * (1 - (y - height * 0.3) / (height * 0.4))))),
  );
  ellipse(image, width * 0.5, height * 0.3, width * 0.22, height * 0.07, palette.map((c) => Math.round(c * 1.1)));
  return image;
}

function syntheticLandscape(index, width, height) {
  const random = rng(4000 + index);
  const image = createImage(width, height, [140, 180, 220]);

  rect(image, 0, 0, width, height * 0.55, (x, y) => [
    Math.round(96 + 90 * (y / (height * 0.55))),
    Math.round(140 + 70 * (y / (height * 0.55))),
    Math.round(200 - 30 * (y / (height * 0.55))),
  ]);
  // Горы.
  for (let peak = 0; peak < 3; peak++) {
    const px = width * (0.2 + peak * 0.3);
    const ph = height * (0.2 + random() * 0.15);
    for (let x = 0; x < width; x++) {
      const distance = Math.abs(x - px);
      const top = height * 0.55 - Math.max(0, ph - distance * 0.6);
      for (let y = top; y < height * 0.58; y++) put(image, x, y, [96 - peak * 12, 92 - peak * 10, 104 - peak * 8]);
    }
  }
  rect(image, 0, height * 0.58, width, height * 0.42, (x, y) => [
    Math.round(70 + 30 * random()),
    Math.round(110 + 40 * (1 - y / height)),
    Math.round(58 + 20 * random()),
  ]);
  return image;
}

function syntheticLowContrast(index, width, height) {
  const random = rng(5000 + index);
  const base = 110 + index * 8;
  const image = createImage(width, height, [base, base, base + 4]);

  // Очень узкий диапазон яркости — главный враг ограниченной палитры.
  rect(image, 0, 0, width, height, (x, y) => {
    const value = base + 10 * Math.sin((x / width) * 3) + 8 * (y / height) + random() * 3;
    return [value, value * 0.99, value * 1.02].map((channel) => Math.round(channel));
  });

  drawPortrait(image, {
    cx: width * 0.5,
    cy: height * 0.45,
    rx: width * 0.22,
    ry: height * 0.26,
    skin: [base + 26, base + 12, base + 6],
    hair: [base - 24, base - 26, base - 22],
    light: 1.03,
    shade: 0.9,
  });
  return image;
}

/** Портрет под углом — тот случай, где детектор чаще всего промахивается. */
function syntheticAngledPortrait(index, width, height) {
  const random = rng(6000 + index);
  const image = createImage(width, height, [150, 152, 158]);
  rect(image, 0, 0, width, height, (x, y) => [
    Math.round(130 + 60 * (x / width)),
    Math.round(132 + 55 * (y / height)),
    Math.round(140 + 40 * random()),
  ]);

  // Лицо смещено к краю и сплюснуто — как при съёмке сверху и сбоку.
  drawPortrait(image, {
    cx: width * (0.28 + random() * 0.12),
    cy: height * (0.36 + random() * 0.1),
    rx: width * 0.26,
    ry: height * 0.2,
    skin: SKINS[index % SKINS.length],
    hair: HAIRS[(index + 2) % HAIRS.length],
    light: 1.06,
    shade: 0.55,
  });
  return image;
}

/** Мягкий свет в помещении: контраст низкий, но не нулевой. */
function syntheticIndoorSoft(index, width, height) {
  const random = rng(7000 + index);
  const base = 140 + index * 6;
  const image = createImage(width, height, [base, base - 2, base - 6]);
  rect(image, 0, 0, width, height, (x, y) => {
    const value = base + 14 * (1 - y / height) + random() * 4;
    return [value, value - 3, value - 8].map((c) => Math.round(c));
  });

  drawPortrait(image, {
    cx: width * 0.5,
    cy: height * 0.45,
    rx: width * 0.23,
    ry: height * 0.27,
    skin: [base + 40, base + 16, base + 2],
    hair: [base - 60, base - 62, base - 58],
    light: 1.02,
    shade: 0.86,
  });
  return image;
}

/** Дымка: контраст сжат к середине шкалы, цвета выцветшие. */
function syntheticHaze(index, width, height) {
  const random = rng(8000 + index);
  const image = syntheticLandscape(index, width, height);
  const haze = 0.55 + index * 0.05;

  for (let i = 0; i < image.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const value = image.data[i + channel];
      image.data[i + channel] = Math.round(value * (1 - haze) + 190 * haze + random() * 2);
    }
  }
  return image;
}

/* ------------------------------------------------------------- сборка */

export function loadRealCases() {
  if (!existsSync(REAL_DIR)) return [];

  return readdirSync(REAL_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const meta = JSON.parse(readFileSync(join(REAL_DIR, name), 'utf8'));
      const raw = readFileSync(join(REAL_DIR, name.replace('.json', '.raw')));
      return {
        id: name.replace('.json', ''),
        kind: 'real',
        preset: meta.preset,
        image: { width: meta.w, height: meta.h, data: new Uint8ClampedArray(raw) },
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Синтетика генерируется под конкретный пресет (нужны его пропорции). */
export function buildSyntheticCases(preset, width, height) {
  const cases = [];
  const add = (kind, index, image) => cases.push({ id: `${kind}-${index + 1}`, kind, preset, image });

  for (let i = 0; i < 10; i++) add('portrait', i, syntheticPortrait(i, width, height));
  for (let i = 0; i < 5; i++) add('angled', i, syntheticAngledPortrait(i, width, height));
  for (let i = 0; i < 5; i++) add('indoor', i, syntheticIndoorSoft(i, width, height));
  for (let i = 0; i < 5; i++) add('haze', i, syntheticHaze(i, width, height));
  for (let i = 0; i < 5; i++) add('group', i, syntheticGroup(i, width, height));
  for (let i = 0; i < 5; i++) add('animal', i, syntheticAnimal(i, width, height));
  for (let i = 0; i < 5; i++) add('object', i, syntheticObject(i, width, height));
  for (let i = 0; i < 5; i++) add('landscape', i, syntheticLandscape(i, width, height));
  for (let i = 0; i < 5; i++) add('lowcontrast', i, syntheticLowContrast(i, width, height));

  return cases;
}

export const DATASET_SUMMARY = {
  real: 'по 2 настоящие фотографии на каждый из трёх пресетов',
  synthetic:
    '10 портретов, 5 под углом, 5 групп, 5 животных, 5 предметов, 5 пейзажей, ' +
    '5 низкоконтрастных, 5 мягкий свет, 5 дымка',
};
