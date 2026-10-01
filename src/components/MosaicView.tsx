'use client';

import * as React from 'react';

import { renderMosaicToCanvas } from '@/algorithms/mosaicGenerator';
import { SHOP_MOSAIC_RENDER } from '@/config/shop';
import { cn } from '@/lib/utils';
import type { MosaicGrid } from '@/types/mosaic';

interface MosaicViewProps {
  /** Готовая сетка. Пока её нет, на месте мозаики мерцает заглушка. */
  grid: MosaicGrid | null | undefined;
  /** Пропорции заглушки, пока сетки нет: cols / rows. */
  aspect: number;
  className?: string;
  label?: string;
}

/** Плотнее трёх пикселей на точку экраны не бывают, а память canvas не бесконечна. */
const MAX_PIXEL_RATIO = 3;

/**
 * Мозаика так, как она выглядит на витрине: детали с зазором на тёмной
 * подложке. Рисует существующий рендерер — сетка цветов не меняется.
 *
 * Картинка рисуется под фактический размер на экране: если нарисовать
 * крупнее и дать браузеру уменьшить, зазоры между деталями дают муар.
 */
export function MosaicView({ grid, aspect, className, label }: MosaicViewProps) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const [box, setBox] = React.useState({ width: 0, height: 0 });

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const measure = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      setBox((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !grid || !box.width) return;
    // При object-contain мозаика занимает не всю коробку — берём вписанную ширину.
    const shownWidth = box.height ? Math.min(box.width, (box.height * grid.cols) / grid.rows) : box.width;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const cellSize = Math.max(2, Math.round((shownWidth * pixelRatio) / grid.cols));
    renderMosaicToCanvas(grid, { ...SHOP_MOSAIC_RENDER, cellSize }, canvas);
  }, [box, grid]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label ?? 'Мозаика'}
      aria-busy={!grid}
      data-ready={grid ? 'true' : 'false'}
      className={cn('block h-auto w-full', !grid && 'animate-pulse bg-on-ink/10', className)}
      style={{ aspectRatio: grid ? `${grid.cols} / ${grid.rows}` : String(aspect) }}
    />
  );
}
