import test from 'node:test';
import assert from 'node:assert/strict';
import { attackOf, createCombatState, createFighter, spearAimedFlight, spearFlight,
  spearOrigin, spearTrajectoryPoint, stepCombat } from '../shared/combat.js';
import { BOSS_EQUIPMENT, equipmentForBoss } from '../shared/equipment.js';
import { platformPose } from '../shared/platforms.js';
import { createRenderer } from '../public/render.js';

const ATTACK_WINDOWS = [
  { kind: 'hero', stage: 1, from: 5, to: 9 },
  { kind: 'hero', stage: 2, from: 6, to: 11 },
  { kind: 'hero', stage: 3, from: 8, to: 14 },
  { kind: 'boss', stage: 1, from: 13, to: 17 },
  { kind: 'boss', stage: 2, from: 14, to: 19 },
  { kind: 'boss', stage: 3, from: 16, to: 22 },
];

const SHADOW_WANDERER = {
  head: '#08151b',
  limbCore: '#35454b',
  hatOutline: '#081219',
  hatCrown: '#1c2932',
  hatRim: '#4db2bd',
  hatWeave: '#567e8d',
  p1: { capeEdge: '#632029', cape: '#c73642', scarf: '#b62236',
    eye: '#fff9f2', eyeAccent: '#ff555a' },
  p2: { capeEdge: '#14394b', cape: '#23758b', scarf: '#287f98',
    eye: '#e9feff', eyeAccent: '#7be8f1' },
};

function recordingCanvas({ failImages = false } = {}) {
  const fills = [];
  const strokes = [];
  const rects = [];
  const images = [];
  const rotations = [];
  const labels = [];
  const stack = [];
  let drawOrder = 0;
  let drawing = {
    scaleX: 1, offsetX: 0, offsetY: 0,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
  };
  let path = [];
  const gradient = () => ({ addColorStop() {} });
  const context = new Proxy({
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    save() { stack.push({ ...drawing }); },
    restore() { drawing = stack.pop() ?? drawing; },
    setTransform(x) { drawing.scaleX = x; drawing.offsetX = 0; drawing.offsetY = 0; },
    scale(x) { drawing.scaleX *= x; },
    translate(x, y) { drawing.offsetX += x * drawing.scaleX; drawing.offsetY += y; },
    rotate(angle) { rotations.push({ angle, originX: drawing.offsetX, originY: drawing.offsetY }); },
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, color: drawing.fillStyle,
        originX: drawing.offsetX, originY: drawing.offsetY, scaleX: drawing.scaleX });
    },
    drawImage(image, ...args) {
      if (failImages) throw new Error('image is no longer drawable');
      images.push({ image, args, originX: drawing.offsetX, originY: drawing.offsetY,
        scaleX: drawing.scaleX, clip: drawing.clip, order: drawOrder++ });
    },
    fillText(value, x, y) { labels.push({ value, x, y, originX: drawing.offsetX }); },
    beginPath() { path = []; },
    clip() { drawing.clip = [...path]; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    bezierCurveTo(cx1, cy1, cx2, cy2, x, y) {
      path.push({ kind: 'bezier', cx1, cy1, cx2, cy2, x, y });
    },
    arc(x, y, radius) { path.push({ kind: 'arc', x, y, radius }); },
    ellipse(x, y, rx, ry) { path.push({ kind: 'ellipse', x, y, rx, ry }); },
    fill() {
      fills.push({ color: drawing.fillStyle, scaleX: drawing.scaleX,
        originX: drawing.offsetX, originY: drawing.offsetY,
        points: [...path], alpha: drawing.globalAlpha, order: drawOrder++ });
    },
    stroke() { strokes.push({ color: drawing.strokeStyle, width: drawing.lineWidth,
      scaleX: drawing.scaleX, originX: drawing.offsetX, originY: drawing.offsetY,
      points: [...path], order: drawOrder++ }); },
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key in drawing) return drawing[key];
      return () => {};
    },
    set(_target, key, value) { drawing[key] = value; return true; },
  });
  const canvas = { width: 960, height: 540, getContext: () => context };
  return { canvas, fills, strokes, rects, images, rotations, labels };
}

function recordingRenderer(reducedMotion = false, options = {}) {
  const recording = recordingCanvas(options);
  const previousMatchMedia = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => ({ matches: reducedMotion });
    return { ...recording, renderer: createRenderer(recording.canvas) };
  } finally {
    if (previousMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = previousMatchMedia;
  }
}

function withClock(run) {
  const originalPerformance = globalThis.performance;
  let time = 1000;
  globalThis.performance = { now: () => time };
  try { run((milliseconds) => { time += milliseconds; }); }
  finally { globalThis.performance = originalPerformance; }
}

function renderFrame(renderer, fighters = [], tick = 40) {
  // Pose effects come from the authoritative snapshot; a target is optional.
  renderer.render({
    tick,
    arena: { theme: 'land', groundY: 430, platforms: [], hazards: [] },
    fighters,
  });
}

function renderFighters(fighters, { reducedMotion = false } = {}) {
  const recording = recordingRenderer(reducedMotion);
  renderFrame(recording.renderer, fighters);
  return recording;
}

function fighter(kind, stage, attackTick, facing = 1) {
  return { kind, attackStage: stage, attackTick, facing, x: 400, y: 430, hp: 100, grounded: true };
}

function kicker(type, kickTick, facing = 1, kind = 'hero') {
  return { ...fighter(kind, 0, 0, facing), kickType: type, kickTick,
    y: type === 'air' ? 350 : 430, grounded: type !== 'air' };
}

function mouth(strokes, outline) {
  return strokes.find(({ color, width, points }) => color === outline && width === 2.8
    && points[1]?.kind === 'bezier');
}

function mouthCurve(stroke) {
  assert.ok(stroke, 'a result or punch expression has a readable mouth');
  return stroke.points[1].cy1 - stroke.points[0][1];
}

function assertPortraitHasNoPaintedExpression(recording, portraitPaint, palette) {
  const scarf = recording.fills.find(({ color, order }) =>
    color === palette.scarf && order > portraitPaint.order);
  assert.ok(scarf, 'the scarf still layers over the portrait');
  const facialColors = new Set([palette.eye, palette.eyeAccent, palette.scarfLight,
    SHADOW_WANDERER.head, '#fff6e5', '#8dbec1']);
  const facialMarks = [...recording.fills, ...recording.strokes].filter(({ color, order }) =>
    order > portraitPaint.order && order < scarf.order && facialColors.has(color));
  assert.deepEqual(facialMarks, [], 'eyes, brows, mouth, teeth and tear must not cover the photo');
  return scarf;
}

function renderResult(fighters, meta = {}, state = {}) {
  const recording = recordingRenderer();
  recording.renderer.render({ tick: 40,
    arena: { theme: 'land', groundY: 430, platforms: [], hazards: [] },
    fighters, ...state }, meta);
  return recording;
}

test('a decided duel smiles for the victor and frowns with KO eyes for the loser', () => {
  const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0 };
  const opponent = { ...fighter('grunt', 0, 0, -1), id: 'opponent', x: 600, hp: 0, team: 1 };
  const { fills, strokes } = renderResult([hero, opponent], { mode: 'duel' },
    { status: 'finished', winner: 'hero' });
  assert.ok(mouthCurve(mouth(strokes, SHADOW_WANDERER.p1.eye)) > 0,
    'the shadow-faced victor keeps a readable bright smile');
  assert.ok(mouthCurve(mouth(strokes, '#663f41')) < 0, 'loser gets a downturned mouth');
  assert.ok(fills.filter(({ color }) => color === SHADOW_WANDERER.p1.eye).length >= 2,
    'the winner retains both luminous eyes below the hat');
  assert.equal(strokes.filter(({ color, width, points }) => color === '#663f41'
    && width === 2.2 && points.length === 2).length, 4,
  'the fallen fighter retains both crossed-out eyes');
  assert.ok(fills.some(({ color }) => color === '#8dbec1'), 'the loss has a single tear');
});

test('campaign results affect the hero while a living opponent keeps a neutral face', () => {
  const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0 };
  const enemy = { ...fighter('grunt', 0, 0), id: 'enemy', team: 1, x: 600 };
  for (const phase of ['cleared', 'completed']) {
    const { strokes } = renderResult([hero, enemy], { mode: 'campaign', campaignPhase: phase });
    assert.ok(mouthCurve(mouth(strokes, SHADOW_WANDERER.p1.eye)) > 0,
      `${phase} makes the hero happy despite the shaded face`);
    assert.equal(mouth(strokes, '#663f41'), undefined, 'a surviving enemy does not celebrate');
  }
  const failed = renderResult([hero, enemy], { mode: 'campaign', campaignPhase: 'failed' });
  assert.ok(mouthCurve(mouth(failed.strokes, SHADOW_WANDERER.p1.eye)) < 0,
    'retry screen makes the hero sad');
  assert.equal(mouth(failed.strokes, '#663f41'), undefined);
  assert.ok(failed.fills.some(({ color }) => color === '#8dbec1'), 'failure has a visible tear');
});

test('all combo punch stages show effort; KO overrides victory and effort', () => {
  for (const stage of [1, 2, 3]) {
    const combatant = { ...fighter('hero', stage, 3), id: 'hero', team: 0 };
    const { fills, strokes } = renderResult([combatant], { mode: 'campaign', campaignPhase: 'playing' });
    assert.equal(mouthCurve(mouth(strokes, SHADOW_WANDERER.p1.eye)), 0,
      `combo ${stage} clenches a flat effort mouth throughout the attack`);
    assert.ok(fills.some(({ color }) => color === '#fff6e5'), 'clenched teeth sharpen the punch effort');
  }
  const resting = renderResult([{ ...fighter('hero', 0, 0), id: 'hero', team: 0 }],
    { mode: 'campaign', campaignPhase: 'playing' });
  assert.equal(mouth(resting.strokes, SHADOW_WANDERER.p1.eye), undefined,
    'resting restores the neutral face');
  assert.ok(!resting.fills.some(({ color }) => color === '#fff6e5'));

  const knockedOut = { ...fighter('hero', 3, 9), id: 'hero', team: 0, hp: 0 };
  const { fills, strokes } = renderResult([knockedOut],
    { mode: 'campaign', campaignPhase: 'cleared' });
  assert.ok(mouthCurve(mouth(strokes, SHADOW_WANDERER.p1.eye)) < 0,
    'KO is sad even during a victory overlay');
  assert.equal(strokes.filter(({ color, width, points }) =>
    color === SHADOW_WANDERER.p1.eye && width === 2.2 && points.length === 2).length, 2,
  'two pale KO eye slashes remain readable against the dark face');
  assert.equal(strokes.filter(({ color, width, points }) =>
    color === SHADOW_WANDERER.p1.eyeAccent && width === 2.2 && points.length === 2).length, 2,
  'the crossed eyes retain the warm shadow-glow accents');
  assert.ok(!fills.some(({ color }) => color === '#fff6e5'), 'KO never shows an effort grimace');
});

test('the cool-coloured second player celebrates without borrowing P1 red highlights', () => {
  const red = { ...fighter('hero', 0, 0), id: 'p1', team: 0, x: 330, hp: 0 };
  const blue = { ...fighter('hero', 0, 0, -1), id: 'p2', team: 1, x: 630 };
  const { fills, strokes } = renderResult([red, blue], { mode: 'duel' },
    { status: 'finished', winner: 'p2' });
  assert.ok(mouthCurve(mouth(strokes, SHADOW_WANDERER.p2.eye)) > 0,
    'P2 shows a blue-white smile when victorious');
  assert.ok(mouthCurve(mouth(strokes, SHADOW_WANDERER.p1.eye)) < 0,
    'the defeated P1 still looks sad');
  assert.ok(fills.some(({ color, scaleX }) => color === SHADOW_WANDERER.p2.eye
    && scaleX === -1), 'the winner has mirrored luminous eyes');
});

test('boss and reduced-motion settings preserve readable facial expressions', () => {
  const boss = { ...fighter('boss', 2, 15, -1), id: 'boss', x: 650 };
  const normal = renderFighters([boss]);
  const reduced = renderFighters([boss], { reducedMotion: true });
  for (const { strokes } of [normal, reduced]) {
    const expression = mouth(strokes, '#482d34');
    assert.equal(mouthCurve(expression), 0);
    assert.equal(expression.scaleX, -1.28, 'the enlarged boss expression mirrors with the head');
  }
});

test('a loaded local avatar replaces the painted face under the scarf and hat', () => {
  for (const reducedMotion of [false, true]) {
    const recording = recordingRenderer(reducedMotion);
    const portrait = { complete: true, naturalWidth: 640, naturalHeight: 960 };
    recording.renderer.setAvatar(portrait);
    const hero = { ...fighter('hero', 2, 8, -1), id: 'hero', team: 0,
      x: 330, hurtFlash: 2 };
    recording.renderer.render({ tick: 40,
      arena: { theme: 'land', groundY: 430, platforms: [], hazards: [] },
      fighters: [hero] }, { mode: 'campaign', theme: 'land', level: 3,
      localFighterId: 'hero' });

    assert.equal(recording.images.length, 1, 'one local portrait is drawn once per frame');
    const image = recording.images[0];
    assert.equal(image.image, portrait);
    assert.equal(image.scaleX, -1, 'a flipped fighter carries the portrait with the head');
    assert.deepEqual(image.args.slice(0, 4), [0, 112, 640, 640],
      'portrait is square-cropped without stretching');
    const circle = image.clip?.find(({ kind }) => kind === 'arc');
    assert.equal(circle?.radius, 18, 'the photo uses a real circular Canvas clip');
    assert.deepEqual(image.args.slice(4), [circle.x - 18, circle.y - 18, 36, 36],
      'the clipped portrait tracks the animated head exactly');
    const head = heroHead(recording.fills);
    const hat = recording.fills.find(({ color }) => color === SHADOW_WANDERER.hatOutline);
    const scarf = assertPortraitHasNoPaintedExpression(recording, image, SHADOW_WANDERER.p1);
    assert.ok(head.order < image.order && image.order < scarf.order && scarf.order < hat.order,
      'the head outline remains beneath the photo while clothing stays on top');
    assert.ok(recording.fills.some(({ color }) => color === SHADOW_WANDERER.p1.capeEdge),
      'the dynamic red cloak is unchanged even under reduced motion');

    recording.images.length = 0;
    recording.strokes.length = 0;
    recording.renderer.setAvatar(null);
    recording.renderer.render({ tick: 41,
      arena: { theme: 'land', groundY: 430, platforms: [], hazards: [] },
      fighters: [hero] }, { mode: 'campaign', theme: 'land', level: 3,
      localFighterId: 'hero' });
    assert.equal(recording.images.length, 0, 'clearing the in-memory image restores drawn-only heads');
    assert.equal(mouthCurve(mouth(recording.strokes, SHADOW_WANDERER.p1.eye)), 0,
      'existing effort expression remains exactly available without a photo');

    recording.renderer.setAvatar({ complete: false, naturalWidth: 640, naturalHeight: 960 });
    recording.strokes.length = 0;
    recording.renderer.render({ tick: 42,
      arena: { theme: 'land', groundY: 430, platforms: [], hazards: [] },
      fighters: [hero] }, { mode: 'campaign', theme: 'land', level: 3,
      localFighterId: 'hero' });
    assert.equal(recording.images.length, 0, 'an undecoded image also falls back safely');
    assert.equal(mouthCurve(mouth(recording.strokes, SHADOW_WANDERER.p1.eye)), 0,
      'a failed decode retains the default facial expression');
  }
});

test('a local portrait suppresses neutral, effort, victory, failure and KO facial marks', () => {
  const portrait = { complete: true, naturalWidth: 192, naturalHeight: 192 };
  const arena = { theme: 'land', groundY: 430, platforms: [], hazards: [] };
  for (const [name, phase, attackStage, hp] of [
    ['neutral', 'playing', 0, 100],
    ['effort', 'playing', 2, 100],
    ['victory', 'cleared', 0, 100],
    ['failure', 'failed', 0, 100],
    ['KO', 'failed', 0, 0],
  ]) {
    const recording = recordingRenderer();
    recording.renderer.setAvatar(portrait);
    const hero = { ...fighter('hero', attackStage, 8), id: 'hero', team: 0, hp };
    recording.renderer.render({ tick: 40, arena, fighters: [hero] },
      { mode: 'campaign', theme: 'land', level: 3,
        campaignPhase: phase, localFighterId: 'hero' });
    assert.equal(recording.images.length, 1, `${name} still displays the portrait`);
    assertPortraitHasNoPaintedExpression(recording, recording.images[0], SHADOW_WANDERER.p1);
  }
});

test('a portrait belongs only to the hero; an attacking enemy keeps its expression', () => {
  const recording = recordingRenderer();
  recording.renderer.setAvatar({ complete: true, width: 192, height: 192 });
  const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 330 };
  const enemy = { ...fighter('grunt', 2, 15, -1), id: 'enemy', team: 1, x: 630 };
  recording.renderer.render({ tick: 40,
    arena: { theme: 'land', groundY: 430, platforms: [], hazards: [] },
    fighters: [hero, enemy] },
  { mode: 'campaign', theme: 'land', level: 3, localFighterId: 'hero' });
  assert.equal(recording.images.length, 1);
  assertPortraitHasNoPaintedExpression(recording, recording.images[0], SHADOW_WANDERER.p1);
  assert.equal(mouthCurve(mouth(recording.strokes, '#663f41')), 0,
    'the enemy effort expression is unaffected by the hero portrait');
});

test('an image that becomes undrawable restores the default expression', () => {
  const recording = recordingRenderer(false, { failImages: true });
  recording.renderer.setAvatar({ complete: true, naturalWidth: 192, naturalHeight: 192 });
  const hero = { ...fighter('hero', 2, 8), id: 'hero', team: 0 };
  recording.renderer.render({ tick: 40,
    arena: { theme: 'land', groundY: 430, platforms: [], hazards: [] },
    fighters: [hero] },
  { mode: 'campaign', theme: 'land', level: 3, localFighterId: 'hero' });
  assert.equal(recording.images.length, 0);
  assert.equal(mouthCurve(mouth(recording.strokes, SHADOW_WANDERER.p1.eye)), 0,
    'drawImage failure cannot leave a blank head');
});

