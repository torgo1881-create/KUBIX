'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Копирует готовый (внешний) canvas в canvas, которым владеет React.
 * Так результат генератора попадает в дерево без ручного appendChild.
 */
export function useMirroredCanvas(source: HTMLCanvasElement | null) {
  const ref = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const target = ref.current;
    if (!target || !source) return;
    target.width = source.width;
    target.height = source.height;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(source, 0, 0);
  }, [source]);

  return ref;
}

interface CanvasMirrorProps {
  source: HTMLCanvasElement | null;
  /** Для мозаики: не размывать ячейки при увеличении. */
  pixelated?: boolean;
  /** Без шахматки и рамки — когда подложку задаёт родитель. */
  bare?: boolean;
  className?: string;
  canvasClassName?: string;
  label?: string;
}

export function CanvasMirror({ source, pixelated, bare, className, canvasClassName, label }: CanvasMirrorProps) {
  const ref = useMirroredCanvas(source);
  return (
    <div
      className={cn(
        'relative overflow-hidden',
        !bare && 'checkerboard rounded-md border border-border',
        className,
      )}
    >
      <canvas
        ref={ref}
        className={cn('block h-auto w-full', canvasClassName)}
        style={pixelated ? { imageRendering: 'pixelated' } : undefined}
      />
      {label ? (
        <span className="pointer-events-none absolute left-2 top-2 rounded-sm bg-card/90 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider">
          {label}
        </span>
      ) : null}
    </div>
  );
}
