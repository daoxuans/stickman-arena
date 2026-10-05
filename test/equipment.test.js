import test from 'node:test';
import assert from 'node:assert/strict';
import { BOSS_EQUIPMENT, equipmentForBoss, getEquipment } from '../shared/equipment.js';
import { createCombatState, createDuelState, createFighter, stepCombat } from '../shared/combat.js';

const rewardLevels = [10, 14, 20, 28, 30, 40, 42, 50, 56];

function sparring(equipmentId = BOSS_EQUIPMENT[0].id, opponents = [
  createFighter({ id: 'enemy', x: 350, y: 438, team: 1, kind: 'grunt' }),
]) {
  const hero = createFighter({ id: 'hero', x: 300, y: 438, team: 0, kind: 'hero' });
  const state = createCombatState({
    mode: 'campaign',
    arena: { theme: 'forest', width: 1920, groundY: 438, platforms: [], hazards: [] },
    fighters: [hero, ...opponents],
  });
  state.equippedEquipmentId = equipmentId;
  return state;
}

function advance(state, ticks, inputForTick = () => ({})) {
  const events = [];
  for (let tick = 0; tick < ticks; tick++) {
    stepCombat(state, { hero: inputForTick(tick) });
    events.push(...state.events);
  }
  return events;
}

test('every campaign Boss has a fixed, frozen reward with bounded increasing damage', () => {
  assert.equal(Object.isFrozen(BOSS_EQUIPMENT), true);
  assert.deepEqual(BOSS_EQUIPMENT.map((item) => item.bossLevel), rewardLevels);
  assert.deepEqual(BOSS_EQUIPMENT.map((item) => item.damage), [15, 16, 17, 18, 19, 20, 21, 22, 24]);
  assert.deepEqual(BOSS_EQUIPMENT.map((item) => item.tier), [1, 1, 2, 2, 3, 3, 4, 4, 5]);
  assert.equal(new Set(BOSS_EQUIPMENT.map((item) => item.id)).size, rewardLevels.length);
  for (const item of BOSS_EQUIPMENT) {
    assert.equal(Object.isFrozen(item), true);
    assert.equal(getEquipment(item.id), item);
    assert.equal(equipmentForBoss(item.bossLevel), item);
    assert.ok(item.reach >= 88 && item.reach <= 126);
    assert.ok(item.cooldown >= 44 && item.cooldown <= 60);
    assert.ok(item.activeFrom > 0 && item.activeFrom <= item.activeTo
      && item.activeTo < item.duration);
    assert.ok(item.knockback > 0 && item.stun > 0 && item.freeze > 0);
    assert.match(item.name, /\S/);
    assert.match(item.color, /^#[0-9a-f]{6}$/i);
    assert.ok(['sweep', 'pierce', 'pulse'].includes(item.style));
  }
  for (const invalid of [null, undefined, '', 'unknown', {}, 10]) {
    assert.equal(getEquipment(invalid), null);
  }
  for (const invalid of [0, 9, 11, 55, 57, '10', null]) {
    assert.equal(equipmentForBoss(invalid), null);
  }
});

test('equipment is a committed single-target attack that hits once at its catalog damage', () => {
  const item = BOSS_EQUIPMENT[0];
  const state = sparring(item.id, [
    createFighter({ id: 'far', x: 370, y: 438, team: 1, kind: 'grunt' }),
    createFighter({ id: 'near', x: 350, y: 438, team: 1, kind: 'grunt' }),
    createFighter({ id: 'behind', x: 266, y: 438, team: 1, kind: 'grunt' }),
  ]);
  const events = advance(state, item.cooldown + 35, () => ({ equipment: true }));
  const swings = events.filter((entry) => entry.type === 'equipment-swing');
  const hits = events.filter((entry) => entry.type === 'hit' && entry.delivery === 'equipment');
  assert.equal(swings.length, 1, 'holding the attack key never re-triggers a cooled-down weapon');
  assert.deepEqual({ source: swings[0].source, equipmentId: swings[0].equipmentId,
    style: swings[0].style, color: swings[0].color, tier: swings[0].tier,
    duration: swings[0].duration, facing: swings[0].facing }, {
    source: 'hero', equipmentId: item.id, style: item.style, color: item.color,
    tier: item.tier, duration: item.duration, facing: 1,
  });
  assert.equal(hits.length, 1);
  assert.deepEqual({ target: hits[0].target, damage: hits[0].damage,
    equipmentId: hits[0].equipmentId }, {
    target: 'near', damage: item.damage, equipmentId: item.id,
  });
  assert.equal(state.fighters.find((fighter) => fighter.id === 'near').hp, 42 - item.damage);
  assert.equal(state.fighters.find((fighter) => fighter.id === 'far').hp, 42);
  assert.equal(state.fighters.find((fighter) => fighter.id === 'behind').hp, 42);
  assert.equal(state.projectiles.length, 0, 'equipment does not silently create a spear or rock');
});

test('selection changes cannot rewrite a committed swing or bypass its effective-frame cooldown', () => {
  const first = BOSS_EQUIPMENT[0];
  const later = BOSS_EQUIPMENT.at(-1);
  const state = sparring(first.id);
  const hero = state.fighters[0];
  stepCombat(state, { hero: { equipment: true } });
  assert.equal(hero.equipmentCooldown, first.cooldown);
  state.equippedEquipmentId = later.id;
  const events = advance(state, first.activeFrom - 1);
  assert.equal(events.find((entry) => entry.delivery === 'equipment').damage, first.damage,
    'the item ID is locked when the move starts, not sampled at its contact frame');

  while (state.hitstop > 0) stepCombat(state);
  stepCombat(state, { hero: { equipment: true } });
  assert.ok(!state.events.some((entry) => entry.type === 'equipment-swing'),
    'a fresh press during cooldown is not queued for later');
  stepCombat(state);
  while (hero.equipmentCooldown > 1) stepCombat(state);
  assert.equal(hero.equipmentAttackId, null);
  stepCombat(state, { hero: { equipment: true } });
  assert.equal(hero.equipmentAttackId, later.id);
  assert.ok(state.events.some((entry) => entry.type === 'equipment-swing'
    && entry.equipmentId === later.id));
});

test('the stronger last Boss reward stays finite and Boss ward still halves it', () => {
  const item = BOSS_EQUIPMENT.at(-1);
  const boss = createFighter({ id: 'boss', x: 350, y: 438, team: 1,
    kind: 'boss', maxHp: 226, bossTier: 5 });
  boss.wardTicks = 100;
  const state = sparring(item.id, [boss]);
  const hits = advance(state, item.activeFrom)
    .filter((entry) => entry.type === 'hit' && entry.delivery === 'equipment');
  assert.equal(hits.length, 0, 'no input means no equipped attack');
  const events = advance(state, item.activeFrom, (tick) => ({ equipment: tick === 0 }));
  const impact = events.find((entry) => entry.type === 'hit' && entry.delivery === 'equipment');
  assert.equal(impact.equipmentId, item.id);
  assert.equal(impact.damage, Math.ceil(item.damage / 2));
  assert.equal(boss.hp, 226 - Math.ceil(item.damage / 2));
  assert.ok(events.some((entry) => entry.type === 'boss-ward-hit'
    && entry.absorbed === item.damage - Math.ceil(item.damage / 2)));
});

test('dodging or invulnerability evades a weapon without a late second hit', () => {
  for (const protection of ['dodgeTicks', 'invulnerable']) {
    const state = sparring();
    const enemy = state.fighters[1];
    // A long dodge moves the defender out of range; activate it immediately
    // before the contact frame to exercise the shared evade path itself.
    if (protection === 'invulnerable') enemy.invulnerable = 22;
    const events = advance(state, BOSS_EQUIPMENT[0].activeFrom - 1,
      (tick) => ({ equipment: tick === 0 }));
    if (protection === 'dodgeTicks') enemy.dodgeTicks = 2;
    events.push(...advance(state, 60));
    assert.equal(enemy.hp, 42, protection);
    assert.equal(events.filter((entry) => entry.type === 'evade' && entry.target === enemy.id).length, 1);
    assert.equal(events.some((entry) => entry.type === 'hit' && entry.delivery === 'equipment'), false);
  }
});

test('equipment has exclusive recovery; a valid swing cancels unconfirmed spear aim only', () => {
  const state = sparring(BOSS_EQUIPMENT[0].id, [
    createFighter({ id: 'enemy', x: 750, y: 438, team: 1, kind: 'grunt' }),
  ]);
  const hero = state.fighters[0];
  stepCombat(state, { hero: { spear: true } });
  assert.equal(hero.spearAiming, true);
  stepCombat(state);
  stepCombat(state, { hero: { equipment: true } });
  assert.equal(hero.spearAiming, false);
  assert.equal(hero.equipmentAttackId, BOSS_EQUIPMENT[0].id);
  assert.ok(state.events.some((entry) => entry.type === 'spear-aim-cancel'));
  assert.ok(state.events.some((entry) => entry.type === 'equipment-swing'));
  assert.equal(state.spearRemaining, 5);

  const facing = hero.facing;
  stepCombat(state, { hero: {
    left: true, jump: true, attack: true, kick: true, dodge: true, spear: true,
  } });
  assert.equal(hero.facing, facing, 'a committed weapon blow locks its attack direction');
  assert.equal(hero.attackStage, 0);
  assert.equal(hero.kickType, null);
  assert.equal(hero.dodgeTicks, 0);
  assert.equal(hero.spearAiming, false);
  assert.equal(hero.spearWindup, 0);
  assert.equal(hero.jumpBuffer, 0);
  assert.equal(state.projectiles.length, 0);
  assert.ok(!state.events.some((entry) => ['jump', 'dodge', 'kick', 'spear-aim'].includes(entry.type)));

  const confirmed = sparring();
  const thrower = confirmed.fighters[0];
  stepCombat(confirmed, { hero: { spear: true } });
  stepCombat(confirmed);
  stepCombat(confirmed, { hero: { spear: true } });
  assert.ok(thrower.spearWindup > 0);
  stepCombat(confirmed, { hero: { equipment: true } });
  assert.ok(thrower.spearWindup > 0, 'gear cannot interrupt a confirmed throw');
  assert.equal(thrower.equipmentAttackId, null);
  assert.ok(!confirmed.events.some((entry) => entry.type === 'equipment-swing'));
});

test('hitstop freezes equipment active frame and cooldown, while a hit cancels the committed swing', () => {
  const state = sparring();
  const [hero, enemy] = state.fighters;
  stepCombat(state, { hero: { equipment: true } });
  const originalTick = hero.equipmentTick;
  const originalCooldown = hero.equipmentCooldown;
  const motionTick = state.motionTick;
  state.hitstop = 4;
  for (let tick = 0; tick < 4; tick++) stepCombat(state);
  assert.equal(state.motionTick, motionTick);
  assert.equal(hero.equipmentTick, originalTick);
  assert.equal(hero.equipmentCooldown, originalCooldown);

  enemy.x = hero.x + 50;
  enemy.attackStage = 1;
  enemy.attackTick = 4;
  enemy.facing = -1;
  stepCombat(state);
  assert.equal(hero.equipmentAttackId, null);
  assert.equal(hero.equipmentTick, 0);
  assert.equal(hero.equipmentHit, false);
  assert.equal(hero.equipmentCooldown, originalCooldown - 1,
    'an interrupted committed move does not refund its cooldown');
  assert.ok(state.events.some((entry) => entry.type === 'hit' && entry.target === hero.id));
});

test('same-tick enemy punch and equipped blow can trade KOs before interruption resolves', () => {
  const item = BOSS_EQUIPMENT[0];
  const state = sparring();
  const [hero, enemy] = state.fighters;
  hero.hp = 1;
  enemy.hp = 1;
  hero.equipmentAttackId = item.id;
  hero.equipmentTick = item.activeFrom - 1;
  hero.equipmentCooldown = item.cooldown;
  enemy.attackStage = 1;
  enemy.attackTick = 4;
  enemy.facing = -1;
  stepCombat(state);
  assert.deepEqual(state.fighters.map((fighter) => fighter.hp), [0, 0]);
  assert.equal(state.events.filter((entry) => entry.type === 'ko').length, 2);
  assert.ok(state.events.some((entry) => entry.type === 'hit'
    && entry.delivery === 'equipment' && entry.target === enemy.id));
});

test('invalid selection, enemy input and forged PvP inputs cannot use campaign equipment', () => {
  const invalid = sparring('forged-power-999');
  advance(invalid, 90, (tick) => ({ equipment: tick % 3 === 0 }));
  assert.equal(invalid.fighters[1].hp, 42);
  assert.equal(invalid.fighters[0].equipmentAttackId, null);

  const teamOne = sparring(BOSS_EQUIPMENT[0].id, [
    createFighter({ id: 'impostor', x: 350, y: 438, team: 1, kind: 'hero' }),
  ]);
  stepCombat(teamOne, { impostor: { equipment: true } });
  assert.equal(teamOne.fighters[0].hp, 100);
  assert.equal(teamOne.fighters[1].equipmentAttackId, null);

  const duel = createDuelState('city');
  duel.equippedEquipmentId = BOSS_EQUIPMENT.at(-1).id;
  duel.fighters[0].x = 300;
  duel.fighters[1].x = 350;
  for (let tick = 0; tick < 100; tick++) {
    stepCombat(duel, { p1: { equipment: tick % 2 === 0 } });
    assert.equal(duel.fighters[0].equipmentAttackId, null);
    assert.ok(!duel.events.some((entry) => entry.type === 'equipment-swing'
      || entry.delivery === 'equipment'));
  }
  assert.equal(duel.fighters[1].hp, 100);
  assert.equal(Object.hasOwn(createDuelState(), 'equipmentDrops'), false);
});

test('fixed equipment input sequences reproduce both damage and events', () => {
  const first = sparring(BOSS_EQUIPMENT[2].id);
  const second = sparring(BOSS_EQUIPMENT[2].id);
  const events = [];
  for (let tick = 0; tick < 125; tick++) {
    const inputs = { hero: { equipment: tick === 0 || tick === 78 } };
    stepCombat(first, inputs);
    stepCombat(second, inputs);
    events.push(...first.events);
    assert.deepEqual(first, second);
  }
  assert.equal(events.filter((entry) => entry.type === 'equipment-swing').length, 2);
  assert.equal(events.filter((entry) => entry.delivery === 'equipment').length, 1,
    'the second fixed swing does not home in on a foe knocked out of range');
  assert.equal(first.fighters[1].hp, 42 - BOSS_EQUIPMENT[2].damage);
});