test('only the fighter selected by this local client receives its avatar in a duel', () => {
  const recording = recordingRenderer();
  const portrait = { complete: true, width: 400, height: 400 };
  const hostilePortrait = { complete: true, width: 200, height: 200 };
  recording.renderer.setAvatar(portrait);
  const fighters = [
    { ...fighter('hero', 0, 0), id: 'p1', team: 0, x: 330,
      avatar: hostilePortrait },
    { ...fighter('hero', 0, 0, -1), id: 'p2', team: 1, x: 630 },
  ];
  const state = (tick) => ({ tick,
    arena: { theme: 'city', groundY: 430, platforms: [], hazards: [] },
    fighters });
  const eyeCount = (palette, originX) => recording.fills.filter(({ color, originX: x }) =>
    color === palette.eye && x === originX).length;
  recording.renderer.render(state(40), { mode: 'duel', theme: 'city', localFighterId: 'p2' });
  assert.equal(recording.images.length, 1);
  assert.equal(recording.images[0].image, portrait);
  assert.equal(recording.images[0].originX, 630);
  assert.equal(recording.images[0].scaleX, -1);
  assertPortraitHasNoPaintedExpression(recording, recording.images[0], SHADOW_WANDERER.p2);
  assert.equal(eyeCount(SHADOW_WANDERER.p2, 630), 0, 'our P2 portrait has no painted eyes');
  assert.ok(eyeCount(SHADOW_WANDERER.p1, 330) >= 2,
    'the remote P1 retains its default expression');
  recording.images.length = 0;
  recording.fills.length = 0;
  recording.strokes.length = 0;
  recording.renderer.render(state(41), { mode: 'duel', theme: 'city', localFighterId: null });
  assert.equal(recording.images.length, 0, 'waiting/unassigned clients show no local photo');
  assert.ok(eyeCount(SHADOW_WANDERER.p1, 330) >= 2
    && eyeCount(SHADOW_WANDERER.p2, 630) >= 2,
  'without a local fighter assignment, both players keep default faces');
  recording.fills.length = 0;
  recording.strokes.length = 0;
  recording.renderer.render(state(42), { mode: 'duel', theme: 'city', localFighterId: 'p1' });
  assert.equal(recording.images.length, 1);
  assert.equal(recording.images[0].originX, 330, 'local identity, not team or slot, chooses the head');
  assert.equal(recording.images[0].image, portrait,
    'an avatar attached to an incoming fighter snapshot is never trusted');
  assertPortraitHasNoPaintedExpression(recording, recording.images[0], SHADOW_WANDERER.p1);
  assert.equal(eyeCount(SHADOW_WANDERER.p1, 330), 0, 'our P1 portrait has no painted eyes');
  assert.ok(eyeCount(SHADOW_WANDERER.p2, 630) >= 2,
    'the remote P2 retains its default expression');
  recording.images.length = 0;
  recording.fills.length = 0;
  recording.strokes.length = 0;
  recording.renderer.setAvatar(null);
  recording.renderer.render(state(43), { mode: 'duel', theme: 'city', localFighterId: 'p2' });
  assert.equal(recording.images.length, 0, 'local deletion removes photos from both duel heads');
  assert.ok(eyeCount(SHADOW_WANDERER.p1, 330) >= 2
    && eyeCount(SHADOW_WANDERER.p2, 630) >= 2,
  'clearing the photo restores both default faces');
});

test('the own KO echo keeps its avatar and tomato, then sceneToken clears old echoes', () => {
  withClock((advance) => {
    const recording = recordingRenderer(true);
    const portrait = { complete: true, naturalWidth: 512, naturalHeight: 512 };
    recording.renderer.setAvatar(portrait);
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0 };
    const arena = { theme: 'land', groundY: 430, platforms: [], hazards: [] };
    const meta = { mode: 'campaign', theme: 'land', level: 3,
      localFighterId: 'hero', sceneToken: 1 };
    recording.renderer.render({ tick: 40, arena, fighters: [hero] }, meta);
    recording.renderer.effect({ id: 'avatar-ko', type: 'ko', target: 'hero',
      x: hero.x, y: hero.y - 40 });
    advance(420);
    recording.images.length = 0;
    recording.fills.length = 0;
    recording.strokes.length = 0;
    recording.renderer.render({ tick: 40, arena, fighters: [] }, meta);
    assert.equal(recording.images.length, 1, 'our KO ghost still wears the chosen face');
    const portraitPaint = recording.images[0];
    const scarf = assertPortraitHasNoPaintedExpression(recording, portraitPaint,
      SHADOW_WANDERER.p1);
    const hat = recording.fills.find(({ color }) => color === SHADOW_WANDERER.hatOutline);
    const stain = recording.fills.find(({ color }) => color === '#702d2a');
    assert.ok(hat && stain && portraitPaint.order < scarf.order
      && scarf.order < hat.order && hat.order < stain.order,
    'the rotten tomato remains on top of the fallen portrait, scarf and hat');

    recording.images.length = 0;
    recording.fills.length = 0;
    recording.renderer.render({ tick: 40, arena, fighters: [] },
      { ...meta, sceneToken: 2 });
    assert.equal(recording.images.length, 0, 'a new run clears the previous avatar KO ghost');
    assert.ok(!recording.fills.some(({ color }) => color === '#702d2a'),
      'same level and tick still reset its stale tomato when the scene epoch advances');
    recording.renderer.render({ tick: 41, arena, fighters: [hero] },
      { ...meta, sceneToken: 2 });
    assert.equal(recording.images.length, 1, 'clearing the scene does not erase the local selection');
  });
});

function scrollingState(playerX, extras = {}) {
  return { tick: 40,
    arena: { theme: 'land', width: 1920, groundY: 430, platforms: [], hazards: [] },
    fighters: [{ ...fighter('hero', 0, 0), id: 'hero', team: 0,
      x: playerX, height: 88, width: 29 }], ...extras };
}

function corpseRecord(id = 'enemy', extras = {}) {
  return { id, kind: 'grunt', team: 1, facing: 1, width: 29, height: 88,
    x: 620, y: 430, koX: 620, koY: 430,
    bornTick: 40, settleTick: 67, expireTick: 247, ...extras };
}

function heroHead(fills) {
  return fills.find(({ color, points }) => color === SHADOW_WANDERER.head
    && points.some((point) => point.kind === 'arc' && point.radius === 22));
}

function capeShape(fills, color = SHADOW_WANDERER.p1.capeEdge) {
  const cape = fills.find((fill) => fill.color === color);
  assert.ok(cape, 'the wanderer has an outlined cape');
  assert.equal(cape.points[1]?.kind, 'bezier');
  return {
    cape,
    tailX: cape.points[1].x - cape.points[0][0],
    tailY: cape.points[1].y - cape.points[0][1],
  };
}

test('only human heroes wear the ragged dark conical hat, red scarf and trailing cloak', () => {
  const kinds = ['grunt', 'runner', 'guard', 'brute', 'boss'];
  const campaign = renderResult([
    { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 140 },
    ...kinds.map((kind, index) => ({ ...fighter(kind, 0, 0), id: kind,
      team: 1, x: 290 + index * 120 })),
  ], { mode: 'campaign' });
  assert.equal(campaign.fills.filter(({ color }) => color === SHADOW_WANDERER.p1.capeEdge).length, 1);
  assert.equal(campaign.fills.filter(({ color }) => color === SHADOW_WANDERER.p1.cape).length, 1);
  assert.ok(campaign.fills.some(({ color }) => color === SHADOW_WANDERER.p1.scarf),
    'a scarlet scarf distinguishes the reference-inspired shadow wanderer');
  const hatOutline = campaign.fills.find(({ color }) => color === SHADOW_WANDERER.hatOutline);
  const crown = campaign.fills.find(({ color }) => color === SHADOW_WANDERER.hatCrown);
  assert.ok(hatOutline && crown, 'one dark hat is exclusive to the human hero');
  assert.equal(campaign.fills.filter(({ color }) => color === SHADOW_WANDERER.hatOutline).length, 1,
    'the dark conical hat never appears on ordinary enemies or the Boss');
  assert.ok(hatOutline.points.filter(Array.isArray).length >= 8,
    'uneven notches keep the brim from reading as the old smooth straw disk');
  const head = heroHead(campaign.fills).points.find((point) => point.kind === 'arc');
  assert.ok(hatOutline.points.filter(Array.isArray).every(([, y]) => y < head.y - 7),
    'the wide dark brim remains above the eyes and emotional mouth');
  assert.ok(campaign.strokes.some(({ color }) => color === SHADOW_WANDERER.hatWeave),
    'restrained cool-toned hat texture remains readable');
  assert.ok(campaign.strokes.some(({ color }) => color === SHADOW_WANDERER.hatRim),
    'the hat separates from the dark silhouette with a cool rim light');
  assert.ok(campaign.strokes.some(({ color, width }) =>
    color === SHADOW_WANDERER.hatRim && width === 1.05),
  'a hairline cool accent also makes the slender torso distinct from dark backdrops');
  assert.ok(!campaign.fills.some(({ color }) => color === '#e2c487' || color === '#d8b47d'),
    'the old pale straw hat does not return');
  assert.ok(campaign.fills.some(({ color }) => color === '#663f41')
    && campaign.fills.some(({ color }) => color === '#482d34'),
  'ordinary enemies and the Boss keep their former head palettes');
  const duel = renderResult([
    { ...fighter('hero', 0, 0, 1), id: 'p1', team: 0, x: 330 },
    { ...fighter('hero', 0, 0, -1), id: 'p2', team: 1, x: 630 },
  ], { mode: 'duel' });
  assert.equal(duel.fills.filter(({ color }) => color === SHADOW_WANDERER.hatOutline).length, 2);
  assert.ok(duel.fills.some(({ color }) => color === SHADOW_WANDERER.p1.scarf),
    'P1 remains scarlet');
  assert.ok(duel.fills.some(({ color }) => color === SHADOW_WANDERER.p2.scarf),
    'P2 uses a cool cyan scarf rather than merging with P1');
  for (const palette of [SHADOW_WANDERER.p1, SHADOW_WANDERER.p2]) {
    assert.ok(duel.fills.filter(({ color }) => color === palette.eye).length >= 2,
      'both teams retain a pair of bright eyes');
    assert.ok(duel.fills.some(({ color }) => color === palette.eyeAccent),
      'each eye keeps a team-coloured glow against the dark face');
  }
  assert.equal(capeShape(duel.fills).cape.scaleX, 1);
  assert.equal(capeShape(duel.fills, SHADOW_WANDERER.p2.capeEdge).cape.scaleX, -1,
    'the P2 cloak mirrors the player while keeping a distinct blue palette');
  assert.equal(duel.fills.filter(({ color }) => color === SHADOW_WANDERER.p2.cape).length, 1,
    'P2 receives its own cool inner cloak panel');
  assert.deepEqual(duel.fills.filter(({ color }) => color === SHADOW_WANDERER.hatOutline)
    .map(({ scaleX }) => scaleX), [1, -1], 'the irregular hat also mirrors with each facing');
});

test('cape trails actual travel, lifts on ascent, and settles without flutter under reduced motion', () => {
  const base = { ...fighter('hero', 0, 0), id: 'hero', team: 0, vx: 0, vy: 0 };
  const idle = capeShape(renderFighters([base]).fills);
  const forward = capeShape(renderFighters([{ ...base, vx: 5 }]).fills);
  const backward = capeShape(renderFighters([{ ...base, vx: -5 }]).fills);
  const mirrored = capeShape(renderFighters([{ ...base, facing: -1, vx: -5 }]).fills);
  const ascending = capeShape(renderFighters([{
    ...base, vx: 5, vy: -8, y: 350, grounded: false,
  }]).fills);
  const descending = capeShape(renderFighters([{
    ...base, vx: 5, vy: 8, y: 350, grounded: false,
  }]).fills);
  assert.ok(forward.tailX < idle.tailX - 8, 'forward momentum pulls the hem behind');
  assert.ok(backward.tailX > idle.tailX + 8, 'backward travel reverses the tail');
  assert.ok(Math.abs(mirrored.tailX - forward.tailX) < .01,
    'equal forward speed uses the same local cape geometry for either facing');
  assert.equal(mirrored.cape.scaleX, -1, 'the whole costume mirrors with facing');
  assert.ok(ascending.tailY < forward.tailY - 4, 'jumping lifts the hem without detaching it');
  assert.ok(ascending.tailY < descending.tailY - 4,
    'the cloak hangs back down while the fighter descends');
  const stillCalm = capeShape(renderFighters([base], { reducedMotion: true }).fills);
  const movingCalm = capeShape(renderFighters([{
    ...base, vx: 5, vy: -8, y: 350, grounded: false,
  }], { reducedMotion: true }).fills);
  assert.equal(movingCalm.tailX, stillCalm.tailX,
    'reduced motion does not sweep the cape with travel speed');
  assert.equal(movingCalm.tailY, stillCalm.tailY,
    'reduced motion does not add an airborne flutter or lift');
  const atTick = (fighterAtTick, tick, reducedMotion) => {
    const recording = recordingRenderer(reducedMotion);
    renderFrame(recording.renderer, [fighterAtTick], tick);
    return capeShape(recording.fills);
  };
  assert.notEqual(atTick({ ...base, vx: 5 }, 46, false).tailX, forward.tailX,
    'moving cloth subtly changes shape across authoritative simulation ticks');
  const laterCalm = atTick({ ...base, vx: 5 }, 46, true);
  assert.deepEqual([laterCalm.tailX, laterCalm.tailY],
    [stillCalm.tailX, stillCalm.tailY],
    'reduced-motion cloth stays static relative to the shoulders across ticks');
});

test('KO tips the dark hat and red cloak while the tomato lands over the scarf and crown', () => {
  withClock((advance) => {
    const recording = recordingRenderer();
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0 };
    renderFrame(recording.renderer, [hero], 39);
    recording.renderer.effect({ id: '40:wanderer-ko', type: 'ko', target: 'hero',
      x: hero.x, y: hero.y - 40 });
    advance(600);
    const before = recording.fills.length;
    renderFrame(recording.renderer, [{ ...hero, hp: 0 }], 40);
    const frame = recording.fills.slice(before);
    const cape = capeShape(frame).cape;
    const head = heroHead(frame);
    const hat = frame.find(({ color }) => color === SHADOW_WANDERER.hatCrown);
    const scarf = frame.find(({ color }) => color === SHADOW_WANDERER.p1.scarf);
    const stain = frame.find(({ color }) => color === '#b14938');
    assert.ok(head && hat && scarf && stain,
      'KO retains the large shadow head, costume and visible splat');
    assert.ok(cape.order < head.order && head.order < hat.order && hat.order < stain.order,
      'cloth stays behind the stick figure and the splat paints over the hat');
    assert.ok(scarf.order < stain.order, 'the impact remains visible above the red scarf');
    assert.ok(recording.rotations.some(({ angle, originX }) =>
      Math.abs(angle + Math.PI * .46) < .001 && originX === hero.x),
    'the existing KO body transform rotates hat and cape together');
  });
});

test('campaign camera follows within 1920px, keeps the hero visible, and leaves HUD fixed', () => {
  withClock((advance) => {
    const { renderer, fills, labels } = recordingRenderer();
    const meta = { mode: 'campaign', theme: 'land', level: 43 };
    renderer.render(scrollingState(90), meta);
    assert.equal(heroHead(fills)?.originX, 90, 'left origin shows the first world segment');
    fills.length = 0;
    advance(16);
    renderer.render(scrollingState(1200, { tick: 41 }), meta);
    const firstFollow = heroHead(fills)?.originX;
    assert.ok(firstFollow > 480 && firstFollow <= 800,
      'the camera eases after a large move but does not let the player leave the frame');
    for (let tick = 42; tick < 72; tick++) {
      advance(16);
      fills.length = 0;
      renderer.render(scrollingState(1200, { tick }), meta);
    }
    assert.ok(Math.abs(heroHead(fills).originX - 480) < 4, 'the player settles near viewport centre');
    assert.equal(labels.at(-1)?.originX, 0, 'scene label is screen-anchored, not in world space');

    const reduced = recordingRenderer(true);
    reduced.renderer.render(scrollingState(1200), meta);
    assert.equal(heroHead(reduced.fills)?.originX, 480,
      'reduced motion follows immediately without camera easing');
    reduced.fills.length = 0;
    reduced.renderer.render(scrollingState(1900, { tick: 41 }), meta);
    assert.equal(heroHead(reduced.fills)?.originX, 940, 'right camera edge clamps to 960');

    const duel = recordingRenderer();
    duel.renderer.render({ ...scrollingState(1200), arena: { theme: 'land', groundY: 430, width: 960 } },
      { mode: 'duel', theme: 'land' });
    assert.equal(heroHead(duel.fills)?.originX, 1200,
      'online duel has no scrolling camera and retains its 960px world');
  });
});

test('the first-stage photo remains original on the left and mirrors at the second panel', () => {
  const previousImage = globalThis.Image;
  const hadImage = Object.hasOwn(globalThis, 'Image');
  class ReadyImage {
    constructor() { this.complete = true; this.naturalWidth = 1600; this.src = ''; }
  }
  globalThis.Image = ReadyImage;
  try {
    const recording = recordingRenderer(true);
    recording.renderer.render({ ...scrollingState(120),
      arena: { theme: 'forest', width: 1920, groundY: 430, platforms: [], hazards: [] } },
    { mode: 'campaign', theme: 'forest', level: 1 });
    assert.equal(recording.images.length, 2);
    assert.deepEqual(recording.images.map(({ args }) => args),
      [[0, 0, 960, 540], [0, 0, 960, 540]], 'each photo panel keeps its original aspect ratio');
    assert.equal(recording.images[0].originX, 0);
    assert.equal(recording.images[0].scaleX, 1, 'the first stage uses the supplied photo unflipped');
    assert.equal(recording.images[1].originX, 1920);
    assert.equal(recording.images[1].scaleX, -1, 'the right panel mirrors around the seam');
  } finally {
    if (hadImage) globalThis.Image = previousImage;
    else delete globalThis.Image;
  }
});

