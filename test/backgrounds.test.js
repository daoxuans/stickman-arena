import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { CampaignSession, STORAGE_KEY } from '../public/campaign.js';
import { createRenderer, photoForLevel } from '../public/render.js';
import { createGameServer } from '../server/index.js';

const THEMES = ['forest', 'city', 'ocean', 'land'];
const ASSET_ROOT = new URL('../public/assets/backgrounds/', import.meta.url);
const EXPECTED_SIZE = [1600, 900];
const PHOTO_LEVELS = [
  [1, 4, 7, 11, 13], [15, 18, 22, 24, 27],
  [29, 33, 39, 42], [44, 46, 49, 56],
];
const PHOTO_NAMES = [
  ['forest-intro.webp', 'forest.webp', 'forest-2.webp', 'forest-3.webp', 'forest-4.webp'],
  ['city.webp', 'city-2.webp', 'city-3.webp', 'city-4.webp', 'city-5.webp'],
  ['ocean.webp', 'ocean-2.webp', 'ocean-3.webp', 'ocean-4.webp'],
  ['land.webp', 'land-2.webp', 'land-3.webp', 'land-4.webp'],
];
const PHOTO_FILES = PHOTO_NAMES.flat();

function webpChunks(buffer) {
  assert.ok(buffer.length >= 30, 'WebP must include a RIFF container and image data');
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WEBP');
  assert.equal(buffer.readUInt32LE(4) + 8, buffer.length, 'RIFF length must match the file');

  const chunks = [];
  for (let offset = 12; offset < buffer.length;) {
    assert.ok(offset + 8 <= buffer.length, 'chunk header must fit within RIFF');
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    assert.ok(start + length <= buffer.length, `${type} chunk must fit within RIFF`);
    chunks.push({ type, start, length });
    offset = start + length + (length & 1);
  }
  return chunks;
}

function webpSize(buffer, chunks) {
  const extended = chunks.find((chunk) => chunk.type === 'VP8X');
  if (extended) {
    const u24 = (offset) => buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
    return [1 + u24(extended.start + 4), 1 + u24(extended.start + 7)];
  }
  const lossy = chunks.find((chunk) => chunk.type === 'VP8 ');
  if (lossy) {
    assert.equal(buffer.subarray(lossy.start + 3, lossy.start + 6).toString('hex'), '9d012a');
    return [buffer.readUInt16LE(lossy.start + 6) & 0x3fff, buffer.readUInt16LE(lossy.start + 8) & 0x3fff];
  }
  const lossless = chunks.find((chunk) => chunk.type === 'VP8L');
  if (lossless) {
    const at = lossless.start;
    assert.equal(buffer[at], 0x2f);
    return [
      1 + buffer[at + 1] + ((buffer[at + 2] & 0x3f) << 8),
      1 + (buffer[at + 2] >> 6) + (buffer[at + 3] << 2) + ((buffer[at + 4] & 0x0f) << 10),
    ];
  }
  assert.fail('WebP has no supported image chunk');
}

function selectedStages(theme, chapter) {
  return Array.from({ length: 14 }, (_, offset) => chapter * 14 + offset + 1)
    .filter((level) => photoForLevel(theme, level));
}

test('only the eighteen bounded, metadata-free 1600×900 WebP backgrounds are public', () => {
  const filenames = readdirSync(ASSET_ROOT).sort();
  assert.deepEqual(filenames, [...PHOTO_FILES].sort());
  for (const filename of filenames) {
    const buffer = readFileSync(new URL(filename, ASSET_ROOT));
    assert.ok(buffer.length > 20_000 && buffer.length < 500_000, `${filename}: unreasonable file size`);
    const chunks = webpChunks(buffer);
    assert.deepEqual(webpSize(buffer, chunks), EXPECTED_SIZE, `${filename}: must be 16:9 at 1600×900`);
    assert.ok(!chunks.some((chunk) => chunk.type === 'EXIF'), `${filename}: should not expose photo EXIF`);
  }
});

