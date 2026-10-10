import { cancelSpearAim, createDuelState, DUEL_WAVE_HITS_REQUIRED, DUEL_WAVE_REACH,
  SPEARS_PER_DUEL, SPEARS_PER_LEVEL, SPEAR_AIM_STEP, SPEAR_MAX_ANGLE, SPEAR_MIN_ANGLE,
  TICK_RATE } from '../shared/combat.js';
import { BOSS_EQUIPMENT, getEquipment } from '../shared/equipment.js';
import { LEVELS, MAX_LEVEL, THEMES, getLevel } from '../shared/levels.js';
import { avatarFromCamera, avatarFromFile } from './avatar.js';
import { CampaignSession } from './campaign.js';
import { createRenderer } from './render.js';

const IDS = [
  'game-canvas', 'fight-hud', 'screen-overlay', 'overlay-title', 'overlay-body',
  'overlay-primary', 'overlay-secondary', 'campaign-button', 'duel-button',
  'campaign-panel', 'duel-panel', 'map-grid', 'theme-label', 'stage-label',
  'stage-title', 'stage-subtitle', 'player-health', 'player-health-text',
  'opponent-health', 'opponent-health-text', 'player-name', 'opponent-name',
  'match-clock', 'session-status', 'checkpoint-label', 'progress-label',
  'room-code', 'room-input', 'create-room', 'join-room', 'copy-room',
  'room-message', 'leave-room', 'rematch', 'sound-toggle', 'toast',
  'special-status', 'special-key-guide', 'special-button',
  'spear-status', 'spear-key-guide', 'spear-guide-remaining',
  'spear-button', 'spear-aim-controls', 'spear-angle',
  'aim-up-button', 'aim-down-button', 'aim-cancel-button', 'touch-tip',
  'equipment-status', 'equipment-brief', 'equipment-count', 'equipment-key-guide',
  'equipment-button', 'backpack-open', 'backpack-dialog', 'backpack-close',
  'backpack-list', 'backpack-message',
  'replay-exit', 'avatar-open', 'avatar-chip-default', 'avatar-chip-photo',
  'avatar-dialog', 'avatar-close', 'avatar-preview-default', 'avatar-preview',
  'avatar-upload', 'avatar-camera', 'avatar-camera-fallback', 'avatar-file',
  'avatar-camera-file', 'avatar-camera-view', 'avatar-video', 'avatar-shutter',
  'avatar-stop-camera', 'avatar-message', 'avatar-reset',
];
const ui = Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)]));
for (const id of IDS) {
  if (!ui[id]) throw new Error(`Game interface is missing #${id}`);
}
const themeSelect = document.getElementById('duel-theme');
const renderer = createRenderer(ui['game-canvas']);
const campaign = new CampaignSession();
let campaignView = campaign.start();
let campaignPaused = true;
let mode = 'campaign';
let lastFrameAt = performance.now();
let accumulator = 0;
let lastHudAt = 0;
let toastTimer;
let resultOverlayTimer = null;
let overlayPrimaryAction = null;
let overlaySecondaryAction = null;
let sceneToken = 0;
let avatarDialogOpen = false;
let avatarPausedCampaign = false;
let avatarPreviousFocus = null;
let backpackDialogOpen = false;
let backpackPausedCampaign = false;
let backpackPreviousFocus = null;
let avatarRequestId = 0;
let cameraRequestId = 0;
let cameraStream = null;

const keyboard = new Set();
const pointerButtons = new Map();
const campaignPresses = new Set();
let pendingSpearPresses = 0;
let spearNeedsReleaseTick = false;
const campaignActions = new Set([
  'jump', 'attack', 'kick', 'dodge', 'special', 'spear', 'equipment',
  'aimUp', 'aimDown', 'aimCancel',
]);
const keyBindings = new Map([
  ['KeyA', 'left'], ['ArrowLeft', 'left'],
  ['KeyD', 'right'], ['ArrowRight', 'right'],
  ['KeyW', 'aimUp'], ['ArrowUp', 'jump'],
  ['KeyS', 'aimDown'], ['ArrowDown', 'aimDown'],
  ['KeyJ', 'attack'], ['KeyK', 'kick'], ['KeyL', 'special'], ['KeyI', 'spear'],
  ['KeyE', 'equipment'], ['Space', 'jump'],
  ['Escape', 'aimCancel'],
  ['ShiftLeft', 'dodge'], ['ShiftRight', 'dodge'],
]);
let aimDrag = null;
let pendingAimAngle = null;
let duelRequestedAimAngle = null;

const duel = {
  socket: null, connection: null, code: null, role: null, theme: 'city',
  phase: 'idle', state: null, previousState: null, receivedAt: 0,
  inputSeq: 0, lastInputAt: 0, seenEvents: new Set(),
};

const MILESTONE_BOSS_SKILLS = Object.freeze([
  '远程投石', '召唤援兵', '震地冲击', '双石连投', '短暂护体',
]);

class SoundEffects {
  static musicScores = Object.freeze({
    // Eight eighth-notes and a four-bar harmonic turn keep each setting recognizable
    // without fetching or shipping third-party recordings.
    forest: { root: 146.83, bpm: 96, melody: [0, 4, 7, 9, 7, 4, 2, null], chords: [0, 5, 3, -2], shape: 'sine' },
    city: { root: 130.81, bpm: 112, melody: [0, 3, 7, 10, 7, 5, 3, null], chords: [0, 3, -2, 5], shape: 'triangle' },
    ocean: { root: 110, bpm: 82, melody: [0, 2, 5, 7, 9, 7, 5, null], chords: [0, 5, 2, -3], shape: 'sine' },
    land: { root: 123.47, bpm: 100, melody: [0, 3, 5, 6, 10, 6, 5, null], chords: [0, -2, 3, -4], shape: 'triangle' },
  });

  constructor() {
    this._enabled = true;
    this.audible = true;
    this.unlocked = false;
    this.context = null;
    this.output = null;
    this.resuming = null;
    this.resumeBlocked = false;
    this.pendingKOs = new Set();
    this.pendingCues = new Set();
    this.cueGeneration = 0;
    this.voices = new Set();
    this.maxVoices = 24;
    this.musicScene = null;
    this.musicBus = null;
    this.musicTimer = null;
    this.musicGeneration = 0;
    this.musicRunning = false;
    this.musicBlocked = false;
    this.musicVoices = new Set();
    this.maxMusicVoices = 6;
    this.musicLevel = 0.28;
    this.musicDuckLevel = 0.08;
    this.musicDuckCurve = null;
    this.musicBeatIndex = 0;
    this.musicNextAt = 0;
  }

  get enabled() { return this._enabled; }

  set enabled(value) {
    const next = Boolean(value);
    if (next === this._enabled) return;
    this._enabled = next;
    if (!next) this.cancelPendingKOs();
    if (this.output) this.output.gain.value = next ? 0.64 : 0;
    if (next) this.startMusic();
  }

  setAudible(value) {
    const next = Boolean(value);
    if (next === this.audible) return;
    this.audible = next;
    if (!next) this.cancelPendingKOs();
    else this.startMusic();
  }

  unlock() {
    // Only called from a real pointer/key gesture or from the sound button.
    this.unlocked = true;
    this.resumeBlocked = false;
    this.musicBlocked = false;
    const context = this.getContext();
    if (context?.state === 'running') this.startMusic();
  }

