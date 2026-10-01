import type { SourceImage } from '../types/mosaic';

/**
 * Пример фотографии для витрины, пока покупатель не загрузил свою.
 *
 * Портрет нарисован кодом — это заглушка из дизайн-прототипа. Когда появится
 * настоящий снимок-пример, достаточно заменить эту функцию загрузкой файла:
 * остальное приложение получает обычный SourceImage.
 */

const SAMPLE_WIDTH = 480;
const SAMPLE_HEIGHT = 720;

export const SAMPLE_PHOTO_NAME = 'пример фото';

function ellipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation = 0,
): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fill();
}

function drawSamplePortrait(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D недоступен в этом браузере');

  const backdrop = ctx.createLinearGradient(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  backdrop.addColorStop(0, '#dfe3e6');
  backdrop.addColorStop(1, '#6f7a84');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

  // Плечи, шея, волосы.
  ctx.filter = 'blur(16px)';
  ctx.fillStyle = '#26303b';
  ellipse(ctx, 240, 780, 260, 210);
  ctx.fillStyle = '#b98060';
  ctx.fillRect(196, 420, 88, 150);
  ctx.fillStyle = '#33241d';
  ellipse(ctx, 240, 300, 170, 215);

  // Лицо и чёлка.
  ctx.filter = 'blur(5px)';
  const skin = ctx.createRadialGradient(200, 280, 20, 240, 320, 175);
  skin.addColorStop(0, '#f6d4b4');
  skin.addColorStop(0.55, '#dba580');
  skin.addColorStop(1, '#9c6646');
  ctx.fillStyle = skin;
  ellipse(ctx, 240, 322, 112, 150);
  ctx.fillStyle = '#33241d';
  ellipse(ctx, 222, 190, 140, 66, -0.25);

  // Брови, глаза, нос, губы.
  ctx.filter = 'blur(2px)';
  ctx.fillStyle = '#4a3226';
  ellipse(ctx, 193, 278, 30, 7, -0.08);
  ellipse(ctx, 287, 278, 30, 7, 0.08);
  ctx.fillStyle = '#fbefe6';
  ellipse(ctx, 195, 308, 21, 10);
  ellipse(ctx, 285, 308, 21, 10);
  ctx.fillStyle = '#22160f';
  ellipse(ctx, 196, 308, 10, 10);
  ellipse(ctx, 284, 308, 10, 10);
  ctx.fillStyle = 'rgba(120,64,40,.4)';
  ellipse(ctx, 252, 362, 13, 32);
  ctx.fillStyle = '#a9564b';
  ellipse(ctx, 240, 414, 36, 12);
  ctx.filter = 'none';

  return canvas;
}

export function createSamplePhoto(): SourceImage {
  const element = drawSamplePortrait();
  return {
    file: new File([], 'sample.png', { type: 'image/png' }),
    url: '',
    element,
    width: element.width,
    height: element.height,
    sizeBytes: 0,
    type: 'image/png',
    name: SAMPLE_PHOTO_NAME,
  };
}
