import { mapGridToPalette } from './color/paletteMapping';
import { labDiffusionMapGrid } from './color/labDiffusion';
import { liftDarkFace, FACE_LUMINANCE_FLOOR } from './image/faceExposure';
import { boostEyes, boostFaceVolume, boostMouth, type EyeBoostSettings } from './image/eyeEnhancement';
import { applyWhiteBalance, estimateWhiteBalance, skinAnchoredBalance } from './image/whiteBalance';
import { isSkinPixel, SKIN_CB_MAX_RELAXED } from './face/faceDetection';
import { labChroma, rgbToLab } from './color/lab';
import { autoLevels } from './image/preprocess';
import { balanceGridTone } from './experimental/toneMapping';
import { detailPasses, sharpenGrid, type GridDetailOptions } from './experimental/gridDetail';
import { LAB_DIFFUSION_ZONES, type LabDiffusionZoneStrength } from '../config/experiments';

/** Зональные силы диффузии, пропорционально уменьшенные под общую силу. */
function scaleDiffusionZones(strength: number): LabDiffusionZoneStrength {
  const factor = strength / LAB_DIFFUSION_ZONES.base;
  return {
    base: LAB_DIFFUSION_ZONES.base * factor,
    face: LAB_DIFFUSION_ZONES.face * factor,
    eyes: LAB_DIFFUSION_ZONES.eyes * factor,
    mouth: LAB_DIFFUSION_ZONES.mouth * factor,
    contour: LAB_DIFFUSION_ZONES.contour * factor,
    hair: LAB_DIFFUSION_ZONES.hair * factor,
  };
}
import { detectFaces } from './face/faceDetection';
import { buildAllFaceRegions, type FaceRegions } from './face/faceRegions';
import { computeAverageGrid } from './gridAverage';
import { computeCellMaps } from './image/edges';
import { cloneImage, isPreprocessNeeded, preprocessImage } from './image/preprocess';
import { applyPieceLimits, type PieceLimitResult } from './optimization/pieceLimit';
import { buildWeightMap, uniformWeightMap, type WeightMap } from './optimization/weightMap';
import {
  getMode,
  getRegionWeights,
  type MosaicMode,
  type MosaicModeId,
  type PreprocessSettings,
} from '../config/quality';
import type { ColorSpaceMode, ImageDataLike, MosaicGrid, MosaicProgress } from '../types/mosaic';
import type { ColorDistanceMetric, Palette, PaletteColor, PaletteMapping, PreparedPalette } from '../types/palette';
import type { CostWeights } from './optimization/costFunction';

/**
 * Чистое ядро генерации: пиксели на входе, данные на выходе.
 *
 * Ни DOM, ни canvas здесь не нужны — именно поэтому этот код может целиком
 * уехать в Web Worker и не блокировать интерфейс. Алгоритм не изменился:
 * это ровно те же шаги, что и раньше, просто вынутые из обёртки с canvas.
 */

export interface MosaicCoreOptions {
  cols: number;
  rows: number;
  mode?: MosaicModeId | MosaicMode;
  colorSpace?: ColorSpaceMode;
  distanceMetric?: ColorDistanceMetric;
  palette?: Palette | PaletteColor[] | PreparedPalette;
  enforcePieceLimits?: boolean;
  costWeights?: Partial<CostWeights>;
  preprocess?: Partial<PreprocessSettings>;
  /** Размер рабочего изображения — нужен для карты весов. */
  sampleWidth: number;
  sampleHeight: number;
  onProgress?: (progress: MosaicProgress) => void;
  /**
   * Кооперативная отмена: ядро спрашивает об этом между шагами и, если
   * работа больше не нужна, бросает CancelledError.
   */
  shouldCancel?: () => boolean;
  /**
   * Подтянуть тёмное лицо к комфортной яркости. Светлые лица не трогаются:
   * коррекция срабатывает выборочно, по медиане яркости кожи.
   */
  faceExposure?: boolean | number;
  /** Растянуть гистограмму после коррекции экспозиции. */
  levels?: boolean;
  /**
   * Сила диффузии ошибки, 0..1. Смешивает соседние тона на переходах, из-за
   * чего кожа и градиенты перестают распадаться на плоские пятна.
   */
  dithering?: number;
  /**
   * Приведение тона к целевому распределению по уровням палитры, 0..1.
   * Убирает перекос в тёмную часть шкалы, из-за которого лицо тонет в тени.
   */
  toneBalance?: number;
  /**
   * Усиление глаз до усреднения: локальный контраст и смещение к тёмному
   * внутри маски глаз и бровей. Ничего не дорисовывает — усиливает то,
   * что уже есть на снимке.
   */
  eyeBoost?: Partial<EyeBoostSettings> | null;
  /** Локальный контраст только внутри овала лица, 0..1. */
  faceVolume?: number;
  /** Усиление губ — как для глаз, по области рта. */
  mouthBoost?: { contrast: number; darkBias: number } | null;
  /**
   * Локальный контраст на уровне сетки: `fine` — штрих и фактура (радиус
   * одна ячейка), `coarse` — объём крупных форм (радиус четыре). Это то,
   * чем мозаика готовых наборов отличается от нашей по измерениям.
   */
  gridDetail?: GridDetailOptions | null;
  /**
   * Баланс белого перед подбором цветов, 0..1 или false.
   *
   * Применяется только к цветным палитрам и только после детекции лица:
   * детектор смотрит на оригинал, а цвета подбираются по выправленному
   * снимку. Иначе кожа при свете экрана уходит в серые детали вместо тёплых.
   */
  whiteBalance?: number | boolean;
}

