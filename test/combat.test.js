import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TICK_RATE, CORPSE_SETTLE_TICKS, CORPSE_HOLD_TICKS,
  SPEAR_WINDUP_TICKS, SPEARS_PER_LEVEL, SPEAR_GRAVITY, SPEAR_MIN_ANGLE, SPEAR_MAX_ANGLE,
  createFighter,
  createCombatState, createDuelState, stepCombat, aiInput, attackOf, kickOf,
  cancelSpearAim, spearOrigin, spearFlight, spearAimedFlight, spearTrajectoryPoint,
} from '../shared/combat.js';
import { getLevel } from '../shared/levels.js';
import { platformPose, platformSurfaceY } from '../shared/platforms.js';

function arena(overrides = {}) {
  return { theme: 'forest', groundY: 438, platforms: [], hazards: [], ...overrides };
}

function sparring(x = 350) {
  const fighters = [
    createFighter({ id: 'hero', x: 300, y: 438, team: 0 }),
    createFighter({ id: 'enemy', x, y: 438, team: 1, kind: 'grunt' }),
  ];
  return createCombatState({ fighters, arena: arena() });
}

function fallingHazard(overrides = {}) {
  return {
    type: 'hail', period: 240, firstTick: 120, warningTicks: 40,
    radius: 8, damageFraction: 0.1, seed: 0, ...overrides,
  };
}

test('duel uses a symmetric arena and a 99-second fixed-step clock', () => {
  const state = createDuelState('ocean');
  assert.equal(TICK_RATE, 60);
  assert.equal(Object.hasOwn(state, 'spearRemaining'), false, 'duels have no campaign spear allowance');
  assert.equal(state.arena.theme, 'ocean');
  assert.equal(state.timerTicks, 99 * TICK_RATE);
  assert.deepEqual(state.fighters.map(({ id, hp }) => [id, hp]), [['p1', 100], ['p2', 100]]);
  stepCombat(state);
  assert.equal(state.timerTicks, 99 * TICK_RATE - 1);
});

test('one attack can damage a target only once, even across active frames', () => {
  const state = sparring();
  const hits = [];
  for (let tick = 0; tick < 26; tick++) {
    stepCombat(state, { hero: { attack: tick === 0 } });
    hits.push(...state.events.filter((event) => event.type === 'hit'));
  }
  assert.equal(state.fighters[1].hp, 42 - 9);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].damage, 9);
});

test('a buffered attack flows into the second combo strike', () => {
  const state = sparring(800);
  stepCombat(state, { hero: { attack: true } });
  stepCombat(state, { hero: { attack: false } });
  stepCombat(state, { hero: { attack: true } });
  for (let tick = 0; tick < 21; tick++) stepCombat(state);
  assert.equal(state.fighters[0].attackStage, 2);
  assert.ok(state.fighters[0].attackTick > 0);
});

test('a finished third strike resets the combo instead of looping the finisher', () => {
  const state = sparring(800);
  const hero = state.fighters[0];
  hero.attackStage = 3;
  hero.attackTick = 30;
  hero.comboStage = 3;
  stepCombat(state);
  assert.equal(hero.attackStage, 0);
  assert.equal(hero.comboWindow, 0);
  stepCombat(state, { hero: { attack: true } });
  assert.equal(hero.attackStage, 1);
});

test('boss attacks telegraph for twelve full ticks before their active frame', () => {
  const state = createCombatState({
    arena: arena(),
    fighters: [
      createFighter({ id: 'hero', x: 300, y: 438, team: 0 }),
      createFighter({ id: 'boss', x: 350, y: 438, team: 1, kind: 'boss' }),
    ],
  });
  const cues = [];
  for (let tick = 0; tick < 12; tick++) {
    stepCombat(state, { boss: { attack: tick === 0 } });
    cues.push(...state.events.filter((entry) => entry.type === 'boss-windup'));
    assert.equal(state.fighters[0].hp, 100);
  }
  assert.equal(cues.length, 1, 'one audio/visual warning belongs to the attack start, not each windup frame');
  assert.deepEqual({ source: cues[0].source, stage: cues[0].stage, facing: cues[0].facing },
    { source: 'boss', stage: 1, facing: -1 });
  assert.ok(Number.isFinite(cues[0].x) && Number.isFinite(cues[0].y));
  stepCombat(state);
  assert.ok(state.fighters[0].hp < 100);
});

test('boss size and punch reach match the enlarged silhouette without faster startup', () => {
  const boss = createFighter({ id: 'boss', x: 350, y: 438, team: 1, kind: 'boss' });
  assert.deepEqual({ width: boss.width, height: boss.height }, { width: 44, height: 136 });
  assert.deepEqual([1, 2, 3].map((stage) => {
    boss.attackStage = stage;
    return attackOf(boss).reach;
  }), [83, 89, 101]);
  boss.attackStage = 0;

  const hero = createFighter({ id: 'hero', x: 265, y: 438, team: 0 });
  const state = createCombatState({ arena: arena(), fighters: [hero, boss] });
  for (let tick = 0; tick < 12; tick++) {
    stepCombat(state, { boss: { attack: tick === 0 } });
    assert.equal(hero.hp, 100);
  }
  stepCombat(state);
  assert.ok(hero.hp < 100, 'enlarged boss connects beyond a regular punch reach');
});

test('ground kick has its own shared window, hits once, and holding the key never repeats it', () => {
  const state = sparring();
  const hero = state.fighters[0];
  assert.equal(kickOf(hero), null);
  assert.equal(attackOf(hero), null); // The existing punch descriptor remains available.
  const kicks = [];
  const hits = [];

  for (let tick = 0; tick < 55; tick++) {
    stepCombat(state, { hero: { kick: true } });
    kicks.push(...state.events.filter((entry) => entry.type === 'kick'));
    hits.push(...state.events.filter((entry) => entry.type === 'hit'));
    if (tick === 0) {
      assert.equal(hero.kickType, 'ground');
      assert.equal(hero.kickTick, 1);
      assert.equal(hero.attackStage, 0);
      assert.deepEqual(
        { duration: kickOf(hero).duration, activeFrom: kickOf(hero).activeFrom,
          activeTo: kickOf(hero).activeTo, damage: kickOf(hero).damage, reach: kickOf(hero).reach },
        { duration: 20, activeFrom: 6, activeTo: 11, damage: 11, reach: 78 },
      );
      assert.ok(Object.isFrozen(kickOf(hero)));
    }
    if (tick === 4) assert.equal(state.fighters[1].hp, 42);
  }
  assert.equal(kicks.length, 1);
  assert.deepEqual(
    { source: kicks[0].source, facing: kicks[0].facing },
    { source: 'hero', facing: 1 },
  );
  assert.ok(Number.isFinite(kicks[0].x) && Number.isFinite(kicks[0].y));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].damage, 11);
  assert.equal(state.fighters[1].hp, 31);
  assert.equal(hero.kickType, null);
  assert.equal(hero.kickTick, 0);

  stepCombat(state, { hero: { kick: false } });
  stepCombat(state, { hero: { kick: true } });
  assert.equal(hero.kickType, 'ground'); // Recovery is the move duration, not a hidden cooldown.
  assert.ok(state.events.some((entry) => entry.type === 'kick'));
});

test('kick, punch and dodge cannot overlap or buffer one another', () => {
  const kicking = sparring(800);
  const hero = kicking.fighters[0];
  stepCombat(kicking, { hero: { kick: true, attack: true } });
  assert.equal(hero.kickType, 'ground');
  assert.equal(hero.attackStage, 0);
  stepCombat(kicking, { hero: { attack: false } });
  stepCombat(kicking, { hero: { attack: true, dodge: true } });
  assert.equal(hero.attackStage, 0);
  assert.equal(hero.attackBuffered, false);
  assert.equal(hero.dodgeTicks, 0);

  const punching = sparring(800);
  stepCombat(punching, { hero: { attack: true } });
  stepCombat(punching, { hero: { kick: true } });
  assert.equal(punching.fighters[0].attackStage, 1);
  assert.equal(punching.fighters[0].kickType, null);

  const dodging = sparring(800);
  stepCombat(dodging, { hero: { dodge: true, kick: true } });
  assert.ok(dodging.fighters[0].dodgeTicks > 0);
  assert.equal(dodging.fighters[0].kickType, null);
});

test('jump+kick in one tick starts an air kick, damages once and marks a heavy hit', () => {
  const state = sparring(360);
  const hero = state.fighters[0];
  const events = [];
  for (let tick = 0; tick < 35; tick++) {
    stepCombat(state, { hero: { jump: tick === 0, kick: tick === 0 } });
    events.push(...state.events);
    if (tick < 6) assert.ok(!state.events.some((entry) => entry.type === 'jump-kick'));
    if (tick === 6) assert.equal(state.events.filter((entry) => entry.type === 'jump-kick').length, 1);
    if (tick === 0) {
      assert.equal(hero.grounded, false);
      assert.equal(hero.kickType, 'air');
      assert.equal(hero.airKickUsed, true);
      assert.deepEqual(
        { duration: kickOf(hero).duration, activeFrom: kickOf(hero).activeFrom,
          activeTo: kickOf(hero).activeTo, damage: kickOf(hero).damage, reach: kickOf(hero).reach },
        { duration: 26, activeFrom: 7, activeTo: 16, damage: 16, reach: 96 },
      );
    }
  }
  assert.equal(events.filter((entry) => entry.type === 'jump').length, 1);
  const jumpKicks = events.filter((entry) => entry.type === 'jump-kick');
  assert.equal(jumpKicks.length, 1);
  assert.equal(jumpKicks[0].source, 'hero');
  assert.equal(jumpKicks[0].facing, 1);
  assert.ok(jumpKicks[0].y < 350, 'burst originates from the airborne foot, not takeoff');
  const hits = events.filter((entry) => entry.type === 'hit');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].damage, 16);
  assert.equal(hits[0].heavy, true);
  assert.equal(state.fighters[1].hp, 26);
});

test('an air kick cannot repeat until landing, and landing safely ends its active window', () => {
  const state = sparring(800);
  const hero = state.fighters[0];
  stepCombat(state, { hero: { jump: true, kick: true } });
  for (let tick = 0; tick < 26; tick++) stepCombat(state);
  assert.equal(hero.kickType, null);
  assert.equal(hero.grounded, false);
  assert.equal(hero.airKickUsed, true);
  stepCombat(state, { hero: { kick: true } });
  assert.equal(hero.kickType, null);
  assert.ok(!state.events.some((entry) => entry.type === 'jump-kick'));

  for (let tick = 0; tick < 80 && !hero.grounded; tick++) stepCombat(state);
  assert.equal(hero.grounded, true);
  assert.equal(hero.airKickUsed, false);
  stepCombat(state, { hero: { jump: true, kick: true } });
  assert.equal(hero.kickType, 'air');
  assert.ok(!state.events.some((entry) => entry.type === 'jump-kick'));
  for (let tick = 0; tick < 6; tick++) stepCombat(state);
  assert.ok(state.events.some((entry) => entry.type === 'jump-kick'));

  const landing = sparring(350);
  const descending = landing.fighters[0];
  descending.y = 437;
  descending.vy = 4;
  descending.grounded = false;
  descending.kickType = 'air';
  descending.kickTick = 8;
  descending.airKickUsed = true;
  stepCombat(landing);
  assert.equal(descending.grounded, true);
  assert.equal(descending.kickType, null);
  assert.equal(descending.kickTick, 0);
  assert.equal(descending.airKickUsed, false);
  assert.equal(landing.fighters[1].hp, 42, 'landing does not extend air-kick damage along the ground');
});