  getContext() {
    if (!this.enabled || !this.audible) return null;
    if (this.resumeBlocked && this.context?.state !== 'running') return null;
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) return null;
    if (!this.context) {
      let createdContext;
      try {
        createdContext = new AudioContextType();
        const output = createdContext.createGain();
        output.gain.value = 0.64;
        // A shared bus keeps overlapping hits punchy without clipping the output.
        const compressor = createdContext.createDynamicsCompressor?.();
        if (compressor) {
          compressor.threshold.value = -18;
          compressor.knee.value = 18;
          compressor.ratio.value = 4;
          compressor.attack.value = 0.004;
          compressor.release.value = 0.16;
          output.connect(compressor).connect(createdContext.destination);
        } else {
          output.connect(createdContext.destination);
        }
        this.context = createdContext;
        this.output = output;
      } catch {
        try { createdContext?.close?.()?.catch?.(() => {}); } catch { /* Optional cleanup. */ }
        this.context = null;
        this.output = null;
        this.resumeBlocked = true;
        return null;
      }
    }
    if (['suspended', 'interrupted'].includes(this.context.state) && !this.resuming) {
      try {
        this.resuming = Promise.resolve(this.context.resume())
          .then(() => {
            if (this.context?.state === 'running') {
              this.resumeBlocked = false;
              this.startMusic();
            } else {
              this.resumeBlocked = true;
              this.cancelPendingKOs();
            }
          })
          .catch(() => {
            this.resumeBlocked = true;
            this.cancelPendingKOs();
          })
          .finally(() => { this.resuming = null; });
      } catch {
        this.resumeBlocked = true;
        this.cancelPendingKOs();
        return null;
      }
    }
    if (this.resumeBlocked && this.context.state !== 'running') return null;
    if (this.context.state !== 'running' && !this.resuming) return null;
    return this.context;
  }

  setMusicScene(scene) {
    const next = scene && SoundEffects.musicScores[scene.theme]
      ? { mode: scene.mode === 'duel' ? 'duel' : 'campaign',
        theme: scene.theme, boss: Boolean(scene.boss) }
      : null;
    if (this.musicScene?.mode === next?.mode && this.musicScene?.theme === next?.theme
      && this.musicScene?.boss === next?.boss) {
      if (next) this.startMusic();
      return;
    }
    this.stopMusic();
    this.musicScene = next;
    this.musicBlocked = false;
    this.startMusic();
  }

  stopMusicVoice(voice) {
    this.musicVoices.delete(voice);
    try { voice.source.stop(); } catch { /* Already ended or never started. */ }
    try { voice.source.disconnect(); } catch { /* Already disconnected. */ }
    try { voice.gain.disconnect(); } catch { /* Already disconnected. */ }
  }

  stopMusic() {
    this.musicGeneration++;
    if (this.musicTimer !== null) window.clearTimeout(this.musicTimer);
    this.musicTimer = null;
    this.musicRunning = false;
    this.musicDuckCurve = null;
    for (const voice of [...this.musicVoices]) this.stopMusicVoice(voice);
    if (this.musicBus) {
      const gain = this.musicBus.gain;
      gain.cancelScheduledValues?.(this.context?.currentTime ?? 0);
      gain.value = this.musicLevel;
    }
  }

  musicTone(context, frequency, at, seconds, volume, shape) {
    for (const voice of this.musicVoices) {
      if (voice.endsAt <= context.currentTime) this.stopMusicVoice(voice);
    }
    if (this.musicVoices.size >= this.maxMusicVoices) return;
    const source = context.createOscillator();
    const gain = context.createGain();
    source.type = shape;
    source.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(volume, at + Math.min(0.018, seconds * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    const voice = { source, gain, endsAt: at + seconds + 0.01 };
    this.musicVoices.add(voice);
    source.onended = () => {
      this.musicVoices.delete(voice);
      try { source.disconnect(); } catch { /* Already disconnected. */ }
      try { gain.disconnect(); } catch { /* Already disconnected. */ }
    };
    source.connect(gain).connect(this.musicBus);
    source.start(at);
    source.stop(at + seconds + 0.01);
  }

  musicBeat(context, at, stepSeconds) {
    const score = SoundEffects.musicScores[this.musicScene.theme];
    const beat = this.musicBeatIndex % score.melody.length;
    const bar = Math.floor(this.musicBeatIndex / score.melody.length);
    const root = score.root * 2 ** (score.chords[bar % score.chords.length] / 12);
    const note = score.melody[beat];
    if (note !== null) this.musicTone(context, root * 2 ** ((note + 12) / 12), at,
      stepSeconds * 0.79, 0.028, score.shape);
    if (beat === 0 || beat === 4 || ((this.musicScene.mode === 'duel' || this.musicScene.boss) && beat % 2 === 0)) {
      this.musicTone(context, root / 2, at, stepSeconds * 0.9, 0.022, 'sine');
    }
    if ((this.musicScene.mode === 'duel' || this.musicScene.boss) && (beat === 2 || beat === 6)) {
      this.musicTone(context, root * 4, at, stepSeconds * 0.16, 0.006, 'sine');
    }
    this.musicBeatIndex++;
  }

  startMusic() {
    if (this.musicRunning || this.musicBlocked || !this.musicScene
      || !this.unlocked || !this.enabled || !this.audible) return;
    const context = this.getContext();
    // A denied or pending browser resume must never spin a silent JS loop.
    if (!context || context.state !== 'running') return;
    try {
      if (!this.musicBus) {
        const bus = context.createGain();
        bus.gain.value = this.musicLevel;
        bus.connect(this.output);
        this.musicBus = bus;
      }
      this.musicRunning = true;
      this.musicBeatIndex = 0;
      this.musicNextAt = context.currentTime + 0.012;
      const generation = ++this.musicGeneration;
      const tick = () => {
        this.musicTimer = null;
        if (!this.musicRunning || generation !== this.musicGeneration) return;
        if (!this.enabled || !this.audible || context.state !== 'running') {
          this.stopMusic();
          return;
        }
        try {
          const score = SoundEffects.musicScores[this.musicScene.theme];
          const stepSeconds = 30 / (score.bpm * (this.musicScene.mode === 'duel' ? 1.12 : 1)
            * (this.musicScene.boss ? 1.07 : 1));
          const at = Math.max(context.currentTime + 0.012, this.musicNextAt);
          this.musicBeat(context, at, stepSeconds);
          this.musicNextAt = at + stepSeconds;
          // One bounded scheduler, using the audio clock so delayed tabs skip beats instead of bursting.
          this.musicTimer = window.setTimeout(tick,
            Math.max(40, Math.min(600, (this.musicNextAt - context.currentTime - 0.06) * 1000)));
        } catch {
          this.musicBlocked = true;
          this.stopMusic(); // A partial Web Audio implementation must not break the game.
        }
      };
      tick();
    } catch {
      this.musicBlocked = true;
      this.stopMusic(); // Music is optional on unsupported devices.
    }
  }

  duckMusic() {
    if (!this.musicRunning || !this.musicBus || !this.context) return;
    const at = this.context.currentTime;
    const gain = this.musicBus.gain;
    const prior = this.musicDuckCurve;
    const age = Math.max(0, at - (prior?.at ?? at));
    const heldLevel = !prior || age >= 0.42 ? this.musicLevel
      : age < 0.02 ? prior.from + (this.musicDuckLevel - prior.from) * age / 0.02
        : this.musicDuckLevel + (this.musicLevel - this.musicDuckLevel) * (age - 0.02) / 0.4;
    if (typeof gain.cancelAndHoldAtTime === 'function') {
      gain.cancelAndHoldAtTime(at);
    } else {
      // Older implementations lack hold; reconstruct the current curve instead
      // of jumping back up to the un-ducked level on every rapid punch.
      gain.cancelScheduledValues?.(at);
      gain.setValueAtTime(heldLevel, at);
    }
    gain.linearRampToValueAtTime(this.musicDuckLevel, at + 0.02);
    gain.linearRampToValueAtTime(this.musicLevel, at + 0.42);
    this.musicDuckCurve = { at, from: heldLevel };
  }

  hasVoiceRoom(context, priority) {
    for (const voice of this.voices) {
      if (voice.endsAt <= context.currentTime) this.stopVoice(voice);
    }
    if (this.voices.size < this.maxVoices) return true;
    if (!priority) return false;
    const quietVoice = [...this.voices].find((voice) => voice.priority < priority);
    if (!quietVoice) return false;
    this.stopVoice(quietVoice);
    return true;
  }

  stopVoice(voice) {
    this.voices.delete(voice);
    try { voice.source.stop?.(); } catch { /* The voice may already have ended. */ }
    this.disconnectVoice(voice);
  }

  disconnectVoice(voice) {
    for (const node of new Set([voice.source, voice.input, voice.gain])) {
      try { node.disconnect?.(); } catch { /* A disconnected node is harmless. */ }
    }
  }

  connectVoice(context, source, gain, seconds, priority, input = source) {
    const voice = { source, input, gain, priority, endsAt: context.currentTime + seconds + 0.02 };
    this.voices.add(voice);
    source.onended = () => {
      this.voices.delete(voice);
      this.disconnectVoice(voice);
    };
    input.connect(gain).connect(this.output);
    source.start(context.currentTime);
    source.stop?.(context.currentTime + seconds + 0.01);
  }

  tone(frequency, endFrequency, seconds, volume = 0.1, shape = 'triangle', priority = 0) {
    const context = this.getContext();
    if (!context || !this.hasVoiceRoom(context, priority)) return;
    const time = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = shape;
    oscillator.frequency.setValueAtTime(frequency, time);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), time + seconds);
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(volume, time + Math.min(0.008, seconds * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.001, time + seconds);
    this.connectVoice(context, oscillator, gain, seconds, priority);
  }

  noise(seconds = 0.075, volume = 0.07, cutoff = 0, filterType = 'lowpass', priority = 0) {
    const context = this.getContext();
    if (!context || !this.hasVoiceRoom(context, priority)) return;
    const count = Math.ceil(context.sampleRate * seconds);
    const buffer = context.createBuffer(1, count, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / count);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    if (cutoff > 0) {
      const filter = context.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = cutoff;
      source.connect(filter);
      this.connectVoice(context, source, gain, seconds, priority, filter);
    } else {
      this.connectVoice(context, source, gain, seconds, priority);
    }
  }

  cancelPendingKOs() {
    this.cueGeneration++;
    for (const timer of this.pendingKOs) window.clearTimeout(timer);
    this.pendingKOs.clear();
    for (const timer of this.pendingCues) window.clearTimeout(timer);
    this.pendingCues.clear();
    // Called by the existing mute/round/mode transitions: no old tail can leak into a new scene.
    for (const voice of [...this.voices]) this.stopVoice(voice);
    this.stopMusic();
  }

  queueCue(delay, callback, pending = this.pendingCues) {
    const generation = this.cueGeneration;
    const timer = window.setTimeout(() => {
      pending.delete(timer);
      if (this.enabled && generation === this.cueGeneration) callback();
    }, delay);
    pending.add(timer);
  }

  tomatoSplat() {
    // A low plop under filtered, quickly fading noise reads as a soft, wet splat.
    this.tone(210, 68, 0.14, 0.065, 'sine', 1);
    this.noise(0.11, 0.048, 1050, 'lowpass', 1);
  }

  play(effect) {
    if (!this.enabled || !this.audible) return;
    if ((effect.type === 'hit' && !effect.special && effect.delivery !== 'duel-wave')
      || ['ko', 'special-wave', 'duel-wave', 'boss-quake', 'campaign-fail'].includes(effect.type)) this.duckMusic();
    switch (effect.type) {
      case 'hit':
        if (effect.special || effect.delivery === 'duel-wave') break; // The light wave already has its own impact sound.
        if (effect.delivery === 'rock') {
          this.noise(0.082, 0.044, 1650, 'lowpass');
          this.tone(350, 105, 0.12, 0.065, 'triangle');
          break;
        }
        // Only confirmed damage gets an audible wind/body hit; a whiff keeps visual wind only.
        this.noise(effect.heavy ? 0.1 : 0.065, effect.heavy ? 0.068 : 0.048, 900, 'highpass');
        this.tone(effect.heavy ? 132 : 185, effect.heavy ? 45 : 72,
          effect.heavy ? 0.18 : 0.115, effect.heavy ? 0.145 : 0.105, 'sine');
        this.tone(effect.heavy ? 266 : 310, effect.heavy ? 74 : 116,
          effect.heavy ? 0.105 : 0.075, effect.heavy ? 0.055 : 0.035, 'triangle');
        if (effect.delivery === 'equipment') this.tone(760, 280, 0.11, 0.027, 'triangle');
        break;
      case 'equipment-swing':
        // A quiet metallic sweep announces the selected weapon; only a real
        // contact receives the foreground impact sound above.
        this.noise(0.09, 0.022, 1700, 'highpass');
        this.tone(540, 340, 0.1, 0.025, 'triangle');
        break;
      case 'equipment-drop':
        this.tone(720, 960, 0.17, 0.021, 'sine');
        break;
      case 'equipment-pickup':
        if (!effect.duplicate) {
          this.tone(490, 735, 0.15, 0.041, 'triangle');
          this.tone(820, 1120, 0.2, 0.026, 'sine');
        }
        break;
      case 'special-wave':
      case 'duel-wave':
        this.tone(170, 540, 0.28, 0.08, 'sawtooth', 1);
        this.tone(105, 58, 0.34, 0.11, 'sine', 1);
        this.noise(0.17, 0.055, 1800, 'lowpass', 1);
        this.tone(740, 460, 0.42, 0.048, 'triangle', 1);
        this.queueCue(105, () => this.tone(940, 675, 0.24, 0.038, 'sine', 1));
        break;
      case 'special-ready':
      case 'duel-wave-ready':
        this.tone(520, 880, 0.17, 0.045);
        this.tone(1040, 1320, 0.21, 0.022, 'sine');
        break;
      case 'boss-windup':
        this.tone(92, 128, 0.19, 0.048, 'sine', 1);
        this.tone(310, 440, 0.22, 0.028, 'triangle', 1);
        break;
      case 'rock-windup':
        this.tone(290, 190, 0.16, 0.023, 'triangle');
        break;
      case 'boss-rock-windup':
        this.tone(105, 148, 0.27, 0.045, 'sine', 1);
        this.noise(0.095, 0.018, 650, 'lowpass');
        break;
      case 'rock-throw':
      case 'boss-rock-throw':
        this.noise(0.13, effect.type === 'boss-rock-throw' ? 0.042 : 0.028,
          1250, 'highpass');
        this.tone(effect.type === 'boss-rock-throw' ? 210 : 320, 110,
          0.13, 0.036, 'triangle');
        break;
      case 'rock-impact':
        // Confirmed character damage has its own dry hit; don't double it.
        if (effect.target && !effect.blocked) break;
        this.tone(310, 92, 0.13, 0.048, 'triangle');
        this.noise(0.06, 0.023, 1100, 'lowpass');
        break;
      case 'boss-summon-windup':
        this.tone(155, 265, 0.3, 0.036, 'sine', 1);
        this.tone(410, 530, 0.28, 0.018, 'triangle');
        break;
      case 'boss-summon':
        this.tone(460, 305, 0.12, 0.027, 'triangle');
        break;
      case 'boss-quake-windup':
        this.tone(78, 135, 0.31, 0.048, 'sine', 1);
        break;
      case 'boss-quake':
        this.tone(100, 42, 0.35, 0.12, 'sine', 1);
        this.noise(0.2, 0.052, 800, 'lowpass', 1);
        break;
      case 'boss-ward-windup':
        this.tone(410, 610, 0.23, 0.028, 'triangle');
        break;
      case 'boss-ward':
        this.tone(620, 940, 0.18, 0.045, 'sine', 1);
        break;
      case 'boss-ward-hit':
        this.tone(810, 380, 0.12, 0.042, 'triangle', 1);
        break;
      case 'spear-aim': this.tone(330, 440, 0.12, 0.026); break;
      case 'spear-windup': this.tone(220, 340, 0.16, 0.028); break;
      case 'spear-throw':
        this.tone(690, 220, 0.18, 0.046, 'triangle');
        this.noise(0.095, 0.044, 1100, 'highpass');
        break;
      case 'spear-impact':
        if (effect.blocked) this.tone(470, 160, 0.09, 0.025);
        break;
      case 'ko': {
        // KO arrives when the fighter falls. The tomato lands on the head ~180 ms later.
        this.tone(125, 75, 0.11, 0.025, 'sine', 1);
        this.queueCue(180, () => this.tomatoSplat(), this.pendingKOs);
        break;
      }
      case 'bones-scatter':
        // A brief dry rattle distinguishes the playful skeleton gag from the wet tomato.
        this.tone(560, 230, 0.1, 0.035, 'triangle');
        this.tone(790, 350, 0.075, 0.018, 'sine');
        this.noise(0.06, 0.025, 2400);
        break;
      case 'jump': this.tone(260, 410, 0.11, 0.035); break;
      case 'kick':
        this.tone(280, 130, 0.105, 0.04);
        this.noise(0.073, 0.035, 950, 'highpass');
        break;
      case 'jump-kick':
        // The same jade overtone returns in the light wave, without pretending a kick hit.
        this.noise(0.1, 0.04, 820, 'highpass', 1);
        this.tone(410, 850, 0.15, 0.048, 'triangle', 1);
        this.tone(1120, 790, 0.23, 0.033, 'sine', 1);
        break;
      case 'fall-impact':
        this.tone(effect.kind === 'hail' ? 650 : 260, effect.kind === 'hail' ? 185 : 82,
          0.085, 0.025, effect.kind === 'hail' ? 'triangle' : 'sine');
        this.noise(0.045, 0.018, effect.kind === 'hail' ? 3400 : 1300);
        break;
      case 'land': this.tone(110, 60, 0.08, 0.04); break;
      case 'dodge': this.noise(0.11, 0.04); break;
      case 'level-clear':
        this.tone(440, 660, 0.19, 0.09, 'triangle', 1);
        this.queueCue(115, () => this.tone(550, 880, 0.21, 0.08, 'triangle', 1));
        break;
      case 'campaign-fail': this.tone(220, 75, 0.33, 0.09); break;
      default: break;
    }
  }
}
const sound = new SoundEffects();
sound.setAudible(!document.hidden);
function syncMusic() {
  const campaignPlaying = mode === 'campaign' && !campaignPaused
    && ['playing', 'aftermath'].includes(campaignView.phase);
  const duelPlaying = mode === 'duel' && duel.phase === 'playing' && Boolean(duel.code);
  sound.setMusicScene(campaignPlaying ? {
    mode, theme: campaignView.level.theme,
    boss: campaignView.combat?.fighters.some((fighter) => fighter.kind === 'boss' && fighter.hp > 0),
  } : duelPlaying ? { mode, theme: duel.theme, boss: false } : null);
}
const unlockAudio = (event) => {
  if (!sound.enabled || document.hidden || (event?.type === 'keydown' && event.repeat)) return;
  // A gesture also restores focus after the browser had suspended background audio.
  sound.setAudible(true);
  sound.unlock();
  syncMusic();
};
// Keep these lightweight: a later gesture can recover after a denied browser resume.
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);

