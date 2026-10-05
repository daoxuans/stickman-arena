import test from 'node:test';
import assert from 'node:assert/strict';
import { CampaignSession, STORAGE_KEY } from '../public/campaign.js';
import { BOSS_EQUIPMENT, equipmentForBoss } from '../shared/equipment.js';
import { MAX_LEVEL, THEMES, LEVELS, checkpointFor, getLevel, isCheckpoint } from '../shared/levels.js';
import { createFighter } from '../shared/combat.js';

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

function enterBossWave(session) {
  for (let wave = 0; wave < session.snapshot().waveCount; wave++) {
    const boss = session.combat.fighters.find((fighter) => fighter.kind === 'boss' && fighter.hp > 0);
    if (boss) return boss;
    assert.equal(session.snapshot().phase, 'playing');
    knockOutWave(session);
  }
  assert.fail('expected a live Boss in the final wave');
}

function knockOutBossWithHero(session) {
  const boss = enterBossWave(session);
  const hero = session.combat.fighters.find((fighter) => fighter.id === 'hero');
  boss.x = hero.x + 40;
  boss.y = hero.y;
  boss.hp = 1;
  boss.vx = boss.vy = 0;
  boss.stun = 500;
  boss.invulnerable = 0;
  boss.wardTicks = 0;
  boss.bossCast = null;
  boss.grounded = true;
  hero.attackStage = 1;
  hero.attackTick = 4;
  hero.hitIds = [];
  hero.facing = 1;
  hero.stun = 0;
  const result = session.step();
  assert.ok(result.events.some((event) => event.type === 'ko' && event.target === boss.id));
  return { boss, hero, result };
}

function finishAftermath(session) {
  let result;
  for (let frame = 0; frame < 400 && session.phase === 'aftermath'; frame++) {
    result = session.step();
  }
  assert.notEqual(session.phase, 'aftermath', 'victory aftermath eventually settles');
  return result ?? session.snapshot();
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
  const oldHp = { grunt: 64, rusher: 52, guard: 80, brute: 104, leaper: 58, slinger: 56 };
  const oldDamage = { grunt: 0.73, rusher: 0.66, guard: 0.8, brute: 1.04,
    leaper: 0.76, slinger: 0.72 };
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

test('only cleared stages can be replayed, and a rejected selection changes no scene or save', () => {
  const backing = seedProgress(11, 9, Array.from({ length: 10 }, (_, index) => index + 1));
  let writes = 0;
  const store = { ...backing, setItem(key, value) { writes++; backing.setItem(key, value); } };
  const session = new CampaignSession({ storage: store });
  assert.equal(session.replay(1).replaying, true, 'an unlocked stage can be chosen before starting');
  assert.equal(session.exitReplay().phase, 'idle');
  const official = session.start();
  const combat = official.combat;
  const saved = store.getItem(STORAGE_KEY);
  const writesBefore = writes;
  for (const invalid of [0, 11, 56, '1', null, undefined]) {
    const result = session.replay(invalid);
    assert.equal(result.replaying, false);
    assert.equal(result.replayLevel, null);
    assert.equal(result.phase, official.phase);
    assert.equal(result.combat, combat);
    assert.equal(result.level.number, 11);
    assert.equal(store.getItem(STORAGE_KEY), saved);
    assert.equal(writes, writesBefore, 'a rejected selection never writes the save');
  }
  assert.equal(session.exitReplay().combat, combat, 'exiting when not practicing is also a no-op');
  assert.equal(session.retryReplay().combat, combat);
});

test('a practice failure retries the selected stage with fresh ammo and restores the paused official fight', () => {
  const cleared = Array.from({ length: 10 }, (_, index) => index + 1);
  const store = seedProgress(11, 9, cleared);
  const session = new CampaignSession({ storage: store });
  const official = session.start();
  const officialCombat = official.combat;
  const hero = officialCombat.fighters[0];
  hero.hp = 73;
  hero.x = 427;
  officialCombat.spearRemaining = 2;
  session.specialKills = 2;
  session.specialCharges = 1;
  const saved = store.getItem(STORAGE_KEY);

  let practice = session.replay(7);
  assert.equal(practice.replaying, true);
  assert.equal(practice.replayLevel, 7);
  assert.equal(practice.level.number, 7);
  assert.equal(practice.combat.fighters[0].hp, 100);
  assert.equal(practice.spearRemaining, 5);
  assert.equal(practice.specialEligible, true);
  assert.equal(practice.specialCharges, 0);
  assert.equal(session.start().combat, practice.combat,
    'the ordinary start action cannot overwrite official progress during practice');
  practice.combat.spearRemaining = 3;
  assert.equal(knockOutWave(session).waveNumber, 2);
  assert.equal(session.snapshot().spearRemaining, 3, 'waves share the practice-stage allowance');
  session.combat.fighters[0].hp = 0;
  const failed = session.step();
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.failedLevel, 7);
  assert.equal(failed.progress.currentLevel, 11);
  assert.equal(failed.progress.deaths, 0);
  assert.equal(failed.events.find((event) => event.type === 'campaign-fail').checkpointLevel, 7);
  assert.equal(store.getItem(STORAGE_KEY), saved);

  practice = session.retry();
  assert.equal(practice.phase, 'playing');
  assert.equal(practice.level.number, 7);
  assert.equal(practice.combat.tick, 0);
  assert.equal(practice.combat.fighters[0].hp, 100);
  assert.equal(practice.spearRemaining, 5);
  assert.equal(store.getItem(STORAGE_KEY), saved);
  assert.equal(session.replay(2).level.number, 2, 'switching practice stages is allowed');
  const practiceCombat = session.combat;
  assert.equal(session.replay(11).combat, practiceCombat,
    'an invalid selection during practice does not replace the scene or official backup');
  assert.equal(session.snapshot().replayLevel, 2);
  const restored = session.exitReplay();
  assert.equal(restored.replaying, false);
  assert.equal(restored.replayLevel, null);
  assert.equal(restored.phase, 'playing');
  assert.equal(restored.level.number, 11);
  assert.equal(restored.combat, officialCombat, 'the official battle is resumed, not rebuilt');
  assert.equal(restored.combat.fighters[0], hero);
  assert.equal(hero.hp, 73);
  assert.equal(hero.x, 427);
  assert.equal(restored.spearRemaining, 2);
  assert.equal(restored.specialKills, 2);
  assert.equal(restored.specialCharges, 1);
  assert.equal(store.getItem(STORAGE_KEY), saved);
  assert.equal(new CampaignSession({ storage: store }).start().level.number, 11,
    'a refresh during practice only ever sees the official save');
});