test('jump-kick burst also fires on a whiff but never for an interrupted or early-landing kick', () => {
  const whiff = sparring(800);
  let bursts = 0;
  for (let tick = 0; tick < 30; tick++) {
    stepCombat(whiff, { hero: { jump: tick === 0, kick: tick === 0 } });
    const current = whiff.events.filter((entry) => entry.type === 'jump-kick');
    if (tick < 6) assert.equal(current.length, 0);
    if (tick === 6) assert.equal(current.length, 1);
    bursts += current.length;
  }
  assert.equal(bursts, 1);
  assert.equal(whiff.fighters[1].hp, 42);

  const interrupted = sparring();
  let interruptedBursts = 0;
  for (let tick = 0; tick < 28; tick++) {
    stepCombat(interrupted, {
      hero: { jump: tick === 0, kick: tick === 0 },
      enemy: { attack: tick === 0 },
    });
    interruptedBursts += interrupted.events.filter((entry) => entry.type === 'jump-kick').length;
  }
  assert.ok(interrupted.fighters[0].hp < 100);
  assert.equal(interruptedBursts, 0);

  const landing = sparring(800);
  const hero = landing.fighters[0];
  hero.y = 437;
  hero.vy = 4;
  hero.grounded = false;
  stepCombat(landing, { hero: { kick: true } });
  assert.equal(hero.kickType, null);
  assert.equal(hero.grounded, true);
  assert.ok(!landing.events.some((entry) => entry.type === 'jump-kick'));
});

test('a hit interrupts a kick, and kick damage still uses hit/KO events', () => {
  const interrupted = sparring();
  stepCombat(interrupted, { hero: { kick: true }, enemy: { attack: true } });
  for (let tick = 0; tick < 4; tick++) stepCombat(interrupted);
  assert.ok(interrupted.fighters[0].hp < 100);
  assert.equal(interrupted.fighters[0].kickType, null);
  assert.equal(interrupted.fighters[0].kickTick, 0);

  const knockout = sparring();
  knockout.fighters[1].hp = 10;
  for (let tick = 0; tick < 6; tick++) stepCombat(knockout, { hero: { kick: tick === 0 } });
  assert.equal(knockout.fighters[1].hp, 0);
  assert.ok(knockout.events.some((entry) => entry.type === 'hit' && entry.source === 'hero'));
  assert.ok(knockout.events.some((entry) => entry.type === 'ko' && entry.target === 'enemy'));
});

test('simultaneous duel strikes trade regardless of fighters array order', () => {
  function trade(action, reverse, health = 100) {
    const p1 = createFighter({ id: 'p1', x: 300, y: 438, team: 0 });
    const p2 = createFighter({ id: 'p2', x: 350, y: 438, team: 1 });
    p1.hp = p2.hp = health;
    const state = createCombatState({
      mode: 'duel', arena: arena(), durationTicks: 600,
      fighters: reverse ? [p2, p1] : [p1, p2],
    });
    const hits = [];
    for (let tick = 0; tick < 40 && state.status === 'playing'; tick++) {
      const input = action === 'jump-kick'
        ? { jump: tick === 0, kick: tick === 0 }
        : { [action]: tick === 0 };
      stepCombat(state, {
        p1: input,
        p2: input,
      });
      hits.push(...state.events.filter((entry) => entry.type === 'hit')
        .map(({ target, damage }) => ({ target, damage })));
    }
    return { hp: { p1: p1.hp, p2: p2.hp }, hits, winner: state.winner, status: state.status };
  }

  for (const action of ['kick', 'jump-kick', 'attack']) {
    const forward = trade(action, false);
    const reversed = trade(action, true);
    const damage = action === 'kick' ? 11 : action === 'jump-kick' ? 16 : 9;
    assert.deepEqual(forward.hp, { p1: 100 - damage, p2: 100 - damage });
    assert.deepEqual(reversed.hp, forward.hp);
    assert.deepEqual(forward.hits, [
      { target: 'p2', damage }, { target: 'p1', damage },
    ]);
    assert.deepEqual(reversed.hits, forward.hits);
  }

  const doubleKO = trade('kick', false, 11);
  assert.deepEqual(doubleKO.hp, { p1: 0, p2: 0 });
  assert.equal(doubleKO.status, 'finished');
  assert.equal(doubleKO.winner, null);
  assert.deepEqual(trade('kick', true, 11), doubleKO);
});

test('dodge grants a short invulnerable dash with cooldown', () => {
  const state = sparring(350);
  state.fighters[1].facing = -1;
  for (let tick = 0; tick < 14; tick++) {
    stepCombat(state, {
      hero: { dodge: tick === 2, left: tick >= 2 && tick < 5 },
      enemy: { attack: tick === 0 },
    });
  }
  assert.equal(state.fighters[0].hp, 100);
  assert.ok(state.fighters[0].dodgeCooldown > 0);
});

test('jumping and one-way platform landing follow gravity', () => {
  const state = createCombatState({
    arena: arena({ platforms: [{ x: 400, y: 338, w: 140, h: 14 }] }),
    fighters: [createFighter({ id: 'hero', x: 465, y: 438 })],
  });
  let apex = 438;
  for (let tick = 0; tick < 48; tick++) {
    stepCombat(state, { hero: { jump: tick === 0 } });
    apex = Math.min(apex, state.fighters[0].y);
  }
  assert.ok(apex < 338, `jump apex ${apex} should clear the platform`);
  assert.equal(state.fighters[0].y, 338);
  assert.equal(state.fighters[0].grounded, true);
});

test('an active hazard damages once and respects a damage cooldown', () => {
  const state = createCombatState({
    arena: arena({ hazards: [{ type: 'thorns', x: 285, y: 400, w: 30, h: 38, damage: 7 }] }),
    fighters: [createFighter({ id: 'hero', x: 300, y: 438 })],
  });
  stepCombat(state);
  assert.equal(state.fighters[0].hp, 93);
  assert.ok(state.events.some((event) => event.type === 'hit'));
  stepCombat(state);
  assert.equal(state.fighters[0].hp, 93);
});

test('one seeded falling object warns every 240 effective frames and replays identically', () => {
  const build = () => createCombatState({
    arena: arena({ fallingHazard: fallingHazard({ seed: 2 }) }),
    fighters: [
      createFighter({ id: 'hero', x: 200, y: 438, team: 0 }),
      createFighter({ id: 'enemy', x: 720, y: 438, team: 1, kind: 'grunt' }),
    ],
  });
  const first = build();
  const replay = build();
  const warnings = [];
  const impacts = [];
  for (let frame = 1; frame <= 600; frame++) {
    stepCombat(first);
    stepCombat(replay);
    assert.deepEqual(first.events, replay.events);
    assert.deepEqual(first.fallingObject, replay.fallingObject);
    for (const entry of first.events) {
      if (entry.type === 'fall-warning') warnings.push({ frame, ...entry });
      if (entry.type === 'fall-impact') impacts.push({ frame, ...entry });
    }
    if (frame === 159) assert.equal(first.fallingObject?.phase, 'warning');
    if (frame === 160) {
      assert.equal(first.fallingObject?.phase, 'falling');
      assert.equal(first.fallingObject?.y, -8);
    }
  }
  assert.deepEqual(warnings.map(({ frame, index }) => [frame, index]), [[120, 0], [360, 1], [600, 2]]);
  assert.deepEqual(warnings.map(({ kind }) => kind), ['hail', 'hail', 'hail']);
  assert.equal(impacts.length, 2);
  assert.ok(impacts[0].frame > 160 && impacts[0].frame < 190);
  assert.ok(impacts[1].frame > 400 && impacts[1].frame < 430);
});

test('hitstop freezes both the falling-hazard clock and its visible warning', () => {
  const state = createCombatState({
    arena: arena({ fallingHazard: fallingHazard({ firstTick: 1, warningTicks: 4 }) }),
    fighters: [createFighter({ id: 'hero', x: 200, y: 438 })],
  });
  stepCombat(state);
  assert.equal(state.fallingObject.phase, 'warning');
  state.hitstop = 6;
  for (let frame = 0; frame < 6; frame++) stepCombat(state);
  assert.equal(state.tick, 7);
  assert.equal(state.fallingClock, 1);
  assert.equal(state.fallingObject.warningRemaining, 4);
  for (let frame = 0; frame < 4; frame++) stepCombat(state);
  assert.equal(state.fallingObject.phase, 'falling');
  stepCombat(state);
  const fallingY = state.fallingObject.y;
  state.hitstop = 3;
  for (let frame = 0; frame < 3; frame++) stepCombat(state);
  assert.equal(state.fallingClock, 6);
  assert.equal(state.fallingObject.y, fallingY);
});

test('falling objects can hit either team for ten percent of maximum HP', () => {
  const hero = createFighter({ id: 'hero', x: 200, y: 438, team: 0 });
  const enemy = createFighter({ id: 'enemy', x: 720, y: 438, team: 1, kind: 'grunt' });
  const state = createCombatState({
    arena: arena({ fallingHazard: fallingHazard({ firstTick: 1, period: 90, warningTicks: 4 }) }),
    fighters: [hero, enemy],
  });
  const hits = [];
  for (let frame = 0; frame < 150; frame++) {
    stepCombat(state);
    hits.push(...state.events.filter((entry) => entry.type === 'hit'));
  }
  assert.equal(hero.hp, 90);
  assert.equal(enemy.hp, 38);
  assert.deepEqual(hits.map(({ target, damage, source }) => ({ target, damage, source })), [
    { target: 'hero', damage: 10, source: 'hazard:hail' },
    { target: 'enemy', damage: 4, source: 'hazard:hail' },
  ]);
});

test('a warned fall can be sidestepped or absorbed by invulnerability', () => {
  const build = () => createCombatState({
    arena: arena({ fallingHazard: fallingHazard({ firstTick: 1, period: 240 }) }),
    fighters: [createFighter({ id: 'hero', x: 200, y: 438 })],
  });
  const evaded = build();
  stepCombat(evaded);
  const markedX = evaded.fallingObject.x;
  let missed = null;
  for (let frame = 0; frame < 90; frame++) {
    stepCombat(evaded, { hero: { right: true } });
    missed ??= evaded.events.find((entry) => entry.type === 'fall-impact');
  }
  assert.ok(Math.abs(evaded.fighters[0].x - markedX) > 100);
  assert.deepEqual({ target: missed?.target, damage: missed?.damage }, { target: null, damage: 0 });
  assert.equal(evaded.fighters[0].hp, 100);

  const protectedState = build();
  stepCombat(protectedState);
  protectedState.fighters[0].invulnerable = 100;
  let blocked = null;
  for (let frame = 0; frame < 90; frame++) {
    stepCombat(protectedState);
    blocked ??= protectedState.events.find((entry) => entry.type === 'fall-impact');
  }
  assert.deepEqual({ target: blocked?.target, damage: blocked?.damage }, { target: 'hero', damage: 0 });
  assert.equal(protectedState.fighters[0].hp, 100);
});

