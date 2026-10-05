import test from 'node:test';
import assert from 'node:assert/strict';
import { CampaignSession, STORAGE_KEY } from '../public/campaign.js';
import { MAX_LEVEL, THEMES, LEVELS, checkpointFor, getLevel, isCheckpoint } from '../shared/levels.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function seedProgress(currentLevel, checkpointLevel, cleared = []) {
  return storage({
    [STORAGE_KEY]: JSON.stringify({
      currentLevel, checkpointLevel, deaths: 0, completed: false, cleared,
    }),
  });
}

function knockOutWave(session) {
  for (const fighter of session.combat.fighters) if (fighter.team === 1) fighter.hp = 0;
  return session.step();
}

function knockOutWithHero(session, count) {
  const hero = session.combat.fighters.find((fighter) => fighter.id === 'hero');
  const enemies = session.combat.fighters.filter((fighter) => fighter.team === 1 && fighter.hp > 0);
  assert.ok(enemies.length >= count);
  enemies.forEach((enemy, index) => {
    enemy.x = index < count ? hero.x + 37 + index * 12 : 860;
    enemy.y = hero.y;
    enemy.hp = index < count ? 1 : enemy.hp;
    enemy.vx = 0;
    enemy.vy = 0;
    enemy.stun = 100;
    enemy.invulnerable = 0;
    enemy.grounded = true;
  });
  hero.attackStage = 1;
  hero.attackTick = 4; // The next fixed tick is the first real hit frame.
  hero.hitIds = [];
  hero.facing = 1;
  hero.stun = 0;
  return session.step();
}

function finishHitstop(session) {
  while (session.combat.hitstop > 0) session.step();
}

test('all 56 stages have four ordered themes, unique scenes, valid waves and nine bosses', () => {
  assert.equal(MAX_LEVEL, 56);
  assert.equal(LEVELS.length, MAX_LEVEL);
  assert.deepEqual([...new Set(LEVELS.map((level) => level.name))].length, 56);
  assert.deepEqual(Object.keys(THEMES), ['forest', 'city', 'ocean', 'land']);
  assert.deepEqual(LEVELS.filter((level) => level.isBoss).map((level) => level.number), [10, 14, 20, 28, 30, 40, 42, 50, 56]);

  for (const [index, level] of LEVELS.entries()) {
    assert.equal(level.number, index + 1);
    assert.equal(level.theme, Object.keys(THEMES)[Math.floor(index / 14)]);
    assert.equal(level.stage, index % 14 + 1);
    assert.ok(level.waves.length >= 1);
    assert.equal(level.groundY, level.arena.groundY);
    assert.equal(level.arena.width, 1920);
    assert.ok(level.enemyCount >= 1);
    assert.ok(level.platforms.length >= 1);
    for (const wave of level.waves) {
      assert.ok(wave.groups.length >= 1);
      for (const group of wave.groups) {
        assert.ok(group.count > 0 && group.maxHp > 0 && group.damageScale > 0);
      }
    }
    for (const item of [...level.platforms, ...level.hazards]) {
      assert.ok(item.x >= 0 && item.x + item.w <= level.arena.width);
      assert.ok(item.y >= 0 && item.y + item.h <= 540);
    }
  }
  assert.equal(getLevel(0), null);
  assert.equal(getLevel(57), null);
});

