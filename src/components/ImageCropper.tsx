'use client';

import * as React from 'react';

import { Slider } from '@/components/ui/slider';
import { CROP_MAX_ZOOM } from '@/config/mosaic';
import { clamp } from '@/lib/utils';
import type { CropRect, SourceImage } from '@/types/mosaic';

export interface ImageCropperHandle {
  /** Область кадрирования в координатах исходного изображения. */
  getCropRect: () => CropRect;
  /** Кадрированное изображение как canvas — вход для генератора. */
  exportCanvas: (maxSize?: number) => HTMLCanvasElement;
  reset: () => void;
}

interface ImageCropperProps {
  image: SourceImage;
  /** Пропорции рамки: cols / rows. */
  aspect: number;
  onCropChange?: (crop: CropRect) => void;
  /**
   * Кадр, с которого начать: когда кроппер открывают повторно, фото встаёт
   * туда, где его оставили. Кадр других пропорций игнорируется.
   */
  initialCrop?: CropRect | null;
  /** Предел масштаба. По умолчанию CROP_MAX_ZOOM. */
  maxZoom?: number;
}

const FRAME_PADDING = 20;
const FRAME_STROKE = 3;
const EXPORT_MAX_SIZE = 2048;

interface View {
  zoom: number; // 1 = рамка заполнена целиком
  offsetX: number; // экранные координаты левого верхнего угла изображения
  offsetY: number;
}