function notify(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { ui.toast.hidden = true; }, 3200);
}

function showOverlay({ title, body, primary, onPrimary, secondary, onSecondary }) {
  ui['screen-overlay'].hidden = false;
  ui['overlay-title'].textContent = title;
  ui['overlay-body'].textContent = body ?? '';
  ui['overlay-primary'].hidden = !primary;
  ui['overlay-secondary'].hidden = !secondary;
  if (primary) ui['overlay-primary'].textContent = primary;
  if (secondary) ui['overlay-secondary'].textContent = secondary;
  overlayPrimaryAction = onPrimary ?? null;
  overlaySecondaryAction = onSecondary ?? null;
}

function hideOverlay() {
  ui['screen-overlay'].hidden = true;
  overlayPrimaryAction = null;
  overlaySecondaryAction = null;
}

function cancelResultOverlay() {
  if (resultOverlayTimer !== null) window.clearTimeout(resultOverlayTimer);
  resultOverlayTimer = null;
}

function showAfterKOResult(events, action) {
  cancelResultOverlay();
  if (!(events ?? []).some((event) => event.type === 'ko')) return action();
  // Keep the fallen fighter and tomato visible before covering the canvas.
  const reducedMotion = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  resultOverlayTimer = window.setTimeout(() => {
    resultOverlayTimer = null;
    action();
  }, reducedMotion ? 300 : 650);
}

ui['overlay-primary'].addEventListener('click', () => overlayPrimaryAction?.());
ui['overlay-secondary'].addEventListener('click', () => overlaySecondaryAction?.());

function currentInput() {
  const held = new Set([...keyboard, ...pointerButtons.values()]);
  return {
    left: held.has('left'), right: held.has('right'),
    attack: held.has('attack'), kick: held.has('kick'),
    jump: held.has('jump'), dodge: held.has('dodge'),
    special: held.has('special'), spear: held.has('spear'),
    equipment: held.has('equipment'),
    aimUp: held.has('aimUp'), aimDown: held.has('aimDown'),
    aimCancel: held.has('aimCancel'),
  };
}

function queueCampaignPress(button) {
  if (mode === 'campaign' && !campaignPaused
    && (campaignView.phase === 'playing' || (campaignView.phase === 'aftermath' && button === 'jump'))
    && campaignActions.has(button)) {
    // Keep distinct I taps even when both land between two simulation frames.
    if (button === 'spear') {
      if (campaignView.spearRemaining > 0) pendingSpearPresses = Math.min(2, pendingSpearPresses + 1);
    } else {
      // A cancellation must also discard a second I tap still waiting behind
      // the release tick, otherwise it can silently start a new aim afterward.
      if (['aimCancel', 'jump', 'attack', 'kick', 'dodge', 'equipment'].includes(button)) pendingSpearPresses = 0;
      campaignPresses.add(button);
    }
  }
}

function campaignInput() {
  const input = currentInput();
  // Spear is a command, not a held action. A real release tick separates two
  // queued taps so combat sees two edges without a long hold auto-confirming.
  input.spear = false;
  // Combat skips control sampling for the entire hitstop tick, including 1 -> 0.
  // Keep short presses until the following tick can actually consume them.
  if (campaignView.combat?.hitstop > 0) return input;
  for (const button of campaignPresses) input[button] = true;
  campaignPresses.clear();
  if (spearNeedsReleaseTick) spearNeedsReleaseTick = false;
  else if (pendingSpearPresses > 0) {
    pendingSpearPresses--;
    input.spear = true;
    spearNeedsReleaseTick = true;
  }
  if (Number.isFinite(pendingAimAngle)) {
    input.aimAngle = pendingAimAngle;
    pendingAimAngle = null;
  }
  return input;
}

function localDuelFighter() {
  return duel.state?.fighters.find((fighter) => fighter.id === duel.role);
}

function nudgeDuelAim(button) {
  if (mode !== 'duel' || duel.phase !== 'playing'
      || (button !== 'aimUp' && button !== 'aimDown')) return;
  const fighter = localDuelFighter();
  if (!fighter?.spearAiming) return;
  // A tap shorter than the server tick still changes the angle. Retain this
  // bounded absolute target through hitstop and short press/release packets;
  // a held key resumes continuous adjustment after the snapshot acknowledges it.
  const current = Number.isFinite(duelRequestedAimAngle)
    ? duelRequestedAimAngle : fighter.spearAimAngle;
  duelRequestedAimAngle = Math.max(SPEAR_MIN_ANGLE, Math.min(SPEAR_MAX_ANGLE,
    current + (button === 'aimUp' ? SPEAR_AIM_STEP : -SPEAR_AIM_STEP)));
  updateAimAngle(fighter, duelRequestedAimAngle);
}

function localDuelAction(button) {
  if (mode !== 'duel' || duel.phase !== 'playing') return;
  if (button === 'aimCancel') {
    duelRequestedAimAngle = null;
    aimDrag = null;
    ui['game-canvas'].classList.remove('is-aim-dragging');
  }
}

function reconcileDuelAim() {
  const fighter = localDuelFighter();
  if (!fighter?.spearAiming || (Number.isFinite(duelRequestedAimAngle)
      && Math.abs(fighter.spearAimAngle - duelRequestedAimAngle) < 0.15)) {
    duelRequestedAimAngle = null;
  }
}

function sendInput(force = false, cancelAim = false) {
  if (mode !== 'duel' || duel.phase !== 'playing' || duel.socket?.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  if (!force && now - duel.lastInputAt < 48) return;
  duel.lastInputAt = now;
  const held = currentInput();
  if (cancelAim) held.aimCancel = true;
  // The server whitelists these PvP controls, owns every resource and samples
  // short spear/special edges; equipment and campaign-only state never travel.
  const input = Object.fromEntries(['left', 'right', 'jump', 'attack', 'kick', 'dodge',
    'special', 'spear', 'aimUp', 'aimDown', 'aimCancel']
    .map((button) => [button, held[button]]));
  if (localDuelFighter()?.spearAiming && Number.isFinite(duelRequestedAimAngle)) {
    input.aimAngle = duelRequestedAimAngle;
  }
  duel.socket.send(JSON.stringify({ type: 'input', seq: duel.inputSeq++, input }));
}

document.addEventListener('keydown', (event) => {
  if (event.code === 'KeyB' && mode === 'campaign' && !avatarDialogOpen) {
    event.preventDefault();
    if (!event.repeat) backpackDialogOpen ? closeBackpackDialog() : openBackpackDialog();
    return;
  }
  if (backpackDialogOpen) return;
  if (avatarDialogOpen) return;
  const button = keyBindings.get(event.code);
  if (!button) return;
  if (document.activeElement === ui['room-input']) return;
  event.preventDefault();
  if (!event.repeat) {
    keyboard.add(button);
    queueCampaignPress(button);
    localDuelAction(button);
    nudgeDuelAim(button);
    sendInput(true);
  }
});
document.addEventListener('keyup', (event) => {
  if (avatarDialogOpen || backpackDialogOpen) return;
  const button = keyBindings.get(event.code);
  if (!button) return;
  event.preventDefault();
  keyboard.delete(button);
  sendInput(true);
});
for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('pointerdown', (event) => {
    if (button.disabled || button.hidden) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    pointerButtons.set(event.pointerId, button.dataset.key);
    queueCampaignPress(button.dataset.key);
    localDuelAction(button.dataset.key);
    nudgeDuelAim(button.dataset.key);
    button.classList.add('is-pressed');
    sendInput(true);
  });
  const release = (event) => {
    pointerButtons.delete(event.pointerId);
    if (![...pointerButtons.values()].includes(button.dataset.key)) button.classList.remove('is-pressed');
    sendInput(true);
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}
const aftermathActionButtons = [...document.querySelectorAll('[data-key]')]
  .filter((button) => ['attack', 'kick', 'dodge'].includes(button.dataset.key));

// Dragging the battlefield only adjusts the elevation in either mode. A
// release never fires a spear: the explicit second I / 发射 remains the commit.
ui['game-canvas'].addEventListener('pointerdown', (event) => {
  const hero = mode === 'campaign'
    ? campaignView.combat?.fighters.find((fighter) => fighter.team === 0)
    : localDuelFighter();
  const fighting = mode === 'campaign'
    ? !campaignPaused && campaignView.phase === 'playing' : duel.phase === 'playing';
  if (!fighting || !hero?.spearAiming || aimDrag) return;
  event.preventDefault();
  ui['game-canvas'].setPointerCapture(event.pointerId);
  aimDrag = { pointerId: event.pointerId, startY: event.clientY,
    startAngle: Number.isFinite(mode === 'campaign' ? pendingAimAngle : duelRequestedAimAngle)
      ? (mode === 'campaign' ? pendingAimAngle : duelRequestedAimAngle) : hero.spearAimAngle };
  ui['game-canvas'].classList.add('is-aim-dragging');
});
ui['game-canvas'].addEventListener('pointermove', (event) => {
  if (!aimDrag || aimDrag.pointerId !== event.pointerId) return;
  const hero = mode === 'campaign'
    ? campaignView.combat?.fighters.find((fighter) => fighter.team === 0)
    : localDuelFighter();
  if (!hero?.spearAiming || !Number.isFinite(event.clientY)) return;
  event.preventDefault();
  const angle = Math.max(SPEAR_MIN_ANGLE, Math.min(SPEAR_MAX_ANGLE,
    aimDrag.startAngle + (aimDrag.startY - event.clientY) * 0.22));
  if (mode === 'campaign') pendingAimAngle = angle;
  else {
    duelRequestedAimAngle = angle;
    updateAimAngle(hero, angle);
    sendInput();
  }
});
function endAimDrag(event) {
  if (!aimDrag || aimDrag.pointerId !== event.pointerId) return;
  aimDrag = null;
  if (mode === 'campaign' && event.type === 'pointercancel') pendingAimAngle = null;
  ui['game-canvas'].classList.remove('is-aim-dragging');
  if (mode === 'duel') sendInput(true);
}
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  ui['game-canvas'].addEventListener(type, endAimDrag);
}