test('falling objects use the boss maximum HP and cannot enter a PvP duel', () => {
  const boss = createFighter({ id: 'boss', x: 350, y: 438, team: 1, kind: 'boss' });
  boss.hp = 50;
  const config = fallingHazard({ type: 'pebble', firstTick: 1, warningTicks: 2 });
  const state = createCombatState({ arena: arena({ fallingHazard: config }), fighters: [boss] });
  let hit = null;
  for (let frame = 0; frame < 60; frame++) {
    stepCombat(state);
    hit ??= state.events.find((entry) => entry.type === 'hit');
  }
  assert.equal(boss.hp, 35);
  assert.deepEqual({ damage: hit?.damage, source: hit?.source },
    { damage: 15, source: 'hazard:pebble' });

  const duel = createCombatState({
    mode: 'duel', durationTicks: 300, arena: arena({ fallingHazard: config }),
    fighters: [createFighter({ id: 'p1', x: 200 }), createFighter({ id: 'p2', x: 720, team: 1 })],
  });
  for (let frame = 0; frame < 120; frame++) stepCombat(duel);
  assert.equal(duel.arena.fallingHazard, null);
  assert.equal(duel.fallingClock, 0);
  assert.equal(duel.fallingObject, null);
  assert.ok(!duel.events.some((entry) => entry.type.startsWith('fall-')));
});

test('the authoritative duel resolves KO and timeouts', () => {
  const knockout = createDuelState();
  knockout.fighters[0].x = 300;
  knockout.fighters[1].x = 350;
  knockout.fighters[1].hp = 1;
  for (let tick = 0; tick < 12 && knockout.status === 'playing'; tick++) {
    stepCombat(knockout, { p1: { attack: tick === 0 } });
  }
  assert.equal(knockout.status, 'finished');
  assert.equal(knockout.winner, 'p1');
  assert.equal(knockout.finishReason, 'ko');

  const timeout = createDuelState();
  timeout.timerTicks = 1;
  stepCombat(timeout);
  assert.equal(timeout.status, 'finished');
  assert.equal(timeout.winner, null);
  assert.equal(timeout.finishReason, 'timeout');
});

test('enemy AI produces safe, deterministic controls', () => {
  const state = sparring();
  const first = aiInput(state.fighters[1], state.fighters[0], state);
  assert.deepEqual(first, aiInput(state.fighters[1], state.fighters[0], state));
  for (const value of Object.values(first)) assert.equal(typeof value, 'boolean');
});

test('each enemy type notices a close target behind and turns before swinging', () => {
  for (const kind of ['grunt', 'rusher', 'guard', 'boss']) {
    const state = sparring(250);
    const [hero] = state.fighters;
    const enemy = createFighter({ id: `enemy-${kind}`, x: 250, y: 438, team: 1, kind });
    state.fighters[1] = enemy;
    // Choose an actual attack opportunity, so merely skipping an idle frame cannot pass.
    enemy.facing = 1;
    const attackTick = Array.from({ length: 63 }, (_, tick) => tick).find((tick) => {
      state.tick = tick;
      return aiInput(enemy, hero, state).attack;
    });
    assert.notEqual(attackTick, undefined);
    state.tick = attackTick;
    enemy.facing = -1;
    const turn = aiInput(enemy, hero, state);
    assert.equal(turn.right, true, `${kind} tracks the target behind`);
    assert.equal(turn.attack, false, `${kind} does not swing while facing away`);
    assert.equal(turn.kick, false);
    stepCombat(state, { [enemy.id]: turn });
    assert.equal(enemy.facing, 1);
    assert.equal(enemy.attackStage, 0);
    assert.equal(hero.hp, 100);

    let swung = false;
    for (let tick = 0; tick < 180; tick++) {
      stepCombat(state, { [enemy.id]: aiInput(enemy, hero, state) });
      if (enemy.attackStage > 0) swung = true;
      if (hero.hp < 100) break;
    }
    assert.equal(swung, true, `${kind} eventually attacks after turning`);
    assert.ok(hero.hp < 100, `${kind} can hit the target after turning`);
  }
});

test('enemy AI tracks a target crossing behind only after a committed punch recovers', () => {
  const state = sparring(350);
  const [hero, enemy] = state.fighters;
  stepCombat(state, { enemy: { attack: true } });
  assert.equal(enemy.attackStage, 1);
  hero.x = enemy.x + 50;

  for (let tick = 0; enemy.attackStage > 0 && tick < 40; tick++) {
    const input = aiInput(enemy, hero, state);
    assert.equal(input.attack, false);
    stepCombat(state, { enemy: input });
    assert.equal(enemy.facing, -1, 'an active punch keeps its original direction');
  }
  assert.equal(enemy.attackStage, 0);
  const turn = aiInput(enemy, hero, state);
  assert.equal(turn.right, true);
  stepCombat(state, { enemy: turn });
  assert.equal(enemy.facing, 1);
});

test('enemy AI does not flicker its direction when fighter hitboxes overlap', () => {
  const state = sparring(300);
  const [hero, enemy] = state.fighters;
  for (const offset of [0, 3, -3, 9, -9, 0]) {
    hero.x = enemy.x + offset;
    const input = aiInput(enemy, hero, state);
    assert.equal(input.left, false);
    assert.equal(input.right, false);
  }
  assert.equal(enemy.facing, -1, 'AI input remains pure');
});

test('the close-behind AI rule does not auto-turn fighters in a PvP duel', () => {
  const duel = createDuelState();
  duel.fighters[0].x = 300;
  duel.fighters[1].x = 250;
  duel.fighters[1].facing = -1;
  stepCombat(duel);
  assert.equal(duel.fighters[1].facing, -1);
});

test('ordinary enemy AI kicks occasionally while the balanced boss AI does not', () => {
  const state = sparring();
  let kickRequests = 0;
  for (let tick = 0; tick < 448; tick++) {
    state.tick = tick;
    if (aiInput(state.fighters[1], state.fighters[0], state).kick) kickRequests++;
  }
  assert.ok(kickRequests >= 1 && kickRequests <= 3);

  const boss = createFighter({ id: 'boss', x: 350, y: 438, team: 1, kind: 'boss' });
  for (let tick = 0; tick < 448; tick++) {
    state.tick = tick;
    assert.equal(aiInput(boss, state.fighters[0], state).kick, false);
  }
});

function pursueThroughHazards({ field, heroX, enemyX, kind = 'grunt', heroY = field.groundY,
  enemyY = field.groundY, frames = 480, firstInput = null }) {
  const hero = createFighter({ id: 'hero', x: heroX, y: heroY, team: 0 });
  // Keep the target at the requested position even when it stands on the
  // danger zone; the test is about the enemy's navigation, not the player's HP.
  hero.invulnerable = frames + 100;
  const enemy = createFighter({ id: 'enemy', x: enemyX, y: enemyY,
    team: 1, kind });
  const state = createCombatState({ arena: field, fighters: [hero, enemy] });
  const path = [];
  const hazardHits = [];
  for (let frame = 0; frame < frames; frame++) {
    const controls = frame === 0 && firstInput !== null
      ? firstInput : aiInput(enemy, hero, state);
    stepCombat(state, { enemy: controls });
    path.push([enemy.x, enemy.y, enemy.hp]);
    for (const entry of state.events) {
      if (entry.type === 'hit' && entry.target === enemy.id
          && entry.source?.startsWith('hazard:')) hazardHits.push(frame);
    }
  }
  return { hero, enemy, path, hazardHits };
}

test('level 02 pursuer approaches a player in the thorns without ping-pong damage', () => {
  const level = getLevel(2);
  assert.ok(level.hazards.some(({ x, w }) => x <= 600 && x + w >= 600),
    'this regression exercises the actual level 02 ground hazard');
  const field = { ...level.arena, fallingHazard: null };
  const setup = { field, heroX: 600, enemyX: 850 };
  const first = pursueThroughHazards(setup);
  assert.deepEqual(first.path, pursueThroughHazards(setup).path,
    'identical inputs and level phase should replay the same trajectory');
  assert.ok(first.path.some(([x]) => Math.abs(x - 600) < 95),
    'the enemy still approaches a fightable distance rather than abandoning pursuit');
  assert.equal(first.hazardHits.length, 0,
    `the enemy should not repeatedly step into the level 02 thorns (${first.hazardHits})`);
});

test('ground enemies cross a persistent trap from either side without taking damage', () => {
  const level = getLevel(2);
  const field = { ...level.arena, fallingHazard: null };
  for (const kind of ['grunt', 'brute']) {
    for (const [enemyX, heroX] of [[850, 470], [470, 850]]) {
      const result = pursueThroughHazards({ field, enemyX, heroX, kind });
      const description = `${kind} ${enemyX} → ${heroX}`;
      assert.ok(result.path.some(([x]) => Math.abs(x - heroX) < 85),
        `${description}: reaches the player on the far side, not just the near edge`);
      assert.equal(result.hazardHits.length, 0,
        `${description}: no repeated damage while crossing (${result.hazardHits})`);
    }
  }
});

test('a periodic ground trap can be crossed at a safe time without repeat damage', () => {
  const field = arena({ width: 1920, hazards: [{
    type: 'thorns', x: 594, y: 424, w: 76, h: 14, damage: 2,
    period: 140, activeTicks: 80, phase: 0,
  }] });
  for (const kind of ['grunt', 'brute']) {
    const result = pursueThroughHazards({ field, enemyX: 850, heroX: 470, kind });
    assert.ok(result.path.some(([x]) => Math.abs(x - 470) < 85),
      `${kind}: eventually crosses instead of waiting forever at the near edge`);
    assert.equal(result.hazardHits.length, 0,
      `${kind}: watches the active phase or clears the trap safely (${result.hazardHits})`);
  }
});

test('an enemy knocked back by the level 02 hazard does not rush into it again', () => {
  const level = getLevel(2);
  const field = { ...level.arena, fallingHazard: null };
  const result = pursueThroughHazards({
    field, heroX: 600, enemyX: 665, firstInput: {},
  });
  assert.deepEqual(result.hazardHits, [0],
    `the deliberately forced first hit must not become a damage loop (${result.hazardHits})`);
  assert.ok(result.path.slice(1).some(([x]) => Math.abs(x - 600) < 95),
    'after stun and knockback, the enemy still seeks a safe attack approach');
  assert.equal(result.enemy.hp, result.enemy.maxHp - level.hazards[0].damage,
    'later movement cannot slowly drain HP on the same obstacle');
});

