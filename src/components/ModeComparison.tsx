'use client';

import * as React from 'react';

import { generateMosaic, type MosaicSource } from '@/algorithms/mosaicGenerator';
import { CanvasMirror } from '@/components/CanvasMirror';
import { Button } from '@/components/ui/button';
import { AB_PREVIEW_MODES, getMode, type MosaicModeId } from '@/config/quality';
import { getPalette } from '@/config/paletteData';
import { cn } from '@/lib/utils';
import type { MosaicResult } from '@/types/mosaic';

interface ModeComparisonProps {
  /** Кадрированное изображение — тот же источник, что и у основной генерации. */
  source: MosaicSource | null;
  cols: number;
  rows: number;
  paletteId: string | null;
  enforcePieceLimits: boolean;
  /** Какой режим сейчас выбран — подсвечиваем его в сравнении. */
  activeMode: MosaicModeId;
  onPick?: (mode: MosaicModeId) => void;
}

interface PreviewItem {
  mode: MosaicModeId;
  result: MosaicResult;
}

/**
 * A/B-превью: оригинал и три режима рядом, на одном и том же кадре.
 * Каждая плитка — настоящая генерация с параметрами своего режима,
 * а не картинка с фильтром.
 */
export function ModeComparison({
  source,
  cols,
  rows,
  paletteId,
  enforcePieceLimits,
  activeMode,
  onPick,
}: ModeComparisonProps) {
  const [previews, setPreviews] = React.useState<PreviewItem[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Новый кадр или другие настройки — старое сравнение больше не актуально.
  React.useEffect(() => {
    setPreviews(null);
  }, [source, cols, rows, paletteId, enforcePieceLimits]);

  const build = React.useCallback(async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const palette = paletteId ? getPalette(paletteId) : undefined;
      const items: PreviewItem[] = [];
      for (const mode of AB_PREVIEW_MODES) {
        items.push({
          mode,
          result: await generateMosaic({
            source,
            cols,
            rows,
            mode,
            palette,
            enforcePieceLimits: enforcePieceLimits && Boolean(palette),
            targetOutputSize: 768,
          }),
        });
      }
      setPreviews(items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось построить сравнение.');
    } finally {
      setBusy(false);
    }
  }, [cols, enforcePieceLimits, paletteId, rows, source]);

  if (!source) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Один и тот же кадр, три набора параметров алгоритма. Разница — в предобработке пикселей,
          пространстве усреднения и весах, а не в фильтрах поверх картинки.
        </p>
        <Button variant="outline" size="sm" onClick={build} disabled={busy}>
          {busy ? 'Считаю…' : previews ? 'Пересчитать' : 'Сравнить режимы'}
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {previews ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <figure className="space-y-1.5">
            <CanvasMirror source={toCanvas(source)} />
            <figcaption className="space-y-0.5">
              <span className="block font-mono text-[11px] uppercase tracking-wider">Original</span>
              <span className="block text-[11px] text-muted-foreground">Кадр без обработки</span>
            </figcaption>
          </figure>

          {previews.map((item) => {
            const mode = getMode(item.mode);
            const faces = item.result.faces.length;
            return (
              <figure key={item.mode} className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => onPick?.(item.mode)}
                  className={cn(
                    'block w-full overflow-hidden rounded-md border transition-colors',
                    activeMode === item.mode ? 'border-primary' : 'border-transparent hover:border-border',
                  )}
                  aria-pressed={activeMode === item.mode}
                >
                  <CanvasMirror source={item.result.canvas} pixelated />
                </button>
                <figcaption className="space-y-0.5">
                  <span className="block font-mono text-[11px] uppercase tracking-wider">{mode.label}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {mode.faceDetection
                      ? faces > 0
                        ? `лицо найдено: ${faces}`
                        : 'лиц не найдено'
                      : 'без поиска лиц'}
                    {item.result.palette ? ` · ΔE ${item.result.palette.averageDistance.toFixed(1)}` : ''}
                  </span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Источник может быть картинкой или canvas — для показа приводим к canvas. */
function toCanvas(source: MosaicSource): HTMLCanvasElement | null {
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return source;
  const canvas = document.createElement('canvas');
  const width = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const height = 'naturalHeight' in source ? source.naturalHeight : source.height;
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(source as CanvasImageSource, 0, 0);
  return canvas;
}
