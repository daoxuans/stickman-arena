import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CampaignSession } from '../public/campaign.js';
import { createDuelState } from '../shared/combat.js';
import { BOSS_EQUIPMENT } from '../shared/equipment.js';

class FakeNode {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.width = 960;
    this.height = 540;
    this.videoWidth = 640;
    this.videoHeight = 480;
    this.files = [];
    this.clicks = 0;
    this.open = false;
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        if (force ?? !classes.has(name)) classes.add(name);
        else classes.delete(name);
      },
    };
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }

  fire(type, details = {}) {
    const event = { type, target: this, preventDefault() {}, pointerId: 0, ...details };
    for (const callback of this.listeners.get(type) ?? []) callback(event);
    return event;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  setPointerCapture() {}
  focus() { globalThis.document.activeElement = this; }
  click() { this.clicks++; this.fire('click'); }
  showModal() { this.open = true; this.hidden = false; }
  close() { this.open = false; this.hidden = true; this.fire('close'); }
  play() { return Promise.resolve(); }
  pause() {}
  toDataURL() { return 'data:image/png;base64,bG9jYWwtYXZhdGFy'; }
  querySelector(selector) {
    if (selector === 'span') return new FakeNode('label');
    if (selector === '[aria-pressed="true"]') return this.children.find((child) =>
      child.attributes?.get('aria-pressed') === 'true') ?? null;
    return null;
  }
  replaceChildren(...nodes) { this.children = nodes.flatMap((node) => node.isFragment ? node.children : [node]); }
  append(...nodes) { this.children.push(...nodes); }
  getContext() { return fakeCanvasContext; }
}

const gradient = { addColorStop() {} };
const fakeCanvasContext = new Proxy({
  createLinearGradient: () => gradient,
  createRadialGradient: () => gradient,
}, {
  get(target, property) { return property in target ? target[property] : () => {}; },
  set(target, property, value) { target[property] = value; return true; },
});

test('portrait setup exposes explicit local-only upload and camera fallback controls', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /<button id="avatar-open"[^>]*aria-label="[^"]*头像/);
  assert.match(page, /<dialog id="avatar-dialog"[^>]*aria-labelledby="avatar-dialog-title"[^>]*aria-describedby="avatar-privacy"/);
  assert.match(page, /id="avatar-privacy"[^>]*>[^<]*当前页面内存[^<]*不上传服务器[^<]*不传给对手[^<]*刷新页面后需重新选择/);
  assert.match(page, /<input id="avatar-file"[^>]*type="file"[^>]*accept="[^"]*image\/jpeg[^"]*image\/png[^"]*image\/webp/);
  assert.match(page, /<input id="avatar-camera-file"[^>]*type="file"[^>]*capture="user"/);
  for (const id of ['avatar-upload', 'avatar-camera', 'avatar-camera-fallback',
    'avatar-video', 'avatar-shutter', 'avatar-stop-camera', 'avatar-reset', 'avatar-close']) {
    assert.match(page, new RegExp(`id="${id}"`), `${id} is present for the camera and consent flow`);
  }
  assert.match(page, /id="replay-exit"[^>]*hidden/);
  assert.match(page, /已过可重打/);
  for (const id of ['equipment-status', 'backpack-open', 'equipment-button',
    'backpack-dialog', 'backpack-close', 'backpack-list']) {
    assert.match(page, new RegExp(`id="${id}"`), `${id} is a visible or accessible equipment entry`);
  }
  assert.match(page, /<dialog id="backpack-dialog"[^>]*aria-labelledby="backpack-title"/);
  assert.match(page, /data-key="equipment"/);
  assert.match(page, /联机技能说明/);
  assert.match(page, /横向三倍战场有旋转木条/);
  assert.match(page, /投矛 · 每人每局 5 发/);
  assert.match(page, /光波 · 3 次命中充能/);
});

test('PvP HUD colors identify red P1 and cyan P2 without recoloring campaign foes', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const style = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(page, /id="fight-hud" class="fight-hud"/);
  assert.match(style, /\.fighter-status--opponent \.health-fill \{[^}]*var\(--signal-hot\)/,
    'campaign enemies retain the existing coral health bar');
  assert.match(style, /\.fight-hud\.is-duel \.fighter-status--player \.health-fill \{[^}]*#a84246/,
    'only the duel P1 health bar uses a warm red gradient');
  assert.match(style, /\.fight-hud\.is-duel \.fighter-status--opponent \{ border-color: #76cfe3; \}/,
    'only the duel P2 HUD frame switches to cyan');
  assert.match(style, /\.fight-hud\.is-duel \.fighter-status--opponent \.health-fill \{[^}]*#66c6d9/,
    'duel P2 health uses the matching cool cyan gradient');
});