test('all four illustrated themes and their ground extend into the second world panel', () => {
  for (const theme of ['forest', 'city', 'ocean', 'land']) {
    const recording = recordingRenderer(true);
    recording.renderer.render({ ...scrollingState(1300),
      arena: { theme, width: 1920, groundY: 430, platforms: [], hazards: [] } },
    { mode: 'campaign', theme, level: 0 });
    const ground = recording.rects.filter(({ y, w, h }) => y === 430 && w === 960 && h === 110);
    assert.equal(ground.length, 2, `${theme} ground has two continuous viewport-width panels`);
    assert.ok(ground.some(({ scaleX }) => scaleX === -1), `${theme} ground reaches the right panel`);
    assert.ok(recording.rects.some(({ y, w, h, scaleX }) => y === 0 && w === 960
      && h === 540 && scaleX === -1), `${theme} sky reaches the right panel`);
  }
});

test('stairs, floating tread and rotating wooden plank use the collision pose at motionTick', () => {
  const floating = { x: 1180, y: 290, w: 120, h: 12,
    motion: 'float', baseY: 290, amplitude: 20, period: 100 };
  const rotating = { x: 1370, y: 300, w: 160, h: 12, type: 'log',
    motion: 'rotate', baseX: 1450, baseY: 300, baseAngle: 0, amplitude: .2, period: 100 };
  const stair = { x: 1570, y: 345, w: 50, h: 12,
    kind: 'stair', stairDirection: 'up' };
  const meta = { mode: 'campaign', theme: 'land', level: 43 };
  const state = scrollingState(1350, { motionTick: 25,
    arena: { theme: 'land', width: 1920, groundY: 430,
      platforms: [floating, rotating, stair], hazards: [] } });
  const recording = recordingRenderer(true);
  recording.renderer.render(state, meta);
  const pose = platformPose(rotating, state.motionTick);
  const plank = recording.rotations.find(({ angle }) => Math.abs(angle - pose.angle) < 1e-9);
  assert.ok(plank, 'wooden plank rotates through the shared collision angle');
  assert.equal(plank.originX, pose.centerX - (1350 - 480));
  assert.equal(plank.originY, pose.centerY);
  assert.ok(recording.rects.some(({ color, x, y, w }) => color === '#c99866'
    && x === -pose.width / 2 && y === 0 && w === pose.width),
  'wooden top edge remains exactly on the walkable collision surface');
  const floatingY = platformPose(floating, state.motionTick).centerY;
  const floatingTop = recording.rects.find(({ color, originY, w }) => color === '#cc9b6c'
    && originY === floatingY && w === floating.w);
  assert.ok(floatingTop, 'floating platform appears at its simulated vertical position');
  assert.ok(recording.rects.some(({ color }) => color === 'rgba(20,39,39,.24)'),
    'stair risers distinguish adjacent walkable treads');
  recording.rects.length = 0;
  recording.renderer.render({ ...state, tick: 41 }, meta);
  assert.ok(recording.rects.some(({ color, originY, w }) => color === '#cc9b6c'
    && originY === floatingY && w === floating.w), 'hitstop freezes the platform pose');
});

test('spear telegraph, projectile and landing effects stay at their world positions', () => {
  const recording = recordingRenderer(true);
  const enemy = { ...fighter('grunt', 0, 0, -1), id: 'enemy', team: 1,
    x: 1510, height: 88, width: 29, spearWindup: 12, spearAimX: 1410, spearAimY: 340 };
  const state = scrollingState(1440, { fighters: [
    { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 1440, height: 88, width: 29 }, enemy],
  projectiles: [{ id: 'one', kind: 'spear', team: 1, x: 1510, y: 330, vx: -15, vy: -1 }] });
  const meta = { mode: 'campaign', theme: 'land', level: 43 };
  recording.renderer.render(state, meta);
  assert.ok(recording.strokes.some(({ color, width }) => color === '#ffca92' && width === 2.8),
    'an enemy draws a held spear and a warning direction before throwing');
  const shaft = recording.strokes.find(({ color, width }) => color === '#d79a70' && width === 3.5);
  assert.equal(shaft?.originX, 550, 'the airborne spear is translated by the camera');
  assert.ok(!recording.strokes.some(({ color, width }) => color === '#d79a70' && width === 3.2),
    'reduced motion keeps the spear but drops its flight trail');

  for (const type of ['spear-windup', 'spear-throw', 'spear-impact']) {
    recording.renderer.effect({ id: `spear-${type}`, type, x: 1510, y: 330,
      vx: -15, vy: -1, facing: -1 });
    recording.renderer.effect({ id: `spear-${type}`, type, x: 1510, y: 330 });
  }
  recording.strokes.length = 0;
  recording.renderer.render({ ...state, tick: 41 }, meta);
  for (const color of ['#fff1c9', '#dffff0', '#fff4ce']) {
    const ring = recording.strokes.filter(({ color: strokeColor, points }) => strokeColor === color
      && points.some((point) => point.kind === 'arc' && point.x === 1510));
    assert.equal(ring.length, 1, `${color} event renders once at the authoritative position`);
    assert.equal(ring[0].originX + 1510, 550, 'event centre follows the same camera');
  }
});

test('enemy spear warning still curves to its locked target even with reduced motion', () => {
  for (const reducedMotion of [false, true]) {
    const recording = recordingRenderer(reducedMotion);
    const enemy = { ...fighter('grunt', 0, 0), id: 'enemy', team: 1,
      x: 1370, y: 438, height: 88, width: 29, spearWindup: 10,
      spearAimX: 1700, spearAimY: 385 };
    recording.renderer.render(scrollingState(1370, { fighters: [enemy] }),
      { mode: 'campaign', theme: 'forest', level: 13 });
    const preview = recording.strokes.find(({ color, points }) => color === '#ffca92'
      && points.length >= 8 && points.every((point) => Array.isArray(point)));
    assert.ok(preview, 'the enemy still gives a readable parabolic warning');
    const first = preview.points[0];
    const last = preview.points.at(-1);
    const highest = Math.min(...preview.points.map((point) => point[1]));
    assert.ok(highest < first[1] - 20, 'the warning rises above its release point');
    assert.ok(last[1] > highest + 20, 'the warning descends toward the target');
    assert.ok(Math.abs(last[0] - enemy.spearAimX) < 0.01);
    assert.ok(Math.abs(last[1] - enemy.spearAimY) < 0.01);
  }
});

test('manual spear aim follows chosen angle and camera while keeping an endpoint cue in both motion settings', () => {
  for (const reducedMotion of [false, true]) {
    const recording = recordingRenderer(reducedMotion);
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0,
      x: 1370, y: 438, height: 88, width: 29, spearAiming: true,
      spearAimAngle: 8, spearWindup: 0 };
    recording.renderer.render(scrollingState(1370, { fighters: [hero] }),
      { mode: 'campaign', theme: 'forest', level: 13 });
    const origin = spearOrigin(hero);
    const flight = spearAimedFlight(1, hero.spearAimAngle);
    const preview = recording.strokes.find(({ color, points }) => color === '#b4f7da'
      && points.length > 10 && points[0]?.[0] === origin.x);
    assert.ok(preview, 'pressing I draws a complete reference arc before any windup');
    assert.equal(preview.originX, -(1370 - 480), 'the arc uses the same world-camera translation');
    assert.deepEqual(preview.points[0], [origin.x, origin.y]);
    assert.deepEqual(preview.points[1], Object.values(spearTrajectoryPoint(origin.x, origin.y, flight, 1)),
      'the first preview step uses the projectile’s actual discrete velocity');
    assert.ok(Math.min(...preview.points.map((point) => point[1])) < origin.y - 4);
    assert.ok(Math.abs(preview.points.at(-1)[1] - (430 - 7)) < 1e-9,
      'the reference arc stops where its centre meets the ground');
    assert.ok(recording.strokes.some(({ color, points }) => color === '#b4f7da'
      && points.some((point) => point.kind === 'arc'
        && Math.abs(point.x - preview.points.at(-1)[0]) < 1e-9)),
    'an on-screen ground endpoint has an explicit reticle');
    assert.ok(recording.labels.some(({ value }) => value === '仰角 8°'));
    assert.ok(recording.labels.some(({ value }) => value === '参考落点'));
    assert.ok(recording.strokes.some(({ color, width, points }) => color === SHADOW_WANDERER.limbCore
      && width === 4.4 && points.at(-1)?.[1] < -60),
    'the hero holds the spear up during manual aiming');
  }
});

test('committed spear warning uses the locked facing and angle, and marks a distant landing as offscreen', () => {
  const recording = recordingRenderer(true);
  const hero = { ...fighter('hero', 0, 0, 1), id: 'hero', team: 0,
    x: 1370, y: 438, height: 88, width: 29,
    spearAiming: false, spearWindup: 10, spearAimAngle: 42, spearLaunchFacing: -1 };
  recording.renderer.render(scrollingState(1370, { fighters: [hero] }),
    { mode: 'campaign', theme: 'forest', level: 13 });
  const origin = spearOrigin(hero, -1);
  const flight = spearAimedFlight(-1, 42);
  const preview = recording.strokes.find(({ color, points }) => color === '#b4f7da'
    && points.length > 10 && points[0]?.[0] === origin.x);
  assert.ok(preview, 'the chosen path remains visible while the locked throw winds up');
  assert.deepEqual(preview.points[1], Object.values(spearTrajectoryPoint(origin.x, origin.y, flight, 1)));
  assert.ok(preview.points[1][0] < origin.x, 'the locked facing wins over a later pose change');
  assert.ok(recording.labels.some(({ value }) => value === '锁定 42°'));
  assert.ok(recording.labels.some(({ value }) => value === '参考落点在画面外'));
});

test('a steep throw from a high platform previews its sky exit rather than a false landing', () => {
  const recording = recordingRenderer(true);
  const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0,
    x: 400, y: 190, height: 88, width: 29, spearAiming: true,
    spearAimAngle: 72, spearWindup: 0 };
  recording.renderer.render(scrollingState(400, { fighters: [hero] }),
    { mode: 'campaign', theme: 'forest', level: 13 });
  const origin = spearOrigin(hero);
  const preview = recording.strokes.find(({ color, points }) => color === '#b4f7da'
    && points.length > 10 && points[0]?.[0] === origin.x);
  assert.ok(preview);
  assert.ok(Math.abs(preview.points.at(-1)[1] + 80) < 1e-9);
  assert.ok(recording.labels.some(({ value }) => value === '飞出场地'));
});

test('a horizontal floating tread renders at its shared collision pose behind the camera', () => {
  const drift = { x: 1300, y: 330, w: 112, h: 12, type: 'stone',
    motion: 'float', axis: 'x', baseX: 1300, baseY: 330,
    period: 120, amplitude: 24, phase: 0 };
  const recording = recordingRenderer(true);
  const state = scrollingState(1370, { arena: { theme: 'land', width: 1920,
    groundY: 430, platforms: [drift], hazards: [] }, motionTick: 0 });
  const meta = { mode: 'campaign', theme: 'land', level: 0 };
  const platformTop = () => recording.rects.find(({ w, h }) => w === drift.w && h === 6);
  recording.renderer.render(state, meta);
  const first = platformTop();
  assert.ok(first);
  assert.equal(first.originX + first.scaleX * (-drift.w / 2),
    platformPose(drift, 0).left - 890, 'the visible plank starts at its simulated world edge');
  recording.rects.length = 0;
  recording.renderer.render({ ...state, tick: 41, motionTick: 30 }, meta);
  const right = platformTop();
  assert.ok(right);
  assert.equal(right.originX - first.originX, 24,
    'the rendered tread shifts exactly as its walkable surface does');
});

test('world-space warning, KO tomato and light wave survive crossing the old 960px boundary', () => {
  withClock(() => {
    const recording = recordingRenderer(true);
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 1450, height: 88 };
    const enemy = { ...fighter('grunt', 0, 0), id: 'enemy', team: 1, x: 1500, height: 84 };
    const state = { ...scrollingState(1450),
      fighters: [hero, enemy], fallingObject: { kind: 'hail', phase: 'warning',
        x: 1500, y: -20, impactY: 325, radius: 8, ticksUntilImpact: 20 } };
    const meta = { mode: 'campaign', theme: 'land', level: 44 };
    recording.renderer.render(state, meta);
    const warning = recording.strokes.find(({ color, points }) => color === '#d4fff4'
      && points.some((point) => point.kind === 'arc' && point.x === 1500));
    assert.equal(warning?.originX + 1500, 540, 'falling warning is not clamped to screen x=960');

    recording.renderer.effect({ id: 'right-side-ko', type: 'ko', target: enemy.id,
      x: 1500, y: enemy.y - enemy.height * .45 });
    recording.renderer.effect({ id: 'right-side-wave', type: 'special-wave',
      x: 1450, y: 350, radius: 1920 });
    recording.fills.length = 0;
    recording.strokes.length = 0;
    recording.rects.length = 0;
    recording.renderer.render({ ...state, tick: 41,
      fighters: [hero, { ...enemy, hp: 0 }] }, meta);
    const tomato = recording.fills.find(({ color }) => color === '#702d2a');
    assert.ok(tomato && tomato.originX > 500 && tomato.originX < 560,
      'KO echo keeps its world position above the fallen enemy');
    const wave = recording.strokes.find(({ color, points }) => color === '#dffff8'
      && points.some((point) => point.kind === 'arc' && point.x === 1450));
    assert.equal(wave?.originX + 1450, 490, 'light wave expands from the hero in world space');
    const crest = recording.strokes.find(({ color, points }) => color === '#ffe0ae'
      && points.some((point) => point.kind === 'bezier'));
    assert.equal(crest?.originX + crest.points[0][0], 442,
      'the land-tinted crest stays with the hero beyond the old world seam');
    assert.ok(!recording.rects.some(({ x, w, originX }) => x === 960 && w === 960
      && originX === -960), 'a spell should not flash over the whole viewport');
  });
});

test('regular and boss punch wind appears only during each real damage window', () => {
  for (const { kind, stage, from, to } of ATTACK_WINDOWS) {
    const frames = [
      [from - 1, false], [from, true],
      [Math.floor((from + to) / 2), true], [to, true], [to + 1, false],
    ];
    for (const [attackTick, visible] of frames) {
      const { fills, strokes } = renderFighters([fighter(kind, stage, attackTick)]);
      const core = kind === 'boss' ? '#ffeddb' : '#fff8e8';
      const gusts = strokes.filter(({ color, points }) => color === core
        && points.some((point) => point.kind === 'bezier'));
      assert.equal(gusts.length, Number(visible), `${kind} combo ${stage}, tick ${attackTick}`);
      assert.equal(fills.filter(({ color }) => color === core).length, 0,
        'punches use open wind strokes, never the old filled arrow');
      if (kind === 'boss') {
        const warning = stage === 3 ? '#f59b77' : '#ffd09a';
        assert.equal(fills.some(({ color }) => color === warning), attackTick < from,
          `boss warning and punch wind must not overlap at stage ${stage}, tick ${attackTick}`);
      }
    }
  }
});

test('hero and opponent fist wakes mirror the fighter direction even on a whiff', () => {
  for (const facing of [-1, 1]) {
    for (const index of [0, 1]) {
      const combatant = fighter(index ? 'grunt' : 'hero', 2, 8, facing);
      const fighters = index ? [fighter('hero', 0, 0), combatant] : [combatant];
      const { strokes } = renderFighters(fighters);
      const core = index ? '#fff0e7' : '#fff8e8';
      const wind = strokes.filter(({ color, points }) => color === core
        && points.some((point) => point.kind === 'bezier'));
      assert.equal(wind.length, 1, `fighter ${index}, facing ${facing}`);
      assert.equal(wind[0].scaleX, facing, `the fist wake mirrors fighter ${index}`);
      assert.ok(wind[0].points[1].x > wind[0].points[0][0],
        'a curved gust moves forward from the fist, without an arrowhead');
    }
  }
});

test('reduced motion keeps the punch wind but removes its decorative trails', () => {
  const combatant = fighter('hero', 3, 10);
  const normal = renderFighters([combatant]);
  const reduced = renderFighters([combatant], { reducedMotion: true });
  const coreWind = ({ color, points }) => color === '#fff8e8'
    && points.some((point) => point.kind === 'bezier');
  const trails = ({ color, width }) => color === '#f5b66d' && width === 1.6;
  assert.equal(normal.strokes.filter(coreWind).length, 1);
  assert.equal(reduced.strokes.filter(coreWind).length, 1);
  assert.equal(normal.strokes.filter(trails).length, 3);
  assert.equal(reduced.strokes.filter(trails).length, 0);
});

test('the boss keeps a slim stick-figure body but stands visibly taller and wider', () => {
  const hero = { ...fighter('hero', 0, 0), id: 'hero', x: 260, height: 88 };
  const boss = { ...fighter('boss', 0, 0, -1), id: 'boss', x: 650, height: 136 };
  const { fills, strokes } = renderFighters([hero, boss]);
  const heroHead = fills.find(({ color, points }) => color === SHADOW_WANDERER.head
    && points.some((point) => point.kind === 'arc' && point.radius === 22));
  const bossHead = fills.find(({ color, points }) => color === '#482d34'
    && points.some((point) => point.kind === 'arc' && point.radius === 22));
  const bossCollar = strokes.find(({ color, width }) => color === '#ef8c72' && width === 1.6);
  assert.equal(heroHead?.scaleX, 1);
  assert.equal(bossHead?.scaleX, -1.28);
  assert.ok(bossCollar, 'an angular shoulder accent separates bosses from ordinary enemies');
  assert.ok(Math.abs(bossHead.scaleX) > Math.abs(heroHead.scaleX),
    'the same oversized head is scaled up on the boss');
});