test('a melee knockback does not make a recovering enemy repeatedly enter the trap', () => {
  const field = arena({ width: 1920, hazards: [{
    type: 'thorns', x: 594, y: 424, w: 76, h: 14, damage: 2,
  }] });
  const hero = createFighter({ id: 'hero', x: 620, y: 438, team: 0 });
  hero.invulnerable = 600;
  const enemy = createFighter({ id: 'enemy', x: 685, y: 438, team: 1, kind: 'grunt' });
  const state = createCombatState({ arena: field, fighters: [hero, enemy] });
  let struck = false;
  const hazardHits = [];
  const path = [];
  for (let frame = 0; frame < 480; frame++) {
    stepCombat(state, {
      hero: { attack: frame === 0 },
      enemy: frame < 6 ? {} : aiInput(enemy, hero, state),
    });
    path.push([enemy.x, enemy.y]);
    struck ||= state.events.some((entry) => entry.type === 'hit'
      && entry.target === enemy.id && entry.source === hero.id);
    if (state.events.some((entry) => entry.type === 'hit'
        && entry.target === enemy.id && entry.source === 'hazard:thorns')) hazardHits.push(frame);
  }
  assert.equal(struck, true, 'the enemy is first knocked away by an actual punch');
  assert.ok(path.some(([x]) => Math.abs(x - hero.x) < 95),
    'the recovering enemy resumes pursuit instead of staying away indefinitely');
  assert.equal(hazardHits.length, 0,
    `approaching again must not turn into repeated thorn hits (${hazardHits})`);
});

test('hazard avoidance still lets a pursuer climb to a player on the upper tier', () => {
  const field = arena({ width: 1920, platforms: [
    { x: 500, y: 338, w: 200, h: 14 },
    { x: 540, y: 238, w: 160, h: 14 },
  ], hazards: [{ type: 'thorns', x: 594, y: 424, w: 76, h: 14, damage: 2 }] });
  const result = pursueThroughHazards({
    field, heroX: 600, heroY: 238, enemyX: 850, kind: 'rusher',
  });
  assert.ok(result.path.some(([x, y]) => Math.abs(x - 600) < 85 && Math.abs(y - 238) < 3),
    'the pursuer reaches the actual upper fighting surface');
  assert.equal(result.hazardHits.length, 0,
    `climbing should not require repeated thorn damage (${result.hazardHits})`);
});

test('nearby traps with no safe landing leave the pursuer waiting on the safe side', () => {
  const field = arena({ width: 1920, hazards: [
    { type: 'thorns', x: 600, y: 424, w: 135, h: 14, damage: 2 },
    // The six-pixel gap is narrower than a fighter, and the combined zone
    // cannot be cleared by one safe leap, even with a mid-air dash.
    { type: 'thorns', x: 741, y: 424, w: 134, h: 14, damage: 2 },
  ] });
  const result = pursueThroughHazards({ field, heroX: 420, enemyX: 1050 });
  const safeEdge = 875 + result.enemy.width * 0.43;
  assert.ok(result.path.some(([x]) => x < 950), 'the enemy walks up to inspect the route');
  assert.ok(result.path.every(([x]) => x >= safeEdge),
    'the enemy does not walk or land inside either hazard');
  assert.ok(result.path.every(([, y]) => y >= field.groundY - 8),
    'an impossible crossing should not start an inevitably harmful leap');
  assert.equal(result.hazardHits.length, 0);
  const tail = result.path.slice(-120).map(([x]) => x);
  assert.ok(Math.max(...tail) - Math.min(...tail) < 12,
    'after approaching, it waits instead of repeatedly running back and forth');
});

test('a trap reaching either world edge never tempts the enemy into a dead-end jump', () => {
  const cases = [
    { heroX: 20, enemyX: 350, hazard: { x: 0, w: 170 }, side: 'right' },
    { heroX: 940, enemyX: 600, hazard: { x: 800, w: 160 }, side: 'left' },
  ];
  for (const { heroX, enemyX, hazard, side } of cases) {
    const field = arena({ width: 960, hazards: [{
      type: 'thorns', y: 424, h: 14, damage: 2, ...hazard,
    }] });
    const result = pursueThroughHazards({ field, heroX, enemyX });
    const clearance = result.enemy.width * 0.43;
    const safeEdge = side === 'right'
      ? hazard.x + hazard.w + clearance : hazard.x - clearance;
    assert.ok(result.path.some(([x]) => Math.abs(x - safeEdge) < 50),
      `${side} side: enemy should approach the obstacle before waiting`);
    assert.ok(result.path.every(([x]) => side === 'right'
      ? x >= safeEdge : x <= safeEdge),
    `${side} side: no room to land beyond the world boundary`);
    assert.ok(result.path.every(([, y]) => y >= field.groundY - 8),
      `${side} side: no useless leap toward an impossible landing`);
    assert.equal(result.hazardHits.length, 0, `${side} side: no trap damage`);
  }
});

test('a ground trap underneath a high platform does not block movement on the plank', () => {
  const field = arena({ width: 1920,
    platforms: [{ x: 480, y: 338, w: 440, h: 14 }],
    hazards: [{ type: 'thorns', x: 594, y: 424, w: 76, h: 14, damage: 2 }],
  });
  const result = pursueThroughHazards({
    field, heroX: 850, heroY: 338, enemyX: 520, enemyY: 338, frames: 260,
  });
  assert.ok(result.path.some(([x, y]) => x > 610 && x < 655 && Math.abs(y - 338) < 3),
    'the enemy walks on the actual raised surface above the trap');
  assert.ok(result.path.some(([x]) => Math.abs(x - 850) < 85),
    'a trap far below its feet must not halt pursuit');
  assert.equal(result.hazardHits.length, 0);
  assert.equal(result.enemy.hp, result.enemy.maxHp);
});

test('a pursuer drops off the safe side of a raised platform toward a ground target', () => {
  for (const { number, kind, enemyX, heroX } of [
    { number: 16, kind: 'rusher', enemyX: 550, heroX: 877 },
    { number: 30, kind: 'boss', enemyX: 650, heroX: 1030 },
  ]) {
    const level = getLevel(number);
    const [hazard] = level.hazards;
    const plank = level.platforms.find(({ x, y }) => x > hazard.x + hazard.w
      && x < heroX && y < level.groundY - 50);
    assert.ok(plank, `level ${number} has a raised plank beyond its hazard`);
    const result = pursueThroughHazards({ field: { ...level.arena, fallingHazard: null },
      kind, enemyX, heroX, frames: 420 });
    const onPlank = result.path.findIndex(([x, y]) => x >= plank.x && x <= plank.x + plank.w
      && Math.abs(y - plank.y) < 3);
    assert.ok(onPlank >= 0, `level ${number}: enemy reaches the elevated surface`);
    const backOnGround = result.path.findIndex(([x, y], frame) => frame > onPlank
      && x > hazard.x + hazard.w && Math.abs(x - heroX) < 85
      && Math.abs(y - level.groundY) < 3);
    assert.ok(backOnGround > onPlank,
      `level ${number}: pursuer leaves the plank toward the ground target`);
    assert.equal(result.hazardHits.length, 0,
      `level ${number}: it does not loop through the hazard while choosing an exit`);
    assert.equal(result.enemy.hp, result.enemy.maxHp);
  }
});

test('level 55 heavy keeps moving toward the ground target after its first high plank', () => {
  const level = getLevel(55);
  const [hazard] = level.hazards;
  const plank = level.platforms.find(({ x, y, w }) => x < hazard.x && x + w > hazard.x
    && y < level.groundY - 50 && w > 100);
  assert.ok(plank, 'the first raised plank overlaps the fissure horizontally');
  const result = pursueThroughHazards({ field: { ...level.arena, fallingHazard: null },
    kind: 'brute', enemyX: 562, heroX: 908, frames: 420 });
  const onPlank = result.path.findIndex(([x, y]) => x >= plank.x && x <= plank.x + plank.w
    && Math.abs(y - plank.y) < 3);
  assert.ok(onPlank >= 0, 'the heavy climbs onto the plank before reaching the fissure');
  const beyondFissure = result.path.findIndex(([x, y], frame) => frame > onPlank
    && x > hazard.x + hazard.w + 20 && Math.abs(x - 908) < 85
    && Math.abs(y - level.groundY) < 3);
  assert.ok(beyondFissure > onPlank,
    'after the plank, the heavy reaches the safe ground near the target');
  assert.ok(result.path.slice(beyondFissure).every(([x]) => x > hazard.x + hazard.w),
    'once past the fissure, it does not reverse back into the same trap');
  assert.equal(result.hazardHits.length, 0);
  assert.equal(result.enemy.hp, result.enemy.maxHp);
});

test('a campaign spear spends one of five throws only when it actually launches', () => {
  const state = sparring(520);
  const [hero, enemy] = state.fighters;
  assert.equal(state.spearRemaining, SPEARS_PER_LEVEL);
  const events = [];
  stepCombat(state, { hero: { spear: true } });
  events.push(...state.events);
  assert.equal(hero.spearAiming, true);
  assert.equal(hero.spearWindup, 0);
  assert.equal(state.spearRemaining, SPEARS_PER_LEVEL, 'aiming does not spend a throw');
  assert.ok(state.events.some((entry) => entry.type === 'spear-aim'));
  for (let frame = 0; frame < SPEAR_WINDUP_TICKS + 5; frame++) {
    stepCombat(state, { hero: { spear: true } });
    events.push(...state.events);
    assert.equal(hero.spearAiming, true, 'holding I must not confirm or launch');
  }
  assert.equal(state.projectiles.length, 0);
  stepCombat(state, { hero: { spear: false } });
  stepCombat(state, { hero: { spear: true } });
  events.push(...state.events);
  assert.equal(hero.spearAiming, false);
  assert.equal(hero.spearWindup, SPEAR_WINDUP_TICKS - 1);
  assert.ok(state.events.some((entry) => entry.type === 'spear-windup'));
  assert.equal(state.spearRemaining, SPEARS_PER_LEVEL, 'confirming the windup does not spend a throw');
  for (let frame = 0; frame < SPEAR_WINDUP_TICKS + 35; frame++) {
    stepCombat(state, { hero: { spear: true } });
    events.push(...state.events);
  }
  assert.equal(events.filter((entry) => entry.type === 'spear-throw').length, 1);
  assert.equal(state.spearRemaining, SPEARS_PER_LEVEL - 1);
  assert.equal(events.filter((entry) => entry.type === 'spear-impact').length, 1);
  assert.equal(events.filter((entry) => entry.type === 'hit' && entry.source === 'hero').length, 1);
  assert.equal(events.find((entry) => entry.type === 'hit' && entry.source === 'hero').delivery, 'spear',
    'projectile contact stays distinguishable from the melee ink-strike effect');
  assert.equal(enemy.hp, 42 - 22);
  assert.equal(state.projectiles.length, 0);
  stepCombat(state, { hero: { spear: false } });
  stepCombat(state, { hero: { spear: true } });
  assert.ok(state.events.some((entry) => entry.type === 'spear-aim'));
  stepCombat(state, { hero: { spear: false } });
  stepCombat(state, { hero: { spear: true } });
  assert.ok(state.events.some((entry) => entry.type === 'spear-windup'));
  assert.equal(state.spearRemaining, SPEARS_PER_LEVEL - 1);
  assert.equal(hero.spearCooldown, 0);
});

