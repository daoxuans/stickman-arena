import test from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_MAX_BYTES, AVATAR_SIZE, avatarFromCamera, avatarFromFile, cropAvatar } from '../public/avatar.js';

function canvasRecorder() {
  const calls = [];
  const createCanvas = () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage: (...args) => calls.push(args) }),
  });
  return { calls, createCanvas };
}

test('a landscape or portrait photograph is cropped at the center and reduced to a small square', () => {
  const { calls, createCanvas } = canvasRecorder();
  const landscape = { naturalWidth: 1600, naturalHeight: 900 };
  const avatar = cropAvatar(landscape, createCanvas);
  assert.equal(avatar.width, AVATAR_SIZE);
  assert.equal(avatar.height, AVATAR_SIZE);
  assert.deepEqual(calls[0], [landscape, 350, 0, 900, 900, 0, 0, 192, 192]);
  const portrait = { naturalWidth: 900, naturalHeight: 1600 };
  cropAvatar(portrait, createCanvas);
  assert.deepEqual(calls[1], [portrait, 0, 350, 900, 900, 0, 0, 192, 192]);
  assert.throws(() => cropAvatar({ width: 9000, height: 9000 }, createCanvas), /过大/);
  assert.throws(() => cropAvatar({ width: 0, height: 900 }, createCanvas), /无效/);
});

test('file photos are validated, decoded locally and their temporary object URL is always revoked', async () => {
  const { calls, createCanvas } = canvasRecorder();
  const revoked = [];
  const urlAPI = {
    createObjectURL: () => 'blob:local-avatar',
    revokeObjectURL: (url) => revoked.push(url),
  };
  class DecodedImage {
    naturalWidth = 1200;
    naturalHeight = 800;
    set src(value) { this.loadedFrom = value; queueMicrotask(() => this.onload()); }
  }
  const file = { type: 'image/jpeg', size: 12345 };
  const avatar = await avatarFromFile(file, { ImageType: DecodedImage, urlAPI, createCanvas });
  assert.equal(avatar.width, 192);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].loadedFrom, 'blob:local-avatar');
  assert.deepEqual(revoked, ['blob:local-avatar']);

  await assert.rejects(() => avatarFromFile({ type: 'image/svg+xml', size: 1 },
    { ImageType: DecodedImage, urlAPI, createCanvas }), /请选择/);
  await assert.rejects(() => avatarFromFile({ type: 'image/jpeg', size: AVATAR_MAX_BYTES + 1 },
    { ImageType: DecodedImage, urlAPI, createCanvas }), /8 MB/);
  assert.deepEqual(revoked, ['blob:local-avatar'], 'invalid files are rejected before any URL is made');

  class BrokenImage {
    set src(value) { this.loadedFrom = value; queueMicrotask(() => this.onerror()); }
  }
  await assert.rejects(() => avatarFromFile(file, { ImageType: BrokenImage, urlAPI, createCanvas }), /无法解码/);
  assert.deepEqual(revoked, ['blob:local-avatar', 'blob:local-avatar'], 'decode failure releases the URL too');
});

test('a user-requested camera frame uses the same local crop, and an unready camera fails clearly', () => {
  const { calls, createCanvas } = canvasRecorder();
  const video = { videoWidth: 1280, videoHeight: 720 };
  const avatar = avatarFromCamera(video, createCanvas);
  assert.equal(avatar.height, 192);
  assert.deepEqual(calls[0], [video, 280, 0, 720, 720, 0, 0, 192, 192]);
  assert.throws(() => avatarFromCamera({ videoWidth: 0, videoHeight: 0 }, createCanvas), /尚未准备/);
});