test('a small regular-enemy lift reaches all 56 stages without changing waves or saves', () => {
  const oldHp = { grunt: 64, rusher: 52, guard: 80, brute: 104 };
  const oldDamage = { grunt: 0.73, rusher: 0.66, guard: 0.8, brute: 1.04 };
  const waveCounts = [1, 2, 1, 2, 2, 2, 2, 2, 2, 3, 2, 2, 3, 2];
  const enemyCounts = [1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 4, 5, 5, 2];
  const addedBosses = new Set([10, 20, 30, 40, 50]);

  for (const level of LEVELS) {
    const chapterIndex = level.chapter - 1;
    const extraBoss = addedBosses.has(level.number) ? 1 : 0;
    assert.equal(level.waves.length, waveCounts[level.stage - 1] + extraBoss);
    assert.equal(level.enemyCount, enemyCounts[level.stage - 1] + extraBoss);
    assert.equal(level.isCheckpoint, [1, 5, 9, 13].includes(level.stage));
    let strongerEnemies = 0;

    for (const wave of level.waves) {
      for (const group of wave.groups) {
        if (group.kind === 'boss') continue; // Prior boss balance is intentionally preserved.
        const baselineHp = Math.round(oldHp[group.kind]
          * (1 + chapterIndex * 0.13 + level.stage * 0.016));
        const baselineDamage = Number((oldDamage[group.kind]
          * (1 + chapterIndex * 0.085 + level.stage * 0.011)).toFixed(2));
        assert.ok(group.maxHp > baselineHp, `level ${level.number} ${group.kind} has more HP`);
        assert.ok(group.damageScale >= baselineDamage, `level ${level.number} ${group.kind} damage does not fall`);
        const statPressure = group.maxHp / baselineHp * group.damageScale / baselineDamage;
        assert.ok(statPressure >= 1.05 && statPressure <= 1.09,
          `level ${level.number} ${group.kind} remains a modest increase: ${statPressure}`);
        strongerEnemies += group.count;
      }
    }
    assert.ok(strongerEnemies >= 1, `level ${level.number} has at least one tougher enemy`);
  }

  assert.equal(getLevel(1).waves[0].groups[0].maxHp, 68); // Formerly 65.
  assert.equal(getLevel(1).waves[0].groups[0].damageScale, 0.76); // Formerly 0.74.
});

test('checkpoints are stage 1, 5, 9 and 13 in every theme', () => {
  const expected = [1, 5, 9, 13, 15, 19, 23, 27, 29, 33, 37, 41, 43, 47, 51, 55];
  assert.deepEqual(LEVELS.filter((level) => isCheckpoint(level.number)).map((level) => level.number), expected);
  for (const [level, point] of [[1, 1], [4, 1], [5, 5], [11, 9], [14, 13],
    [15, 15], [18, 15], [19, 19], [28, 27], [29, 29], [42, 41], [43, 43], [56, 55]]) {
    assert.equal(checkpointFor(level), point);
  }
  assert.equal(checkpointFor(57), null);
});

test('death immediately saves rollback; retry and reload recreate checkpoint origin', () => {
  const store = seedProgress(11, 9, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const session = new CampaignSession({ storage: store });
  session.start();
  assert.equal(session.levelNumber, 11);
  session.combat.fighters[0].hp = 0;
  const failed = session.step();
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.failedLevel, 11);
  assert.equal(failed.progress.currentLevel, 9);
  assert.equal(failed.progress.checkpointLevel, 9);
  assert.equal(failed.progress.deaths, 1);
  assert.equal(JSON.parse(store.getItem(STORAGE_KEY)).currentLevel, 9);

  const retry = session.retry();
  assert.equal(retry.phase, 'playing');
  assert.equal(retry.level.number, 9);
  assert.equal(retry.combat.tick, 0);
  assert.equal(retry.combat.fighters[0].hp, 100);
  assert.ok(retry.combat.fighters.some((fighter) => fighter.team === 1 && fighter.hp > 0));
  assert.notEqual(retry.combat.arena.hazards, failed.combat.arena.hazards);

  const restored = new CampaignSession({ storage: store }).start();
  assert.equal(restored.phase, 'playing');
  assert.equal(restored.level.number, 9);
  assert.equal(restored.progress.deaths, 1);
});

test('entering a new checkpoint activates it before any fight', () => {
  const store = seedProgress(19, 15);
  const session = new CampaignSession({ storage: store });
  assert.equal(session.start().progress.checkpointLevel, 19);
  session.combat.fighters[0].hp = 0;
  const result = session.step();
  assert.equal(result.progress.currentLevel, 19);
  assert.equal(JSON.parse(store.getItem(STORAGE_KEY)).checkpointLevel, 19);
});

