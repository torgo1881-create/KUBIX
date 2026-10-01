import type { VariantSettings } from '../../config/variants';

/**
 * Автоподбор параметров варианта.
 *
 * Здесь только чистая логика: как настройки превращаются в вектор чисел,
 * какие у каждого параметра границы и шаг, и сам поиск — покоординатный
 * спуск. Расчёт метрик по кадрам живёт в tools/tune.mjs: он медленный и
 * параллельный, а эта часть должна проверяться тестом за миллисекунды.
 *
 * Честная оговорка. Поиск улучшает ровно то, что измеряет целевая функция.
 * Если метрика расходится с глазами, он уверенно уйдёт не туда — поэтому
 * результат подбора попадает в ленту отдельным вариантом, а не заменяет
 * встроенные: последнее слово за выбором людей.
 */

export interface TunableParam {
  /** Ключ в векторе: поле настроек или `eyeBoost.<поле>`. */
  key: string;
  min: number;
  max: number;
  step: number;
  /** Булевы параметры хранятся как 0/1 с шагом 1. */
  kind: 'number' | 'boolean';
  /** Короткое пояснение для отчёта. */
  label: string;
  /**
   * Ложь — параметр подбирается только если его назвали явно. Так помечены
   * намеренные изменения тона (подъём лица, растяжение гистограммы): метрика
   * меряет верность исходному снимку и всегда голосует против них, хотя
   * ради них варианты и существуют. Их судьбу решает выбор людей.
   */
  tuneByDefault?: boolean;
}

export const TUNABLE_PARAMS: TunableParam[] = [
  { key: 'faceExposure', min: 0, max: 1, step: 1, kind: 'boolean', label: 'подъём тёмного лица', tuneByDefault: false },
  { key: 'levels', min: 0, max: 1, step: 1, kind: 'boolean', label: 'растяжение гистограммы', tuneByDefault: false },
  { key: 'dithering', min: 0, max: 0.6, step: 0.1, kind: 'number', label: 'сила диффузии ошибки' },
  { key: 'toneBalance', min: 0, max: 0.8, step: 0.2, kind: 'number', label: 'тональный баланс' },
  { key: 'faceVolume', min: 0, max: 0.8, step: 0.2, kind: 'number', label: 'рельеф внутри лица' },
  { key: 'detail', min: 0, max: 2, step: 0.25, kind: 'number', label: 'штрих по ячейкам' },
  { key: 'localContrast', min: 0, max: 1.2, step: 0.2, kind: 'number', label: 'объём по ячейкам' },
  { key: 'contrast', min: 0.9, max: 1.6, step: 0.1, kind: 'number', label: 'контраст' },
  { key: 'saturation', min: 0.8, max: 1.2, step: 0.1, kind: 'number', label: 'насыщенность' },
  { key: 'sharpen', min: 0, max: 0.8, step: 0.15, kind: 'number', label: 'резкость' },
  { key: 'smoothing', min: 0, max: 0.3, step: 0.1, kind: 'number', label: 'сглаживание' },
  { key: 'eyeBoost.contrast', min: 0, max: 1.6, step: 0.3, kind: 'number', label: 'контраст глаз' },
  { key: 'eyeBoost.darkBias', min: 0, max: 0.7, step: 0.15, kind: 'number', label: 'затемнение глаз' },
];

export type Vector = Record<string, number>;

const DEFAULT_EYE = { radiusScale: 1.5, includeBrows: true };

/** Настройки → плоский вектор. Отсутствующее усиление глаз — нули. */
export function settingsToVector(settings: VariantSettings): Vector {
  return {
    faceExposure: settings.faceExposure ? 1 : 0,
    levels: settings.levels ? 1 : 0,
    dithering: settings.dithering,
    toneBalance: settings.toneBalance,
    faceVolume: settings.faceVolume ?? 0,
    detail: settings.detail ?? 0,
    localContrast: settings.localContrast ?? 0,
    contrast: settings.contrast,
    saturation: settings.saturation,
    sharpen: settings.sharpen,
    smoothing: settings.smoothing,
    'eyeBoost.contrast': settings.eyeBoost?.contrast ?? 0,
    'eyeBoost.darkBias': settings.eyeBoost?.darkBias ?? 0,
  };
}

/**
 * Вектор → настройки. Радиус и брови берутся из базового варианта: их не
 * подбираем, они зависят от размера глаза, а не от вкуса.
 */
