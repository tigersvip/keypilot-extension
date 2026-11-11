import jsQR from 'jsqr';

// Pixels never leave this page. Mask a decoded code to find others in the same image.
export function decodeQrPixels(pixels: ImageData, multiple = true): string[] {
  const data = new Uint8ClampedArray(pixels.data), found: string[] = [];
  for (let index = 0; index < 20; index++) {
    const code = jsQR(data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
    if (!code) break;
    if (!found.includes(code.data)) found.push(code.data);
    if (!multiple) return found;
    const corners = [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomLeftCorner, code.location.bottomRightCorner];
    const left = Math.max(0, Math.floor(Math.min(...corners.map(point => point.x))) - 2);
    const right = Math.min(pixels.width, Math.ceil(Math.max(...corners.map(point => point.x))) + 2);
    const top = Math.max(0, Math.floor(Math.min(...corners.map(point => point.y))) - 2);
    const bottom = Math.min(pixels.height, Math.ceil(Math.max(...corners.map(point => point.y))) + 2);
    for (let y = top; y < bottom; y++) data.fill(255, (y * pixels.width + left) * 4, (y * pixels.width + right) * 4);
  }
  // Aligned codes can confuse a single-code locator. Also inspect independent image regions.
  if (multiple) {
    const halfWidth = Math.floor(pixels.width / 2), halfHeight = Math.floor(pixels.height / 2);
    const regions = [
      [0, 0, halfWidth, pixels.height], [halfWidth, 0, pixels.width - halfWidth, pixels.height],
      [0, 0, pixels.width, halfHeight], [0, halfHeight, pixels.width, pixels.height - halfHeight],
      [0, 0, halfWidth, halfHeight], [halfWidth, 0, pixels.width - halfWidth, halfHeight],
      [0, halfHeight, halfWidth, pixels.height - halfHeight], [halfWidth, halfHeight, pixels.width - halfWidth, pixels.height - halfHeight]
    ];
    for (const [left, top, width, height] of regions) {
      if (width < 60 || height < 60) continue;
      const cropped = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) cropped.set(data.subarray(((top + y) * pixels.width + left) * 4, ((top + y) * pixels.width + left + width) * 4), y * width * 4);
      const code = jsQR(cropped, width, height, { inversionAttempts: 'attemptBoth' });
      if (code && !found.includes(code.data)) found.push(code.data);
    }
  }
  return found;
}

export function qrPixels(source: CanvasImageSource, width: number, height: number, maxEdge = 1800): ImageData {
  if (!width || !height || width * height > 50000000) throw new Error('图片尺寸过大或无效，请裁剪到二维码区域后重试。');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器无法读取图片，请换一张 PNG 或 JPG 图片。');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export async function readQrImage(file: File): Promise<string[]> {
  if (file.size > 10 * 1024 * 1024) throw new Error('每张二维码图片不能超过 10 MB。');
  if (!/^image\/(png|jpeg|webp|bmp)$/.test(file.type)) throw new Error('请选择 PNG、JPG、WebP 或 BMP 图片。');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('图片无法打开，请重新保存为 PNG 或 JPG。'); }
  try {
    let found = decodeQrPixels(qrPixels(bitmap, bitmap.width, bitmap.height));
    if (!found.length && Math.max(bitmap.width, bitmap.height) > 1800) found = decodeQrPixels(qrPixels(bitmap, bitmap.width, bitmap.height, 2800));
    if (!found.length) throw new Error('没有识别到二维码。请保留完整四角，裁剪掉多余背景后重试。');
    return found;
  } finally { bitmap.close(); }
}