test('waves advance one by one, then clear unlocks exactly the next room', () => {
  const store = storage();
  const session = new CampaignSession({ storage: store });
  assert.equal(session.start().level.number, 1);
  let result = knockOutWave(session);
  assert.equal(result.phase, 'cleared');
  assert.equal(result.progress.currentLevel, 2);
  assert.deepEqual(result.progress.cleared, [1]);

  result = session.next();
  assert.equal(result.phase, 'playing');
  assert.equal(result.level.number, 2);
  assert.equal(result.waveNumber, 1);
  session.combat.fighters[0].hp = 81;
  result = knockOutWave(session);
  assert.equal(result.phase, 'playing');
  assert.equal(result.waveNumber, 2);
  assert.equal(result.combat.fighters[0].hp, 93);
  assert.ok(result.combat.fighters.some((fighter) => fighter.team === 1 && fighter.hp > 0));
  result = knockOutWave(session);
  assert.equal(result.phase, 'cleared');
  assert.equal(result.progress.currentLevel, 3);
  assert.deepEqual(result.progress.cleared, [1, 2]);
  assert.equal(new CampaignSession({ storage: store }).start().level.number, 3);
});

test('a 1920px stage uses its far half and never spawns enemies on a ground hazard', () => {
  const opening = new CampaignSession({ storage: storage() }).start();
  assert.equal(opening.combat.arena.width, 1920);
  const firstEnemy = opening.combat.fighters.find((fighter) => fighter.team === 1);
  assert.ok(firstEnemy.x >= 1450 && firstEnemy.x <= 1550,
    `first wave draws the player across the scrolling arena: ${firstEnemy.x}`);

  const later = new CampaignSession({ storage: seedProgress(22, 19) });
  later.start();
  for (const enemy of later.combat.fighters.filter((fighter) => fighter.team === 1)) {
    assert.ok(enemy.x >= 46 && enemy.x <= later.combat.arena.width - 46);
    assert.ok(Math.abs(enemy.x - later.combat.fighters[0].x) >= 190);
    assert.ok(later.combat.arena.hazards.every((hazard) =>
      enemy.x + 22 <= hazard.x - 8 || enemy.x - 22 >= hazard.x + hazard.w + 8));
  }
});

test('the campaign spear aims before any KO, needs confirmation, repeats, and survives retry', () => {
  const session = new CampaignSession({ storage: seedProgress(7, 5) });
  assert.equal(Object.hasOwn(session.start(), 'spearCharges'), false);
  const enemy = session.combat.fighters.find((fighter) => fighter.team === 1);
  enemy.x = 500;
  enemy.hp = 60;
  enemy.stun = 300;
  session.combat.fighters.filter((fighter) => fighter.team === 1 && fighter !== enemy)
    .forEach((fighter) => { fighter.x = 900; fighter.stun = 300; });
  session.combat.arena.platforms = []; // Interception is verified in the combat physics tests.
  const firstAim = session.step({ spear: true });
  assert.ok(firstAim.events.some((entry) => entry.type === 'spear-aim'));
  assert.equal(session.combat.fighters[0].spearWindup, 0);
  session.step({ spear: false, aimUp: true });
  const confirmed = session.step({ spear: true });
  assert.ok(confirmed.events.some((entry) => entry.type === 'spear-windup'));
  let throws = 0;
  let hits = 0;
  for (let frame = 0; frame < 65; frame++) {
    const result = session.step({ spear: true });
    throws += result.events.filter((entry) => entry.type === 'spear-throw').length;
    hits += result.events.filter((entry) => entry.type === 'hit'
      && entry.source === 'hero' && entry.target === enemy.id).length;
    assert.ok(!result.events.some((entry) => entry.type === 'spear-ready'));
  }
  assert.equal(throws, 1, 'a held key never repeats the throw');
  assert.equal(hits, 1);
  assert.equal(enemy.hp, 38);
  session.step({ spear: false });
  assert.ok(session.step({ spear: true }).events.some((entry) => entry.type === 'spear-aim'));
  session.step({ spear: false });
  assert.ok(session.step({ spear: true }).events.some((entry) => entry.type === 'spear-windup'));
  assert.equal(session.combat.fighters[0].spearCooldown, 0);

  session.combat.fighters[0].hp = 0;
  assert.equal(session.step().phase, 'failed');
  const retry = session.retry();
  assert.equal(retry.level.number, 5);
  assert.ok(session.step({ spear: true }).events.some((entry) => entry.type === 'spear-aim'));
});