function releaseInput(cancelAim = false) {
  keyboard.clear();
  pointerButtons.clear();
  campaignPresses.clear();
  pendingSpearPresses = 0;
  spearNeedsReleaseTick = false;
  for (const button of document.querySelectorAll('[data-key]')) button.classList.remove('is-pressed');
  aimDrag = null;
  pendingAimAngle = null;
  duelRequestedAimAngle = null;
  ui['game-canvas'].classList.remove('is-aim-dragging');
  if (cancelAim && mode === 'campaign') {
    const hero = campaignView.combat?.fighters.find((fighter) => fighter.team === 0);
    if (hero?.spearAiming) cancelSpearAim(hero);
    // A blur/mode change can happen between ticks. Clear the sampled I edge so
    // the first fresh press after returning is not mistaken for a held key.
    if (hero?.prevInput) {
      hero.prevInput.spear = false;
      hero.prevInput.equipment = false;
    }
    updateCampaignHud();
  }
  if (cancelAim && mode === 'duel') {
    // A blur/hidden tab must cancel server-owned aim even when an I tap was
    // queued between snapshots. Send a short edge, then the normal released
    // controls so a later Escape can form a new edge.
    sendInput(true, true);
  }
  sendInput(true);
}

function updateAvatarAvailability() {
  const inDuelFight = mode === 'duel' && ['countdown', 'playing'].includes(duel.phase);
  ui['avatar-open'].disabled = inDuelFight;
  ui['avatar-open'].title = inDuelFight
    ? '本局结束后可设置头像' : '设置我的侠客头像：上传照片或拍照';
}

function stopCamera() {
  // Invalidate an outstanding permission request as well as an active stream.
  cameraRequestId++;
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
    cameraStream = null;
  }
  ui['avatar-video'].pause?.();
  ui['avatar-video'].srcObject = null;
  ui['avatar-camera-view'].hidden = true;
  ui['avatar-camera'].disabled = false;
}

function finishAvatarDialog() {
  if (!avatarDialogOpen) return;
  avatarDialogOpen = false;
  avatarRequestId++;
  stopCamera();
  ui['avatar-dialog'].hidden = true;
  avatarPreviousFocus?.focus?.();
  avatarPreviousFocus = null;
  if (avatarPausedCampaign && mode === 'campaign') showMainlineResumeOverlay();
  avatarPausedCampaign = false;
}

function closeAvatarDialog() {
  if (!avatarDialogOpen) return;
  if (ui['avatar-dialog'].open && typeof ui['avatar-dialog'].close === 'function') {
    ui['avatar-dialog'].close();
  } else {
    ui['avatar-dialog'].removeAttribute?.('open');
  }
  finishAvatarDialog();
}

function openAvatarDialog() {
  if (avatarDialogOpen || backpackDialogOpen || ui['avatar-open'].disabled) return;
  avatarPreviousFocus = document.activeElement ?? ui['avatar-open'];
  avatarPausedCampaign = mode === 'campaign' && !campaignPaused
    && ['playing', 'aftermath'].includes(campaignView.phase);
  if (avatarPausedCampaign) campaignPaused = true;
  // Clear held keys in the waiting-room too: their keyup happens inside the
  // dialog and must not become a stuck attack when the PvP countdown starts.
  releaseInput(avatarPausedCampaign);
  if (avatarPausedCampaign) syncMusic();
  ui['avatar-message'].textContent = '选择 JPG、PNG、WebP 或浏览器支持的 HEIC，最大 8 MB。';
  ui['avatar-camera-fallback'].hidden = true;
  ui['avatar-dialog'].hidden = false;
  avatarDialogOpen = true;
  try {
    if (typeof ui['avatar-dialog'].showModal === 'function') ui['avatar-dialog'].showModal();
    else ui['avatar-dialog'].setAttribute('open', '');
    ui['avatar-upload'].focus?.();
  } catch {
    // A browser without usable native dialogs can still expose the same form.
    ui['avatar-dialog'].setAttribute('open', '');
    ui['avatar-upload'].focus?.();
  }
}

function setAvatar(canvas) {
  // The only copies are this page's Canvas pixels and local preview data URLs.
  // No photo enters the campaign save, fighter state, room or WebSocket.
  const preview = canvas?.toDataURL('image/png') ?? '';
  renderer.setAvatar(canvas);
  for (const id of ['avatar-preview', 'avatar-chip-photo']) {
    ui[id].src = preview;
    ui[id].hidden = !canvas;
  }
  ui['avatar-preview-default'].hidden = Boolean(canvas);
  ui['avatar-chip-default'].hidden = Boolean(canvas);
}

async function handleAvatarFile(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file || !avatarDialogOpen) return;
  stopCamera();
  const requestId = ++avatarRequestId;
  ui['avatar-message'].textContent = '正在处理照片…';
  try {
    const canvas = await avatarFromFile(file);
    if (!avatarDialogOpen || requestId !== avatarRequestId) return;
    setAvatar(canvas);
    ui['avatar-message'].textContent = '头像已应用到我方侠客；刷新页面后需重新选择。';
  } catch (error) {
    if (avatarDialogOpen && requestId === avatarRequestId) {
      ui['avatar-message'].textContent = error.message || '照片处理失败，请换一张再试。';
    }
  }
}

async function openCamera() {
  if (!avatarDialogOpen) return;
  avatarRequestId++; // A pending file decode must not replace a newly requested camera shot.
  stopCamera();
  const requestId = cameraRequestId;
  const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (!getUserMedia) {
    ui['avatar-message'].textContent = '此设备或当前访问地址不支持网页相机，可改用系统相机或相册。';
    ui['avatar-camera-fallback'].hidden = false;
    return;
  }
  ui['avatar-camera'].disabled = true;
  ui['avatar-message'].textContent = '正在等待相机授权…';
  let stream;
  try {
    stream = await getUserMedia({ audio: false, video: { facingMode: 'user' } });
    if (!avatarDialogOpen || requestId !== cameraRequestId) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    cameraStream = stream;
    ui['avatar-video'].srcObject = stream;
    ui['avatar-camera-view'].hidden = false;
    await ui['avatar-video'].play?.();
    if (requestId !== cameraRequestId) return;
    ui['avatar-camera-fallback'].hidden = true;
    ui['avatar-message'].textContent = '调整画面后点击“拍照并使用”；视频仅在本页预览。';
  } catch {
    if (requestId !== cameraRequestId) return;
    stopCamera();
    ui['avatar-camera-fallback'].hidden = false;
    ui['avatar-message'].textContent = '无法打开相机或未获授权，请改用系统相机/相册或上传照片。';
  } finally {
    if (requestId === cameraRequestId) ui['avatar-camera'].disabled = false;
  }
}

ui['avatar-open'].addEventListener('click', openAvatarDialog);
ui['avatar-close'].addEventListener('click', closeAvatarDialog);
ui['avatar-dialog'].addEventListener('close', () => {
  // Native close events are queued; an old one must not hide a newly reopened dialog.
  if (!ui['avatar-dialog'].open) finishAvatarDialog();
});
ui['avatar-dialog'].addEventListener('cancel', (event) => {
  event.preventDefault();
  closeAvatarDialog();
});
ui['avatar-dialog'].addEventListener('click', (event) => {
  if (event.target === ui['avatar-dialog']) closeAvatarDialog();
});
ui['avatar-upload'].addEventListener('click', () => {
  stopCamera();
  ui['avatar-file'].click();
});
ui['avatar-camera-fallback'].addEventListener('click', () => {
  stopCamera();
  ui['avatar-camera-file'].click();
});
ui['avatar-file'].addEventListener('change', () => handleAvatarFile(ui['avatar-file']));
ui['avatar-camera-file'].addEventListener('change', () => handleAvatarFile(ui['avatar-camera-file']));
ui['avatar-camera'].addEventListener('click', openCamera);
ui['avatar-stop-camera'].addEventListener('click', () => {
  stopCamera();
  ui['avatar-message'].textContent = '相机已关闭；可重新拍照或上传照片。';
});
ui['avatar-shutter'].addEventListener('click', () => {
  if (!cameraStream) return;
  try {
    const canvas = avatarFromCamera(ui['avatar-video']);
    avatarRequestId++;
    setAvatar(canvas);
    stopCamera();
    ui['avatar-message'].textContent = '照片已应用到我方侠客；刷新页面后需重新选择。';
  } catch (error) {
    ui['avatar-message'].textContent = error.message || '拍摄失败，请再试一次。';
  }
});
ui['avatar-reset'].addEventListener('click', () => {
  avatarRequestId++;
  stopCamera();
  setAvatar(null);
  ui['avatar-message'].textContent = '已恢复默认侠客表情；刷新页面也不会保存照片。';
});

const EQUIPMENT_GLYPHS = Object.freeze({
  sweep: '刃', pierce: '刺', pulse: '印',
});

function renderBackpackList() {
  const items = (campaignView.inventory ?? []).map(getEquipment).filter(Boolean);
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'backpack-empty';
    empty.textContent = '背包还是空的。第 10 关起击败首领会掉落装备；走近自动拾取，过关前没走到也会收纳。';
    fragment.append(empty);
  }
  for (const item of items) {
    const selected = item.id === campaignView.equippedEquipmentId;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'backpack-item';
    button.style.setProperty('--equipment-color', item.color);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `${item.name}，${item.tier} 阶，伤害 ${item.damage}，射程 ${item.reach}，冷却 ${(item.cooldown / TICK_RATE).toFixed(1)} 秒，${selected ? '当前装备' : '点击装备'}`);
    const mark = document.createElement('span');
    mark.className = 'backpack-item__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = EQUIPMENT_GLYPHS[item.style] ?? '器';
    const copy = document.createElement('span');
    copy.className = 'backpack-item__copy';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const stats = document.createElement('small');
    stats.textContent = `${item.tier} 阶 · 伤害 ${item.damage} · 射程 ${item.reach} · 间隔 ${(item.cooldown / TICK_RATE).toFixed(1)} 秒`;
    copy.append(name, stats);
    const choice = document.createElement('span');
    choice.className = 'backpack-item__choice';
    choice.textContent = selected ? '已装备' : '装备';
    button.append(mark, copy, choice);
    button.addEventListener('click', () => {
      campaignView = campaign.selectEquipment(item.id);
      ui['backpack-message'].textContent = `${item.name}已装备。关闭背包后按 E 或点“装备技”使用。`;
      renderBackpackList();
      updateCampaignHud();
      ui['backpack-list'].querySelector('[aria-pressed="true"]')?.focus?.();
    });
    fragment.append(button);
  }
  ui['backpack-list'].replaceChildren(fragment);
  if (!backpackDialogOpen) ui['backpack-message'].textContent = items.length
    ? '不同装备的伤害、射程与冷却各有取舍；每次出招最多命中一名敌人。'
    : '目前还没有装备；第 10 关开始可从首领身上获得。';
}

