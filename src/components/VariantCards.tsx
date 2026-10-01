'use client';

import { Check, Trophy } from 'lucide-react';
import * as React from 'react';

import type { MosaicSource } from '@/algorithms/mosaicGenerator';
import { generateVariants, type Variant } from '@/algorithms/variants/variantGenerator';
import { CanvasMirror } from '@/components/CanvasMirror';
import { Button } from '@/components/ui/button';
import { cn, formatNumber } from '@/lib/utils';

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
 * Четыре варианта одной фотографии. Каждая карточка — превью, число деталей,
 * число цветов и оценка качества; кнопка делает вариант главным результатом.
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

  if (!source) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Один запуск — четыре набора параметров: число цветов, контраст, насыщенность, сглаживание,
          веса цвета и границ, палитра. Оценка считается по снимку, а не выдумывается.
        </p>
        <Button variant="outline" size="sm" onClick={build} disabled={busy}>
          {busy ? (status ?? 'Считаю…') : variants ? 'Пересчитать' : 'Создать 4 варианта'}
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {variants ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="variant-cards">
          {variants.map((variant) => {
            const selected = selectedId === variant.id;
            const score = variant.qualityScore;
            return (
              <article
                key={variant.id}
                data-variant={variant.id}
                className={cn(
                  'flex flex-col gap-3 rounded-lg border bg-card p-3',
                  selected ? 'border-primary' : 'border-border',
                )}
              >
                <CanvasMirror source={variant.image} pixelated />

                <header className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                      Variant {variant.id}
                    </span>
                    {bestId === variant.id ? (
                      <span className="flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                        <Trophy className="size-3" />
                        лучший
                      </span>
                    ) : null}
                  </div>
                  <h3 className="text-sm font-medium">{variant.name}</h3>
                  <p className="text-[11px] leading-snug text-muted-foreground">{variant.description}</p>
                </header>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                  <div>
                    <dt className="text-muted-foreground">Деталей</dt>
                    <dd className="font-mono text-sm" data-pieces>
                      {formatNumber(variant.statistics.pieces)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Цветов</dt>
                    <dd className="font-mono text-sm" data-colors>
                      {variant.statistics.colors}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Quality score</dt>
                    <dd className="font-mono text-sm" data-score>
                      {Math.round(score.total * 100)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Запас</dt>
                    <dd
                      className={cn('font-mono text-sm', variant.statistics.withinLimits ? '' : 'text-destructive')}
                      data-limits={variant.statistics.withinLimits ? 'ok' : 'over'}
                    >
                      {variant.statistics.withinLimits ? 'соблюдён' : 'превышен'}
                    </dd>
                  </div>
                </dl>

                <ul className="space-y-1 font-mono text-[10px] text-muted-foreground">
                  <li>цвет {Math.round(score.colorSimilarity * 100)} · границы {Math.round(score.edgePreservation * 100)}</li>
                  <li>
                    лицо {Math.round(score.facePreservation * 100)}
                    {score.hasFace ? '' : ' (лица нет)'} · запас {Math.round(score.quantityCompliance * 100)}
                  </li>
                  <li>ΔE {score.averageDelta.toFixed(1)} · {variant.statistics.durationMs} мс</li>
                </ul>

                <Button
                  variant={selected ? 'default' : 'outline'}
                  size="sm"
                  className="mt-auto"
                  onClick={() => onSelect(variant)}
                >
                  {selected ? <Check /> : null}
                  {selected ? 'Выбран' : 'Выбрать этот вариант'}
                </Button>
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