test('a spear KO remains a personal KO for the existing light-wave skill', () => {
  const session = new CampaignSession({ storage: seedProgress(7, 5) });
  session.start();
  const enemy = session.combat.fighters.find((fighter) => fighter.team === 1);
  enemy.x = 500;
  enemy.hp = 1;
  enemy.stun = 300;
  session.combat.fighters.filter((fighter) => fighter.team === 1 && fighter !== enemy)
    .forEach((fighter) => { fighter.x = 900; fighter.stun = 300; });
  session.combat.arena.platforms = [];
  assert.ok(session.step({ spear: true }).events.some((entry) => entry.type === 'spear-aim'));
  session.step({ spear: false });
  let ko = null;
  for (let frame = 0; frame < 65 && !ko; frame++) {
    const result = session.step({ spear: true });
    ko = result.events.find((entry) => entry.type === 'ko' && entry.target === enemy.id);
  }
  assert.equal(ko?.source, 'hero');
  assert.equal(session.snapshot().specialKills, 1);
  assert.equal(session.snapshot().specialCharges, 0);
  assert.equal(Object.hasOwn(session.snapshot(), 'spearCharges'), false);
});

test('an uncharged wave leaves spear aim alone; a charged wave cancels aim or windup', () => {
  const session = new CampaignSession({ storage: seedProgress(7, 5) });
  session.start();
  const hero = session.combat.fighters[0];
  session.step({ spear: true });
  assert.equal(hero.spearAiming, true);
  session.step({ spear: false, special: true });
  assert.equal(hero.spearAiming, true, 'an unavailable wave must not cancel aiming');
  session.step({ special: false });
  session.specialCharges = 1;
  const wave = session.step({ special: true });
  assert.ok(wave.events.some((entry) => entry.type === 'special-wave'));
  assert.equal(hero.spearAiming, false);
  assert.equal(hero.spearWindup, 0);

  session.step({ special: false, spear: true });
  session.step({ spear: false });
  session.step({ spear: true });
  assert.ok(hero.spearWindup > 0, 'a second I press commits the spear');
  session.specialCharges = 1;
  session.step({ special: true });
  assert.equal(hero.spearWindup, 0, 'a charged wave also interrupts committed windup');
});

test('light-wave charges are available only in rooms with more than three enemies and require two player KOs', () => {
  const shortRoom = new CampaignSession({ storage: seedProgress(6, 5) });
  assert.equal(shortRoom.start().specialEligible, false);
  const shortResult = knockOutWithHero(shortRoom, 2);
  assert.equal(shortResult.specialKills, 0);
  assert.equal(shortResult.specialCharges, 0);
  finishHitstop(shortRoom);
  assert.equal(shortRoom.step({ special: true }).events.some((event) => event.type === 'special-wave'), false);

  const longRoom = new CampaignSession({ storage: seedProgress(7, 5) });
  assert.equal(longRoom.start().specialEligible, true);
  const first = knockOutWithHero(longRoom, 1);
  assert.equal(first.specialKills, 1);
  assert.equal(first.specialCharges, 0);
  finishHitstop(longRoom);
  const second = knockOutWithHero(longRoom, 1);
  assert.equal(second.specialKills, 2);
  assert.equal(second.specialCharges, 1);
  assert.ok(second.events.some((event) => event.type === 'special-ready'));
  finishHitstop(longRoom);
  const activeEnemies = longRoom.combat.fighters.filter((fighter) => fighter.team === 1 && fighter.hp > 0);
  assert.equal(activeEnemies.length, 2);
  const before = activeEnemies.map((enemy) => enemy.hp);
  const wave = longRoom.step({ special: true });
  assert.equal(wave.specialCharges, 0);
  assert.deepEqual(activeEnemies.map((enemy) => enemy.hp), before.map((hp) => Math.ceil(hp / 2)));
  assert.equal(wave.events.filter((event) => event.type === 'hit' && event.special).length, 2);
});

