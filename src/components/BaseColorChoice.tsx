'use client';

import * as React from 'react';

import { getPalette, presetPaletteSize } from '@/config/paletteData';
import { BASE_COLOR_ID, baseColorIsOptional, type ProductPreset } from '@/config/productPresets';
import { cn } from '@/lib/utils';

interface BaseColorChoiceProps {
  preset: ProductPreset;
  withBase: boolean;
  onChange: (withBase: boolean) => void;
  /** Короткий вид — одна строка, для шага «Вариант». */
  compact?: boolean;
  className?: string;
}

/**
 * Выбор «с основой / без основы».
 *
 * Чёрная основа — дополнительный тёмный цвет, который лежит в коробке
 * цветных наборов. С ней тени и контур глубже, без неё картина мягче и
 * светлее. Выбор меняет только палитру генерации: детали основы из коробки
 * никуда не исчезают, а остальных цветов от отказа не становится больше.
 *
 * У наборов, где основы в коробке нет, выбирать нечего — компонент тогда
 * ничего не рисует.
 */
export function BaseColorChoice({ preset, withBase, onChange, compact, className }: BaseColorChoiceProps) {
  if (!baseColorIsOptional(preset)) return null;

  const tones = presetPaletteSize(preset, false);
  const baseHex = getPalette(preset.paletteId).colors.find((color) => color.id === BASE_COLOR_ID)?.hex ?? '#14161A';

  const options: { value: boolean; label: string; hint: string }[] = [
    { value: true, label: 'С основой', hint: `${tones} цветов + чёрная основа` },
    { value: false, label: 'Без основы', hint: `только ${tones} цветов набора` },
  ];

  if (compact) {
    return (
      <div
        className={cn('flex flex-wrap items-center gap-3 rounded-[18px] bg-card px-[18px] py-3', className)}
        data-base-choice="compact"
      >
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            aria-hidden
            className="h-4 w-4 rounded-[4px] shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)]"
            style={{ background: baseHex }}
          />
          Чёрная основа
        </span>
        <div className="flex rounded-xl bg-background p-[3px]" role="group" aria-label="Чёрная основа">
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              data-base={option.value ? 'on' : 'off'}
              aria-pressed={withBase === option.value}
              onClick={() => onChange(option.value)}
              className={cn(
                'rounded-[9px] px-3 py-1.5 text-[13px] font-extrabold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                withBase === option.value ? 'bg-ink text-background' : 'text-ink hover:bg-secondary',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className={cn('flex flex-col gap-3 rounded-3xl bg-card p-5', className)} data-base-choice="full">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-display text-[19px] font-extrabold leading-tight">
          <span
            aria-hidden
            className="h-[18px] w-[18px] rounded-[5px] shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)]"
            style={{ background: baseHex }}
          />
          Чёрная основа
        </h2>
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">
          Дополнительный тёмный цвет в коробке. С ним тени и контур глубже, без него картина мягче и светлее.
          Детали основы остаются в коробке в любом случае.
        </p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-2.5" role="group">
        {options.map((option) => {
          const active = withBase === option.value;
          return (
            <button
              key={String(option.value)}
              type="button"
              data-base={option.value ? 'on' : 'off'}
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={cn(
                'flex flex-col gap-0.5 rounded-[16px] bg-background p-3.5 text-left',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                active ? 'shadow-[inset_0_0_0_2px_#C8471F]' : 'shadow-[inset_0_0_0_2px_transparent] hover:bg-secondary',
              )}
            >
              <span className="font-extrabold">{option.label}</span>
              <span className="text-[13px] text-muted-foreground">{option.hint}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
