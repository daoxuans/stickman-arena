import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DUEL_WORLD_WIDTH, DUEL_WAVE_DAMAGE, DUEL_WAVE_REACH,
  DUEL_WAVE_HALF_HEIGHT, DUEL_WAVE_GUARD_TICKS,
  SPEARS_PER_DUEL, SPEAR_WINDUP_TICKS,
  createDuelState, stepCombat,
} from '../shared/combat.js';
import { platformPose } from '../shared/platforms.js';

test('every PvP theme has a 3x mirrored arena with animated bars and theme hazards', () => {
  const types = { forest: 'thorns', city: 'traffic', ocean: 'tide', land: 'fissure' };
  for (const [theme, type] of Object.entries(types)) {
    const state = createDuelState(theme);
    assert.equal(state.arena.width, DUEL_WORLD_WIDTH);
    assert.equal(state.arena.fallingHazard, null);
    assert.equal(state.fighters[0].x + state.fighters[1].x, DUEL_WORLD_WIDTH,
      'players start in the visible middle rather than at far-off world edges');
    const { platforms, hazards } = state.arena;
    assert.ok(platforms.filter((platform) => platform.motion === 'rotate').length >= 2);
    assert.ok(platforms.filter((platform) => platform.axis === 'x').length >= 2);
    assert.equal(hazards.length, 3);
    assert.ok(hazards.every((hazard) => hazard.type === type && hazard.damage === 10));
    assert.equal(hazards[0].x + hazards[2].x + hazards[0].w, DUEL_WORLD_WIDTH);
    assert.equal(hazards[1].x * 2 + hazards[1].w, DUEL_WORLD_WIDTH);
    for (const tick of [0, 39, 97, 168]) {
      for (let index = 0; index < 3; index++) {
        const left = platformPose(platforms[index], tick);
        const right = platformPose(platforms[platforms.length - 1 - index], tick);
        assert.ok(Math.abs(left.centerX + right.centerX - DUEL_WORLD_WIDTH) < 1e-9);
        assert.ok(Math.abs(left.centerY - right.centerY) < 1e-9);
        assert.ok(Math.abs(left.angle + right.angle) < 1e-9);
      }
    }
  }
});

test('mirrored hazards hit both teams for 10% HP with cooldown; dodge avoids contact', () => {
  const state = createDuelState('forest');
  const [p1, p2] = state.fighters;
  const [left, , right] = state.arena.hazards;
  p1.x = left.x + left.w / 2;
  p2.x = right.x + right.w / 2;
  stepCombat(state);
  assert.deepEqual([p1.hp, p2.hp], [90, 90]);
  assert.deepEqual(state.events.filter((entry) => entry.type === 'hit')
    .map(({ damage, source }) => [damage, source]),
  [[10, 'hazard:thorns'], [10, 'hazard:thorns']]);
  assert.deepEqual([p1.duelWaveHits, p2.duelWaveHits], [0, 0]);
  for (let tick = 0; tick < 35; tick++) stepCombat(state);
  assert.deepEqual([p1.hp, p2.hp], [90, 90], 'cooldown stops rapid repeated trap damage');

  const dodge = createDuelState('city');
  const [evader, exposed] = dodge.fighters;
  evader.x = dodge.arena.hazards[0].x + dodge.arena.hazards[0].w / 2;
  exposed.x = dodge.arena.hazards[2].x + dodge.arena.hazards[2].w / 2;
  stepCombat(dodge, { p1: { dodge: true } });
  assert.deepEqual([evader.hp, exposed.hp], [100, 90]);
});

test('a same-tick pair of lethal hazard contacts resolves as a PvP draw', () => {
  const state = createDuelState('land');
  const [p1, p2] = state.fighters;
  p1.hp = p2.hp = 10;
  p1.x = state.arena.hazards[0].x + 38;
  p2.x = state.arena.hazards[2].x + 38;
  stepCombat(state);
  assert.equal(state.status, 'finished');
  assert.equal(state.finishReason, 'ko');
  assert.equal(state.winner, null);
  assert.deepEqual(state.events.filter((entry) => entry.type === 'ko')
    .map((entry) => entry.target), ['p1', 'p2']);
});