test('the campaign-only light wave accumulates charges, halves the current wave and protects the hero', () => {
  const session = new CampaignSession({ storage: seedProgress(12, 9) });
  session.start();
  let result = knockOutWithHero(session, 2);
  assert.equal(result.waveNumber, 2);
  assert.equal(result.specialCharges, 1);
  finishHitstop(session);
  result = knockOutWithHero(session, 2);
  assert.equal(result.specialKills, 4);
  assert.equal(result.specialCharges, 2);
  assert.equal(result.phase, 'playing');

  // A short press arriving during hitstop is not consumed on a frozen tick.
  assert.equal(session.step({ special: true }).specialCharges, 2);
  while (session.combat.hitstop > 0) assert.equal(session.step({ special: true }).specialCharges, 2);
  const enemy = session.combat.fighters.find((fighter) => fighter.team === 1 && fighter.hp > 0);
  const hero = session.combat.fighters.find((fighter) => fighter.id === 'hero');
  const originalHp = enemy.hp;
  result = session.step({ special: true });
  assert.equal(result.specialCharges, 1);
  assert.equal(enemy.hp, Math.ceil(originalHp / 2));
  assert.ok(hero.invulnerable >= 35 && hero.specialWaveTicks > 0);
  assert.ok(result.events.some((event) => event.type === 'special-wave' && event.source === hero.id));
  assert.ok(result.events.some((event) => event.type === 'hit' && event.target === enemy.id && event.special));

  const hpAfterWave = hero.hp;
  session.combat.arena.hazards.push({ x: hero.x - 10, y: hero.y - 14, w: 20, h: 14, damage: 50 });
  result = session.step({ special: true });
  assert.equal(result.specialCharges, 1, 'holding the button cannot spend a second charge');
  assert.equal(hero.hp, hpAfterWave, 'the invulnerable wave blocks terrain damage');
  session.combat.arena.hazards.pop();
  session.step({ special: false });
  result = session.step({ special: true });
  assert.equal(result.specialCharges, 0);
  assert.equal(enemy.hp, Math.ceil(Math.ceil(originalHp / 2) / 2));

  hero.hp = 0;
  assert.equal(session.step().phase, 'failed');
  const retry = session.retry();
  assert.equal(retry.level.number, 9);
  assert.equal(retry.specialEligible, true);
  assert.equal(retry.specialKills, 0);
  assert.equal(retry.specialCharges, 0);
});

test('the final boss ends the campaign and persists completion', () => {
  const store = seedProgress(56, 55, Array.from({ length: 55 }, (_, i) => i + 1));
  const session = new CampaignSession({ storage: store });
  session.start();
  assert.equal(knockOutWave(session).phase, 'playing');
  assert.equal(session.snapshot().waveNumber, 2);
  const final = knockOutWave(session);
  assert.equal(final.phase, 'completed');
  assert.equal(final.progress.completed, true);
  assert.equal(final.progress.currentLevel, 56);
  assert.equal(final.progress.cleared.length, 56);
  assert.equal(new CampaignSession({ storage: store }).start().phase, 'completed');
  assert.equal(session.next().phase, 'completed');
});

