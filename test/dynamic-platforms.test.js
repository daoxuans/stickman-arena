import test from 'node:test';
import assert from 'node:assert/strict';
import { DUEL_WORLD_WIDTH, createCombatState, createDuelState, createFighter, stepCombat } from '../shared/combat.js';
import { platformPose, platformSurfaceY } from '../shared/platforms.js';

const arena = (platforms = []) => ({
  theme: 'forest', width: 1920, groundY: 438, platforms, hazards: [],
});

test('campaign movement reaches the second half while PvP uses its own 3x boundary', () => {
  const hero = createFighter({ id: 'hero', x: 1150, y: 438 });
  const campaign = createCombatState({ arena: arena(), fighters: [hero] });
  for (let tick = 0; tick < 170; tick++) stepCombat(campaign, { hero: { right: true } });
  assert.ok(hero.x > 1800 && hero.x <= 1901);
  assert.equal(campaign.arena.width, 1920);

  const duel = createDuelState();
  assert.equal(duel.arena.width, DUEL_WORLD_WIDTH);
  duel.fighters[0].x = DUEL_WORLD_WIDTH - 40;
  for (let tick = 0; tick < 30; tick++) stepCombat(duel, { p1: { right: true } });
  assert.equal(duel.fighters[0].x, DUEL_WORLD_WIDTH - 19);
});

test('contiguous 12px stair treads can be walked up and down without jumping', () => {
  const treads = [426, 414, 402, 414, 426].map((y, index) => ({
    x: 300 + index * 50, y, w: 50, h: 12, kind: 'stair', type: 'log',
  }));
  const hero = createFighter({ id: 'hero', x: 250, y: 438 });
  const state = createCombatState({ arena: arena(treads), fighters: [hero] });
  const visited = new Set();
  for (let tick = 0; tick < 92; tick++) {
    stepCombat(state, { hero: { right: true } });
    if (hero.x > 310 && hero.x < 335 && hero.grounded && hero.y === 426) visited.add(426);
    if (hero.x > 360 && hero.x < 385 && hero.grounded && hero.y === 414) visited.add(414);
    if (hero.x > 410 && hero.x < 435 && hero.grounded && hero.y === 402) visited.add(402);
  }
  assert.deepEqual([...visited].sort(), [402, 414, 426]);
  assert.ok(hero.x > 550);
  assert.equal(hero.y, 438);
});

test('a vertically floating platform carries a standing fighter in both directions', () => {
  const float = { x: 300, y: 350, w: 140, h: 12, type: 'log',
    motion: 'float', baseX: 300, baseY: 350, period: 120, amplitude: 18, phase: 0 };
  const hero = createFighter({ id: 'hero', x: 370, y: 350 });
  const state = createCombatState({ arena: arena([float]), fighters: [hero] });
  for (let tick = 1; tick <= 120; tick++) {
    stepCombat(state);
    assert.ok(Math.abs(hero.y - platformPose(float, state.tick).centerY) < 0.7,
      `tick ${tick}: feet ${hero.y} should stay on the visible plank`);
    assert.equal(hero.grounded, true);
  }
});

test('a horizontally drifting platform carries its rider both ways without moving the ground', () => {
  const float = { x: 300, y: 350, w: 140, h: 12, type: 'log',
    motion: 'float', axis: 'x', baseX: 300, baseY: 350,
    period: 120, amplitude: 24, phase: 0 };
  const hero = createFighter({ id: 'hero', x: 370, y: 350 });
  const grounded = createFighter({ id: 'grounded', x: 220, y: 438 });
  const state = createCombatState({ arena: arena([float]), fighters: [hero, grounded] });
  for (let tick = 1; tick <= 120; tick++) {
    stepCombat(state);
    const pose = platformPose(float, state.motionTick);
    assert.ok(Math.abs(hero.x - pose.centerX) < 0.01,
      `tick ${tick}: rider x ${hero.x} should follow wood center ${pose.centerX}`);
    assert.equal(hero.y, 350);
    assert.equal(hero.grounded, true);
    assert.equal(grounded.x, 220, 'a fighter on the ground is not dragged along');
  }
  assert.ok(Math.abs(hero.x - 370) < 0.01);
});

test('horizontal platform motion freezes during hitstop and replays the same positions after retry', () => {
  const float = { x: 300, y: 350, w: 140, h: 12, type: 'log',
    motion: 'float', axis: 'x', baseX: 300, baseY: 350,
    period: 160, amplitude: 28, phase: 17 };
  const create = () => createCombatState({ arena: arena([float]),
    fighters: [createFighter({ id: 'hero', x: platformPose(float, 0).centerX, y: 350 })] });
  const first = create();
  const retry = create();
  for (let tick = 0; tick < 60; tick++) {
    const input = { hero: { right: tick >= 15 && tick < 23 } };
    stepCombat(first, input);
    stepCombat(retry, input);
    assert.deepEqual([first.motionTick, first.fighters[0].x, first.fighters[0].y],
      [retry.motionTick, retry.fighters[0].x, retry.fighters[0].y]);
  }
  const pose = platformPose(float, first.motionTick);
  const x = first.fighters[0].x;
  first.hitstop = 4;
  for (let tick = 0; tick < 4; tick++) {
    stepCombat(first);
    assert.equal(first.motionTick, 60);
    assert.equal(first.fighters[0].x, x);
    assert.deepEqual(platformPose(float, first.motionTick), pose);
  }
});

test('a rotating plank presents the same sloped surface to physics and rendering', () => {
  const plank = { x: 410, y: 348, w: 160, h: 12, type: 'log',
    motion: 'rotate', baseX: 490, baseY: 348, baseAngle: 0,
    angle: 0, period: 120, amplitude: 0.16, phase: 0 };
  const hero = createFighter({ id: 'hero', x: 450, y: 348 });
  const state = createCombatState({ arena: arena([plank]), fighters: [hero] });
  for (let tick = 1; tick <= 120; tick++) {
    stepCombat(state);
    const surface = platformSurfaceY(platformPose(plank, state.tick), hero.x);
    assert.ok(Math.abs(hero.y - surface) < 0.7,
      `tick ${tick}: feet ${hero.y} should match tilted wood ${surface}`);
    assert.equal(hero.grounded, true);
  }
});
