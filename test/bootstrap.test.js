import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CampaignSession } from '../public/campaign.js';
import { createDuelState } from '../shared/combat.js';

class FakeNode {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.width = 960;
    this.height = 540;
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
    const event = { preventDefault() {}, pointerId: 0, ...details };
    for (const callback of this.listeners.get(type) ?? []) callback(event);
    return event;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  setPointerCapture() {}
  querySelector(selector) { return selector === 'span' ? new FakeNode('label') : null; }
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

test('browser controller boots, switches modes, starts a fight and renders a frame', async () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = [...page.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const elements = new Map(ids.map((id) => [id, new FakeNode(id)]));
  elements.get('duel-theme').value = 'city';
  const buttons = ['left', 'right', 'attack', 'kick', 'jump', 'dodge'].map((key) => {
    const node = new FakeNode();
    node.dataset.key = key;
    return node;
  });
  const frames = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const sockets = [];
  const campaignInputs = [];
  const timers = new Map();
  let timerId = 0;
  const fireTimers = (delay) => {
    for (const [id, entry] of [...timers]) {
      if (entry.delay !== delay) continue;
      timers.delete(id);
      entry.callback();
    }
  };
  let latestCampaignView;
  const originalCampaignStep = CampaignSession.prototype.step;
  CampaignSession.prototype.step = function captureCampaignInput(input) {
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
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:3000' };
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); };
  globalThis.WebSocket = FakeWebSocket;
  try {
    await import(`../public/app.js?bootstrap=${Date.now()}`);
    assert.equal(elements.get('map-grid').children.length, 56);
    assert.equal(elements.get('screen-overlay').hidden, false);
    assert.equal(elements.get('duel-panel').hidden, true);
    assert.equal(elements.get('stage-title').textContent, '林缘试招');

    elements.get('duel-button').fire('click');
    assert.equal(elements.get('campaign-panel').hidden, true);
    assert.equal(elements.get('duel-panel').hidden, false);
    assert.equal(elements.get('stage-label').textContent, '实时联机 1V1');

    elements.get('campaign-button').fire('click');
    elements.get('overlay-primary').fire('click');
    assert.equal(elements.get('screen-overlay').hidden, true);
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
    advanceFrame(35);
    assert.match(elements.get('player-health-text').textContent, /100 \/ 100/);

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

    for (const [code, action] of [['Space', 'jump'], ['KeyJ', 'attack'], ['KeyK', 'kick'], ['ShiftLeft', 'dodge']]) {
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
    globalThis.document.fire('visibilitychange');
    assert.equal(advanceFrame()[0].dodge, false, 'hiding the tab must drop queued actions');
    globalThis.document.hidden = false;

    tapKey('KeyK');
    elements.get('duel-button').fire('click');
    elements.get('campaign-button').fire('click');
    document.fire('keydown', { code: 'Space', repeat: false });
    elements.get('overlay-primary').fire('click');
    assert.equal(advanceFrame()[0].kick, false, 'mode switch must clear the old campaign tap');
    assert.equal(campaignInputs.at(-1).jump, false, 'a key pressed while paused must not fire on resume');
    document.fire('keyup', { code: 'Space' });

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

    elements.get('create-room').fire('click');
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets.at(-1);
    assert.equal(socket.url, 'ws://127.0.0.1:3000/ws');
    socket.fire('message', { data: JSON.stringify({ type: 'created', code: '123456', role: 'p1', theme: 'city' }) });
    socket.fire('message', { data: JSON.stringify({ type: 'start', code: '123456', role: 'p1', theme: 'city' }) });
    assert.equal(socket.sent.at(-1).input.kick, false);

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
    finish('ko', [ko]);
    assert.equal(elements.get('screen-overlay').hidden, true, 'duel KO should show the canvas first');
    fireTimers(180);
    assert.equal(elements.get('screen-overlay').hidden, true);
    fireTimers(650);
    assert.equal(elements.get('overlay-title').textContent, '你赢了！');

    socket.fire('message', { data: JSON.stringify({ type: 'start', code: '123456', role: 'p1', theme: 'city' }) });
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
  } finally {
    CampaignSession.prototype.step = originalCampaignStep;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