test('HTTP serves every processed background but never exposes private originals or the contact sheet', async (t) => {
  const game = await createGameServer({ port: 0, host: '127.0.0.1' });
  t.after(() => game.close());
  const base = `http://127.0.0.1:${game.port}`;

  for (const filename of PHOTO_FILES) {
    const background = await fetch(`${base}/assets/backgrounds/${filename}`);
    assert.equal(background.status, 200, filename);
    assert.match(background.headers.get('content-type') || '', /^image\/webp/, filename);
    assert.ok((await background.arrayBuffer()).byteLength > 20_000, filename);
  }

  for (const privatePath of [
    '/pic/source-contact.webp',
    `/pic/${encodeURIComponent('微信图片_20261004174950_13_2.jpg')}`,
    `/pic/${encodeURIComponent('微信图片_20261004174959_18_2.jpg')}`,
    `/pic/${encodeURIComponent('微信图片_20261004174956_16_2.jpg')}`,
    '/pic/Forest_path_at_sunset_(Unsplash).jpg',
    '/assets/backgrounds/source-contact.webp',
  ]) {
    assert.equal((await fetch(`${base}${privatePath}`)).status, 404, `${privatePath} must stay private`);
  }
});

test('eighteen photo stages preserve the existing photos plus the first-stage and city additions', async () => {
  const allSelected = [];
  const secondLoad = await import(`../public/render.js?backgrounds-stability=${Date.now()}`);

  for (let chapter = 0; chapter < THEMES.length; chapter += 1) {
    const theme = THEMES[chapter];
    const stages = selectedStages(theme, chapter);
    assert.deepEqual(stages, PHOTO_LEVELS[chapter], `${theme} must keep its assigned photo stages`);
    allSelected.push(...stages);
    const selectedPaths = stages.map((level) => photoForLevel(theme, level));
    assert.equal(new Set(selectedPaths).size, stages.length, `${theme} must use each background once`);

    for (let level = chapter * 14 + 1; level <= (chapter + 1) * 14; level += 1) {
      const photoIndex = stages.indexOf(level);
      const expected = photoIndex >= 0 ? `./assets/backgrounds/${PHOTO_NAMES[chapter][photoIndex]}` : null;
      assert.equal(photoForLevel(theme, level), expected, `${theme} stage ${level}`);
      assert.equal(secondLoad.photoForLevel(theme, level), expected, 'choice must survive a fresh module load');
      for (const other of THEMES.filter((name) => name !== theme)) {
        assert.equal(photoForLevel(other, level), null, `stage ${level} must not use ${other}'s photo`);
      }
    }
  }

  assert.equal(allSelected.length, 18);
  for (let i = 1; i < allSelected.length; i += 1) {
    assert.ok(allSelected[i] - allSelected[i - 1] > 1, `photo stages ${allSelected[i - 1]} and ${allSelected[i]} are adjacent`);
  }
  for (const invalid of [undefined, null, -1, 0, 1.5, 57, '1', NaN, Infinity]) {
    assert.equal(photoForLevel('forest', invalid), null);
  }
  for (const invalidTheme of ['bogus', 'Forest', '', null, undefined]) {
    assert.equal(photoForLevel(invalidTheme, 1), null);
  }
});

function savedAt(currentLevel, checkpointLevel = currentLevel) {
  let saved = JSON.stringify({
    currentLevel, checkpointLevel, deaths: 0, completed: false, cleared: [],
  });
  return {
    getItem(key) { return key === STORAGE_KEY ? saved : null; },
    setItem(key, value) { if (key === STORAGE_KEY) saved = value; },
  };
}

test('first-stage, city and ocean checkpoint photos survive failure, retry and reload', () => {
  for (const [level, filename] of [
    [1, 'forest-intro.webp'], [27, 'city-5.webp'], [33, 'ocean-2.webp'],
  ]) {
    const storage = savedAt(level);
    const session = new CampaignSession({ storage });
    const first = session.start();
    const chosen = photoForLevel(first.level.theme, first.level.number);
    assert.equal(chosen, `./assets/backgrounds/${filename}`);

    session.combat.fighters[0].hp = 0;
    assert.equal(session.step().phase, 'failed');
    const retry = session.retry();
    assert.equal(retry.level.number, level);
    assert.equal(photoForLevel(retry.level.theme, retry.level.number), chosen);

    const restored = new CampaignSession({ storage }).start();
    assert.equal(photoForLevel(restored.level.theme, restored.level.number), chosen);
  }
});

test('level four uses the old forest photo; failing there returns to the first-stage photo', () => {
  const storage = savedAt(4, 1);
  const session = new CampaignSession({ storage });
  const first = session.start();
  assert.equal(photoForLevel(first.level.theme, first.level.number), './assets/backgrounds/forest.webp');
  const refreshed = new CampaignSession({ storage }).start();
  assert.equal(photoForLevel(refreshed.level.theme, refreshed.level.number), './assets/backgrounds/forest.webp');

  session.combat.fighters[0].hp = 0;
  assert.equal(session.step().phase, 'failed');
  const retry = session.retry();
  assert.equal(retry.level.number, 1);
  assert.equal(photoForLevel(retry.level.theme, retry.level.number), './assets/backgrounds/forest-intro.webp');
});

