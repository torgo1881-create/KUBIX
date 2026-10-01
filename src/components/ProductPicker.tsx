'use client';

import * as React from 'react';

import { buildPresetPalette, presetPaletteSize } from '@/config/paletteData';
import {
  CATEGORY_LABELS,
  describePreset,
  PRODUCT_PRESETS,
  type ProductCategory,
  type ProductPreset,
} from '@/config/productPresets';
import { cn, formatNumber } from '@/lib/utils';

interface ProductPickerProps {
  selectedId: string | null;
  onSelect: (preset: ProductPreset) => void;
}

const CATEGORY_ORDER: ProductCategory[] = ['classic', 'color'];

/**
 * Шаг 1: выбор набора.
 *
 * В карточке только продуктовые сведения — размер картины, сетка, цвета и
 * объём набора. Технические параметры алгоритма сюда не попадают: их задаёт
 * пресет.
 */
export function ProductPicker({ selectedId, onSelect }: ProductPickerProps) {
  return (
    <div className="space-y-6">
      {CATEGORY_ORDER.map((category) => {
        const presets = PRODUCT_PRESETS.filter((preset) => preset.category === category);
        if (presets.length === 0) return null;

        return (
          <div key={category} className="space-y-3">
            <span className="eyebrow">{CATEGORY_LABELS[category]}</span>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {presets.map((preset) => {
                const card = describePreset(preset, presetPaletteSize(preset));
                const palette = buildPresetPalette(preset);
                const active = selectedId === preset.id;

                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-preset={preset.id}
                    aria-pressed={active}
                    onClick={() => onSelect(preset)}
                    className={cn(
                      'flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-foreground/30',
                    )}
                  >
                    <span className="text-base font-semibold">{card.name}</span>

                    <span className="flex overflow-hidden rounded-sm border border-border">
                      {palette.colors.map((color) => (
                        <span key={color.id} className="h-4 flex-1" style={{ background: color.hex }} />
                      ))}
                    </span>

                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                      <dt className="text-muted-foreground">Картина</dt>
                      <dd className="font-mono">{card.size}</dd>
                      <dt className="text-muted-foreground">Сетка</dt>
                      <dd className="font-mono">{card.grid}</dd>
                      <dt className="text-muted-foreground">Цветов</dt>
                      <dd className="font-mono">{card.colorsLabel}</dd>
                      <dt className="text-muted-foreground">Деталей</dt>
                      <dd className="font-mono">≈ {formatNumber(card.pieces)}</dd>
                    </dl>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Компактная сводка выбранного набора — показывается на шагах 3–5. */
export function ProductSummary({
  preset,
  manual,
  cols,
  rows,
}: {
  preset: ProductPreset;
  manual?: boolean;
  cols?: number;
  rows?: number;
}) {
  const card = describePreset(preset, presetPaletteSize(preset));
  const rowsData: [string, string][] = [
    ['Набор', card.name],
    ['Размер', card.size],
    ['Сетка', manual && cols && rows ? `${cols}×${rows}` : card.grid],
    ['Цветов', manual ? 'ручные настройки' : card.colorsLabel],
    ['Кадр', card.aspect],
  ];

  return (
    <dl className="grid grid-cols-2 gap-3 rounded-md border border-border bg-background p-3 sm:grid-cols-5">
      {rowsData.map(([label, value]) => (
        <div key={label}>
          <dt className="eyebrow">{label}</dt>
          <dd className="font-mono text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
