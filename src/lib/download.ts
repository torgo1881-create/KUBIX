import { OUTPUT_FILENAME_PREFIX } from '../config/mosaic';

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Браузер не смог собрать PNG из canvas.'));
    }, type);
  });
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Освобождаем чуть позже: Safari успевает начать скачивание.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function buildFilename(cols: number, rows: number, sourceName?: string, ext = 'png'): string {
  const base = (sourceName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stamp = new Date().toISOString().slice(0, 10);
  return [OUTPUT_FILENAME_PREFIX, base || null, `${cols}x${rows}`, stamp].filter(Boolean).join('-') + '.' + ext;
}

export async function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const blob = await canvasToBlob(canvas, 'image/png');
  saveBlob(blob, filename);
}

export function downloadText(text: string, filename: string, type = 'application/json'): void {
  saveBlob(new Blob([text], { type }), filename);
}
