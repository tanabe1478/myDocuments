import { averageColor } from './canvas';
import type { Rgb } from './contrast';

/** 平均色を求めるときの縮小サイズ（一辺）。 */
const SAMPLE_SIZE = 32;

/** 画像を縮小して平均色を求める。デコードできなければ例外。ブラウザ（Canvas）が要る。 */
export async function measureAverageColor(blob: Blob): Promise<Rgb> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2d context is not available');
    ctx.drawImage(bitmap, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return averageColor(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
  } finally {
    bitmap.close();
  }
}
