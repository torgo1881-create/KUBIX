'use client';

import * as React from 'react';

import type { Variant } from '@/algorithms/variants/variantGenerator';
import { BuildMode } from '@/components/BuildMode';
import { CanvasMirror } from '@/components/CanvasMirror';
import { ImageCropper } from '@/components/ImageCropper';
import { MosaicView } from '@/components/MosaicView';
import { ProductPicker, type PresetPreviews } from '@/components/ProductPicker';
import { UploadDropzone } from '@/components/UploadDropzone';
import { VariantCardList } from '@/components/VariantCards';
import { buildPresetPalette, getPaletteLabel, presetPaletteSize } from '@/config/paletteData';
import { describePreset, presetAspect, type ProductPreset } from '@/config/productPresets';
import { SHOP_CROP_MAX_ZOOM, SHOP_STEPS } from '@/config/shop';
import type { VariantPreset } from '@/config/variants';
import { describeCapacity } from '@/lib/capacity';
import { cn, formatNumber } from '@/lib/utils';
import type { CropRect, MosaicGrid, SourceImage } from '@/types/mosaic';

interface GeneratorProps {
  /** Текущий шаг, 1–5. */
  step: number;
  onStep: (step: number) => void;

  product: ProductPreset;
  previews: PresetPreviews;
  onSelectPreset: (preset: ProductPreset) => void;

  /** Загруженное фото; null — пока готовится пример. */
  image: SourceImage | null;
  thumbnail: HTMLCanvasElement | null;
  uploading: boolean;
  onFile: (file: File) => void;
  onError: (message: string) => void;

  /** Текущий кадр в координатах фото и его вырезка — вход генератора. */
  crop: CropRect | null;
  cropped: HTMLCanvasElement | null;
  onCropChange: (crop: CropRect) => void;

  /** Лента вариантов набора и то, что уже посчитано для текущего кадра. */
  lineup: VariantPreset[];
  variants: ReadonlyMap<string, Variant>;
  variantId: string;
  bestVariantId: string | null;
  onSelectVariant: (id: string) => void;
}

/**
 * Пять шагов: Набор → Фото → Кадр → Вариант → Сборка. Компонент только
 * показывает шаги — состояние и расчёты живут выше, поэтому переход между
 * шагами ничего не теряет.
 */
