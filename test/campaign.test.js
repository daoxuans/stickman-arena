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

test('all 56 stages have four ordered themes, unique scenes, valid waves and four bosses', () => {
  assert.equal(MAX_LEVEL, 56);
  assert.equal(LEVELS.length, MAX_LEVEL);
  assert.deepEqual([...new Set(LEVELS.map((level) => level.name))].length, 56);
  assert.deepEqual(Object.keys(THEMES), ['forest', 'city', 'ocean', 'land']);
  assert.deepEqual(LEVELS.filter((level) => level.isBoss).map((level) => level.number), [14, 28, 42, 56]);

  for (const [index, level] of LEVELS.entries()) {
    assert.equal(level.number, index + 1);
    assert.equal(level.theme, Object.keys(THEMES)[Math.floor(index / 14)]);
    assert.equal(level.stage, index % 14 + 1);
    assert.ok(level.waves.length >= 1);
    assert.equal(level.groundY, level.arena.groundY);
    assert.ok(level.enemyCount >= 1);
    assert.ok(level.platforms.length >= 1);
    for (const wave of level.waves) {
      assert.ok(wave.groups.length >= 1);
      for (const group of wave.groups) {
        assert.ok(group.count > 0 && group.maxHp > 0 && group.damageScale > 0);
      }
    }
    for (const item of [...level.platforms, ...level.hazards]) {
      assert.ok(item.x >= 0 && item.x + item.w <= 960);
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

  for (const level of LEVELS) {
    const chapterIndex = level.chapter - 1;
    assert.equal(level.waves.length, waveCounts[level.stage - 1]);
    assert.equal(level.enemyCount, enemyCounts[level.stage - 1]);
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

test('four bosses use reduced stats and only boss-wave entry restores 30 HP', () => {
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