test('four chapter bosses retain reduced stats and boss-wave entry restores 30 HP', () => {
  const expected = [
    [14, 171, 0.95, 132],
    [28, 190, 1.02, 146],
    [42, 208, 1.09, 161],
    [56, 226, 1.16, 175],
  ];
  for (const [number, bossHp, bossDamageScale, bruteHp] of expected) {
    const level = getLevel(number);
    assert.equal(level.waves[0].groups[0].maxHp, bruteHp); // Global lift also reaches the warm-up wave.
    const bossGroup = level.waves.at(-1).groups[0];
    assert.equal(bossGroup.kind, 'boss');
    assert.equal(bossGroup.maxHp, bossHp);
    assert.equal(bossGroup.damageScale, bossDamageScale);

    const session = new CampaignSession({ storage: seedProgress(number, checkpointFor(number)) });
    session.start();
    session.combat.fighters[0].hp = 45;
    const result = knockOutWave(session);
    assert.equal(result.phase, 'playing');
    assert.equal(result.waveNumber, 2);
    assert.equal(result.combat.fighters[0].hp, 75);
    assert.equal(result.combat.fighters.find((fighter) => fighter.kind === 'boss').maxHp, bossHp);
  }

  const regular = new CampaignSession({ storage: seedProgress(2, 1) });
  regular.start();
  regular.combat.fighters[0].hp = 45;
  const nextRegularWave = knockOutWave(regular);
  assert.equal(nextRegularWave.waveNumber, 2);
  assert.equal(nextRegularWave.combat.fighters[0].hp, 57);
});

test('simultaneous KO counts as failure, and corrupt storage never crashes startup', () => {
  const store = storage({ [STORAGE_KEY]: '{not json' });
  const session = new CampaignSession({ storage: store });
  session.start();
  for (const fighter of session.combat.fighters) fighter.hp = 0;
  const result = session.step();
  assert.equal(result.phase, 'failed');
  assert.equal(result.progress.currentLevel, 1);
  assert.equal(result.progress.deaths, 1);
});

test('storage access denial falls back to in-memory progress', () => {
  const denied = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
    removeItem() { throw new Error('storage denied'); },
  };
  const storageKey = 'campaign-fallback-test';
  const first = new CampaignSession({ storage: denied, storageKey });
  first.start();
  first.combat.fighters[0].hp = 0;
  assert.equal(first.step().progress.deaths, 1);
  const second = new CampaignSession({ storage: denied, storageKey });
  assert.equal(second.start().progress.deaths, 1);
});

test('the first stage keeps a real final KO playable until its corpse expires', () => {
  const store = storage();
  const session = new CampaignSession({ storage: store });
  session.start();
  const [hero, enemy] = session.combat.fighters;
  enemy.x = hero.x + 40;
  enemy.hp = 1;
  enemy.stun = 500;
  enemy.vx = 0;
  session.combat.projectiles.push({
    id: 'leftover-spear', kind: 'spear', source: enemy.id, team: 1,
    x: 1200, y: 250, vx: -3, vy: 0, radius: 7, damage: 99, ttl: 100,
  });
  session.combat.fallingObject = { phase: 'warning', warningRemaining: 100,
    kind: 'cone', x: hero.x, y: -8, impactY: hero.y, radius: 8 };
  let result;
  for (let frame = 0; frame < 12; frame++) {
    if (frame === 4) {
      hero.attackBuffered = true;
      hero.comboWindow = 14;
    }
    result = session.step({ attack: frame === 0 });
    if (result.phase === 'aftermath') break;
  }
  assert.equal(result.phase, 'aftermath');
  assert.equal(result.progress.currentLevel, 1);
  assert.deepEqual(result.progress.cleared, []);
  assert.equal(JSON.parse(store.getItem(STORAGE_KEY)).currentLevel, 1,
    'winning is not saved before the post-KO window ends');
  assert.equal(result.combat.corpses.length, 1);
  assert.equal(result.combat.corpses[0].id, enemy.id);
  assert.equal(result.combat.aftermath, true);
  assert.equal(result.combat.projectiles.length, 0);
  assert.equal(result.combat.fallingObject, null);
  assert.equal(hero.attackStage, 0);
  assert.equal(hero.attackTick, 0);
  assert.equal(hero.attackBuffered, false);
  assert.equal(hero.comboWindow, 0);
  const deadline = result.combat.corpses[0].expireTick;
  const stoppedAt = result.combat.motionTick;
  while (session.combat.hitstop > 0) {
    result = session.step({ right: true });
    assert.equal(result.combat.motionTick, stoppedAt, 'KO hitstop pauses the aftermath clock');
  }
  const hp = hero.hp;
  const startX = hero.x;
  result.combat.arena.hazards.push({ x: startX - 15, y: hero.y - 20,
    w: 30, h: 24, damage: 100 });
  result = session.step({ right: true, attack: true, spear: true, special: true });
  assert.ok(hero.x > startX, 'the player can walk through the short victory aftermath');
  assert.equal(hero.hp, hp, 'hazards and any AI damage stay off');
  assert.ok(!result.events.some((entry) => entry.type === 'spear-aim'
    || entry.type === 'special-wave'));
  while (session.combat.motionTick < deadline - 1) result = session.step();
  assert.equal(result.phase, 'aftermath');
  assert.equal(result.combat.corpses.length, 1);
  result = session.step();
  assert.equal(result.combat.motionTick, deadline);
  assert.equal(result.combat.corpses.length, 0);
  assert.equal(result.phase, 'cleared');
  assert.equal(result.progress.currentLevel, 2);
  assert.deepEqual(result.progress.cleared, [1]);
  assert.ok(result.events.some((entry) => entry.type === 'level-clear'));
  assert.equal(JSON.parse(store.getItem(STORAGE_KEY)).currentLevel, 2);
});