export function Generator(props: GeneratorProps) {
  const { step, onStep, product, lineup, variants, variantId } = props;
  const meta = SHOP_STEPS[step - 1];
  const aspect = presetAspect(product);
  const card = describePreset(product, presetPaletteSize(product));
  const preset = lineup.find((item) => item.id === variantId) ?? lineup[0];
  const variant = variants.get(variantId);

  // Пока новый кадр считается, на экране остаётся прошлая мозаика той же сетки.
  const lastGrid = React.useRef<MosaicGrid | null>(null);
  if (variant) lastGrid.current = variant.mosaic.grid;
  const previewGrid =
    variant?.mosaic.grid ??
    (lastGrid.current?.cols === product.width && lastGrid.current.rows === product.height
      ? lastGrid.current
      : null);

  const palette = React.useMemo(() => buildPresetPalette(product), [product]);

  // На узком экране ряд шагов прокручивается — текущий шаг держим в поле зрения.
  const stepsRef = React.useRef<HTMLOListElement>(null);
  React.useEffect(() => {
    const list = stepsRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !current) return;
    list.scrollTo({ left: current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2 });
  }, [step]);

  return (
    <>
      <main className="mx-auto flex w-full max-w-[1240px] flex-1 flex-col gap-7 px-6 pb-[130px] pt-6" data-step={step}>
        <ol
          ref={stepsRef}
          className="relative flex gap-1.5 overflow-x-auto rounded-2xl bg-card p-1.5"
          aria-label="Шаги генератора"
        >
          {SHOP_STEPS.map((item, index) => {
            const number = index + 1;
            const state = number === step ? 'current' : number < step ? 'done' : 'todo';
            return (
              <li key={item.label} className="flex-[1_0_auto]">
                <button
                  type="button"
                  data-step-button={number}
                  aria-current={state === 'current' ? 'step' : undefined}
                  onClick={() => onStep(number)}
                  className={cn(
                    'flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-[11px] px-3.5 py-2.5 text-sm font-extrabold transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    state === 'current' && 'bg-primary text-white',
                    state === 'done' && 'bg-mint text-ink',
                    state === 'todo' && 'text-muted-foreground hover:bg-secondary',
                  )}
                >
                  <span className="font-display">{number}</span>
                  {item.label}
                </button>
              </li>
            );
          })}
        </ol>

        <div className="flex max-w-[760px] flex-col gap-2">
          <h1 className="font-display text-[clamp(30px,4.2vw,52px)] font-extrabold leading-[1.05] tracking-[-0.02em]">
            {meta.title}
          </h1>
          <p className="text-[17px] text-muted-foreground [text-wrap:pretty]">{meta.subtitle}</p>
        </div>

        {step === 1 ? (
          <ProductPicker selectedId={product.id} onSelect={props.onSelectPreset} previews={props.previews} />
        ) : null}

        {step === 2 ? (
          <div className="flex flex-wrap items-stretch gap-4">
            <UploadDropzone
              className="flex-[2_1_420px]"
              onFile={props.onFile}
              onError={props.onError}
              disabled={props.uploading}
            />
            <div className="flex flex-[1_1_260px] flex-col gap-3 rounded-3xl bg-card p-5">
              <span className="text-sm font-extrabold text-muted-foreground">Сейчас загружено</span>
              <CanvasMirror
                bare
                source={props.thumbnail}
                className="h-60 rounded-[14px] bg-background"
                canvasClassName="h-full w-full object-contain"
              />
              <span className="truncate text-sm" title={props.image?.name}>
                {props.uploading ? 'Открываю файл…' : (props.image?.name ?? '')}
              </span>
              <button
                type="button"
                onClick={() => onStep(3)}
                disabled={!props.image || props.uploading}
                data-action="use-photo"
                className="rounded-xl bg-ink px-4 py-3 font-extrabold text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
              >
                Продолжить с этим фото
              </button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-start gap-6">
            {props.image ? (
              <ImageCropper
                image={props.image}
                aspect={aspect}
                initialCrop={props.crop}
                maxZoom={SHOP_CROP_MAX_ZOOM}
                onCropChange={props.onCropChange}
              />
            ) : (
              <div className="h-[340px] animate-pulse rounded-[20px] bg-border sm:h-[460px]" />
            )}
            <div className="flex flex-col gap-3 rounded-3xl bg-ink p-4">
              <MosaicView grid={previewGrid} aspect={aspect} className="rounded-lg" label="Превью мозаики" />
              <span className="px-1 text-sm text-on-ink">
                Превью · <b className="text-background">{preset.name}</b> · {card.name} · {card.size}
              </span>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <VariantCardList
            presets={lineup}
            variants={variants}
            aspect={aspect}
            bestId={props.bestVariantId}
            selectedId={variantId}
            onSelect={props.onSelectVariant}
          />
        ) : null}

        {step === 5 ? (
          variant ? (
            <div className="flex flex-col gap-4">
              <CapacityNotice product={product} variant={variant} />
              <BuildMode
                result={variant.mosaic}
                original={props.cropped}
                palette={palette}
                paletteLabel={getPaletteLabel(product.paletteId)}
                modeLabel={variant.name}
                photoName={props.image?.name}
                qualityScore={variant.qualityScore.total}
                summary={
                  <>
                    <b className="text-ink">{card.name}</b> · {card.size} · {variant.name} ·{' '}
                    {formatNumber(card.cells)} деталей
                  </>
                }
              />
            </div>
          ) : (
            <div className="flex min-h-[240px] items-center justify-center rounded-3xl bg-card p-8 text-muted-foreground">
              Считаю схему сборки…
            </div>
          )
        ) : null}
      </main>

      <div className="sticky bottom-0 z-[15] border-t border-border bg-background/[0.94] backdrop-blur-[10px]">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-3 px-6 py-3">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => onStep(step - 1)}
              data-action="back"
              className="rounded-xl bg-card px-5 py-3 font-extrabold text-ink shadow-[inset_0_0_0_1px_#E2D9CC] transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ← Назад
            </button>
          ) : null}
          <span className="flex-1" />
          {meta.next ? (
            <button
              type="button"
              onClick={() => onStep(step + 1)}
              data-action="forward"
              className="rounded-xl bg-primary px-6 py-[13px] font-extrabold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {meta.next} →
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** Предупреждение, если деталей набора на эту фотографию хватает впритык или не хватает. */
function CapacityNotice({ product, variant }: { product: ProductPreset; variant: Variant }) {
  const capacity = describeCapacity(product, variant.mosaic.pieceLimit);
  if (capacity.level !== 'insufficient' && capacity.level !== 'tight') return null;

  return (
    <div role="status" data-capacity={capacity.level} className="rounded-[18px] bg-peach px-[18px] py-3">
      <p className="font-extrabold">{capacity.title}</p>
      <p className="text-sm">{capacity.detail}</p>
    </div>
  );
}
