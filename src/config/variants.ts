import type { ColorSpaceMode } from '../types/mosaic';
import type { ColorDistanceMetric } from '../types/palette';
import type { MosaicModeId } from './quality';
import tunedVariantsJson from './tuned.json';
import variantRankingJson from './variantRanking.json';

/**
 * Наборы параметров для вариантов A–D и веса оценки качества.
 * Варианты отличаются именно этими значениями, а не случайным шумом.
 */

export interface QualityWeights {
  color: number;
  edge: number;
  face: number;
  quantity: number;
}

export const QUALITY_WEIGHTS: QualityWeights = {
  color: 0.4,
  edge: 0.25,
  face: 0.25,
  quantity: 0.1,
};

export const QUALITY_LIMITS = {
  /** ΔE, при которой похожесть цвета считается нулевой. */
  maxAcceptableDelta: 22,
  /** Потолок для варианта, который физически не собрать. */
  infeasiblePenalty: 0.3,
};

export interface VariantSettings {
  /** Подтянуть тёмное лицо к комфортной яркости. */
  faceExposure: boolean;
  /** Растянуть гистограмму. */
  levels: boolean;
  /** Сила диффузии ошибки, 0..1. */
  dithering: number;
  /** Приведение тона к целевому распределению по палитре, 0..1. */
  toneBalance: number;
  /**
   * Усиление глаз: локальный контраст и смещение к тёмному внутри маски
   * глаз и бровей. null — не трогать.
   */
  eyeBoost: { contrast: number; darkBias: number; radiusScale: number; includeBrows: boolean } | null;
  /** Локальный контраст только внутри овала лица, 0..1. */
  faceVolume?: number;
  /**
   * Нерезкая маска по ячейкам сетки, радиус одна ячейка: штрих, фактура,
   * светлые ореолы вдоль тёмных черт — то, чем мозаика готовых наборов
   * отличается от гладких пятен. 0 — выключено.
   */
  detail?: number;
  /** То же с радиусом четыре ячейки: объём крупных форм. 0 — выключено. */
  localContrast?: number;
  contrast: number;
  saturation: number;
  sharpen: number;
  smoothing: number;
}

export type VariantCategory = 'classic' | 'color';

export interface VariantPreset {
  id: string;
  name: string;
  description: string;
  settings: VariantSettings;
  /**
   * Для каких наборов вариант имеет смысл. Тональный баланс, снятый с
   * монохромного эталона, на цветной палитре не работает — такие варианты
   * показываются только там, где помогают.
   */
  categories?: VariantCategory[];
}

/**
 * Варианты одной фотографии.
 *
 * Все считаются на палитре и сетке выбранного набора — отличается только
 * обработка. Пользователь выбирает глазами, а не параметрами: под каждым
 * вариантом стоит понятная фраза, а не набор чисел.
 *
 * Рычаги взяты те, что реально меняют результат на реальных снимках:
 * экспозиция лица, растяжение гистограммы, диффузия ошибки и контраст.
 */