export function vectorToSettings(vector: Vector, base: VariantSettings): VariantSettings {
  const eyeContrast = vector['eyeBoost.contrast'] ?? 0;
  const eyeDark = vector['eyeBoost.darkBias'] ?? 0;
  const faceVolume = vector.faceVolume ?? 0;
  const detail = vector.detail ?? 0;
  const localContrast = vector.localContrast ?? 0;
  return {
    faceExposure: (vector.faceExposure ?? 0) >= 0.5,
    levels: (vector.levels ?? 0) >= 0.5,
    dithering: round(vector.dithering ?? 0),
    toneBalance: round(vector.toneBalance ?? 0),
    eyeBoost:
      eyeContrast > 0 || eyeDark > 0
        ? {
            contrast: round(eyeContrast),
            darkBias: round(eyeDark),
            radiusScale: base.eyeBoost?.radiusScale ?? DEFAULT_EYE.radiusScale,
            includeBrows: base.eyeBoost?.includeBrows ?? DEFAULT_EYE.includeBrows,
          }
        : null,
    ...(faceVolume > 0 ? { faceVolume: round(faceVolume) } : {}),
    ...(detail > 0 ? { detail: round(detail) } : {}),
    ...(localContrast > 0 ? { localContrast: round(localContrast) } : {}),
    contrast: round(vector.contrast ?? base.contrast),
    saturation: round(vector.saturation ?? base.saturation),
    sharpen: round(vector.sharpen ?? base.sharpen),
    smoothing: round(vector.smoothing ?? base.smoothing),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Соседние значения параметра: шаг вниз и шаг вверх в пределах границ. */
export function neighbourValues(param: TunableParam, current: number): number[] {
  const values: number[] = [];
  for (const candidate of [current - param.step, current + param.step]) {
    const clamped = round(Math.min(param.max, Math.max(param.min, candidate)));
    if (Math.abs(clamped - current) > 1e-9 && !values.includes(clamped)) values.push(clamped);
  }
  return values;
}

export function vectorKey(vector: Vector): string {
  return TUNABLE_PARAMS.map((param) => `${param.key}=${round(vector[param.key] ?? 0)}`).join(';');
}

export interface Evaluation {
  /** Чем больше, тем лучше. */
  objective: number;
  /** Ложь — вариант нарушает ограничение (запас деталей, рябь) и не принимается. */
  feasible: boolean;
  /** Что угодно для отчёта: средняя рябь, рельеф, число кадров. */
  details?: Record<string, number | boolean>;
}

export interface SearchStep {
  round: number;
  param: string;
  from: number;
  to: number;
  objective: number;
}

export interface SearchOptions {
  /** Какие параметры трогать; по умолчанию все. */
  params?: string[];
  /** Сколько оценок разрешено всего (кэш не считается). */
  budget?: number;
  /** Сколько проходов по всем параметрам, если улучшения продолжаются. */
  rounds?: number;
  /** Минимальный прирост, который считается улучшением. */
  epsilon?: number;
  onProgress?: (info: { evaluations: number; budget: number; round: number; param: string; best: number }) => void;
}

export interface SearchResult {
  start: Vector;
  startEvaluation: Evaluation;
  best: Vector;
  bestEvaluation: Evaluation;
  steps: SearchStep[];
  evaluations: number;
  /** Остановились из-за исчерпания бюджета, а не потому что улучшений нет. */
  exhausted: boolean;
}

/**
 * Покоординатный спуск: по одному параметру за раз пробуем шаг вниз и шаг
 * вверх, принимаем лучший, если он допустим и улучшает цель больше чем на
 * epsilon. Проход повторяется, пока есть улучшения, бюджет или раунды.
 *
 * Детерминирован, объясним («контраст 1.08 → 1.2 дал +0.004») и устойчив к
 * шумной метрике: маленькие колебания ниже epsilon не принимаются.
 */
export async function coordinateDescent(
  start: Vector,
  evaluate: (vector: Vector) => Promise<Evaluation>,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const params = TUNABLE_PARAMS.filter((param) =>
    options.params ? options.params.includes(param.key) : param.tuneByDefault !== false,
  );
  const budget = options.budget ?? 60;
  const rounds = options.rounds ?? 3;
  const epsilon = options.epsilon ?? 0.001;

  const cache = new Map<string, Evaluation>();
  let evaluations = 0;
  const score = async (vector: Vector): Promise<Evaluation | null> => {
    const key = vectorKey(vector);
    const cached = cache.get(key);
    if (cached) return cached;
    if (evaluations >= budget) return null;
    evaluations++;
    const result = await evaluate(vector);
    cache.set(key, result);
    return result;
  };

  const startEvaluation = (await score(start)) ?? { objective: -Infinity, feasible: false };
  let best = { ...start };
  let bestEvaluation = startEvaluation;
  const steps: SearchStep[] = [];
  let exhausted = false;

  for (let round = 1; round <= rounds && !exhausted; round++) {
    let improved = false;
    for (const param of params) {
      const current = best[param.key] ?? param.min;
      let candidateVector: Vector | null = null;
      let candidateEvaluation: Evaluation | null = null;

      for (const value of neighbourValues(param, current)) {
        const vector = { ...best, [param.key]: value };
        const evaluation = await score(vector);
        if (!evaluation) {
          exhausted = true;
          break;
        }
        options.onProgress?.({ evaluations, budget, round, param: param.key, best: bestEvaluation.objective });
        if (!evaluation.feasible) continue;
        if (evaluation.objective > bestEvaluation.objective + epsilon &&
            (!candidateEvaluation || evaluation.objective > candidateEvaluation.objective)) {
          candidateVector = vector;
          candidateEvaluation = evaluation;
        }
      }

      if (candidateVector && candidateEvaluation) {
        steps.push({ round, param: param.key, from: current, to: candidateVector[param.key], objective: candidateEvaluation.objective });
        best = candidateVector;
        bestEvaluation = candidateEvaluation;
        improved = true;
      }
      if (exhausted) break;
    }
    if (!improved) break;
  }

  return { start, startEvaluation, best, bestEvaluation, steps, evaluations, exhausted };
}

/** Параметры, которые подбираются без явного указания. */
export function defaultTunableKeys(): string[] {
  return TUNABLE_PARAMS.filter((param) => param.tuneByDefault !== false).map((param) => param.key);
}

/** Человекочитаемая разница между двумя векторами — для отчёта. */
export function describeChange(from: Vector, to: Vector): string[] {
  const lines: string[] = [];
  for (const param of TUNABLE_PARAMS) {
    const a = from[param.key] ?? 0;
    const b = to[param.key] ?? 0;
    if (Math.abs(a - b) < 1e-9) continue;
    const show = (value: number) => (param.kind === 'boolean' ? (value >= 0.5 ? 'да' : 'нет') : String(round(value)));
    lines.push(`${param.label} (${param.key}): ${show(a)} → ${show(b)}`);
  }
  return lines;
}