function finishBackpackDialog() {
  if (!backpackDialogOpen) return;
  backpackDialogOpen = false;
  ui['backpack-dialog'].hidden = true;
  backpackPreviousFocus?.focus?.();
  backpackPreviousFocus = null;
  if (backpackPausedCampaign && mode === 'campaign') resumeCampaign();
  backpackPausedCampaign = false;
}

function closeBackpackDialog() {
  if (!backpackDialogOpen) return;
  if (ui['backpack-dialog'].open && typeof ui['backpack-dialog'].close === 'function') {
    ui['backpack-dialog'].close();
  } else {
    ui['backpack-dialog'].removeAttribute?.('open');
  }
  finishBackpackDialog();
}

function openBackpackDialog() {
  if (mode !== 'campaign' || backpackDialogOpen || avatarDialogOpen) return;
  backpackPreviousFocus = document.activeElement ?? ui['backpack-open'];
  backpackPausedCampaign = !campaignPaused
    && ['playing', 'aftermath'].includes(campaignView.phase);
  if (backpackPausedCampaign) campaignPaused = true;
  releaseInput(true);
  if (backpackPausedCampaign) syncMusic();
  renderBackpackList();
  ui['backpack-dialog'].hidden = false;
  backpackDialogOpen = true;
  try {
    if (typeof ui['backpack-dialog'].showModal === 'function') ui['backpack-dialog'].showModal();
    else ui['backpack-dialog'].setAttribute('open', '');
  } catch {
    ui['backpack-dialog'].setAttribute('open', '');
  }
  (ui['backpack-list'].querySelector('[aria-pressed="true"]')
    ?? ui['backpack-close']).focus?.();
}

ui['backpack-open'].addEventListener('click', openBackpackDialog);
ui['backpack-close'].addEventListener('click', closeBackpackDialog);
ui['backpack-dialog'].addEventListener('close', () => {
  // A close event from an earlier opening must not dismiss a newly opened bag.
  if (!ui['backpack-dialog'].open) finishBackpackDialog();
});
ui['backpack-dialog'].addEventListener('cancel', (event) => {
  event.preventDefault();
  closeBackpackDialog();
});
ui['backpack-dialog'].addEventListener('click', (event) => {
  if (event.target === ui['backpack-dialog']) closeBackpackDialog();
});
window.addEventListener('blur', () => {
  releaseInput(true);
  if (cameraStream) stopCamera();
  sound.setAudible(false);
});
window.addEventListener('focus', () => {
  if (document.hidden) return;
  sound.setAudible(true);
  syncMusic();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    releaseInput(true);
    if (avatarDialogOpen) stopCamera();
    sound.setAudible(false);
  } else if (typeof document.hasFocus !== 'function' || document.hasFocus()) {
    sound.setAudible(true);
    syncMusic();
  }
});

function health(fill, label, fighter) {
  const value = fighter ? Math.max(0, Math.ceil(fighter.hp)) : 0;
  const max = fighter?.maxHp ?? 100;
  fill.style.width = `${Math.max(0, Math.min(100, value / max * 100))}%`;
  label.textContent = `${value} / ${max}`;
}

function updateAimAngle(hero, angle = hero?.spearAimAngle) {
  if (!hero?.spearAiming) return;
  const label = `仰角 ${Math.round(angle)}°`;
  if (ui['spear-angle'].textContent !== label) ui['spear-angle'].textContent = label;
}

function drawMap() {
  const progress = campaignView.progress;
  const fragment = document.createDocumentFragment();
  for (const stage of LEVELS) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'map-node';
    if (stage.isCheckpoint) node.classList.add('is-checkpoint');
    if (stage.isBoss) node.classList.add('is-boss');
    const cleared = progress.cleared.includes(stage.number);
    if (stage.number === progress.currentLevel && !progress.completed) node.classList.add('is-current');
    else if (cleared) node.classList.add('is-cleared');
    else node.classList.add('is-locked');
    if (campaignView.replaying && stage.number === campaignView.replayLevel) node.classList.add('is-replaying');
    node.title = `第 ${stage.number} 关 · ${stage.name}${stage.isCheckpoint ? ' · 存档点' : ''}`
      + (cleared ? ' · 点击重打（不改变主线）' : '');
    node.setAttribute('aria-label', node.title);
    node.setAttribute('aria-pressed', String(campaignView.replaying && stage.number === campaignView.replayLevel));
    node.textContent = String(stage.number).padStart(2, '0');
    node.addEventListener('click', () => {
      if (cleared) return enterReplay(stage.number);
      notify(stage.number === progress.currentLevel
        ? `当前关卡：${stage.name}`
        : `第 ${stage.number} 关「${stage.name}」${stage.number > progress.currentLevel ? '尚未到达' : '不可跳关，需按存档线路推进'}`);
    });
    fragment.append(node);
  }
  ui['map-grid'].replaceChildren(fragment);
  ui['replay-exit'].hidden = !campaignView.replaying;
}

function updateCampaignHud() {
  const { level, combat, progress, waveNumber, waveCount,
    specialEligible, specialCharges, specialKills, spearRemaining,
    inventory = [], equippedEquipmentId } = campaignView;
  const hero = combat?.fighters.find((fighter) => fighter.team === 0);
  const opponents = combat?.fighters.filter((fighter) => fighter.team === 1 && fighter.hp > 0) ?? [];
  const opponent = opponents[0];
  const milestoneBoss = combat?.fighters.find((fighter) => fighter.kind === 'boss' && fighter.bossTier > 0);
  const activeSummons = opponents.filter((fighter) => fighter.summonedBy).length;
  const replayLabel = campaignView.replaying ? '重打练习 · ' : '';
  ui['theme-label'].textContent = `${level.themeName} · 第 ${level.chapter} 章`;
  ui['stage-label'].textContent = `${replayLabel}关卡 ${String(level.number).padStart(2, '0')} / ${MAX_LEVEL}`;
  ui['stage-title'].textContent = level.name;
  ui['stage-subtitle'].textContent = campaignView.phase === 'aftermath'
    ? `${replayLabel}对手已倒下 · 退开再走过倒地敌人，片刻后结算`
    : `${replayLabel}${level.isBoss ? '首领之战 · ' : ''}第 ${level.stage} 关 · 第 ${waveNumber}/${waveCount} 波 · ${level.enemyCount} 名初始对手${milestoneBoss?.bossTier >= 2 ? ` · 召唤兵 ${activeSummons}/5` : ''}`;
  ui['player-name'].textContent = '火柴斗士';
  ui['opponent-name'].textContent = opponent?.name ?? (campaignView.phase === 'aftermath'
    ? '对手已倒下' : ['cleared', 'completed'].includes(campaignView.phase) ? '本关已清除' : '等待下一波');
  health(ui['player-health'], ui['player-health-text'], hero);
  health(ui['opponent-health'], ui['opponent-health-text'], opponent);
  ui['match-clock'].textContent = `${waveNumber} / ${waveCount}`;
  ui['session-status'].textContent = campaignView.replaying
    ? '重打练习 · 不计正式进度'
    : campaignView.phase === 'aftermath' ? '胜利收尾 · 可继续走动' : '单人闯关 · 本机存档';
  ui['checkpoint-label'].textContent = `${campaignView.replaying ? '主线' : ''}存档点：第 ${String(progress.checkpointLevel).padStart(2, '0')} 关`;
  ui['progress-label'].textContent = `${campaignView.replaying ? '主线进度' : '当前进度'} ${String(progress.currentLevel).padStart(2, '0')} / ${MAX_LEVEL} · 失败 ${progress.deaths} 次${campaignView.replaying ? '（练习不计）' : ''}`;
  ui['special-status'].hidden = !specialEligible;
  ui['special-key-guide'].hidden = !specialEligible;
  ui['special-button'].hidden = !specialEligible;
  ui['spear-status'].hidden = false;
  ui['spear-key-guide'].hidden = false;
  ui['spear-button'].hidden = false;
  ui['equipment-status'].hidden = false;
  ui['equipment-key-guide'].hidden = false;
  const equipment = getEquipment(equippedEquipmentId);
  const equipmentCooldown = hero?.equipmentCooldown ?? 0;
  ui['equipment-count'].textContent = String(inventory.length);
  ui['backpack-open'].disabled = false;
  ui['equipment-brief'].textContent = equipment
    ? `${equipment.name} · ${equipment.tier} 阶 / 伤害 ${equipment.damage}${equipmentCooldown > 0 ? ` · 冷却 ${(equipmentCooldown / TICK_RATE).toFixed(1)} 秒` : ' · E 使用'}`
    : inventory.length ? '背包有装备 · 按 B 选择' : '背包空 · 击败首领获得装备';
  ui['equipment-status'].classList.toggle('is-equipped', Boolean(equipment));
  const count = `${spearRemaining}/${SPEARS_PER_LEVEL}`;
  if (ui['spear-guide-remaining'].textContent !== count) ui['spear-guide-remaining'].textContent = count;
  const active = campaignView.phase === 'playing' && !campaignPaused && hero?.hp > 0;
  const aiming = active && hero.spearAiming === true;
  const winding = active && hero.spearWindup > 0;
  const busy = hero && (hero.stun > 0 || hero.attackStage > 0 || hero.kickType
    || hero.dodgeTicks > 0 || hero.equipmentAttackId);
  const spearText = campaignView.phase === 'aftermath'
    ? `胜利收尾 · 投矛剩余 ${count}，退开再走过倒地敌人`
    : aiming
    ? `投矛剩余 ${count} · W 抬角、S/↓ 压角或上下拖动，再按 I 发射；↑ 跳跃并取消瞄准`
    : winding ? `投矛剩余 ${count} · 蓄势中，实际投出才扣次；被击中会打断`
      : spearRemaining === 0 ? `投矛已用尽（${count}）· 下一关或失败回档重试后恢复`
        : busy ? `投矛剩余 ${count} · 出招结束后按 I 瞄准`
          : `投矛剩余 ${count} · 按 I 瞄准，再按 I 发射`;
  if (ui['spear-status'].textContent !== spearText) ui['spear-status'].textContent = spearText;
  ui['spear-status'].classList.toggle('is-ready', active && spearRemaining > 0 && !busy && !winding);
  ui['spear-status'].classList.toggle('is-aiming', aiming);
  ui['spear-button'].textContent = aiming ? `发射 ×${spearRemaining}`
    : winding ? `蓄势 ×${spearRemaining}` : `投矛 ×${spearRemaining}`;
  ui['spear-button'].disabled = !active || spearRemaining === 0 || winding || (!aiming && Boolean(busy));
  ui['spear-button'].setAttribute('aria-label', aiming
    ? `确认投矛，剩余 ${spearRemaining} 次，当前仰角 ${Math.round(hero.spearAimAngle)} 度`
    : winding ? `投矛蓄势中，剩余 ${spearRemaining} 次，飞出后扣一次`
      : spearRemaining === 0 ? '本关投矛次数已用尽' : `进入投矛瞄准，剩余 ${spearRemaining} 次`);
  ui['spear-aim-controls'].hidden = !aiming;
  if (aiming) updateAimAngle(hero);
  for (const id of ['aim-up-button', 'aim-down-button', 'aim-cancel-button']) ui[id].disabled = !aiming;
  ui['game-canvas'].classList.toggle('is-aiming', aiming);
  ui['equipment-button'].hidden = !equipment;
  ui['equipment-button'].disabled = !active || !equipment || equipmentCooldown > 0
    || Boolean(busy) || aiming || winding;
  ui['equipment-button'].textContent = equipment ? `${equipment.name} · 技` : '装备技';
  ui['equipment-button'].setAttribute('aria-label', equipment
    ? `使用${equipment.name}攻击，伤害 ${equipment.damage}${equipmentCooldown > 0 ? `，冷却还需 ${(equipmentCooldown / TICK_RATE).toFixed(1)} 秒` : ''}`
    : '尚未装备武器，击败首领后在背包中选择');
  ui['touch-tip'].textContent = campaignView.phase === 'aftermath'
    ? '左右走动 · 走近掉落装备自动拾取，退开再走过倒地敌人可触发散骨'
    : aiming
    ? `投矛剩余 ${count} · 上下拖动或按「抬高/压低」调角，点「发射」确认`
    : winding ? `投矛剩余 ${count} · 蓄势中，被击中会打断且不扣次`
      : spearRemaining === 0 ? `投矛已用尽（${count}）· 空中按「踢腿」释放跳踢大招`
        : `投矛剩余 ${count} · 空中按「踢腿」释放跳踢大招${equipment ? ' · 装备技可出招' : ' · Boss 掉落可装进背包'}`;
  for (const button of aftermathActionButtons) button.disabled = campaignView.phase === 'aftermath';
  if (specialEligible) {
    const needed = 2 - (specialKills % 2);
    const specialText = specialCharges > 0
      ? `光波 ×${specialCharges} · 按 L 发动`
      : `光波充能 · 再击倒 ${needed} 人`;
    if (ui['special-status'].textContent !== specialText) ui['special-status'].textContent = specialText;
    ui['special-status'].classList.toggle('is-ready', specialCharges > 0);
    ui['special-button'].textContent = specialCharges > 0 ? `光波 ×${specialCharges}` : '光波';
    ui['special-button'].disabled = specialCharges === 0 || campaignView.phase !== 'playing';
    ui['special-button'].setAttribute('aria-label', `无敌光波，剩余 ${specialCharges} 次`);
  }
}

