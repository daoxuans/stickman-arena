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
    fireNext(advance) {
      const [id, entry] = pending.entries().next().value ?? [];
      assert.ok(entry, 'a scheduled audio beat should exist');
      pending.delete(id);
      advance?.(entry.delay);
      entry.callback();
      return entry.delay;
    },
  };
}

function fakeAudio() {
  const stats = { links: [], filters: [], compressors: [], contexts: [], sources: [],
    starts: [], stops: [], disconnected: [], edges: [], gains: [] };
  let gains = 0;
  const param = () => ({
    value: 0,
    events: [],
    setValueAtTime(value, at) { this.value = value; this.events.push(['set', value, at]); },
    linearRampToValueAtTime(value, at) { this.value = value; this.events.push(['linear', value, at]); },
    exponentialRampToValueAtTime(value, at) { this.value = value; this.events.push(['exponential', value, at]); },
    cancelScheduledValues(at) { this.events.push(['cancel', at]); },
  });
  const node = (name) => ({
    name,
    connect(next) { stats.links.push(`${name}->${next.name}`); stats.edges.push([this, next]); return next; },
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
    createGain() {
      const gain = { ...node(gains++ === 0 ? 'master' : 'gain'), gain: param() };
      stats.gains.push(gain);
      return gain;
    }
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

test('PvP wave charge and release are audible once without duplicating a target impact', () => {
  const timer = clock();
  const SoundEffects = soundClass(timer);
  const sound = new SoundEffects();
  const played = [];
  let ducks = 0;
  sound.tone = (...args) => played.push(['tone', ...args]);
  sound.noise = (...args) => played.push(['noise', ...args]);
  sound.duckMusic = () => { ducks++; };

  sound.play({ type: 'duel-wave-ready', source: 'p2' });
  assert.deepEqual(played.map(([kind]) => kind), ['tone', 'tone']);
  assert.equal(ducks, 0, 'a readiness cue does not duck the whole score');
  played.length = 0;
  sound.play({ type: 'duel-wave', source: 'p2' });
  assert.deepEqual(played.map(([kind]) => kind), ['tone', 'tone', 'noise', 'tone']);
  assert.equal(ducks, 1, 'one wave release gives the foreground sound priority');
  assert.deepEqual([...timer.pending.values()].map(({ delay }) => delay), [105]);
  sound.play({ type: 'hit', delivery: 'duel-wave', target: 'p1' });
  assert.equal(played.length, 4, 'the target hit does not layer a second heavy impact');
  assert.equal(ducks, 1, 'one wave does not duck music twice');
  timer.fire(105);
  assert.equal(played.at(-1)[1], 940);
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

test('stone, summon, quake and ward have distinct bounded cues; an actual rock hit sounds only once', () => {
  const SoundEffects = soundClass({});
  const sound = new SoundEffects();
  const played = [];
  sound.tone = (...args) => played.push(['tone', ...args]);
  sound.noise = (...args) => played.push(['noise', ...args]);

  sound.play({ type: 'boss-rock-windup' });
  assert.deepEqual(played.map(([kind]) => kind), ['tone', 'noise']);
  assert.ok(played[0][4] < 0.05, 'a stone telegraph stays below a damaging hit');
  played.length = 0;
  sound.play({ type: 'rock-impact', target: 'hero' });
  assert.equal(played.length, 0, 'a hit projectile has its own delivery-marked hit sound');
  sound.play({ type: 'hit', delivery: 'rock', target: 'hero' });
  assert.deepEqual(played.map(([kind]) => kind), ['noise', 'tone']);
  played.length = 0;
  sound.play({ type: 'rock-impact', blocked: true });
  assert.deepEqual(played.map(([kind]) => kind), ['tone', 'noise']);

  for (const type of ['rock-windup', 'rock-throw', 'boss-rock-throw',
    'boss-summon-windup', 'boss-summon', 'boss-quake-windup', 'boss-quake',
    'boss-ward-windup', 'boss-ward', 'boss-ward-hit']) {
    played.length = 0;
    sound.play({ type });
    assert.ok(played.length >= 1 && played.length <= 2, `${type} is audible without an uncontrolled stack`);
  }
  played.length = 0;
  sound.enabled = false;
  sound.play({ type: 'boss-quake' });
  assert.equal(played.length, 0);
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

test('four synthesized themes have distinct melodic roots and tempi; a duel adds a faster pulse', () => {
  const timer = clock();
  const { stats, FakeAudioContext } = fakeAudio();
  const SoundEffects = soundClass({ ...timer, AudioContext: FakeAudioContext });
  const sound = new SoundEffects();
  sound.unlock();
  const leads = [];
  const beatDelays = [];
  for (const theme of ['forest', 'city', 'ocean', 'land']) {
    sound.setMusicScene({ mode: 'campaign', theme });
    assert.equal(sound.musicVoices.size, 2, `${theme} starts with a lead and restrained bass`);
    leads.push([...sound.musicVoices][0].source.frequency.value);
    beatDelays.push([...timer.pending.values()][0].delay);
    assert.equal(timer.pending.size, 1, 'one scheduler serves the music, even after switching themes');
  }
  assert.equal(new Set(leads).size, 4, 'each setting uses its own actual melody pitch');
  assert.equal(new Set(beatDelays).size, 4, 'each setting has a distinct rhythm');
  const oceanDelay = beatDelays[2];
  sound.setMusicScene({ mode: 'duel', theme: 'ocean' });
  assert.ok([...timer.pending.values()][0].delay < oceanDelay, 'the room owner’s ocean theme gets a quicker duel arrangement');
  assert.equal(sound.musicScene.theme, 'ocean');
  assert.equal(stats.contexts.length, 1, 'theme switching reuses the same audio context');
});

test('music needs a user gesture, loops with a single timer and keeps its own small voice budget', () => {
  const timer = clock();
  const { stats, FakeAudioContext } = fakeAudio();
  const SoundEffects = soundClass({ ...timer, AudioContext: FakeAudioContext });
  const sound = new SoundEffects();
  sound.setMusicScene({ mode: 'campaign', theme: 'forest' });
  assert.equal(stats.contexts.length, 0, 'no autoplay context before an explicit gesture');
  assert.equal(timer.pending.size, 0);
  sound.unlock();
  assert.equal(sound.musicRunning, true);
  assert.equal(timer.pending.size, 1);
  const originalStarts = stats.starts.length;
  for (let i = 0; i < 45; i++) {
    sound.setMusicScene({ mode: 'campaign', theme: 'forest' });
    assert.equal(timer.pending.size, 1, 'repeated HUD/frame synchronization does not double the loop');
    timer.fireNext((delay) => { stats.contexts[0].currentTime += delay / 1000; });
    assert.equal(timer.pending.size, 1);
    assert.ok(sound.musicVoices.size <= sound.maxMusicVoices);
  }
  assert.ok(stats.starts.length > originalStarts + 20, 'a short melody repeats instead of a single sustained note');
  assert.equal(sound.voices.size, 0, 'the 24 combat-effect voices remain entirely available');
  assert.ok(stats.edges.some(([from, to]) => from === sound.musicBus && to === sound.output),
    'music has a separate quiet gain branch feeding the shared compressor');
  assert.ok(stats.edges.some(([from, to]) => from === sound.output && to === stats.compressors[0]));
  sound.play({ type: 'hit', heavy: true });
  assert.equal(sound.voices.size, 3, 'a layered heavy hit is not blocked by music voices');
  for (let i = 0; i < 30; i++) sound.play({ type: 'hit', heavy: i % 3 === 0 });
  assert.equal(sound.voices.size, sound.maxVoices, 'effect polyphony remains capped independently');
  assert.ok(sound.musicVoices.size <= sound.maxMusicVoices);
});

test('background mix stays well below the impact and ducks briefly when a confirmed hit lands', () => {
  const timer = clock();
  const { stats, FakeAudioContext } = fakeAudio();
  const SoundEffects = soundClass({ ...timer, AudioContext: FakeAudioContext });
  const sound = new SoundEffects();
  sound.setMusicScene({ mode: 'campaign', theme: 'city', boss: true });
  sound.unlock();
  const musicRawPeaks = [...sound.musicVoices].map((voice) =>
    Math.max(...voice.gain.gain.events.filter(([type]) => type === 'linear').map(([, value]) => value)));
  assert.ok(musicRawPeaks.reduce((sum, volume) => sum + volume, 0) * sound.musicLevel < 0.105 / 5,
    'even the simultaneous lead and bass stay far below one ordinary hit tone');
  const output = sound.output;
  const bus = sound.musicBus;
  const before = bus.gain.events.length;
  sound.play({ type: 'hit', heavy: false });
  assert.equal(output.gain.value, 0.64, 'the shared effects master is not ducked');
  assert.deepEqual(bus.gain.events.slice(before).map(([kind, value]) => [kind, value]), [
    ['cancel', 0], ['set', sound.musicLevel], ['linear', sound.musicDuckLevel], ['linear', sound.musicLevel],
  ]);
  assert.ok(sound.musicDuckLevel < sound.musicLevel / 2, 'an impact lowers only the music branch by more than half');
  const afterHit = bus.gain.events.length;
  sound.play({ type: 'hit', special: true });
  assert.equal(bus.gain.events.length, afterHit, 'individual light-wave target events do not repeatedly duck');
  sound.play({ type: 'ko' });
  assert.ok(bus.gain.events.length > afterHit, 'the KO gets clear priority too');
  assert.equal(stats.compressors.length, 1, 'both branches share the same clipping guard');
});

test('rapid combo hits hold the current music envelope instead of pumping it up between punches', () => {
  const timer = clock();
  const { stats, FakeAudioContext } = fakeAudio();
  const SoundEffects = soundClass({ ...timer, AudioContext: FakeAudioContext });
  const sound = new SoundEffects();
  sound.setMusicScene({ mode: 'campaign', theme: 'forest' });
  sound.unlock();
  const gain = sound.musicBus.gain;
  sound.play({ type: 'hit' });
  stats.contexts[0].currentTime = 0.15;
  let before = gain.events.length;
  sound.play({ type: 'hit' });
  const heldDuringRecovery = gain.events.slice(before).find(([kind]) => kind === 'set')[1];
  assert.ok(heldDuringRecovery > sound.musicDuckLevel && heldDuringRecovery < sound.musicLevel,
    'old AudioParam APIs resume from the interrupted recovery, never jump to full level');
  stats.contexts[0].currentTime = 0.16;
  before = gain.events.length;
  sound.play({ type: 'hit' });
  const heldDuringNewDip = gain.events.slice(before).find(([kind]) => kind === 'set')[1];
  assert.ok(heldDuringNewDip < heldDuringRecovery, 'another quick punch continues the dip without a bounce');

  gain.cancelAndHoldAtTime = (at) => { gain.events.push(['hold', at]); };
  stats.contexts[0].currentTime = 0.18;
  before = gain.events.length;
  sound.play({ type: 'hit' });
  assert.deepEqual(gain.events.slice(before).map(([kind]) => kind), ['hold', 'linear', 'linear'],
    'modern AudioParam holds the exact instantaneous value rather than reading a stale .value');
});

test('mute, focus loss and scene changes stop all music tails; restoring resumes only one loop', () => {
  const timer = clock();
  const { stats, FakeAudioContext } = fakeAudio();
  const SoundEffects = soundClass({ ...timer, AudioContext: FakeAudioContext });
  const sound = new SoundEffects();
  sound.setMusicScene({ mode: 'campaign', theme: 'land' });
  sound.unlock();
  const staleTick = [...timer.pending.values()][0].callback;
  sound.enabled = false;
  assert.equal(timer.pending.size, 0);
  assert.equal(sound.musicVoices.size, 0);
  assert.equal(sound.output.gain.value, 0);
  staleTick();
  assert.equal(timer.pending.size, 0, 'a stale timeout cannot resurrect the muted music');
  sound.enabled = true;
  assert.equal(timer.pending.size, 1);
  sound.setAudible(false);
  assert.equal(timer.pending.size, 0);
  assert.equal(sound.musicVoices.size, 0);
  sound.setAudible(true);
  assert.equal(timer.pending.size, 1, 'focus return resumes the same scene exactly once');
  sound.setMusicScene({ mode: 'duel', theme: 'city' });
  assert.equal(timer.pending.size, 1);
  assert.equal(sound.musicScene.theme, 'city');
  sound.setMusicScene(null);
  assert.equal(timer.pending.size, 0, 'returning to a lobby/finished round is silent');
  assert.equal(sound.musicVoices.size, 0);
  assert.ok(stats.disconnected.includes('oscillator') && stats.disconnected.includes('gain'),
    'stopped notes release their audio-node connections');
  assert.ok(stats.stops.some(({ time }) => time === undefined), 'tails end at the scene boundary');
});

test('unsupported or denied browser audio never spins a silent music timer and can retry on another gesture', async () => {
  const timer = clock();
  const SoundEffects = soundClass(timer);
  const unsupported = new SoundEffects();
  unsupported.setMusicScene({ mode: 'campaign', theme: 'forest' });
  unsupported.unlock();
  assert.equal(timer.pending.size, 0);
  assert.equal(unsupported.musicRunning, false);

  const { stats, FakeAudioContext } = fakeAudio();
  class SuspendedAudioContext extends FakeAudioContext {
    constructor() { super(); this.state = 'suspended'; this.allowed = false; this.resumeCalls = 0; }
    resume() {
      this.resumeCalls++;
      if (!this.allowed) return Promise.reject(new Error('autoplay blocked'));
      this.state = 'running';
      return Promise.resolve();
    }
  }
  const BlockedSound = soundClass({ ...timer, AudioContext: SuspendedAudioContext });
  const sound = new BlockedSound();
  sound.setMusicScene({ mode: 'campaign', theme: 'ocean' });
  sound.unlock();
  sound.play({ type: 'hit', heavy: true });
  assert.equal(sound.voices.size, 3, 'a pending resume can temporarily queue a layered impact');
  await new Promise(setImmediate);
  assert.equal(timer.pending.size, 0);
  assert.equal(sound.musicRunning, false);
  assert.equal(sound.voices.size, 0, 'a denied resume cleans up the temporarily queued hit too');
  assert.equal(stats.contexts[0].resumeCalls, 1);
  for (let i = 0; i < 120; i++) sound.setMusicScene({ mode: 'campaign', theme: 'ocean' });
  sound.play({ type: 'hit' });
  assert.equal(stats.contexts[0].resumeCalls, 1,
    'frame-by-frame scene synchronization must not hot-loop a rejected browser resume');
  assert.equal(sound.voices.size, 0, 'new effects do not queue into a permanently suspended context');
  stats.contexts[0].allowed = true;
  sound.unlock();
  await new Promise(setImmediate);
  assert.equal(stats.contexts[0].resumeCalls, 2);
  assert.equal(sound.musicRunning, true);
  assert.equal(timer.pending.size, 1);
});

test('a partial Web Audio API pauses music retries until a scene change or another gesture', () => {
  const timer = clock();
  const { stats, FakeAudioContext } = fakeAudio();
  class PartialAudioContext extends FakeAudioContext {
    constructor() { super(); this.musicAttempts = 0; }
    createOscillator() { this.musicAttempts++; throw new Error('oscillators unavailable'); }
  }
  const SoundEffects = soundClass({ ...timer, AudioContext: PartialAudioContext });
  const sound = new SoundEffects();
  sound.setMusicScene({ mode: 'campaign', theme: 'forest' });
  sound.unlock();
  assert.equal(sound.musicRunning, false);
  assert.equal(sound.musicBlocked, true);
  assert.equal(timer.pending.size, 0);
  for (let i = 0; i < 120; i++) sound.setMusicScene({ mode: 'campaign', theme: 'forest' });
  assert.equal(stats.contexts[0].musicAttempts, 1, 'a broken sound device does not get hammered every frame');
  sound.setMusicScene({ mode: 'campaign', theme: 'city' });
  assert.equal(stats.contexts[0].musicAttempts, 2, 'a new theme may retry once');
  sound.unlock();
  assert.equal(stats.contexts[0].musicAttempts, 3, 'a new user gesture can retry again');
  assert.equal(timer.pending.size, 0);
});

test('an interrupted audio context waits safely, then resumes on a fresh gesture after focus returns', async () => {
  const timer = clock();
  const { stats, FakeAudioContext } = fakeAudio();
  class InterruptedAudioContext extends FakeAudioContext {
    constructor() { super(); this.allowed = false; this.resumeCalls = 0; }
    resume() {
      this.resumeCalls++;
      if (!this.allowed) return Promise.reject(new Error('gesture required'));
      this.state = 'running';
      return Promise.resolve();
    }
  }
  const SoundEffects = soundClass({ ...timer, AudioContext: InterruptedAudioContext });
  const sound = new SoundEffects();
  sound.setMusicScene({ mode: 'campaign', theme: 'forest' });
  sound.unlock();
  assert.equal(timer.pending.size, 1);
  sound.setAudible(false);
  assert.equal(timer.pending.size, 0);
  stats.contexts[0].state = 'interrupted';
  sound.setAudible(true);
  await new Promise(setImmediate);
  assert.equal(stats.contexts[0].resumeCalls, 1);
  assert.equal(sound.resumeBlocked, true);
  assert.equal(timer.pending.size, 0);
  for (let i = 0; i < 100; i++) sound.setMusicScene({ mode: 'campaign', theme: 'forest' });
  assert.equal(stats.contexts[0].resumeCalls, 1, 'an interrupted Safari context does not spin on every frame');
  stats.contexts[0].allowed = true;
  sound.unlock();
  await new Promise(setImmediate);
  assert.equal(stats.contexts[0].resumeCalls, 2);
  assert.equal(sound.musicRunning, true);
  assert.equal(timer.pending.size, 1);
  assert.equal(stats.contexts.length, 1, 'recovery keeps the existing audio context');
});
