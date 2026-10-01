'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { MOSAIC_SIZES } from '@/config/mosaic';
import { PALETTES, getPaletteLabel } from '@/config/paletteData';
import { MOSAIC_MODE_IDS, getMode, type MosaicModeId } from '@/config/quality';
import { cn, formatNumber } from '@/lib/utils';
import type { CellShape, ColorSpaceMode } from '@/types/mosaic';
import type { ColorDistanceMetric } from '@/types/palette';

export interface MosaicSettings {
  /** Режим генерации: меняет предобработку, метрику, веса и форму ячеек. */
  modeId: MosaicModeId;
  sizeId: string;
  shape: CellShape;
  gap: number;
  showGrid: boolean;
  colorSpace: ColorSpaceMode;
  /** id палитры из config/palettes.json либо null — без палитры. */
  paletteId: string | null;
  distanceMetric: ColorDistanceMetric;
  /** Учитывать availableQuantity из palettes.json. */
  enforcePieceLimits: boolean;
}

interface MosaicControlsProps {
  settings: MosaicSettings;
  onChange: (settings: MosaicSettings) => void;
  disabled?: boolean;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="space-y-1.5">
      <span className="eyebrow">{label}</span>
      <div className="flex rounded-md border border-border bg-background p-0.5" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex-1 rounded-[3px] px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              value === option.value
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MosaicControls({ settings, onChange, disabled }: MosaicControlsProps) {
  const update = (patch: Partial<MosaicSettings>) => onChange({ ...settings, ...patch });

  const mode = getMode(settings.modeId);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <span className="eyebrow">Режим</span>
        <div className="grid grid-cols-2 gap-2">
          {MOSAIC_MODE_IDS.map((id) => {
            const option = getMode(id);
            const active = settings.modeId === id;
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                data-mode={id}
                onClick={() => update({ modeId: id })}
                className={cn(
                  'rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                  active ? 'border-primary bg-primary/5' : 'border-border bg-background hover:border-foreground/30',
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">{mode.description}</p>
      </div>

      <div className="space-y-2">
        <span className="eyebrow">Размер мозаики</span>
        <div className="grid grid-cols-2 gap-2">
          {MOSAIC_SIZES.map((preset) => {
            const active = preset.id === settings.sizeId;
            return (
              <button
                key={preset.id}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => update({ sizeId: preset.id })}
                className={cn(
                  'rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                  active
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-background hover:border-foreground/30',
                )}
              >
                <span className="block font-mono text-sm">{preset.label}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {formatNumber(preset.cols * preset.rows)} ячеек
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <span className="eyebrow">Палитра деталей</span>
        <div className="grid gap-2">
          {[{ id: null, label: 'Без палитры', hint: 'Средние цвета как есть' }, ...PALETTES.map((palette) => ({
            id: palette.id,
            label: getPaletteLabel(palette.id),
            hint: `${palette.colors.length} цветов`,
            colors: palette.colors,
          }))].map((option) => {
            const active = settings.paletteId === option.id;
            return (
              <button
                key={option.id ?? 'none'}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                data-palette={option.id ?? 'none'}
                onClick={() => update({ paletteId: option.id })}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                  active ? 'border-primary bg-primary/5' : 'border-border bg-background hover:border-foreground/30',
                )}
              >
                <span>
                  <span className="block text-sm">{option.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{option.hint}</span>
                </span>
                {'colors' in option && option.colors ? (
                  <span className="flex shrink-0 overflow-hidden rounded-[2px] border border-border">
                    {option.colors.map((color) => (
                      <span key={color.id} className="size-3" style={{ background: color.hex }} />
                    ))}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {settings.paletteId ? (
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="eyebrow block">Запас деталей</span>
            <span className="text-[11px] text-muted-foreground">
              Не превышать availableQuantity
            </span>
          </div>
          <Button
            type="button"
            variant={settings.enforcePieceLimits ? 'default' : 'outline'}
            size="sm"
            disabled={disabled}
            aria-pressed={settings.enforcePieceLimits}
            onClick={() => update({ enforcePieceLimits: !settings.enforcePieceLimits })}
          >
            {settings.enforcePieceLimits ? 'Учитывать' : 'Игнорировать'}
          </Button>
        </div>
      ) : null}

      {settings.paletteId ? (
        <Segmented
          label="Метрика близости"
          value={settings.distanceMetric}
          onChange={(distanceMetric) => update({ distanceMetric })}
          disabled={disabled}
          options={[
            { value: 'ciede2000', label: 'ΔE00' },
            { value: 'cie94', label: 'ΔE94' },
            { value: 'cie76', label: 'ΔE76' },
          ]}
        />
      ) : null}

      <Segmented
        label="Форма ячейки"
        value={settings.shape}
        onChange={(shape) => update({ shape })}
        disabled={disabled}
        options={[
          { value: 'square', label: 'Квадрат' },
          { value: 'circle', label: 'Круг' },
        ]}
      />

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Зазор</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {Math.round(settings.gap * 100)}%
          </span>
        </div>
        <Slider
          value={[settings.gap]}
          min={0}
          max={0.4}
          step={0.02}
          disabled={disabled}
          aria-label="Зазор между ячейками"
          onValueChange={([gap]) => update({ gap })}
        />
      </div>

      <Segmented
        label="Усреднение"
        value={settings.colorSpace}
        onChange={(colorSpace) => update({ colorSpace })}
        disabled={disabled}
        options={[
          { value: 'srgb', label: 'sRGB' },
          { value: 'linear', label: 'Линейное' },
        ]}
      />

      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="eyebrow block">Разлиновка</span>
          <span className="text-[11px] text-muted-foreground">Тонкая сетка поверх ячеек</span>
        </div>
        <Button
          type="button"
          variant={settings.showGrid ? 'default' : 'outline'}
          size="sm"
          disabled={disabled}
          aria-pressed={settings.showGrid}
          onClick={() => update({ showGrid: !settings.showGrid })}
        >
          {settings.showGrid ? 'Включена' : 'Выключена'}
        </Button>
      </div>
    </div>
  );
}