test('victory aftermath clears a finishing kick or dodge and queued inputs without erasing KO feedback', () => {
  for (const active of ['kick', 'dodge']) {
    const session = new CampaignSession({ storage: storage() });
    session.start();
    const [hero, enemy] = session.combat.fighters;
    enemy.x = hero.x + 180;
    enemy.hp = 1;
    enemy.stun = 500;
    session.combat.arena.platforms = [];
    session.combat.projectiles.push({
      id: `finisher-${active}`, kind: 'spear', source: hero.id, team: 0,
      x: enemy.x - 25, y: enemy.y - 40, vx: 10, vy: 0,
      radius: 7, damage: 22, ttl: 20,
    });
    hero.attackBuffered = true;
    hero.comboStage = 2;
    hero.comboWindow = 12;
    hero.jumpBuffer = 5;
    if (active === 'kick') {
      hero.kickType = 'ground';
      hero.kickTick = 2;
    } else hero.dodgeTicks = 5;
    const result = session.step();
    assert.equal(result.phase, 'aftermath', active);
    assert.ok(result.events.some((entry) => entry.type === 'ko' && entry.target === enemy.id));
    assert.ok(result.combat.hitstop > 0, 'the final impact remains perceptible');
    assert.deepEqual({
      attackStage: hero.attackStage, attackTick: hero.attackTick,
      attackBuffered: hero.attackBuffered, comboStage: hero.comboStage,
      comboWindow: hero.comboWindow, kickType: hero.kickType, kickTick: hero.kickTick,
      dodgeTicks: hero.dodgeTicks, jumpBuffer: hero.jumpBuffer,
    }, {
      attackStage: 0, attackTick: 0, attackBuffered: false, comboStage: 0,
      comboWindow: 0, kickType: null, kickTick: 0, dodgeTicks: 0, jumpBuffer: 0,
    });
    while (session.combat.hitstop > 0) session.step();
    const after = session.step({ right: true, attack: true, kick: true,
      dodge: true, spear: true });
    assert.equal(after.phase, 'aftermath');
    assert.equal(hero.attackStage, 0);
    assert.equal(hero.kickType, null);
    assert.equal(hero.dodgeTicks, 0);
    assert.ok(!after.events.some((entry) => entry.type === 'kick'
      || entry.type === 'jump-kick' || entry.type === 'spear-aim'));
  }
});