test('five launches exhaust the room allowance, while held or extra spear inputs never fire a sixth', () => {
  const state = sparring(800);
  const hero = state.fighters[0];
  state.fighters[1].hp = 0; // Keep every flight independent of enemy hitstop.
  let thrown = 0;
  for (let use = 0; use < SPEARS_PER_LEVEL; use++) {
    stepCombat(state, { hero: { spear: true } });
    assert.equal(hero.spearAiming, true, `throw ${use + 1} begins with an aim`);
    assert.equal(state.spearRemaining, SPEARS_PER_LEVEL - use);
    stepCombat(state, { hero: { spear: false } });
    stepCombat(state, { hero: { spear: true } });
    assert.ok(hero.spearWindup > 0);
    assert.equal(state.spearRemaining, SPEARS_PER_LEVEL - use);
    for (let frame = 1; frame < SPEAR_WINDUP_TICKS; frame++) {
      stepCombat(state, { hero: { spear: true } });
      thrown += state.events.filter((entry) => entry.type === 'spear-throw').length;
    }
    assert.equal(thrown, use + 1, 'a windup produces exactly one projectile');
    assert.equal(state.spearRemaining, SPEARS_PER_LEVEL - use - 1);
    stepCombat(state, { hero: { spear: true } });
    assert.equal(hero.spearAiming, false, 'holding I does not start another aim');
    stepCombat(state, { hero: { spear: false } });
  }
  for (let frame = 0; frame < 30; frame++) {
    stepCombat(state, { hero: { spear: frame % 2 === 0 } });
    assert.equal(hero.spearAiming, false, 'zero remaining cannot enter aim');
    assert.equal(hero.spearWindup, 0);
    assert.equal(state.spearRemaining, 0);
    assert.ok(!state.events.some((entry) => entry.type === 'spear-aim'
      || entry.type === 'spear-windup' || entry.type === 'spear-throw'));
  }
  assert.equal(state.projectileSerial, SPEARS_PER_LEVEL);
});

test('near, middle and distant throws follow visible parabolic arcs and still hit', () => {
  for (const [distance, rise] of [[120, 4], [300, 7], [620, 60]]) {
    const state = sparring(300 + distance);
    const launchY = state.fighters[0].y - state.fighters[0].height * 0.65;
    const samples = [];
    const observed = [];
    for (let frame = 0; frame < SPEAR_WINDUP_TICKS + 75 && !observed.some((entry) => entry.type === 'spear-impact'); frame++) {
      stepCombat(state, { hero: { spear: frame === 0 || frame === 2 } });
      observed.push(...state.events);
      if (state.projectiles.length) samples.push(state.projectiles[0].y);
    }
    assert.ok(observed.some((entry) => entry.type === 'spear-throw'), `${distance}px launch`);
    assert.ok(observed.some((entry) => entry.type === 'spear-impact'
      && entry.target === 'enemy' && entry.damage === 22), `${distance}px hit`);
    const apexY = Math.min(...samples);
    assert.ok(apexY <= launchY - rise,
      `${distance}px trajectory rises ${Math.round(launchY - apexY)}px, expected at least ${rise}px`);
    if (distance >= 300) {
      assert.ok(samples.at(-1) > apexY + rise * 0.45,
        `${distance}px trajectory descends after its apex`);
    }
    assert.equal(state.fighters[1].hp, 20);
  }
});

test('the shared spear arc predicts every discrete gravity step and its locked aim point', () => {
  for (const [aimX, aimY] of [[320, 380], [620, 250], [820, 400]]) {
    const flight = spearFlight(200, 300, aimX, aimY);
    assert.deepEqual(spearTrajectoryPoint(200, 300, flight, 0), { x: 200, y: 300 });
    const endpoint = spearTrajectoryPoint(200, 300, flight, flight.ticks);
    assert.ok(Math.abs(endpoint.x - aimX) < 1e-9);
    assert.ok(Math.abs(endpoint.y - aimY) < 1e-9);
    let x = 200;
    let y = 300;
    let vy = flight.vy;
    for (let tick = 1; tick <= Math.floor(flight.ticks); tick++) {
      vy += SPEAR_GRAVITY;
      x += flight.vx;
      y += vy;
      const point = spearTrajectoryPoint(200, 300, flight, tick);
      assert.ok(Math.abs(point.x - x) < 1e-9);
      assert.ok(Math.abs(point.y - y) < 1e-9);
    }
  }
});

test('manual aim uses bounded angles, optional finite pointer input, and locks facing on confirm', () => {
  const state = sparring(800);
  const hero = state.fighters[0];
  assert.equal(SPEAR_MIN_ANGLE, 8);
  assert.equal(SPEAR_MAX_ANGLE, 72);
  stepCombat(state, { hero: { spear: true } });
  const seededAngle = hero.spearAimAngle;
  assert.ok(seededAngle >= SPEAR_MIN_ANGLE && seededAngle <= SPEAR_MAX_ANGLE);
  stepCombat(state, { hero: { aimUp: true, right: true } });
  assert.equal(hero.spearAimAngle, Math.min(SPEAR_MAX_ANGLE, seededAngle + 1.25));
  assert.ok(hero.vx > 0, 'movement remains available in aim mode');
  stepCombat(state, { hero: { aimAngle: 999 } });
  assert.equal(hero.spearAimAngle, SPEAR_MAX_ANGLE);
  stepCombat(state, { hero: { aimAngle: -200 } });
  assert.equal(hero.spearAimAngle, SPEAR_MIN_ANGLE);
  stepCombat(state, { hero: { aimAngle: Infinity, aimDown: true } });
  assert.equal(hero.spearAimAngle, SPEAR_MIN_ANGLE, 'non-finite pointer angles are ignored');
  stepCombat(state, { hero: { aimAngle: 32.5, left: true } });
  assert.equal(hero.facing, -1);
  assert.equal(hero.spearAimAngle, 32.5);

  stepCombat(state, { hero: { spear: true } });
  assert.equal(hero.spearAiming, false);
  assert.equal(hero.spearWindup, SPEAR_WINDUP_TICKS - 1);
  assert.equal(hero.spearLaunchFacing, -1);
  assert.equal(state.events.find((entry) => entry.type === 'spear-windup')?.angle, 32.5);
  for (let tick = 1; tick < SPEAR_WINDUP_TICKS; tick++) {
    stepCombat(state, { hero: { right: true, aimAngle: 70, aimUp: true } });
  }
  const thrown = state.events.find((entry) => entry.type === 'spear-throw');
  assert.ok(thrown);
  assert.equal(thrown.facing, -1);
  assert.deepEqual({ vx: thrown.vx, vy: thrown.vy }, spearAimedFlight(-1, 32.5));
  assert.equal(hero.spearAimAngle, 32.5, 'aim inputs cannot retarget a committed throw');
  assert.equal(hero.spearLaunchFacing, null);
});

test('manual preview and real projectile share their origin, velocity and each discrete gravity step', () => {
  const state = sparring(800);
  const hero = state.fighters[0];
  stepCombat(state, { hero: { spear: true } });
  stepCombat(state, { hero: { aimAngle: 33 } });
  assert.equal(hero.spearAimAngle, 33);
  stepCombat(state, { hero: { spear: true } });
  for (let tick = 1; tick < SPEAR_WINDUP_TICKS; tick++) stepCombat(state);
  const thrown = state.events.find((entry) => entry.type === 'spear-throw');
  assert.ok(thrown);
  const lockedFlight = spearAimedFlight(thrown.facing, 33);
  assert.deepEqual({ vx: thrown.vx, vy: thrown.vy }, lockedFlight);
  assert.deepEqual(spearOrigin(hero), { x: thrown.x, y: thrown.y });
  for (let tick = 1; tick <= 10; tick++) {
    if (tick > 1) stepCombat(state);
    const projectile = state.projectiles[0];
    assert.ok(projectile, `flight still exists at tick ${tick}`);
    const predicted = spearTrajectoryPoint(thrown.x, thrown.y, lockedFlight, tick);
    assert.ok(Math.abs(projectile.x - predicted.x) < 1e-9);
    assert.ok(Math.abs(projectile.y - predicted.y) < 1e-9);
  }
});

test('cancel, punch, kick, jump and dodge leave aim without throwing; a new press can start again', () => {
  for (const action of ['aimCancel', 'attack', 'kick', 'jump', 'dodge']) {
    const state = sparring(800);
    const hero = state.fighters[0];
    stepCombat(state, { hero: { spear: true } });
    stepCombat(state);
    stepCombat(state, { hero: { [action]: true } });
    assert.equal(hero.spearAiming, false, `${action} cancels the unconfirmed aim`);
    assert.equal(hero.spearWindup, 0);
    assert.equal(state.projectiles.length, 0);
    assert.equal(state.spearRemaining, SPEARS_PER_LEVEL, `${action} does not spend an unthrown spear`);
    assert.ok(state.events.some((entry) => entry.type === 'spear-aim-cancel'), `${action} has a HUD cue`);
    if (action === 'attack') assert.equal(hero.attackStage, 1);
    if (action === 'kick') assert.equal(hero.kickType, 'ground');
    if (action === 'jump') assert.ok(hero.vy < 0);
    if (action === 'dodge') assert.ok(hero.dodgeTicks > 0);
  }

  const state = sparring(800);
  const hero = state.fighters[0];
  stepCombat(state, { hero: { spear: true } });
  const tick = state.tick;
  assert.equal(cancelSpearAim(hero), true, 'blur can discard a pending aim without a simulation step');
  assert.equal(state.spearRemaining, SPEARS_PER_LEVEL);
  assert.equal(state.tick, tick);
  assert.equal(cancelSpearAim(hero), false);
  stepCombat(state, { hero: { spear: true } });
  assert.equal(hero.spearAiming, false, 'holding the original press does not restart');
  stepCombat(state);
  stepCombat(state, { hero: { spear: true } });
  assert.equal(hero.spearAiming, true, 'release and fresh press reopens aim while ammo remains');
  stepCombat(state, { hero: { spear: false, aimCancel: true } });
  stepCombat(state, { hero: { spear: true, aimCancel: true } });
  assert.equal(hero.spearAiming, false, 'cancel and I in the same tick must not reopen the aim');
});

test('a moving or jumping target cannot silently redirect a telegraphed spear', () => {
  const hero = createFighter({ id: 'hero', x: 650, y: 438 });
  const enemy = createFighter({ id: 'enemy', x: 180, y: 438, team: 1,
    kind: 'grunt', spearEnabled: true });
  enemy.facing = 1;
  const state = createCombatState({ arena: arena({ width: 1920 }), fighters: [hero, enemy] });
  stepCombat(state, { enemy: { spear: true } });
  const warning = state.events.find((entry) => entry.type === 'spear-windup');
  assert.ok(warning);
  for (let tick = 2; tick <= SPEAR_WINDUP_TICKS; tick++) {
    stepCombat(state, { hero: { right: true, jump: tick === 2 } });
  }
  const thrown = state.events.find((entry) => entry.type === 'spear-throw');
  assert.ok(thrown);
  assert.equal(state.spearRemaining, SPEARS_PER_LEVEL, 'an enemy throw never spends hero ammo');
  assert.ok(hero.x - warning.targetX > 65, 'the player has left the warned lane');
  assert.ok(warning.targetY - (hero.y - hero.height * 0.57) > 50,
    'the player has also jumped above the warned height');
  const flight = spearFlight(thrown.x, thrown.y, warning.targetX, warning.targetY);
  assert.ok(Math.abs(thrown.vx - flight.vx) < 1e-9);
  assert.ok(Math.abs(thrown.vy - flight.vy) < 1e-9);
  const first = spearTrajectoryPoint(thrown.x, thrown.y, flight, 1);
  assert.ok(Math.abs(state.projectiles[0].x - first.x) < 1e-9);
  assert.ok(Math.abs(state.projectiles[0].y - first.y) < 1e-9);
});

