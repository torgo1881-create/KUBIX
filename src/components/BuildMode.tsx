'use client';

import { ChevronLeft, ChevronRight, FileDown } from 'lucide-react';
import * as React from 'react';

import {
  buildInstructionPlan,
  contrastInk,
  DEFAULT_BLOCK_SIZE,
} from '@/algorithms/instruction/blockGenerator';
import { CanvasMirror } from '@/components/CanvasMirror';
import { Button } from '@/components/ui/button';
import { buildFilename, saveBlob } from '@/lib/download';
import {
  buildInstructionPdf,
  canvasToJpeg,
  countInstructionPages,
  loadPdfFont,
} from '@/services/pdfGenerator';
import { cn, formatNumber } from '@/lib/utils';
import type { MosaicResult } from '@/types/mosaic';
import type { Palette } from '@/types/palette';

interface BuildModeProps {
  result: MosaicResult;
  /** Кадрированная фотография — попадёт в PDF как «оригинал». */
  original: HTMLCanvasElement | null;
  palette: Palette | null;
  paletteLabel?: string;
  modeLabel?: string;
  photoName?: string;
  qualityScore?: number | null;
}

const BLOCK_SIZES = [4, 8, 16];

/**
 * Build Mode: мозаика разбита на блоки, по ним можно идти шаг за шагом.
 * Алгоритм генерации не трогается — берётся уже готовая сетка.
 */
export function BuildMode({
  result,
  original,
  palette,
  paletteLabel,
  modeLabel,
  photoName,
  qualityScore,
}: BuildModeProps) {
  const [blockSize, setBlockSize] = React.useState(DEFAULT_BLOCK_SIZE);
  const [step, setStep] = React.useState(0);
  const [pdfBusy, setPdfBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const plan = React.useMemo(
    () => buildInstructionPlan(result.grid, { blockSize, palette }),
    [blockSize, palette, result.grid],
  );

  React.useEffect(() => {
    setStep(0);
  }, [plan]);

  const block = plan.blocks[Math.min(step, plan.blocks.length - 1)];
  const progress = ((step + 1) / plan.blocks.length) * 100;

  const downloadPdf = React.useCallback(async () => {
    setPdfBusy(true);
    setError(null);
    try {
      const font = await loadPdfFont();
      const [mosaicJpeg, originalJpeg] = await Promise.all([
        canvasToJpeg(result.canvas),
        original ? canvasToJpeg(original) : Promise.resolve(null),
      ]);

      const bytes = buildInstructionPdf({
        plan,
        font,
        mosaic: mosaicJpeg,
        original: originalJpeg,
        usage: result.palette?.usage,
        requirements: result.pieceLimit?.requirements,
        meta: {
          title: 'Инструкция по сборке',
          photoName,
          paletteLabel,
          modeLabel,
          qualityScore: qualityScore ?? null,
          createdAt: new Date(),
        },
      });

      saveBlob(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }),
        buildFilename(plan.cols, plan.rows, photoName, 'pdf'),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось собрать PDF.');
    } finally {
      setPdfBusy(false);
    }
  }, [modeLabel, original, paletteLabel, photoName, plan, qualityScore, result]);

  return (
    <div className="space-y-4" data-testid="build-mode">
      {/* Управление */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="eyebrow">Блок</span>
          <div className="flex rounded-md border border-border p-0.5">
            {BLOCK_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                data-block-size={size}
                aria-pressed={blockSize === size}
                onClick={() => setBlockSize(size)}
                className={cn(
                  'rounded-[3px] px-2 py-1 font-mono text-xs transition-colors',
                  blockSize === size ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {size}×{size}
              </button>
            ))}
          </div>
        </div>

        <Button variant="outline" size="sm" onClick={downloadPdf} disabled={pdfBusy}>
          <FileDown />
          {pdfBusy ? 'Собираю PDF…' : `Скачать PDF (${countInstructionPages(plan)} стр.)`}
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        {/* Схема блока */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="block font-mono text-sm" data-step-label>
                Шаг {step + 1} / {plan.blocks.length}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {block.blockId} · строка {block.row + 1}, столбец {block.column + 1}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-action="previous"
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                disabled={step === 0}
              >
                <ChevronLeft />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-action="next"
                onClick={() => setStep((current) => Math.min(plan.blocks.length - 1, current + 1))}
                disabled={step >= plan.blocks.length - 1}
              >
                Next
                <ChevronRight />
              </Button>
            </div>
          </div>

          <div
            className="h-1 w-full overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={plan.blocks.length}
            aria-valuenow={step + 1}
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
          </div>

          {/* Увеличенная сетка блока */}
          <div
            className="grid gap-[2px] rounded-md border border-border bg-border p-[2px]"
            style={{ gridTemplateColumns: `repeat(${block.width}, minmax(0, 1fr))` }}
            data-block={block.blockId}
          >
            {block.cells.map((cell, index) => (
              <div
                key={`${cell.x}-${cell.y}`}
                className="flex aspect-square items-center justify-center font-mono text-[clamp(9px,2.2vw,16px)]"
                style={{ background: cell.hex, color: contrastInk(cell.rgb) }}
                title={`${cell.hex} · ячейка ${cell.x + 1}, ${cell.y + 1}`}
                data-cell-number={block.numbers[index]}
              >
                {block.numbers[index]}
              </div>
            ))}
          </div>

          {/* Количества */}
          <div className="space-y-1.5">
            <span className="eyebrow">Деталей в блоке</span>
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5" data-block-counts>
              {block.counts.map((count) => (
                <li key={count.hex} className="flex items-center gap-1.5 text-[12px]">
                  <span
                    className="inline-block size-3.5 rounded-[2px] border border-border"
                    style={{ background: count.hex }}
                    aria-hidden
                  />
                  <span className="font-mono">{count.number}</span>
                  <span>{count.name}</span>
                  <span className="font-mono text-muted-foreground">×{count.count}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Общая картина и легенда */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="eyebrow">Где мы находимся</span>
            <div className="relative overflow-hidden rounded-md">
              <CanvasMirror source={result.canvas} pixelated />
              <div
                className="pointer-events-none absolute border-2 border-primary shadow-[0_0_0_9999px_rgba(238,239,242,0.55)]"
                data-highlight
                style={{
                  left: `${(block.x / plan.cols) * 100}%`,
                  top: `${(block.y / plan.rows) * 100}%`,
                  width: `${(block.width / plan.cols) * 100}%`,
                  height: `${(block.height / plan.rows) * 100}%`,
                }}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="eyebrow">Легенда</span>
            <ul className="space-y-1" data-legend>
              {plan.legend.map((entry) => (
                <li key={entry.hex} className="flex items-center gap-2 text-[12px]">
                  <span className="w-4 shrink-0 font-mono text-muted-foreground">{entry.number}</span>
                  <span
                    className="inline-block size-3.5 shrink-0 rounded-[2px] border border-border"
                    style={{ background: entry.hex }}
                    aria-hidden
                  />
                  <span className="truncate">{entry.name}</span>
                  <span className="ml-auto font-mono text-muted-foreground">{formatNumber(entry.total)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