test('scattering just before expiry leaves 36 effective frames for the bones animation', () => {
  const session = new CampaignSession({ storage: storage() });
  session.start();
  const [hero, enemy] = session.combat.fighters;
  enemy.x = hero.x + 40;
  enemy.hp = 1;
  enemy.stun = 500;
  for (let frame = 0; frame < 12 && session.phase === 'playing'; frame++) {
    session.step({ attack: frame === 0 });
  }
  assert.equal(session.phase, 'aftermath');
  const corpse = session.combat.corpses[0];
  const originalDeadline = corpse.expireTick;
  while (session.combat.motionTick < originalDeadline - 3) session.step();
  hero.x = corpse.x - 60;
  hero.y = corpse.y;
  hero.vx = 0;
  hero.vy = 0;
  hero.grounded = true;
  session.step(); // First leave the corpse's horizontal region.
  assert.equal(corpse.wasInside, false);
  hero.x = corpse.x - 20.5;
  hero.vx = 0;
  const scattered = session.step({ right: true });
  assert.equal(scattered.combat.motionTick, originalDeadline - 1);
  assert.equal(scattered.events.filter((entry) => entry.type === 'bones-scatter').length, 1);
  assert.equal(scattered.combat.corpses.length, 0);
  assert.equal(scattered.phase, 'aftermath');
  const extendedDeadline = session.aftermathUntilTick;
  assert.equal(extendedDeadline, scattered.combat.motionTick + 36);
  assert.equal(scattered.specialKills, 0);
  while (session.combat.motionTick < originalDeadline) session.step();
  assert.equal(session.phase, 'aftermath', 'early scattering never shortens the original hold');
  while (session.combat.motionTick < extendedDeadline - 1) session.step();
  assert.equal(session.phase, 'aftermath');
  const cleared = session.step();
  assert.equal(cleared.combat.motionTick, extendedDeadline);
  assert.equal(cleared.phase, 'cleared');
  assert.deepEqual(cleared.progress.cleared, [1]);
});

test('earlier-wave corpses survive replacement and a retry clears all ephemeral remains', () => {
  const session = new CampaignSession({ storage: seedProgress(2, 1) });
  session.start();
  const [hero, enemy] = session.combat.fighters;
  enemy.x = hero.x + 40;
  enemy.hp = 1;
  enemy.stun = 500;
  let result;
  for (let frame = 0; frame < 12; frame++) {
    result = session.step({ attack: frame === 0 });
    if (result.waveNumber === 2) break;
  }
  assert.equal(result.phase, 'playing');
  assert.equal(result.waveNumber, 2);
  assert.equal(result.combat.corpses.length, 1);
  assert.equal(result.combat.corpses[0].id, enemy.id);
  assert.equal(result.combat.fighters.some((fighter) => fighter.id === enemy.id), false,
    'the corpse has its own lifetime after the dead fighter leaves the wave');
  hero.hp = 0;
  assert.equal(session.step().phase, 'failed');
  const retry = session.retry();
  assert.equal(retry.level.number, 1);
  assert.deepEqual(retry.combat.corpses, []);
  assert.equal(retry.combat.aftermath, false);
});

test('a real same-frame double KO still fails before starting an aftermath', () => {
  const session = new CampaignSession({ storage: storage() });
  session.start();
  const [hero, enemy] = session.combat.fighters;
  enemy.x = hero.x + 40;
  enemy.facing = -1;
  hero.hp = 1;
  enemy.hp = 1;
  hero.attackStage = enemy.attackStage = 1;
  hero.attackTick = enemy.attackTick = 4;
  const result = session.step();
  assert.ok(result.events.some((entry) => entry.type === 'ko' && entry.target === hero.id));
  assert.ok(result.events.some((entry) => entry.type === 'ko' && entry.target === enemy.id));
  assert.equal(result.phase, 'failed');
  assert.equal(result.combat.aftermath, false);
  assert.equal(result.progress.deaths, 1);
});