test('the enlarged boss fist wake stays near its authoritative melee reach', () => {
  for (const [stage, activeTick] of [[1, 14], [2, 15], [3, 17]]) {
    const { strokes } = renderFighters([fighter('boss', stage, activeTick)]);
    const wake = strokes.find(({ color, points }) => color === '#ffeddb'
      && points.some((point) => point.kind === 'bezier'));
    const reach = attackOf({ kind: 'boss', attackStage: stage }).reach;
    assert.ok(wake);
    assert.ok(wake.points[1].x * Math.abs(wake.scaleX) <= reach + 20,
      `boss combo ${stage} must not suggest a long-range projectile`);
  }
});

test('Boss windup gathers local gold energy without changing its warning window', () => {
  const winding = fighter('boss', 3, 8);
  const normal = renderFighters([winding]);
  const reduced = renderFighters([winding], { reducedMotion: true });
  for (const { fills, strokes } of [normal, reduced]) {
    assert.ok(fills.some(({ color }) => color === '#f59b77'),
      'the existing warning mark stays readable before the damaging frame');
    const gold = strokes.find(({ color }) => color === '#fff0c3');
    assert.ok(gold?.points.some((point) => point.kind === 'arc' && point.radius < 45),
      'the secondary warning is a small ring around the fist');
  }
  assert.equal(normal.strokes.filter(({ color }) => color === '#ffe8b5').length, 3);
  assert.equal(reduced.strokes.filter(({ color }) => color === '#ffe8b5').length, 0,
    'reduced motion keeps the warning but removes the loose charging sparks');
});

test('the special wave charges at two palms, then releases a directional beam with a quieter area echo', () => {
  withClock((advance) => {
    const { renderer, fills, strokes, rects } = recordingRenderer();
    renderFrame(renderer, [], 39);
    strokes.length = 0;
    fills.length = 0;
    const wave = { id: '40:special-wave', type: 'special-wave', x: 310, y: 350,
      facing: 1, radius: 960 };
    renderer.effect(wave);
    renderFrame(renderer, [{ ...fighter('hero', 0, 0), specialWaveTicks: 35 }], 40);
    assert.ok(fills.some(({ color }) => color === '#e9fff0'),
      'the first frame gathers jade-white energy at the palms');
    assert.equal(strokes.filter(({ color }) => color === '#fffdf0').length, 0,
      'the long beam waits until its short visual charge finishes');
    assert.equal(strokes.filter(({ color }) => color === '#dffff8').length, 1,
      'the cast also sends a weaker round shock across the full wave');
    assert.equal(strokes.filter(({ color }) => color === '#ffe0ae').length, 1,
      'the land scene lends a restrained warm crest');
    assert.ok(!rects.some(({ color }) => typeof color === 'string'
      && color.startsWith('rgba(148,255,239,')),
    'the cast never flashes a full-screen rectangle');
    assert.ok(strokes.some(({ color }) => color === '#ddfff3'),
      'the hero remains visibly shielded during the special window');

    advance(175);
    strokes.length = 0;
    renderFrame(renderer, [{ ...fighter('hero', 0, 0), specialWaveTicks: 25 }], 50);
    const core = strokes.find(({ color, width, points }) => color === '#fffdf0'
      && width === 11 && points.some((point) => point.kind === 'bezier'));
    assert.ok(core, 'a white-core jade beam moves forward from the hero');
    assert.ok(strokes.some(({ color, width }) => color === '#173a42' && width === 46),
      'an ink edge separates the light from bright photo backdrops');
    assert.equal(strokes.filter(({ color }) => color === '#72e4df').length, 2,
      'the forward beam dominates the thinner area echo');
    assert.ok(strokes.filter(({ color }) => color === '#ffe0ae').length <= 3,
      'the scene-coloured accent stays on the cast crest, rail and moving head');
    strokes.length = 0;
    renderer.effect({ ...wave });
    renderFrame(renderer, [], 51);
    assert.equal(strokes.filter(({ color, width }) => color === '#fffdf0' && width === 11).length, 1,
      'replayed authoritative snapshots cannot stack the same beam');
  });
});

test('beam head advances in world space, mirrors with cast facing and never overshoots arena edge', () => {
  withClock((advance) => {
    const right = recordingRenderer();
    const left = recordingRenderer();
    const meta = { mode: 'campaign', theme: 'land', level: 44 };
    const state = scrollingState(1450);
    for (const recording of [right, left]) recording.renderer.render({ ...state, tick: 39 }, meta);
    right.renderer.effect({ id: '40:right-wave', type: 'special-wave', source: 'hero',
      x: 1450, y: 350, facing: 1, radius: 1920 });
    left.renderer.effect({ id: '40:left-wave', type: 'special-wave', source: 'hero',
      x: 1450, y: 350, facing: -1, radius: 1920 });
    const core = (recording) => recording.strokes.find(({ color, width, points }) =>
      color === '#fffdf0' && width === 11 && points.some((point) => point.kind === 'bezier'));
    const endpoint = (stroke) => stroke.points.find((point) => point.kind === 'bezier').x;

    advance(145);
    for (const recording of [right, left]) {
      recording.strokes.length = 0;
      recording.renderer.render({ ...state, tick: 48 }, meta);
    }
    const rightEarly = core(right);
    const leftEarly = core(left);
    assert.ok(rightEarly && leftEarly);
    assert.equal(rightEarly.originX, 1450 + 39 - 960,
      'the outgoing palm is fixed in world space across the old 960px seam');
    assert.equal(leftEarly.originX, 1450 - 39 - 960,
      'a left-facing cast starts from the other extended palm');
    assert.equal(rightEarly.scaleX, 1);
    assert.equal(leftEarly.scaleX, -1, 'the same beam geometry mirrors to the left');
    const rightLength = endpoint(rightEarly);
    const leftLength = endpoint(leftEarly);

    advance(155);
    for (const recording of [right, left]) {
      recording.strokes.length = 0;
      recording.renderer.render({ ...state, tick: 57 }, meta);
    }
    assert.ok(endpoint(core(right)) > rightLength + 30);
    assert.ok(endpoint(core(left)) > leftLength + 50,
      'the luminous head visibly advances over the first few frames');
    assert.ok(endpoint(core(right)) <= 1920 - (1450 + 39),
      'rightward light stops at the world boundary');
    assert.ok(endpoint(core(left)) <= 1450 - 39,
      'leftward light stops at the other world boundary');
  });
});

test('reduced motion keeps a static, short directional beam and calm per-target confirmation', () => {
  withClock((advance) => {
    const calm = recordingRenderer(true);
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 400 };
    const behind = { ...fighter('grunt', 0, 0), id: 'behind', team: 1, x: 240 };
    const ahead = { ...fighter('grunt', 0, 0), id: 'ahead', team: 1, x: 700 };
    const fighters = [hero, behind, ahead];
    renderFrame(calm.renderer, fighters, 39);
    calm.renderer.effect({ id: '40:calm-wave', type: 'special-wave', source: 'hero',
      x: 400, y: 350, facing: 1, radius: 1920 });
    for (const target of [behind, ahead]) {
      calm.renderer.effect({ id: `40:calm-hit-${target.id}`, type: 'hit', source: 'hero',
        target: target.id, x: target.x, y: 350, heavy: true, special: true });
    }
    const calmCore = () => calm.strokes.find(({ color, width }) => color === '#fffdf0' && width === 4);
    calm.strokes.length = 0;
    renderFrame(calm.renderer, fighters, 40);
    const first = calmCore();
    assert.ok(first, 'low-motion players still see a clearly directional beam immediately');
    const distance = first.points.find((point) => point.kind === 'bezier').x;
    assert.ok(distance > 200 && distance <= 380, 'the calm beam is bounded instead of sweeping a viewport');
    assert.equal(calm.strokes.filter(({ color }) => color === '#e4fff3').length, 2,
      'front and rear targets each show their own hit confirmation');
    assert.ok(calm.strokes.some(({ color, scaleX }) => color === '#e4fff3' && scaleX === -1),
      'a target behind the main ray still has a leftward impact cue');
    advance(145);
    calm.strokes.length = 0;
    renderFrame(calm.renderer, fighters, 49);
    assert.equal(calmCore().points.find((point) => point.kind === 'bezier').x, distance,
      'reduced motion fades a fixed ray without moving its head');
    assert.equal(calm.strokes.filter(({ color, originX }) => color === '#ffe0ae'
      && (originX === behind.x || originX === ahead.x)).length, 0,
    'calm target marks do not add moving theme-coloured flecks');
    advance(210);
    calm.strokes.length = 0;
    renderFrame(calm.renderer, fighters, 70);
    assert.equal(calmCore(), undefined, 'the transient spell clears promptly');
  });
});

test('legacy wave events infer facing from the last fighter and a new stage clears the beam', () => {
  withClock((advance) => {
    const { renderer, strokes } = recordingRenderer();
    const hero = { ...fighter('hero', 0, 0, -1), id: 'hero', team: 0 };
    renderFrame(renderer, [hero], 39);
    renderer.effect({ id: '40:legacy-wave', type: 'special-wave', source: 'hero',
      x: hero.x, y: 350, radius: 960 });
    advance(160);
    strokes.length = 0;
    renderFrame(renderer, [hero], 40);
    assert.ok(strokes.some(({ color, width, scaleX }) => color === '#fffdf0'
      && width === 11 && scaleX === -1),
    'an older event without facing still points where its source was looking');

    strokes.length = 0;
    renderer.render({ tick: 0, arena: { theme: 'city', groundY: 430, width: 960 },
      fighters: [hero] }, { mode: 'campaign', theme: 'city', level: 15 });
    assert.ok(!strokes.some(({ color, width }) => color === '#fffdf0' && width === 11),
      'retry, mode or stage switches never leave the old beam on the next scene');
  });
});

test('a wave received before the first wide-world frame keeps cast and target world coordinates', () => {
  withClock(() => {
    const { renderer, strokes } = recordingRenderer(true);
    renderer.effect({ id: 'early-wave', type: 'special-wave', source: 'hero',
      x: 1450, y: 350, facing: 1, radius: 1920 });
    renderer.effect({ id: 'early-wave-hit', type: 'hit', special: true, heavy: true,
      source: 'hero', target: 'enemy', x: 1510, y: 350 });
    renderer.render(scrollingState(1450), { mode: 'campaign', theme: 'land', level: 44 });
    const echo = strokes.find(({ color, points }) => color === '#dffff8'
      && points.some((point) => point.kind === 'arc' && point.x === 1450));
    const beam = strokes.find(({ color, width }) => color === '#fffdf0' && width === 4);
    const mark = strokes.find(({ color }) => color === '#e4fff3');
    assert.equal(echo?.originX, -960);
    assert.equal(beam?.originX, 1450 + 39 - 960);
    assert.equal(mark?.originX, 1510 - 960,
      'neither the ray nor a distant hit snaps to the old x=960 boundary');
    assert.ok(strokes.some(({ color }) => color === '#ffe0ae'),
      'the first rendered chapter still tints a cast received before its scene metadata');
  });
});

test('confirmed hits create one near-contact ink brush, with a stronger heavy stroke', () => {
  withClock((advance) => {
    const { renderer, strokes } = recordingRenderer();
    const attacker = { ...fighter('hero', 3, 8), id: 'hero', team: 0, x: 440 };
    const victim = { ...fighter('grunt', 0, 0, -1), id: 'enemy', team: 1, x: 500 };
    renderFrame(renderer, [attacker, victim], 39);
    assert.equal(strokes.filter(({ color }) => color === '#fff9e9').length, 0,
      'the pose alone never claims a landed hit');
    const hit = { id: '40:hit', type: 'hit', source: 'hero', target: 'enemy',
      x: 500, y: 378, damage: 17, heavy: true };
    renderer.effect(hit);
    strokes.length = 0;
    renderFrame(renderer, [attacker, victim], 40);
    const brush = strokes.filter(({ color }) => color === '#fff9e9');
    assert.equal(brush.length, 1);
    assert.equal(brush[0].width, 5, 'the heavy hit lays a bolder white ink stroke');
    assert.ok(brush[0].originX > 480 && brush[0].originX < 510,
      'the impact sits at the target within the short hit shake, not at the attacker');
    assert.ok(strokes.some(({ color }) => color === '#f8cf8c'),
      'P1 keeps a warm gold contact accent');
    renderer.effect({ ...hit });
    advance(50);
    strokes.length = 0;
    renderFrame(renderer, [attacker, victim], 41);
    assert.equal(strokes.filter(({ color }) => color === '#fff9e9').length, 1,
      'replayed authoritative hits do not double the impact');
    advance(196);
    strokes.length = 0;
    renderFrame(renderer, [attacker, victim], 42);
    assert.equal(strokes.filter(({ color }) => color === '#fff9e9').length, 0,
      'the brush clears within a quarter second');
  });
});

test('impact accents respect scene, PvP team and reduced-motion bounds', () => {
  const duel = recordingRenderer();
  const p2 = { ...fighter('hero', 0, 0, -1), id: 'p2', team: 1, x: 600 };
  duel.renderer.render({ tick: 39, arena: { theme: 'city', groundY: 430 },
    fighters: [p2] }, { mode: 'duel', theme: 'city' });
  duel.renderer.effect({ id: 'p2-hit', type: 'hit', source: 'p2', target: 'p1',
    x: 510, y: 380, heavy: false });
  duel.strokes.length = 0;
  duel.renderer.render({ tick: 40, arena: { theme: 'city', groundY: 430 },
    fighters: [p2] }, { mode: 'duel', theme: 'city' });
  assert.ok(duel.strokes.some(({ color, scaleX }) => color === '#b7f2f2' && scaleX === -1),
    'P2 turns the same local brush cool and mirrors the strike direction');
  assert.equal(duel.strokes.filter(({ color }) => color === '#d1d2ee').length, 2,
    'city colour stays in just two little directional flecks');
  duel.strokes.length = 0;
  duel.renderer.render({ tick: 0, arena: { theme: 'forest', groundY: 430 },
    fighters: [p2] }, { mode: 'duel', theme: 'forest' });
  assert.equal(duel.strokes.filter(({ color }) => color === '#fff9e9').length, 0,
    'switching scenery clears the previous impact instead of recolouring it');

  const calm = recordingRenderer(true);
  renderFrame(calm.renderer, [], 39);
  for (let i = 0; i < 30; i++) calm.renderer.effect({ id: `hit-${i}`, type: 'hit',
    x: 400 + i, y: 350, source: 'hero', target: `enemy-${i}`, heavy: i % 2 === 0 });
  calm.renderer.effect({ id: 'hazard-hit', type: 'hit', x: 650, y: 350,
    source: 'hazard:spikes', target: 'hero' });
  calm.renderer.effect({ id: 'wave-hit', type: 'hit', x: 700, y: 350,
    source: 'hero', target: 'enemy', special: true });
  calm.strokes.length = 0;
  renderFrame(calm.renderer, [], 40);
  assert.equal(calm.strokes.filter(({ color }) => color === '#fff9e9').length, 24,
    'many same-frame hits stay within the fixed local-mark budget');
  assert.equal(calm.strokes.filter(({ color }) => color === '#ffe0ae').length, 0,
    'reduced motion removes travelling flecks while preserving the contact strokes');
});

test('a confirmed spear hit keeps projectile impact feedback without a melee brush', () => {
  const { renderer, strokes } = recordingRenderer();
  renderFrame(renderer, [], 39);
  renderer.effect({ id: '40:spear-damage', type: 'hit', delivery: 'spear',
    source: 'hero', target: 'enemy', x: 500, y: 350, heavy: true, damage: 22 });
  renderer.effect({ id: '40:spear-impact', type: 'spear-impact',
    x: 500, y: 350, source: 'hero', target: 'enemy', damage: 22, surface: 'fighter' });
  strokes.length = 0;
  renderFrame(renderer, [], 40);
  assert.equal(strokes.filter(({ color }) => color === '#fff9e9').length, 0,
    'a projectile must not draw the new near-contact fist ink');
  assert.ok(strokes.some(({ color }) => color === '#fff4ca'),
    'the ordinary confirmed-damage cue is still present');
  assert.ok(strokes.some(({ color }) => color === '#fff4ce'),
    'the existing spear impact ring remains readable');
});

test('falling-object warning and object are legible only in campaign scenes', () => {
  const recording = recordingRenderer();
  const { renderer, strokes, fills } = recording;
  const arena = { theme: 'ocean', groundY: 430, platforms: [], hazards: [] };
  const fallingObject = { kind: 'hail', phase: 'warning', x: 380, y: -20,
    impactY: 325, radius: 8, ticksUntilImpact: 45, warningTicks: 40, index: 0 };
  renderer.render({ tick: 130, arena, fighters: [], fallingObject },
    { mode: 'campaign', theme: 'ocean', level: 30 });
  assert.ok(strokes.some(({ color }) => color === '#d4fff4'),
    'the target zone warns before a small object descends');

  strokes.length = 0;
  fills.length = 0;
  renderer.render({ tick: 172, arena, fighters: [],
    fallingObject: { ...fallingObject, phase: 'falling', y: 190, ticksUntilImpact: 12 } },
  { mode: 'campaign', theme: 'ocean', level: 30 });
  assert.ok(fills.some(({ color }) => color === '#679eaa'), 'a hailstone is actually visible');
  assert.ok(strokes.some(({ color }) => color === '#d6f5f4'), 'its short trail conveys falling motion');

  strokes.length = 0;
  fills.length = 0;
  renderer.render({ tick: 173, arena, fighters: [], fallingObject },
    { mode: 'duel', theme: 'ocean' });
  assert.ok(!strokes.some(({ color }) => color === '#d4fff4'));
  assert.ok(!fills.some(({ color }) => color === '#679eaa'));

  const reduced = recordingRenderer(true);
  reduced.renderer.render({ tick: 172, arena, fighters: [],
    fallingObject: { ...fallingObject, phase: 'falling', y: 190 } },
  { mode: 'campaign', theme: 'ocean', level: 30 });
  assert.ok(reduced.fills.some(({ color }) => color === '#679eaa'));
  assert.ok(!reduced.strokes.some(({ color }) => color === '#d6f5f4'),
    'reduced motion keeps the object and warning, without a falling streak');
});