function campaignOverlay() {
  const { phase, level, failedLevel, progress } = campaignView;
  if (campaignView.replaying) {
    const levelLabel = `第 ${String(level.number).padStart(2, '0')} 关「${level.name}」`;
    if (phase === 'failed' || phase === 'cleared') {
      showOverlay({
        title: phase === 'failed' ? '练习失利' : '重打成功',
        body: `${levelLabel}${phase === 'failed' ? '挑战失利' : '已经完成'}。这是独立练习，战利品与装备选择不会带回主线；进度、存档与失败次数均未改变。`,
        primary: '再打这一关', onPrimary: retryReplay,
        secondary: '返回主线', onSecondary: exitReplay,
      });
    } else if (phase === 'aftermath') {
      showOverlay({
        title: '练习收尾',
        body: '敌人已倒下。可走过倒地敌人触发散骨，片刻后显示练习结果；随时可返回主线。',
        primary: '继续走动', onPrimary: () => { resumeCampaign(); hideOverlay(); },
        secondary: '返回主线', onSecondary: exitReplay,
      });
    } else {
      showOverlay({
        title: `重打第 ${String(level.number).padStart(2, '0')} 关`,
        body: `${levelLabel}从起点开始独立练习。可试用已有装备，练习战利品不会带回主线；可随时从右侧返回主线。`,
        primary: '开始重打', onPrimary: () => { resumeCampaign(); hideOverlay(); },
        secondary: '返回主线', onSecondary: exitReplay,
      });
    }
    return;
  }
  const bossTier = level.waves.flatMap((wave) => wave.groups)
    .find((group) => group.kind === 'boss' && group.bossTier > 0)?.bossTier ?? 0;
  const summonHint = bossTier >= 2
    ? '每次最多召唤 2 名援兵，场上活兵最多 5 名；首领 KO 时它召出的活兵也会倒下。' : '';
  const bossHint = bossTier
    ? ` 本关首领逐级叠加${MILESTONE_BOSS_SKILLS.slice(0, bossTier).join('、')}。${summonHint}光波对首领只扣当前血量的三分之一。击败首领必掉装备。`
    : level.isBoss ? ' 光波对首领只扣当前血量的三分之一；击败后必掉装备。' : '';
  if (phase === 'failed') {
    showOverlay({
      title: '挑战失败',
      body: `第 ${failedLevel} 关失利。已回到第 ${progress.checkpointLevel} 关存档原点；血量、敌人、机关及上次存档后取得的装备会回滚。`,
      primary: `从第 ${progress.checkpointLevel} 关重试`,
      onPrimary: () => {
        campaignView = campaign.retry();
        sceneToken++;
        resumeCampaign();
        drawMap();
        updateCampaignHud();
        hideOverlay();
      },
    });
  } else if (phase === 'cleared') {
    showOverlay({
      title: '关卡突破',
      body: `第 ${level.number} 关「${level.name}」完成。${level.isBoss ? '首领战利品已收进背包。' : ''}下一站：第 ${progress.currentLevel} 关「${getLevel(progress.currentLevel).name}」。`,
      primary: '进入下一关',
      onPrimary: () => {
        campaignView = campaign.next();
        sceneToken++;
        resumeCampaign();
        drawMap();
        updateCampaignHud();
        hideOverlay();
      },
    });
  } else if (phase === 'completed') {
    showOverlay({
      title: '56 关全部突破',
      body: '森林、城市、海洋与陆地的九场首领战均已突破，战利品已收进背包。通关记录保存在这台浏览器；点击右侧已通过的关卡可随时重打。',
      primary: '开启新的征程',
      onPrimary: () => {
        if (!window.confirm('重新开始将清除当前的 56 关通关进度，确定继续吗？')) return;
        campaignView = campaign.reset();
        sceneToken++;
        resumeCampaign();
        drawMap();
        updateCampaignHud();
        hideOverlay();
      },
    });
  } else if (phase === 'aftermath') {
    showOverlay({
      title: '胜利收尾',
      body: '敌人已经倒下。走近首领掉落可拾取，未拾到的装备过关时自动收纳；从同一层走过倒地敌人可触发散骨。落稳后约 3 秒自动结算，本段不会再受到机关伤害。',
      primary: '继续走动', onPrimary: () => { resumeCampaign(); hideOverlay(); },
    });
  } else {
    showOverlay({
      title: level.number === 1 && progress.cleared.length === 0 ? '准备开战' : '继续征程',
      body: `第 ${level.number} / ${MAX_LEVEL} 关 · ${level.themeName}「${level.name}」。A/D 移动，J 攻击，↑/空格跳跃，Shift 闪避。每关最多投矛 ${SPEARS_PER_LEVEL} 次；按 I 预览弧线，W 抬角、S/↓ 压角，再按 I 确认发射，真正投出才扣次；Esc 取消。B 打开背包，选装备后按 E 攻击。${campaignView.specialEligible ? '每击倒两名敌人可按 L 释放一次无敌光波。' : ''}${bossHint}`,
      primary: '开始挑战',
      onPrimary: () => { resumeCampaign(); hideOverlay(); },
      secondary: '设置头像', onSecondary: openAvatarDialog,
    });
  }
}

function showMainlineResumeOverlay({ fromReplay = false } = {}) {
  const ending = campaignView.phase === 'aftermath';
  if (campaignView.replaying) {
    showOverlay({
      title: '练习已暂停',
      body: `第 ${campaignView.level.number} 关的重打现场未重置；头像设置只改变本页画面，不影响练习或正式存档。`,
      primary: ending ? '继续走动' : '继续重打',
      onPrimary: () => { resumeCampaign({ preserveAim: true }); hideOverlay(); },
      secondary: '返回主线', onSecondary: exitReplay,
    });
    return;
  }
  showOverlay({
    title: ending ? '继续主线收尾' : '主线已暂停',
    body: `${fromReplay
      ? `已回到第 ${campaignView.level.number} 关原来的现场，生命、敌人和机关状态没有因重打而回退。`
      : `第 ${campaignView.level.number} 关已暂停，设置头像不会重置当前战斗。`}${ending ? '可继续走动等待结算。' : '准备好后继续挑战。'}`,
    primary: ending ? '继续走动' : '继续主线',
    onPrimary: () => { resumeCampaign({ preserveAim: true }); hideOverlay(); },
    secondary: '设置头像', onSecondary: openAvatarDialog,
  });
}

function enterReplay(levelNumber) {
  if (mode !== 'campaign' || !campaignView.progress.cleared.includes(levelNumber)) return;
  if (campaignView.replaying && campaignView.replayLevel === levelNumber
    && ['playing', 'aftermath'].includes(campaignView.phase)) {
    notify('正在重打这一关；可继续战斗或点击“退出重打”返回主线。');
    return;
  }
  cancelResultOverlay();
  sound.cancelPendingKOs();
  campaignPaused = true;
  releaseInput(false);
  campaignView = campaign.replay(levelNumber);
  sceneToken++;
  accumulator = 0;
  drawMap();
  updateCampaignHud();
  campaignOverlay();
  syncMusic();
}

function retryReplay() {
  if (!campaignView.replaying) return;
  cancelResultOverlay();
  sound.cancelPendingKOs();
  releaseInput(false);
  campaignView = campaign.retryReplay();
  sceneToken++;
  drawMap();
  resumeCampaign();
  hideOverlay();
}

function exitReplay({ showResult = true } = {}) {
  if (!campaignView.replaying) return;
  cancelResultOverlay();
  sound.cancelPendingKOs();
  releaseInput(false);
  campaignView = campaign.exitReplay();
  sceneToken++;
  campaignPaused = true;
  accumulator = 0;
  drawMap();
  updateCampaignHud();
  if (showResult && mode === 'campaign') {
    if (['playing', 'aftermath'].includes(campaignView.phase)) showMainlineResumeOverlay({ fromReplay: true });
    else campaignOverlay();
  }
  syncMusic();
}

ui['replay-exit'].addEventListener('click', () => exitReplay());

function resumeCampaign({ preserveAim = false } = {}) {
  cancelResultOverlay();
  sound.cancelPendingKOs();
  releaseInput(!preserveAim);
  if (preserveAim) {
    const hero = campaignView.combat?.fighters.find((fighter) => fighter.team === 0);
    if (hero?.prevInput) hero.prevInput.spear = false;
  }
  accumulator = 0;
  campaignPaused = false;
  updateCampaignHud();
  syncMusic();
}

function consumeEvents(events) {
  for (const effect of events ?? []) {
    renderer.effect(effect);
    // A charge belongs to one duelist. Both clients may draw the tell, but
    // only that player's device should play a personal ready chime.
    if (effect.type !== 'duel-wave-ready' || mode !== 'duel'
        || (effect.source === duel.role && duel.phase === 'playing')) sound.play(effect);
    if (mode === 'campaign' && ['spear-aim-cancel', 'special-wave', 'wave'].includes(effect.type)) {
      pendingSpearPresses = 0;
    }
    if (mode === 'campaign' && effect.type === 'spear-throw' && campaignView.spearRemaining === 0) {
      pendingSpearPresses = 0;
    }
    if (mode === 'campaign' && effect.type === 'special-ready') {
      notify(`光波已充能 ${effect.charges} 次，按 L 或点击光波发动`);
      updateCampaignHud();
    }
    if (mode === 'duel' && duel.phase === 'playing'
        && effect.type === 'duel-wave-ready' && effect.source === duel.role) {
      notify(`灵能光波已充满！面对对手按 L 发射，前向射程 ${DUEL_WAVE_REACH}。`);
      updateDuelHud();
    }
    if (mode === 'campaign' && effect.type === 'equipment-drop') {
      const item = getEquipment(effect.equipmentId);
      if (item) notify(`${item.name}掉落！靠近自动拾取；过关时未拾取也会收入背包。`);
    }
    if (mode === 'campaign' && effect.type === 'equipment-pickup') {
      const item = getEquipment(effect.equipmentId);
      if (item) notify(effect.duplicate
        ? `${item.name}已在背包，不会重复叠加。`
        : `${item.name}已收入背包${effect.auto ? '（过关自动收纳）' : ''}，按 B 选择、E 出招。`);
      updateCampaignHud();
      if (backpackDialogOpen) renderBackpackList();
    }
    if (mode === 'campaign' && ['spear-aim', 'spear-aim-cancel', 'spear-windup', 'spear-throw',
      'equipment-swing', 'special-wave', 'wave']
      .includes(effect.type)) updateCampaignHud();
  }
}

