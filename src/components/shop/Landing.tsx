'use client';

import * as React from 'react';

import { CanvasMirror } from '@/components/CanvasMirror';
import { MosaicView } from '@/components/MosaicView';
import { ProductCatalog, type PresetPreviews } from '@/components/ProductPicker';
import { useFileDrop } from '@/components/UploadDropzone';
import type { ProductPreset } from '@/config/productPresets';
import { SHOP_FAQ, SHOP_GIFT_CARDS, SHOP_HOW_IT_WORKS } from '@/config/shop';
import { clamp, cn } from '@/lib/utils';
import type { MosaicGrid } from '@/types/mosaic';

const CONTAINER = 'mx-auto max-w-[1240px] px-6';
const H2 = 'font-display text-[clamp(30px,3.8vw,48px)] font-extrabold leading-[1.05] tracking-[-0.02em]';
const HERO_ASPECT = 2 / 3;

interface LandingProps {
  /** Превью наборов; мозаика hero и примерки — превью набора по умолчанию. */
  previews: PresetPreviews;
  heroGrid: MosaicGrid | undefined;
  /** Фото, кадрированное под hero, — слой «до» в примерке. */
  heroPhoto: HTMLCanvasElement | null;
  /** Название набора, в котором показана примерка. */
  heroPresetName: string;
  photoName: string;
  uploading: boolean;
  onFile: (file: File) => void;
  onError: (message: string) => void;
  onBuy: (preset: ProductPreset) => void;
  onTry: (preset: ProductPreset) => void;
  /** «Попробовать бесплатно»: открыть генератор на загрузке фото. */
  onStart: () => void;
  onBoxCode: (code: string) => void;
}

