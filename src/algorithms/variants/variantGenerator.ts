
import { computeCellMaps } from '../image/edges';
import type { MosaicSource } from '../mosaicGenerator';
import { CancelledError, runMosaic } from '../../services/mosaicRunner';
import { scoreMosaic, type QualityScore } from './qualityScore';
import { getPalette } from '../../config/paletteData';
import {
  ALL_VARIANT_PRESETS,
  VARIANT_RANKING,
  orderByRanking,
  rankingKey,
  type VariantPreset,
  type VariantSettings,
} from '../../config/variants';
import type { MosaicModeId } from '../../config/quality';
import { createCanvas, sampleImageData } from '../mosaicGenerator';
import type { MosaicGrid, MosaicResult, MosaicStage } from '../../types/mosaic';
import type { ColorDistanceMetric, Palette, PaletteUsage } from '../../types/palette';
import type { ColorRequirement } from '../optimization/pieceLimit';

/**
 * Генерация нескольких вариантов одной фотографии.
 *
 * Варианты различаются параметрами алгоритма — числом цветов, контрастом,
 * весами цвета и границ, насыщенностью, сглаживанием и палитрой, — а не
 * случайным шумом: при одинаковом входе результат всегда одинаковый.
 *
 * Ни один вариант не выпускается с нарушенными запасами деталей: палитра
 * урезается только до набора, которого физически хватает на сетку, а
 * итог проверяется по pieceLimit.
 */

export interface VariantStatistics {
  /** Всего деталей (равно числу ячеек). */
  pieces: number;
  /** Сколько разных цветов реально использовано. */
  colors: number;
  /** Сколько цветов было доступно варианту. */
  paletteSize: number;
  usage: PaletteUsage[];
  requirements: ColorRequirement[];
  /** Соблюдены ли запасы. */
  withinLimits: boolean;
  /** Сколько ячеек переназначено ради лимитов. */
  reassigned: number;
  averageDelta: number;
  durationMs: number;
}

export interface Variant {
  id: string;
  name: string;
  description: string;
  settings: VariantSettings;
  mosaic: MosaicResult;
  statistics: VariantStatistics;
  qualityScore: QualityScore;
  /** Готовое изображение варианта. */
  image: HTMLCanvasElement;
}

export interface VariantSet {
  variants: Variant[];
  /** Вариант с наибольшим qualityScore.total. */
  best: Variant | null;
  durationMs: number;
}

export interface GenerateVariantsParams {
  source: MosaicSource;
  cols: number;
  rows: number;
  /** Палитра набора — одна на все варианты. */
  palette?: Palette | null;
  /** Либо id палитры, если объект не передан. */
  paletteId?: string | null;
  /** Режим обработки из профиля набора. */
  modeId?: MosaicModeId;
  distanceMetric?: ColorDistanceMetric;
  /** Категория набора — отсеивает варианты, которые для неё не подходят. */
  category?: 'classic' | 'color';
  /** Учитывать ли запасы деталей. По умолчанию да. */
  enforcePieceLimits?: boolean;
  presets?: VariantPreset[];
  /**
   * Сторона итоговой картинки варианта. На телефоне полный размер (2048 px)
   * для одиннадцати вариантов не помещается в память canvas — там
   * запрашивают поменьше, а полноразмерный PNG дорисовывают из сетки.
   */
  targetOutputSize?: number;
  /** Отмена: прерывает текущий вариант и не начинает следующие. */
  signal?: AbortSignal;
  onProgress?: (progress: { stage: MosaicStage; value: number; message?: string }) => void;
}