test('hitstop freezes both aim adjustment and the confirmed spear windup clock', () => {
  const state = sparring(520);
  stepCombat(state, { hero: { spear: true } });
  const hero = state.fighters[0];
  const initialAngle = hero.spearAimAngle;
  assert.equal(state.motionTick, 1);
  state.hitstop = 4;
  for (let frame = 0; frame < 4; frame++) {
    stepCombat(state, { hero: { aimUp: true } });
    assert.equal(state.motionTick, 1);
    assert.equal(hero.spearAimAngle, initialAngle);
  }
  stepCombat(state, { hero: { aimUp: true } });
  assert.equal(state.motionTick, 2);
  assert.equal(hero.spearAimAngle, initialAngle + 1.25);
  stepCombat(state, { hero: { spear: true } });
  const remaining = hero.spearWindup;
  assert.equal(remaining, SPEAR_WINDUP_TICKS - 1);
  state.hitstop = 4;
  const motionTick = state.motionTick;
  for (let frame = 0; frame < 4; frame++) {
    stepCombat(state, { hero: { spear: true } });
    assert.equal(state.motionTick, motionTick);
    assert.equal(hero.spearWindup, remaining);
  }
  stepCombat(state, { hero: { spear: true } });
  assert.equal(state.motionTick, motionTick + 1);
  assert.equal(hero.spearWindup, remaining - 1);
});

test('a hit cancels aim, an interrupted windup can be retried, and dodge absorbs a projectile', () => {
  const state = sparring(350);
  const [hero, enemy] = state.fighters;
  enemy.attackStage = 1;
  enemy.attackTick = 4;
  stepCombat(state, { hero: { spear: true } });
  assert.ok(state.events.some((entry) => entry.type === 'spear-aim'));
  assert.ok(state.events.some((entry) => entry.type === 'spear-aim-cancel'));
  assert.equal(hero.spearAiming, false, 'the punch interrupts the open aim');
  assert.equal(state.projectiles.length, 0);
  while (hero.stun > 0 || state.hitstop > 0) stepCombat(state);
  stepCombat(state, { hero: { spear: true } });
  assert.ok(state.events.some((entry) => entry.type === 'spear-aim'),
    'a new press after recovery starts aiming without spending for the interrupted attempt');
  stepCombat(state);
  stepCombat(state, { hero: { spear: true } });
  assert.ok(state.events.some((entry) => entry.type === 'spear-windup'));
  assert.ok(hero.spearWindup > 0);
  hero.invulnerable = 0;
  enemy.x = hero.x + 50;
  enemy.y = hero.y;
  enemy.facing = -1;
  enemy.attackStage = 1;
  enemy.attackTick = 4;
  enemy.hitIds = [];
  stepCombat(state);
  assert.equal(hero.spearWindup, 0, 'a new punch interrupts the committed throw');
  assert.equal(state.projectiles.length, 0);
  assert.equal(state.spearRemaining, SPEARS_PER_LEVEL, 'a hit during windup spends no spear');

  const guarded = sparring(350);
  const target = guarded.fighters[1];
  target.dodgeTicks = 5;
  guarded.projectiles.push({
    id: 'spear-test', kind: 'spear', source: 'hero', team: 0,
    x: 280, y: 390, vx: 120, vy: 0, radius: 7, damage: 22, ttl: 20,
  });
  stepCombat(guarded);
  assert.equal(target.hp, 42);
  assert.equal(guarded.projectiles.length, 0);
  assert.ok(guarded.events.some((entry) => entry.type === 'spear-impact'
    && entry.target === target.id && entry.blocked && entry.damage === 0));
});

test('KO clears a pending aim or windup without launching a late projectile', () => {
  for (const confirmed of [false, true]) {
    const state = sparring(350);
    const [hero, enemy] = state.fighters;
    hero.hp = 1;
    stepCombat(state, { hero: { spear: true } });
    if (confirmed) {
      stepCombat(state);
      stepCombat(state, { hero: { spear: true } });
      assert.ok(hero.spearWindup > 0);
    }
    enemy.x = hero.x + 50;
    enemy.facing = -1;
    enemy.attackStage = 1;
    enemy.attackTick = 4;
    stepCombat(state);
    assert.equal(hero.hp, 0);
    assert.equal(hero.spearAiming, false);
    assert.equal(hero.spearWindup, 0);
    assert.equal(hero.spearLaunchFacing, null);
    assert.equal(state.projectiles.length, 0);
    assert.equal(state.spearRemaining, SPEARS_PER_LEVEL, 'KO cannot spend an unthrown spear');
    assert.ok(state.events.some((entry) => entry.type === 'ko' && entry.target === hero.id));
  }
});

test('swept spears stop on static, floating and rotating wooden platforms', () => {
  for (const platform of [
    { x: 350, y: 344, w: 100, h: 14 },
    { x: 350, y: 344, w: 100, h: 14, motion: 'float', baseY: 344,
      period: 120, amplitude: 10, phase: 0 },
    { x: 350, y: 344, w: 100, h: 14, motion: 'rotate', baseX: 400, baseY: 344,
      baseAngle: 0, period: 120, amplitude: 0.22, phase: 30 },
  ]) {
    const state = createCombatState({ arena: arena({ platforms: [platform] }),
      fighters: sparring(520).fighters });
    state.projectiles.push({
      id: 'spear-platform', kind: 'spear', source: 'hero', team: 0,
      x: 300, y: 350, vx: 200, vy: 0, radius: 7, damage: 22, ttl: 20,
    });
    stepCombat(state);
    assert.equal(state.fighters[1].hp, 42);
    assert.equal(state.projectiles.length, 0);
    assert.ok(state.events.some((entry) => entry.type === 'spear-impact'
      && entry.surface === 'platform' && entry.target === null));
  }
});

test('opposing projectiles can trade a same-frame KO regardless of array order', () => {
  const run = (reverse) => {
    const state = sparring(390);
    state.fighters.forEach((fighter) => { fighter.hp = 1; });
    const shots = [
      { id: 'spear-a', kind: 'spear', source: 'hero', team: 0,
        x: 320, y: 390, vx: 100, vy: 0, radius: 7, damage: 10, ttl: 20 },
      { id: 'spear-b', kind: 'spear', source: 'enemy', team: 1,
        x: 370, y: 390, vx: -100, vy: 0, radius: 7, damage: 10, ttl: 20 },
    ];
    state.projectiles.push(...(reverse ? shots.reverse() : shots));
    stepCombat(state);
    return {
      hp: state.fighters.map((fighter) => fighter.hp),
      knockouts: state.events.filter((entry) => entry.type === 'ko')
        .map(({ target, source }) => ({ target, source })).sort((a, b) => a.target.localeCompare(b.target)),
    };
  };
  assert.deepEqual(run(false), run(true));
  assert.deepEqual(run(false), {
    hp: [0, 0], knockouts: [
      { target: 'enemy', source: 'hero' }, { target: 'hero', source: 'enemy' },
    ],
  });
});

test('a duel cannot create spears even from a forged input or enabled fighter', () => {
  const state = createDuelState();
  state.fighters[0].spearEnabled = true;
  for (let frame = 0; frame < 70; frame++) {
    stepCombat(state, { p1: {
      spear: frame % 3 === 0, aimUp: true, aimAngle: 72, aimCancel: frame % 7 === 0,
    } });
    assert.equal(state.projectiles.length, 0);
    assert.equal(state.fighters[0].spearAiming, false);
    assert.equal(state.fighters[0].spearWindup, 0);
    assert.ok(!state.events.some((entry) => entry.type.startsWith('spear-')));
  }
});

test('an enemy under a two-tier target climbs instead of repeatedly punching beneath it', () => {
  const hero = createFighter({ id: 'hero', x: 600, y: 238, team: 0 });
  const enemy = createFighter({ id: 'enemy', x: 600, y: 438, team: 1, kind: 'rusher' });
  const state = createCombatState({ arena: arena({ width: 1920, platforms: [
    { x: 500, y: 338, w: 200, h: 14 },
    { x: 540, y: 238, w: 160, h: 14 },
  ] }), fighters: [hero, enemy] });
  let jumped = 0;
  let futilePunches = 0;
  for (let frame = 0; frame < 340 && hero.hp === 100; frame++) {
    const controls = aiInput(enemy, hero, state);
    if (controls.jump) jumped++;
    if (enemy.y - hero.y > 95 && controls.attack) futilePunches++;
    stepCombat(state, { enemy: controls });
  }
  assert.ok(jumped >= 2, `AI should ascend in steps, observed ${jumped} jump requests`);
  assert.equal(futilePunches, 0);
  assert.ok(hero.hp < 100, 'the pursuer eventually reaches the player on the upper platform');
});

test('enemy reaches the drifting upper platform in each chapter\'s late stages', () => {
  for (const levelNumber of [13, 14, 27, 28, 41, 42, 55, 56]) {
    const level = getLevel(levelNumber);
    const drift = level.platforms.find((platform) => platform.motion === 'float'
      && platform.axis === 'x');
    assert.ok(drift, `level ${levelNumber} includes the late horizontal platform`);
    const pose = platformPose(drift, 0);
    const hero = createFighter({ id: 'hero', x: pose.centerX, y: pose.centerY });
    hero.invulnerable = 10000;
    const enemy = createFighter({ id: 'enemy', x: hero.x - 160,
      y: level.groundY, team: 1, kind: 'rusher' });
    const state = createCombatState({ arena: { ...level.arena, hazards: [], fallingHazard: null },
      fighters: [hero, enemy] });
    let jumps = 0;
    let landedBesideHero = false;
    let attacks = 0;
    for (let frame = 0; frame < 360; frame++) {
      const controls = aiInput(enemy, hero, state);
      if (controls.jump) jumps++;
      if (controls.attack) attacks++;
      stepCombat(state, { enemy: controls });
      if (enemy.grounded && Math.abs(enemy.y - hero.y) < 2) landedBesideHero = true;
    }
    assert.ok(jumps >= 2, `level ${levelNumber}: pursuer keeps climbing after its first step`);
    assert.equal(landedBesideHero, true, `level ${levelNumber}: reaches the drifting plank`);
    assert.ok(attacks > 0, `level ${levelNumber}: attacks once it can actually hit`);
  }
});