test('practice victory never unlocks the next stage and next cannot leave practice', () => {
  const store = seedProgress(6, 5, [1, 2, 3, 4, 5]);
  const session = new CampaignSession({ storage: store });
  const official = session.start();
  const saved = store.getItem(STORAGE_KEY);
  const practice = session.replay(2);
  assert.equal(practice.waveCount, 2);
  assert.equal(knockOutWave(session).phase, 'playing');
  const won = knockOutWave(session);
  assert.equal(won.phase, 'cleared');
  assert.equal(won.replaying, true);
  assert.deepEqual(won.progress.cleared, [1, 2, 3, 4, 5]);
  assert.equal(won.progress.currentLevel, 6);
  assert.equal(won.progress.completed, false);
  assert.equal(session.next().combat, won.combat);
  assert.equal(session.next().phase, 'cleared');
  assert.equal(store.getItem(STORAGE_KEY), saved);
  assert.equal(session.retryReplay().phase, 'playing', 'a finished practice can be restarted');
  assert.equal(session.exitReplay().combat, official.combat);
  assert.equal(session.snapshot().level.number, 6);
  assert.equal(store.getItem(STORAGE_KEY), saved);
});

test('leaving practice restores official failed and aftermath states without replay side effects', () => {
  const store = seedProgress(2, 1, [1]);
  const failed = new CampaignSession({ storage: store });
  failed.start();
  failed.combat.fighters[0].hp = 0;
  const officialFailure = failed.step();
  const saved = store.getItem(STORAGE_KEY);
  assert.equal(officialFailure.phase, 'failed');
  assert.equal(failed.replay(1).phase, 'playing');
  assert.equal(failed.exitReplay().combat, officialFailure.combat);
  assert.equal(failed.snapshot().phase, 'failed');
  assert.equal(failed.snapshot().failedLevel, 2);
  assert.equal(failed.snapshot().progress.deaths, 1);
  assert.equal(store.getItem(STORAGE_KEY), saved);
  assert.equal(failed.retry().level.number, 1, 'the official retry still follows its checkpoint');

  const finishing = new CampaignSession({ storage: seedProgress(2, 1, [1]) });
  finishing.start();
  assert.equal(knockOutWave(finishing).waveNumber, 2);
  const aftermath = knockOutWithHero(finishing, 1);
  assert.equal(aftermath.phase, 'aftermath');
  const deadline = finishing.aftermathUntilTick;
  finishing.replay(1);
  const restored = finishing.exitReplay();
  assert.equal(restored.phase, 'aftermath');
  assert.equal(restored.combat, aftermath.combat);
  assert.equal(finishing.aftermathUntilTick, deadline);
  while (finishing.phase === 'aftermath') finishing.step();
  assert.equal(finishing.snapshot().phase, 'cleared');
  assert.equal(finishing.snapshot().progress.currentLevel, 3);
});