export const VARIANT_PRESETS: VariantPreset[] = [
  /* --- почерк готовых наборов ------------------------------------------
   *
   * Сравнение с готовым набором на одной и той же фотографии (64×96, пять
   * тонов) показало, чем их мозаика отличается от нашей в числах: вдвое
   * больше границ между соседними ячейками, в двенадцать раз чаще сосед
   * отличается сразу на два тона, три тона в блоке 4×4 вместо двух. Это
   * нерезкая маска по ячейкам сетки (detail / localContrast), а не что-то
   * в предобработке пикселей. Стенд: npm run exp:13.
   */
  {
    id: 'G',
    name: 'Как в наборе',
    description: 'Чёткие черты и фактура как у готовых наборов: светлые ореолы вдоль тёмных линий, объём лица.',
    categories: ['classic'],
    settings: {
      faceExposure: true,
      levels: true,
      dithering: 0,
      toneBalance: 0,
      eyeBoost: null,
      detail: 1.5,
      localContrast: 0.6,
      contrast: 1.08,
      saturation: 0.96,
      sharpen: 0.45,
      smoothing: 0,
    },
  },
  {
    id: 'N',
    name: 'Чёткие черты',
    description: 'Тот же приём мягче: глаза, нос и губы читаются, кожа не дробится. Для цветных наборов — основной.',
    settings: {
      faceExposure: true,
      levels: true,
      dithering: 0,
      toneBalance: 0,
      eyeBoost: null,
      detail: 1,
      localContrast: 0.4,
      contrast: 1.08,
      saturation: 0.96,
      sharpen: 0.45,
      smoothing: 0,
    },
  },
  {
    id: 'A',
    name: 'Как на фото',
    description: 'Минимум обработки. Ближе всего к оригинальным тонам снимка.',
    settings: { faceExposure: false, levels: false, dithering: 0, toneBalance: 0, eyeBoost: null, contrast: 1.08, saturation: 0.96, sharpen: 0.45, smoothing: 0 },
  },
  {
    id: 'B',
    name: 'Светлое лицо',
    description: 'Поднимает тёмное лицо, чтобы оно отделилось от волос и фона.',
    settings: { faceExposure: true, levels: true, dithering: 0, toneBalance: 0, eyeBoost: null, contrast: 1.08, saturation: 0.96, sharpen: 0.45, smoothing: 0 },
  },
  {
    id: 'K',
    name: 'Светлое лицо + объём',
    description: 'Рельеф кожи усилен внутри лица: скулы и надбровные дуги читаются, фон не тронут.',
    settings: { faceExposure: true, levels: true, dithering: 0, toneBalance: 0, eyeBoost: null, faceVolume: 0.5, contrast: 1.08, saturation: 0.96, sharpen: 0.45, smoothing: 0 },
  },
  {
    id: 'C',
    name: 'Мягкие переходы',
    description: 'Смешивает соседние тона: кожа выглядит объёмнее, без резких ступеней.',
    settings: { faceExposure: false, levels: false, dithering: 0.3, toneBalance: 0, eyeBoost: null, contrast: 1.08, saturation: 0.96, sharpen: 0.45, smoothing: 0 },
  },
  {
    id: 'D',
    name: 'Детальный',
    description: 'Светлое лицо и мягкие переходы вместе — больше всего полутонов.',
    settings: { faceExposure: true, levels: true, dithering: 0.35, toneBalance: 0, eyeBoost: null, contrast: 1.08, saturation: 0.96, sharpen: 0.45, smoothing: 0 },
  },
  {
    id: 'E',
    name: 'Контрастный',
    description: 'Растянутая гистограмма и усиленный контраст: черты читаются издалека.',
    settings: { faceExposure: false, levels: true, dithering: 0, toneBalance: 0, eyeBoost: null, contrast: 1.4, saturation: 1.05, sharpen: 0.5, smoothing: 0 },
  },
  {
    id: 'F',
    name: 'Графичный',
    description: 'Сильный контраст без смешивания. Крупные пятна света и тени.',
    settings: { faceExposure: true, levels: true, dithering: 0, toneBalance: 0, eyeBoost: null, contrast: 1.55, saturation: 1, sharpen: 0.35, smoothing: 0.15 },
  },

  /* --- варианты с усиленными глазами -----------------------------------
   *
   * База — три уже существующих варианта, к которым добавлено усиление
   * глаз до усреднения. Силы разные: чем светлее или контрастнее база,
   * тем сильнее нужен акцент, иначе взгляд растворяется.
   */

  {
    id: 'H',
    name: 'Контраст + глаза',
    description: 'Контрастный вариант, в котором глаза и брови дополнительно проявлены.',
    settings: {
      faceExposure: false,
      levels: true,
      dithering: 0,
      toneBalance: 0,
      eyeBoost: { contrast: 0.7, darkBias: 0.3, radiusScale: 1.5, includeBrows: true },
      contrast: 1.4,
      saturation: 1.05,
      sharpen: 0.5,
      smoothing: 0,
    },
  },
  {
    id: 'I',
    name: 'Светлое лицо + глаза',
    description: 'Светлая кожа и тёмный выразительный взгляд. Обычно лучший выбор для портрета.',
    settings: {
      faceExposure: true,
      levels: true,
      dithering: 0,
      toneBalance: 0,
      // Лицо поднято к светлому, поэтому глазам нужен акцент сильнее:
      // иначе они растворяются в общей светлой массе.
      eyeBoost: { contrast: 1.1, darkBias: 0.45, radiusScale: 1.6, includeBrows: true },
      contrast: 1.08,
      saturation: 0.96,
      sharpen: 0.45,
      smoothing: 0,
    },
  },
  {
    id: 'J',
    name: 'Графика + глаза',
    description: 'Крупные пятна света и тени, взгляд выделен сильнее всего.',
    settings: {
      faceExposure: true,
      levels: true,
      dithering: 0,
      toneBalance: 0,
      // Самый резкий вариант: зрачок уверенно занимает свою ячейку целиком.
      eyeBoost: { contrast: 1.4, darkBias: 0.55, radiusScale: 1.45, includeBrows: true },
      contrast: 1.55,
      saturation: 1,
      sharpen: 0.35,
      smoothing: 0.15,
    },
  },
];