test('a close enemy uses its reachable punch lane instead of jumping at the player', () => {
  const hero = createFighter({ id: 'hero', x: 600, y: 338 });
  const enemy = createFighter({ id: 'enemy', x: 630, y: 383, team: 1, kind: 'rusher' });
  const boss = createFighter({ id: 'boss', x: 660, y: 413, team: 1, kind: 'boss' });
  const state = createCombatState({ arena: arena(), fighters: [hero, enemy, boss] });
  let attacks = 0;
  for (let tick = 0; tick < 120; tick++) {
    state.tick = tick;
    for (const attacker of [enemy, boss]) {
      const controls = aiInput(attacker, hero, state);
      assert.equal(controls.jump, false, `${attacker.kind} has a reachable punch lane`);
      if (controls.attack) attacks++;
    }
  }
  assert.ok(attacks > 0);
});

test('an enemy above the player walks off its platform and reacquires a reachable attack lane', () => {
  const hero = createFighter({ id: 'hero', x: 450, y: 438, team: 0 });
  const enemy = createFighter({ id: 'enemy', x: 450, y: 338, team: 1, kind: 'rusher' });
  const state = createCombatState({ arena: arena({ platforms: [
    { x: 400, y: 338, w: 140, h: 14 },
  ] }), fighters: [hero, enemy] });
  let escapedPlatform = false;
  let uselessPunches = 0;
  for (let frame = 0; frame < 260 && hero.hp === 100; frame++) {
    const controls = aiInput(enemy, hero, state);
    if (enemy.y - hero.y < -95 && controls.attack) uselessPunches++;
    stepCombat(state, { enemy: controls });
    if (enemy.y > 375) escapedPlatform = true;
  }
  assert.equal(uselessPunches, 0);
  assert.equal(escapedPlatform, true, 'the pursuer leaves the upper plank');
  assert.ok(hero.hp < 100, 'it reaches and strikes the player below');
});

test('campaign fighters and hazards can advance into the 1920px half, while PvP stays 960px', () => {
  const hero = createFighter({ id: 'hero', x: 980, y: 438, team: 0 });
  const state = createCombatState({ arena: arena({ width: 1920,
    fallingHazard: fallingHazard({ firstTick: 1, warningTicks: 1 }) }), fighters: [hero] });
  for (let frame = 0; frame < 125; frame++) stepCombat(state, { hero: { right: true } });
  assert.ok(hero.x > 1100 && hero.x <= 1901);
  assert.equal(state.arena.width, 1920);
  const duel = createDuelState();
  assert.equal(duel.arena.width, 960);
  duel.fighters[1].x = 940;
  duel.fighters[1].vx = 20;
  stepCombat(duel);
  assert.equal(duel.fighters[1].x, 941);
});

test('a genuine campaign KO leaves a supported corpse for 27 plus 180 effective frames', () => {
  const state = sparring(350);
  const [hero, enemy] = state.fighters;
  enemy.hp = 1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  stepCombat(state);
  assert.equal(enemy.hp, 0);
  assert.ok(state.events.some((entry) => entry.type === 'ko' && entry.target === enemy.id));
  assert.equal(state.corpses.length, 1);
  const corpse = state.corpses[0];
  assert.deepEqual([
    corpse.id, corpse.kind, corpse.team, corpse.facing, corpse.width, corpse.height,
    corpse.x, corpse.y, corpse.koX, corpse.koY,
  ], [enemy.id, enemy.kind, 1, enemy.facing, enemy.width, enemy.height,
    enemy.x, state.arena.groundY, enemy.x, enemy.y]);
  assert.equal(corpse.settleTick - corpse.bornTick, CORPSE_SETTLE_TICKS);
  assert.equal(corpse.expireTick - corpse.settleTick, CORPSE_HOLD_TICKS);
  const frozenTick = state.motionTick;
  const frozenFrames = state.hitstop;
  for (let frame = 0; frame < frozenFrames; frame++) stepCombat(state);
  assert.equal(state.motionTick, frozenTick, 'hitstop cannot age the body');
  assert.equal(state.corpses.length, 1);
  while (state.motionTick < corpse.expireTick - 1) stepCombat(state);
  assert.equal(state.corpses.length, 1);
  stepCombat(state);
  assert.equal(state.motionTick, corpse.expireTick);
  assert.equal(state.corpses.length, 0, 'it expires without a second KO event');
  assert.ok(!state.events.some((entry) => entry.type === 'ko' || entry.type === 'bones-scatter'));
});

test('walk-away and re-entry scatters once; an overhead jump or stationary landing does not', () => {
  const state = sparring(342);
  const [hero, enemy] = state.fighters;
  enemy.hp = 1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  stepCombat(state);
  const corpse = state.corpses[0];
  assert.equal(corpse.wasInside, false, 'the killer begins in front of the fallen feet');
  while (state.motionTick < corpse.settleTick) stepCombat(state, { hero: { left: true } });
  assert.equal(state.corpses.length, 1);
  assert.equal(corpse.wasInside, false, 'the player remains outside the body region');
  const hp = hero.hp;
  hero.x = corpse.x - 31;
  hero.y = corpse.y - 90;
  hero.vx = 0;
  hero.vy = 0;
  hero.grounded = false;
  for (let frame = 0; frame < 8; frame++) {
    stepCombat(state, { hero: { right: true } });
    assert.ok(!state.events.some((entry) => entry.type === 'bones-scatter'));
  }
  assert.ok(hero.x > corpse.x - 20, 'the jump enters the silhouette horizontally');
  assert.equal(corpse.wasInside, false, 'airborne overlap does not occupy the grounded body');
  hero.y = corpse.y;
  hero.vy = 0;
  hero.vx = 0;
  hero.grounded = true;
  stepCombat(state);
  assert.equal(state.corpses.length, 1, 'dropping vertically into an occupied region is not a walk-over');
  assert.equal(corpse.wasInside, true, 'a stationary landing occupies the body until exit');
  for (let frame = 0; frame < 24 && corpse.wasInside; frame++) {
    stepCombat(state, { hero: { left: true } });
  }
  assert.equal(corpse.wasInside, false);
  let scatters = [];
  for (let frame = 0; frame < 50 && state.corpses.length; frame++) {
    stepCombat(state, { hero: { right: true } });
    scatters.push(...state.events.filter((entry) => entry.type === 'bones-scatter'));
  }
  assert.equal(state.corpses.length, 0);
  assert.equal(scatters.length, 1);
  assert.deepEqual({ target: scatters[0].target, x: scatters[0].x, y: scatters[0].y,
    kind: scatters[0].kind, facing: scatters[0].facing,
    width: scatters[0].width, height: scatters[0].height },
  { target: enemy.id, x: corpse.x, y: corpse.y, kind: corpse.kind,
    facing: corpse.facing, width: corpse.width, height: corpse.height });
  assert.equal(hero.hp, hp);
  for (let frame = 0; frame < 20; frame++) {
    stepCombat(state, { hero: { left: true } });
    assert.ok(!state.events.some((entry) => entry.type === 'bones-scatter'
      || entry.type === 'ko'));
  }
});

test('a corpse rides a drifting plank, but one on the ground cannot be scattered from above', () => {
  const plank = { x: 400, y: 338, w: 140, h: 14, motion: 'float', axis: 'x',
    baseX: 400, baseY: 338, amplitude: 32, period: 120 };
  const hero = createFighter({ id: 'hero', x: 430, y: 338, team: 0 });
  const enemy = createFighter({ id: 'enemy', x: 470, y: 338, team: 1, kind: 'grunt' });
  enemy.hp = 1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  const state = createCombatState({ fighters: [hero, enemy], arena: arena({ platforms: [plank] }) });
  stepCombat(state);
  assert.equal(state.corpses.length, 1);
  const corpse = state.corpses[0];
  assert.equal(corpse.platformIndex, 0);
  const startX = corpse.x;
  while (state.motionTick < corpse.settleTick) stepCombat(state);
  const pose = platformPose(plank, state.motionTick);
  assert.ok(Math.abs(corpse.x - (pose.left + (pose.right - pose.left) * corpse.supportT)) < 1e-9);
  assert.ok(corpse.x > startX, 'the corpse travels with its platform');
  assert.equal(corpse.y, 338);
  hero.x = corpse.x - 25;
  hero.y = 238;
  hero.vx = 0;
  hero.vy = 0;
  hero.grounded = false;
  for (let frame = 0; frame < 6; frame++) {
    stepCombat(state, { hero: { right: true } });
    assert.ok(!state.events.some((entry) => entry.type === 'bones-scatter'));
  }
  assert.equal(state.corpses.length, 1);
  hero.x = corpse.x - 50;
  hero.y = corpse.y;
  hero.vx = 0;
  hero.vy = 0;
  hero.grounded = true;
  stepCombat(state);
  assert.equal(corpse.wasInside, false);
  let sharedPlankScatter = null;
  for (let frame = 0; frame < 25 && !sharedPlankScatter; frame++) {
    stepCombat(state, { hero: { right: true } });
    sharedPlankScatter = state.events.find((entry) => entry.type === 'bones-scatter');
  }
  assert.ok(sharedPlankScatter, 'walking on the same translating plank reaches the body');

  const ground = sparring(342);
  ground.arena.platforms = [{ x: 280, y: 338, w: 140, h: 14 }];
  ground.fighters[1].hp = 1;
  ground.fighters[0].attackStage = 1;
  ground.fighters[0].attackTick = 4;
  stepCombat(ground);
  const groundCorpse = ground.corpses[0];
  assert.equal(groundCorpse.y, 438, 'an overhead plank cannot catch a ground KO');
  while (ground.motionTick < groundCorpse.settleTick) stepCombat(ground);
  const upperHero = ground.fighters[0];
  upperHero.x = groundCorpse.x - 60;
  upperHero.y = 338;
  upperHero.vx = 0;
  upperHero.vy = 0;
  upperHero.grounded = true;
  for (let frame = 0; frame < 14; frame++) {
    stepCombat(ground, { hero: { right: true } });
    assert.ok(!ground.events.some((entry) => entry.type === 'bones-scatter'));
  }
  assert.equal(ground.corpses.length, 1);
});

test('walk-over contact covers the rendered head and flips inward at a world edge', () => {
  const ordinary = sparring(350);
  ordinary.fighters[1].hp = 1;
  ordinary.fighters[0].attackStage = 1;
  ordinary.fighters[0].attackTick = 4;
  stepCombat(ordinary);
  const body = ordinary.corpses[0];
  const walker = ordinary.fighters[0];
  walker.x = body.x + 140;
  walker.vx = 0;
  while (ordinary.motionTick < body.settleTick) stepCombat(ordinary);
  assert.equal(body.wasInside, false);
  let headScatter = null;
  for (let frame = 0; frame < 30 && !headScatter; frame++) {
    stepCombat(ordinary, { hero: { left: true } });
    headScatter = ordinary.events.find((entry) => entry.type === 'bones-scatter');
  }
  assert.ok(headScatter);
  assert.ok(walker.x > body.x + 100, 'the visible head, not only the feet, is walkable');

  const hero = createFighter({ id: 'hero', x: 1855, y: 438, team: 0 });
  const enemy = createFighter({ id: 'edge-enemy', x: 1895, y: 438, team: 1, kind: 'grunt' });
  enemy.hp = 1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  const edge = createCombatState({ fighters: [hero, enemy], arena: arena({ width: 1920 }) });
  stepCombat(edge);
  const flipped = edge.corpses[0];
  hero.x = flipped.x - 150;
  hero.vx = 0;
  while (edge.motionTick < flipped.settleTick) stepCombat(edge);
  let inwardScatter = null;
  for (let frame = 0; frame < 30 && !inwardScatter; frame++) {
    stepCombat(edge, { hero: { right: true } });
    inwardScatter = edge.events.find((entry) => entry.type === 'bones-scatter');
  }
  assert.ok(inwardScatter);
  assert.ok(hero.x < flipped.x - 90, 'the reversed head is inside the arena');
});