test('falling impacts burst once even if an authoritative event is replayed', () => {
  const { renderer, strokes, fills } = recordingRenderer();
  renderFrame(renderer, [], 39);
  const impact = { id: '40:fall-impact', type: 'fall-impact', x: 400, y: 325,
    kind: 'hail', radius: 8, index: 0 };
  renderer.effect(impact);
  strokes.length = 0;
  fills.length = 0;
  renderFrame(renderer, [], 40);
  assert.equal(strokes.filter(({ color }) => color === '#f8e7c7').length, 1);
  assert.ok(fills.some(({ color }) => color === '#cbd7ca'), 'the impact scatters a few small shards');
  renderer.effect({ ...impact });
  strokes.length = 0;
  renderFrame(renderer, [], 41);
  assert.equal(strokes.filter(({ color }) => color === '#f8e7c7').length, 1,
    'the same falling object cannot burst twice when snapshots repeat');
});

test('ground and air kick energy tracks only the authoritative active frames, even on a whiff', () => {
  for (const { type, from, to, core, accent } of [
    { type: 'ground', from: 6, to: 11, core: '#fff4d6', accent: '#ffe0a3' },
    { type: 'air', from: 7, to: 16, core: '#f7fff0', accent: '#8de9df' },
  ]) {
    for (const [kickTick, visible] of [
      [from - 1, false], [from, true], [Math.floor((from + to) / 2), true],
      [to, true], [to + 1, false],
    ]) {
      // Only one fighter and no hit event: a missed kick must still read clearly.
      const { fills, strokes } = renderFighters([kicker(type, kickTick)]);
      assert.equal(fills.filter(({ color }) => color === core).length, Number(visible),
        `${type} kick, tick ${kickTick}`);
      const impactStroke = strokes.filter(({ color, width }) => color === accent
        && (type === 'air' ? width === 2.2 : width === 4));
      assert.equal(impactStroke.length, visible ? (type === 'air' ? 2 : 1) : 0,
        `${type} impact shape must not extend into windup or recovery at tick ${kickTick}`);
      if (type === 'air') {
        const charge = strokes.filter(({ color, width }) => color === accent && width === 2.5);
        assert.equal(charge.length, kickTick < from ? 1 : 0,
          'air-kick windup uses a compact charge ring, never the extended impact trail');
      }
    }
  }
});

test('kick silhouettes and jump-kick event streaks mirror both facing directions', () => {
  for (const facing of [-1, 1]) {
    for (const type of ['ground', 'air']) {
      for (const index of [0, 1]) {
        const tick = type === 'air' ? 9 : 8;
        const combatant = kicker(type, tick, facing, index ? 'grunt' : 'hero');
        const fighters = index ? [fighter('hero', 0, 0), combatant] : [combatant];
        const { fills, strokes } = renderFighters(fighters);
        const core = type === 'air' ? '#f7fff0' : '#fff4d6';
        assert.equal(fills.find(({ color }) => color === core)?.scaleX, facing);
        const accent = type === 'air' ? (index ? '#ffad8b' : '#8de9df')
          : (index ? '#ffb296' : '#ffe0a3');
        assert.equal(strokes.find(({ color }) => color === accent)?.scaleX, facing);
      }
    }

    const { renderer, strokes } = recordingRenderer();
    renderFrame(renderer, [], 39);
    strokes.length = 0;
    renderer.effect({ id: `jump-kick-${facing}`, type: 'jump-kick', x: 400, y: 300, facing });
    renderFrame(renderer, [], 40);
    const streak = strokes.find(({ color }) => color === '#a7f3e5');
    assert.equal(streak?.scaleX, facing);
    assert.ok(streak.points[1].x > streak.points[0][0], 'curved event streak moves forward locally');
    const ring = strokes.find(({ color, points }) => color === '#eaffec'
      && points.some((point) => point.kind === 'arc'));
    assert.equal(ring?.points.find((point) => point.kind === 'arc')?.x, 400 + facing * 84,
      'the burst originates near the foot rather than at the torso');
  }
});

test('kick and jump-kick events deduplicate repeated authoritative snapshots', () => {
  for (const type of ['kick', 'jump-kick']) {
    const { renderer, strokes } = recordingRenderer();
    const event = { id: `${type}-once`, type, tick: 40, x: 400, y: 300, facing: -1 };
    const palette = type === 'kick' ? ['#fff4ca', '#f5a96c', '#e97157']
      : ['#eaffec', '#8de9df', '#f5d995'];
    renderFrame(renderer, [], 39);
    strokes.length = 0;
    renderer.effect(event);
    renderFrame(renderer, [], 40);
    const singleCount = strokes.filter(({ color }) => palette.includes(color)).length;
    assert.equal(singleCount, type === 'kick' ? 8 : 21,
      `${type} has one ring and a bounded number of short-lived shards`);
    strokes.length = 0;
    renderer.effect({ ...event });
    renderFrame(renderer, [], 41);
    assert.equal(strokes.filter(({ color }) => palette.includes(color)).length, singleCount,
      `${type} repeats must not spawn another ring or particle burst`);
  }

  const { renderer, strokes } = recordingRenderer();
  const anonymous = { type: 'kick', tick: 45, x: 400, y: 300 };
  renderFrame(renderer, [], 39);
  strokes.length = 0;
  renderer.effect(anonymous);
  renderer.effect({ ...anonymous });
  renderFrame(renderer, [], 40);
  assert.equal(strokes.filter(({ color }) => ['#fff4ca', '#f5a96c', '#e97157'].includes(color)).length, 8,
    'legacy events without IDs also deduplicate within the short replay window');
});

test('reduced motion keeps both kick impact cues but removes jump-kick flourish', () => {
  for (const type of ['ground', 'air']) {
    const activeTick = type === 'ground' ? 8 : 9;
    const { fills, strokes } = renderFighters([kicker(type, activeTick)], { reducedMotion: true });
    assert.equal(fills.filter(({ color }) => color === (type === 'ground' ? '#fff4d6' : '#f7fff0')).length, 1);
    if (type === 'air') assert.equal(strokes.filter(({ color, width }) => color === '#8de9df' && width === 2.2).length, 0);
  }

  const normal = recordingRenderer();
  const reduced = recordingRenderer(true);
  const event = { id: 'low-motion-jump-kick', type: 'jump-kick', x: 400, y: 300, facing: 1 };
  for (const recording of [normal, reduced]) {
    renderFrame(recording.renderer, [], 39);
    recording.strokes.length = 0;
    recording.renderer.effect(event);
    renderFrame(recording.renderer, [], 40);
  }
  const palette = ['#eaffec', '#8de9df', '#f5d995'];
  assert.equal(normal.strokes.filter(({ color }) => palette.includes(color)).length, 21);
  assert.equal(reduced.strokes.filter(({ color }) => palette.includes(color)).length, 6);
  assert.equal(normal.strokes.filter(({ color }) => color === '#a7f3e5' || color === '#f4e2ac').length, 2);
  assert.equal(reduced.strokes.filter(({ color }) => color === '#a7f3e5' || color === '#f4e2ac').length, 0);
});

test('low-motion jump-kick confirms the move with a stationary ring', () => {
  withClock((advance) => {
    const { renderer, strokes } = recordingRenderer(true);
    renderFrame(renderer, [], 39);
    renderer.effect({ id: 'stationary-jump-kick', type: 'jump-kick',
      x: 400, y: 300, facing: 1 });
    strokes.length = 0;
    renderFrame(renderer, [], 40);
    const radius = () => strokes.find(({ color, points }) => color === '#eaffec'
      && points.some((point) => point.kind === 'arc'))
      ?.points.find((point) => point.kind === 'arc')?.radius;
    const first = radius();
    assert.ok(first > 20 && first < 40);
    advance(150);
    strokes.length = 0;
    renderFrame(renderer, [], 41);
    assert.equal(radius(), first, 'the reduced-motion cue fades in place without radial travel');
  });
});

test('the head is much wider than every slim body stroke', () => {
  const { fills, strokes } = renderFighters([{ ...fighter('hero', 0, 0), id: 'hero' }]);
  const head = fills.find(({ color, points }) => color === SHADOW_WANDERER.head
    && points.some((point) => point.kind === 'arc' && point.radius === 22));
  const torso = strokes.find(({ color, width }) => color === SHADOW_WANDERER.head && width === 7.8);
  assert.ok(head, 'the oversized head has a 22-pixel outer radius');
  assert.ok(torso, 'the body retains a slim outline');
  assert.ok(44 / torso.width > 5, 'head diameter dominates body thickness');
});

test('each KO gets its own falling rotten tomato, even if the next wave replaces an enemy', () => {
  withClock((advance) => {
    const { renderer, fills } = recordingRenderer();
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, height: 88 };
    const enemy = { ...fighter('grunt', 0, 0), id: 'enemy-old', team: 1,
      x: 530, height: 84 };
    renderFrame(renderer, [hero, enemy], 39);
    fills.length = 0;
    const ko = { id: '40:ko-old', type: 'ko', target: enemy.id,
      x: enemy.x, y: enemy.y - enemy.height * .45 };
    renderer.effect(ko);
    renderer.effect({ ...ko });
    renderFrame(renderer, [hero, { ...enemy, id: 'enemy-new', hp: 100 }], 40);
    assert.equal(fills.filter(({ color }) => color === '#702d2a').length, 1,
      'one tomato follows the removed fighter as an echo; a replay does not duplicate it');

    fills.length = 0;
    advance(190);
    renderFrame(renderer, [hero, { ...enemy, id: 'enemy-new', hp: 100 }], 41);
    assert.ok(fills.some(({ color }) => color === '#4f7850'), 'rotten calyx remains on the splat');
    assert.ok(fills.filter(({ color }) => color === '#a83f33').length >= 4,
      'the tomato breaks into visible pulp and droplets');
  });
});

test('tomato accelerates into the head, compresses at impact, then leaves a brief stain', () => {
  withClock((advance) => {
    const { renderer, fills, strokes } = recordingRenderer();
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, height: 88 };
    renderFrame(renderer, [hero], 39);
    renderer.effect({ id: '40:tomato-phases', type: 'ko', target: hero.id,
      x: hero.x, y: hero.y - hero.height * .45 });
    const defeated = { ...hero, hp: 0 };
    const tomatoY = (tick) => {
      fills.length = 0;
      strokes.length = 0;
      renderFrame(renderer, [defeated], tick);
      return fills.find(({ color }) => color === '#d6533d')?.originY;
    };
    const startY = tomatoY(40);
    advance(60);
    const earlyY = tomatoY(41);
    advance(60);
    const laterY = tomatoY(42);
    assert.ok(laterY - earlyY > earlyY - startY,
      'the falling tomato gains speed instead of descending at a fixed rate');
    advance(60);
    tomatoY(43);
    advance(65);
    tomatoY(44);
    assert.ok(fills.some(({ color, scaleX }) => color === '#702d2a' && scaleX > 1.5),
      'the peel visibly spreads sideways as it hits the crown');
    assert.equal(strokes.filter(({ color, points }) => color === '#b4513b'
      && points.some((point) => point.kind === 'bezier')).length, 2,
    'two restrained juice ribbons burst away from the impact');
    assert.equal(fills.filter(({ color }) => color === '#8f3a30').length, 3,
      'three uneven pulp fragments separate from the peel');

    advance(100);
    tomatoY(45);
    assert.ok(fills.some(({ color }) => color === '#e4b27c'),
      'seeds and pulp remain stuck above the eyes after the peel splits');
    advance(355);
    tomatoY(46);
    assert.ok(fills.some(({ color }) => color === '#a83f33'),
      'the head stain remains visible while the result overlay appears');
    assert.ok(!fills.some(({ color }) => color === '#8f3a30'),
      'flying fragments finish quickly instead of filling the result screen');
    advance(400);
    tomatoY(47);
    assert.ok(!fills.some(({ color }) => color === '#e4b27c'),
      'the temporary mess fully clears after its fixed lifetime');
  });
});

test('reduced motion keeps a readable splat without flying peel or juice arcs', () => {
  withClock((advance) => {
    const normal = recordingRenderer();
    const reduced = recordingRenderer(true);
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, height: 88 };
    for (const recording of [normal, reduced]) {
      renderFrame(recording.renderer, [hero], 39);
      recording.renderer.effect({ id: `40:tomato-${recording === reduced}`, type: 'ko',
        target: hero.id, x: hero.x, y: hero.y - hero.height * .45 });
      recording.fills.length = 0;
      recording.strokes.length = 0;
    }
    advance(190);
    for (const recording of [normal, reduced]) {
      renderFrame(recording.renderer, [{ ...hero, hp: 0 }], 40);
    }
    assert.ok(reduced.fills.some(({ color }) => color === '#e4b27c'),
      'reduced motion shows the final head splat as soon as the sound lands');
    assert.equal(reduced.fills.filter(({ color }) => color === '#8f3a30').length, 0);
    assert.equal(reduced.strokes.filter(({ color }) => color === '#b4513b').length, 0);
    assert.equal(normal.fills.filter(({ color }) => color === '#8f3a30').length, 3);
    assert.ok(normal.fills.length > reduced.fills.length,
      'normal mode can splatter, while the calmer mode retains just the impact');
  });
});

test('two world-space KOs produce distinct bounded splashes after the 960px seam', () => {
  withClock((advance) => {
    const { renderer, fills } = recordingRenderer();
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 1450, height: 88 };
    const enemy = { ...fighter('grunt', 0, 0, -1), id: 'enemy', team: 1, x: 1510, height: 88 };
    const state = scrollingState(1450, { fighters: [hero, enemy] });
    const meta = { mode: 'campaign', theme: 'land', level: 43 };
    renderer.render({ ...state, tick: 39 }, meta);
    for (const combatant of [hero, enemy]) {
      const event = { id: `40:ko-${combatant.id}`, type: 'ko', target: combatant.id,
        x: combatant.x, y: combatant.y - combatant.height * .45 };
      renderer.effect(event);
      renderer.effect({ ...event });
    }
    advance(230);
    fills.length = 0;
    renderer.render({ ...state, tick: 40,
      fighters: [{ ...hero, hp: 0 }, { ...enemy, hp: 0 }] }, meta);
    const pulp = fills.filter(({ color }) => color === '#8f3a30');
    assert.equal(pulp.length, 6, 'each distinct KO produces exactly three pulp fragments');
    assert.ok(pulp.some(({ originX }) => originX > 460 && originX < 520));
    assert.ok(pulp.some(({ originX }) => originX > 520 && originX < 600),
      'the other head splashes separately on the right side of the scrolling world');
  });
});

test('simultaneous KOs drop two tomatoes; changing scenes clears both', () => {
  withClock(() => {
    const { renderer, fills } = recordingRenderer();
    const first = { ...fighter('hero', 0, 0), id: 'p1', x: 350, team: 0, height: 88 };
    const second = { ...fighter('hero', 0, 0), id: 'p2', x: 610, team: 1, height: 88 };
    renderFrame(renderer, [first, second], 39);
    renderer.effect({ id: '40:0', type: 'ko', target: 'p1', x: 350, y: 390 });
    renderer.effect({ id: '40:1', type: 'ko', target: 'p2', x: 610, y: 390 });
    fills.length = 0;
    renderFrame(renderer, [{ ...first, hp: 0 }, { ...second, hp: 0 }], 40);
    assert.equal(fills.filter(({ color }) => color === '#702d2a').length, 2);

    fills.length = 0;
    renderer.render({ tick: 0, arena: { theme: 'forest', groundY: 430 },
      fighters: [first, second] }, { mode: 'campaign', theme: 'forest', level: 2 });
    assert.equal(fills.filter(({ color }) => color === '#702d2a').length, 0);
  });
});

test('an airborne KO uses the current impact height, not the previous drawn frame', () => {
  withClock(() => {
    const { renderer, fills } = recordingRenderer();
    const airborne = { ...fighter('hero', 0, 0), id: 'p1', team: 0,
      x: 450, y: 200, grounded: false, height: 88 };
    renderFrame(renderer, [airborne], 39);
    fills.length = 0;
    renderer.effect({ id: '40:ko', type: 'ko', target: 'p1', x: 450,
      y: 330 - airborne.height * .45 });
    renderFrame(renderer, [{ ...airborne, y: 330, hp: 0 }], 40);
    const tomato = fills.find(({ color }) => color === '#d6533d');
    assert.ok(tomato);
    // At the start of the drop, the red body is 131px above the raised hat impact crown.
    // The previous y=200 frame would put this tomato 130px too high.
    assert.ok(tomato.originY > 64 && tomato.originY < 96,
      `tomato follows the new foot y=330 and catches the hat, actual origin ${tomato.originY}`);
  });
});

test('a KO keeps its motion setting when the system preference changes mid-splat', () => {
  withClock((advance) => {
    for (const startReduced of [false, true]) {
      const previousMatchMedia = globalThis.matchMedia;
      const preference = { matches: startReduced };
      let recording;
      try {
        globalThis.matchMedia = () => preference;
        recording = recordingCanvas();
        recording.renderer = createRenderer(recording.canvas);
      } finally {
        if (previousMatchMedia === undefined) delete globalThis.matchMedia;
        else globalThis.matchMedia = previousMatchMedia;
      }
      const hero = { ...fighter('hero', 0, 0), id: 'p1', height: 88 };
      renderFrame(recording.renderer, [hero], 39);
      recording.renderer.effect({ id: `40:ko-${startReduced}`, type: 'ko', target: 'p1',
        x: hero.x, y: hero.y - hero.height * .45 });
      preference.matches = !startReduced;
      advance(190);
      recording.fills.length = 0;
      renderFrame(recording.renderer, [{ ...hero, hp: 0 }], 40);
      const pulp = recording.fills.filter(({ color }) => color === '#a83f33').length;
      assert.equal(pulp, startReduced ? 4 : 10,
        'a change after impact cannot make the result overlay outrun the KO animation');
    }
  });
});