export function Landing({
  previews,
  heroGrid,
  heroPhoto,
  heroPresetName,
  photoName,
  uploading,
  onFile,
  onError,
  onBuy,
  onTry,
  onStart,
  onBoxCode,
}: LandingProps) {
  return (
    <>
      {/* Hero */}
      <section
        className={cn(
          CONTAINER,
          'grid grid-cols-[repeat(auto-fit,minmax(min(100%,440px),1fr))] items-center gap-12 pb-[72px] pt-12',
        )}
      >
        <div className="flex flex-col gap-6">
          <span className="self-start rounded-full bg-mint px-3.5 py-1.5 text-[13px] font-extrabold">
            Фото-конструктор
          </span>
          <h1 className="font-display text-[clamp(40px,5.8vw,78px)] font-extrabold leading-none tracking-[-0.03em] [text-wrap:balance]">
            Собери любое фото <span className="text-primary">из деталей</span>
          </h1>
          <p className="max-w-[500px] text-[19px] text-muted-foreground [text-wrap:pretty]">
            Один набор — и любая фотография становится картиной для стены. Загрузи снимок, получи схему и
            собирай.
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href="#catalog"
              className="rounded-[14px] bg-primary px-7 py-4 text-[17px] font-extrabold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Выбрать набор
            </a>
            <button
              type="button"
              onClick={onStart}
              data-action="try-free"
              className="rounded-[14px] bg-card px-6 py-4 text-[17px] font-extrabold text-ink shadow-[inset_0_0_0_1px_#E2D9CC] transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Попробовать бесплатно
            </button>
          </div>
        </div>

        <div className="relative flex justify-center pb-[60px] pl-10">
          <div className="w-[min(100%,380px)] rotate-[1.5deg] rounded-3xl bg-ink p-4">
            <MosaicView grid={heroGrid} aspect={HERO_ASPECT} className="rounded-lg" label="Мозаика из фото" />
          </div>
          {/* Место под ролик о сборке: пока заглушка из дизайна. */}
          <div
            className="absolute bottom-0 left-0 flex aspect-[16/10] w-[min(62%,280px)] items-end rounded-[18px] border-4 border-background p-3.5 shadow-[0_20px_40px_-20px_rgba(20,48,47,.5)]"
            style={{ background: 'repeating-linear-gradient(135deg,#F6D5BF 0 10px,#F2C9A8 10px 20px)' }}
          >
            <span className="rounded-lg bg-ink px-2 py-1 font-mono text-xs text-background">
              видео: как собирается картина
            </span>
          </div>
        </div>
      </section>

      {/* Каталог */}
      <section id="catalog" className="scroll-mt-16 border-y border-border bg-card">
        <div className={cn(CONTAINER, 'flex flex-col gap-8 py-20')}>
          <div className="flex flex-wrap items-end justify-between gap-5">
            <h2 className={H2}>Какой формат выбрать?</h2>
            <span className="max-w-[380px] text-muted-foreground">
              Превью — это твоё фото в палитре каждого набора. Загрузи своё, и картинки обновятся.
            </span>
          </div>
          <ProductCatalog previews={previews} onBuy={onBuy} onTry={onTry} />
        </div>
      </section>

      {/* Как это работает */}
      <section id="how" className={cn(CONTAINER, 'flex scroll-mt-16 flex-col gap-8 py-20')}>
        <h2 className={H2}>Как это работает</h2>
        <ol className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
          {SHOP_HOW_IT_WORKS.map((item, index) => {
            const dark = index === SHOP_HOW_IT_WORKS.length - 1;
            return (
              <li
                key={item.title}
                className={cn(
                  'flex flex-col gap-3 rounded-[22px] p-[26px]',
                  dark ? 'bg-ink text-background' : 'bg-card',
                )}
              >
                <span
                  className={cn(
                    'font-display text-5xl font-extrabold leading-none',
                    dark ? 'text-peach' : 'text-primary',
                  )}
                >
                  {index + 1}
                </span>
                <strong className="text-xl font-extrabold">{item.title}</strong>
                <span className={dark ? 'text-on-ink' : 'text-muted-foreground'}>{item.text}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {/* Примерка до/после */}
      <section className="bg-ink text-background">
        <div
          className={cn(
            CONTAINER,
            'grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] items-center gap-12 py-20',
          )}
        >
          <div className="flex flex-col gap-5">
            <h2 className={H2}>Посмотри, как будет выглядеть твоя картина</h2>
            <p className="text-[17px] text-on-ink">
              Двигай линию: слева фото, справа оно же в деталях {heroPresetName}. Загрузи своё — всё считается
              прямо в браузере.
            </p>
            <TryOnDropzone photoName={photoName} uploading={uploading} onFile={onFile} onError={onError} />
          </div>
          <BeforeAfter photo={heroPhoto} grid={heroGrid} />
        </div>
      </section>

      {/* В подарок */}
      <section id="gift" className={cn(CONTAINER, 'flex scroll-mt-16 flex-col gap-8 py-20')}>
        <div className="flex max-w-[720px] flex-col gap-2.5">
          <h2 className={H2}>Не знаешь, что подарить?</h2>
          <p className="text-[17px] text-muted-foreground">
            Картина из общего фото — подарок, который собирают своими руками.
          </p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
          {SHOP_GIFT_CARDS.map((card) => (
            <div
              key={card.title}
              className={cn(
                'flex min-h-[200px] flex-col gap-2.5 rounded-[22px] p-7',
                card.tone === 'peach' ? 'bg-peach' : card.tone === 'mint' ? 'bg-mint' : 'bg-card',
              )}
            >
              <strong className="font-display text-[22px] font-extrabold leading-tight">{card.title}</strong>
              <span>{card.text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Вопросы */}
      <section id="faq" className="scroll-mt-16 border-y border-border bg-card">
        <div className="mx-auto flex max-w-[880px] flex-col gap-6 px-6 py-20">
          <h2 className={H2}>Вопросы</h2>
          <Faq />
        </div>
      </section>

      {/* Уже купил набор */}
      <section className={cn(CONTAINER, 'py-20')}>
        <BoxCodeBanner onSubmit={onBoxCode} />
      </section>

      <footer className="border-t border-border">
        <div className={cn(CONTAINER, 'flex flex-wrap justify-between gap-4 py-6 text-sm text-muted-foreground')}>
          <span className="font-display font-extrabold text-ink">kubix</span>
          <span>© 2026</span>
        </div>
      </footer>
    </>
  );
}

/** Зона загрузки на тёмной полосе примерки. */
function TryOnDropzone({
  photoName,
  uploading,
  onFile,
  onError,
}: Pick<LandingProps, 'photoName' | 'uploading' | 'onFile' | 'onError'>) {
  const { dragging, zoneProps, inputProps, open } = useFileDrop({ onFile, onError, disabled: uploading });

  return (
    <div
      {...zoneProps}
      onClick={open}
      data-dropzone="try-on"
      className={cn(
        'flex cursor-pointer flex-wrap items-center gap-4 rounded-[18px] border-2 border-dashed p-[22px] transition-colors',
        dragging ? 'border-primary bg-white/5' : 'border-[#4F7A76]',
        uploading && 'pointer-events-none opacity-60',
      )}
    >
      <input {...inputProps} onClick={(event) => event.stopPropagation()} />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        className="rounded-xl bg-primary px-5 py-3 font-extrabold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
      >
        {uploading ? 'Открываю…' : 'Загрузить файл'}
      </button>
      <span className="min-w-0 break-words text-sm text-on-ink">
        {dragging ? 'отпусти — файл примем' : `или перетащи фото сюда · ${photoName}`}
      </span>
    </div>
  );
}

/** Шторка «фото / мозаика»: линию можно тащить, ползунок под рамкой — для клавиатуры. */
function BeforeAfter({ photo, grid }: { photo: HTMLCanvasElement | null; grid: MosaicGrid | undefined }) {
  const [position, setPosition] = React.useState(50);
  const dragging = React.useRef(false);

  const moveTo = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) setPosition(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100));
  };

  return (
    <div className="flex flex-col items-center gap-3.5">
      <div
        data-compare
        className="relative aspect-[2/3] w-[min(100%,380px)] cursor-ew-resize touch-pan-y select-none overflow-hidden rounded-2xl bg-[#0E2322]"
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          moveTo(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) moveTo(event);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <MosaicView
          grid={grid}
          aspect={HERO_ASPECT}
         
          label="Мозаика"
          className="absolute inset-0 h-full w-full"
        />
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
          <CanvasMirror bare source={photo} className="h-full w-full" canvasClassName="h-full w-full object-cover" />
        </div>
        <div
          className="pointer-events-none absolute inset-y-0 -ml-[1.5px] w-[3px] bg-background"
          style={{ left: `${position}%` }}
        />
        <span className="pointer-events-none absolute left-2.5 top-2.5 rounded-lg bg-ink/85 px-2 py-[3px] text-xs font-extrabold text-background">
          фото
        </span>
        <span className="pointer-events-none absolute right-2.5 top-2.5 rounded-lg bg-primary px-2 py-[3px] text-xs font-extrabold text-white">
          мозаика
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(position)}
        onChange={(event) => setPosition(Number(event.target.value))}
        aria-label="Сравнение фото и мозаики"
        className="w-[min(100%,380px)]"
      />
    </div>
  );
}

/** Аккордеон: одновременно открыт один пункт, по умолчанию первый. */
function Faq() {
  const [open, setOpen] = React.useState(0);

  return (
    <div className="flex flex-col border-t border-border">
      {SHOP_FAQ.map((item, index) => {
        const expanded = open === index;
        return (
          <div key={item.question} className="border-b border-border">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`faq-answer-${index}`}
              onClick={() => setOpen(expanded ? -1 : index)}
              className="flex w-full items-center justify-between gap-4 py-5 text-left text-lg font-extrabold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.question}
              <span
                className="flex size-8 flex-none items-center justify-center rounded-[10px] bg-background text-xl text-primary"
                aria-hidden
              >
                {expanded ? '−' : '+'}
              </span>
            </button>
            {expanded ? (
              <p id={`faq-answer-${index}`} className="mb-5 max-w-[680px] text-muted-foreground">
                {item.answer}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function BoxCodeBanner({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [code, setCode] = React.useState('');

  return (
    <div className="flex flex-wrap items-center justify-between gap-6 rounded-[28px] bg-primary px-8 py-11 text-white">
      <div className="flex max-w-[520px] flex-col gap-2">
        <h2 className="font-display text-[clamp(26px,3vw,38px)] font-extrabold leading-[1.1]">Уже купил набор?</h2>
        <span>Введи код из коробки, загрузи фото и скачай инструкцию.</span>
      </div>
      <form
        className="flex max-w-[460px] flex-[1_1_320px] flex-wrap gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(code.trim());
        }}
      >
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Код из коробки"
          aria-label="Код из коробки"
          autoComplete="off"
          data-box-code
          className="min-w-0 flex-[1_1_180px] rounded-xl bg-card px-4 py-3.5 font-bold text-ink placeholder:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        />
        <button
          type="submit"
          className="rounded-xl bg-ink px-[22px] py-3.5 font-extrabold text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
        >
          Дальше →
        </button>
      </form>
    </div>
  );
}
