'use client';

import * as React from 'react';

import {
  buildInstructionPlan,
  contrastInk,
  DEFAULT_BLOCK_SIZE,
} from '@/algorithms/instruction/blockGenerator';
import { MosaicView } from '@/components/MosaicView';
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
  /** Что собираем — строка слева в верхней панели: набор, размер, вариант. */
  summary?: React.ReactNode;
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
  summary,
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

  const lastStep = plan.blocks.length - 1;

  return (
    <div className="flex flex-col gap-4" data-testid="build-mode">
      {/* Сводка и управление */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] bg-card px-[18px] py-3">
        <span className="text-sm text-muted-foreground">
          {summary ?? `${plan.cols}×${plan.rows} · ${formatNumber(plan.totalPieces)} деталей`}
        </span>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex rounded-xl bg-background p-[3px]" role="group" aria-label="Размер блока">
            {BLOCK_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                data-block-size={size}
                aria-pressed={blockSize === size}
                onClick={() => setBlockSize(size)}
                className={cn(
                  'rounded-[9px] px-3 py-1.5 text-[13px] font-extrabold transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  blockSize === size ? 'bg-ink text-background' : 'text-ink hover:bg-secondary',
                )}
              >
                {size}×{size}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={downloadPdf}
            disabled={pdfBusy}
            data-action="download-pdf"
            className="rounded-xl bg-primary px-4 py-[9px] text-sm font-extrabold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {pdfBusy ? 'Собираю PDF…' : `Скачать PDF · ${countInstructionPages(plan)} стр.`}
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-4">
        {/* Схема блока */}
        <div className="flex min-w-0 flex-[2_1_440px] flex-col gap-3.5 rounded-3xl bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-display text-2xl font-extrabold leading-tight" data-step-label>
                Шаг {step + 1} из {plan.blocks.length}
              </div>
              <div className="text-sm text-muted-foreground">
                Блок {String(block.index + 1).padStart(2, '0')} · строка {block.row + 1}, столбец {block.column + 1}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                data-action="previous"
                aria-label="Предыдущий блок"
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                disabled={step === 0}
                className="rounded-xl bg-background px-4 py-[11px] font-extrabold transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                ←
              </button>
              <button
                type="button"
                data-action="next"
                onClick={() => setStep((current) => Math.min(lastStep, current + 1))}
                disabled={step >= lastStep}
                className="rounded-xl bg-ink px-[18px] py-[11px] font-extrabold text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-40"
              >
                Следующий блок →
              </button>
            </div>
          </div>

          <div
            className="h-2 w-full overflow-hidden rounded-lg bg-background"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={plan.blocks.length}
            aria-valuenow={step + 1}
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
          </div>

          {/* Увеличенная сетка блока */}
          <div
            className="grid max-w-[640px] gap-[3px] rounded-[10px] bg-ink p-1.5"
            style={{ gridTemplateColumns: `repeat(${block.width}, minmax(0, 1fr))` }}
            data-block={block.blockId}
          >
            {block.cells.map((cell, index) => (
              <div
                key={`${cell.x}-${cell.y}`}
                className="flex aspect-square items-center justify-center rounded-[3px] text-[clamp(9px,1.6vw,15px)] font-extrabold"
                style={{ background: cell.hex, color: contrastInk(cell.rgb) }}
                title={`${cell.hex} · ячейка ${cell.x + 1}, ${cell.y + 1}`}
                data-cell-number={block.numbers[index]}
              >
                {block.numbers[index]}
              </div>
            ))}
          </div>

          {/* Количества */}
          <ul className="flex flex-wrap gap-2" aria-label="Деталей в блоке" data-block-counts>
            {block.counts.map((count) => (
              <li
                key={count.hex}
                className="flex items-center gap-2 rounded-[10px] bg-background py-[5px] pl-[5px] pr-2.5 text-sm"
              >
                <span
                  className="size-5 rounded-[5px] shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)]"
                  style={{ background: count.hex }}
                  aria-hidden
                />
                <b>{count.number}</b>
                <span>{count.name}</span>
                <b className="text-primary">×{count.count}</b>
              </li>
            ))}
          </ul>
        </div>

        {/* Общая картина и легенда */}
        <aside className="flex flex-[1_1_240px] flex-col gap-4">
          <div className="rounded-[20px] bg-ink p-2.5">
            <div className="relative overflow-hidden rounded-md">
              <MosaicView grid={result.grid} aspect={plan.cols / plan.rows} label="Вся картина" />
              <div
                className="pointer-events-none absolute border-[3px] border-primary shadow-[0_0_0_9999px_rgba(20,48,47,0.55)]"
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

          <ul className="flex flex-col gap-0.5 rounded-[20px] bg-card px-[18px] py-3.5" data-legend>
            {plan.legend.map((entry) => (
              <li key={entry.hex} className="flex items-center gap-2.5 py-[5px] text-sm">
                <b className="w-4 shrink-0 text-muted-foreground">{entry.number}</b>
                <span
                  className="size-4 shrink-0 rounded shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)]"
                  style={{ background: entry.hex }}
                  aria-hidden
                />
                <span className="truncate">{entry.name}</span>
                <span className="ml-auto text-muted-foreground">{formatNumber(entry.total)}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
