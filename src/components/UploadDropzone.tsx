'use client';

import * as React from 'react';

import { ACCEPT_ATTRIBUTE, MAX_FILE_SIZE_BYTES } from '@/config/mosaic';
import { checkFile, pickFileFromDataTransfer } from '@/lib/imageFile';
import { cn, formatBytes } from '@/lib/utils';

interface FileDropOptions {
  onFile: (file: File) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

/**
 * Приём файла: выбор, перетаскивание и вставка из буфера обмена с одной и
 * той же проверкой. Разметку зоны задаёт вызывающий компонент.
 */
export function useFileDrop({ onFile, onError, disabled }: FileDropOptions) {
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

  const zoneProps = {
    onDragEnter: (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current += 1;
      if (!disabled) setDragging(true);
    },
    onDragOver: (event: React.DragEvent) => event.preventDefault(),
    onDragLeave: (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) setDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (disabled) return;
      accept(event.dataTransfer ? pickFileFromDataTransfer(event.dataTransfer) : null);
    },
  };

  const inputProps = {
    ref: inputRef,
    type: 'file' as const,
    accept: ACCEPT_ATTRIBUTE,
    className: 'sr-only',
    tabIndex: -1,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      accept(event.target.files?.[0] ?? null);
      event.target.value = '';
    },
  };

  return { dragging, zoneProps, inputProps, open: () => inputRef.current?.click() };
}

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
  const { dragging, zoneProps, inputProps, open } = useFileDrop({ onFile, onError, disabled });

  return (
    <div
      {...zoneProps}
      onClick={open}
      data-dropzone
      className={cn(
        'relative flex cursor-pointer flex-col items-center justify-center border-2 border-dashed bg-card text-center transition-colors',
        dragging ? 'border-primary' : 'border-[#C9BBA6]',
        disabled && 'pointer-events-none opacity-60',
        compact ? 'gap-2 rounded-2xl p-4' : 'min-h-[340px] gap-3.5 rounded-3xl px-6 py-10',
        className,
      )}
    >
      <input {...inputProps} onClick={(event) => event.stopPropagation()} />

      <p className={cn('font-display font-extrabold', compact ? 'text-base' : 'text-[26px] leading-tight')}>
        {dragging ? 'Отпусти — файл примем' : 'Перетащи фото сюда'}
      </p>
      <p className={cn('text-muted-foreground', compact && 'text-sm')}>
        JPG, PNG или WEBP, до {formatBytes(MAX_FILE_SIZE_BYTES)}
      </p>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        className={cn(
          'rounded-xl bg-primary font-extrabold text-primary-foreground transition-colors hover:bg-primary-hover',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          compact ? 'px-4 py-2 text-sm' : 'px-[22px] py-3',
        )}
      >
        Выбрать файл
      </button>
    </div>
  );
}