test('campaign corpse settles by simulation tick, remains for three seconds after settling, but the tomato still expires at 1.08s', () => {
  withClock((advance) => {
    const recording = recordingRenderer();
    const { renderer, fills } = recording;
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 170, height: 88 };
    const alive = { ...fighter('grunt', 0, 0), id: 'enemy', team: 1, x: 600, y: 310,
      height: 88, width: 29 };
    const corpse = corpseRecord('enemy', { x: 660, y: 430, koX: 600, koY: 310 });
    const meta = { mode: 'campaign', theme: 'land', level: 17 };
    const state = scrollingState(170, { fighters: [hero, { ...alive, hp: 0 }], corpses: [corpse] });
    const head = () => fills.find(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'arc' && point.radius === 22));
    renderer.render({ ...state, tick: 39, motionTick: 39,
      fighters: [hero, alive], corpses: [] }, meta);
    renderer.effect({ id: '40:corpse-ko', type: 'ko', target: 'enemy',
      x: alive.x, y: alive.y - alive.height * .45 });

    fills.length = 0;
    renderer.render({ ...state, tick: 40, motionTick: 40 }, meta);
    assert.equal(head()?.originX, 600, 'the corpse begins at the KO world-space position');
    assert.equal(head()?.originY, 310, 'an aerial KO does not jump to the ground at birth');
    assert.equal(fills.filter(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'arc' && point.radius === 22)).length, 1,
    'a dead enemy still in fighters is not painted on top of its corpse');

    fills.length = 0;
    renderer.render({ ...state, tick: 54, motionTick: 54 }, meta);
    assert.ok(head().originX > 600 && head().originX < 660, 'motionTick moves toward the landing x');
    assert.ok(head().originY > 310 && head().originY < 430, 'motionTick lowers an airborne KO');

    advance(1140);
    fills.length = 0;
    renderer.render({ ...state, tick: 110, motionTick: 110 }, meta);
    assert.equal(head()?.originX, 660, 'the corpse has reached the current support position');
    assert.ok(!fills.some(({ color }) => color === '#e4b27c' || color === '#702d2a'),
      'the tomato stain ends at its original 1.08-second lifetime');
    assert.ok(head(), 'the body persists independently of the expired tomato');

    fills.length = 0;
    renderer.render({ ...state, tick: 241, motionTick: 241 }, meta);
    assert.ok(head()?.alpha > .45 && head()?.alpha < .55,
      'the last 12 effective ticks only lightly fade the corpse');
    fills.length = 0;
    renderer.render({ ...state, tick: 247, motionTick: 247 }, meta);
    assert.equal(head(), undefined, 'the corpse disappears at settleTick + 180 ticks');
    fills.length = 0;
    renderer.render({ ...state, tick: 248, motionTick: 248, corpses: [] }, meta);
    assert.equal(head(), undefined, 'a stale dead fighter cannot reappear after corpse expiry');
  });
});

test('a removed campaign enemy stays as one corpse across waves and aftermath gives the hero a smile', () => {
  withClock(() => {
    const recording = recordingRenderer();
    const { renderer, fills, strokes } = recording;
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 170, height: 88 };
    const oldEnemy = { ...fighter('grunt', 0, 0), id: 'enemy-old', team: 1, x: 620,
      height: 88 };
    const newEnemy = { ...oldEnemy, id: 'enemy-next', x: 800 };
    const corpse = corpseRecord(oldEnemy.id, { bornTick: 40, settleTick: 67, expireTick: 247 });
    const meta = { mode: 'campaign', theme: 'land', level: 17 };
    const state = scrollingState(170, { fighters: [hero, oldEnemy], motionTick: 39, corpses: [] });
    renderer.render({ ...state, tick: 39 }, meta);
    renderer.effect({ id: '40:old-ko', type: 'ko', target: oldEnemy.id,
      x: 620, y: 430 - oldEnemy.height * .45 });

    fills.length = 0;
    renderer.render({ ...state, tick: 68, motionTick: 68,
      fighters: [hero, newEnemy], corpses: [corpse] }, meta);
    assert.equal(fills.filter(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'arc' && point.radius === 22)).length, 2,
    'one old corpse and the new-wave enemy coexist without duplicate KO echoes');

    fills.length = 0;
    strokes.length = 0;
    renderer.render({ ...state, tick: 69, motionTick: 69,
      fighters: [hero], corpses: [corpse] }, { ...meta, campaignPhase: 'aftermath' });
    assert.equal(fills.filter(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'arc' && point.radius === 22)).length, 1,
    'the final enemy can remain visible while the player is still in the arena');
    assert.ok(mouthCurve(mouth(strokes, SHADOW_WANDERER.p1.eye)) > 0,
      'the living hero celebrates during the movable aftermath window');
  });
});

test('a settled corpse follows the current simulated support pose instead of its KO-time platform position', () => {
  withClock(() => {
    const recording = recordingRenderer(true);
    const { renderer, fills } = recording;
    const meta = { mode: 'campaign', theme: 'land', level: 43 };
    const state = scrollingState(1400, { tick: 68, motionTick: 68,
      corpses: [corpseRecord('platform-enemy', { x: 1500, y: 320, koX: 1480, koY: 320 })] });
    const head = () => fills.find(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'arc' && point.radius === 22));
    renderer.render(state, meta);
    const first = { x: head().originX, y: head().originY };
    fills.length = 0;
    renderer.render({ ...state, tick: 69, motionTick: 69,
      corpses: [{ ...state.corpses[0], x: 1522, y: 334 }] }, meta);
    assert.equal(head()?.originX - first.x, 22, 'horizontal support drift carries the corpse in world space');
    assert.equal(head()?.originY - first.y, 14, 'vertical support drift carries the corpse on its ledge');
  });
});

test('stepping over a campaign corpse scatters one bounded set of cartoon bones and never resurrects the fighter', () => {
  withClock((advance) => {
    const recording = recordingRenderer();
    const { renderer, strokes, fills } = recording;
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 170, height: 88 };
    const dead = { ...fighter('grunt', 0, 0), id: 'enemy', team: 1, x: 620, hp: 0 };
    const corpse = corpseRecord();
    const meta = { mode: 'campaign', theme: 'land', level: 17 };
    const state = scrollingState(170, { tick: 68, motionTick: 68,
      fighters: [hero, dead], corpses: [corpse] });
    renderer.render(state, meta);
    const event = { id: '68:bones', type: 'bones-scatter', target: 'enemy',
      x: 620, y: 430, kind: 'grunt', facing: 1, width: 29, height: 88 };
    renderer.effect(event);
    renderer.effect({ ...event });
    renderer.effect({ ...event, id: '68:bones-replayed' });

    fills.length = 0;
    strokes.length = 0;
    renderer.render({ ...state, tick: 69, motionTick: 69 }, meta);
    const pieces = () => strokes.filter(({ color, width }) => color === '#663f41'
      && Math.abs(width - 6.2) < 1e-9);
    assert.equal(pieces().length, 5, 'one head and five detached thin-limb/torso pieces');
    assert.ok(fills.some(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'ellipse' && point.rx === 22)),
    'the oversized cartoon head remains readable after the body comes apart');
    assert.ok(!fills.some(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'arc' && point.radius === 22)),
    'the intact corpse is suppressed even if an older snapshot still includes it');
    const before = pieces().map(({ originX }) => originX);

    advance(310);
    fills.length = 0;
    strokes.length = 0;
    renderer.render({ ...state, tick: 87, motionTick: 87, corpses: [] }, meta);
    assert.equal(pieces().length, 5);
    assert.ok(pieces().some(({ originX }, index) => Math.abs(originX - before[index]) > .2),
      'normal motion spreads the pieces in short arcs');

    advance(320);
    fills.length = 0;
    strokes.length = 0;
    renderer.render({ ...state, tick: 106, motionTick: 106, corpses: [] }, meta);
    assert.equal(pieces().length, 0, 'bone pieces clear after about 0.6 seconds');
    assert.ok(!fills.some(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'arc' && point.radius === 22)),
    'a dead fighter in the snapshot cannot come back when the scatter ends');
  });
});

test('an early scatter keeps the tomato stain on the detached head only until the original KO lifetime', () => {
  withClock((advance) => {
    const recording = recordingRenderer();
    const { renderer, fills } = recording;
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 170, height: 88 };
    const enemy = { ...fighter('grunt', 0, 0), id: 'enemy', team: 1, x: 620,
      height: 88, width: 29 };
    const meta = { mode: 'campaign', theme: 'land', level: 17 };
    const state = scrollingState(170, { motionTick: 39, fighters: [hero, enemy], corpses: [] });
    renderer.render({ ...state, tick: 39 }, meta);
    renderer.effect({ id: '40:ko-before-scatter', type: 'ko', target: 'enemy',
      x: enemy.x, y: enemy.y - enemy.height * .45 });
    advance(500);
    renderer.render({ ...state, tick: 68, motionTick: 68,
      fighters: [hero], corpses: [corpseRecord()] }, meta);
    renderer.effect({ id: '68:bones-after-tomato', type: 'bones-scatter', target: 'enemy',
      x: 620, y: 430, kind: 'grunt', facing: 1, width: 29, height: 88 });

    advance(300);
    fills.length = 0;
    renderer.render({ ...state, tick: 86, motionTick: 86,
      fighters: [hero], corpses: [] }, meta);
    assert.ok(fills.some(({ color }) => color === '#e4b27c'),
      'seeds and stain remain on the detached head while the 1.08s tomato is active');

    advance(290);
    fills.length = 0;
    renderer.render({ ...state, tick: 103, motionTick: 103,
      fighters: [hero], corpses: [] }, meta);
    assert.ok(fills.some(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'ellipse' && point.rx === 22)),
    'the bone head is still present near the end of its own short scatter');
    assert.ok(!fills.some(({ color }) => color === '#e4b27c'),
      'the original tomato ends at 1.08s even while bones continue to fade');
  });
});

test('boss bones share the campaign camera, scatter inward at a world edge, and reduced motion stays static', () => {
  withClock((advance) => {
    const normal = recordingRenderer();
    const calm = recordingRenderer(true);
    const meta = { mode: 'campaign', theme: 'land', level: 30 };
    const state = scrollingState(1450, { corpses: [], motionTick: 40 });
    const event = { id: '40:boss-bones', type: 'bones-scatter', target: 'boss-30',
      x: 1510, y: 430, kind: 'boss', facing: 1, width: 44, height: 136 };
    for (const recording of [normal, calm]) {
      recording.renderer.render(state, meta);
      recording.renderer.effect(event);
      recording.fills.length = 0;
      recording.strokes.length = 0;
      recording.renderer.render({ ...state, tick: 41, motionTick: 41 }, meta);
    }
    const bossHead = (recording) => recording.fills.find(({ color, points }) => color === '#482d34'
      && points.some((point) => point.kind === 'ellipse' && Math.abs(point.rx - 22 * 1.28) < .01));
    assert.ok(bossHead(normal)?.originX > 400 && bossHead(normal)?.originX < 460,
      'world x=1510 becomes an on-screen boss skull at the shared camera offset');
    assert.equal(bossHead(normal)?.originX, bossHead(calm)?.originX);
    const normalX = normal.strokes.filter(({ color }) => color === '#482d34').map(({ originX }) => originX);
    const calmX = calm.strokes.filter(({ color }) => color === '#482d34').map(({ originX }) => originX);

    advance(310);
    for (const recording of [normal, calm]) {
      recording.fills.length = 0;
      recording.strokes.length = 0;
      recording.renderer.render({ ...state, tick: 59, motionTick: 59 }, meta);
    }
    assert.ok(normal.strokes.filter(({ color }) => color === '#482d34')
      .some(({ originX }, index) => Math.abs(originX - normalX[index]) > .2),
    'normal motion sends the thin fragments outward');
    assert.deepEqual(calm.strokes.filter(({ color }) => color === '#482d34')
      .map(({ originX }) => originX), calmX,
    'reduced motion keeps the bone pile fixed without camera shake');

    const edge = recordingRenderer(true);
    const edgeState = scrollingState(170, { corpses: [], motionTick: 40 });
    edge.renderer.render(edgeState, meta);
    edge.renderer.effect({ ...event, id: 'edge-bones', target: 'edge-boss', x: 22 });
    edge.fills.length = 0;
    edge.renderer.render({ ...edgeState, tick: 41, motionTick: 41 }, meta);
    assert.ok(bossHead(edge)?.originX > 22 && bossHead(edge)?.originX < 220,
      'a boss at the left world edge breaks toward the arena, not out of view');

    const farEdge = recordingRenderer(true);
    const farState = scrollingState(1750, { corpses: [], motionTick: 40 });
    farEdge.renderer.render(farState, meta);
    farEdge.renderer.effect({ ...event, id: 'far-edge-bones', target: 'far-boss',
      x: 1898, facing: -1 });
    farEdge.fills.length = 0;
    farEdge.renderer.render({ ...farState, tick: 41, motionTick: 41 }, meta);
    assert.ok(bossHead(farEdge)?.originX > 700 && bossHead(farEdge)?.originX < 960,
      'a boss at the right world edge also breaks inward under the camera');
  });
});

test('PvP ignores campaign corpse and bones fields but retains its KO tomato and defeated fighter', () => {
  withClock(() => {
    const recording = recordingRenderer();
    const { renderer, fills, strokes } = recording;
    const hero = { ...fighter('hero', 0, 0), id: 'p1', team: 0, x: 350, height: 88 };
    const enemy = { ...fighter('grunt', 0, 0), id: 'p2', team: 1, x: 600, height: 88 };
    const meta = { mode: 'duel', theme: 'city' };
    const state = { tick: 39, arena: { theme: 'city', groundY: 430, width: 960 },
      fighters: [hero, enemy] };
    renderer.render(state, meta);
    renderer.effect({ id: '40:duel-ko', type: 'ko', target: 'p2',
      x: 600, y: 430 - enemy.height * .45 });
    renderer.effect({ id: '40:untrusted-bones', type: 'bones-scatter', target: 'p2',
      x: 600, y: 430, kind: 'grunt', facing: 1 });
    fills.length = 0;
    strokes.length = 0;
    renderer.render({ ...state, tick: 40, motionTick: 40,
      fighters: [hero, { ...enemy, hp: 0 }], corpses: [corpseRecord('p2')] }, meta);
    assert.ok(fills.some(({ color }) => color === '#702d2a'), 'the duel still drops its tomato');
    assert.equal(fills.filter(({ color, points }) => color === '#663f41'
      && points.some((point) => point.kind === 'arc' && point.radius === 22)).length, 1,
    'the loser remains a whole stick fighter in PvP');
    assert.ok(!strokes.some(({ color, width }) => color === '#663f41'
      && Math.abs(width - 6.2) < 1e-9), 'campaign bones never appear in PvP');
  });
});

test('leaper and slinger stay thin, distinct and mirrored in both motion settings', () => {
  for (const reducedMotion of [false, true]) {
    for (const facing of [-1, 1]) {
      const leaper = { ...fighter('leaper', 0, 0, facing), id: 'leaper', team: 1,
        y: 340, grounded: false, vy: -4 };
      const agile = renderFighters([leaper], { reducedMotion });
      assert.ok(agile.fills.some(({ color, points }) => color === '#29423d'
        && points.some((point) => point.kind === 'arc' && point.radius === 22)),
      'the mobile fighter keeps an oversized head and thin stick body');
      assert.equal(agile.strokes.filter(({ color, width, scaleX }) => color === '#a5e6bd'
        && width === 2 && scaleX === facing).length, 2,
      'split shin wraps identify the jumper from either direction');
      assert.equal(agile.strokes.some(({ color }) => color === '#d8f8de'), !reducedMotion,
        'only normal motion adds the short airborne foot accent');

      const slinger = { ...fighter('slinger', 0, 0, facing), id: 'slinger', team: 1 };
      const ranged = renderFighters([slinger], { reducedMotion });
      assert.ok(ranged.fills.some(({ color }) => color === '#51433e'),
        'the stone carrier has a dark satchel without widening its torso');
      assert.ok(ranged.fills.some(({ color }) => color === '#3d4c4e'),
        'the raised hand visibly holds a stone before a cast');
      assert.ok(ranged.strokes.some(({ color, width, scaleX }) => color === '#e7b578'
        && width === 2.5 && scaleX === facing), 'the headband mirrors with its facing');
    }
  }
});

test('slinger arc and both stone sizes use the 1920px campaign camera across four themes', () => {
  for (const theme of ['forest', 'city', 'ocean', 'land']) {
    for (const reducedMotion of [false, true]) {
      const recording = recordingRenderer(reducedMotion);
      const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 1450, height: 88 };
      const origin = { x: 1489, y: 374.56 };
      const target = { x: 1360, y: 380 };
      const flight = spearFlight(origin.x, origin.y, target.x, target.y);
      const slinger = { ...fighter('slinger', 0, 0, -1), id: 'slinger', team: 1,
        x: 1510, height: 88, bossCast: { type: 'rock', ticks: 12, totalTicks: 22,
          originX: origin.x, originY: origin.y, targetX: target.x, targetY: target.y,
          vx: flight.vx, vy: flight.vy, radius: 8 } };
      recording.renderer.render(scrollingState(1450, { fighters: [hero, slinger],
        arena: { theme, width: 1920, groundY: 430, platforms: [], hazards: [] },
        projectiles: [
          { id: 'small', kind: 'rock', x: 1500, y: 320, vx: -10, vy: 3, radius: 8 },
          { id: 'heavy', kind: 'rock', x: 1520, y: 325, vx: -8, vy: 4, radius: 14 },
        ] }), { mode: 'campaign', theme, level: 0 });
      const arc = recording.strokes.find(({ color, points }) => color === '#d4e9c8'
        && points.length >= 11 && points.every(Array.isArray));
      assert.ok(arc, `${theme} keeps the stone warning visible over its backdrop`);
      assert.equal(arc.originX, -960);
      assert.deepEqual(arc.points[0], [origin.x, origin.y]);
      assert.ok(Math.abs(arc.points.at(-1)[0] - target.x) < .001);
      assert.ok(Math.abs(arc.points.at(-1)[1] - target.y) < .001,
        'the visual arc uses the same discrete gravity and locked aim as the projectile');
      assert.ok(recording.strokes.some(({ color, points }) => color === '#d4e9c8'
        && points.some((point) => point.kind === 'arc' && point.x === target.x)),
      'the target has a readable reticle over photo and painted backdrops');
      assert.ok(recording.fills.some(({ color, originX }) => color === '#3d4c4e'
        && originX === 540));
      assert.ok(recording.fills.some(({ color, originX }) => color === '#a2ada4'
        && originX === 540), 'the smaller stone remains visible in the same camera frame');
      assert.equal(recording.fills.find(({ color, originX }) => color === '#4a3c36'
        && originX === 560)?.originX, 560,
      'the large Boss stone remains separate and camera-aligned');
      assert.equal(recording.strokes.some(({ color }) => color === '#e4c19c'), !reducedMotion,
        'reduced motion removes the flight streak but preserves warning and stone');
    }
  }
});