test('PvP spear requires two fresh presses, is aimed independently by P2 and spends only on launch', () => {
  const state = createDuelState();
  state.arena.hazards = [];
  const [p1, p2] = state.fighters;
  stepCombat(state, { p1: { spear: true }, p2: { spear: true } });
  assert.equal(p1.spearAiming, true);
  assert.equal(p2.spearAiming, true);
  assert.deepEqual([p1.spearRemaining, p2.spearRemaining], [5, 5]);
  stepCombat(state, { p2: { aimAngle: 60 } });
  assert.equal(p2.spearAimAngle, 60);
  stepCombat(state, { p2: { spear: true } });
  assert.equal(p2.spearAiming, false);
  assert.equal(p2.spearLaunchFacing, -1);
  assert.equal(p1.spearAiming, true);
  assert.equal(p2.spearRemaining, SPEARS_PER_DUEL);
  let throwEvent;
  for (let frame = 1; frame < SPEAR_WINDUP_TICKS; frame++) {
    stepCombat(state);
    throwEvent ||= state.events.find((entry) => entry.type === 'spear-throw');
  }
  assert.ok(throwEvent && throwEvent.source === 'p2' && throwEvent.vx < 0);
  assert.deepEqual([p1.spearRemaining, p2.spearRemaining], [5, 4]);
  stepCombat(state, { p1: { aimCancel: true } });
  assert.equal(p1.spearAiming, false);
  assert.equal(p1.spearRemaining, SPEARS_PER_DUEL);
});

test('each PvP duelist is capped at five actual throws, regardless of repeated input', () => {
  const state = createDuelState();
  state.arena.hazards = [];
  state.arena.platforms = [];
  const [p1, p2] = state.fighters;
  p1.x = 180;
  p2.x = 2640;
  let thrown = 0;
  for (let use = 0; use < SPEARS_PER_DUEL; use++) {
    stepCombat(state, { p1: { spear: true } });
    assert.equal(p1.spearAiming, true);
    stepCombat(state);
    stepCombat(state, { p1: { spear: true } });
    for (let frame = 1; frame < SPEAR_WINDUP_TICKS; frame++) {
      stepCombat(state, { p1: { spear: true } });
      thrown += state.events.filter((entry) => entry.type === 'spear-throw').length;
    }
    assert.equal(p1.spearRemaining, SPEARS_PER_DUEL - use - 1);
    stepCombat(state);
  }
  assert.equal(thrown, SPEARS_PER_DUEL);
  for (let frame = 0; frame < 20; frame++) {
    stepCombat(state, { p1: { spear: frame % 2 === 0 } });
    assert.equal(p1.spearAiming, false);
    assert.equal(p1.spearWindup, 0);
    assert.ok(!state.events.some((entry) => entry.type === 'spear-throw'));
  }
  assert.equal(p1.spearRemaining, 0);
  assert.equal(p2.spearRemaining, SPEARS_PER_DUEL);
});

test('a hit interrupts an unthrown PvP spear without consuming that duelist\'s allowance', () => {
  const state = createDuelState();
  state.arena.hazards = [];
  const [p1, p2] = state.fighters;
  stepCombat(state, { p1: { spear: true } });
  stepCombat(state);
  stepCombat(state, { p1: { spear: true } });
  assert.ok(p1.spearWindup > 0);
  p2.x = p1.x + 48;
  p2.attackStage = 1;
  p2.attackTick = 4;
  stepCombat(state);
  assert.ok(p1.hp < p1.maxHp);
  assert.equal(p1.spearWindup, 0);
  assert.equal(p1.spearRemaining, SPEARS_PER_DUEL);
  assert.equal(state.projectiles.length, 0);
});

