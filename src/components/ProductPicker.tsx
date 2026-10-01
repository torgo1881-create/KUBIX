'use client';

import * as React from 'react';

import { MosaicView } from '@/components/MosaicView';
import { buildPresetPalette, presetPaletteSize } from '@/config/paletteData';
import {
  CATEGORY_LABELS,
  describePreset,
  presetAspect,
  PRODUCT_PRESETS,
  type ProductCategory,
  type ProductPreset,
} from '@/config/productPresets';
import { cn, formatNumber } from '@/lib/utils';
import type { MosaicGrid } from '@/types/mosaic';

/** Превью наборов: фото покупателя в палитре и сетке каждого набора. */
export type PresetPreviews = ReadonlyMap<string, MosaicGrid>;

const CATEGORY_ORDER: ProductCategory[] = ['classic', 'color'];

/** Наборы в порядке витрины: сначала Classic, затем Color. */
const ORDERED_PRESETS = CATEGORY_ORDER.flatMap((category) =>
  PRODUCT_PRESETS.filter((preset) => preset.category === category),
);

function tonesLabel(count: number, withBase: boolean): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11 ? 'тон' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'тона' : 'тонов';
  return `${count} ${word}${withBase ? ' + чёрная основа' : ''}`;
}

function Swatches({ preset, size }: { preset: ProductPreset; size: number }) {
  return (
    <span className="flex items-center gap-0.5">
      {buildPresetPalette(preset).colors.map((color) => (
        <span
          key={color.id}
          title={color.name}
          className="rounded-[3px] shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)]"
          style={{ background: color.hex, width: size, height: size }}
        />
      ))}
    </span>
  );
}

interface ProductPickerProps {
  selectedId: string | null;
  onSelect: (preset: ProductPreset) => void;
  /** Если переданы — в карточке показывается мозаика фото, иначе цвета набора. */
  previews?: PresetPreviews;
}

/**
 * Шаг 1: выбор набора.
 *
 * В карточке только продуктовые сведения — размер картины, цвета и объём
 * набора. Технические параметры алгоритма сюда не попадают: их задаёт пресет.
 */
export function ProductPicker({ selectedId, onSelect, previews }: ProductPickerProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,210px),1fr))] gap-3.5">
      {ORDERED_PRESETS.map((preset) => {
        const card = describePreset(preset, presetPaletteSize(preset));
        const active = selectedId === preset.id;

        return (
          <button
            key={preset.id}
            type="button"
            data-preset={preset.id}
            aria-pressed={active}
            onClick={() => onSelect(preset)}
            className={cn(
              'flex flex-col gap-2.5 rounded-[20px] bg-card p-3 text-left text-ink',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              active ? 'shadow-[inset_0_0_0_2px_#C8471F]' : 'shadow-[inset_0_0_0_2px_transparent]',
            )}
          >
            {previews ? (
              <span className="relative block aspect-square w-full rounded-xl bg-ink">
                <MosaicView
                  grid={previews.get(preset.id)}
                  aspect={presetAspect(preset)}
                  label={`${card.name}: превью`}
                  className="absolute inset-2 h-[calc(100%-16px)] w-[calc(100%-16px)] rounded-[3px] object-contain"
                />
              </span>
            ) : (
              <span className="px-1 pt-1">
                <Swatches preset={preset} size={16} />
              </span>
            )}

            <span className="flex items-baseline justify-between gap-2 px-1">
              <span className="font-display text-[19px] font-extrabold leading-tight">{card.name}</span>
              <span className="text-[13px] text-muted-foreground">{card.size}</span>
            </span>
            <span className="px-1 pb-1 text-[13px] text-muted-foreground">
              {tonesLabel(card.colors, preset.baseColorEnabled)} · ≈ {formatNumber(card.pieces)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface ProductCatalogProps {
  previews: PresetPreviews;
  onBuy: (preset: ProductPreset) => void;
  /** «Примерить»: открыть генератор с этим набором. */
  onTry: (preset: ProductPreset) => void;
}

/** Каталог на лендинге: те же наборы, но с покупкой и примеркой. */
export function ProductCatalog({ previews, onBuy, onTry }: ProductCatalogProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,210px),1fr))] gap-4">
      {ORDERED_PRESETS.map((preset) => {
        const card = describePreset(preset, presetPaletteSize(preset));

        return (
          <article
            key={preset.id}
            data-preset={preset.id}
            className="flex flex-col gap-3 rounded-[22px] bg-background p-3.5"
          >
            <div className="relative aspect-[3/4] rounded-[14px] bg-ink">
              <MosaicView
                grid={previews.get(preset.id)}
                aspect={presetAspect(preset)}
                label={`${card.name}: превью`}
                className="absolute inset-2.5 h-[calc(100%-20px)] w-[calc(100%-20px)] rounded object-contain"
              />
            </div>

            <div className="flex items-baseline justify-between gap-2 px-1">
              <h3 className="font-display text-xl font-extrabold leading-tight">{card.name}</h3>
              <span className="text-[13px] text-muted-foreground">{CATEGORY_LABELS[preset.category]}</span>
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-1 text-sm">
              <dt className="text-muted-foreground">Картина</dt>
              <dd className="font-extrabold">{card.size}</dd>
              <dt className="text-muted-foreground">Деталей</dt>
              <dd className="font-extrabold">≈ {formatNumber(card.pieces)}</dd>
              <dt className="text-muted-foreground">Цвета</dt>
              <dd className="flex items-center">
                <Swatches preset={preset} size={12} />
              </dd>
            </dl>

            <div className="mt-auto flex flex-col gap-1.5 px-1 pb-0.5 pt-1">
              <button
                type="button"
                data-action="buy"
                onClick={() => onBuy(preset)}
                className="h-[42px] w-full rounded-[10px] bg-primary text-[15px] font-bold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                В корзину
              </button>
              <button
                type="button"
                data-action="try"
                title="Примерить своё фото"
                onClick={() => onTry(preset)}
                className="h-[42px] w-full rounded-[10px] border-[1.5px] border-ink bg-card text-[15px] font-bold text-ink transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                Примерить
              </button>
            </div>
          </article>
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
