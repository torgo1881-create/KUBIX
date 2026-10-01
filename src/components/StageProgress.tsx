'use client';

import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { MosaicStage } from '@/types/mosaic';

const STEPS: { stage: MosaicStage; label: string }[] = [
  { stage: 'loading', label: 'Загрузка' },
  { stage: 'processing', label: 'Обработка' },
  { stage: 'generating', label: 'Генерация' },
  { stage: 'done', label: 'Готово' },
];

const ORDER: MosaicStage[] = ['idle', 'loading', 'processing', 'generating', 'done'];

interface StageProgressProps {
  stage: MosaicStage;
  value: number;
  message?: string;
  className?: string;
}

export function StageProgress({ stage, value, message, className }: StageProgressProps) {
  const currentIndex = ORDER.indexOf(stage);

  return (
    <div className={cn('space-y-2', className)}>
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {STEPS.map((step) => {
          const index = ORDER.indexOf(step.stage);
          const isDone = stage === 'error' ? false : currentIndex > index || stage === 'done';
          const isActive = stage === step.stage;
          return (
            <li
              key={step.stage}
              className={cn(
                'flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em]',
                isActive ? 'text-foreground' : isDone ? 'text-muted-foreground' : 'text-muted-foreground/50',
              )}
            >
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-full border',
                  isActive && 'border-primary bg-primary text-primary-foreground',
                  isDone && !isActive && 'border-border bg-secondary',
                  !isActive && !isDone && 'border-border',
                )}
                aria-hidden
              >
                {isDone && !isActive ? <Check className="size-2.5" /> : null}
              </span>
              {step.label}
            </li>
          );
        })}
      </ol>

      <div
        className="h-1 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-label={message ?? 'Прогресс'}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-200',
            stage === 'error' ? 'bg-destructive' : 'bg-primary',
          )}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
        />
      </div>

      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
