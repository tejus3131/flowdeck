// Client-side avatar upload: the browser resizes the picture to a small
// square before sending (no 10 MB uploads), then puts it straight into the
// user's own folder in the public `avatars` bucket under the signed-in
// session — storage RLS keeps everyone to their own folder.
import { browserClient } from './supabase-client';

const MAX_INPUT_BYTES = 10 * 1024 * 1024; // reject anything huge up front
const AVATAR_SIZE = 256;

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image'))),
      'image/webp',
      0.85,
    );
  });
}

/** Center-crop to a square and downscale — keeps avatars small and crisp. */
async function resizeToSquare(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process that image');
    context.imageSmoothingQuality = 'high';
    const left = (bitmap.width - side) / 2;
    const top = (bitmap.height - side) / 2;
    context.drawImage(bitmap, left, top, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    return await toBlob(canvas);
  } finally {
    bitmap.close();
  }
}

/**
 * Upload `file` as the user's avatar. Returns the public URL (cache-busted
 * so a new picture never shows the stale one) — callers persist it through
 * setAvatarUrl().
 */
export async function uploadAvatar(userId: string, file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Pick an image file (PNG, JPG, WebP…)');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error('That image is too large (over 10 MB)');
  }

  const client = browserClient();
  if (!client) throw new Error('Uploads are unavailable in this build');

  const blob = await resizeToSquare(file);
  // One path per user; upsert replaces, and the ?v= cache-buster in the
  // stored URL keeps renders fresh.
  const path = `${userId}/avatar`;
  const { error } = await client.storage.from('avatars').upload(path, blob, {
    contentType: blob.type || 'image/webp',
    upsert: true,
  });
  if (error) throw new Error(error.message);

  const { data } = client.storage.from('avatars').getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}