test('a grounded hero on a shallow overhead plank cannot scatter a ground corpse through it', () => {
  const state = sparring(350);
  state.arena.platforms = [{ x: 320, y: 420, w: 200, h: 14 }];
  const [hero, enemy] = state.fighters;
  enemy.hp = 1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  stepCombat(state);
  const corpse = state.corpses[0];
  assert.equal(corpse.platformIndex, null);
  assert.equal(corpse.y - 420, 18, 'the plank is inside the former loose foot-height tolerance');
  while (state.motionTick < corpse.settleTick) stepCombat(state);
  hero.x = corpse.x + 140;
  hero.y = 420;
  hero.vx = 0;
  hero.vy = 0;
  hero.grounded = true;
  stepCombat(state); // The player starts beyond the visible fallen head.
  assert.equal(corpse.wasInside, false);
  for (let frame = 0; frame < 15; frame++) {
    stepCombat(state, { hero: { left: true } });
    assert.equal(hero.grounded, true);
    assert.ok(!state.events.some((entry) => entry.type === 'bones-scatter'));
  }
  assert.equal(corpse.wasInside, false, 'an upper-platform crossing does not consume a ground entry');
  assert.equal(state.corpses.length, 1, 'close feet at different support levels do not count');

  hero.x = corpse.x + 140;
  hero.y = state.arena.groundY;
  hero.vx = 0;
  hero.vy = 0;
  hero.grounded = true;
  stepCombat(state);
  assert.equal(corpse.wasInside, false);
  let scatter = null;
  for (let frame = 0; frame < 30 && !scatter; frame++) {
    stepCombat(state, { hero: { left: true } });
    scatter = state.events.find((entry) => entry.type === 'bones-scatter');
  }
  assert.ok(scatter, 'walking along the actual ground still scatters it');
});

test('an upper-stair overlap remains armed until a walking stair-to-ground transition', () => {
  const state = sparring(350);
  state.arena.platforms = [{ x: 400, y: 426, w: 140, h: 14 }];
  const [hero, enemy] = state.fighters;
  enemy.hp = 1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  stepCombat(state);
  const corpse = state.corpses[0];
  assert.equal(corpse.platformIndex, null);
  while (state.motionTick < corpse.settleTick) stepCombat(state);
  hero.x = 510;
  hero.y = 426;
  hero.vx = 0;
  hero.vy = 0;
  hero.grounded = true;
  stepCombat(state);
  assert.equal(corpse.wasInside, false);
  let scatter = null;
  let overlappedFromAbove = false;
  for (let frame = 0; frame < 70 && !scatter; frame++) {
    stepCombat(state, { hero: { left: true } });
    if (hero.x < corpse.x + 105 && hero.y === 426) {
      overlappedFromAbove = true;
      assert.equal(corpse.wasInside, false, 'the stair crossing has not consumed ground entry');
    }
    scatter = state.events.find((entry) => entry.type === 'bones-scatter');
  }
  assert.equal(overlappedFromAbove, true);
  assert.ok(scatter, 'the seamless grounded step down enters the ground corpse');
  assert.equal(hero.y, state.arena.groundY);
  assert.equal(state.corpses.length, 0);
});

test('an upper-stair overlap at the original KO does not disarm its later ground entry', () => {
  const plank = { x: 400, y: 426, w: 140, h: 14 };
  const hero = createFighter({ id: 'hero', team: 0, x: 410, y: 426 });
  const enemy = createFighter({ id: 'enemy', team: 1, x: 350, y: 438, kind: 'grunt' });
  hero.facing = -1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  enemy.hp = 1;
  const state = createCombatState({ arena: arena({ platforms: [plank] }), fighters: [hero, enemy] });
  stepCombat(state);
  const corpse = state.corpses[0];
  assert.ok(corpse);
  assert.equal(corpse.platformIndex, null);
  assert.ok(hero.x > corpse.x && hero.x < corpse.x + 105,
    'the killer is horizontally inside the corpse at the KO');
  assert.equal(corpse.wasInside, false, 'different supports cannot disarm at creation');
  while (state.motionTick < corpse.settleTick) stepCombat(state);
  let scatter = null;
  for (let frame = 0; frame < 30 && !scatter; frame++) {
    stepCombat(state, { hero: { left: true } });
    scatter = state.events.find((entry) => entry.type === 'bones-scatter');
  }
  assert.equal(scatter?.target, enemy.id);
  assert.equal(hero.y, state.arena.groundY);
});

test('walking into an unsettled body arms its same-support occupancy without a delayed scatter', () => {
  const state = sparring(350);
  const [hero, enemy] = state.fighters;
  enemy.hp = 1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  stepCombat(state);
  const corpse = state.corpses[0];
  while (state.hitstop > 0) stepCombat(state);
  hero.x = corpse.x + 127;
  hero.vx = 0;
  for (let frame = 0; frame < 8 && !corpse.wasInside; frame++) {
    stepCombat(state, { hero: { left: true } });
    assert.ok(!state.events.some((entry) => entry.type === 'bones-scatter'));
  }
  assert.ok(state.motionTick < corpse.settleTick);
  assert.equal(corpse.wasInside, true);
  while (state.motionTick < corpse.settleTick + 3) {
    stepCombat(state);
    assert.ok(!state.events.some((entry) => entry.type === 'bones-scatter'));
  }
  for (let frame = 0; frame < 25 && corpse.wasInside; frame++) {
    stepCombat(state, { hero: { right: true } });
  }
  assert.equal(corpse.wasInside, false);
  let scatter = null;
  for (let frame = 0; frame < 25 && !scatter; frame++) {
    stepCombat(state, { hero: { left: true } });
    scatter = state.events.find((entry) => entry.type === 'bones-scatter');
  }
  assert.equal(scatter?.target, enemy.id);
});

test('a same-support overlap at KO requires leaving and re-entering after the settle', () => {
  const state = sparring(350);
  const [hero, enemy] = state.fighters;
  hero.x = 390;
  hero.facing = -1;
  enemy.hp = 1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  stepCombat(state);
  const corpse = state.corpses[0];
  assert.equal(corpse.wasInside, true, 'the KO starts with the killer on the fallen body');
  while (state.motionTick < corpse.settleTick + 4) {
    stepCombat(state);
    assert.ok(!state.events.some((entry) => entry.type === 'bones-scatter'));
  }
  assert.equal(corpse.wasInside, true);
  for (let frame = 0; frame < 35 && corpse.wasInside; frame++) {
    stepCombat(state, { hero: { left: true } });
  }
  assert.equal(corpse.wasInside, false);
  let scatter = null;
  for (let frame = 0; frame < 35 && !scatter; frame++) {
    stepCombat(state, { hero: { right: true } });
    scatter = state.events.find((entry) => entry.type === 'bones-scatter');
  }
  assert.equal(scatter?.target, enemy.id);
});

test('stunned and dodging crossings do not consume a later valid walk-over', () => {
  for (const status of ['stun', 'dodgeTicks']) {
    const state = sparring(350);
    const [hero, enemy] = state.fighters;
    enemy.hp = 1;
    hero.attackStage = 1;
    hero.attackTick = 4;
    stepCombat(state);
    const corpse = state.corpses[0];
    while (state.motionTick < corpse.settleTick) stepCombat(state);
    hero.x = corpse.x + 140;
    hero.y = corpse.y;
    hero.vx = 0;
    hero.vy = 0;
    hero.grounded = true;
    stepCombat(state);
    assert.equal(corpse.wasInside, false);
    hero[status] = 12;
    if (status === 'dodgeTicks') hero.facing = -1;
    hero.vx = -8;
    for (let frame = 0; frame < 4; frame++) {
      stepCombat(state, { hero: { left: true } });
      assert.ok(!state.events.some((entry) => entry.type === 'bones-scatter'));
    }
    assert.ok(hero.x < corpse.x + 125, `${status} crossed the head contact boundary`);
    assert.equal(corpse.wasInside, false, `${status} cannot latch a valid walk-over`);
    hero[status] = 0;
    hero.x = corpse.x + 140;
    hero.vx = 0;
    stepCombat(state);
    let scatter = null;
    for (let frame = 0; frame < 30 && !scatter; frame++) {
      stepCombat(state, { hero: { left: true } });
      scatter = state.events.find((entry) => entry.type === 'bones-scatter');
    }
    assert.equal(scatter?.target, enemy.id, status);
  }
});

test('walking along the same animated sloped plank scatters despite different foot y values', () => {
  const plank = { x: 350, y: 338, w: 320, h: 14, motion: 'rotate',
    baseX: 510, baseY: 338, baseAngle: 0.2, amplitude: 0.06, period: 120 };
  const initial = platformPose(plank, 0);
  const hero = createFighter({ id: 'hero', team: 0, x: 470,
    y: platformSurfaceY(initial, 470) });
  const enemy = createFighter({ id: 'enemy', team: 1, x: 510,
    y: platformSurfaceY(initial, 510), kind: 'grunt' });
  enemy.hp = 1;
  hero.attackStage = 1;
  hero.attackTick = 4;
  const state = createCombatState({ fighters: [hero, enemy], arena: arena({ platforms: [plank] }) });
  stepCombat(state);
  const corpse = state.corpses[0];
  assert.equal(corpse.platformIndex, 0);
  while (state.motionTick < corpse.settleTick) stepCombat(state);
  hero.x = corpse.x + 145;
  hero.y = platformSurfaceY(platformPose(plank, state.motionTick), hero.x);
  hero.vx = 0;
  hero.vy = 0;
  hero.grounded = true;
  stepCombat(state);
  assert.equal(corpse.wasInside, false);
  let scatter = null;
  for (let frame = 0; frame < 30 && !scatter; frame++) {
    stepCombat(state, { hero: { left: true } });
    scatter = state.events.find((entry) => entry.type === 'bones-scatter');
  }
  assert.ok(scatter);
  assert.ok(Math.abs(hero.y - corpse.y) > 24,
    'slope geometry, not a flat 24px foot difference, decides shared support');
});

test('PvP KOs never create campaign corpses or a post-fight walk phase', () => {
  const duel = createDuelState();
  const [first, second] = duel.fighters;
  first.x = 300;
  second.x = 340;
  second.hp = 1;
  first.attackStage = 1;
  first.attackTick = 4;
  stepCombat(duel);
  assert.equal(duel.status, 'finished');
  assert.equal(duel.corpses.length, 0);
  assert.equal(duel.aftermath, false);
});