function updateDuelHud() {
  const state = duel.state ?? createDuelState(duel.theme);
  // The fixed P1/P2 HUD positions and colors always match the canvas fighters.
  const [first, second] = state.fighters;
  const local = state.fighters.find((fighter) => fighter.id === duel.role);
  const active = duel.phase === 'playing' && local?.hp > 0;
  const aiming = active && local.spearAiming === true;
  const winding = active && local.spearWindup > 0;
  const busy = local && (local.stun > 0 || local.attackStage > 0 || local.kickType
    || local.dodgeTicks > 0 || local.duelWaveRecovery > 0);
  const direction = local?.facing < 0 ? '左' : '右';
  const remaining = Number.isFinite(local?.spearRemaining)
    ? Math.max(0, Math.min(SPEARS_PER_DUEL, local.spearRemaining)) : SPEARS_PER_DUEL;
  const charge = local?.duelWaveCharge === 1 ? 1 : 0;
  const hits = Math.max(0, Math.min(DUEL_WAVE_HITS_REQUIRED - 1, local?.duelWaveHits ?? 0));
  const count = `${remaining}/${SPEARS_PER_DUEL}`;
  const aimAngle = Number.isFinite(duelRequestedAimAngle)
    ? duelRequestedAimAngle : local?.spearAimAngle;
  const theme = THEMES[duel.theme] ?? THEMES.city;
  ui['theme-label'].textContent = `${theme.name} · 对战竞技场`;
  ui['stage-label'].textContent = '实时联机 1V1';
  ui['stage-title'].textContent = '同屏较量，远端决胜';
  ui['stage-subtitle'].textContent = duel.code
    ? `房间 ${duel.code} · ${duel.role === 'p1' ? first.name : second.name} · 横向三倍战场`
    : '创建房间，或输入六位房间码加入';
  ui['player-name'].textContent = `${first.name}${duel.role === 'p1' ? ' · 你' : ''}`;
  ui['opponent-name'].textContent = `${second.name}${duel.role === 'p2' ? ' · 你' : ''}`;
  health(ui['player-health'], ui['player-health-text'], first);
  health(ui['opponent-health'], ui['opponent-health-text'], second);
  ui['match-clock'].textContent = duel.phase === 'playing' || duel.phase === 'finished'
    ? String(Math.ceil((state.timerTicks ?? 0) / TICK_RATE)).padStart(2, '0')
    : '--';
  ui['session-status'].textContent = duel.code ? `联机房间 · ${duel.code}` : '联机大厅';
  ui['checkpoint-label'].textContent = '服务器判定命中与胜负';
  ui['progress-label'].textContent = duel.phase === 'playing'
    ? `99 秒决胜 · 光波前向射程 ${DUEL_WAVE_REACH}`
    : `双方到齐后自动开赛 · 每人 ${SPEARS_PER_DUEL} 发矛`;
  ui['special-status'].hidden = false;
  ui['special-key-guide'].hidden = false;
  ui['special-button'].hidden = false;
  ui['special-status'].textContent = charge
    ? busy ? `联机光波 ×1 · 当前动作结束后，朝${direction}前方 ${DUEL_WAVE_REACH} 发射`
      : `联机光波 ×1 · 朝${direction}前方 ${DUEL_WAVE_REACH} 范围 · 按 L 发射`
    : `联机光波充能 ${hits}/${DUEL_WAVE_HITS_REQUIRED} · 再命中 ${DUEL_WAVE_HITS_REQUIRED - hits} 次`;
  ui['special-status'].classList.toggle('is-ready', active && charge > 0 && !busy);
  ui['special-button'].textContent = charge ? '光波 ×1' : `光波 ${hits}/${DUEL_WAVE_HITS_REQUIRED}`;
  ui['special-button'].disabled = !active || charge === 0 || Boolean(busy);
  ui['special-button'].setAttribute('aria-label', charge
    ? busy ? '光波已充满，当前动作结束后可发射'
      : `朝${direction}前方发射光波，射程 ${DUEL_WAVE_REACH}，剩余 1 次`
    : `光波充能 ${hits}/${DUEL_WAVE_HITS_REQUIRED}，还需 ${DUEL_WAVE_HITS_REQUIRED - hits} 次有效命中`);
  for (const button of aftermathActionButtons) button.disabled = false;
  ui['touch-tip'].textContent = aiming
    ? `朝${direction}投矛 · ${Math.round(aimAngle)}° · 上下拖动或按「抬高/压低」调角，点「发射」确认；弧线仅预测落点`
    : winding ? `朝${direction}蓄势中 · 矛实际飞出才扣次数`
      : active ? `朝${direction}前方光波射程 ${DUEL_WAVE_REACH}，需同高度 · 投矛剩余 ${count} · 空中「踢腿」可跳踢`
        : duel.phase === 'finished' ? '本局结束 · 双方申请再战后，投矛与光波重新开始'
          : `联机：I 投矛、W 抬角、S/↓ 压角、↑/空格跳跃、L 光波 · 每人 ${SPEARS_PER_DUEL} 发矛`;
  ui['equipment-status'].hidden = true;
  ui['equipment-key-guide'].hidden = true;
  ui['equipment-button'].hidden = true;
  ui['equipment-button'].disabled = true;
  ui['backpack-open'].disabled = true;
  ui['spear-status'].hidden = false;
  ui['spear-key-guide'].hidden = false;
  ui['spear-button'].hidden = false;
  ui['spear-guide-remaining'].textContent = count;
  ui['spear-status'].textContent = !active
    ? `联机投矛 ${count} · ${duel.phase === 'finished' ? `本局结束，下局恢复 ${SPEARS_PER_DUEL} 发`
      : duel.phase === 'playing' ? '已被 KO，等待结果' : '开战后按 I 瞄准'}`
    : aiming ? `联机投矛剩余 ${count} · 朝${direction}瞄准，W 抬角、S/↓ 压角或上下拖动，再按 I 发射；↑ 跳跃并取消瞄准`
      : winding ? `联机投矛剩余 ${count} · 蓄势中，真正投出才扣 1 发`
        : remaining === 0 ? `联机投矛已用尽（0/${SPEARS_PER_DUEL}）· 下局恢复`
          : `联机投矛剩余 ${count} · 朝${direction}按 I 瞄准，再按 I 确认`;
  ui['spear-status'].classList.toggle('is-ready', active && remaining > 0 && !busy && !winding);
  ui['spear-status'].classList.toggle('is-aiming', aiming);
  ui['spear-button'].textContent = aiming ? `发射 ×${remaining}`
    : winding ? `蓄势 ×${remaining}` : `投矛 ×${remaining}`;
  ui['spear-button'].disabled = !active || remaining === 0 || winding || (!aiming && Boolean(busy));
  ui['spear-button'].setAttribute('aria-label', aiming
    ? `确认朝${direction}投矛，剩余 ${remaining} 发，当前仰角 ${Math.round(aimAngle)} 度`
    : winding ? `投矛蓄势中，剩余 ${remaining} 发，实际投出才扣 1 发`
      : remaining === 0 ? '本局投矛已用尽' : `朝${direction}进入投矛瞄准，剩余 ${remaining} 发`);
  ui['spear-aim-controls'].hidden = !aiming;
  if (aiming) updateAimAngle(local, aimAngle);
  for (const id of ['aim-up-button', 'aim-down-button', 'aim-cancel-button']) ui[id].disabled = !aiming;
  ui['game-canvas'].classList.toggle('is-aiming', aiming);
  if (!aiming) ui['game-canvas'].classList.remove('is-aim-dragging');
  ui['room-code'].textContent = duel.code ?? '—— —— ——';
  ui['copy-room'].disabled = !duel.code;
  ui['leave-room'].hidden = !duel.code;
  ui['leave-room'].disabled = !duel.code;
  ui['rematch'].hidden = duel.phase !== 'finished';
  ui['rematch'].disabled = duel.phase !== 'finished';
  ui['create-room'].disabled = Boolean(duel.code);
  ui['join-room'].disabled = Boolean(duel.code);
  if (themeSelect) themeSelect.disabled = Boolean(duel.code);
}

function previewDuel() {
  duel.previousState = null;
  duel.state = createDuelState(themeSelect?.value ?? duel.theme);
  duel.theme = duel.state.arena.theme;
  updateDuelHud();
}

function syncDuelTheme(theme) {
  if (!Object.hasOwn(THEMES, theme)) return false;
  duel.theme = theme;
  if (themeSelect) themeSelect.value = theme;
  return true;
}

function send(message) {
  if (duel.socket?.readyState !== WebSocket.OPEN) return false;
  duel.socket.send(JSON.stringify(message));
  return true;
}

function resetDuelRoom() {
  cancelResultOverlay();
  sound.cancelPendingKOs();
  duel.code = null;
  duel.role = null;
  duel.phase = 'idle';
  releaseInput();
  duel.inputSeq = 0;
  duel.lastInputAt = 0;
  duel.seenEvents.clear();
  sceneToken++;
  previewDuel();
  ui['room-message'].textContent = '创建房间，邀请朋友输入房间码即可对战。';
  updateAvatarAvailability();
  syncMusic();
}

function leaveRoom() {
  if (duel.code) send({ type: 'leave' });
  resetDuelRoom();
  hideOverlay();
}

function processDuelEvents(events) {
  for (const effect of events ?? []) {
    const id = effect.id ?? `${effect.type}:${effect.x}:${effect.y}:${effect.damage}`;
    if (duel.seenEvents.has(id)) continue;
    duel.seenEvents.add(id);
    consumeEvents([effect]);
  }
  if (duel.seenEvents.size > 240) duel.seenEvents = new Set([...duel.seenEvents].slice(-120));
}