test('final-stage practice preserves a completed save, and reset deliberately discards practice', () => {
  const complete = { currentLevel: 56, checkpointLevel: 55, deaths: 4,
    completed: true, cleared: Array.from({ length: 56 }, (_, index) => index + 1) };
  const store = storage({ [STORAGE_KEY]: JSON.stringify(complete) });
  const session = new CampaignSession({ storage: store });
  const official = session.start();
  assert.equal(official.phase, 'completed');
  const saved = store.getItem(STORAGE_KEY);
  assert.equal(session.replay(56).level.number, 56);
  assert.equal(knockOutWave(session).phase, 'playing');
  const victory = knockOutWave(session);
  assert.equal(victory.phase, 'cleared');
  assert.equal(victory.replaying, true);
  assert.equal(victory.progress.completed, true);
  assert.equal(session.exitReplay().phase, 'completed');
  assert.equal(store.getItem(STORAGE_KEY), saved);
  assert.equal(new CampaignSession({ storage: store }).start().phase, 'completed');

  session.replay(1);
  const reset = session.reset();
  assert.equal(reset.replaying, false);
  assert.equal(reset.phase, 'playing');
  assert.equal(reset.level.number, 1);
  assert.equal(reset.progress.deaths, 0);
  assert.deepEqual(reset.progress.cleared, []);
  assert.equal(session.exitReplay().phase, 'playing', 'reset clears the old official backup');
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

test('campaign spear aim/confirm costs nothing, a real throw costs one, and retry refreshes the allowance', () => {
  const session = new CampaignSession({ storage: seedProgress(7, 5) });
  assert.equal(session.start().spearRemaining, 5);
  const enemy = session.combat.fighters.find((fighter) => fighter.team === 1);
  enemy.x = 500;
  enemy.hp = 60;
  enemy.stun = 300;
  session.combat.fighters.filter((fighter) => fighter.team === 1 && fighter !== enemy)
    .forEach((fighter) => { fighter.x = 900; fighter.stun = 300; });
  session.combat.arena.platforms = []; // Interception is verified in the combat physics tests.
  const firstAim = session.step({ spear: true });
  assert.ok(firstAim.events.some((entry) => entry.type === 'spear-aim'));
  assert.equal(firstAim.spearRemaining, 5);
  assert.equal(session.combat.fighters[0].spearWindup, 0);
  session.step({ spear: false, aimUp: true });
  const confirmed = session.step({ spear: true });
  assert.ok(confirmed.events.some((entry) => entry.type === 'spear-windup'));
  assert.equal(confirmed.spearRemaining, 5);
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
  assert.equal(session.snapshot().spearRemaining, 4);
  assert.equal(hits, 1);
  assert.equal(enemy.hp, 38);
  session.step({ spear: false });
  assert.ok(session.step({ spear: true }).events.some((entry) => entry.type === 'spear-aim'));
  session.step({ spear: false });
  assert.ok(session.step({ spear: true }).events.some((entry) => entry.type === 'spear-windup'));
  assert.equal(session.snapshot().spearRemaining, 4, 'a second confirmed but unthrown spear is free');
  assert.equal(session.combat.fighters[0].spearCooldown, 0);

  session.combat.fighters[0].hp = 0;
  assert.equal(session.step().phase, 'failed');
  const retry = session.retry();
  assert.equal(retry.level.number, 5);
  assert.equal(retry.spearRemaining, 5, 'failure resets the per-level throw allowance');
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
  assert.equal(session.snapshot().spearRemaining, 4);
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
  hero.facing = -1;
  const beforeTurnX = hero.x;
  const wave = session.step({ special: true, right: true });
  const turnCue = wave.events.find((entry) => entry.type === 'special-wave');
  assert.ok(hero.x > beforeTurnX, 'the player can turn and move on the casting tick');
  assert.equal(turnCue?.facing, 1,
    'beam direction uses the caster facing shown after this same simulation tick');
  assert.equal(turnCue.x, hero.x, 'the beam originates at the same-frame caster position');
  assert.equal(turnCue.y, hero.y - hero.height * .52);
  assert.equal(hero.spearAiming, false);
  assert.equal(hero.spearWindup, 0);
  assert.equal(wave.spearRemaining, 5, 'cancelling an aim with a wave costs no spear');

  session.step({ special: false, spear: true });
  session.step({ spear: false });
  session.step({ spear: true });
  assert.ok(hero.spearWindup > 0, 'a second I press commits the spear');
  session.specialCharges = 1;
  hero.facing = -1;
  const beforeJumpY = hero.y;
  const secondWave = session.step({ special: true, jump: true });
  assert.equal(hero.spearWindup, 0, 'a charged wave also interrupts committed windup');
  assert.equal(secondWave.spearRemaining, 5, 'a wave interrupting windup costs no spear');
  assert.ok(hero.y < beforeJumpY, 'jump changes the caster hand position on the casting tick');
  const jumpCue = secondWave.events.find((entry) => entry.type === 'special-wave');
  assert.equal(jumpCue?.facing, -1);
  assert.equal(jumpCue.x, hero.x);
  assert.equal(jumpCue.y, hero.y - hero.height * .52,
    'the source follows the airborne caster, not the pre-step feet position');
});

test('one room shares spear throws across waves; a new stage restores five without saving ammo', () => {
  const store = seedProgress(2, 1);
  const session = new CampaignSession({ storage: store });
  assert.equal(session.start().spearRemaining, 5);
  for (const enemy of session.combat.fighters.filter((fighter) => fighter.team === 1)) enemy.stun = 300;
  session.step({ spear: true });
  session.step({ spear: false });
  session.step({ spear: true });
  let launched = false;
  for (let frame = 0; frame < 30 && !launched; frame++) {
    const snapshot = session.step({ spear: true });
    launched = snapshot.events.some((entry) => entry.type === 'spear-throw' && entry.source === 'hero');
  }
  assert.equal(launched, true);
  assert.equal(session.snapshot().spearRemaining, 4);
  assert.equal(new CampaignSession({ storage: store }).start().spearRemaining, 5,
    'a page reload rebuilds the level instead of persisting a partial allowance');
  const secondWave = knockOutWave(session);
  assert.equal(secondWave.waveNumber, 2);
  assert.equal(secondWave.spearRemaining, 4, 'the second wave spends from the same five');
  const cleared = knockOutWave(session);
  assert.equal(cleared.phase, 'cleared');
  assert.equal(cleared.spearRemaining, 4);
  const next = session.next();
  assert.equal(next.level.number, 3);
  assert.equal(next.spearRemaining, 5, 'only a new stage refreshes the limit');
  assert.equal(Object.hasOwn(JSON.parse(store.getItem(STORAGE_KEY)), 'spearRemaining'), false,
    'ammunition is not part of the local checkpoint record');
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

test('the campaign-only light wave accumulates charges, halves ordinary foes and protects the hero', () => {
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

test('each tenth-stage boss carries its cumulative tier without changing chapter bosses or the save route', () => {
  for (const number of [10, 20, 30, 40, 50]) {
    const session = new CampaignSession({ storage: seedProgress(number, checkpointFor(number)) });
    const level = session.start().level;
    assert.equal(level.waves.at(-1).groups[0].bossTier, number / 10);
    while (session.waveIndex < level.waves.length - 1) knockOutWave(session);
    const boss = session.combat.fighters.find((fighter) => fighter.kind === 'boss' && fighter.hp > 0);
    assert.equal(boss.bossTier, number / 10, `milestone boss at level ${number}`);
    assert.equal(session.snapshot().progress.checkpointLevel, checkpointFor(number));
  }
  for (const number of [14, 28, 42, 56]) {
    const group = getLevel(number).waves.at(-1).groups[0];
    assert.equal(group.bossTier ?? 0, 0, `chapter boss ${number} has no milestone skill tier`);
  }
});

test('a light wave takes one third of Boss current HP, half from other foes, even during Boss ward', () => {
  const session = new CampaignSession({ storage: seedProgress(50, 47) });
  const level = session.start().level;
  while (session.waveIndex < level.waves.length - 1) knockOutWave(session);
  const boss = session.combat.fighters.find((fighter) => fighter.kind === 'boss' && fighter.hp > 0);
  const hero = session.combat.fighters.find((fighter) => fighter.id === 'hero');
  boss.hp = 91;
  boss.wardTicks = 50;
  boss.bossCast = { type: 'rock', ticks: 10, totalTicks: 20 };
  const minion = createFighter({
    id: 'wave-ordinary', team: 1, kind: 'grunt', x: boss.x + 58,
    y: boss.y, maxHp: 60,
  });
  minion.hp = 45;
  minion.summonedBy = boss.id;
  session.combat.fighters.push(minion);
  session.specialCharges = 1;

  const result = session.step({ special: true });
  assert.equal(result.specialCharges, 0);
  assert.equal(boss.hp, 61, 'odd Boss health rounds the remaining two thirds upward');
  assert.equal(minion.hp, 23);
  assert.equal(boss.bossCast, null, 'the impact interrupts a telegraphed Boss cast');
  assert.ok(hero.invulnerable > 0);
  assert.deepEqual(result.events.filter((event) => event.type === 'hit' && event.special)
    .map((event) => [event.target, event.damage]).sort(),
  [[boss.id, 30], [minion.id, 22]].sort());

  hero.hp = 0;
  assert.equal(session.step().phase, 'failed');
  const retry = session.retry();
  assert.equal(retry.level.number, 47);
  assert.equal(retry.specialCharges, 0);
  assert.equal(retry.combat.fighters.some((fighter) => fighter.summonedBy), false);
});

test('Boss summons join the live wave and collapse on its real KO without earning extra light-wave charge', () => {
  const session = new CampaignSession({ storage: seedProgress(20, 19) });
  const level = session.start().level;
  while (session.waveIndex < level.waves.length - 1) knockOutWave(session);
  const boss = session.combat.fighters.find((fighter) => fighter.kind === 'boss' && fighter.hp > 0);
  const hero = session.combat.fighters.find((fighter) => fighter.id === 'hero');
  boss.bossCast = { type: 'summon', ticks: 1, totalTicks: 40, count: 2, tier: 2 };
  boss.bossAbilityCooldown = 600;
  hero.invulnerable = 300;
  const arrival = session.step();
  const minions = arrival.combat.fighters.filter((fighter) => fighter.summonedBy === boss.id && fighter.hp > 0);
  assert.equal(minions.length, 2);
  assert.equal(arrival.level.enemyCount, 4, 'extra summons never change the static level-size gate');
  assert.ok(arrival.events.filter((event) => event.type === 'boss-summon').length >= 2);

  minions.forEach((minion, index) => {
    minion.x = hero.x + 400 + index * 60;
    minion.stun = 500;
  });
  const { result } = knockOutBossWithHero(session);
  assert.equal(result.phase, 'aftermath', 'the last Boss and its linked summons enter the normal victory window');
  assert.equal(result.waveNumber, level.waves.length);
  assert.ok(minions.every((minion) => minion.hp === 0));
  assert.ok(minions.every((minion) => result.events.some((event) => event.type === 'ko'
    && event.target === minion.id && event.source !== hero.id)));
  assert.ok(minions.every((minion) => result.combat.corpses.some((corpse) => corpse.id === minion.id)),
    'linked summons keep the usual KO corpse and scatter lifecycle');
  assert.equal(result.specialKills, 1, 'only the Boss personally KOed by the hero counts');
  assert.equal(result.specialCharges, 0, 'two collapsing minions cannot generate a free light wave');
  assert.equal(result.combat.equipmentDrops.length, 1, 'the real Boss KO still drops its reward');
});

test('a summoned enemy personally KOed before its Boss still charges the campaign light wave', () => {
  const session = new CampaignSession({ storage: seedProgress(20, 19) });
  session.start();
  const boss = enterBossWave(session);
  const hero = session.combat.fighters.find((fighter) => fighter.id === 'hero');
  const personal = createFighter({ id: 'personal-summon', x: hero.x + 40, y: hero.y,
    team: 1, kind: 'grunt', summonedBy: boss.id });
  const linked = createFighter({ id: 'linked-summon', x: hero.x + 500, y: hero.y,
    team: 1, kind: 'grunt', summonedBy: boss.id });
  personal.hp = 1;
  personal.stun = linked.stun = boss.stun = 500;
  boss.x = hero.x + 500;
  session.combat.fighters.push(personal, linked);
  hero.attackStage = 1;
  hero.attackTick = 4;
  hero.hitIds = [];
  hero.facing = 1;
  const first = session.step();
  assert.equal(personal.hp, 0);
  assert.ok(boss.hp > 0);
  assert.equal(first.specialKills, 1, 'a player-delivered minion KO still counts');
  assert.equal(first.specialCharges, 0);
  finishHitstop(session);

  const { result } = knockOutBossWithHero(session);
  assert.equal(result.phase, 'aftermath');
  assert.equal(linked.hp, 0);
  assert.equal(result.specialKills, 2, 'the subsequent personal Boss KO completes the pair');
  assert.equal(result.specialCharges, 1, 'the automatic linked KO does not count as a third personal kill');
  assert.ok(!result.events.some((event) => event.type === 'ko'
    && event.target === linked.id && event.source === hero.id));
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

test('all nine Bosses drop their deterministic catalog reward on a real KO, before the wave settles', () => {
  const bossLevels = [10, 14, 20, 28, 30, 40, 42, 50, 56];
  assert.deepEqual(BOSS_EQUIPMENT.map((item) => item.bossLevel), bossLevels);
  for (const levelNumber of bossLevels) {
    const session = new CampaignSession({ storage: seedProgress(levelNumber, checkpointFor(levelNumber)) });
    session.start();
    const { boss, result } = knockOutBossWithHero(session);
    const reward = equipmentForBoss(levelNumber);
    assert.equal(result.phase, 'aftermath', `level ${levelNumber} pauses for the real KO`);
    assert.equal(result.combat.equipmentDrops.length, 1, `level ${levelNumber} has a guaranteed drop`);
    const [drop] = result.combat.equipmentDrops;
    assert.equal(drop.equipmentId, reward.id);
    assert.equal(drop.spawnedTick, result.combat.motionTick);
    assert.equal(drop.x, boss.x);
    assert.ok(result.events.some((event) => event.type === 'equipment-drop'
      && event.equipmentId === reward.id && event.dropId === drop.id));
    assert.deepEqual(result.inventory, [], 'the reward is not instantly granted before collection');
    assert.deepEqual(result.progress.equipment, [], 'a KO alone does not write the save');
    session.step();
    assert.equal(session.combat.equipmentDrops.length, 1, 'hitstop does not duplicate the drop');
  }
});

test('nearby pickup waits 14 effective ticks, equips the first reward and commits only on clear', () => {
  const store = seedProgress(10, 9);
  const session = new CampaignSession({ storage: store });
  session.start();
  const { result } = knockOutBossWithHero(session);
  const [drop] = result.combat.equipmentDrops;
  const reward = equipmentForBoss(10);
  let collected;
  while (session.combat.motionTick - drop.spawnedTick < 13) {
    collected = session.step();
    assert.deepEqual(collected.inventory, []);
  }
  collected = session.step();
  assert.equal(collected.combat.motionTick - drop.spawnedTick, 14);
  assert.deepEqual(collected.inventory, [reward.id]);
  assert.equal(collected.equippedEquipmentId, reward.id);
  assert.equal(collected.combat.equippedEquipmentId, reward.id);
  assert.equal(collected.combat.equipmentDrops.length, 0);
  assert.ok(collected.events.some((event) => event.type === 'equipment-pickup'
    && event.equipmentId === reward.id && event.auto === false && event.duplicate === false));
  assert.deepEqual(JSON.parse(store.getItem(STORAGE_KEY)).equipment, [],
    'pickup is provisional until the stage finishes');
  const clear = finishAftermath(session);
  assert.equal(clear.phase, 'cleared');
  assert.deepEqual(clear.progress.equipment, [reward.id]);
  assert.deepEqual(new CampaignSession({ storage: store }).start().inventory, [reward.id]);
});

test('the Boss reward is automatically collected at clear if the player cannot cross the wide arena in time', () => {
  const store = seedProgress(10, 9);
  const session = new CampaignSession({ storage: store });
  session.start();
  const { hero, result } = knockOutBossWithHero(session);
  assert.equal(result.combat.equipmentDrops.length, 1);
  hero.x = 20;
  const clear = finishAftermath(session);
  assert.equal(clear.phase, 'cleared');
  assert.deepEqual(clear.inventory, [equipmentForBoss(10).id]);
  assert.equal(clear.combat.equipmentDrops.length, 0);
  assert.ok(clear.events.some((event) => event.type === 'equipment-pickup'
    && event.auto === true && event.duplicate === false));
  assert.deepEqual(JSON.parse(store.getItem(STORAGE_KEY)).equipment, clear.inventory);
});

test('uncollected gear follows a Boss corpse on a moving platform, then falls after its support vanishes', () => {
  const session = new CampaignSession({ storage: seedProgress(28, 27) });
  session.start();
  const { result } = knockOutBossWithHero(session);
  const [drop] = result.combat.equipmentDrops;
  const corpse = result.combat.corpses.find((body) => body.id === drop.id);
  const platformIndex = result.combat.arena.platforms.findIndex((platform) =>
    platform.motion === 'float' && platform.axis === 'x');
  assert.ok(platformIndex >= 0);
  corpse.platformIndex = platformIndex;
  corpse.supportT = 0.5;
  while (session.combat.motionTick < drop.spawnedTick + 8) session.step();
  assert.equal(drop.x, corpse.x);
  assert.equal(drop.y, corpse.y);
  assert.ok(drop.x > 1000, 'the platform takes the world-space reward with it');
  session.combat.corpses = [];
  const formerY = drop.y;
  session.combat.hitstop = 2;
  session.step();
  session.step();
  assert.equal(drop.y, formerY, 'hitstop cannot advance the reward fall');
  session.step();
  assert.equal(drop.y, formerY + 7);
});

test('Boss KO drops equipment and collapses its minion, but an unrelated foe blocks completion', () => {
  const store = seedProgress(20, 19);
  const session = new CampaignSession({ storage: store });
  session.start();
  const boss = enterBossWave(session);
  const hero = session.combat.fighters.find((fighter) => fighter.id === 'hero');
  const minion = createFighter({
    id: 'remaining-summon', name: '援兵', team: 1, kind: 'grunt',
    x: hero.x + 500, y: hero.y, summonedBy: boss.id,
  });
  const unrelated = createFighter({
    id: 'independent-enemy', name: '预设敌人', team: 1, kind: 'grunt',
    x: hero.x + 600, y: hero.y,
  });
  minion.stun = unrelated.stun = 500;
  session.combat.fighters.push(minion, unrelated);
  const { result } = knockOutBossWithHero(session);
  assert.equal(result.phase, 'playing');
  assert.equal(minion.hp, 0);
  assert.ok(result.events.some((event) => event.type === 'ko' && event.target === minion.id));
  assert.equal(unrelated.hp, unrelated.maxHp, 'a non-summoned foe remains alive');
  assert.equal(result.combat.equipmentDrops.length, 1);
  assert.ok(result.events.some((event) => event.type === 'equipment-drop'));
  let picked = result;
  for (let tick = 0; tick < 30 && session.combat.equipmentDrops.length; tick++) picked = session.step();
  assert.deepEqual(picked.inventory, [equipmentForBoss(20).id]);
  assert.equal(picked.phase, 'playing');
  assert.deepEqual(JSON.parse(store.getItem(STORAGE_KEY)).equipment, []);
  hero.hp = 0;
  const failure = session.step();
  assert.equal(failure.phase, 'failed');
  assert.deepEqual(failure.inventory, []);
  assert.deepEqual(failure.combat.equipmentDrops, []);
  assert.deepEqual(failure.progress.equipment, []);
  assert.equal(failure.progress.currentLevel, 19);
  assert.deepEqual(session.retry().inventory, []);
});

test('same-frame Boss and hero KO fails without generating persistent or collectible loot', () => {
  const store = seedProgress(10, 9);
  const session = new CampaignSession({ storage: store });
  session.start();
  const boss = enterBossWave(session);
  const hero = session.combat.fighters.find((fighter) => fighter.id === 'hero');
  boss.x = hero.x + 40;
  boss.y = hero.y;
  boss.hp = 1;
  boss.stun = 500;
  boss.invulnerable = 0;
  boss.wardTicks = 0;
  const minion = createFighter({
    id: 'double-ko-linked-summon', x: hero.x + 500, y: hero.y,
    team: 1, kind: 'grunt', summonedBy: boss.id,
  });
  minion.stun = 500;
  session.combat.fighters.push(minion);
  hero.hp = 1;
  hero.invulnerable = 0;
  hero.hazardCooldown = 0;
  hero.attackStage = 1;
  hero.attackTick = 4;
  hero.hitIds = [];
  hero.facing = 1;
  session.combat.arena.hazards.push({
    x: hero.x - 20, y: hero.y - 14, w: 40, h: 14, damage: 10, type: 'test',
  });
  const failure = session.step();
  assert.ok(failure.events.some((event) => event.type === 'ko' && event.target === boss.id));
  assert.ok(failure.events.some((event) => event.type === 'ko' && event.target === hero.id));
  assert.equal(minion.hp, 0, 'the linked enemy still falls on its Boss KO');
  assert.ok(failure.events.some((event) => event.type === 'ko' && event.target === minion.id));
  assert.equal(failure.phase, 'failed');
  assert.ok(!failure.events.some((event) => event.type === 'equipment-drop'));
  assert.deepEqual(failure.combat.equipmentDrops, []);
  assert.deepEqual(failure.inventory, []);
  assert.deepEqual(JSON.parse(store.getItem(STORAGE_KEY)).equipment, []);
});

test('Boss equipment after a checkpoint is lost on failure, while entry to the next checkpoint secures it', () => {
  const store = seedProgress(10, 9);
  const session = new CampaignSession({ storage: store });
  session.start();
  knockOutBossWithHero(session);
  assert.equal(finishAftermath(session).phase, 'cleared');
  const levelTenReward = equipmentForBoss(10).id;
  assert.deepEqual(session.snapshot().progress.equipment, [levelTenReward]);
  assert.deepEqual(session.snapshot().progress.checkpointEquipment, []);
  assert.equal(session.next().level.number, 11);
  session.combat.fighters[0].hp = 0;
  const failed = session.step();
  assert.equal(failed.progress.currentLevel, 9);
  assert.deepEqual(failed.inventory, []);
  assert.deepEqual(failed.progress.equipment, []);
  assert.equal(failed.equippedEquipmentId, null);
  assert.deepEqual(new CampaignSession({ storage: store }).start().inventory, []);
  const retry = session.retry();
  assert.equal(retry.level.number, 9);
  for (let wave = 0; wave < retry.waveCount; wave++) knockOutWave(session);
  assert.equal(session.snapshot().phase, 'cleared');
  assert.equal(session.next().level.number, 10);
  const secondVictory = knockOutBossWithHero(session).result;
  assert.equal(secondVictory.combat.equipmentDrops[0].equipmentId, levelTenReward,
    'replaying the checkpoint route can earn back the lost unique item');

  const laterStore = seedProgress(14, 13, Array.from({ length: 13 }, (_, index) => index + 1));
  const later = new CampaignSession({ storage: laterStore });
  later.start();
  knockOutBossWithHero(later);
  assert.equal(finishAftermath(later).phase, 'cleared');
  const chapterReward = equipmentForBoss(14).id;
  assert.ok(later.snapshot().inventory.includes(chapterReward));
  const enteringCheckpoint = later.next();
  assert.equal(enteringCheckpoint.level.number, 15);
  assert.ok(enteringCheckpoint.progress.checkpointEquipment.includes(chapterReward));
  later.combat.fighters[0].hp = 0;
  const checkpointFailure = later.step();
  assert.equal(checkpointFailure.progress.currentLevel, 15);
  assert.ok(checkpointFailure.inventory.includes(chapterReward));
  assert.ok(new CampaignSession({ storage: laterStore }).start().inventory.includes(chapterReward));
});

test('Boss practice may try equipment without changing the official backpack, selection, scene or save', () => {
  const owned = equipmentForBoss(10).id;
  const practiceReward = equipmentForBoss(14).id;
  const cleared = Array.from({ length: 14 }, (_, index) => index + 1);
  const store = storage({ [STORAGE_KEY]: JSON.stringify({
    currentLevel: 15, checkpointLevel: 15, deaths: 0, completed: false, cleared,
    equipment: [owned], checkpointEquipment: [owned], equippedEquipmentId: owned,
  }) });
  const session = new CampaignSession({ storage: store });
  const official = session.start();
  const originalCombat = official.combat;
  const originalBackpack = session.inventory;
  const saved = store.getItem(STORAGE_KEY);
  const practice = session.replay(14);
  assert.deepEqual(practice.inventory, [owned]);
  assert.equal(practice.combat.equippedEquipmentId, owned);
  const loot = knockOutBossWithHero(session).result;
  assert.equal(loot.replaying, true);
  assert.equal(loot.combat.equipmentDrops[0].equipmentId, practiceReward);
  assert.equal(finishAftermath(session).phase, 'cleared');
  assert.deepEqual(session.snapshot().inventory, [owned, practiceReward]);
  assert.equal(session.selectEquipment(practiceReward).equippedEquipmentId, practiceReward);
  assert.equal(session.snapshot().combat.equippedEquipmentId, practiceReward);
  assert.equal(store.getItem(STORAGE_KEY), saved, 'practice never commits its picked item');
  const retryPractice = session.retryReplay();
  assert.deepEqual(retryPractice.inventory, [owned], 'retry drops gear earned in the previous practice attempt');
  assert.equal(retryPractice.equippedEquipmentId, owned);
  knockOutBossWithHero(session);
  finishAftermath(session);
  assert.ok(session.snapshot().inventory.includes(practiceReward));
  assert.deepEqual(session.replay(10).inventory, [owned],
    'switching practice stages cannot carry a temporary Boss reward');
  const officialAgain = session.exitReplay();
  assert.equal(officialAgain.combat, originalCombat);
  assert.equal(session.inventory, originalBackpack, 'restore the original backpack object');
  assert.deepEqual(officialAgain.inventory, [owned]);
  assert.equal(officialAgain.equippedEquipmentId, owned);
  assert.equal(officialAgain.combat.equippedEquipmentId, owned);
  assert.equal(store.getItem(STORAGE_KEY), saved);
});

test('equipment selection rejects unknown gear, and an owned selection survives a reload', () => {
  const first = equipmentForBoss(10).id;
  const second = equipmentForBoss(14).id;
  const cleared = Array.from({ length: 14 }, (_, index) => index + 1);
  const store = storage({ [STORAGE_KEY]: JSON.stringify({
    currentLevel: 15, checkpointLevel: 15, deaths: 0, completed: false, cleared,
    equipment: [first, second], checkpointEquipment: [first, second], equippedEquipmentId: first,
  }) });
  const session = new CampaignSession({ storage: store });
  session.start();
  const before = store.getItem(STORAGE_KEY);
  assert.equal(session.selectEquipment('earth-seal').equippedEquipmentId, first);
  assert.equal(session.selectEquipment('not-real').equippedEquipmentId, first);
  assert.equal(store.getItem(STORAGE_KEY), before);
  assert.equal(session.selectEquipment(second).equippedEquipmentId, second);
  assert.equal(session.combat.equippedEquipmentId, second);
  assert.equal(new CampaignSession({ storage: store }).start().equippedEquipmentId, second);
});

test('legacy saves backfill only cleared Bosses still on the formal route; corrupted equipment is ignored', () => {
  const throughThirty = Array.from({ length: 30 }, (_, index) => index + 1);
  const saved = seedProgress(31, 29, throughThirty);
  const backfilled = new CampaignSession({ storage: saved }).start();
  assert.deepEqual(backfilled.inventory, BOSS_EQUIPMENT.filter((item) => item.bossLevel <= 30)
    .map((item) => item.id));
  assert.deepEqual(backfilled.progress.checkpointEquipment,
    BOSS_EQUIPMENT.filter((item) => item.bossLevel < 29).map((item) => item.id));
  assert.deepEqual(JSON.parse(saved.getItem(STORAGE_KEY)).equipment, backfilled.inventory,
    'an old save is upgraded without permanently withholding earlier rewards');

  const rolledBack = seedProgress(29, 29, throughThirty);
  const restored = new CampaignSession({ storage: rolledBack }).start();
  assert.ok(!restored.inventory.includes(equipmentForBoss(30).id),
    'cleared remembers the former win but the checkpoint rollback does not keep its gear');
  const finished = storage({ [STORAGE_KEY]: JSON.stringify({
    currentLevel: 56, checkpointLevel: 55, deaths: 0, completed: true,
    cleared: Array.from({ length: 56 }, (_, index) => index + 1),
  }) });
  const completed = new CampaignSession({ storage: finished }).start();
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.inventory.length, 9);
  assert.ok(completed.inventory.includes(equipmentForBoss(56).id));

  const corrupt = storage({ [STORAGE_KEY]: JSON.stringify({
    currentLevel: 11, checkpointLevel: 9, deaths: 0, completed: false,
    cleared: Array.from({ length: 10 }, (_, index) => index + 1),
    equipment: ['fake-item', equipmentForBoss(56).id, equipmentForBoss(10).id, equipmentForBoss(10).id],
    checkpointEquipment: [equipmentForBoss(10).id, 'fake-item'],
    equippedEquipmentId: equipmentForBoss(56).id,
  }) });
  const sanitized = new CampaignSession({ storage: corrupt }).start();
  assert.deepEqual(sanitized.inventory, [equipmentForBoss(10).id]);
  assert.deepEqual(sanitized.progress.checkpointEquipment, []);
  assert.equal(sanitized.equippedEquipmentId, equipmentForBoss(10).id);
});
