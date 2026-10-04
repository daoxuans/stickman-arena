import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// The controller boots against a real DOM. Evaluate only its sound class so
// timers and AudioContext can be checked without a browser or audio device.
function soundClass(window) {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('class SoundEffects {');
  const end = source.indexOf('\nconst sound = new SoundEffects();', begin);
  assert.ok(begin >= 0 && end > begin, 'sound class must exist in the controller');
  return runInNewContext(`${source.slice(begin, end)}\nSoundEffects`, { window });
}

function clock() {
  const pending = new Map();
  let next = 0;
  return {
    pending,
    setTimeout(callback, delay) {
      const id = ++next;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    fire(delay) {
      for (const [id, entry] of [...pending]) {
        if (entry.delay !== delay) continue;
        pending.delete(id);
        entry.callback();
      }
    },
  };
}

test('a KO cues a quiet fall and plays its filtered tomato splat at the 180 ms landing', () => {
  const timer = clock();
  const SoundEffects = soundClass(timer);
  const sound = new SoundEffects();
  const played = [];
  sound.tone = (...args) => played.push(['tone', ...args]);
  sound.noise = (...args) => played.push(['noise', ...args]);

  sound.play({ type: 'ko' });
  assert.deepEqual(played.map(([kind]) => kind), ['tone']);
  assert.ok(played[0][4] <= 0.03, 'the immediate cue should not drown out the hit');
  assert.deepEqual([...timer.pending.values()].map(({ delay }) => delay), [180]);
  timer.fire(180);
  assert.deepEqual(played.map(([kind]) => kind), ['tone', 'tone', 'noise']);
  assert.ok(played[1][4] <= 0.07 && played[2][2] <= 0.05, 'splat is deliberately restrained');
  assert.equal(played[2][3], 1050, 'wet splat noise is low-pass filtered');
  assert.equal(sound.pendingKOs.size, 0);
});

test('muting or starting a new round prevents a queued tomato sound', () => {
  const timer = clock();
  const SoundEffects = soundClass(timer);
  const sound = new SoundEffects();
  const played = [];
  sound.tone = (...args) => played.push(['tone', ...args]);
  sound.noise = (...args) => played.push(['noise', ...args]);

  sound.play({ type: 'ko' });
  sound.enabled = false;
  timer.fire(180);
  assert.equal(played.length, 1, 'muting before impact prevents the delayed sound');

  sound.enabled = true;
  sound.play({ type: 'ko' });
  sound.cancelPendingKOs();
  assert.equal(timer.pending.size, 0);
  timer.fire(180);
  assert.equal(played.length, 2, 'a cancelled KO never plays after a round change');
});

test('tomato noise passes through a low-pass filter before reaching the output', () => {
  const links = [];
  const filters = [];
  const node = (name) => ({ name, connect(next) { links.push(`${name}->${next.name}`); return next; } });
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 8000;
      this.destination = node('speaker');
    }

    createBuffer(_channels, count) { return { getChannelData: () => new Float32Array(count) }; }
    createBufferSource() { return { ...node('noise'), start() {} }; }
    createBiquadFilter() {
      const filter = { ...node('filter'), frequency: { value: 0 } };
      filters.push(filter);
      return filter;
    }
    createGain() { return { ...node('gain'), gain: { value: 0 } }; }
  }
  const SoundEffects = soundClass({ AudioContext: FakeAudioContext });
  const sound = new SoundEffects();
  sound.noise(0.11, 0.05, 1050);
  assert.equal(filters.length, 1);
  assert.equal(filters[0].type, 'lowpass');
  assert.equal(filters[0].frequency.value, 1050);
  assert.deepEqual(links, ['noise->filter', 'filter->gain', 'gain->speaker']);
});