test('browser controller boots, switches modes, starts a fight and renders a frame', async () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = [...page.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const aimControlsMarkup = page.match(/<div id="spear-aim-controls"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(aimControlsMarkup, /<span id="spear-angle"/, 'touch aiming shows its own angle readout');
  const elements = new Map(ids.map((id) => [id, new FakeNode(id)]));
  elements.get('duel-theme').value = 'city';
  for (const id of ['avatar-dialog', 'avatar-preview', 'avatar-chip-photo', 'backpack-dialog',
    'avatar-camera-fallback', 'avatar-camera-view', 'replay-exit']) elements.get(id).hidden = true;
  const touchIds = { special: 'special-button', spear: 'spear-button', aimUp: 'aim-up-button',
    aimDown: 'aim-down-button', aimCancel: 'aim-cancel-button', equipment: 'equipment-button' };
  const buttons = ['left', 'right', 'attack', 'kick', 'jump', 'dodge', 'special', 'spear',
    'equipment', 'aimUp', 'aimDown', 'aimCancel'].map((key) => {
    const node = touchIds[key] ? elements.get(touchIds[key]) : new FakeNode();
    node.dataset.key = key;
    return node;
  });
  const frames = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const sockets = [];
  const campaignInputs = [];
  const savedItems = new Map();
  let storageWrites = 0;
  const localStorage = {
    getItem(key) { return savedItems.get(key) ?? null; },
    setItem(key, value) { storageWrites++; savedItems.set(key, String(value)); },
    removeItem(key) { savedItems.delete(key); },
  };
  let cameraRequests = 0;
  let cameraStops = 0;
  const stream = { getTracks: () => [{ stop() { cameraStops++; } }] };
  const navigator = { mediaDevices: { async getUserMedia() {
    cameraRequests++;
    if (cameraRequests === 1) throw new Error('permission denied');
    return stream;
  } } };
  const timers = new Map();
  let timerId = 0;
  const fireTimers = (delay) => {
    for (const [id, entry] of [...timers]) {
      if (entry.delay !== delay) continue;
      timers.delete(id);
      entry.callback();
    }
  };
  // Observe actual browser-controller music routing without exporting its
  // private SoundEffects instance or depending on a real audio device.
  const audio = { contexts: [], starts: [], stops: [], master: null };
  const parameter = () => ({
    value: 0,
    setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; },
    exponentialRampToValueAtTime(value) { this.value = value; },
    cancelScheduledValues() {},
  });
  const audioNode = () => ({
    connect(next) { this.to = next; return next; },
    disconnect() {},
  });
  const sourceNode = (oscillator = false) => ({
    ...audioNode(),
    start(at) {
      // Music has a separate gain bus before the existing effects master.
      const music = oscillator && this.to?.to !== audio.master && this.to?.to?.to === audio.master;
      audio.starts.push({ music, at });
      this.music = music;
    },
    stop(at) { audio.stops.push({ music: this.music, at }); },
  });
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.destination = audioNode();
      audio.contexts.push(this);
    }

    createGain() {
      const gain = { ...audioNode(), gain: parameter() };
      audio.master ??= gain;
      return gain;
    }
    createDynamicsCompressor() {
      return { ...audioNode(), threshold: parameter(), knee: parameter(), ratio: parameter(),
        attack: parameter(), release: parameter() };
    }
    createOscillator() { return { ...sourceNode(true), frequency: parameter() }; }
    createBuffer(_channels, count) { return { getChannelData: () => new Float32Array(count) }; }
    createBufferSource() { return sourceNode(); }
    createBiquadFilter() { return { ...audioNode(), frequency: parameter() }; }
    resume() { return Promise.resolve(); }
  }
  const musicStarts = () => audio.starts.filter((entry) => entry.music).length;
  const musicStops = () => audio.stops.filter((entry) => entry.music && entry.at === undefined).length;
  let latestCampaignView;
  let activeCampaign;
  const originalCampaignStep = CampaignSession.prototype.step;
  CampaignSession.prototype.step = function captureCampaignInput(input) {
    activeCampaign = this;
    campaignInputs.push({ ...input });
    latestCampaignView = originalCampaignStep.call(this, input);
    return latestCampaignView;
  };
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.fire('open'); });
    }

    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }

    fire(type, details = {}) {
      for (const callback of this.listeners.get(type) ?? []) callback(details);
    }

    send(payload) { this.sent.push(JSON.parse(payload)); }
  }
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    WebSocket: globalThis.WebSocket,
    matchMedia: globalThis.matchMedia,
  };
  const browserGlobals = Object.fromEntries(['localStorage', 'navigator', 'Image']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true });
  globalThis.document = {
    activeElement: null,
    hidden: false,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: () => new FakeNode(),
    createDocumentFragment: () => Object.assign(new FakeNode(), { isFragment: true }),
    querySelectorAll: (selector) => selector === '[data-key]' ? buttons : [],
    addEventListener(type, callback) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(callback);
    },
    fire(type, details = {}) {
      const event = { preventDefault() {}, ...details };
      for (const callback of documentListeners.get(type) ?? []) callback(event);
    },
  };
  globalThis.window = {
    AudioContext: FakeAudioContext,
    addEventListener(type, callback) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(callback);
    },
    fire(type) { for (const callback of windowListeners.get(type) ?? []) callback(); },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    confirm: () => true,
  };
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:3001' };
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); };
  globalThis.WebSocket = FakeWebSocket;
  try {
    await import(`../public/app.js?bootstrap=${Date.now()}`);
    assert.equal(elements.get('map-grid').children.length, 56);
    assert.equal(elements.get('screen-overlay').hidden, false);
    assert.equal(elements.get('duel-panel').hidden, true);
    assert.equal(elements.get('stage-title').textContent, '林缘试招');
    assert.equal(elements.get('special-button').hidden, true, 'the first room cannot use the wave');
    assert.equal(elements.get('spear-button').hidden, false, 'campaign shows the spear action');
    assert.equal(elements.get('spear-button').disabled, true, 'pre-fight overlay keeps the action inactive');
    assert.match(elements.get('spear-status').textContent, /剩余 5\/5/);
    assert.equal(elements.get('spear-guide-remaining').textContent, '5/5');
    assert.equal(audio.contexts.length, 0, 'opening the page does not start browser audio');
    document.fire('pointerdown');
    assert.equal(audio.contexts.length, 1, 'a user gesture unlocks one shared audio context');
    assert.equal(musicStarts(), 0, 'the start overlay does not autoplay the battle score');
    assert.equal(elements.get('overlay-secondary').textContent, '设置头像',
      'the first start screen offers portrait setup before the fight');
    assert.equal(cameraRequests, 0, 'opening the page never requests camera permission');
    const firstSave = savedItems.get('stickman-arena.campaign.v1');
    const writesBeforeAvatar = storageWrites;
    elements.get('overlay-secondary').focus();
    elements.get('overlay-secondary').fire('click');
    assert.equal(elements.get('avatar-dialog').open, true);
    assert.equal(cameraRequests, 0, 'opening portrait setup also leaves camera permission untouched');

    // Permission is requested only by the explicit camera action, and an
    // unavailable/denied stream retains a native capture-file alternative.
    elements.get('avatar-camera').fire('click');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cameraRequests, 1);
    assert.equal(elements.get('avatar-camera-fallback').hidden, false);
    elements.get('avatar-camera-fallback').fire('click');
    assert.equal(elements.get('avatar-camera-file').clicks, 1);
    elements.get('avatar-camera').fire('click');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cameraRequests, 2);
    assert.equal(elements.get('avatar-video').srcObject, stream);
    assert.equal(elements.get('avatar-camera-view').hidden, false);
    elements.get('avatar-shutter').fire('click');
    assert.match(elements.get('avatar-preview').src, /^data:image\/png;base64,/);
    assert.equal(elements.get('avatar-preview').hidden, false);
    const stopsAfterShutter = cameraStops;
    assert.ok(stopsAfterShutter > 0, 'capturing a frame releases its video stream');
    elements.get('avatar-camera').fire('click');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cameraRequests, 3);
    assert.equal(elements.get('avatar-video').srcObject, stream);
    elements.get('avatar-close').fire('click');
    assert.equal(elements.get('avatar-dialog').open, false);
    assert.ok(cameraStops > stopsAfterShutter, 'closing setup releases any live camera tracks');
    assert.equal(globalThis.document.activeElement, elements.get('overlay-secondary'),
      'closing setup returns keyboard focus to its opener');

    // The same local preview path accepts a file, and can be reset without
    // touching either the campaign save or any multiplayer message.
    elements.get('avatar-open').fire('click');
    elements.get('avatar-dialog').fire('close'); // A late close event from the previous opening.
    assert.equal(elements.get('avatar-dialog').open, true);
    assert.equal(elements.get('avatar-dialog').hidden, false,
      'a queued native close event cannot hide a rapidly reopened setup');
    navigator.mediaDevices = null;
    elements.get('avatar-camera').fire('click');
    assert.equal(cameraRequests, 3, 'unsupported devices do not attempt a permission request');
    assert.equal(elements.get('avatar-camera-fallback').hidden, false,
      'a device without getUserMedia still exposes the native capture picker');
    elements.get('avatar-reset').fire('click');
    assert.equal(elements.get('avatar-preview').hidden, true);
    assert.equal(elements.get('avatar-chip-photo').hidden, true);
    class DecodedImage {
      naturalWidth = 640;
      naturalHeight = 480;
      set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
      get src() { return this._src; }
    }
    Object.defineProperty(globalThis, 'Image', { value: DecodedImage, configurable: true });
    elements.get('avatar-upload').fire('click');
    assert.equal(elements.get('avatar-file').clicks, 1, 'the visible upload control opens the native file picker');
    elements.get('avatar-file').files = [new Blob(['private local photo'], { type: 'image/png' })];
    elements.get('avatar-file').fire('change');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(elements.get('avatar-preview').src, /^data:image\/png;base64,/);
    assert.equal(elements.get('avatar-chip-photo').hidden, false);
    assert.equal(savedItems.get('stickman-arena.campaign.v1'), firstSave);
    assert.equal(storageWrites, writesBeforeAvatar, 'portrait choice never enters the campaign save');
    elements.get('avatar-close').fire('click');

    elements.get('duel-button').fire('click');
    assert.equal(elements.get('campaign-panel').hidden, true);
    assert.equal(elements.get('duel-panel').hidden, false);
    assert.equal(elements.get('fight-hud').classList.contains('is-duel'), true,
      'the P1/P2 HUD gets duel-only colors');
    assert.equal(elements.get('stage-label').textContent, '实时联机 1V1');
    assert.equal(elements.get('avatar-open').disabled, false, 'the idle duel lobby can set a local portrait');

    elements.get('campaign-button').fire('click');
    assert.equal(elements.get('fight-hud').classList.contains('is-duel'), false,
      'campaign enemies return to their original warm-colored HUD');
    elements.get('overlay-primary').fire('click');
    assert.equal(elements.get('screen-overlay').hidden, true);
    assert.ok(musicStarts() > 0, 'starting the campaign begins its quiet theme after the gesture');
    assert.equal(timers.size, 1, 'one scheduler continues the background theme');
    assert.ok([...timers.values()][0].delay >= 40 && [...timers.values()][0].delay <= 600);
    assert.ok(frames.length > 0);
    let frameTime = performance.now();
    function advanceFrame(milliseconds = 18) {
      frameTime = Math.max(frameTime, performance.now()) + milliseconds;
      const before = campaignInputs.length;
      const next = frames.shift();
      assert.ok(next, 'game should schedule a frame');
      next(frameTime);
      return campaignInputs.slice(before);
    }
    const tapKey = (code) => {
      document.fire('keydown', { code, repeat: false });
      document.fire('keyup', { code });
    };
    const campaignHero = () => latestCampaignView.combat.fighters.find((fighter) => fighter.id === 'hero');
    advanceFrame(35);
    assert.equal(elements.get('equipment-status').hidden, false);
    assert.equal(elements.get('equipment-count').textContent, '0');
    assert.equal(elements.get('equipment-button').hidden, true,
      'a new player does not see an unusable equipment attack control');
    const bagTick = activeCampaign.combat.tick;
    tapKey('KeyB');
    assert.equal(elements.get('backpack-dialog').open, true);
    assert.match(elements.get('backpack-list').children[0].textContent, /背包还是空的/);
    advanceFrame(35);
    assert.equal(activeCampaign.combat.tick, bagTick, 'opening the backpack pauses live combat');
    elements.get('backpack-dialog').fire('cancel');
    assert.equal(elements.get('backpack-dialog').open, false, 'Escape cancel closes the modal');
    tapKey('KeyB');
    assert.equal(elements.get('backpack-dialog').open, true, 'the bag can reopen after Escape');
    tapKey('KeyB');
    assert.equal(elements.get('backpack-dialog').open, false);
    advanceFrame(35);
    assert.ok(activeCampaign.combat.tick > bagTick, 'closing the backpack resumes the fight');
    const pausedTick = activeCampaign.combat.tick;
    tapKey('KeyJ');
    elements.get('avatar-open').fire('click');
    assert.equal(elements.get('avatar-dialog').open, true);
    advanceFrame(35);
    assert.equal(activeCampaign.combat.tick, pausedTick, 'portrait setup pauses the live campaign');
    elements.get('avatar-close').fire('click');
    assert.equal(elements.get('screen-overlay').hidden, false,
      'closing portrait setup asks before resuming the paused fight');
    advanceFrame(35);
    assert.equal(activeCampaign.combat.tick, pausedTick, 'the continue screen holds the fight still');
    elements.get('overlay-primary').fire('click');
    assert.equal(advanceFrame(35)[0].attack, false,
      'an attack pressed before opening portrait setup cannot fire on resume');
    assert.equal(elements.get('spear-button').disabled, false, 'a player can aim from the first fight without a KO');
    assert.equal(elements.get('spear-button').attributes.get('aria-label'), '进入投矛瞄准，剩余 5 次');
    assert.match(elements.get('player-health-text').textContent, /100 \/ 100/);

    tapKey('KeyI');
    assert.equal(advanceFrame()[0].spear, true);
    assert.equal(campaignHero().spearAiming, true, 'first I press should preview an arc, not throw');
    assert.equal(campaignHero().spearWindup, 0);
    assert.equal(elements.get('spear-button').textContent, '发射 ×5');
    assert.equal(elements.get('spear-aim-controls').hidden, false);
    assert.equal(elements.get('spear-angle').textContent,
      `仰角 ${Math.round(campaignHero().spearAimAngle)}°`);
    const startingAngle = campaignHero().spearAimAngle;
    document.fire('keydown', { code: 'ArrowUp', repeat: false });
    advanceFrame();
    document.fire('keyup', { code: 'ArrowUp' });
    assert.ok(campaignHero().spearAimAngle > startingAngle, 'up raises the throwing angle');
    assert.equal(elements.get('spear-angle').textContent,
      `仰角 ${Math.round(campaignHero().spearAimAngle)}°`, 'keyboard adjustments refresh the touch readout');
    const raisedAngle = campaignHero().spearAimAngle;
    const canvas = elements.get('game-canvas');
    canvas.fire('pointerdown', { pointerId: 77, clientY: 180 });
    canvas.fire('pointermove', { pointerId: 77, clientY: 140 });
    canvas.fire('pointerup', { pointerId: 77, clientY: 140 });
    const dragged = advanceFrame();
    assert.ok(dragged[0].aimAngle > raisedAngle, 'stage drag sends a finite angle to the simulation');
    assert.ok(campaignHero().spearAimAngle > raisedAngle, 'dragging upwards raises the angle');
    assert.equal(elements.get('spear-angle').textContent,
      `仰角 ${Math.round(campaignHero().spearAimAngle)}°`, 'drag adjustments refresh the touch readout');
    const beforeDown = campaignHero().spearAimAngle;
    const aimDown = elements.get('aim-down-button');
    aimDown.fire('pointerdown', { pointerId: 78 });
    aimDown.fire('pointerup', { pointerId: 78 });
    advanceFrame();
    assert.ok(campaignHero().spearAimAngle < beforeDown, 'a short touch press lowers the angle');
    assert.equal(elements.get('spear-angle').textContent,
      `仰角 ${Math.round(campaignHero().spearAimAngle)}°`, 'touch adjustments refresh the angle readout');
    assert.equal(campaignHero().spearWindup, 0, 'adjusting/releasing the stage does not throw');

    tapKey('KeyI');
    advanceFrame();
    assert.equal(campaignHero().spearAiming, false);
    assert.ok(campaignHero().spearWindup > 0, 'second I press commits a 20-tick windup');
    assert.equal(latestCampaignView.spearRemaining, 5, 'confirming alone does not spend a spear');
    assert.equal(elements.get('spear-button').disabled, true);
    assert.equal(elements.get('spear-aim-controls').hidden, true);
    for (let index = 0; index < 4; index++) advanceFrame(100);
    assert.equal(campaignHero().spearWindup, 0, 'the committed throw completes before re-aiming');
    assert.equal(latestCampaignView.spearRemaining, 4);
    assert.equal(elements.get('spear-guide-remaining').textContent, '4/5');
    assert.equal(elements.get('spear-button').textContent, '投矛 ×4');
    assert.match(elements.get('touch-tip').textContent, /剩余 4\/5/);
    tapKey('KeyI');
    advanceFrame();
    assert.equal(campaignHero().spearAiming, true, 'a remaining spear can be aimed again');
    tapKey('Escape');
    advanceFrame();
    assert.equal(campaignHero().spearAiming, false, 'Escape cancels without a projectile');
    assert.equal(latestCampaignView.spearRemaining, 4, 'cancel leaves the allowance intact');
    const spearTouch = elements.get('spear-button');
    spearTouch.fire('pointerdown', { pointerId: 79 });
    spearTouch.fire('pointerup', { pointerId: 79 });
    advanceFrame();
    assert.equal(campaignHero().spearAiming, true, 'the touch spear button enters the same aim state');
    advanceFrame();
    spearTouch.fire('pointerdown', { pointerId: 79 });
    spearTouch.fire('pointerup', { pointerId: 79 });
    advanceFrame();
    assert.ok(campaignHero().spearWindup > 0, 'touch 发射 explicitly confirms the aimed throw');
    for (let index = 0; index < 4; index++) advanceFrame(100);
    assert.equal(latestCampaignView.spearRemaining, 3);
    spearTouch.fire('pointerdown', { pointerId: 79 });
    spearTouch.fire('pointerup', { pointerId: 79 });
    advanceFrame();
    assert.equal(campaignHero().spearAiming, true, 'touch can aim again while throws remain');
    const cancelTouch = elements.get('aim-cancel-button');
    cancelTouch.fire('pointerdown', { pointerId: 80 });
    cancelTouch.fire('pointerup', { pointerId: 80 });
    advanceFrame();
    assert.equal(campaignHero().spearAiming, false, 'touch cancel leaves the throw uncommitted');
    assert.equal(latestCampaignView.spearRemaining, 3);

    // Core tests deplete five actual launches. Here the exhausted state probes
    // both visible touch controls and the keyboard command path without
    // spending the rest of the browser integration test firing four more.
    activeCampaign.combat.spearRemaining = 0;
    advanceFrame(100);
    assert.equal(elements.get('spear-button').disabled, true);
    assert.equal(elements.get('spear-button').textContent, '投矛 ×0');
    assert.equal(elements.get('spear-guide-remaining').textContent, '0/5');
    assert.match(elements.get('spear-status').textContent, /已用尽/);
    assert.match(elements.get('touch-tip').textContent, /0\/5/);
    tapKey('KeyI');
    assert.equal(advanceFrame()[0].spear, false, 'an exhausted keyboard press does not queue a new aim');
    assert.equal(campaignHero().spearAiming, false);
    spearTouch.fire('pointerdown', { pointerId: 83 });
    assert.equal(advanceFrame()[0].spear, false, 'disabled touch cannot queue a sixth spear');
    activeCampaign.combat.spearRemaining = 3;
    advanceFrame(100);

    for (const [label, cancel] of [
      ['Escape', () => tapKey('Escape')],
      ['touch cancel', () => {
        cancelTouch.fire('pointerdown', { pointerId: 82 });
        cancelTouch.fire('pointerup', { pointerId: 82 });
      }],
    ]) {
      tapKey('KeyI');
      tapKey('KeyI');
      assert.equal(advanceFrame()[0].spear, true);
      assert.equal(campaignHero().spearAiming, true, `${label}: first rapid I tap enters aim`);
      cancel();
      assert.equal(advanceFrame()[0].spear, false, `${label}: cancel wins over the pending second tap`);
      for (let index = 0; index < 2; index++) {
        assert.equal(advanceFrame()[0].spear, false, `${label}: no delayed throw or re-aim`);
      }
      assert.equal(campaignHero().spearAiming, false, `${label}: aim stays cancelled`);
      assert.equal(campaignHero().spearWindup, 0, `${label}: no throw is committed`);
      assert.equal(elements.get('spear-aim-controls').hidden, true);
    }

    // Casting a charged wave cancels aim and updates the controls in the same
    // simulation frame, without waiting for the regular HUD refresh interval.
    activeCampaign.specialEligible = true;
    activeCampaign.specialCharges = 1;
    tapKey('KeyI');
    advanceFrame();
    assert.equal(campaignHero().spearAiming, true);
    advanceFrame(100);
    assert.equal(elements.get('special-button').disabled, false);
    assert.equal(elements.get('spear-aim-controls').hidden, false);
    tapKey('KeyL');
    assert.equal(advanceFrame()[0].special, true);
    assert.ok(latestCampaignView.events.some((event) => event.type === 'special-wave'));
    assert.equal(campaignHero().spearAiming, false);
    assert.equal(elements.get('spear-aim-controls').hidden, true, 'wave hides aim controls immediately');
    assert.equal(elements.get('spear-button').textContent, '投矛 ×3',
      'wave restores the spear button without spending a throw');
    assert.equal(elements.get('spear-button').disabled, false);
    assert.equal(elements.get('special-button').disabled, true, 'spent wave charge updates immediately');
    activeCampaign.specialEligible = false;
    activeCampaign.specialCharges = 0;

    tapKey('KeyI');
    advanceFrame();
    const musicStopsBeforeBlur = musicStops();
    window.fire('blur');
    assert.equal(campaignHero().spearAiming, false, 'losing focus cancels uncommitted aim');
    assert.ok(musicStops() > musicStopsBeforeBlur, 'losing focus cuts off the campaign score');
    const musicBeforeFocus = musicStarts();
    window.fire('focus');
    assert.ok(musicStarts() > musicBeforeFocus, 'returning focus resumes just the active scene');
    document.fire('keydown', { code: 'KeyI', repeat: false });
    advanceFrame();
    assert.equal(campaignHero().spearAiming, true, 'holding I first enters aim');
    for (let index = 0; index < 4; index++) advanceFrame(35);
    assert.equal(campaignHero().spearAiming, true, 'holding I never confirms the throw');
    assert.equal(campaignHero().spearWindup, 0);
    document.fire('keyup', { code: 'KeyI' });
    tapKey('Escape');
    advanceFrame();
    tapKey('KeyI');
    advanceFrame();
    assert.equal(campaignHero().spearAiming, true);
    const musicStopsBeforeMode = musicStops();
    elements.get('duel-button').fire('click');
    assert.equal(campaignHero().spearAiming, false, 'switching modes drops an unconfirmed aim');
    assert.ok(musicStops() > musicStopsBeforeMode, 'switching to the duel lobby stops campaign music');
    const musicInLobby = musicStarts();
    advanceFrame();
    assert.equal(musicStarts(), musicInLobby, 'the duel lobby stays silent');
    elements.get('campaign-button').fire('click');
    elements.get('overlay-primary').fire('click');
    assert.ok(musicStarts() > musicInLobby, 'resuming the campaign restores its theme once');

    tapKey('KeyI');
    tapKey('KeyI');
    assert.equal(advanceFrame()[0].spear, true);
    assert.equal(campaignHero().spearAiming, true, 'the first rapid tap still shows the arc');
    assert.equal(advanceFrame()[0].spear, false, 'a release tick separates rapid taps');
    assert.equal(advanceFrame()[0].spear, true, 'the second rapid tap is not merged or lost');
    assert.ok(campaignHero().spearWindup > 0, 'rapid double-tap can commit once');
    const committedTicks = campaignHero().spearWindup;
    elements.get('duel-button').fire('click');
    assert.equal(campaignHero().spearWindup, committedTicks,
      'switching away pauses but does not undo an already committed spear');
    elements.get('campaign-button').fire('click');
    elements.get('overlay-primary').fire('click');
    advanceFrame();
    assert.ok(campaignHero().spearWindup < committedTicks,
      'the committed windup continues on the next live campaign tick');
    for (let index = 0; index < 4; index++) advanceFrame(100);

    // Both short presses occur between simulation ticks, yet the next tick
    // must see them together and resolve jump + kick as an air kick.
    tapKey('Space');
    tapKey('KeyK');
    const combo = advanceFrame();
    assert.equal(combo[0].jump, true);
    assert.equal(combo[0].kick, true);
    assert.equal(latestCampaignView.combat.fighters.find((fighter) => fighter.id === 'hero').kickType, 'air');
    assert.equal(advanceFrame()[0].jump, false);
    assert.equal(campaignInputs.at(-1).kick, false);

    for (const [code, action] of [['Space', 'jump'], ['KeyJ', 'attack'], ['KeyK', 'kick'], ['KeyL', 'special'], ['KeyI', 'spear'], ['ShiftLeft', 'dodge']]) {
      tapKey(code);
      assert.equal(advanceFrame()[0][action], true, `short ${action} keyboard tap should survive until the next tick`);
      assert.equal(advanceFrame()[0][action], false, `${action} must not automatically repeat`);
    }
    for (const [index, action] of ['jump', 'attack', 'kick', 'dodge'].entries()) {
      const button = buttons.find((entry) => entry.dataset.key === action);
      button.fire('pointerdown', { pointerId: 20 + index });
      button.fire('pointerup', { pointerId: 20 + index });
      button.fire('lostpointercapture', { pointerId: 20 + index });
      assert.equal(advanceFrame()[0][action], true, `short ${action} touch tap should survive until the next tick`);
      assert.equal(advanceFrame()[0][action], false, `${action} touch tap must be consumed once`);
    }
    const unavailableSpecial = buttons.find((entry) => entry.dataset.key === 'special');
    unavailableSpecial.fire('pointerdown', { pointerId: 81 });
    assert.equal(advanceFrame()[0].special, false, 'hidden or disabled touch actions never queue');
    tapKey('KeyJ');
    const catchUpSteps = advanceFrame(45);
    assert.ok(catchUpSteps.length > 1, 'a delayed animation frame should simulate multiple ticks');
    assert.equal(catchUpSteps[0].attack, true);
    assert.ok(catchUpSteps.slice(1).every((input) => !input.attack), 'a short press belongs only to the first tick');

    latestCampaignView.combat.hitstop = 3;
    tapKey('KeyJ');
    const hitstopSteps = advanceFrame(100);
    assert.equal(hitstopSteps.length, 5);
    assert.ok(hitstopSteps.slice(0, 3).every((input) => !input.attack), 'hitstop ticks do not sample actions');
    assert.equal(hitstopSteps[3].attack, true, 'the first sampling tick receives the short press');
    assert.equal(hitstopSteps[4].attack, false, 'the press is consumed after the first sampling tick');

    tapKey('KeyK');
    window.fire('blur');
    assert.equal(advanceFrame()[0].kick, false, 'blur must drop queued actions');
    tapKey('ShiftLeft');
    globalThis.document.hidden = true;
    const musicStopsBeforeHidden = musicStops();
    globalThis.document.fire('visibilitychange');
    assert.equal(advanceFrame()[0].dodge, false, 'hiding the tab must drop queued actions');
    assert.ok(musicStops() > musicStopsBeforeHidden, 'a hidden tab stops background music');
    globalThis.document.hidden = false;
    const musicBeforeVisible = musicStarts();
    globalThis.document.fire('visibilitychange');
    assert.ok(musicStarts() > musicBeforeVisible, 'a visible, already-unlocked game can resume music');

    tapKey('KeyK');
    elements.get('duel-button').fire('click');
    elements.get('campaign-button').fire('click');
    document.fire('keydown', { code: 'Space', repeat: false });
    elements.get('overlay-primary').fire('click');
    assert.equal(advanceFrame()[0].kick, false, 'mode switch must clear the old campaign tap');
    assert.equal(campaignInputs.at(-1).jump, false, 'a key pressed while paused must not fire on resume');
    document.fire('keyup', { code: 'Space' });

    tapKey('KeyL');
    tapKey('KeyI');
    window.fire('blur');
    assert.equal(advanceFrame()[0].special, false, 'blur drops a queued light wave');
    assert.equal(campaignInputs.at(-1).spear, false, 'blur drops a queued spear');

    document.fire('keydown', { code: 'ShiftLeft', repeat: false });
    latestCampaignView.combat.fighters.find((fighter) => fighter.id === 'hero').hp = 0;
    advanceFrame();
    assert.equal(elements.get('overlay-title').textContent, '挑战失败');
    elements.get('overlay-primary').fire('click');
    assert.equal(advanceFrame(35)[0].dodge, false, 'a held key must not carry through failure and retry');

    // A real KO event keeps the canvas uncovered until the tomato has landed.
    let hero = latestCampaignView.combat.fighters.find((fighter) => fighter.id === 'hero');
    hero.hp = 1;
    hero.y = 620;
    advanceFrame();
    assert.ok(latestCampaignView.events.some((event) => event.type === 'ko'));
    assert.equal(elements.get('screen-overlay').hidden, true);
    assert.ok([...timers.values()].some((entry) => entry.delay === 650));
    fireTimers(180);
    assert.equal(elements.get('screen-overlay').hidden, true);
    fireTimers(650);
    assert.equal(elements.get('overlay-title').textContent, '挑战失败');
    elements.get('overlay-primary').fire('click');

    // Switching modes before the landing must not resurrect an old result panel.
    hero = latestCampaignView.combat.fighters.find((fighter) => fighter.id === 'hero');
    hero.hp = 1;
    hero.y = 620;
    advanceFrame();
    assert.equal(elements.get('screen-overlay').hidden, true);
    elements.get('duel-button').fire('click');
    fireTimers(650);
    assert.equal(elements.get('screen-overlay').hidden, true);

    document.fire('keydown', { code: 'KeyJ', repeat: false });
    elements.get('avatar-open').fire('click');
    assert.equal(elements.get('avatar-dialog').open, true);
    document.fire('keyup', { code: 'KeyJ' }); // Released behind the modal dialog.
    elements.get('avatar-close').fire('click');

    elements.get('create-room').fire('click');
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets.at(-1);
    assert.equal(socket.url, 'ws://127.0.0.1:3001/ws');
    const musicBeforeRoom = musicStarts();
    socket.fire('message', { data: JSON.stringify({ type: 'created', code: '123456', role: 'p1', theme: 'city' }) });
    assert.equal(musicStarts(), musicBeforeRoom, 'waiting for an opponent has no battle score');
    elements.get('room-input').focus();
    socket.fire('message', { data: JSON.stringify({ type: 'start', code: '123456', role: 'p1', theme: 'city' }) });
    assert.equal(globalThis.document.activeElement, elements.get('game-canvas'),
      'joining via Enter moves keyboard focus out of the room-code field before combat');
    assert.ok(musicStarts() > musicBeforeRoom, 'server start begins the duel arrangement');
    assert.equal(elements.get('avatar-open').disabled, true,
      'portrait setup cannot interrupt a live server-authoritative duel');
    const musicStopsBeforeMute = musicStops();
    elements.get('sound-toggle').fire('click');
    assert.equal(elements.get('sound-toggle').attributes.get('aria-pressed'), 'false');
    assert.ok(musicStops() > musicStopsBeforeMute, 'the shared sound switch also mutes music');
    const musicWhileMuted = musicStarts();
    document.fire('pointerdown');
    assert.equal(musicStarts(), musicWhileMuted, 'a gesture cannot restart muted music');
    elements.get('sound-toggle').fire('click');
    assert.equal(elements.get('sound-toggle').attributes.get('aria-pressed'), 'true');
    assert.ok(musicStarts() > musicWhileMuted, 'unmuting an active duel resumes one score');
    assert.equal(socket.sent.at(-1).input.kick, false);
    assert.equal(socket.sent.at(-1).input.attack, false,
      'a duel-lobby key released during portrait setup cannot become a ghost attack');
    assert.equal(socket.sent.at(-1).input.special, false);
    assert.equal(socket.sent.at(-1).input.spear, false);
    assert.equal('equipment' in socket.sent.at(-1).input, false);
    assert.deepEqual(Object.keys(socket.sent.at(-1).input).sort(),
      ['aimCancel', 'aimDown', 'aimUp', 'attack', 'dodge', 'jump', 'kick',
        'left', 'right', 'spear', 'special']);
    assert.doesNotMatch(JSON.stringify(socket.sent), /data:image|avatar|portrait/i,
      'portrait pixels and metadata never travel with room or combat messages');

    document.fire('keydown', { code: 'KeyL', repeat: false });
    assert.equal(socket.sent.at(-1).input.special, true, 'L sends an authorized PvP wave input');
    document.fire('keyup', { code: 'KeyL' });
    assert.equal(socket.sent.at(-1).input.special, false);
    assert.equal(elements.get('special-button').hidden, false, 'both duelists see the wave button');
    assert.equal(elements.get('special-button').disabled, true, 'uncharged wave is unavailable');
    document.fire('keydown', { code: 'KeyI', repeat: false });
    assert.equal(socket.sent.at(-1).input.spear, true, 'I sends an authorized PvP spear edge');
    document.fire('keyup', { code: 'KeyI' });
    assert.equal(socket.sent.at(-1).input.spear, false, 'release separates two I presses');
    document.fire('keydown', { code: 'ArrowUp', repeat: false });
    assert.equal(socket.sent.at(-1).input.aimUp, true, 'an aim key is authorized in PvP');
    document.fire('keyup', { code: 'ArrowUp' });
    assert.equal(socket.sent.at(-1).input.aimUp, false);
    assert.equal(elements.get('spear-button').hidden, false, 'both duelists see the spear button');
    assert.equal(elements.get('spear-guide-remaining').textContent, '5/5');
    assert.equal(elements.get('spear-aim-controls').hidden, true);
    assert.equal(elements.get('equipment-status').hidden, true, 'the backpack is campaign-only');
    assert.equal(elements.get('equipment-button').hidden, true);
    document.fire('keydown', { code: 'KeyE', repeat: false });
    assert.equal('equipment' in socket.sent.at(-1).input, false,
      'equipment attacks never enter the duel protocol');
    document.fire('keyup', { code: 'KeyE' });
    tapKey('KeyB');
    assert.equal(elements.get('backpack-dialog').open, false, 'B cannot open a campaign bag in PvP');

    // Resource/readout truth comes from the local role in the authoritative
    // state. A network-delayed aim may be nudged by a very brief touch or key
    // tap, while double I presses and hitstop remain separate network edges.
    const duelSkills = createDuelState('city');
    duelSkills.fighters[0].spearRemaining = 3;
    duelSkills.fighters[0].spearAiming = true;
    duelSkills.fighters[0].spearAimAngle = 34;
    duelSkills.fighters[0].facing = -1;
    duelSkills.fighters[0].duelWaveCharge = 1;
    duelSkills.fighters[0].duelWaveHits = 2;
    socket.fire('message', { data: JSON.stringify({
      type: 'state', code: '123456', phase: 'playing', state: duelSkills,
    }) });
    assert.equal(elements.get('spear-guide-remaining').textContent, '3/5');
    assert.match(elements.get('spear-status').textContent, /朝左瞄准/);
    assert.equal(elements.get('spear-button').textContent, '发射 ×3');
    assert.equal(elements.get('spear-aim-controls').hidden, false);
    assert.equal(elements.get('special-button').disabled, false);
    assert.match(elements.get('special-status').textContent, /朝左前方 800/);
    assert.equal(elements.get('game-canvas').classList.contains('is-aiming'), true);
    assert.match(elements.get('touch-tip').textContent, /弧线仅预测落点/);
    document.fire('keydown', { code: 'KeyI', repeat: false });
    const lastSpearSeq = socket.sent.at(-1).seq;
    window.fire('blur');
    const [blurCancel, blurRelease] = socket.sent.slice(-2);
    assert.equal(blurCancel.seq, lastSpearSeq + 1);
    assert.equal(blurRelease.seq, blurCancel.seq + 1);
    assert.deepEqual([blurCancel.input.aimCancel, blurRelease.input.aimCancel], [true, false],
      'PvP blur sends a cancellable server edge and releases it for later Esc presses');
    assert.equal(blurCancel.input.spear, false,
      'blur discards a held or queued I rather than confirming the aimed spear');
    assert.equal(blurRelease.input.spear, false);
    window.fire('focus');
    globalThis.document.hidden = true;
    globalThis.document.fire('visibilitychange');
    assert.deepEqual(socket.sent.slice(-2).map(({ input }) => input.aimCancel), [true, false],
      'hiding the duel tab also cancels server-owned aim without a stuck Esc');
    globalThis.document.hidden = false;
    globalThis.document.fire('visibilitychange');
    duelSkills.fighters[0].spearAiming = false;
    duelSkills.fighters[0].stun = 4;
    socket.fire('message', { data: JSON.stringify({
      type: 'state', code: '123456', phase: 'playing', state: duelSkills,
    }) });
    assert.equal(elements.get('special-button').disabled, true,
      'a charged PvP wave cannot be requested while its fighter is stunned');
    assert.match(elements.get('special-status').textContent, /当前动作结束后/);
    duelSkills.fighters[0].stun = 0;
    duelSkills.fighters[0].spearWindup = 8;
    socket.fire('message', { data: JSON.stringify({
      type: 'state', code: '123456', phase: 'playing', state: duelSkills,
    }) });
    assert.equal(elements.get('special-button').disabled, false,
      'an already-charged wave may interrupt an unthrown PvP spear');
    assert.equal(elements.get('spear-button').disabled, true, 'a committed spear cannot be re-aimed');
    duelSkills.fighters[0].spearWindup = 0;
    duelSkills.fighters[0].spearAiming = true;
    socket.fire('message', { data: JSON.stringify({
      type: 'state', code: '123456', phase: 'playing', state: duelSkills,
    }) });
    assert.equal(elements.get('special-button').disabled, false,
      'the charged wave may also cancel the unconfirmed aim');

    document.fire('keydown', { code: 'ArrowUp', repeat: false });
    document.fire('keyup', { code: 'ArrowUp' });
    assert.ok(socket.sent.at(-1).input.aimAngle > 34,
      'a quick up tap sends an absolute angle even if released before a server tick');
    const upButton = elements.get('aim-up-button');
    upButton.fire('pointerdown', { pointerId: 70 });
    upButton.fire('pointerup', { pointerId: 70 });
    assert.ok(socket.sent.at(-1).input.aimAngle > 35,
      'a quick touch tap also survives until the server samples its target angle');
    const duelCanvas = elements.get('game-canvas');
    duelCanvas.fire('pointerdown', { pointerId: 71, clientY: 200 });
    duelCanvas.fire('pointermove', { pointerId: 71, clientY: 150 });
    duelCanvas.fire('pointerup', { pointerId: 71, clientY: 150 });
    const draggedAngle = socket.sent.at(-1).input.aimAngle;
    assert.ok(draggedAngle > 40, 'dragging up requests a higher throw angle');
    assert.equal(duelCanvas.classList.contains('is-aim-dragging'), false);
    assert.match(elements.get('spear-angle').textContent, /仰角 [4-9][0-9]°/);
    duelSkills.fighters[0].spearAimAngle = draggedAngle;
    socket.fire('message', { data: JSON.stringify({
      type: 'state', code: '123456', phase: 'playing', state: duelSkills,
    }) });
    document.fire('keydown', { code: 'KeyD', repeat: false });
    assert.equal('aimAngle' in socket.sent.at(-1).input, false,
      'a server-acknowledged drag stops overriding subsequent keyboard adjustments');
    document.fire('keyup', { code: 'KeyD' });

    duelSkills.hitstop = 3;
    socket.fire('message', { data: JSON.stringify({
      type: 'state', code: '123456', phase: 'playing', state: duelSkills,
    }) });
    document.fire('keydown', { code: 'KeyI', repeat: false });
    document.fire('keyup', { code: 'KeyI' });
    document.fire('keydown', { code: 'KeyI', repeat: false });
    document.fire('keyup', { code: 'KeyI' });
    assert.deepEqual(socket.sent.slice(-4).map(({ input }) => input.spear),
      [true, false, true, false], 'two fast I taps preserve both rising edges during hitstop');
    const spearButton = elements.get('spear-button');
    spearButton.fire('pointerdown', { pointerId: 72 });
    spearButton.fire('pointerup', { pointerId: 72 });
    assert.deepEqual(socket.sent.slice(-2).map(({ input }) => input.spear), [true, false],
      'touch 发射 uses the same explicit I confirmation');
    const specialButton = elements.get('special-button');
    specialButton.fire('pointerdown', { pointerId: 73 });
    specialButton.fire('pointerup', { pointerId: 73 });
    assert.deepEqual(socket.sent.slice(-2).map(({ input }) => input.special), [true, false],
      'touch 光波 sends one down/release pulse');
    const cancelButton = elements.get('aim-cancel-button');
    cancelButton.fire('pointerdown', { pointerId: 74 });
    cancelButton.fire('pointerup', { pointerId: 74 });
    assert.deepEqual(socket.sent.slice(-2).map(({ input }) => input.aimCancel), [true, false]);
    duelSkills.fighters[0].spearAiming = false;
    duelSkills.fighters[0].spearRemaining = 0;
    duelSkills.fighters[0].duelWaveCharge = 0;
    duelSkills.fighters[0].duelWaveHits = 1;
    socket.fire('message', { data: JSON.stringify({
      type: 'state', code: '123456', phase: 'playing', state: duelSkills,
    }) });
    assert.equal(elements.get('spear-aim-controls').hidden, true);
    assert.equal(elements.get('spear-button').disabled, true);
    assert.match(elements.get('spear-status').textContent, /已用尽/);
    assert.equal(elements.get('special-button').disabled, true);
    assert.match(elements.get('special-status').textContent, /充能 1\/3/);

    // A joining client must read P2's own resources, not the P1 HUD column.
    socket.fire('message', { data: JSON.stringify({ type: 'start', code: '123456', role: 'p2', theme: 'city' }) });
    const guestSkills = createDuelState('city');
    guestSkills.fighters[0].spearRemaining = 5;
    guestSkills.fighters[0].duelWaveCharge = 0;
    guestSkills.fighters[1].spearRemaining = 1;
    guestSkills.fighters[1].duelWaveCharge = 1;
    guestSkills.fighters[1].facing = 1;
    socket.fire('message', { data: JSON.stringify({
      type: 'state', code: '123456', phase: 'playing', state: guestSkills,
    }) });
    assert.equal(elements.get('spear-guide-remaining').textContent, '1/5');
    assert.match(elements.get('spear-status').textContent, /朝右/);
    assert.equal(elements.get('special-button').disabled, false);
    assert.match(elements.get('opponent-name').textContent, /你/);
    assert.doesNotMatch(elements.get('player-name').textContent, /你/);
    document.fire('keydown', { code: 'KeyJ', repeat: false });
    document.fire('keydown', { code: 'KeyI', repeat: false });
    socket.fire('message', { data: JSON.stringify({ type: 'countdown', code: '123456', seconds: 3 }) });
    assert.equal(elements.get('spear-button').disabled, true, 'countdown blocks stale skill taps');
    socket.fire('message', { data: JSON.stringify({ type: 'start', code: '123456', role: 'p1', theme: 'city' }) });
    assert.equal(socket.sent.at(-1).input.attack, false, 'round start drops a held pre-countdown punch');
    assert.equal(socket.sent.at(-1).input.spear, false, 'round start drops a held pre-countdown I');
    socket.fire('message', { data: JSON.stringify({
      type: 'state', code: '123456', phase: 'playing', state: createDuelState('city'),
    }) });

    document.fire('keydown', { code: 'KeyK', repeat: false });
    assert.equal(socket.sent.at(-1).input.kick, true);
    document.fire('keyup', { code: 'KeyK' });
    assert.equal(socket.sent.at(-1).input.kick, false);

    document.fire('keydown', { code: 'Space', repeat: false });
    document.fire('keydown', { code: 'KeyK', repeat: false });
    assert.equal(socket.sent.at(-1).input.jump, true);
    assert.equal(socket.sent.at(-1).input.kick, true);
    document.fire('keyup', { code: 'KeyK' });
    document.fire('keyup', { code: 'Space' });

    const kickButton = buttons.find(({ dataset }) => dataset.key === 'kick');
    kickButton.fire('pointerdown', { pointerId: 7 });
    assert.equal(socket.sent.at(-1).input.kick, true);
    assert.equal(kickButton.classList.contains('is-pressed'), true);
    kickButton.fire('pointerup', { pointerId: 7 });
    assert.equal(socket.sent.at(-1).input.kick, false);
    assert.equal(kickButton.classList.contains('is-pressed'), false);

    const resultState = (events = []) => {
      const state = createDuelState('city');
      state.fighters[1].hp = 0;
      state.events = events;
      return state;
    };
    const ko = { id: 'test:duel-ko', type: 'ko', x: 600, y: 370, target: 'p2' };
    const finish = (reason, events) => socket.fire('message', { data: JSON.stringify({
      type: 'finished', code: '123456', reason, winner: 'p1', state: resultState(events),
    }) });
    const musicStopsBeforeFinish = musicStops();
    finish('ko', [ko]);
    assert.equal(elements.get('screen-overlay').hidden, true, 'duel KO should show the canvas first');
    const musicAfterFinish = musicStarts();
    assert.ok(musicStops() > musicStopsBeforeFinish, 'the finished round cuts off its score');
    fireTimers(180);
    assert.equal(elements.get('screen-overlay').hidden, true);
    fireTimers(650);
    assert.equal(elements.get('overlay-title').textContent, '你赢了！');
    assert.equal(musicStarts(), musicAfterFinish, 'the result overlay remains silent');
    assert.equal(elements.get('avatar-open').disabled, false,
      'the local portrait can be changed after a duel finishes');

    socket.fire('message', { data: JSON.stringify({ type: 'start', code: '123456', role: 'p1', theme: 'city' }) });
    assert.ok(musicStarts() > musicAfterFinish, 'a new duel round starts a fresh score');
    finish('timeout', []);
    assert.equal(elements.get('overlay-title').textContent, '你赢了！');
    assert.equal(elements.get('screen-overlay').hidden, false, 'timeouts must show the result immediately');

    socket.fire('message', { data: JSON.stringify({ type: 'start', code: '123456', role: 'p1', theme: 'city' }) });
    finish('ko', []);
    assert.equal(elements.get('screen-overlay').hidden, false,
      'a result packet without a KO event must not invent a delayed tomato');

    socket.fire('message', { data: JSON.stringify({ type: 'start', code: '123456', role: 'p1', theme: 'city' }) });
    globalThis.matchMedia = () => ({ matches: true });
    finish('ko', [{ ...ko, id: 'test:reduced-ko' }]);
    assert.equal(elements.get('screen-overlay').hidden, true);
    assert.ok([...timers.values()].some((entry) => entry.delay === 300), 'reduced motion waits less');
    socket.fire('message', { data: JSON.stringify({ type: 'countdown', code: '123456', seconds: 3 }) });
    fireTimers(300);
    assert.equal(elements.get('overlay-title').textContent, '3', 'the previous KO panel must stay cancelled');

    socket.fire('message', { data: JSON.stringify({ type: 'start', code: '123456', role: 'p1', theme: 'city' }) });
    finish('ko', [{ ...ko, id: 'test:leave-ko' }]);
    elements.get('leave-room').fire('click');
    fireTimers(300);
    assert.equal(elements.get('screen-overlay').hidden, true, 'leaving cancels the queued result');
    assert.equal(elements.get('avatar-open').disabled, false,
      'leaving the room restores local portrait setup in the waiting lobby');

    // A single-enemy room must stay walkable after the real final KO so the
    // player can pass the fallen enemy before the clear panel takes over.
    elements.get('campaign-button').fire('click');
    elements.get('overlay-primary').fire('click'); // retry the earlier failed first room
    advanceFrame(35);
    const finisher = activeCampaign.combat.fighters.find((fighter) => fighter.team === 0);
    const lastEnemy = activeCampaign.combat.fighters.find((fighter) => fighter.team === 1);
    assert.ok(finisher && lastEnemy);
    finisher.x = lastEnemy.x - 37;
    finisher.y = lastEnemy.y;
    finisher.facing = 1;
    finisher.attackStage = 1;
    finisher.attackTick = 4;
    finisher.hitIds = [];
    finisher.stun = 0;
    lastEnemy.hp = 1;
    lastEnemy.stun = 100;
    lastEnemy.invulnerable = 0;
    advanceFrame(35);
    assert.equal(latestCampaignView.phase, 'aftermath');
    assert.equal(elements.get('screen-overlay').hidden, true, 'the victory window remains playable');
    assert.match(elements.get('stage-subtitle').textContent, /走过倒地敌人/);
    assert.equal(elements.get('opponent-name').textContent, '对手已倒下',
      'the HUD must not promise another wave during final-KO aftermath');
    assert.equal(elements.get('spear-button').disabled, true);
    assert.equal(buttons.find((button) => button.dataset.key === 'attack').disabled, true);
    assert.equal(buttons.find((button) => button.dataset.key === 'jump').disabled, false);
    for (let frame = 0; frame < 3; frame++) advanceFrame(100);
    assert.equal(latestCampaignView.phase, 'aftermath', 'the clear panel cannot mask the KO immediately');
    for (let frame = 0; frame < 65 && latestCampaignView.phase === 'aftermath'; frame++) advanceFrame(100);
    assert.equal(latestCampaignView.phase, 'cleared', 'the victory window eventually resolves');
    assert.equal(elements.get('overlay-title').textContent, '关卡突破');

    // Clearing room one unlocks it for replay; the official second-room scene
    // stays in memory and its save remains byte-for-byte untouched throughout
    // a failed practice attempt, retry, and explicit return to the main route.
    elements.get('overlay-primary').fire('click');
    advanceFrame(35);
    assert.equal(activeCampaign.snapshot().level.number, 2);
    const officialScene = activeCampaign.combat;
    const officialTick = officialScene.tick;
    const savedAfterClear = savedItems.get('stickman-arena.campaign.v1');
    const writesAfterClear = storageWrites;
    const deathsAfterClear = activeCampaign.progress.deaths;
    assert.equal(elements.get('map-grid').children[0].classList.contains('is-cleared'), true);
    elements.get('map-grid').children[2].fire('click');
    assert.equal(activeCampaign.snapshot().replaying, false, 'uncleared route nodes still cannot skip the main quest');
    assert.equal(savedItems.get('stickman-arena.campaign.v1'), savedAfterClear);
    tapKey('KeyJ');
    elements.get('map-grid').children[0].fire('click');
    assert.equal(activeCampaign.snapshot().replaying, true);
    assert.equal(activeCampaign.snapshot().level.number, 1);
    assert.equal(elements.get('map-grid').children[0].classList.contains('is-replaying'), true);
    assert.equal(elements.get('replay-exit').hidden, false);
    assert.match(elements.get('stage-label').textContent, /重打|练习/);
    assert.match(elements.get('progress-label').textContent, /02/,
      'the status keeps identifying the saved official progression');
    if (!elements.get('screen-overlay').hidden) elements.get('overlay-primary').fire('click');
    assert.equal(advanceFrame(35)[0].attack, false,
      'an attack buffered in the official scene does not fire inside a replay');
    assert.equal(activeCampaign.snapshot().replaying, true);
    assert.equal(storageWrites, writesAfterClear);
    const practiceTick = activeCampaign.combat.tick;
    elements.get('avatar-open').fire('click');
    advanceFrame(35);
    assert.equal(activeCampaign.combat.tick, practiceTick, 'portrait setup also pauses a live replay');
    elements.get('avatar-close').fire('click');
    assert.equal(elements.get('overlay-title').textContent, '练习已暂停');
    assert.equal(elements.get('overlay-primary').textContent, '继续重打');
    assert.equal(elements.get('overlay-secondary').textContent, '返回主线');
    assert.equal(activeCampaign.snapshot().replaying, true, 'portrait setup does not silently exit practice');
    elements.get('overlay-primary').fire('click');
    advanceFrame(35);
    assert.ok(activeCampaign.combat.tick > practiceTick);

    const replayHero = activeCampaign.combat.fighters.find((fighter) => fighter.team === 0);
    replayHero.hp = 1;
    replayHero.y = 620;
    advanceFrame(35);
    fireTimers(300); // Reduced-motion setting remains enabled from the duel KO test.
    fireTimers(650);
    assert.equal(activeCampaign.snapshot().phase, 'failed');
    assert.match(elements.get('overlay-title').textContent, /重打|练习/);
    assert.match(elements.get('overlay-primary').textContent, /再打|重试/);
    assert.match(elements.get('overlay-secondary').textContent, /返回主线/);
    assert.equal(activeCampaign.progress.deaths, deathsAfterClear);
    assert.equal(savedItems.get('stickman-arena.campaign.v1'), savedAfterClear);
    assert.equal(storageWrites, writesAfterClear);
    elements.get('overlay-primary').fire('click');
    assert.equal(activeCampaign.snapshot().replaying, true);
    assert.equal(activeCampaign.snapshot().phase, 'playing');
    assert.equal(activeCampaign.snapshot().level.number, 1);
    assert.equal(activeCampaign.combat.fighters.find((fighter) => fighter.team === 0).hp, 100);
    assert.equal(savedItems.get('stickman-arena.campaign.v1'), savedAfterClear);
    elements.get('replay-exit').fire('click');
    assert.equal(activeCampaign.snapshot().replaying, false);
    assert.equal(activeCampaign.snapshot().level.number, 2);
    assert.equal(activeCampaign.combat, officialScene, 'returning restores the exact official fight');
    assert.equal(officialScene.tick, officialTick, 'the official fight was paused throughout replay');
    assert.equal(elements.get('screen-overlay').hidden, false, 'returning shows a paused continue screen');
    assert.equal(elements.get('replay-exit').hidden, true);
    assert.equal(savedItems.get('stickman-arena.campaign.v1'), savedAfterClear);
    assert.equal(storageWrites, writesAfterClear);
    advanceFrame(100);
    assert.equal(officialScene.tick, officialTick, 'the official scene does not advance behind its continue screen');
    elements.get('overlay-primary').fire('click');
    advanceFrame(35);
    assert.ok(officialScene.tick > officialTick, 'the official fight advances after the player chooses to continue');

    // Drive the inventory UI with two already-earned catalog IDs. Loot/persistence
    // rules are covered separately by CampaignSession tests; this checks the
    // keyboard/touch presentation and a real equipment input tick.
    const [blade, staff] = BOSS_EQUIPMENT;
    activeCampaign.inventory = [blade.id, staff.id];
    activeCampaign.equippedEquipmentId = blade.id;
    activeCampaign.combat.equippedEquipmentId = blade.id;
    const armedHero = activeCampaign.combat.fighters.find((fighter) => fighter.id === 'hero');
    armedHero.stun = 0;
    armedHero.attackStage = 0;
    armedHero.kickType = null;
    armedHero.spearWindup = 0;
    armedHero.dodgeTicks = 0;
    for (const enemy of activeCampaign.combat.fighters.filter((fighter) => fighter.team === 1)) enemy.stun = 1000;
    advanceFrame(100);
    assert.equal(elements.get('equipment-count').textContent, '2');
    assert.equal(elements.get('equipment-button').hidden, false);
    elements.get('backpack-open').fire('click');
    assert.equal(elements.get('backpack-dialog').open, true);
    assert.equal(elements.get('backpack-list').children.length, 2);
    elements.get('backpack-list').children[1].fire('click');
    assert.equal(activeCampaign.snapshot().equippedEquipmentId, staff.id);
    assert.equal(elements.get('backpack-list').children[1].attributes.get('aria-pressed'), 'true');
    elements.get('backpack-close').fire('click');
    assert.equal(elements.get('backpack-dialog').open, false);
    tapKey('KeyE');
    assert.equal(advanceFrame(35)[0].equipment, true);
    assert.equal(armedHero.equipmentAttackId, staff.id, 'E starts the selected gear move');
    assert.equal(elements.get('equipment-button').disabled, true, 'the gear has a visible cooldown');
  } finally {
    CampaignSession.prototype.step = originalCampaignStep;
    for (const [key, descriptor] of Object.entries(browserGlobals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
