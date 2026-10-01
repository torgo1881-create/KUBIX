'use client';

import { ImageDown, Upload } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { ACCEPT_ATTRIBUTE, MAX_FILE_SIZE_BYTES } from '@/config/mosaic';
import { checkFile, pickFileFromDataTransfer } from '@/lib/imageFile';
import { cn, formatBytes } from '@/lib/utils';

interface UploadDropzoneProps {
  onFile: (file: File) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}

export function UploadDropzone({
  onFile,
  onError,
  disabled,
  compact = false,
  className,
}: UploadDropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const dragDepth = React.useRef(0);

  const accept = React.useCallback(
    (file: File | null) => {
      if (!file) {
        onError('В этом перетаскивании нет файла.');
        return;
      }
      const check = checkFile(file);
      if (!check.ok) {
        onError(check.error ?? 'Файл не подходит.');
        return;
      }
      onFile(file);
    },
    [onError, onFile],
  );

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;
    accept(event.dataTransfer ? pickFileFromDataTransfer(event.dataTransfer) : null);
  };

  // Вставка из буфера обмена — бесплатный бонус того же пути загрузки.
  React.useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (disabled || !event.clipboardData) return;
      const file = Array.from(event.clipboardData.files)[0];
      if (file) accept(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [accept, disabled]);

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        if (!disabled) setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={handleDrop}
      className={cn(
        'relative rounded-lg border border-dashed border-border bg-card/60 transition-colors',
        dragging && 'border-primary bg-primary/5',
        disabled && 'pointer-events-none opacity-60',
        compact ? 'p-4' : 'p-10 sm:p-16',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        onChange={(event) => {
          accept(event.target.files?.[0] ?? null);
          event.target.value = '';
        }}
      />

      <div className={cn('flex flex-col items-center text-center', compact ? 'gap-2' : 'gap-4')}>
        <div
          className={cn(
            'flex items-center justify-center rounded-md border border-border bg-background text-muted-foreground',
            compact ? 'h-8 w-8' : 'h-12 w-12',
          )}
          aria-hidden
        >
          {dragging ? <ImageDown className="size-5" /> : <Upload className="size-5" />}
        </div>

        <div className="space-y-1">
          <p className={cn('font-medium', compact ? 'text-sm' : 'text-base')}>
            {dragging ? 'Отпустите — файл примем' : 'Перетащите фотографию сюда'}
          </p>
          <p className="text-sm text-muted-foreground">
            JPG, JPEG, PNG или WEBP, до {formatBytes(MAX_FILE_SIZE_BYTES)}
          </p>
        </div>

        <Button
          type="button"
          variant={compact ? 'outline' : 'default'}
          size={compact ? 'sm' : 'default'}
          onClick={() => inputRef.current?.click()}
        >
          Выбрать файл
        </Button>
      </div>
    </div>
  );
}
