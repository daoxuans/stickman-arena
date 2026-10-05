export const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
export const AVATAR_SIZE = 192;

const PHOTO_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

export function cropAvatar(source, createCanvas = () => document.createElement('canvas')) {
  const width = Number(source?.naturalWidth || source?.videoWidth || source?.width);
  const height = Number(source?.naturalHeight || source?.videoHeight || source?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)
    || width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new Error('图片尺寸无效或过大，请选择边长不超过 8192 像素的照片。');
  }
  const canvas = createCanvas();
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法处理头像图片。');
  const side = Math.min(width, height);
  context.drawImage(source, (width - side) / 2, (height - side) / 2, side, side,
    0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return canvas;
}

export async function avatarFromFile(file, {
  ImageType = globalThis.Image,
  urlAPI = globalThis.URL,
  createCanvas,
} = {}) {
  if (!file || !PHOTO_TYPES.has(file.type)) {
    throw new Error('请选择 JPG、PNG、WebP 或浏览器支持的 HEIC 照片。');
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > AVATAR_MAX_BYTES) {
    throw new Error('照片不能超过 8 MB。');
  }
  if (typeof ImageType !== 'function' || typeof urlAPI?.createObjectURL !== 'function') {
    throw new Error('当前浏览器无法读取本地照片。');
  }
  const objectUrl = urlAPI.createObjectURL(file);
  try {
    const image = new ImageType();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('照片无法解码，请换一张 JPG、PNG 或 WebP 图片。'));
      image.src = objectUrl;
    });
    return cropAvatar(image, createCanvas);
  } finally {
    urlAPI.revokeObjectURL(objectUrl);
  }
}

export function avatarFromCamera(video, createCanvas) {
  if (!video?.videoWidth || !video?.videoHeight) {
    throw new Error('相机画面尚未准备好，请稍后再拍。');
  }
  return cropAvatar(video, createCanvas);
}