test('second Boss stone warns at its second locked target and warning freezes in hitstop', () => {
  withClock((advance) => {
    const recording = recordingRenderer();
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 1450, height: 88 };
    const origin = { x: 1541, y: 339 };
    const secondX = 1610;
    const flight = spearFlight(origin.x, origin.y, secondX, 355);
    const boss = { ...fighter('boss', 0, 0), id: 'boss', team: 1,
      x: 1510, height: 136, width: 44, bossTier: 4,
      bossCast: { type: 'volley', stage: 1, ticks: 8, totalTicks: 12,
        originX: origin.x, originY: origin.y, targetX: 1360, secondTargetX: secondX,
        targetY: 355, vx: flight.vx, vy: flight.vy } };
    const state = scrollingState(1450, { fighters: [hero, boss], motionTick: 39 });
    const meta = { mode: 'campaign', theme: 'land', level: 40 };
    recording.renderer.render({ ...state, tick: 39 }, meta);
    const warning = () => recording.strokes.find(({ color, points }) => color === '#ffe1aa'
      && points.length === 21 && points.every(Array.isArray));
    const before = warning();
    assert.ok(before);
    assert.equal(before.originX, -960);
    assert.ok(Math.abs(before.points.at(-1)[0] - secondX) < .001);
    assert.ok(Math.abs(before.points.at(-1)[1] - 355) < .001);
    assert.ok(recording.strokes.some(({ color, points }) => color === '#ffe1aa'
      && points.some((point) => point.kind === 'arc' && point.x === secondX)),
    'the reticle moves with the second volley, not the first stone');
    advance(400);
    recording.strokes.length = 0;
    recording.renderer.render({ ...state, tick: 40 }, meta);
    assert.deepEqual(warning()?.points, before.points,
      'hitstop leaves the fixed-frame telegraph at the same simulated pose');
  });
});

test('summon, ground quake and ward show bounded warnings and a persistent Boss shell', () => {
  for (const reducedMotion of [false, true]) {
    const recording = recordingRenderer(reducedMotion);
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0, x: 1450, height: 88 };
    const boss = { ...fighter('boss', 0, 0), id: 'boss', team: 1,
      x: 1510, height: 136, width: 44, bossTier: 5, wardTicks: 58 };
    const meta = { mode: 'campaign', theme: 'ocean', level: 50 };
    const renderCast = (type, fields = {}) => {
      recording.strokes.length = 0;
      recording.renderer.render(scrollingState(1450, { fighters: [hero, { ...boss,
        bossCast: { type, ticks: 10, totalTicks: 30, ...fields } }] }), meta);
      return recording.strokes;
    };
    const summon = renderCast('summon', { count: 3 });
    assert.ok(summon.some(({ color, points }) => color === '#c6f4dd'
      && points.some((point) => point.kind === 'ellipse' && point.x === boss.x)),
    'summoning announces itself around the Boss feet');
    assert.equal(summon.filter(({ color }) => color === '#eaffed').length, 3,
      'its pre-cast marks communicate the capped batch size');
    const quake = renderCast('quake', { range: 150 });
    const strips = quake.filter(({ color, points }) => color === '#ffc29b'
      && points.length === 7 && points.every(Array.isArray));
    assert.equal(strips.length, 2, 'shock range warns on both sides of the Boss');
    assert.deepEqual(strips.map((strip) => strip.points.at(-1)[0]).sort((a, b) => a - b),
      [boss.x - 150, boss.x + 150]);
    const ward = renderCast('ward');
    assert.ok(ward.some(({ color, points }) => color === '#ccefcf'
      && points.some((point) => point.kind === 'ellipse' && point.y === boss.y - 71)),
    'the ward tells the player what is about to activate');
    assert.ok(ward.some(({ color, points }) => color === '#c7f2d4'
      && points.some((point) => point.kind === 'ellipse' && point.y === -55)),
    'an active ward continues to outline the Boss without hiding its face');
  }
});

test('Boss effects use actual world positions, deduplicate replays and clear on stage change', () => {
  withClock(() => {
    const recording = recordingRenderer(true);
    const events = [
      { id: 'rock', type: 'rock-impact', x: 1510, y: 320, radius: 14, tier: 4,
        surface: 'ground' },
      { id: 'spawn-a', type: 'boss-summon', x: 1350, y: 430, kind: 'leaper' },
      { id: 'spawn-b', type: 'boss-summon', x: 1650, y: 430, kind: 'slinger' },
      { id: 'quake', type: 'boss-quake', x: 1500, y: 430, range: 155 },
      { id: 'ward', type: 'boss-ward', x: 1550, y: 430 },
      { id: 'ward-absorb', type: 'boss-ward-hit', x: 1540, y: 340, absorbed: 10 },
    ];
    for (const event of events) {
      recording.renderer.effect(event); // A snapshot may precede the first wide-world frame.
      recording.renderer.effect({ ...event });
    }
    const meta = { mode: 'campaign', theme: 'land', level: 50 };
    const state = scrollingState(1450);
    recording.renderer.render(state, meta);
    const ringAt = (color, x) => recording.strokes.filter(({ color: ink, points }) => ink === color
      && points.some((point) => point.kind === 'arc' && point.x === x));
    assert.equal(ringAt('#ffe1aa', 1510).length, 1,
      'one actual stone impact survives a pre-frame event and replay at world x=1510');
    assert.equal(ringAt('#ffe1aa', 1510)[0].originX, -960);
    assert.deepEqual(recording.strokes.filter(({ color, points }) => color === '#d8fff0'
      && points.some((point) => point.kind === 'ellipse')).map(({ points }) =>
      points.find((point) => point.kind === 'ellipse').x).sort((a, b) => a - b),
    [1350, 1650], 'each minion uses its own actual spawn position');
    const quake = recording.strokes.filter(({ color, points }) => color === '#ffe0b9'
      && points.length === 6 && points.every(Array.isArray));
    assert.deepEqual(quake.map(({ points }) => points.at(-1)[0]).sort((a, b) => a - b),
      [1345, 1655], 'ground shock stops at its two real range endpoints');
    assert.equal(ringAt('#e4f8dd', 1550).length, 1);
    assert.equal(ringAt('#e4f8dd', 1550)[0].points.find((point) => point.kind === 'arc').y,
      360, 'the ward release belongs around the body, not on the Boss feet');
    assert.equal(ringAt('#e4f8dd', 1540).length, 1);
    assert.equal(ringAt('#e4f8dd', 1540)[0].points.find((point) => point.kind === 'arc').y,
      340, 'the absorbed blow is confirmed at its true impact point');
    assert.equal(recording.strokes.filter(({ color }) => color === '#b99477').length, 2,
      'low motion uses only a small pair of stone-ground skid lines');

    recording.strokes.length = 0;
    recording.renderer.render({ ...state, tick: 0 }, { ...meta, level: 51 });
    assert.equal(ringAt('#ffe1aa', 1510).length, 0);
    assert.equal(ringAt('#e4f8dd', 1550).length, 0,
      'retry and stage transitions clear the previous Boss effects');
  });
});

test('rock and quake damage never draw punch ink, and campaign casts never leak into PvP', () => {
  const recording = recordingRenderer(true);
  const boss = { ...fighter('boss', 0, 0), id: 'boss', team: 1,
    x: 600, height: 136, width: 44,
    bossCast: { type: 'quake', ticks: 8, totalTicks: 30, range: 150 } };
  const state = { tick: 39,
    arena: { theme: 'city', width: 960, groundY: 430, platforms: [], hazards: [] },
    fighters: [boss], projectiles: [{ kind: 'rock', x: 560, y: 350, radius: 14 }] };
  recording.renderer.render(state, { mode: 'campaign', theme: 'city', level: 30 });
  for (const delivery of ['rock', 'quake']) recording.renderer.effect({ id: delivery,
    type: 'hit', source: 'boss', target: 'hero', x: 480, y: 350,
    delivery, damage: 19, heavy: true });
  recording.strokes.length = 0;
  recording.renderer.render({ ...state, tick: 40 }, { mode: 'campaign', theme: 'city', level: 30 });
  assert.equal(recording.strokes.filter(({ color }) => color === '#fff9e9').length, 0,
    'ranged/ground hits keep their damage cue without a misleading close-contact fist mark');
  assert.ok(recording.strokes.some(({ color }) => color === '#fff4ca'));
  recording.fills.length = 0;
  recording.strokes.length = 0;
  recording.renderer.render({ ...state, tick: 0 }, { mode: 'duel', theme: 'city' });
  assert.ok(!recording.fills.some(({ color }) => color === '#4a3c36'),
    'a copied campaign stone snapshot is ignored in multiplayer');
  assert.ok(!recording.strokes.some(({ color }) => color === '#ffc29b'),
    'Boss-only telegraphs never enter a multiplayer match');
});

test('Boss equipment rests above its actual world surface behind the campaign camera', () => {
  const equipment = equipmentForBoss(42);
  const drop = { id: 'boss-42:loot', equipmentId: equipment.id,
    x: 1510, y: 322, spawnedTick: 40 };
  const recording = recordingRenderer(true);
  const state = scrollingState(1370, { equipmentDrops: [drop],
    arena: { theme: 'land', width: 1920, groundY: 430,
      platforms: [{ x: 1460, y: 322, w: 120, h: 12 }], hazards: [] } });
  recording.renderer.render(state, { mode: 'campaign', theme: 'land', level: 43 });
  const crest = recording.fills.find(({ color }) => color === equipment.color);
  assert.ok(crest, 'the ground item carries its own tier colour, not a hazard warning');
  assert.equal(crest.originX, 620, 'world x=1510 follows the same 890px camera as the hero');
  assert.equal(crest.originY, 304, 'the emblem floats 18px above its platform top');
  assert.ok(crest.order < heroHead(recording.fills).order,
    'the drop sits behind the fighter rather than covering their face and attack');
  assert.equal(recording.strokes.filter(({ color, width }) => color === equipment.color
    && width === 1.7).length, equipment.tier, 'small pips distinguish equipment tiers');
  assert.deepEqual(drop, { id: 'boss-42:loot', equipmentId: equipment.id,
    x: 1510, y: 322, spawnedTick: 40 }, 'rendering never moves the saved drop');
});

test('sweep, pierce and pulse equipment have fixed-frame windup and mirrored active poses', () => {
  const meta = { mode: 'campaign', theme: 'land', level: 50 };
  for (const bossLevel of [10, 14, 42]) {
    const equipment = equipmentForBoss(bossLevel);
    const hero = { ...fighter('hero', 0, 0), id: 'hero', team: 0,
      x: 1370, equipmentAttackId: equipment.id };
    const stateAt = (tick, facing = 1) => scrollingState(1370, {
      fighters: [{ ...hero, facing, equipmentTick: tick }],
    });
    const weaponStrokes = (strokes) => strokes.filter(({ color, originX }) =>
      color === equipment.color && originX === 480);
    const farthestPoint = (strokes) => Math.max(...weaponStrokes(strokes)
      .flatMap(({ points }) => points.filter(Array.isArray).map(([x]) => x)));
    const recording = recordingRenderer();
    recording.renderer.render(stateAt(equipment.activeFrom - 1), meta);
    const windupEnd = farthestPoint(recording.strokes);
    recording.strokes.length = 0;
    recording.renderer.render({ ...stateAt(equipment.activeFrom), tick: 41 }, meta);
    assert.ok(farthestPoint(recording.strokes) > windupEnd + 10,
      `${equipment.name} visibly extends its held weapon on the first active frame`);
    assert.ok(weaponStrokes(recording.strokes).every(({ scaleX }) => scaleX === 1),
      'the attack is anchored to the hero rather than travelling across the arena');
    const calm = recordingRenderer(true);
    calm.renderer.render(stateAt(equipment.activeFrom), meta);
    assert.ok(weaponStrokes(calm.strokes).length > 0,
      `${equipment.name} remains legible under reduced motion`);
    assert.ok(weaponStrokes(recording.strokes).length > weaponStrokes(calm.strokes).length,
      'low-motion mode removes the flourish, not the weapon silhouette');
    const mirrored = recordingRenderer(true);
    mirrored.renderer.render(stateAt(equipment.activeFrom, -1), meta);
    assert.ok(weaponStrokes(mirrored.strokes).some(({ scaleX }) => scaleX === -1),
      `${equipment.name} follows the hero's actual left-facing pose`);
    const resting = recordingRenderer(true);
    resting.renderer.render(stateAt(0), meta);
    assert.equal(weaponStrokes(resting.strokes).length, 0,
      'no attack weapon is falsely shown when the equipment skill is idle');
  }
});

test('every weapon visibly reaches a Boss at the farthest legal contact edge', () => {
  function paintedForwardEdge(recording, equipment, facing) {
    // The weapon is painted in fighter-local coordinates; mirrored paths keep
    // their positive forward x while the canvas transform flips their side.
    const paint = [...recording.strokes, ...recording.fills].filter(({ color, originX, scaleX }) =>
      originX === 480 && scaleX === facing
      && (color === equipment.color || color === '#f7f6df'));
    return Math.max(...paint.flatMap(({ points }) => points.flatMap((point) => {
      if (Array.isArray(point)) return [point[0]];
      if (point.kind === 'bezier') return [point.cx1, point.cx2, point.x];
      if (point.kind === 'arc') return [point.x + point.radius];
      if (point.kind === 'ellipse') return [point.x + point.rx];
      return [];
    })));
  }

  for (const equipment of BOSS_EQUIPMENT) {
    for (const facing of [-1, 1]) {
      for (const reducedMotion of [false, true]) {
        const hero = createFighter({ id: 'hero', x: 1370, y: 430, team: 0, kind: 'hero' });
        hero.facing = facing;
        const boss = createFighter({ id: 'far-boss', x: 1370, y: 430,
          team: 1, kind: 'boss' });
        boss.x += facing * (equipment.reach + boss.width * .45 - .25);
        boss.stun = 1000;
        const state = createCombatState({ mode: 'campaign',
          arena: { theme: 'land', width: 1920, groundY: 430 }, fighters: [hero, boss] });
        state.equippedEquipmentId = equipment.id;
        for (let tick = 0; tick < equipment.activeFrom; tick++) {
          stepCombat(state, { hero: { equipment: tick === 0 } });
        }
        const hit = state.events.find((event) => event.type === 'hit'
          && event.delivery === 'equipment' && event.target === boss.id);
        assert.equal(hit?.damage, equipment.damage,
          `${equipment.name} actually hits the outer edge facing ${facing}`);
        const recording = recordingRenderer(reducedMotion);
        recording.renderer.render(state, { mode: 'campaign', theme: 'land',
          level: equipment.bossLevel });
        const visibleEdge = paintedForwardEdge(recording, equipment, facing);
        const bossNearEdge = Math.abs(boss.x - hero.x) - boss.width / 2;
        assert.ok(visibleEdge >= bossNearEdge - 2,
          `${equipment.name} must touch the outer Boss silhouette, not deal invisible damage`);
        assert.ok(visibleEdge <= equipment.reach + 8,
          `${equipment.name} must not suggest a longer projectile-like attack`);
      }
    }
  }
});

test('pickup makes one short world-space ring, stays calm in reduced motion and clears on the next scene', () => {
  withClock((advance) => {
    const equipment = equipmentForBoss(30);
    const meta = { mode: 'campaign', theme: 'land', level: 43, sceneToken: 1 };
    const state = scrollingState(1370);
    const event = { id: 'pickup:30', type: 'equipment-pickup', equipmentId: equipment.id,
      source: 'hero', x: 1510, y: 430 };
    const normal = recordingRenderer();
    const calm = recordingRenderer(true);
    for (const recording of [normal, calm]) {
      recording.renderer.effect(event); // An event can precede its first wide-world frame.
      recording.renderer.effect({ ...event });
      recording.renderer.render(state, meta);
    }
    const rings = (recording) => recording.strokes.filter(({ color, points }) =>
      color === equipment.color && points.some((point) => point.kind === 'arc'
        && point.x === 1510 && point.y === 412));
    assert.equal(rings(normal).length, 1, 'replayed pickup is not painted twice');
    assert.equal(rings(normal)[0].originX + 1510, 620,
      'the pickup ring shares the drop camera transform');
    const radius = (recording) => rings(recording)[0].points.find((point) => point.kind === 'arc').radius;
    const firstNormal = radius(normal);
    const firstCalm = radius(calm);
    advance(90);
    for (const recording of [normal, calm]) {
      recording.strokes.length = 0;
      recording.renderer.render({ ...state, tick: 41 }, meta);
    }
    assert.ok(radius(normal) > firstNormal, 'regular pickup has one brief expanding confirmation');
    assert.equal(radius(calm), firstCalm, 'low-motion pickup fades at a fixed radius');
    normal.strokes.length = 0;
    normal.renderer.render({ ...state, tick: 42 }, { ...meta, sceneToken: 2 });
    assert.equal(rings(normal).length, 0, 'a new attempt cannot inherit an old pickup ring');
  });
});

