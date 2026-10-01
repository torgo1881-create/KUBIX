'use client';

import * as React from 'react';

import type { MosaicSource } from '@/algorithms/mosaicGenerator';
import { generateVariants, type Variant } from '@/algorithms/variants/variantGenerator';
import { MosaicView } from '@/components/MosaicView';
import { Button } from '@/components/ui/button';
import type { VariantPreset } from '@/config/variants';
import { cn, formatNumber } from '@/lib/utils';

interface VariantCardListProps {
  /** Что показываем: карточка появляется сразу, превью — когда вариант посчитан. */
  presets: Pick<VariantPreset, 'id' | 'name' | 'description'>[];
  /** Готовые варианты по id. */
  variants: ReadonlyMap<string, Variant>;
  /** Пропорции превью, пока вариант считается: cols / rows. */
  aspect: number;
  bestId?: string | null;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  /** Технические цифры под описанием — для лаборатории. */
  details?: boolean;
}

/**
 * Карточки вариантов одной фотографии: превью на тёмной подложке, название,
 * оценка и кнопка выбора. Считать варианты — дело вызывающего кода.
 */
export function VariantCardList({
  presets,
  variants,
  aspect,
  bestId,
  selectedId,
  onSelect,
  details = false,
}: VariantCardListProps) {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-4"
      data-testid="variant-cards"
    >
      {presets.map((preset) => {
        const variant = variants.get(preset.id);
        const selected = selectedId === preset.id;
        const score = variant?.qualityScore;

        return (
          <article
            key={preset.id}
            data-variant={preset.id}
            data-selected={selected ? 'true' : 'false'}
            className={cn(
              'flex flex-col gap-2.5 rounded-[22px] bg-card p-3',
              selected ? 'shadow-[inset_0_0_0_2px_#C8471F]' : 'shadow-[inset_0_0_0_2px_transparent]',
            )}
          >
            <button
              type="button"
              aria-label={`Выбрать вариант «${preset.name}»`}
              onClick={() => onSelect(preset.id)}
              disabled={!variant}
              className="block rounded-[14px] bg-ink p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <MosaicView grid={variant?.mosaic.grid} aspect={aspect} className="rounded" label={preset.name} />
            </button>

            <div className="flex items-center justify-between gap-2 px-1">
              <h3 className="text-lg font-extrabold leading-tight">{preset.name}</h3>
              <span
                className="rounded-lg bg-background px-2 py-0.5 text-sm font-extrabold tabular-nums"
                title="Оценка качества, 0–100"
                data-score
              >
                {score ? Math.round(score.total * 100) : '…'}
              </span>
            </div>

            {bestId === preset.id ? (
              <span className="ml-1 self-start rounded-lg bg-mint px-2.5 py-0.5 text-xs font-extrabold">
                лучшая оценка
              </span>
            ) : null}

            <p className="px-1 text-sm text-muted-foreground [text-wrap:pretty]">{preset.description}</p>

            {details && variant && score ? (
              <ul className="space-y-0.5 px-1 font-mono text-[11px] text-muted-foreground">
                <li>
                  деталей <span data-pieces>{formatNumber(variant.statistics.pieces)}</span> · цветов{' '}
                  <span data-colors>{variant.statistics.colors}</span> · запас{' '}
                  <span
                    className={variant.statistics.withinLimits ? undefined : 'text-destructive'}
                    data-limits={variant.statistics.withinLimits ? 'ok' : 'over'}
                  >
                    {variant.statistics.withinLimits ? 'соблюдён' : 'превышен'}
                  </span>
                </li>
                <li>
                  цвет {Math.round(score.colorSimilarity * 100)} · границы {Math.round(score.edgePreservation * 100)} ·
                  лицо {Math.round(score.facePreservation * 100)}
                  {score.hasFace ? '' : ' (лица нет)'}
                </li>
                <li>
                  ΔE {score.averageDelta.toFixed(1)} · {variant.statistics.durationMs} мс
                </li>
              </ul>
            ) : null}

            <button
              type="button"
              onClick={() => onSelect(preset.id)}
              disabled={!variant}
              aria-pressed={selected}
              data-action="select-variant"
              className={cn(
                'mt-auto rounded-xl px-3.5 py-2.5 text-sm font-extrabold shadow-[inset_0_0_0_1.5px_#E2D9CC] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50',
                selected ? 'bg-ink text-background' : 'bg-transparent text-ink hover:bg-secondary',
              )}
            >
              {selected ? 'Выбран' : variant ? 'Выбрать' : 'Считаю…'}
            </button>
          </article>
        );
      })}
    </div>
  );
}

interface VariantCardsProps {
  source: MosaicSource | null;
  cols: number;
  rows: number;
  paletteId: string | null;
  enforcePieceLimits: boolean;
  /** id выбранного варианта — подсвечивается. */
  selectedId?: string | null;
  onSelect: (variant: Variant) => void;
}

/**
 * Все варианты одной фотографии по кнопке — для лаборатории. Каждая карточка
 * показывает превью, оценку и технические цифры; кнопка делает вариант
 * главным результатом.
 */
export function VariantCards({
  source,
  cols,
  rows,
  paletteId,
  enforcePieceLimits,
  selectedId,
  onSelect,
}: VariantCardsProps) {
  const [variants, setVariants] = React.useState<Variant[] | null>(null);
  const [bestId, setBestId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setVariants(null);
    setBestId(null);
  }, [source, cols, rows, paletteId, enforcePieceLimits]);

  const build = React.useCallback(async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const set = await generateVariants({
        source,
        cols,
        rows,
        paletteId,
        enforcePieceLimits,
        onProgress: (progress) => setStatus(progress.message ?? null),
      });
      setVariants(set.variants);
      setBestId(set.best?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось построить варианты.');
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [cols, enforcePieceLimits, paletteId, rows, source]);

  const byId = React.useMemo(
    () => new Map((variants ?? []).map((variant) => [variant.id, variant])),
    [variants],
  );

  if (!source) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Один запуск — все наборы параметров: контраст, насыщенность, сглаживание, веса цвета и
          границ. Оценка считается по снимку, а не выдумывается.
        </p>
        <Button variant="outline" size="sm" onClick={build} disabled={busy}>
          {busy ? (status ?? 'Считаю…') : variants ? 'Пересчитать' : 'Создать варианты'}
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {variants ? (
        <VariantCardList
          presets={variants}
          variants={byId}
          aspect={cols / rows}
          bestId={bestId}
          selectedId={selectedId}
          details
          onSelect={(id) => {
            const variant = byId.get(id);
            if (variant) onSelect(variant);
          }}
        />
      ) : null}
    </div>
  );
}
