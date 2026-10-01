'use client';

import { AlertTriangle, Braces, Download, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import * as React from 'react';

import { extractPalette } from '@/algorithms/gridAverage';
import { gridToJson } from '@/algorithms/mosaicGenerator';
import { CancelledError, isWorkerAvailable, runMosaic, setWorkerFactory } from '@/services/mosaicRunner';
import { createMosaicWorker } from '@/lib/workerFactory';
import { ProjectsPanel } from '@/components/ProjectsPanel';
import { ProjectStore, makeThumbnail, type Project } from '@/services/projectStorage';
import { buildShareUrl, readShareUrl, shareProject } from '@/services/shareLink';
import { BuildMode } from '@/components/BuildMode';
import { CanvasMirror } from '@/components/CanvasMirror';
import { CompareViewer } from '@/components/CompareViewer';
import { ImageCropper, type ImageCropperHandle } from '@/components/ImageCropper';
import { ModeComparison } from '@/components/ModeComparison';
import { MosaicControls, type MosaicSettings } from '@/components/MosaicControls';
import { PaletteStatistics } from '@/components/PaletteStatistics';
import { StageProgress } from '@/components/StageProgress';
import { VariantCards } from '@/components/VariantCards';
import { UploadDropzone } from '@/components/UploadDropzone';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DEFAULT_CELL_SHAPE,
  DEFAULT_COLOR_SPACE,
  DEFAULT_GAP,
  DEFAULT_SIZE_ID,
  getSizePreset,
} from '@/config/mosaic';
import { DEFAULT_PALETTE_ID, getPalette, getPaletteLabel } from '@/config/paletteData';
import { DEFAULT_MODE_ID, getMode } from '@/config/quality';
import { ProductPicker, ProductSummary } from '@/components/ProductPicker';
import { buildPresetPalette } from '@/config/paletteData';
import { DEFAULT_PRESET_ID, getPreset, type ProductPreset } from '@/config/productPresets';
import { getProcessingProfile } from '@/config/processingProfiles';
import { describeCapacity, type CapacityStatus } from '@/lib/capacity';
import { buildFilename, downloadCanvasPng, downloadText } from '@/lib/download';
import { loadImageFile, releaseImage } from '@/lib/imageFile';
import { cn, formatBytes, formatNumber } from '@/lib/utils';
import type { MosaicProgress, MosaicResult, SourceImage } from '@/types/mosaic';

const INITIAL_SETTINGS: MosaicSettings = {
  modeId: DEFAULT_MODE_ID,
  sizeId: DEFAULT_SIZE_ID,
  shape: DEFAULT_CELL_SHAPE,
  gap: DEFAULT_GAP,
  showGrid: false,
  colorSpace: DEFAULT_COLOR_SPACE,
  paletteId: DEFAULT_PALETTE_ID,
  distanceMetric: 'ciede2000',
  enforcePieceLimits: true,
};

const IDLE_PROGRESS: MosaicProgress = { stage: 'idle', value: 0 };