function fakeCanvas(calls) {
  const gradient = { addColorStop() {} };
  const context = new Proxy({
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    drawImage(image, ...args) { calls.push({ image, args }); },
  }, {
    get(target, property) { return property in target ? target[property] : () => {}; },
    set(target, property, value) { target[property] = value; return true; },
  });
  return { width: 960, height: 540, getContext: () => context };
}

test('campaign photos load asynchronously and cache; duel and non-photo stages stay vector-only', () => {
  const previousImage = globalThis.Image;
  const hadImage = Object.hasOwn(globalThis, 'Image');
  const created = [];

  class FakeImage {
    constructor() {
      this.complete = false;
      this.naturalWidth = 0;
      this.src = '';
      created.push(this);
    }
    finishLoading() {
      this.complete = true;
      this.naturalWidth = 1600;
      this.onload?.();
    }
    failLoading() {
      this.complete = true;
      this.naturalWidth = 0;
      this.onerror?.();
    }
  }

  globalThis.Image = FakeImage;
  try {
    for (let chapter = 0; chapter < THEMES.length; chapter += 1) {
      const theme = THEMES[chapter];
      const selectedLevels = selectedStages(theme, chapter);
      const noPhoto = Array.from({ length: 14 }, (_, offset) => chapter * 14 + offset + 1)
        .find((level) => photoForLevel(theme, level) === null);
      const calls = [];
      const renderer = createRenderer(fakeCanvas(calls));
      const state = { arena: { theme, groundY: 438, platforms: [], hazards: [] }, fighters: [], tick: 1 };
      for (const selected of selectedLevels) {
        const count = created.length;
        const drawn = calls.length;
        renderer.render(state, { mode: 'duel', theme, level: selected });
        assert.equal(created.length, count, `${theme} duel must never request a photo`);
        assert.equal(calls.length, drawn);

        renderer.render(state, { mode: 'campaign', theme, level: selected });
        assert.equal(created.length, count + 1, `${theme} stage ${selected} should start loading once`);
        assert.ok(created.at(-1).src.endsWith(photoForLevel(theme, selected).slice(1)));
        assert.equal(calls.length, drawn, 'vector background must remain while image is pending');

        created.at(-1).finishLoading();
        renderer.render(state, { mode: 'campaign', theme, level: selected });
        assert.equal(calls.length, drawn + 1, 'loaded photo should be drawn on the next frame');
        assert.deepEqual(calls.at(-1).args, [0, 0, 960, 540]);
        renderer.render(state, { mode: 'campaign', theme, level: selected });
        assert.equal(created.length, count + 1, 'photo should come from cache');
      }

      const drawCount = calls.length;
      const count = created.length;
      renderer.render(state, { mode: 'campaign', theme, level: noPhoto });
      renderer.render(state, { mode: 'duel', theme, level: selectedLevels[0] });
      assert.equal(created.length, count);
      assert.equal(calls.length, drawCount, 'neither an unselected campaign stage nor duel may draw photos');

      renderer.render(state, { mode: 'campaign', theme, level: selectedLevels[0] });
      assert.equal(created.length, count, 'returning to a photo stage should use the cached image');
    }

    const failedCalls = [];
    const failedRenderer = createRenderer(fakeCanvas(failedCalls));
    const failedTheme = 'forest';
    const failedLevel = selectedStages(failedTheme, 0)[0];
    const state = { arena: { theme: failedTheme, groundY: 438, platforms: [], hazards: [] }, fighters: [], tick: 1 };
    const beforeFailure = created.length;
    failedRenderer.render(state, { mode: 'campaign', theme: failedTheme, level: failedLevel });
    assert.equal(created.length, beforeFailure + 1);
    created.at(-1).failLoading();
    failedRenderer.render(state, { mode: 'campaign', theme: failedTheme, level: failedLevel });
    failedRenderer.render(state, { mode: 'campaign', theme: failedTheme, level: failedLevel });
    assert.equal(failedCalls.length, 0, 'broken photo must keep the illustrated fallback');
    assert.equal(created.length, beforeFailure + 1, 'a failed photo must not trigger repeated requests each frame');
  } finally {
    if (hadImage) globalThis.Image = previousImage;
    else delete globalThis.Image;
  }
});
