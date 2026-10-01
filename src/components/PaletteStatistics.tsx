'use client';

import { describeDelta } from '@/algorithms/color/distance';
import { cn, formatNumber } from '@/lib/utils';
import type { PieceLimitResult } from '@/algorithms/optimization/pieceLimit';
import type { PaletteMapping } from '@/types/palette';

interface PaletteStatisticsProps {
  mapping: PaletteMapping;
  /** Всего ячеек в мозаике — для проверки итога. */
  totalCells: number;
  /** Результат учёта запасов: добавляет колонки Required / Available / Status. */
  pieceLimit?: PieceLimitResult;
  className?: string;
}

const STATUS_LABEL: Record<string, string> = {
  ok: 'ok',
  corrected: 'corrected',
  over: 'over limit',
};

/**
 * Список использованных цветов палитры: таблица и визуальная легенда.
 * Количество деталей ничем не ограничивается — колонка «в наличии» пока
 * просто справочная.
 */
export function PaletteStatistics({ mapping, totalCells, pieceLimit, className }: PaletteStatisticsProps) {
  const used = mapping.usage.length;
  const totalPieces = mapping.usage.reduce((sum, item) => sum + item.count, 0);
  const requirementById = new Map(
    (pieceLimit?.requirements ?? []).map((requirement) => [requirement.color.id, requirement]),
  );

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          <span className="font-mono text-foreground">{used}</span> цветов ·{' '}
          <span className="font-mono text-foreground">{formatNumber(totalPieces)}</span> деталей
        </span>
        <span>
          средняя ошибка ΔE{' '}
          <span className="font-mono text-foreground">{mapping.averageDistance.toFixed(1)}</span> —{' '}
          {describeDelta(mapping.averageDistance)}
        </span>
        {pieceLimit ? (
          <span>
            переназначено{' '}
            <span className="font-mono text-foreground">{formatNumber(pieceLimit.moved)}</span> ячеек за{' '}
            {pieceLimit.durationMs} мс
          </span>
        ) : null}
      </div>

      {pieceLimit && !pieceLimit.feasible ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Деталей физически не хватает: на {formatNumber(pieceLimit.totalCells)} ячеек есть только{' '}
          {formatNumber(pieceLimit.totalAvailable)} деталей. Увеличьте запас в palettes.json или возьмите
          сетку помельче.
        </p>
      ) : null}

      {/* Легенда: полоса, где ширина = доля цвета в мозаике */}
      <div className="space-y-1.5">
        <span className="eyebrow">Легенда</span>
        <div
          className="flex h-6 w-full overflow-hidden rounded-sm border border-border"
          role="img"
          aria-label="Доли цветов палитры в мозаике"
        >
          {mapping.usage.map((item) => (
            <span
              key={item.color.id}
              title={`${item.color.name} · ${formatNumber(item.count)} шт · ${(item.share * 100).toFixed(1)}%`}
              style={{ background: item.color.hex, width: `${Math.max(item.share * 100, 0.4)}%` }}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {mapping.usage.map((item) => (
            <span key={item.color.id} className="flex items-center gap-1.5 text-[11px]">
              <span
                className="inline-block size-3 rounded-[2px] border border-border"
                style={{ background: item.color.hex }}
                aria-hidden
              />
              {item.color.name}
              <span className="font-mono text-muted-foreground">{formatNumber(item.count)}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Таблица */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm" data-testid="palette-statistics">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left">
              <Th>Цвет</Th>
              <Th className="font-mono">HEX</Th>
              <Th className="text-right">{pieceLimit ? 'Required' : 'Количество'}</Th>
              <Th className="text-right">Доля</Th>
              <Th className="text-right">{pieceLimit ? 'Available' : 'В наличии'}</Th>
              {pieceLimit ? <Th className="text-right">Status</Th> : null}
            </tr>
          </thead>
          <tbody>
            {mapping.usage.map((item) => {
              const requirement = requirementById.get(item.color.id);
              const short = item.count > item.color.availableQuantity;
              return (
                <tr key={item.color.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block size-4 shrink-0 rounded-[2px] border border-border"
                        style={{ background: item.color.hex }}
                        aria-hidden
                      />
                      {item.color.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">{item.color.hex}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatNumber(item.count)}</td>
                  <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                    {(item.share * 100).toFixed(1)}%
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right font-mono',
                      short ? 'text-destructive' : 'text-muted-foreground',
                    )}
                    title={short ? 'Деталей этого цвета в палитре меньше, чем нужно' : undefined}
                  >
                    {formatNumber(item.color.availableQuantity)}
                  </td>
                  {pieceLimit ? (
                    <td className="px-3 py-2 text-right">
                      <span
                        data-status={requirement?.status ?? 'ok'}
                        title={
                          requirement && requirement.status === 'corrected'
                            ? `Было ${formatNumber(requirement.initialRequired)} — приведено к запасу`
                            : undefined
                        }
                        className={cn(
                          'inline-block rounded-sm border px-1.5 py-0.5 font-mono text-[11px]',
                          requirement?.status === 'over'
                            ? 'border-destructive/40 bg-destructive/10 text-destructive'
                            : requirement?.status === 'corrected'
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-border text-muted-foreground',
                        )}
                      >
                        {STATUS_LABEL[requirement?.status ?? 'ok']}
                      </span>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-secondary/40">
              <td className="px-3 py-2 font-medium">Итого</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2 text-right font-mono">{formatNumber(totalPieces)}</td>
              <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                {totalPieces === totalCells ? '100%' : '—'}
              </td>
              <td className="px-3 py-2" />
              {pieceLimit ? <td className="px-3 py-2" /> : null}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn('px-3 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground', className)}
    >
      {children}
    </th>
  );
}