test('a confirmed PvP spear can be replaced by a charged wave without spending ammo', () => {
  const state = createDuelState();
  state.arena.hazards = [];
  const p1 = state.fighters[0];
  stepCombat(state, { p1: { spear: true } });
  stepCombat(state);
  stepCombat(state, { p1: { spear: true } });
  assert.ok(p1.spearWindup > 0);
  p1.duelWaveCharge = 1;
  stepCombat(state, { p1: { special: true } });
  assert.equal(p1.spearWindup, 0);
  assert.equal(p1.spearRemaining, SPEARS_PER_DUEL);
  assert.equal(p1.duelWaveCharge, 0);
  assert.ok(state.events.some((entry) => entry.type === 'duel-wave'));
  for (let frame = 0; frame < SPEAR_WINDUP_TICKS + 5; frame++) {
    stepCombat(state);
    assert.ok(!state.events.some((entry) => entry.type === 'spear-throw'));
  }
});

test('a valid duelist spear impact contributes one real-hit wave charge point', () => {
  const state = createDuelState();
  state.arena.hazards = [];
  const [p1, p2] = state.fighters;
  state.projectiles.push({ id: 'spear-test', kind: 'spear', source: p1.id, team: p1.team,
    x: p2.x - 48, y: p2.y - 48, vx: 70, vy: 0, radius: 7, damage: 22, ttl: 20 });
  stepCombat(state);
  assert.equal(p2.hp, 78);
  assert.equal(p1.duelWaveHits, 1);
  assert.ok(state.events.some((entry) => entry.type === 'hit'
    && entry.source === p1.id && entry.delivery === 'spear'));
  assert.ok(state.events.some((entry) => entry.type === 'spear-impact'
    && entry.target === p2.id));
});