/** Один вариант: настройки → мозаика → статистика → оценка. */
export async function generateVariant(
  preset: VariantPreset,
  params: GenerateVariantsParams,
): Promise<Variant> {
  const started = variantClock();
  const { source, cols, rows, enforcePieceLimits = true } = params;
  const settings = preset.settings;

  // Палитра и сетка — из выбранного набора. Варианты отличаются только
  // обработкой, поэтому любой из них физически собирается тем же набором.
  const palette = params.palette ?? (params.paletteId ? getPalette(params.paletteId) : null);

  // Тяжёлый расчёт уходит в воркер (если он есть) — интерфейс не замирает,
  // а на телефоне страница не считается зависшей.
  const mosaic = await runMosaic({
    source,
    cols,
    rows,
    signal: params.signal,
    mode: params.modeId ?? 'portrait',
    palette: palette ?? undefined,
    distanceMetric: params.distanceMetric ?? 'ciede2000',
    targetOutputSize: params.targetOutputSize,
    enforcePieceLimits: enforcePieceLimits && Boolean(palette),
    faceExposure: settings.faceExposure,
    levels: settings.levels,
    dithering: settings.dithering,
    toneBalance: settings.toneBalance,
    eyeBoost: settings.eyeBoost,
    faceVolume: settings.faceVolume,
    gridDetail: { fine: settings.detail ?? 0, coarse: settings.localContrast ?? 0 },
    preprocess: {
      contrast: settings.contrast,
      saturation: settings.saturation,
      sharpen: settings.sharpen,
      smooth: settings.smoothing,
    },
    onProgress: params.onProgress,
  });

  const maps = computeCellMaps(
    sampleImageData(source, mosaic.sampleWidth, mosaic.sampleHeight),
    cols,
    rows,
  );

  const qualityScore = scoreMosaic({
    averageGrid: mosaic.averageGrid,
    mosaicGrid: mosaic.grid,
    maps,
    weightMap: mosaic.weightMap,
    pieceLimit: mosaic.pieceLimit ?? null,
  });

  const usage = mosaic.palette?.usage ?? [];
  const statistics: VariantStatistics = {
    pieces: mosaic.grid.cells.length,
    colors: usage.length || countDistinctColors(mosaic.grid),
    paletteSize: palette?.colors.length ?? 0,
    usage,
    requirements: mosaic.pieceLimit?.requirements ?? [],
    withinLimits: mosaic.pieceLimit ? mosaic.pieceLimit.satisfied : true,
    reassigned: mosaic.pieceLimit?.moved ?? 0,
    averageDelta: qualityScore.averageDelta,
    durationMs: Math.round(variantClock() - started),
  };

  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    settings,
    mosaic,
    statistics,
    qualityScore,
    image: mosaic.canvas,
  };
}

/** Все варианты по очереди. Порядок и результат детерминированы. */
export async function generateVariants(params: GenerateVariantsParams): Promise<VariantSet> {
  const started = variantClock();
  const presets = (params.presets ?? ALL_VARIANT_PRESETS).filter(
    (preset) => !preset.categories || !params.category || preset.categories.includes(params.category),
  );
  const variants: Variant[] = [];

  for (let index = 0; index < presets.length; index++) {
    const preset = presets[index];
    if (params.signal?.aborted) throw new CancelledError();
    params.onProgress?.({
      stage: 'generating',
      value: index / presets.length,
      message: `Вариант ${preset.id}: ${preset.name}`,
    });
    // Макрозадача между вариантами: если расчёт идёт на главном потоке
    // (воркер недоступен), подпись прогресса успевает отрисоваться.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    variants.push(await generateVariant(preset, { ...params, onProgress: undefined }));
  }

  params.onProgress?.({ stage: 'done', value: 1, message: 'Варианты готовы' });

  const best = variants.reduce<Variant | null>(
    (winner, variant) =>
      !winner || variant.qualityScore.total > winner.qualityScore.total ? variant : winner,
    null,
  );

  // Порядок ленты — по выбору людей (variantRanking.json), если он есть для
  // этого типа набора и фото с лицом / без. Первый вариант становится
  // выбором по умолчанию. Явно переданный список пресетов не трогаем.
  const ordered = params.presets
    ? variants
    : orderByRanking(
        variants,
        VARIANT_RANKING.rankings[rankingKey(params.category, (variants[0]?.mosaic.faces.length ?? 0) > 0)],
      );

  return { variants: ordered, best, durationMs: Math.round(variantClock() - started) };
}

function countDistinctColors(grid: MosaicGrid): number {
  const seen = new Set<string>();
  for (const cell of grid.cells) seen.add(cell.hex);
  return seen.size;
}

/** Уменьшенная копия изображения варианта — для карточки. */
export function createVariantThumbnail(variant: Variant, maxSide = 320): HTMLCanvasElement {
  const source = variant.image;
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = createCanvas(source.width * scale, source.height * scale);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

function variantClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