/** Сколько вариантов строится по умолчанию. */
export const DEFAULT_VARIANT_COUNT = VARIANT_PRESETS.length;

/* ------------------------------------------------------------------------
 * Автоподобранные варианты.
 *
 * `npm run tune -- --apply` записывает найденные настройки в tuned.json.
 * Они попадают в ленту как ещё один вариант — не вместо встроенных, а
 * рядом: пользователи выбирают глазами, а сводка выборов (npm run choices)
 * показывает, выигрывает ли автоподбор у ручных настроек.
 *
 * Файл правится руками и скриптом, поэтому всё проверяется: кривая запись
 * не должна ронять генерацию.
 * ---------------------------------------------------------------------- */

const SETTING_RANGES: Record<'dithering' | 'toneBalance' | 'faceVolume' | 'detail' | 'localContrast' | 'contrast' | 'saturation' | 'sharpen' | 'smoothing', [number, number]> = {
  dithering: [0, 1],
  toneBalance: [0, 1],
  faceVolume: [0, 1],
  detail: [0, 3],
  localContrast: [0, 2],
  contrast: [0.5, 2.5],
  saturation: [0, 2],
  sharpen: [0, 1.5],
  smoothing: [0, 1],
};

function numberIn(value: unknown, range: [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range[1], Math.max(range[0], value));
}

/** Приводит произвольный объект к корректным настройкам варианта. */
export function normalizeVariantSettings(raw: unknown, base: VariantSettings = VARIANT_PRESETS[0].settings): VariantSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const eye = source.eyeBoost && typeof source.eyeBoost === 'object' ? (source.eyeBoost as Record<string, unknown>) : null;
  const eyeContrast = eye ? numberIn(eye.contrast, [0, 3], 0) : 0;
  const eyeDark = eye ? numberIn(eye.darkBias, [0, 1], 0) : 0;
  const faceVolume = numberIn(source.faceVolume, SETTING_RANGES.faceVolume, base.faceVolume ?? 0);
  const detail = numberIn(source.detail, SETTING_RANGES.detail, base.detail ?? 0);
  const localContrast = numberIn(source.localContrast, SETTING_RANGES.localContrast, base.localContrast ?? 0);

  return {
    faceExposure: typeof source.faceExposure === 'boolean' ? source.faceExposure : base.faceExposure,
    levels: typeof source.levels === 'boolean' ? source.levels : base.levels,
    dithering: numberIn(source.dithering, SETTING_RANGES.dithering, base.dithering),
    toneBalance: numberIn(source.toneBalance, SETTING_RANGES.toneBalance, base.toneBalance),
    // Усиление с нулевой силой — то же, что его отсутствие.
    eyeBoost:
      eye && (eyeContrast > 0 || eyeDark > 0)
        ? {
            contrast: eyeContrast,
            darkBias: eyeDark,
            radiusScale: numberIn(eye.radiusScale, [0.5, 3], 1.5),
            includeBrows: typeof eye.includeBrows === 'boolean' ? eye.includeBrows : true,
          }
        : null,
    ...(faceVolume > 0 ? { faceVolume } : {}),
    ...(detail > 0 ? { detail } : {}),
    ...(localContrast > 0 ? { localContrast } : {}),
    contrast: numberIn(source.contrast, SETTING_RANGES.contrast, base.contrast),
    saturation: numberIn(source.saturation, SETTING_RANGES.saturation, base.saturation),
    sharpen: numberIn(source.sharpen, SETTING_RANGES.sharpen, base.sharpen),
    smoothing: numberIn(source.smoothing, SETTING_RANGES.smoothing, base.smoothing),
  };
}

