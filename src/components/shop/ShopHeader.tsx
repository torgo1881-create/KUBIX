'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

const LOGO_CELLS = [
  'bg-primary',
  'bg-ink',
  'bg-peach',
  'bg-ink',
  'bg-peach',
  'bg-primary',
  'bg-peach',
  'bg-primary',
  'bg-ink',
];

const NAV_LINKS = [
  { href: '#catalog', label: 'Каталог' },
  { href: '#how', label: 'Как это работает' },
  { href: '#gift', label: 'В подарок' },
  { href: '#faq', label: 'Вопросы' },
];

/** Логотип собран из квадратов — картинок в шапке нет. */
export function KubixLogo() {
  return (
    <span className="grid grid-cols-[repeat(3,7px)] gap-0.5" aria-hidden>
      {LOGO_CELLS.map((color, index) => (
        <span key={index} className={cn('size-[7px] rounded-sm', color)} />
      ))}
    </span>
  );
}

interface ShopHeaderProps {
  /** На лендинге видна навигация по разделам. */
  landing: boolean;
  cartCount: number;
  onHome: () => void;
  onUpload: () => void;
}

export function ShopHeader({ landing, cartCount, onHome, onUpload }: ShopHeaderProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
        <button
          type="button"
          onClick={onHome}
          aria-label="Kubix — на главную"
          className="flex items-center gap-2.5 rounded-md text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
        >
          <KubixLogo />
          <span className="font-display text-[22px] font-extrabold leading-none">kubix</span>
        </button>

        {landing ? (
          <nav className="flex flex-wrap items-center gap-x-[22px] gap-y-1 text-[15px] font-bold" aria-label="Разделы">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className="text-ink transition-colors hover:text-primary">
                {link.label}
              </a>
            ))}
          </nav>
        ) : null}

        <div className="ml-auto flex items-center gap-2.5">
          <button
            type="button"
            onClick={onUpload}
            data-action="upload"
            className="rounded-xl border-2 border-ink px-4 py-[7px] font-extrabold text-ink transition-colors hover:bg-ink hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Загрузить фото
          </button>
          <span
            className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 font-extrabold"
            aria-live="polite"
          >
            Корзина
            <span
              data-cart-count
              className={cn(
                'flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-xs text-white',
                cartCount > 0 ? 'bg-primary' : 'bg-[#B9B0A3]',
              )}
            >
              {cartCount}
            </span>
          </span>
        </div>
      </div>
    </header>
  );
}
