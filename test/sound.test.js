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

function fakeAudio() {
  const stats = { links: [], filters: [], compressors: [], contexts: [], sources: [],
    starts: [], stops: [], disconnected: [] };
  let gains = 0;
  const param = () => ({
    value: 0,
    setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; },
    exponentialRampToValueAtTime(value) { this.value = value; },
  });
  const node = (name) => ({
    name,
    connect(next) { stats.links.push(`${name}->${next.name}`); return next; },
    disconnect() { stats.disconnected.push(name); },
  });
  const source = (name) => {
    const created = {
      ...node(name),
      start(time) { stats.starts.push({ name, time }); },
      stop(time) { stats.stops.push({ name, time }); },
    };
    stats.sources.push(created);
    return created;
  };
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.destination = node('speaker');
      stats.contexts.push(this);
    }

    createBuffer(_channels, count) { return { getChannelData: () => new Float32Array(count) }; }
    createBufferSource() { return source('noise'); }
    createOscillator() { return { ...source('oscillator'), frequency: param() }; }
    createGain() { return { ...node(gains++ === 0 ? 'master' : 'gain'), gain: param() }; }
    createBiquadFilter() {
      const filter = { ...node('filter'), frequency: param() };
      stats.filters.push(filter);
      return filter;
    }
    createDynamicsCompressor() {
      const compressor = { ...node('compressor'), threshold: param(), knee: param(), ratio: param(),
        attack: param(), release: param() };
      stats.compressors.push(compressor);
      return compressor;
    }
  }
  return { stats, FakeAudioContext };
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
  const staleLanding = [...timer.pending.values()][0].callback;
  sound.enabled = false;
  timer.fire(180);
  assert.equal(played.length, 1, 'muting before impact prevents the delayed sound');

  sound.enabled = true;
  staleLanding();
  assert.equal(played.length, 1, 'a queued callback cannot leak through a fast mute/unmute');
  sound.play({ type: 'ko' });
  sound.cancelPendingKOs();
  assert.equal(timer.pending.size, 0);
  timer.fire(180);
  assert.equal(played.length, 2, 'a cancelled KO never plays after a round change');
});

test('walking over a fallen enemy plays one restrained, dry bone rattle and respects mute', () => {
  const SoundEffects = soundClass({});
  const sound = new SoundEffects();
  const played = [];
  sound.tone = (...args) => played.push(['tone', ...args]);
  sound.noise = (...args) => played.push(['noise', ...args]);

  sound.play({ type: 'bones-scatter' });
  assert.deepEqual(played.map(([kind]) => kind), ['tone', 'tone', 'noise']);
  assert.ok(played[0][4] <= 0.04 && played[2][2] <= 0.03,
    'the dry scatter cue should stay below a heavy combat impact');
  assert.equal(played[2][3], 2400, 'the scatter has a crisp but filtered texture');
  sound.enabled = false;
  sound.play({ type: 'bones-scatter' });
  assert.equal(played.length, 3, 'muting silences the new effect too');
});

test('falling-object warnings stay quiet, while impacts make restrained material cues', () => {
  const SoundEffects = soundClass({});
  const sound = new SoundEffects();
  const played = [];
  sound.tone = (...args) => played.push(['tone', ...args]);
  sound.noise = (...args) => played.push(['noise', ...args]);

  sound.play({ type: 'fall-warning', kind: 'hail' });
  assert.equal(played.length, 0);
  sound.play({ type: 'fall-impact', kind: 'hail' });
  assert.deepEqual(played.map(([name]) => name), ['tone', 'noise']);
  assert.equal(played[0][1], 650);
  assert.ok(played[0][4] <= 0.03 && played[1][2] <= 0.02);
  played.length = 0;
  sound.play({ type: 'fall-impact', kind: 'pebble' });
  assert.ok(played[0][1] < 650, 'a pebble should sound lower than hail');
});

test('spear windup and release have distinct cues, and a blocked impact stays subtle', () => {
  const SoundEffects = soundClass({});
  const sound = new SoundEffects();
  const played = [];
  sound.tone = (...args) => played.push(['tone', ...args]);
  sound.noise = (...args) => played.push(['noise', ...args]);

  sound.play({ type: 'spear-windup' });
  assert.deepEqual(played.map(([name]) => name), ['tone']);
  played.length = 0;
  sound.play({ type: 'spear-throw' });
  assert.deepEqual(played.map(([name]) => name), ['tone', 'noise']);
  assert.equal(played[1][4], 'highpass', 'a release is an air slice, not a body impact');
  played.length = 0;
  sound.play({ type: 'spear-impact', blocked: false });
  assert.equal(played.length, 0, 'an unblocked spear also produces the standard hit cue');
  sound.play({ type: 'spear-impact', blocked: true });
  assert.deepEqual(played.map(([name]) => name), ['tone']);
});

test('filtered textures feed a capped master bus and compressor before the speaker', () => {
  const { stats, FakeAudioContext } = fakeAudio();
  const SoundEffects = soundClass({ AudioContext: FakeAudioContext });
  const sound = new SoundEffects();
  sound.noise(0.11, 0.05, 1050);
  assert.equal(stats.filters.length, 1);
  assert.equal(stats.filters[0].type, 'lowpass');
  assert.equal(stats.filters[0].frequency.value, 1050);
  assert.deepEqual(stats.links, [
    'master->compressor', 'compressor->speaker', 'noise->filter', 'filter->gain', 'gain->master',
  ]);
  assert.equal(stats.compressors[0].threshold.value, -18);
  assert.equal(stats.contexts[0].currentTime, 0);
  stats.sources[0].onended();
  assert.equal(sound.voices.size, 0, 'finished nodes release their connections');
  assert.ok(stats.disconnected.includes('filter') && stats.disconnected.includes('gain'));
});

