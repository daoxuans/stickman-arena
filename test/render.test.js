import test from 'node:test';
import assert from 'node:assert/strict';
import { attackOf } from '../shared/combat.js';
import { createRenderer } from '../public/render.js';

const ATTACK_WINDOWS = [
  { kind: 'hero', stage: 1, from: 5, to: 9 },
  { kind: 'hero', stage: 2, from: 6, to: 11 },
  { kind: 'hero', stage: 3, from: 8, to: 14 },
  { kind: 'boss', stage: 1, from: 13, to: 17 },
  { kind: 'boss', stage: 2, from: 14, to: 19 },
  { kind: 'boss', stage: 3, from: 16, to: 22 },
];

function recordingCanvas() {
  const fills = [];
  const strokes = [];
  const stack = [];
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
    beginPath() { path = []; },
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
        points: [...path], alpha: drawing.globalAlpha });
    },
    stroke() { strokes.push({ color: drawing.strokeStyle, width: drawing.lineWidth, scaleX: drawing.scaleX, points: [...path] }); },
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key in drawing) return drawing[key];
      return () => {};
    },
    set(_target, key, value) { drawing[key] = value; return true; },
  });
  const canvas = { width: 960, height: 540, getContext: () => context };
  return { canvas, fills, strokes };
}

function recordingRenderer(reducedMotion = false) {
  const recording = recordingCanvas();
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
  const heroHead = fills.find(({ color, points }) => color === '#173b3b'
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

test('the special wave expands from the player once and keeps a readable invulnerable aura', () => {
  const { renderer, strokes } = recordingRenderer();
  renderFrame(renderer, [], 39);
  strokes.length = 0;
  const wave = { id: '40:special-wave', type: 'special-wave', x: 310, y: 350, radius: 960 };
  renderer.effect(wave);
  renderFrame(renderer, [{ ...fighter('hero', 0, 0), specialWaveTicks: 25 }], 40);
  assert.equal(strokes.filter(({ color }) => color === '#dffff8').length, 1);
  assert.equal(strokes.filter(({ color }) => color === '#72e4df').length, 1);
  assert.ok(strokes.some(({ color }) => color === '#ddfff3'),
    'the hero is visibly shielded for the whole special window');
  strokes.length = 0;
  renderer.effect({ ...wave });
  renderFrame(renderer, [], 41);
  assert.equal(strokes.filter(({ color }) => color === '#dffff8').length, 1,
    'replayed snapshots cannot stack the same full-screen wave');

  const reduced = recordingRenderer(true);
  renderFrame(reduced.renderer, [], 39);
  reduced.renderer.effect({ ...wave, id: '40:low-motion-wave' });
  renderFrame(reduced.renderer, [], 40);
  assert.equal(reduced.strokes.filter(({ color }) => color === '#dffff8').length, 1,
    'reduced motion retains the cast confirmation with a static flash');
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
    assert.ok(streak.points[1][0] > streak.points[0][0], 'event streak points forward locally');
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
    assert.equal(singleCount, type === 'kick' ? 8 : 29, `${type} has one ring and its expected particles`);
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
  assert.equal(normal.strokes.filter(({ color }) => palette.includes(color)).length, 29);
  assert.equal(reduced.strokes.filter(({ color }) => palette.includes(color)).length, 6);
  assert.equal(normal.strokes.filter(({ color }) => color === '#a7f3e5' || color === '#f4e2ac').length, 2);
  assert.equal(reduced.strokes.filter(({ color }) => color === '#a7f3e5' || color === '#f4e2ac').length, 0);
});

test('the head is much wider than every slim body stroke', () => {
  const { fills, strokes } = renderFighters([{ ...fighter('hero', 0, 0), id: 'hero' }]);
  const head = fills.find(({ color, points }) => color === '#173b3b'
    && points.some((point) => point.kind === 'arc' && point.radius === 22));
  const torso = strokes.find(({ color, width }) => color === '#173b3b' && width === 7.8);
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
    // At the start of the drop, the red body is 131px above the head's crown.
    // The previous y=200 frame would put this tomato 130px too high.
    assert.ok(tomato.originY > 80 && tomato.originY < 110,
      `tomato follows the new foot y=330, actual origin ${tomato.originY}`);
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