export const ImageCropper = React.forwardRef<ImageCropperHandle, ImageCropperProps>(
  function ImageCropper({ image, aspect, onCropChange, initialCrop, maxZoom = CROP_MAX_ZOOM }, ref) {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    const [view, setView] = React.useState<View>({ zoom: 1, offsetX: 0, offsetY: 0 });
    const pointers = React.useRef(new Map<number, { x: number; y: number }>());
    const pinch = React.useRef<{ distance: number; zoom: number } | null>(null);
    const initialCropRef = React.useRef(initialCrop);
    initialCropRef.current = initialCrop;

    /* --- геометрия ------------------------------------------------------ */

    const frame = React.useMemo(() => {
      const availableWidth = Math.max(0, size.width - FRAME_PADDING * 2);
      const availableHeight = Math.max(0, size.height - FRAME_PADDING * 2);
      let width = availableWidth;
      let height = width / aspect;
      if (height > availableHeight) {
        height = availableHeight;
        width = height * aspect;
      }
      return {
        x: (size.width - width) / 2,
        y: (size.height - height) / 2,
        width,
        height,
      };
    }, [size.width, size.height, aspect]);

    const minScale = React.useMemo(() => {
      if (!frame.width || !frame.height) return 1;
      return Math.max(frame.width / image.width, frame.height / image.height);
    }, [frame.width, frame.height, image.width, image.height]);

    const clampView = React.useCallback(
      (next: View): View => {
        const zoom = clamp(next.zoom, 1, maxZoom);
        const scale = minScale * zoom;
        const drawnWidth = image.width * scale;
        const drawnHeight = image.height * scale;
        return {
          zoom,
          offsetX: clamp(next.offsetX, frame.x + frame.width - drawnWidth, frame.x),
          offsetY: clamp(next.offsetY, frame.y + frame.height - drawnHeight, frame.y),
        };
      },
      [frame.x, frame.y, frame.width, frame.height, image.width, image.height, maxZoom, minScale],
    );

    const centerView = React.useCallback((): View => {
      const scale = minScale;
      return {
        zoom: 1,
        offsetX: frame.x + (frame.width - image.width * scale) / 2,
        offsetY: frame.y + (frame.height - image.height * scale) / 2,
      };
    }, [frame.x, frame.y, frame.width, frame.height, image.width, image.height, minScale]);

    /** Вид, при котором в рамке оказывается заданный кадр. */
    const viewForCrop = React.useCallback(
      (crop: CropRect): View => {
        const scale = frame.width / crop.width;
        return clampView({
          zoom: scale / minScale,
          offsetX: frame.x - crop.x * scale,
          offsetY: frame.y - crop.y * scale,
        });
      },
      [clampView, frame.x, frame.y, frame.width, minScale],
    );

    const getCropRect = React.useCallback((): CropRect => {
      const scale = minScale * view.zoom;
      if (!scale || !frame.width) {
        return { x: 0, y: 0, width: image.width, height: image.height };
      }
      const x = clamp((frame.x - view.offsetX) / scale, 0, image.width);
      const y = clamp((frame.y - view.offsetY) / scale, 0, image.height);
      const width = clamp(frame.width / scale, 1, image.width - x);
      const height = clamp(frame.height / scale, 1, image.height - y);
      return { x, y, width, height };
    }, [frame.x, frame.y, frame.width, frame.height, image.width, image.height, minScale, view]);

    /* --- размеры контейнера --------------------------------------------- */

    React.useEffect(() => {
      const element = containerRef.current;
      if (!element) return;
      const update = () =>
        setSize({ width: element.clientWidth, height: element.clientHeight });
      update();
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }, []);

    // Новое фото или новые пропорции — центрируем заново, а если кадр уже
    // выбирали раньше, возвращаемся к нему.
    React.useEffect(() => {
      if (!frame.width || !frame.height) return;
      const saved = initialCropRef.current;
      const fits =
        saved &&
        saved.width > 0 &&
        saved.height > 0 &&
        Math.abs(saved.width / saved.height - aspect) < 0.02 &&
        saved.x + saved.width <= image.width + 1 &&
        saved.y + saved.height <= image.height + 1;
      setView(fits ? viewForCrop(saved) : centerView());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [image.url, aspect, frame.width, frame.height]);

    React.useEffect(() => {
      onCropChange?.(getCropRect());
    }, [getCropRect, onCropChange]);

    /* --- отрисовка ------------------------------------------------------- */

    React.useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !size.width || !size.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(size.width * dpr);
      canvas.height = Math.round(size.height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);

      const scale = minScale * view.zoom;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        image.element,
        view.offsetX,
        view.offsetY,
        image.width * scale,
        image.height * scale,
      );

      // Затемняем всё, что не попадёт в кадр.
      ctx.fillStyle = 'rgba(20, 48, 47, 0.6)';
      ctx.beginPath();
      ctx.rect(0, 0, size.width, size.height);
      ctx.rect(frame.x, frame.y, frame.width, frame.height);
      ctx.fill('evenodd');

      // Рамка кадра — акцентная, снаружи от картинки.
      ctx.strokeStyle = '#C8471F';
      ctx.lineWidth = FRAME_STROKE;
      ctx.lineJoin = 'round';
      ctx.strokeRect(
        frame.x - FRAME_STROKE / 2,
        frame.y - FRAME_STROKE / 2,
        frame.width + FRAME_STROKE,
        frame.height + FRAME_STROKE,
      );
    }, [image, view, frame, minScale, size.width, size.height]);

    /* --- взаимодействие --------------------------------------------------- */

    const zoomAt = React.useCallback(
      (nextZoom: number, anchorX: number, anchorY: number) => {
        setView((current) => {
          const zoom = clamp(nextZoom, 1, maxZoom);
          const ratio = zoom / current.zoom;
          return clampView({
            zoom,
            offsetX: anchorX - (anchorX - current.offsetX) * ratio,
            offsetY: anchorY - (anchorY - current.offsetY) * ratio,
          });
        });
      },
      [clampView],
    );

    const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
      (event.target as Element).setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    };

    const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const previous = pointers.current.get(event.pointerId);
      if (!previous) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      const points = [...pointers.current.values()];

      if (points.length >= 2) {
        const [a, b] = points;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const rect = canvasRef.current?.getBoundingClientRect();
        const anchorX = (a.x + b.x) / 2 - (rect?.left ?? 0);
        const anchorY = (a.y + b.y) / 2 - (rect?.top ?? 0);
        if (!pinch.current) {
          pinch.current = { distance, zoom: view.zoom };
        } else if (pinch.current.distance > 0) {
          zoomAt((pinch.current.zoom * distance) / pinch.current.distance, anchorX, anchorY);
        }
        return;
      }

      pinch.current = null;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      setView((current) =>
        clampView({ ...current, offsetX: current.offsetX + dx, offsetY: current.offsetY + dy }),
      );
    };

    const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
    };

    const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY / 400);
      zoomAt(view.zoom * factor, event.clientX - rect.left, event.clientY - rect.top);
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      const step = event.shiftKey ? 40 : 12;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [step, 0],
        ArrowRight: [-step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      };
      const move = moves[event.key];
      if (move) {
        event.preventDefault();
        setView((current) =>
          clampView({ ...current, offsetX: current.offsetX + move[0], offsetY: current.offsetY + move[1] }),
        );
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomAt(view.zoom * 1.15, frame.x + frame.width / 2, frame.y + frame.height / 2);
      }
      if (event.key === '-') {
        event.preventDefault();
        zoomAt(view.zoom / 1.15, frame.x + frame.width / 2, frame.y + frame.height / 2);
      }
    };

    /* --- императивный API ------------------------------------------------- */

    React.useImperativeHandle(
      ref,
      () => ({
        getCropRect,
        reset: () => setView(centerView()),
        exportCanvas: (maxSize = EXPORT_MAX_SIZE) => {
          const crop = getCropRect();
          const scale = Math.min(1, maxSize / Math.max(crop.width, crop.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(crop.width * scale));
          canvas.height = Math.max(1, Math.round(crop.height * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas 2D недоступен в этом браузере');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(
            image.element,
            crop.x,
            crop.y,
            crop.width,
            crop.height,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          return canvas;
        },
      }),
      [centerView, getCropRect, image.element],
    );

    const frameCenter: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];

    return (
      <div className="flex flex-col gap-3.5">
        <div
          ref={containerRef}
          className="relative h-[340px] w-full overflow-hidden rounded-[20px] bg-border sm:h-[460px]"
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="application"
            aria-label="Кадрирование: перетаскивай фото, колесо мыши меняет масштаб"
            style={{ width: size.width, height: size.height, touchAction: 'none' }}
            className="cursor-grab select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
          />
        </div>

        <div className="flex items-center gap-3.5 rounded-[14px] bg-card px-4 py-2.5">
          <span className="text-sm font-extrabold">Масштаб</span>
          <Slider
            value={[view.zoom]}
            min={1}
            max={maxZoom}
            step={0.01}
            aria-label="Масштаб"
            className="min-w-[120px] flex-1"
            onValueChange={([value]) => zoomAt(value, frameCenter[0], frameCenter[1])}
          />
          <span className="w-12 text-right text-sm font-extrabold tabular-nums" data-zoom-label>
            {Math.round(view.zoom * 100)}%
          </span>
        </div>
      </div>
    );
  },
);