test('older audio contexts without a compressor still connect the sound to the speaker', () => {
  const { stats, FakeAudioContext } = fakeAudio();
  class OlderAudioContext extends FakeAudioContext {
    constructor() {
      super();
      this.createDynamicsCompressor = undefined;
    }
  }
  const SoundEffects = soundClass({ AudioContext: OlderAudioContext });
  const sound = new SoundEffects();
  sound.tone(350, 120, 0.1);
  assert.ok(stats.links.includes('master->speaker'));
  assert.ok(stats.links.includes('gain->master'));
});

test('one browser unlock request covers a layered hit while audio is suspended', () => {
  const { stats, FakeAudioContext } = fakeAudio();
  class SuspendedAudioContext extends FakeAudioContext {
    constructor() {
      super();
      this.state = 'suspended';
      this.resumeCalls = 0;
    }
    resume() { this.resumeCalls++; return Promise.resolve(); }
  }
  const SoundEffects = soundClass({ AudioContext: SuspendedAudioContext });
  const sound = new SoundEffects();
  sound.play({ type: 'hit', heavy: true });
  assert.equal(stats.contexts[0].resumeCalls, 1);
  assert.equal(stats.starts.length, 3, 'all layers use the same pending browser unlock');
});

test('jump kick and wave have a jade overtone; only a real hit gets a body thud', () => {
  const timer = clock();
  const SoundEffects = soundClass(timer);
  const sound = new SoundEffects();
  const played = [];
  sound.tone = (...args) => played.push(['tone', ...args]);
  sound.noise = (...args) => played.push(['noise', ...args]);

  sound.play({ type: 'jump-kick' });
  assert.deepEqual(played.map(([name]) => name), ['noise', 'tone', 'tone']);
  assert.ok(played.filter(([name]) => name === 'tone').every(([, frequency]) => frequency > 400),
    'the whiff still has its energy flourish but no low impact');
  played.length = 0;
  sound.play({ type: 'hit', heavy: true });
  assert.deepEqual(played.map(([name]) => name), ['noise', 'tone', 'tone']);
  assert.equal(played[1][1], 132, 'the impact event adds the actual body thud');
  played.length = 0;
  sound.play({ type: 'hit', special: true });
  assert.equal(played.length, 0, 'wave hits do not repeat an impact for each affected foe');
  sound.play({ type: 'special-wave' });
  assert.deepEqual(played.map(([name]) => name), ['tone', 'tone', 'noise', 'tone']);
  assert.deepEqual([...timer.pending.values()].map(({ delay }) => delay), [105]);
  timer.fire(105);
  assert.equal(played.at(-1)[1], 940, 'a brief chime follows the spreading wave');
});

test('boss telegraph rises quietly and never plays while muted', () => {
  const SoundEffects = soundClass({});
  const sound = new SoundEffects();
  const played = [];
  sound.tone = (...args) => played.push(args);
  sound.play({ type: 'boss-windup' });
  assert.deepEqual(played.map(([start, end]) => [start, end]), [[92, 128], [310, 440]]);
  assert.ok(played.every(([, , , volume]) => volume < 0.05), 'windup is quieter than a hit');
  sound.enabled = false;
  sound.play({ type: 'boss-windup' });
  assert.equal(played.length, 2);
});

test('rapid hits cap polyphony; critical KO remains audible and mute stops every tail', () => {
  const timer = clock();
  const { stats, FakeAudioContext } = fakeAudio();
  const SoundEffects = soundClass({ ...timer, AudioContext: FakeAudioContext });
  const sound = new SoundEffects();
  for (let i = 0; i < 30; i++) sound.play({ type: 'hit', heavy: i % 3 === 0 });
  assert.equal(stats.starts.length, sound.maxVoices);
  assert.equal(sound.voices.size, sound.maxVoices);
  const beforeKO = stats.starts.length;
  sound.play({ type: 'ko' });
  assert.equal(stats.starts.length, beforeKO + 1, 'KO preempts an old low-priority hit');
  assert.equal(sound.voices.size, sound.maxVoices);
  assert.ok(stats.stops.some(({ time }) => time === undefined), 'preempted voice is stopped');
  assert.deepEqual([...timer.pending.values()].map(({ delay }) => delay), [180]);
  sound.enabled = false;
  assert.equal(sound.voices.size, 0);
  assert.equal(timer.pending.size, 0);
  assert.equal(sound.output.gain.value, 0);
  const startsWhileMuted = stats.starts.length;
  timer.fire(180);
  sound.play({ type: 'hit' });
  assert.equal(stats.starts.length, startsWhileMuted);
  sound.enabled = true;
  sound.play({ type: 'hit' });
  assert.ok(stats.starts.length > startsWhileMuted, 'unmuting reuses the available audio context');
  assert.equal(sound.output.gain.value, 0.64);
});

test('new round cancels delayed wave and victory cues as well as tomatoes', () => {
  const timer = clock();
  const SoundEffects = soundClass(timer);
  const sound = new SoundEffects();
  const played = [];
  sound.tone = (...args) => played.push(args);
  sound.noise = () => {};
  sound.play({ type: 'special-wave' });
  sound.play({ type: 'level-clear' });
  sound.play({ type: 'ko' });
  assert.deepEqual([...timer.pending.values()].map(({ delay }) => delay), [105, 115, 180]);
  const immediate = played.length;
  sound.cancelPendingKOs();
  assert.equal(timer.pending.size, 0);
  timer.fire(105);
  timer.fire(115);
  timer.fire(180);
  assert.equal(played.length, immediate);
});
