import { cancelSpearAim, createDuelState, SPEAR_MAX_ANGLE, SPEAR_MIN_ANGLE,
  TICK_RATE } from '../shared/combat.js';
import { LEVELS, MAX_LEVEL, THEMES, getLevel } from '../shared/levels.js';
import { CampaignSession } from './campaign.js';
import { createRenderer } from './render.js';

const IDS = [
  'game-canvas', 'screen-overlay', 'overlay-title', 'overlay-body',
  'overlay-primary', 'overlay-secondary', 'campaign-button', 'duel-button',
  'campaign-panel', 'duel-panel', 'map-grid', 'theme-label', 'stage-label',
  'stage-title', 'stage-subtitle', 'player-health', 'player-health-text',
  'opponent-health', 'opponent-health-text', 'player-name', 'opponent-name',
  'match-clock', 'session-status', 'checkpoint-label', 'progress-label',
  'room-code', 'room-input', 'create-room', 'join-room', 'copy-room',
  'room-message', 'leave-room', 'rematch', 'sound-toggle', 'toast',
  'special-status', 'special-key-guide', 'special-button',
  'spear-status', 'spear-key-guide', 'spear-button', 'spear-aim-controls', 'spear-angle',
  'aim-up-button', 'aim-down-button', 'aim-cancel-button', 'touch-tip',
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

const keyboard = new Set();
const pointerButtons = new Map();
const campaignPresses = new Set();
let pendingSpearPresses = 0;
let spearNeedsReleaseTick = false;
const campaignActions = new Set([
  'jump', 'attack', 'kick', 'dodge', 'special', 'spear', 'aimUp', 'aimDown', 'aimCancel',
]);
const keyBindings = new Map([
  ['KeyA', 'left'], ['ArrowLeft', 'left'],
  ['KeyD', 'right'], ['ArrowRight', 'right'],
  ['KeyW', 'aimUp'], ['ArrowUp', 'aimUp'],
  ['KeyS', 'aimDown'], ['ArrowDown', 'aimDown'],
  ['KeyJ', 'attack'], ['KeyK', 'kick'], ['KeyL', 'special'], ['KeyI', 'spear'], ['Space', 'jump'],
  ['Escape', 'aimCancel'],
  ['ShiftLeft', 'dodge'], ['ShiftRight', 'dodge'],
]);
let aimDrag = null;
let pendingAimAngle = null;

const duel = {
  socket: null, connection: null, code: null, role: null, theme: 'city',
  phase: 'idle', state: null, previousState: null, receivedAt: 0,
  inputSeq: 0, lastInputAt: 0, seenEvents: new Set(),
};

class SoundEffects {
  constructor() {
    this._enabled = true;
    this.context = null;
    this.output = null;
    this.resuming = null;
    this.pendingKOs = new Set();
    this.pendingCues = new Set();
    this.cueGeneration = 0;
    this.voices = new Set();
    this.maxVoices = 24;
  }

  get enabled() { return this._enabled; }

  set enabled(value) {
    const next = Boolean(value);
    if (next === this._enabled) return;
    this._enabled = next;
    if (!next) this.cancelPendingKOs();
    if (this.output) this.output.gain.value = next ? 0.64 : 0;
  }

  getContext() {
    if (!this.enabled) return null;
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) return null;
    if (!this.context) {
      try {
        this.context = new AudioContextType();
        this.output = this.context.createGain();
        this.output.gain.value = 0.64;
        // A shared bus keeps overlapping hits punchy without clipping the output.
        const compressor = this.context.createDynamicsCompressor?.();
        if (compressor) {
          compressor.threshold.value = -18;
          compressor.knee.value = 18;
          compressor.ratio.value = 4;
          compressor.attack.value = 0.004;
          compressor.release.value = 0.16;
          this.output.connect(compressor).connect(this.context.destination);
        } else {
          this.output.connect(this.context.destination);
        }
      } catch {
        this.context = null;
        this.output = null;
        return null;
      }
    }
    if (this.context.state === 'suspended' && !this.resuming) {
      try {
        this.resuming = Promise.resolve(this.context.resume())
          .catch(() => {})
          .finally(() => { this.resuming = null; });
      } catch { /* Browser denied playback. */ }
    }
    return this.context;
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
    if (!this.enabled) return;
    switch (effect.type) {
      case 'hit':
        if (effect.special) break; // The light wave already has its own impact sound.
        // Only confirmed damage gets an audible wind/body hit; a whiff keeps visual wind only.
        this.noise(effect.heavy ? 0.1 : 0.065, effect.heavy ? 0.068 : 0.048, 900, 'highpass');
        this.tone(effect.heavy ? 132 : 185, effect.heavy ? 45 : 72,
          effect.heavy ? 0.18 : 0.115, effect.heavy ? 0.145 : 0.105, 'sine');
        this.tone(effect.heavy ? 266 : 310, effect.heavy ? 74 : 116,
          effect.heavy ? 0.105 : 0.075, effect.heavy ? 0.055 : 0.035, 'triangle');
        break;
      case 'special-wave':
        this.tone(170, 540, 0.28, 0.08, 'sawtooth', 1);
        this.tone(105, 58, 0.34, 0.11, 'sine', 1);
        this.noise(0.17, 0.055, 1800, 'lowpass', 1);
        this.tone(740, 460, 0.42, 0.048, 'triangle', 1);
        this.queueCue(105, () => this.tone(940, 675, 0.24, 0.038, 'sine', 1));
        break;
      case 'special-ready':
        this.tone(520, 880, 0.17, 0.045);
        this.tone(1040, 1320, 0.21, 0.022, 'sine');
        break;
      case 'boss-windup':
        this.tone(92, 128, 0.19, 0.048, 'sine', 1);
        this.tone(310, 440, 0.22, 0.028, 'triangle', 1);
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
const unlockAudio = () => { if (sound.enabled) sound.getContext(); };
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

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
    aimUp: held.has('aimUp'), aimDown: held.has('aimDown'),
    aimCancel: held.has('aimCancel'),
  };
}

function queueCampaignPress(button) {
  if (mode === 'campaign' && !campaignPaused
    && (campaignView.phase === 'playing' || (campaignView.phase === 'aftermath' && button === 'jump'))
    && campaignActions.has(button)) {
    // Keep distinct I taps even when both land between two simulation frames.
    if (button === 'spear') pendingSpearPresses = Math.min(2, pendingSpearPresses + 1);
    else {
      // A cancellation must also discard a second I tap still waiting behind
      // the release tick, otherwise it can silently start a new aim afterward.
      if (['aimCancel', 'jump', 'attack', 'kick', 'dodge'].includes(button)) pendingSpearPresses = 0;
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

function sendInput(force = false) {
  if (mode !== 'duel' || duel.phase !== 'playing' || duel.socket?.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  if (!force && now - duel.lastInputAt < 48) return;
  duel.lastInputAt = now;
  const held = currentInput();
  // Send only the six authorized PvP controls; new campaign aim fields cannot leak.
  const input = Object.fromEntries(['left', 'right', 'jump', 'attack', 'kick', 'dodge']
    .map((button) => [button, held[button]]));
  duel.socket.send(JSON.stringify({ type: 'input', seq: duel.inputSeq++, input }));
}

document.addEventListener('keydown', (event) => {
  const button = keyBindings.get(event.code);
  if (!button) return;
  if (document.activeElement === ui['room-input']) return;
  event.preventDefault();
  if (!event.repeat) {
    keyboard.add(button);
    queueCampaignPress(button);
    sendInput(true);
  }
});
document.addEventListener('keyup', (event) => {
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

// Dragging the battlefield only adjusts the elevation. Releasing a finger never
// fires a spear: the explicit second I press / 发射 button remains the commit.
ui['game-canvas'].addEventListener('pointerdown', (event) => {
  const hero = campaignView.combat?.fighters.find((fighter) => fighter.team === 0);
  if (mode !== 'campaign' || campaignPaused || campaignView.phase !== 'playing'
      || !hero?.spearAiming || aimDrag) return;
  event.preventDefault();
  ui['game-canvas'].setPointerCapture(event.pointerId);
  aimDrag = { pointerId: event.pointerId, startY: event.clientY,
    startAngle: Number.isFinite(pendingAimAngle) ? pendingAimAngle : hero.spearAimAngle };
  ui['game-canvas'].classList.add('is-aim-dragging');
});
ui['game-canvas'].addEventListener('pointermove', (event) => {
  if (!aimDrag || aimDrag.pointerId !== event.pointerId) return;
  const hero = campaignView.combat?.fighters.find((fighter) => fighter.team === 0);
  if (!hero?.spearAiming || !Number.isFinite(event.clientY)) return;
  event.preventDefault();
  pendingAimAngle = Math.max(SPEAR_MIN_ANGLE, Math.min(SPEAR_MAX_ANGLE,
    aimDrag.startAngle + (aimDrag.startY - event.clientY) * 0.22));
});
function endAimDrag(event) {
  if (!aimDrag || aimDrag.pointerId !== event.pointerId) return;
  aimDrag = null;
  if (event.type === 'pointercancel') pendingAimAngle = null;
  ui['game-canvas'].classList.remove('is-aim-dragging');
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
  ui['game-canvas'].classList.remove('is-aim-dragging');
  if (cancelAim && mode === 'campaign') {
    const hero = campaignView.combat?.fighters.find((fighter) => fighter.team === 0);
    if (hero?.spearAiming) cancelSpearAim(hero);
    // A blur/mode change can happen between ticks. Clear the sampled I edge so
    // the first fresh press after returning is not mistaken for a held key.
    if (hero?.prevInput) hero.prevInput.spear = false;
    updateCampaignHud();
  }
  sendInput(true);
}
window.addEventListener('blur', () => releaseInput(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInput(true); });

function health(fill, label, fighter) {
  const value = fighter ? Math.max(0, Math.ceil(fighter.hp)) : 0;
  const max = fighter?.maxHp ?? 100;
  fill.style.width = `${Math.max(0, Math.min(100, value / max * 100))}%`;
  label.textContent = `${value} / ${max}`;
}

function updateAimAngle(hero) {
  if (!hero?.spearAiming) return;
  const label = `仰角 ${Math.round(hero.spearAimAngle)}°`;
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
    if (stage.number === progress.currentLevel && !progress.completed) node.classList.add('is-current');
    else if (progress.completed && progress.cleared.includes(stage.number)) node.classList.add('is-cleared');
    else if (stage.number < progress.currentLevel && progress.cleared.includes(stage.number)) node.classList.add('is-cleared');
    else node.classList.add('is-locked');
    node.title = `第 ${stage.number} 关 · ${stage.name}${stage.isCheckpoint ? ' · 存档点' : ''}`;
    node.setAttribute('aria-label', node.title);
    node.textContent = String(stage.number).padStart(2, '0');
    node.addEventListener('click', () => {
      notify(stage.number === progress.currentLevel
        ? `当前关卡：${stage.name}`
        : `第 ${stage.number} 关「${stage.name}」${stage.number > progress.currentLevel ? '尚未到达' : '不可跳关，需按存档线路推进'}`);
    });
    fragment.append(node);
  }
  ui['map-grid'].replaceChildren(fragment);
}

function updateCampaignHud() {
  const { level, combat, progress, waveNumber, waveCount,
    specialEligible, specialCharges, specialKills } = campaignView;
  const hero = combat?.fighters.find((fighter) => fighter.team === 0);
  const opponents = combat?.fighters.filter((fighter) => fighter.team === 1 && fighter.hp > 0) ?? [];
  const opponent = opponents[0];
  ui['theme-label'].textContent = `${level.themeName} · 第 ${level.chapter} 章`;
  ui['stage-label'].textContent = `关卡 ${String(level.number).padStart(2, '0')} / ${MAX_LEVEL}`;
  ui['stage-title'].textContent = level.name;
  ui['stage-subtitle'].textContent = campaignView.phase === 'aftermath'
    ? '对手已倒下 · 退开再走过倒地敌人，片刻后结算'
    : `${level.isBoss ? '首领之战 · ' : ''}第 ${level.stage} 关 · 第 ${waveNumber}/${waveCount} 波 · ${level.enemyCount} 名对手`;
  ui['player-name'].textContent = '火柴斗士';
  ui['opponent-name'].textContent = opponent?.name ?? (campaignView.phase === 'aftermath'
    ? '对手已倒下' : ['cleared', 'completed'].includes(campaignView.phase) ? '本关已清除' : '等待下一波');
  health(ui['player-health'], ui['player-health-text'], hero);
  health(ui['opponent-health'], ui['opponent-health-text'], opponent);
  ui['match-clock'].textContent = `${waveNumber} / ${waveCount}`;
  ui['session-status'].textContent = campaignView.phase === 'aftermath'
    ? '胜利收尾 · 可继续走动' : '单人闯关 · 本机存档';
  ui['checkpoint-label'].textContent = `存档点：第 ${String(progress.checkpointLevel).padStart(2, '0')} 关`;
  ui['progress-label'].textContent = `当前进度 ${String(progress.currentLevel).padStart(2, '0')} / ${MAX_LEVEL} · 失败 ${progress.deaths} 次`;
  ui['special-status'].hidden = !specialEligible;
  ui['special-key-guide'].hidden = !specialEligible;
  ui['special-button'].hidden = !specialEligible;
  ui['spear-status'].hidden = false;
  ui['spear-key-guide'].hidden = false;
  ui['spear-button'].hidden = false;
  const active = campaignView.phase === 'playing' && !campaignPaused && hero?.hp > 0;
  const aiming = active && hero.spearAiming === true;
  const winding = active && hero.spearWindup > 0;
  const busy = hero && (hero.stun > 0 || hero.attackStage > 0 || hero.kickType
    || hero.dodgeTicks > 0);
  const spearText = campaignView.phase === 'aftermath'
    ? '胜利收尾 · 退开再走过倒地敌人，落稳后约 3 秒结算'
    : aiming
    ? '瞄准中 · ↑↓ / W S 或上下拖动调角，再按 I 发射，Esc 取消'
    : winding ? '投矛蓄势中 · 被击中会打断'
      : busy ? '投矛不限次数 · 出招结束后按 I 瞄准'
        : '投矛不限次数 · 按 I 瞄准，再按 I 发射';
  if (ui['spear-status'].textContent !== spearText) ui['spear-status'].textContent = spearText;
  ui['spear-status'].classList.toggle('is-ready', active && !busy && !winding);
  ui['spear-status'].classList.toggle('is-aiming', aiming);
  ui['spear-button'].textContent = aiming ? '发射' : winding ? '蓄势中' : '投矛';
  ui['spear-button'].disabled = !active || winding || (!aiming && Boolean(busy));
  ui['spear-button'].setAttribute('aria-label', aiming
    ? `确认发射投矛，当前仰角 ${Math.round(hero.spearAimAngle)} 度`
    : winding ? '投矛蓄势中' : '进入投矛瞄准，不限次数');
  ui['spear-aim-controls'].hidden = !aiming;
  if (aiming) updateAimAngle(hero);
  for (const id of ['aim-up-button', 'aim-down-button', 'aim-cancel-button']) ui[id].disabled = !aiming;
  ui['game-canvas'].classList.toggle('is-aiming', aiming);
  ui['touch-tip'].textContent = campaignView.phase === 'aftermath'
    ? '左右走动 · 退开再走过倒地敌人可触发散骨'
    : aiming
    ? '上下拖动画面或按「抬高/压低」调角 · 点「发射」确认，战斗不会暂停'
    : winding ? '投矛蓄势中 · 被击中会打断'
      : '空中按「踢腿」释放跳踢大招 · 投矛先瞄准、再发射';
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
  if (phase === 'failed') {
    showOverlay({
      title: '挑战失败',
      body: `第 ${failedLevel} 关失利。已回到第 ${progress.checkpointLevel} 关存档原点；血量、敌人和机关会全部重置。`,
      primary: `从第 ${progress.checkpointLevel} 关重试`,
      onPrimary: () => {
        campaignView = campaign.retry();
        resumeCampaign();
        drawMap();
        updateCampaignHud();
        hideOverlay();
      },
    });
  } else if (phase === 'cleared') {
    showOverlay({
      title: '关卡突破',
      body: `第 ${level.number} 关「${level.name}」完成。下一站：第 ${progress.currentLevel} 关「${getLevel(progress.currentLevel).name}」。`,
      primary: '进入下一关',
      onPrimary: () => {
        campaignView = campaign.next();
        resumeCampaign();
        drawMap();
        updateCampaignHud();
        hideOverlay();
      },
    });
  } else if (phase === 'completed') {
    showOverlay({
      title: '56 关全部突破',
      body: '森林、城市、海洋与陆地的九场首领战均已突破。你的通关记录保存在这台浏览器。',
      primary: '开启新的征程',
      onPrimary: () => {
        if (!window.confirm('重新开始将清除当前的 56 关通关进度，确定继续吗？')) return;
        campaignView = campaign.reset();
        resumeCampaign();
        drawMap();
        updateCampaignHud();
        hideOverlay();
      },
    });
  } else if (phase === 'aftermath') {
    showOverlay({
      title: '胜利收尾',
      body: '敌人已经倒下。退开后，从同一层走过倒地敌人可触发散骨；落稳后约 3 秒自动结算，本段不会再受到机关伤害。',
      primary: '继续走动', onPrimary: () => { resumeCampaign(); hideOverlay(); },
    });
  } else {
    showOverlay({
      title: level.number === 1 && progress.cleared.length === 0 ? '准备开战' : '继续征程',
      body: `第 ${level.number} / ${MAX_LEVEL} 关 · ${level.themeName}「${level.name}」。A/D 移动，J 攻击，空格跳跃，Shift 闪避。按 I 预览投矛弧线，↑↓ 调角，再按 I 确认发射；Esc 取消。${campaignView.specialEligible ? '每击倒两名敌人可按 L 释放一次无敌光波。' : ''}`,
      primary: '开始挑战',
      onPrimary: () => { resumeCampaign(); hideOverlay(); },
    });
  }
}

function resumeCampaign() {
  cancelResultOverlay();
  sound.cancelPendingKOs();
  releaseInput(true);
  accumulator = 0;
  campaignPaused = false;
  updateCampaignHud();
}

function consumeEvents(events) {
  for (const effect of events ?? []) {
    renderer.effect(effect);
    sound.play(effect);
    if (mode === 'campaign' && ['spear-aim-cancel', 'special-wave', 'wave'].includes(effect.type)) {
      pendingSpearPresses = 0;
    }
    if (mode === 'campaign' && effect.type === 'special-ready') {
      notify(`光波已充能 ${effect.charges} 次，按 L 或点击光波发动`);
      updateCampaignHud();
    }
    if (mode === 'campaign' && ['spear-aim', 'spear-aim-cancel', 'spear-windup', 'spear-throw', 'special-wave', 'wave']
      .includes(effect.type)) updateCampaignHud();
  }
}

function updateDuelHud() {
  const state = duel.state ?? createDuelState(duel.theme);
  // The fixed P1/P2 HUD positions and colors always match the canvas fighters.
  const [first, second] = state.fighters;
  const theme = THEMES[duel.theme] ?? THEMES.city;
  ui['theme-label'].textContent = `${theme.name} · 对战竞技场`;
  ui['stage-label'].textContent = '实时联机 1V1';
  ui['stage-title'].textContent = '同屏较量，远端决胜';
  ui['stage-subtitle'].textContent = duel.code ? `房间 ${duel.code} · ${duel.role === 'p1' ? '青色斗士' : '赤色斗士'}` : '创建房间，或输入六位房间码加入';
  ui['player-name'].textContent = `${first.name}${duel.role === 'p1' ? ' · 你' : ''}`;
  ui['opponent-name'].textContent = `${second.name}${duel.role === 'p2' ? ' · 你' : ''}`;
  health(ui['player-health'], ui['player-health-text'], first);
  health(ui['opponent-health'], ui['opponent-health-text'], second);
  ui['match-clock'].textContent = duel.phase === 'playing' || duel.phase === 'finished'
    ? String(Math.ceil((state.timerTicks ?? 0) / TICK_RATE)).padStart(2, '0')
    : '--';
  ui['session-status'].textContent = duel.code ? `联机房间 · ${duel.code}` : '联机大厅';
  ui['checkpoint-label'].textContent = '服务器判定命中与胜负';
  ui['progress-label'].textContent = duel.phase === 'playing' ? '99 秒决胜 · 平局可重赛' : '双方到齐后自动开赛';
  ui['special-status'].hidden = true;
  ui['special-key-guide'].hidden = true;
  ui['special-button'].hidden = true;
  ui['special-button'].disabled = true;
  for (const button of aftermathActionButtons) button.disabled = false;
  ui['touch-tip'].textContent = '空中按「踢腿」释放跳踢大招';
  ui['spear-status'].hidden = true;
  ui['spear-key-guide'].hidden = true;
  ui['spear-button'].hidden = true;
  ui['spear-button'].disabled = true;
  ui['spear-aim-controls'].hidden = true;
  for (const id of ['aim-up-button', 'aim-down-button', 'aim-cancel-button']) ui[id].disabled = true;
  ui['game-canvas'].classList.remove('is-aiming', 'is-aim-dragging');
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
  duel.inputSeq = 0;
  duel.seenEvents.clear();
  previewDuel();
  ui['room-message'].textContent = '创建房间，邀请朋友输入房间码即可对战。';
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
  if (['waiting', 'countdown', 'start', 'state', 'finished', 'rematch', 'peer-left'].includes(message.type)
    && message.code !== duel.code) return;
  switch (message.type) {
    case 'created':
    case 'joined':
      duel.code = message.code;
      duel.role = message.role;
      duel.theme = message.theme;
      duel.phase = 'waiting';
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
      ui['room-message'].textContent = `房间 ${message.code} · 等待第二位玩家加入`;
      updateDuelHud();
      break;
    case 'countdown':
      cancelResultOverlay();
      sound.cancelPendingKOs();
      duel.phase = 'countdown';
      if (mode === 'duel') showOverlay({ title: `${message.seconds}`, body: '对手已就位 · 战斗即将开始' });
      break;
    case 'start':
      cancelResultOverlay();
      sound.cancelPendingKOs();
      duel.phase = 'playing';
      duel.role = message.role;
      duel.theme = message.theme;
      duel.inputSeq = 0;
      duel.seenEvents.clear();
      ui['room-message'].textContent = `房间 ${message.code} · 战斗进行中`;
      if (mode === 'duel') hideOverlay();
      sendInput(true);
      break;
    case 'state':
      duel.previousState = duel.state;
      duel.state = message.state;
      duel.receivedAt = performance.now();
      if (message.phase === 'playing') duel.phase = 'playing';
      processDuelEvents(message.state?.events);
      if (mode === 'duel') updateDuelHud();
      break;
    case 'finished': {
      duel.previousState = duel.state;
      duel.state = message.state;
      duel.receivedAt = performance.now();
      duel.phase = 'finished';
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
    case 'error':
      notify(message.message || '房间请求失败');
      break;
    default:
      break;
  }
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
  cancelResultOverlay();
  sound.cancelPendingKOs();
  if (mode === 'duel' && duel.code) leaveRoom();
  releaseInput(true);
  mode = next;
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
}

ui['campaign-button'].addEventListener('click', () => switchMode('campaign'));
ui['duel-button'].addEventListener('click', () => switchMode('duel'));
function updateSoundToggle() {
  const label = `音效：${sound.enabled ? '开' : '关'}`;
  const text = ui['sound-toggle'].querySelector('span');
  if (text) text.textContent = label;
  ui['sound-toggle'].setAttribute('aria-label', label);
  ui['sound-toggle'].setAttribute('aria-pressed', String(sound.enabled));
}
ui['sound-toggle'].addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  if (!sound.enabled) sound.cancelPendingKOs();
  updateSoundToggle();
  if (sound.enabled) sound.getContext();
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
        const vx = fighter.dodgeTicks > 0 ? fighter.vx : direction * (fighter.speed ?? 4.45);
        return { ...fighter, x: Math.max(19, Math.min(941, fighter.x + vx * lookAhead * 0.62)) };
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

  if (mode === 'duel') sendInput();
  const view = mode === 'campaign'
    ? (campaignView.combat ?? createDuelState(campaignView.level.theme))
    : duelPresentation(now);
  const stage = mode === 'campaign' ? campaignView.level : null;
  renderer.render(view, {
    theme: mode === 'campaign' ? stage.theme : duel.theme,
    mode, level: stage?.number, time: now / 1000,
    campaignPhase: mode === 'campaign' ? campaignView.phase : undefined,
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
requestAnimationFrame(frame);