function handleServerMessage(message) {
  if (mode !== 'duel' && (message.type === 'created' || message.type === 'joined')) {
    // A room response can race with switching back to the campaign.
    send({ type: 'leave' });
    return;
  }
  if (['waiting', 'countdown', 'start', 'state', 'finished', 'rematch', 'peer-left', 'room-expired'].includes(message.type)
    && message.code !== duel.code) return;
  switch (message.type) {
    case 'created':
    case 'joined':
      duel.code = message.code;
      duel.role = message.role;
      syncDuelTheme(message.theme);
      duel.phase = 'waiting';
      releaseInput();
      ui['room-message'].textContent = `房间 ${message.code} · ${message.role === 'p1' ? '已创建，等待朋友加入' : '已加入，准备开战'}`;
      updateDuelHud();
      if (message.type === 'created' && mode === 'duel') {
        showOverlay({
          title: '房间已建立', body: `把房间码 ${message.code} 发给朋友。第二位玩家进入后自动开始。`,
          primary: '复制房间码', onPrimary: copyRoomCode,
          secondary: '离开房间', onSecondary: leaveRoom,
        });
      }
      break;
    case 'waiting':
      duel.phase = 'waiting';
      releaseInput();
      ui['room-message'].textContent = `房间 ${message.code} · 等待第二位玩家加入`;
      updateDuelHud();
      break;
    case 'countdown':
      closeAvatarDialog();
      cancelResultOverlay();
      sound.cancelPendingKOs();
      duel.phase = 'countdown';
      releaseInput();
      updateDuelHud();
      if (mode === 'duel') showOverlay({ title: `${message.seconds}`, body: '对手已就位 · 战斗即将开始' });
      break;
    case 'start':
      closeAvatarDialog();
      cancelResultOverlay();
      sound.cancelPendingKOs();
      releaseInput();
      duel.phase = 'playing';
      duel.role = message.role;
      syncDuelTheme(message.theme);
      duel.inputSeq = 0;
      duel.lastInputAt = 0;
      duel.seenEvents.clear();
      sceneToken++;
      ui['room-message'].textContent = `房间 ${message.code} · 战斗进行中`;
      if (mode === 'duel') hideOverlay();
      // Joining with Enter leaves focus in the room-code input. Move it to
      // the arena so the first combat key is not swallowed by that field.
      if (document.activeElement === ui['room-input']) ui['game-canvas'].focus?.();
      updateDuelHud();
      sendInput(true);
      break;
    case 'state':
      duel.previousState = duel.state;
      duel.state = message.state;
      duel.receivedAt = performance.now();
      if (message.phase === 'playing') duel.phase = 'playing';
      reconcileDuelAim();
      processDuelEvents(message.state?.events);
      if (mode === 'duel') updateDuelHud();
      break;
    case 'finished': {
      duel.previousState = duel.state;
      duel.state = message.state;
      duel.receivedAt = performance.now();
      duel.phase = 'finished';
      releaseInput();
      processDuelEvents(message.state?.events);
      updateDuelHud();
      const result = message.winner == null ? '平局' : message.winner === duel.role ? '你赢了！' : '惜败，再战！';
      ui['room-message'].textContent = `本局结束 · ${result}`;
      if (mode === 'duel') {
        const finishedState = duel.state;
        const finishedCode = duel.code;
        showAfterKOResult(message.state?.events, () => {
          if (mode !== 'duel' || duel.phase !== 'finished'
              || duel.code !== finishedCode || duel.state !== finishedState) return;
          showOverlay({
            title: result,
            body: `本局以${message.reason === 'timeout' ? '倒计时结束' : '击倒'}决出结果。双方都申请再战后，会重新倒计时。`,
            primary: '申请再战',
            onPrimary: () => {
              send({ type: 'rematch' });
              showOverlay({ title: '等待对手确认', body: '你已申请再战，对手确认后自动开始。', secondary: '离开房间', onSecondary: leaveRoom });
            },
            secondary: '离开房间', onSecondary: leaveRoom,
          });
        });
      }
      break;
    }
    case 'rematch':
      ui['room-message'].textContent = `${message.ready} / ${message.total} 位玩家已确认再战`;
      break;
    case 'peer-left':
      cancelResultOverlay();
      sound.cancelPendingKOs();
      if (duel.role === 'p2') {
        resetDuelRoom();
        ui['room-message'].textContent = '房主已离开，房间已关闭。';
        if (mode === 'duel') showOverlay({ title: '房间已关闭', body: '房主离开了对战；你可以创建新的房间。', primary: '返回大厅', onPrimary: hideOverlay });
      } else {
        duel.phase = 'waiting';
        releaseInput();
        duel.state = createDuelState(duel.theme);
        ui['room-message'].textContent = '对手已离开，可将原房间码发给新对手。';
        if (mode === 'duel') showOverlay({
          title: '对手已离开', body: `房间 ${duel.code} 仍可加入；邀请新对手，或离开房间。`,
          primary: '复制房间码', onPrimary: copyRoomCode,
          secondary: '离开房间', onSecondary: leaveRoom,
        });
      }
      updateDuelHud();
      break;
    case 'left':
      resetDuelRoom();
      if (mode === 'duel') hideOverlay();
      break;
    case 'room-expired':
      resetDuelRoom();
      ui['room-message'].textContent = message.message || '等待房已过期，请重新创建或加入其他房间。';
      if (mode === 'duel') hideOverlay();
      break;
    case 'error':
      notify(message.message || '房间请求失败');
      break;
    default:
      break;
  }
  updateAvatarAvailability();
  syncMusic();
}

function ensureSocket() {
  if (duel.socket?.readyState === WebSocket.OPEN) return Promise.resolve(duel.socket);
  if (duel.socket?.readyState === WebSocket.CONNECTING && duel.connection) return duel.connection;
  if (location.protocol === 'file:') return Promise.reject(new Error('请通过本地服务地址打开游戏，不能直接打开 HTML 文件'));
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  duel.socket = socket;
  duel.connection = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      ui['room-message'].textContent = '已连接联机服务，创建或加入房间。';
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => reject(new Error('无法连接联机服务，请确认本地服务正在运行')), { once: true });
  });
  socket.addEventListener('message', (event) => {
    try { handleServerMessage(JSON.parse(event.data)); }
    catch { notify('收到的服务器消息无法识别'); }
  });
  socket.addEventListener('close', () => {
    duel.connection = null;
    if (duel.socket !== socket) return;
    duel.socket = null;
    const wasInRoom = Boolean(duel.code);
    resetDuelRoom();
    if (wasInRoom && mode === 'duel') {
      showOverlay({ title: '连接中断', body: '联机服务连接已断开；本局未保存，可重新进入大厅。', primary: '返回大厅', onPrimary: hideOverlay });
    }
  });
  return duel.connection;
}

async function createRoom() {
  if (duel.code) return notify('请先离开当前房间');
  try {
    await ensureSocket();
    duel.theme = themeSelect?.value ?? 'city';
    previewDuel();
    send({ type: 'create', theme: duel.theme });
  } catch (error) { notify(error.message); }
}

async function joinRoom() {
  if (duel.code) return notify('请先离开当前房间');
  const code = ui['room-input'].value.trim();
  if (!/^\d{6}$/.test(code)) return notify('请输入六位数字房间码');
  try {
    await ensureSocket();
    send({ type: 'join', code });
  } catch (error) { notify(error.message); }
}

async function copyRoomCode() {
  if (!duel.code) return notify('请先创建房间');
  try {
    await navigator.clipboard.writeText(duel.code);
    notify(`房间码 ${duel.code} 已复制`);
  } catch {
    ui['room-input'].value = duel.code;
    ui['room-input'].focus();
    ui['room-input'].select();
    notify('已选中房间码，请手动复制');
  }
}

ui['create-room'].addEventListener('click', createRoom);
ui['join-room'].addEventListener('click', joinRoom);
ui['room-input'].addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });
ui['copy-room'].addEventListener('click', copyRoomCode);
ui['leave-room'].addEventListener('click', leaveRoom);
ui.rematch.addEventListener('click', () => {
  if (duel.phase === 'finished') {
    send({ type: 'rematch' });
    showOverlay({ title: '等待对手确认', body: '双方确认后自动开始新一局。', secondary: '离开房间', onSecondary: leaveRoom });
  }
});
themeSelect?.addEventListener('change', () => {
  if (!duel.code) previewDuel();
});

function switchMode(next) {
  if (mode === next) return;
  closeBackpackDialog();
  closeAvatarDialog();
  if (mode === 'campaign' && campaignView.replaying) exitReplay({ showResult: false });
  cancelResultOverlay();
  sound.cancelPendingKOs();
  if (mode === 'duel' && duel.code) leaveRoom();
  releaseInput(true);
  mode = next;
  sceneToken++;
  ui['fight-hud'].classList.toggle('is-duel', next === 'duel');
  ui['campaign-panel'].hidden = next !== 'campaign';
  ui['duel-panel'].hidden = next !== 'duel';
  for (const [button, isActive] of [[ui['campaign-button'], next === 'campaign'], [ui['duel-button'], next === 'duel']]) {
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  }
  if (next === 'campaign') {
    campaignPaused = true;
    updateCampaignHud();
    drawMap();
    campaignOverlay();
  } else {
    campaignPaused = true;
    hideOverlay();
    previewDuel();
  }
  updateAvatarAvailability();
  syncMusic();
}

ui['campaign-button'].addEventListener('click', () => switchMode('campaign'));
ui['duel-button'].addEventListener('click', () => switchMode('duel'));
function updateSoundToggle() {
  const label = `背景音乐与战斗音效：${sound.enabled ? '开' : '关'}`;
  const text = ui['sound-toggle'].querySelector('span');
  if (text) text.textContent = `声音：${sound.enabled ? '开' : '关'}`;
  ui['sound-toggle'].setAttribute('aria-label', label);
  ui['sound-toggle'].setAttribute('aria-pressed', String(sound.enabled));
  ui['sound-toggle'].title = label;
}
ui['sound-toggle'].addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  updateSoundToggle();
  if (sound.enabled) unlockAudio();
});

function duelPresentation(now) {
  const state = duel.state ?? createDuelState(duel.theme);
  if (!duel.previousState || duel.phase !== 'playing') return state;
  const alpha = Math.max(0, Math.min(1, (now - duel.receivedAt) / 55));
  const lookAhead = Math.max(0, Math.min(2.3, (now - duel.receivedAt) / (1000 / TICK_RATE)));
  const buttons = currentInput();
  return {
    ...state,
    fighters: state.fighters.map((fighter) => {
      const previous = duel.previousState.fighters.find((old) => old.id === fighter.id);
      if (!previous) return fighter;
      if (fighter.id === duel.role) {
        // Only movement is predicted; hit detection and health always come from the server.
        const direction = Number(buttons.right) - Number(buttons.left);
        const vx = fighter.dodgeTicks > 0 || fighter.spearWindup > 0 || fighter.duelWaveRecovery > 0
          ? fighter.vx : direction * (fighter.speed ?? 4.45);
        return { ...fighter, x: Math.max(19, Math.min(state.arena.width - 19,
          fighter.x + vx * lookAhead * 0.62)) };
      }
      return {
        ...fighter,
        x: previous.x + (fighter.x - previous.x) * alpha,
        y: previous.y + (fighter.y - previous.y) * alpha,
      };
    }),
  };
}

function frame(now) {
  const elapsed = Math.min(100, Math.max(0, now - lastFrameAt));
  lastFrameAt = now;
  if (mode === 'campaign' && !campaignPaused
      && (campaignView.phase === 'playing' || campaignView.phase === 'aftermath')) {
    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= 1000 / TICK_RATE && steps < 5) {
      const previousPhase = campaignView.phase;
      campaignView = campaign.step(campaignInput());
      consumeEvents(campaignView.events);
      if (campaignView.phase !== previousPhase) updateCampaignHud();
      updateAimAngle(campaignView.combat?.fighters.find((fighter) => fighter.team === 0));
      accumulator -= 1000 / TICK_RATE;
      steps++;
      if (campaignView.phase !== 'playing' && campaignView.phase !== 'aftermath') {
        campaignPaused = true;
        releaseInput(true);
        drawMap();
        updateCampaignHud();
        const settledView = campaignView;
        showAfterKOResult(settledView.events, () => {
          if (mode === 'campaign' && campaignView === settledView) campaignOverlay();
        });
        break;
      }
    }
    if (steps === 5) accumulator = 0;
  } else {
    accumulator = 0;
  }

  if (mode === 'campaign') syncMusic();

  if (mode === 'duel') sendInput();
  const view = mode === 'campaign'
    ? (campaignView.combat ?? createDuelState(campaignView.level.theme))
    : duelPresentation(now);
  const stage = mode === 'campaign' ? campaignView.level : null;
  renderer.render(view, {
    theme: mode === 'campaign' ? stage.theme : duel.theme,
    mode, level: stage?.number, time: now / 1000,
    campaignPhase: mode === 'campaign' ? campaignView.phase : undefined,
    localFighterId: mode === 'campaign' ? 'hero' : duel.role,
    sceneToken,
  });
  if (now - lastHudAt > 80) {
    if (mode === 'campaign') updateCampaignHud();
    else updateDuelHud();
    lastHudAt = now;
  }
  requestAnimationFrame(frame);
}

drawMap();
updateCampaignHud();
campaignOverlay();
ui['campaign-button'].classList.add('is-active');
ui['campaign-button'].setAttribute('aria-pressed', 'true');
ui['duel-button'].setAttribute('aria-pressed', 'false');
ui['campaign-panel'].hidden = false;
ui['duel-panel'].hidden = true;
ui.toast.hidden = true;
updateSoundToggle();
updateAvatarAvailability();
requestAnimationFrame(frame);