export interface MosaicCoreResult {
  averageGrid: MosaicGrid;
  grid: MosaicGrid;
  mapping?: PaletteMapping;
  pieceLimit?: PieceLimitResult;
  faces: FaceRegions[];
  weightMap: WeightMap;
  mode: MosaicModeId;
}

export class CancelledError extends Error {
  constructor(message = 'Генерация отменена') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'CancelledError';
}

/** Полный расчёт мозаики по пикселям. Синхронный и переносимый. */
export function computeMosaicCore(image: ImageDataLike, options: MosaicCoreOptions): MosaicCoreResult {
  const mode = typeof options.mode === 'object' ? options.mode : getMode(options.mode);
  const {
    cols,
    rows,
    colorSpace = mode.colorSpace,
    distanceMetric = mode.distanceMetric,
    palette,
    enforcePieceLimits = false,
    costWeights = mode.costWeights,
    sampleWidth,
    sampleHeight,
    onProgress,
    shouldCancel,
  } = options;

  const checkpoint = () => {
    if (shouldCancel?.()) throw new CancelledError();
  };

  checkpoint();

  /*
   * Баланс белого — раньше детекции, но только при холодном или магентовом
   * сдвиге (свет экрана, холодная лампа). На таких снимках синяя компонента
   * кожи уходит за порог детектора, и лицо либо не находится, либо находится
   * обрывками. Выправленная копия становится входом для всего конвейера.
   * Тёплые снимки этот шаг не трогает вовсе.
   */
  const chromaticPalette = Boolean(
    palette && ('colors' in palette ? palette.colors : palette).some((color) => labChroma(rgbToLab(color.rgb)) > 8),
  );
  const whiteBalanceStrength =
    options.whiteBalance === false || options.whiteBalance === 0
      ? 0
      : typeof options.whiteBalance === 'number'
        ? options.whiteBalance
        : chromaticPalette
          ? 0.6
          : 0;

  let source: ImageDataLike = image;
  if (whiteBalanceStrength > 0) {
    // Якорь по коже: надёжнее «серого мира» на портретах. Кожа ищется с
    // ослабленным порогом, чтобы поймать и сдвинутую в магенту.
    const candidate = cloneImage(image);
    const skinReport = skinAnchoredBalance(candidate, (r, g, b) => isSkinPixel(r, g, b, SKIN_CB_MAX_RELAXED), {
      strength: whiteBalanceStrength,
    });
    if (skinReport.applied) {
      source = candidate;
    } else {
      // Кожи в кадре мало — предмет, пейзаж, животное: правим только явный холодный сдвиг.
      const report = estimateWhiteBalance(image, { strength: whiteBalanceStrength });
      if (report.applied) {
        applyWhiteBalance(candidate, report.gains);
        source = candidate;
      }
    }
  }

  // Лица ищем по исходным пикселям, до правки контраста и резкости.
  let faces: FaceRegions[] = [];
  let weightMap: WeightMap = uniformWeightMap(cols, rows);
  if (mode.faceDetection) {
    onProgress?.({ stage: 'processing', value: 0.6, message: 'Ищу лицо' });
    const detection = detectFaces(source);
    faces = buildAllFaceRegions(source, detection.faces, { skin: detection.skin });
  }

  checkpoint();

  // Предобработка меняет сами пиксели, а не показ: усреднение увидит уже её результат.
  const preprocess = { ...mode.preprocess, ...options.preprocess };
  const needsExposure =
    Boolean(options.faceExposure) ||
    Boolean(options.levels) ||
    Boolean(options.toneBalance) ||
    Boolean(options.eyeBoost) ||
    Boolean(options.faceVolume) ||
    Boolean(options.mouthBoost);
  const working = isPreprocessNeeded(preprocess) || needsExposure ? cloneImage(source) : source;

  // Экспозиция лица идёт первой: остальная обработка должна видеть уже
  // выправленный тон, иначе контраст растягивается вокруг неверной середины.
  if (working !== source && options.faceExposure && faces.length > 0) {
    const floor = typeof options.faceExposure === 'number' ? options.faceExposure : FACE_LUMINANCE_FLOOR;
    liftDarkFace(
      working,
      faces.map((region) => region.face),
      floor,
    );
  }
  if (working !== source && options.levels) autoLevels(working, 0.02, 0.98);

  // Глаза усиливаем после экспозиции, но до контраста и резкости: иначе
  // общий контраст размажет то, что мы только что вытянули.
  if (working !== source && faces.length > 0) {
    // Порядок: сначала объём всего лица, потом акценты — глаза и губы.
    if (options.faceVolume) boostFaceVolume(working, faces, options.faceVolume);
    if (options.eyeBoost) boostEyes(working, faces, options.eyeBoost);
    if (options.mouthBoost) boostMouth(working, faces, options.mouthBoost);
  }

  if (working !== source) preprocessImage(working, preprocess);

  onProgress?.({ stage: 'processing', value: 1, message: 'Пиксели прочитаны' });
  onProgress?.({ stage: 'generating', value: 0, message: 'Считаю средние цвета' });
  checkpoint();

  const averageWeight = palette ? 0.55 : 0.8;
  const averageGrid = computeAverageGrid(working, {
    cols,
    rows,
    colorSpace,
    onProgress: (value) =>
      onProgress?.({ stage: 'generating', value: value * averageWeight, message: 'Считаю средние цвета' }),
  });

  // Локальный контраст по ячейкам — до тонального баланса: баланс потом
  // расставит уровни уже с учётом добавленных ореолов и фактуры.
  const passes = detailPasses(options.gridDetail);
  if (passes.length) sharpenGrid(averageGrid, passes);

  // Тональный баланс считается по средним цветам ячеек — ровно по тем
  // значениям, которые дальше округляются до деталей палитры.
  if (options.toneBalance && options.toneBalance > 0 && palette) {
    balanceGridTone(averageGrid, palette, undefined, options.toneBalance);
  }

  checkpoint();

  // Карты границ и веса областей нужны и диффузии, и оптимизатору запаса,
  // поэтому считаются один раз здесь, до сопоставления с палитрой.
  const needsMaps = Boolean(options.dithering && options.dithering > 0) || Boolean(enforcePieceLimits && palette);
  let maps: ReturnType<typeof computeCellMaps> | null = null;

  if (needsMaps) {
    maps = computeCellMaps(working, cols, rows);
    if (faces.length > 0 || mode.faceDetection) {
      weightMap = buildWeightMap({
        cols,
        rows,
        width: sampleWidth,
        height: sampleHeight,
        faces,
        edge: maps.edge,
        weights: getRegionWeights(mode),
      });
    }
  }

  checkpoint();

  // Сопоставление с палитрой — отдельный шаг: средние цвета остаются нетронутыми.
  let mapping: PaletteMapping | undefined;
  if (palette) {
    onProgress?.({ stage: 'generating', value: averageWeight, message: 'Подбираю цвета палитры' });
    mapping =
      options.dithering && options.dithering > 0
        ? // Диффузия ошибки: остаток округления переносится на соседей,
          // и переходы читаются как промежуточный тон.
          labDiffusionMapGrid({
            grid: averageGrid,
            palette,
            weightMap,
            // Зональные силы масштабируются под запрошенную: иначе параметр
            // силы игнорировался, и любой дизеринг шёл на полной мощности.
            config: { adaptive: true, strength: options.dithering, zones: scaleDiffusionZones(options.dithering) },
          })
        : mapGridToPalette(averageGrid, palette, {
            metric: distanceMetric,
            onProgress: (value) =>
              onProgress?.({
                stage: 'generating',
                value: averageWeight + value * 0.25,
                message: 'Подбираю цвета палитры',
              }),
          });
  }

  checkpoint();

  // Ограничение по запасу деталей — отдельный шаг поверх сопоставления.
  let pieceLimit: PieceLimitResult | undefined;
  if (mapping && palette && enforcePieceLimits) {
    onProgress?.({ stage: 'generating', value: 0.78, message: 'Свожу с запасом деталей' });

    pieceLimit = applyPieceLimits({
      averageGrid,
      mapping,
      palette,
      options: {
        metric: distanceMetric,
        weights: costWeights,
        maps: maps ?? undefined,
        cellWeights: weightMap.weight,
      },
    });
    mapping = pieceLimit.mapping;
  }

  checkpoint();

  return {
    averageGrid,
    grid: mapping?.grid ?? averageGrid,
    mapping,
    pieceLimit,
    faces,
    weightMap,
    mode: mode.id,
  };
}