test('equipment hits use confirmed contact only without fist brush or screen shake', () => {
  withClock(() => {
    const equipment = equipmentForBoss(20);
    const recording = recordingRenderer();
    const meta = { mode: 'campaign', theme: 'land', level: 43 };
    const state = scrollingState(1370, { tick: 39 });
    recording.renderer.render(state, meta);
    recording.renderer.effect({ id: 'equip-hit', type: 'hit', delivery: 'equipment',
      equipmentId: equipment.id, source: 'hero', target: 'enemy',
      x: 1510, y: 350, damage: equipment.damage, heavy: true });
    recording.strokes.length = 0;
    recording.fills.length = 0;
    recording.renderer.render({ ...state, tick: 40 }, meta);
    assert.equal(recording.strokes.filter(({ color }) => color === '#fff9e9').length, 0,
      'weapon contact never paints the close-range fist brush');
    const hitRing = recording.strokes.filter(({ color, points }) => color === equipment.color
      && points.some((point) => point.kind === 'arc' && point.x === 1510));
    assert.equal(hitRing.length, 1, 'one restrained cue marks the authoritative target');
    assert.equal(hitRing[0].originX + 1510, 620, 'the confirmed hit stays at its world position');
    assert.equal(heroHead(recording.fills).originX, 480,
      'equipment damage adds no screen shake or displacement');
  });
});

test('copied equipment drops, poses and pickup events never enter a PvP scene', () => {
  const equipment = equipmentForBoss(50);
  const state = scrollingState(520, {
    arena: { theme: 'land', width: 960, groundY: 430, platforms: [], hazards: [] },
    fighters: [{ ...fighter('hero', 0, 0), id: 'p1', team: 0, x: 520,
      equipmentAttackId: equipment.id, equipmentTick: equipment.activeFrom }],
    equipmentDrops: [{ id: 'spoof-drop', equipmentId: equipment.id,
      x: 560, y: 430, spawnedTick: 40 }],
  });
  const recording = recordingRenderer(true);
  const meta = { mode: 'duel', theme: 'land' };
  recording.renderer.effect({ id: 'early-duel-pickup', type: 'equipment-pickup',
    equipmentId: equipment.id, x: 560, y: 430 });
  recording.renderer.render(state, meta);
  recording.renderer.effect({ id: 'duel-equip-hit', type: 'hit', delivery: 'equipment',
    equipmentId: equipment.id, x: 560, y: 350 });
  recording.strokes.length = 0;
  recording.fills.length = 0;
  recording.renderer.render({ ...state, tick: 41 }, meta);
  assert.equal(recording.fills.filter(({ color }) => color === equipment.color).length, 0);
  assert.equal(recording.strokes.filter(({ color }) => color === equipment.color).length, 0,
    'PvP retains its existing plain hero even if a copied state/event has campaign-only fields');
});

function wideDuelState(p1X = 260, p2X = 2580, extras = {}) {
  return { tick: 40, motionTick: 40, status: 'playing',
    arena: { theme: 'city', width: 2880, groundY: 430, platforms: [], hazards: [] },
    fighters: [
      { ...fighter('hero', 0, 0, 1), id: 'p1', team: 0, x: p1X,
        width: 29, height: 88 },
      { ...fighter('hero', 0, 0, -1), id: 'p2', team: 1, x: p2X,
        width: 29, height: 88 },
    ], ...extras };
}

test('each wide-duel client follows its own fighter and shows an offscreen opponent without sharing photos', () => {
  const portrait = { complete: true, naturalWidth: 256, naturalHeight: 256 };
  const state = wideDuelState();
  const headXs = (recording) => recording.fills.filter(({ color, points }) =>
    color === SHADOW_WANDERER.head && points.some((point) => point.kind === 'arc'
      && point.radius === 22)).map(({ originX }) => originX);
  const p1View = recordingRenderer(true);
  p1View.renderer.setAvatar(portrait);
  p1View.renderer.render(state, { mode: 'duel', localFighterId: 'p1' });
  assert.deepEqual(headXs(p1View), [260, 2580]);
  assert.equal(p1View.images.length, 1);
  assert.equal(p1View.images[0].image, portrait);
  assert.ok(p1View.labels.some(({ value, originX }) => value === '对手 距离 2320'
    && originX === 0), 'P1 is told the opponent is to the right on the fixed screen layer');
  assert.ok(p1View.fills.some(({ color, originX }) => color === '#7be8f1' && originX === 0),
    'the right-edge direction arrow uses P2 colour');

  const p2View = recordingRenderer(true);
  p2View.renderer.setAvatar(portrait);
  p2View.renderer.render(state, { mode: 'duel', localFighterId: 'p2' });
  assert.deepEqual(headXs(p2View), [-1660, 660], 'P2 sees its own camera clamped to the far arena edge');
  assert.equal(p2View.images.length, 1);
  assert.equal(p2View.images[0].image, portrait);
  assert.ok(p2View.images[0].originX > 0 && p2View.images[0].originX < 960,
    'the only painted photo belongs to P2, not the distant P1');
  assert.ok(p2View.labels.some(({ value, originX }) => value === '对手 距离 2320'
    && originX === 0), 'P2 independently sees a leftward distance cue');
  assert.ok(p2View.fills.some(({ color, originX }) => color === '#ff555a' && originX === 0));

  const anonymous = recordingRenderer(true);
  anonymous.renderer.setAvatar(portrait);
  anonymous.renderer.render(state, { mode: 'duel' });
  assert.equal(anonymous.images.length, 0, 'without an explicit local identity no remote fighter inherits the photo');
  assert.ok(!anonymous.labels.some(({ value }) => String(value).startsWith('对手 距离')));
  p2View.labels.length = 0;
  p2View.renderer.render(wideDuelState(2110, 2580, { tick: 41 }),
    { mode: 'duel', localFighterId: 'p2' });
  assert.ok(!p2View.labels.some(({ value }) => String(value).startsWith('对手 距离')),
    'the cue disappears once the opponent is actually inside this viewport');
});

test('the third 960px illustrated panel stays continuous in all four duel themes and never requests photos', () => {
  for (const theme of ['forest', 'city', 'ocean', 'land']) {
    const recording = recordingRenderer(true);
    const state = wideDuelState(2400, 2580);
    recording.renderer.render({ ...state, arena: { ...state.arena, theme } },
      { mode: 'duel', theme, level: 1, localFighterId: 'p1' });
    const ground = recording.rects.filter(({ y, w, h }) => y === 430 && w === 960 && h === 110);
    assert.deepEqual(ground.map(({ originX, scaleX }) => [originX, scaleX]),
      [[-1920, 1], [0, -1], [0, 1]], `${theme} has a continuous, mirrored middle seam and a third ground panel`);
    assert.ok(recording.rects.some(({ y, w, h, originX, scaleX }) =>
      y === 0 && w === 960 && h === 540 && originX === 0 && scaleX === 1),
    `${theme} sky fills the visible third segment`);
    assert.equal(recording.images.length, 0, 'PvP does not load a campaign photo even with a level hint');
  }
});

test('the far-side rotating plank, moving tread and timed damaging trap use authoritative world poses', () => {
  const rotating = { x: 2090, y: 310, w: 168, h: 12, type: 'log', motion: 'rotate',
    baseX: 2174, baseY: 310, baseAngle: 0, amplitude: .19, period: 96 };
  const moving = { x: 2310, y: 337, w: 120, h: 12, motion: 'float', axis: 'x',
    baseX: 2310, baseY: 337, amplitude: 22, period: 120 };
  const trap = { x: 2060, y: 410, w: 90, h: 20, type: 'electric',
    period: 120, activeTicks: 60, phase: 0, damage: 9 };
  const state = wideDuelState(260, 2400, { tick: 106, motionTick: 24 });
  state.arena.platforms = [rotating, moving];
  state.arena.hazards = [trap];
  const recording = recordingRenderer(true);
  const meta = { mode: 'duel', localFighterId: 'p2' };
  recording.renderer.render(state, meta);
  const pose = platformPose(rotating, 24);
  assert.ok(recording.rotations.some(({ angle, originX, originY }) =>
    Math.abs(angle - pose.angle) < 1e-9 && originX === pose.centerX - 1920
      && originY === pose.centerY), 'the visible wooden rotation equals the shared collision pose');
  assert.ok(recording.rects.some(({ color, w, x }) =>
    color === '#c99866' && w === pose.width && x === -pose.width / 2),
  'the wooden walkable edge remains the platform top');
  assert.ok(recording.rects.some(({ color, originX, w }) =>
    color === '#b5b8ad' && originX === platformPose(moving, 24).centerX - 1920
      && w === moving.w), 'the floating tread occupies its simulated far-panel location');
  assert.ok(recording.labels.some(({ value, originX }) => value === '机关即将启动'
    && originX === -1920), 'a periodic PvP trap warns while still inactive');
  recording.labels.length = 0;
  recording.strokes.length = 0;
  recording.renderer.render({ ...state, tick: 120 }, meta);
  assert.ok(!recording.labels.some(({ value }) => value === '机关即将启动'),
    'the inactive countdown cannot obscure the now-active trap');
  assert.ok(recording.strokes.some(({ color }) => color === '#e9db86'),
    'the live electric hitbox has its existing visibly active markings');
  recording.renderer.effect({ id: 'duel-trap-hit', type: 'hit', source: 'hazard:electric',
    target: 'p2', x: 2400, y: 350, damage: 9 });
  recording.labels.length = 0;
  recording.strokes.length = 0;
  recording.renderer.render({ ...state, tick: 121 }, meta);
  assert.ok(recording.labels.some(({ value, originX }) => value === '机关 -9'
    && originX === -1920), 'only confirmed trap damage receives a short numeric hit cue');
  assert.ok(!recording.strokes.some(({ color }) => color === '#fff9e9'),
    'trap damage cannot masquerade as a close-range fist hit');
});

test('both duelists render their own manual spear arc, committed direction and projectile across the third panel', () => {
  const recording = recordingRenderer(true);
  const state = wideDuelState(170, 2420);
  state.fighters[1] = { ...state.fighters[1], spearAiming: true, spearAimAngle: 8 };
  state.projectiles = [{ id: 'p2-spear', kind: 'spear', team: 1,
    x: 2400, y: 330, vx: -25, vy: -5 }];
  const meta = { mode: 'duel', localFighterId: 'p2' };
  recording.renderer.render(state, meta);
  const origin = spearOrigin(state.fighters[1]);
  const arc = recording.strokes.find(({ color, points }) => color === '#a8eaf8'
    && points.length > 10 && points[0]?.[0] === origin.x);
  assert.ok(arc, 'P2 can aim a real player-selected arc rather than an AI locked target');
  assert.equal(arc.originX, -1920);
  assert.deepEqual(arc.points[1], Object.values(spearTrajectoryPoint(origin.x, origin.y,
    spearAimedFlight(-1, 8), 1)));
  assert.ok(recording.labels.some(({ value }) => value === '仰角 8°'));
  assert.ok(recording.strokes.some(({ color, originX }) => color === '#7bd6ed'
    && originX === 480), 'P2 cool-coloured spear shaft follows the same third-panel camera');

  recording.strokes.length = 0;
  recording.labels.length = 0;
  const committed = { ...state.fighters[1], facing: -1, spearAiming: false,
    spearWindup: 10, spearLaunchFacing: 1, spearAimAngle: 42 };
  recording.renderer.render({ ...state, tick: 41, fighters: [state.fighters[0], committed] }, meta);
  const lockedOrigin = spearOrigin(committed, 1);
  const lockedArc = recording.strokes.find(({ color, points }) => color === '#a8eaf8'
    && points.length > 10 && points[0]?.[0] === lockedOrigin.x);
  assert.ok(lockedArc);
  assert.ok(lockedArc.points[1][0] > lockedOrigin.x,
    'the already committed P2 throw uses its launch-facing instead of later body facing');
  assert.ok(recording.labels.some(({ value }) => value === '锁定 42°'));
});

test('duel light wave stops at its real forward reach and confirms only actual hits, including low motion', () => {
  for (const reducedMotion of [false, true]) withClock((advance) => {
    const recording = recordingRenderer(reducedMotion);
    const state = wideDuelState(2600, 2200);
    const meta = { mode: 'duel', localFighterId: 'p2' };
    recording.renderer.effect({ id: `wave-${reducedMotion}`, type: 'duel-wave',
      source: 'p2', x: 2200, y: 350, facing: 1, reach: 800,
      halfHeight: 42, durationTicks: 14 });
    recording.renderer.effect({ id: `wave-hit-${reducedMotion}`, type: 'hit',
      delivery: 'duel-wave', source: 'p2', target: 'p1', x: 2600, y: 350,
      damage: 20, heavy: true });
    recording.renderer.render(state, meta);
    const core = recording.strokes.find(({ color, width, points }) => color === '#f6ffff'
      && width === (reducedMotion ? 6 : 10) && points.length === 2);
    assert.ok(core, 'the authoritative cast has a white-core forward ray on both motion settings');
    assert.ok(Math.abs(core.originX - (2200 + 39 - 1720)) < 8,
      'a pre-frame event retains its world-space origin, allowing only the confirmed-hit camera shake');
    assert.equal(core.points[1][0], 2880 - 2200 - 39,
      'the beam is clipped at the arena wall, not stretched to a campaign-wide echo');
    assert.ok(recording.strokes.some(({ color, originX }) => color === '#e4fff3'
      && Math.abs(originX - (2600 - 1720)) < 8),
    'a server-confirmed target gets one local impact cue');
    assert.ok(!recording.strokes.some(({ color }) => color === '#dffff8'),
      'a duel ray never claims the campaign wave hits opponents behind its arc');
    recording.strokes.length = 0;
    recording.renderer.effect({ id: `wave-${reducedMotion}`, type: 'duel-wave',
      source: 'p2', x: 2200, y: 350, facing: 1, reach: 800,
      halfHeight: 42, durationTicks: 14 });
    recording.renderer.render({ ...state, tick: 41 }, meta);
    assert.equal(recording.strokes.filter(({ color, width }) => color === '#f6ffff'
      && width === (reducedMotion ? 6 : 10)).length, 1,
    'replayed room events cannot pile up the same cast');
    advance(260);
    recording.strokes.length = 0;
    recording.renderer.render({ ...state, tick: 56 }, meta);
    assert.ok(!recording.strokes.some(({ color }) => color === '#f6ffff'),
      'the PvP beam does not linger beyond the actual short hit window');
  });
});

test('P1 left-facing ray mirrors from its own palm, and a ready cue does not imply a hit', () => {
  const recording = recordingRenderer(true);
  const state = wideDuelState(1400, 2500);
  const meta = { mode: 'duel', localFighterId: 'p1', sceneToken: 'room-1' };
  recording.renderer.effect({ id: 'ready-p1', type: 'duel-wave-ready',
    source: 'p1', x: 1400, y: 350, charge: 1 });
  recording.renderer.effect({ id: 'left-wave', type: 'duel-wave', source: 'p1',
    x: 1400, y: 350, facing: -1, reach: 800, halfHeight: 42, durationTicks: 14 });
  recording.renderer.render(state, meta);
  const beam = recording.strokes.find(({ color, width, scaleX }) =>
    color === '#fffaf0' && width === 6 && scaleX === -1);
  assert.ok(beam, 'P1 casts the same bounded beam to the left');
  assert.equal(beam.originX, 1400 - 39 - 920);
  assert.equal(beam.points[1][0], 800 - 39);
  assert.ok(recording.strokes.some(({ color, originX, points }) => color === '#b8f7dd'
    && originX === -920 && points.some((point) => point.kind === 'arc'
      && point.x === 1400)), 'earning a charge has a short local ring');
  assert.ok(!recording.strokes.some(({ color }) => color === '#e4fff3'),
    'without an authoritative hit event the distant opponent gets no false hit marker');
  recording.strokes.length = 0;
  recording.renderer.render({ ...state, tick: 0 }, { ...meta, sceneToken: 'room-2' });
  assert.ok(!recording.strokes.some(({ color }) => color === '#fffaf0' || color === '#b8f7dd'),
    'a new round clears both the cast and the old readiness cue');
});

test('early spear-impact and KO events beyond x=1920 remain attached to the duel world after the first frame', () => {
  withClock(() => {
    const recording = recordingRenderer(true);
    recording.renderer.effect({ id: 'far-impact', type: 'spear-impact',
      x: 2530, y: 340, source: 'p2', target: 'p1', damage: 22 });
    recording.renderer.effect({ id: 'far-ko', type: 'ko', target: 'p1',
      kind: 'hero', x: 2530, y: 390, source: 'p2' });
    const state = wideDuelState(2530, 2310);
    state.fighters[0].hp = 0;
    recording.renderer.render(state, { mode: 'duel', localFighterId: 'p2' });
    assert.ok(recording.strokes.some(({ color, originX, points }) => color === '#fff4ce'
      && originX === -1830 && points.some((point) => point.kind === 'arc'
        && point.x === 2530)), 'the spear impact is not clamped to the old 960px map');
    assert.ok(recording.fills.some(({ color, originX }) => color === '#702d2a'
      && originX > 680 && originX < 760),
    'the fallen opponent and its tomato remain near the real far-side world x');

    const p2Ko = recordingRenderer(true);
    p2Ko.renderer.effect({ id: 'far-p2-ko', type: 'ko', target: 'p2',
      kind: 'hero', x: 2530, y: 390, source: 'p1' });
    const p2State = wideDuelState(2310, 2530);
    p2State.fighters[1].hp = 0;
    p2Ko.renderer.render(p2State, { mode: 'duel', localFighterId: 'p1' });
    assert.ok(p2Ko.fills.some(({ color, originX }) => color === '#287f98'
      && originX > 680 && originX < 760),
    'a first-frame P2 KO retains its own cool scarf rather than borrowing P1 red');
  });
});
