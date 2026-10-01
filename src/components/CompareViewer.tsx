'use client';

import { Move, ZoomIn, ZoomOut } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { VIEW_MAX_ZOOM, VIEW_MIN_ZOOM } from '@/config/mosaic';
import { getCell } from '@/algorithms/gridAverage';
import { useMirroredCanvas } from '@/components/CanvasMirror';
import { clamp } from '@/lib/utils';
import type { MosaicCell, MosaicGrid } from '@/types/mosaic';

interface CompareViewerProps {
  original: HTMLCanvasElement;
  mosaic: HTMLCanvasElement;
  grid: MosaicGrid;
}

export function CompareViewer({ original, mosaic, grid }: CompareViewerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const originalRef = useMirroredCanvas(original);
  const mosaicRef = useMirroredCanvas(mosaic);

  const [split, setSplit] = React.useState(50);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [hovered, setHovered] = React.useState<MosaicCell | null>(null);
  const drag = React.useRef<{ x: number; y: number } | null>(null);
  const splitDrag = React.useRef(false);

  const clampPan = React.useCallback((next: { x: number; y: number }, z: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return next;
    return {
      x: clamp(next.x, rect.width * (1 - z), 0),
      y: clamp(next.y, rect.height * (1 - z), 0),
    };
  }, []);

  const zoomAt = React.useCallback(
    (nextZoom: number, anchorX: number, anchorY: number) => {
      const z = clamp(nextZoom, VIEW_MIN_ZOOM, VIEW_MAX_ZOOM);
      setPan((current) => {
        const ratio = z / zoom;
        return clampPan(
          { x: anchorX - (anchorX - current.x) * ratio, y: anchorY - (anchorY - current.y) * ratio },
          z,
        );
      });
      setZoom(z);
    },
    [clampPan, zoom],
  );

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const updateHovered = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = (clientX - rect.left - pan.x) / zoom;
    const localY = (clientY - rect.top - pan.y) / zoom;
    const gx = Math.floor((localX / rect.width) * grid.cols);
    const gy = Math.floor((localY / rect.height) * grid.rows);
    setHovered(getCell(grid, gx, gy) ?? null);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    if (splitDrag.current) return;
    drag.current = { x: event.clientX - pan.x, y: event.clientY - pan.y };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (splitDrag.current && rect) {
      setSplit(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100));
      return;
    }
    if (drag.current) {
      setPan(clampPan({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }, zoom));
      return;
    }
    updateHovered(event.clientX, event.clientY);
  };

  const endPointer = () => {
    drag.current = null;
    splitDrag.current = false;
  };

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  return (
    <div className="space-y-3">
      <div
        ref={containerRef}
        className="checkerboard relative w-full select-none overflow-hidden rounded-md border border-border"
        style={{ aspectRatio: `${grid.cols} / ${grid.rows}`, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={() => {
          endPointer();
          setHovered(null);
        }}
        onWheel={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          zoomAt(
            zoom * Math.exp(-event.deltaY / 400),
            event.clientX - rect.left,
            event.clientY - rect.top,
          );
        }}
      >
        {/* Оригинал */}
        <div className="absolute inset-0" style={{ transform, transformOrigin: '0 0' }}>
          <canvas ref={originalRef} className="h-full w-full" />
        </div>

        {/* Мозаика — обрезается в экранных координатах, поэтому шторка не «уезжает» при зуме */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
          <div className="absolute inset-0" style={{ transform, transformOrigin: '0 0' }}>
            <canvas
              ref={mosaicRef}
              className="h-full w-full"
              style={{ imageRendering: 'pixelated' }}
            />
          </div>
        </div>

        {/* Шторка */}
        <div
          className="absolute inset-y-0 w-px bg-foreground/70"
          style={{ left: `${split}%` }}
          aria-hidden
        />
        <button
          type="button"
          aria-label="Передвинуть шторку сравнения"
          className="absolute top-1/2 z-10 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-border bg-card shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ left: `${split}%` }}
          onPointerDown={(event) => {
            event.stopPropagation();
            splitDrag.current = true;
            (event.currentTarget.parentElement as Element).setPointerCapture?.(event.pointerId);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setSplit((s) => clamp(s - 2, 0, 100));
            if (event.key === 'ArrowRight') setSplit((s) => clamp(s + 2, 0, 100));
          }}
        >
          <Move className="size-3.5 text-muted-foreground" />
        </button>

        <span className="pointer-events-none absolute left-2 top-2 rounded-sm bg-card/90 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider">
          Original
        </span>
        <span className="pointer-events-none absolute right-2 top-2 rounded-sm bg-card/90 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider">
          Mosaic
        </span>

        {/* Инспектор ячейки — сетка отдаёт свои настоящие данные */}
        {hovered && (
          <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-2 rounded-sm border border-border bg-card/95 px-2 py-1 font-mono text-[11px]">
            <span
              className="inline-block size-4 rounded-[2px] border border-border"
              style={{ background: hovered.hex }}
            />
            <span>
              x{hovered.x} y{hovered.y}
            </span>
            <span className="text-muted-foreground">{hovered.hex}</span>
            <span className="text-muted-foreground">rgb({hovered.rgb.join(', ')})</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="eyebrow shrink-0">Шторка</span>
        <Slider
          value={[split]}
          min={0}
          max={100}
          step={0.5}
          aria-label="Положение шторки сравнения"
          className="min-w-[120px] flex-1"
          onValueChange={([value]) => setSplit(value)}
        />

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Отдалить"
            onClick={() => {
              const rect = containerRef.current?.getBoundingClientRect();
              zoomAt(zoom / 1.4, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
            }}
          >
            <ZoomOut />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Приблизить"
            onClick={() => {
              const rect = containerRef.current?.getBoundingClientRect();
              zoomAt(zoom * 1.4, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
            }}
          >
            <ZoomIn />
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={resetView} disabled={zoom === 1}>
            {zoom.toFixed(1)}×
          </Button>
        </div>
      </div>
    </div>
  );
}
