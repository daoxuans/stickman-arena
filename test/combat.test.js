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