/** Запись в tuned.json: вариант плюс след того, откуда он взялся. */
export interface TunedVariantRecord {
  id: string;
  name: string;
  description?: string;
  /** Встроенный вариант, с которого начинался подбор. */
  base?: string;
  categories?: VariantCategory[];
  settings: VariantSettings;
  tunedAt?: string;
  /** Что и на скольких кадрах улучшилось — для отчёта, не для расчёта. */
  objective?: { frames: number; start: number; best: number };
}

const BUILT_IN_IDS = new Set(VARIANT_PRESETS.map((preset) => preset.id));

/** Разбирает tuned.json; кривые записи пропускаются, а не роняют генерацию. */
export function parseTunedVariants(raw: unknown): VariantPreset[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { variants?: unknown }).variants)
    ? ((raw as { variants: unknown[] }).variants)
    : [];
  const seen = new Set<string>();
  const presets: VariantPreset[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<TunedVariantRecord>;
    if (typeof record.id !== 'string' || !record.id.trim() || BUILT_IN_IDS.has(record.id) || seen.has(record.id)) continue;
    if (typeof record.name !== 'string' || !record.name.trim()) continue;
    const base = VARIANT_PRESETS.find((preset) => preset.id === record.base)?.settings;
    const categories = Array.isArray(record.categories)
      ? (record.categories.filter((c): c is VariantCategory => c === 'classic' || c === 'color'))
      : undefined;
    seen.add(record.id);
    presets.push({
      id: record.id,
      name: record.name,
      description: typeof record.description === 'string' ? record.description : 'Настройки подобраны автоматически по бенчмарку.',
      settings: normalizeVariantSettings(record.settings, base),
      ...(categories && categories.length ? { categories } : {}),
    });
  }
  return presets;
}

export const TUNED_VARIANT_PRESETS: VariantPreset[] = parseTunedVariants(tunedVariantsJson);

/** Встроенные варианты плюс автоподобранные — то, что реально строится. */
export const ALL_VARIANT_PRESETS: VariantPreset[] = [...VARIANT_PRESETS, ...TUNED_VARIANT_PRESETS];

/* ------------------------------------------------------------------------
 * Порядок вариантов по выбору людей.
 *
 * `npm run choices -- --apply` записывает в variantRanking.json, какие
 * варианты чаще выбирают для каждого типа набора и для фото с лицом / без.
 * Лента показывает их первыми, и первый становится выбором по умолчанию.
 * Сами варианты и их настройки это не меняет — только порядок.
 * ---------------------------------------------------------------------- */

export interface VariantRanking {
  updatedAt: string | null;
  minSessions: number;
  /** Ключ — rankingKey(category, faces), значение — id в порядке убывания выборов. */
  rankings: Record<string, string[]>;
}

export function rankingKey(category: VariantCategory | undefined, faces: boolean): string {
  return `${category ?? 'any'}|${faces ? 'face' : 'noface'}`;
}

export function parseVariantRanking(raw: unknown): VariantRanking {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rankings: Record<string, string[]> = {};
  const entries = source.rankings && typeof source.rankings === 'object' ? (source.rankings as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(entries)) {
    if (!Array.isArray(value)) continue;
    const ids = value.filter((id): id is string => typeof id === 'string');
    if (ids.length) rankings[key] = [...new Set(ids)];
  }
  return {
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    minSessions: typeof source.minSessions === 'number' && source.minSessions > 0 ? source.minSessions : 10,
    rankings,
  };
}

export const VARIANT_RANKING: VariantRanking = parseVariantRanking(variantRankingJson);

/**
 * Переставляет элементы: сначала те, что есть в порядке (в его
 * последовательности), затем остальные как были. Неизвестные id в порядке
 * просто пропускаются.
 */
export function orderByRanking<T extends { id: string }>(items: T[], order: string[] | undefined): T[] {
  if (!order || !order.length) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const ranked = order.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
  const rankedIds = new Set(ranked.map((item) => item.id));
  return [...ranked, ...items.filter((item) => !rankedIds.has(item.id))];
}