test('both PvP teams launch equally powerful parabolic spears and earn equal hit charge', () => {
  const outcomes = [];
  for (const shooter of ['p1', 'p2']) {
    const state = createDuelState();
    state.arena.platforms = [];
    state.arena.hazards = [];
    const [p1, p2] = state.fighters;
    p1.x = 1120;
    p2.x = 1420;
    const attacker = shooter === 'p1' ? p1 : p2;
    const target = shooter === 'p1' ? p2 : p1;
    let launch;
    let impact;
    for (let frame = 0; frame < 100 && !impact; frame++) {
      stepCombat(state, { [shooter]: { spear: frame === 0 || frame === 2 } });
      launch ||= state.events.find((entry) => entry.type === 'spear-throw');
      impact ||= state.events.find((entry) => entry.type === 'spear-impact');
    }
    assert.equal(impact?.target, target.id, `${shooter} connects using its chosen arc`);
    assert.equal(impact?.damage, 22);
    assert.equal(target.hp, 78);
    assert.equal(attacker.spearRemaining, 4);
    assert.equal(attacker.duelWaveHits, 1);
    outcomes.push({ damage: impact.damage, vx: Math.abs(launch.vx), vy: launch.vy });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('three personally landed non-wave hits charge one PvP wave; terrain never charges it', () => {
  const state = createDuelState();
  state.arena.hazards = [];
  state.arena.platforms = [];
  const [p1, p2] = state.fighters;
  for (let hit = 1; hit <= 3; hit++) {
    state.hitstop = 0;
    p1.attackStage = 1;
    p1.attackTick = 4;
    p1.hitIds = [];
    p2.x = p1.x + 45;
    p2.y = p1.y;
    p2.invulnerable = 0;
    stepCombat(state);
    assert.equal(p1.duelWaveCharge, hit === 3 ? 1 : 0);
    assert.equal(p1.duelWaveHits, hit === 3 ? 0 : hit);
    assert.equal(p2.duelWaveHits, 0);
  }
  assert.equal(state.events.filter((entry) => entry.type === 'duel-wave-ready').length, 1);
  assert.equal(p2.hp, 73);
  assert.ok(!state.events.some((entry) => entry.type === 'duel-wave'));
  // A full charge has no overflow stockpile.
  state.hitstop = 0;
  p1.attackStage = 1;
  p1.attackTick = 4;
  p1.hitIds = [];
  p2.x = p1.x + 45;
  p2.invulnerable = 0;
  stepCombat(state);
  assert.deepEqual([p1.duelWaveCharge, p1.duelWaveHits], [1, 0]);
});

test('PvP wave is a bounded forward chest-level blast; it cannot recharge itself', () => {
  const run = ({ x = 180, y = 438, facing = 1, dodge = 0, invulnerable = 0 } = {}) => {
    const state = createDuelState();
    state.arena.hazards = [];
    state.arena.platforms = [];
    const [p1, p2] = state.fighters;
    p1.x = 600;
    p1.facing = facing;
    p1.duelWaveCharge = 1;
    p2.x = p1.x + x;
    p2.y = y;
    p2.dodgeTicks = dodge;
    p2.invulnerable = invulnerable;
    stepCombat(state, { p1: { special: true } });
    return { state, p1, p2 };
  };
  const hit = run({ x: DUEL_WAVE_REACH - 8 });
  const blast = hit.state.events.find((entry) => entry.type === 'duel-wave');
  assert.deepEqual({ x: blast.x, facing: blast.facing, reach: blast.reach,
    halfHeight: blast.halfHeight, damage: blast.damage }, {
    x: 600, facing: 1, reach: DUEL_WAVE_REACH,
    halfHeight: DUEL_WAVE_HALF_HEIGHT, damage: DUEL_WAVE_DAMAGE,
  });
  assert.equal(hit.p2.hp, 80);
  assert.equal(hit.state.events.find((entry) => entry.type === 'hit')?.delivery, 'duel-wave');
  assert.deepEqual([hit.p1.duelWaveCharge, hit.p1.duelWaveHits], [0, 0]);
  assert.equal(hit.p1.invulnerable, DUEL_WAVE_GUARD_TICKS);
  assert.equal(hit.p1.duelWaveRecovery, DUEL_WAVE_GUARD_TICKS);
  stepCombat(hit.state, { p1: { attack: true, special: true } });
  assert.equal(hit.p1.attackStage, 0, 'the short protected cast cannot immediately combo into a punch');
  for (const options of [
    { x: -100 }, { x: DUEL_WAVE_REACH + 60 }, { x: 180, y: 300 },
    { x: 180, dodge: 6 }, { x: 180, invulnerable: 6 },
  ]) {
    const miss = run(options);
    assert.equal(miss.p2.hp, 100, JSON.stringify(options));
  }
  const left = run({ x: -180, facing: -1 });
  assert.equal(left.p2.hp, 80, 'a facing-left wave is mirrored');
});

test('simultaneous charged waves guard both players; each same-input replay is deterministic', () => {
  const state = createDuelState('land');
  state.arena.hazards = [];
  state.fighters[0].x = 1300;
  state.fighters[1].x = 1530;
  for (const fighter of state.fighters) fighter.duelWaveCharge = 1;
  stepCombat(state, { p1: { special: true }, p2: { special: true } });
  assert.equal(state.events.filter((entry) => entry.type === 'duel-wave').length, 2);
  assert.deepEqual(state.fighters.map((fighter) => fighter.hp), [100, 100]);
  assert.deepEqual(state.fighters.map((fighter) => fighter.duelWaveCharge), [0, 0]);

  const play = () => {
    const replay = createDuelState('ocean');
    const log = [];
    for (let frame = 0; frame < 180; frame++) {
      stepCombat(replay, {
        p1: { right: frame < 25, jump: frame === 30,
          spear: frame === 40 || frame === 43, aimUp: frame > 40 && frame < 43 },
        p2: { left: frame < 25, dodge: frame === 48, kick: frame === 63 },
      });
      log.push({ tick: replay.tick, motionTick: replay.motionTick,
        hp: replay.fighters.map((fighter) => fighter.hp),
        ammo: replay.fighters.map((fighter) => fighter.spearRemaining),
        events: replay.events, projectiles: replay.projectiles });
    }
    return log;
  };
  assert.deepEqual(play(), play());
});
