import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TICK_RATE, createFighter, createCombatState, createDuelState,
  stepCombat, aiInput, attackOf, kickOf,
} from '../shared/combat.js';

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
  for (let tick = 0; tick < 12; tick++) {
    stepCombat(state, { boss: { attack: tick === 0 } });
    assert.equal(state.fighters[0].hp, 100);
  }
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