export default function HomePage() {
  const cropperRef = React.useRef<ImageCropperHandle>(null);
  const imageRef = React.useRef<SourceImage | null>(null);

  const [image, setImage] = React.useState<SourceImage | null>(null);
  const [settings, setSettings] = React.useState<MosaicSettings>(INITIAL_SETTINGS);
  const [result, setResult] = React.useState<MosaicResult | null>(null);
  const [cropped, setCropped] = React.useState<HTMLCanvasElement | null>(null);
  const [progress, setProgress] = React.useState<MosaicProgress>(IDLE_PROGRESS);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [viewMode, setViewMode] = React.useState<'split' | 'side'>('split');
  const [selectedVariant, setSelectedVariant] = React.useState<string | null>(null);
  const [presetId, setPresetId] = React.useState<string>(DEFAULT_PRESET_ID);
  const [presetChosen, setPresetChosen] = React.useState(false);
  const [manual, setManual] = React.useState(false);
  const [capacity, setCapacity] = React.useState<CapacityStatus | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [projectName, setProjectName] = React.useState('Новый проект');
  const [notice, setNotice] = React.useState<string | null>(null);
  const storeRef = React.useRef<ProjectStore | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const product = getPreset(presetId);
  const profile = getProcessingProfile(product.processingProfile);
  const sizePreset = getSizePreset(settings.sizeId);

  /**
   * Что именно уходит в алгоритм: параметры набора, а в режиме Advanced —
   * ручные настройки. Пользователь технических параметров не выбирает.
   */
  const config = React.useMemo(
    () =>
      manual
        ? {
            cols: sizePreset.cols,
            rows: sizePreset.rows,
            modeId: settings.modeId,
            palette: settings.paletteId ? getPalette(settings.paletteId) : undefined,
            metric: settings.distanceMetric,
            enforceLimits: settings.enforcePieceLimits,
          }
        : {
            cols: product.width,
            rows: product.height,
            modeId: profile.modeId,
            palette: buildPresetPalette(product),
            metric: profile.distanceMetric,
            enforceLimits: profile.enforcePieceLimits,
          },
    [manual, product, profile, settings, sizePreset],
  );

  const preset = { cols: config.cols, rows: config.rows };
  const aspect = config.cols / config.rows;

  React.useEffect(() => {
    imageRef.current = image;
  }, [image]);

  // Инициализация: воркер, хранилище, уборка старых проектов, разбор ссылки.
  React.useEffect(() => {
    setWorkerFactory(() => createMosaicWorker());

    const store = new ProjectStore();
    storeRef.current = store;
    store.cleanup();
    setProjects(store.list());

    const shared = readShareUrl(window.location.href);
    if (shared) {
      setSettings((current) => ({
        ...current,
        modeId: shared.settings.modeId as MosaicSettings['modeId'],
        sizeId: shared.settings.sizeId,
        paletteId: shared.settings.paletteId,
        distanceMetric: shared.settings.distanceMetric as MosaicSettings['distanceMetric'],
        enforcePieceLimits: shared.settings.enforcePieceLimits,
      }));
      setProjectName(shared.name);
      setNotice('Настройки взяты из ссылки. Загрузите свою фотографию — исходник не передаётся.');
    }

    return () => {
      setWorkerFactory(null);
      abortRef.current?.abort();
    };
  }, []);

  React.useEffect(() => () => releaseImage(imageRef.current), []);

  /* --- загрузка --------------------------------------------------------- */

  const handleFile = React.useCallback(async (file: File) => {
    setError(null);
    setBusy(true);
    setProgress({ stage: 'loading', value: 0.2, message: 'Читаю файл' });
    try {
      const next = await loadImageFile(file);
      releaseImage(imageRef.current);
      setResult(null);
      setCropped(null);
      setImage(next);
      setProgress({
        stage: 'processing',
        value: 0.5,
        message: 'Кадрируйте снимок и выберите размер сетки',
      });
    } catch (cause) {
      setImage(null);
      setError(cause instanceof Error ? cause.message : 'Не удалось открыть изображение.');
      setProgress({ stage: 'error', value: 0 });
    } finally {
      setBusy(false);
    }
  }, []);

  /* --- генерация -------------------------------------------------------- */

  const handleGenerate = React.useCallback(async () => {
    if (!image) return;
    setBusy(true);
    setError(null);
    setProgress({ stage: 'generating', value: 0, message: 'Готовлю кадр' });

    try {
      // В режиме результата кроппер размонтирован — тогда берём уже готовый кадр.
      const source = cropperRef.current?.exportCanvas() ?? cropped;
      if (!source) throw new Error('Кадр не готов. Вернитесь к кадрированию.');
      const controller = new AbortController();
      abortRef.current = controller;

      const next = await runMosaic({
        source,
        signal: controller.signal,
        cols: config.cols,
        rows: config.rows,
        mode: config.modeId,
        colorSpace: settings.colorSpace,
        palette: config.palette,
        distanceMetric: config.metric,
        enforcePieceLimits: config.enforceLimits,
        shape: settings.shape,
        gap: settings.gap,
        showGrid: settings.showGrid,
        onProgress: setProgress,
      });
      setCropped(source);
      setResult(next);
      setSelectedVariant(null);
      setCapacity(describeCapacity(product, next.pieceLimit));
      setProgress({
        stage: 'done',
        value: 1,
        message: [
          `${formatNumber(next.grid.cells.length)} ячеек`,
          next.palette ? `${next.palette.usage.length} цветов палитры` : null,
          next.faces.length ? `лиц найдено: ${next.faces.length}` : null,
          `${next.durationMs} мс`,
        ]
          .filter(Boolean)
          .join(' · '),
      });
    } catch (cause) {
      if (cause instanceof CancelledError || (cause as Error)?.name === 'CancelledError') {
        setProgress({ stage: 'processing', value: 0.5, message: 'Генерация отменена' });
      } else {
        setError(cause instanceof Error ? cause.message : 'Генерация не удалась.');
        setProgress({ stage: 'error', value: 0 });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [config, cropped, image, product, settings]);

  const cancelGeneration = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /* --- проекты ---------------------------------------------------------- */

  const snapshot = React.useCallback(
    () => ({
      modeId: settings.modeId,
      sizeId: settings.sizeId,
      paletteId: settings.paletteId,
      distanceMetric: settings.distanceMetric,
      enforcePieceLimits: settings.enforcePieceLimits,
      shape: settings.shape,
      gap: settings.gap,
      showGrid: settings.showGrid,
      colorSpace: settings.colorSpace,
    }),
    [settings],
  );

  const saveProject = React.useCallback(() => {
    const store = storeRef.current;
    if (!store || !result) return;

    const saved = store.save({
      id: projectId ?? undefined,
      name: projectName,
      photoName: image?.name,
      thumbnail: makeThumbnail(result.canvas),
      settings: snapshot(),
      stats: {
        cols: result.grid.cols,
        rows: result.grid.rows,
        pieces: result.grid.cells.length,
        colors: result.palette?.usage.length ?? 0,
        faces: result.faces.length,
        durationMs: result.durationMs,
      },
    });

    if (!saved.ok) {
      setError(saved.error ?? 'Не удалось сохранить проект.');
      return;
    }
    setProjectId(saved.project!.id);
    setProjects(store.list());
    setNotice(saved.evicted > 0 ? `Проект сохранён, ${saved.evicted} старых убрано ради места.` : 'Проект сохранён.');
  }, [image?.name, projectId, projectName, result, snapshot]);

  const openProject = React.useCallback((project: Project) => {
    setProjectId(project.id);
    setProjectName(project.name);
    setSettings((current) => ({
      ...current,
      modeId: project.settings.modeId as MosaicSettings['modeId'],
      sizeId: project.settings.sizeId,
      paletteId: project.settings.paletteId,
      distanceMetric: project.settings.distanceMetric as MosaicSettings['distanceMetric'],
      enforcePieceLimits: project.settings.enforcePieceLimits,
    }));
    setNotice('Настройки проекта загружены. Фотография не сохраняется — выберите её заново.');
  }, []);

  const renameProject = React.useCallback((id: string, name: string) => {
    const store = storeRef.current;
    if (!store) return;
    const renamed = store.rename(id, name);
    setProjects(store.list());
    if (renamed && renamed.id === projectId) setProjectName(renamed.name);
  }, [projectId]);

  const deleteProject = React.useCallback((id: string) => {
    const store = storeRef.current;
    if (!store) return;
    store.remove(id);
    setProjects(store.list());
    if (id === projectId) setProjectId(null);
  }, [projectId]);

  const share = React.useCallback(
    async (project?: Project) => {
      const url = buildShareUrl(window.location.href.split('#')[0], {
        version: 1,
        name: project?.name ?? projectName,
        settings: project?.settings ?? snapshot(),
      });
      const outcome = await shareProject(url, project?.name ?? projectName);
      setNotice(
        outcome === 'copied'
          ? 'Ссылка скопирована. В ней только настройки — фотография остаётся у вас.'
          : outcome === 'shared'
            ? 'Ссылка отправлена.'
            : 'Не удалось поделиться — скопируйте адрес из строки браузера.',
      );
    },
    [projectName, snapshot],
  );

  /* --- действия --------------------------------------------------------- */

  const handleDownloadPng = React.useCallback(async () => {
    if (!result) return;
    try {
      await downloadCanvasPng(result.canvas, buildFilename(result.grid.cols, result.grid.rows, image?.name));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Скачивание не удалось.');
    }
  }, [image?.name, result]);

  const handleDownloadJson = React.useCallback(() => {
    if (!result) return;
    downloadText(
      gridToJson(result.grid),
      buildFilename(result.grid.cols, result.grid.rows, image?.name, 'json'),
    );
  }, [image?.name, result]);

  const handleReset = React.useCallback(() => {
    releaseImage(imageRef.current);
    setImage(null);
    setResult(null);
    setCropped(null);
    setSettings(INITIAL_SETTINGS);
    setSelectedVariant(null);
    setError(null);
    setProgress(IDLE_PROGRESS);
  }, []);

  // Если сменились пропорции сетки, старый кадр больше не подходит.
  React.useEffect(() => {
    if (!result || !cropped) return;
    if (Math.abs(cropped.width / cropped.height - aspect) > 0.02) setResult(null);
  }, [aspect, cropped, result]);

  const palette = React.useMemo(
    () => (result && !result.palette ? extractPalette(result.grid, 8) : []),
    [result],
  );

  /* --- разметка --------------------------------------------------------- */

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 lg:py-14">
      <header className="space-y-3">
        <p className="eyebrow">Фотомозаика · картина из деталей</p>
        <h1 className="max-w-2xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Фотография превращается в картину из деталей — с инструкцией по сборке.
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          Всё считается прямо в браузере: файл никуда не отправляется. Выберите набор, загрузите
          фотографию, кадрируйте — и получите мозаику, статистику деталей и PDF.
        </p>
        <p className="max-w-xl text-sm">
          <a href="/m" className="font-medium text-primary underline underline-offset-4">
            Мобильная версия с лентой вариантов обработки →
          </a>{' '}
          <span className="text-muted-foreground">— откройте с телефона, чтобы сравнить варианты и выбрать лучший.</span>
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {notice ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
          <span data-notice>{notice}</span>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      ) : null}

      {!presetChosen ? (
        <section className="space-y-4">
          <div>
            <span className="eyebrow">Шаг 1</span>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">Выберите набор</h2>
          </div>
          <ProductPicker
            selectedId={presetChosen ? presetId : null}
            onSelect={(next: ProductPreset) => {
              setPresetId(next.id);
              setPresetChosen(true);
              setResult(null);
            }}
          />
        </section>
      ) : !image ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <span className="eyebrow">Шаг 2</span>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">Загрузите фотографию</h2>
            </div>
            <Button variant="outline" size="sm" onClick={() => setPresetChosen(false)}>
              Другой набор
            </Button>
          </div>
          <ProductSummary preset={product} manual={manual} cols={config.cols} rows={config.rows} />
          <UploadDropzone onFile={handleFile} onError={setError} disabled={busy} />
        </section>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Рабочая область */}
          <div className="space-y-6">
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                <CardTitle>{result ? 'Сравнение' : 'Кадрирование'}</CardTitle>
                {result ? (
                  <div className="flex rounded-md border border-border p-0.5">
                    {(
                      [
                        { id: 'split', label: 'Шторка' },
                        { id: 'side', label: 'Рядом' },
                      ] as const
                    ).map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        aria-pressed={viewMode === mode.id}
                        onClick={() => setViewMode(mode.id)}
                        className={
                          'rounded-[3px] px-2 py-1 text-xs transition-colors ' +
                          (viewMode === mode.id
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:text-foreground')
                        }
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </CardHeader>

              <CardContent className="space-y-4">
                <ProductSummary preset={product} manual={manual} cols={config.cols} rows={config.rows} />

                {capacity && result ? (
                  <div
                    data-capacity={capacity.level}
                    className={cn(
                      'rounded-md border border-l-[3px] border-border px-3 py-2',
                      capacity.level === 'insufficient'
                        ? 'border-l-destructive'
                        : capacity.level === 'tight'
                          ? 'border-l-amber-500'
                          : 'border-l-primary',
                    )}
                  >
                    <p className="text-sm font-medium">{capacity.title}</p>
                    <p className="text-[13px] text-muted-foreground">{capacity.detail}</p>
                  </div>
                ) : null}

                {!result ? (
                  <ImageCropper ref={cropperRef} image={image} aspect={aspect} />
                ) : viewMode === 'split' && cropped ? (
                  <CompareViewer original={cropped} mosaic={result.canvas} grid={result.grid} />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <CanvasMirror source={cropped} label="Original" />
                    <CanvasMirror source={result.canvas} label="Mosaic" pixelated />
                  </div>
                )}

                {result ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={handleDownloadPng}>
                      <Download />
                      Скачать PNG
                    </Button>
                    <Button variant="outline" onClick={handleGenerate} disabled={busy}>
                      <RefreshCw className={busy ? 'animate-spin' : undefined} />
                      Пересобрать
                    </Button>
                    <Button variant="outline" onClick={() => setResult(null)} disabled={busy}>
                      Вернуться к кадру
                    </Button>
                    <Button variant="ghost" onClick={handleDownloadJson}>
                      <Braces />
                      Сетка в JSON
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button className="w-full sm:w-auto" onClick={handleGenerate} disabled={busy} data-action="generate">
                      <Sparkles />
                      {busy ? 'Считаю…' : 'Создать мозаику'}
                    </Button>
                    {busy ? (
                      <Button variant="outline" onClick={cancelGeneration} data-action="cancel">
                        Отменить
                      </Button>
                    ) : null}
                    <span className="text-[11px] text-muted-foreground">
                      {isWorkerAvailable() ? 'Расчёт идёт в фоне — интерфейс не подвисает' : 'Расчёт на главном потоке'}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {result ? (
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle>Инструкция по сборке</CardTitle>
                  <span className="eyebrow">Build mode</span>
                </CardHeader>
                <CardContent>
                  <BuildMode
                    result={result}
                    original={cropped}
                    palette={settings.paletteId ? getPalette(settings.paletteId) : null}
                    paletteLabel={settings.paletteId ? getPaletteLabel(settings.paletteId) : undefined}
                    modeLabel={getMode(result.mode).label}
                    photoName={image.name}
                  />
                </CardContent>
              </Card>
            ) : null}

            {result ? (
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle>Варианты</CardTitle>
                  {selectedVariant ? (
                    <span className="eyebrow">выбран вариант {selectedVariant}</span>
                  ) : null}
                </CardHeader>
                <CardContent>
                  <VariantCards
                    source={cropped}
                    cols={preset.cols}
                    rows={preset.rows}
                    paletteId={settings.paletteId}
                    enforcePieceLimits={settings.enforcePieceLimits}
                    selectedId={selectedVariant}
                    onSelect={(variant) => {
                      // Выбранный вариант становится главным результатом.
                      setResult(variant.mosaic);
                      setSelectedVariant(variant.id);
                      setProgress({
                        stage: 'done',
                        value: 1,
                        message: `Вариант ${variant.id} · ${variant.name} · score ${Math.round(
                          variant.qualityScore.total * 100,
                        )}`,
                      });
                    }}
                  />
                </CardContent>
              </Card>
            ) : null}

            {result ? (
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle>A/B: режимы рядом</CardTitle>
                  <span className="eyebrow">{getMode(result.mode).label}</span>
                </CardHeader>
                <CardContent>
                  <ModeComparison
                    source={cropped}
                    cols={preset.cols}
                    rows={preset.rows}
                    paletteId={settings.paletteId}
                    enforcePieceLimits={settings.enforcePieceLimits}
                    activeMode={settings.modeId}
                    onPick={(modeId) => setSettings((current) => ({ ...current, modeId }))}
                  />
                </CardContent>
              </Card>
            ) : null}

            {result?.palette ? (
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle>Использованные цвета</CardTitle>
                  <span className="eyebrow">
                    {getPaletteLabel(result.palette.paletteId)} · {result.palette.metric}
                    {result.pieceLimit
                      ? result.pieceLimit.satisfied
                        ? ' · запас соблюдён'
                        : ' · деталей не хватает'
                      : ''}
                  </span>
                </CardHeader>
                <CardContent>
                  <PaletteStatistics
                    mapping={result.palette}
                    totalCells={result.grid.cells.length}
                    pieceLimit={result.pieceLimit}
                  />
                </CardContent>
              </Card>
            ) : null}

            {result ? (
              <Card>
                <CardHeader>
                  <CardTitle>Что получилось</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                    <Stat label="Сетка" value={`${result.grid.cols} × ${result.grid.rows}`} />
                    <Stat label="Ячеек" value={formatNumber(result.grid.cells.length)} />
                    <Stat label="PNG" value={`${result.width} × ${result.height}`} />
                    <Stat label="Время" value={`${result.durationMs} мс`} />
                  </dl>

                  {result.faces.length ? (
                    <div className="space-y-1.5">
                      <span className="eyebrow">Лицо</span>
                      <ul className="space-y-1 text-sm">
                        {result.faces.map((face, index) => (
                          <li key={index} className="font-mono text-[12px] text-muted-foreground">
                            #{index + 1} {Math.round(face.face.width)}×{Math.round(face.face.height)} px ·
                            глаза: {face.eyes.length} · рот: {face.mouth ? 'да' : 'нет'} · волосы:{' '}
                            {face.hair ? 'да' : 'нет'} · уверенность {face.face.confidence.toFixed(2)}
                          </li>
                        ))}
                      </ul>
                      <p className="text-[11px] text-muted-foreground">
                        Защищено ячеек: глаза {result.weightMap.counts.eyes}, рот{' '}
                        {result.weightMap.counts.mouth}, контур {result.weightMap.counts.contour}, лицо{' '}
                        {result.weightMap.counts.face}
                      </p>
                    </div>
                  ) : getMode(result.mode).faceDetection ? (
                    <p className="text-sm text-muted-foreground">
                      Лиц не найдено — мозаика построена обычным способом.
                    </p>
                  ) : null}

                  <div className="space-y-1.5" hidden={palette.length === 0}>
                    <span className="eyebrow">Палитра снимка</span>
                    <div className="flex flex-wrap gap-1.5">
                      {palette.map((cell) => (
                        <span
                          key={cell.hex}
                          title={`${cell.hex} · rgb(${cell.rgb.join(', ')})`}
                          className="flex items-center gap-1.5 rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[11px]"
                        >
                          <span
                            className="inline-block size-4 rounded-[2px] border border-border"
                            style={{ background: cell.hex }}
                          />
                          {cell.hex}
                        </span>
                      ))}
                    </div>
                  </div>

                  <details className="rounded-md border border-border bg-background p-3">
                    <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      Первая ячейка массива
                    </summary>
                    <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-relaxed">
{JSON.stringify(result.grid.cells[0], null, 2)}
                    </pre>
                  </details>
                </CardContent>
              </Card>
            ) : null}
          </div>

          {/* Панель управления */}
          <aside className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Исходник</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="truncate text-sm" title={image.name}>
                  {image.name}
                </p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Stat label="Разрешение" value={`${image.width} × ${image.height}`} />
                  <Stat label="Файл" value={formatBytes(image.sizeBytes)} />
                  <Stat label="Формат" value={image.type.replace('image/', '').toUpperCase()} />
                  <Stat
                    label="Пикселей"
                    value={formatNumber(Math.round((image.width * image.height) / 1000)) + ' K'}
                  />
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleReset}>
                    <Trash2 />
                    Сбросить
                  </Button>
                </div>
                <UploadDropzone compact onFile={handleFile} onError={setError} disabled={busy} />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-0">
                <details className="group">
                  <summary className="cursor-pointer px-4 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    Advanced · для тестирования алгоритма
                  </summary>

                  <div className="space-y-4 border-t border-border p-4">
                    <p className="text-[12px] leading-snug text-muted-foreground">
                      Обычному пользователю этот раздел не нужен: набор задаёт все параметры сам. Здесь их
                      можно переопределить вручную, чтобы сравнивать поведение алгоритма.
                    </p>

                    <Button
                      variant={manual ? 'default' : 'outline'}
                      size="sm"
                      aria-pressed={manual}
                      data-action="manual-toggle"
                      onClick={() => setManual((current) => !current)}
                    >
                      {manual ? 'Ручные настройки включены' : 'Ручные настройки выключены'}
                    </Button>

                    <div className={manual ? '' : 'pointer-events-none opacity-45'}>
                      <MosaicControls settings={settings} onChange={setSettings} disabled={busy} />
                    </div>

                    {capacity ? (
                      <p className="font-mono text-[11px] text-muted-foreground">
                        debug · feasible: {String(capacity.debug.feasible)} · satisfied:{' '}
                        {String(capacity.debug.satisfied)} · перекрашено {capacity.reassigned} · превышения:{' '}
                        {capacity.debug.overflowColors.join(', ') || 'нет'}
                      </p>
                    ) : null}
                  </div>
                </details>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                <CardTitle>Проект</CardTitle>
                <span className="eyebrow">{projects.length} в истории</span>
              </CardHeader>
              <CardContent className="space-y-3">
                <input
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  aria-label="Название проекта"
                  data-project-name
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={saveProject} disabled={!result} data-action="save-project">
                    Сохранить
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => share()} data-action="share-project">
                    Поделиться
                  </Button>
                </div>
                <ProjectsPanel
                  projects={projects}
                  currentId={projectId}
                  storageAvailable={storeRef.current?.available ?? false}
                  onOpen={openProject}
                  onRename={renameProject}
                  onDelete={deleteProject}
                  onShare={(project) => share(project)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Прогресс</CardTitle>
              </CardHeader>
              <CardContent>
                <StageProgress
                  stage={progress.stage}
                  value={progress.value}
                  message={progress.message}
                />
              </CardContent>
            </Card>
          </aside>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}
