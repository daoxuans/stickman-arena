import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, checkpointFor, getLevel } from '../shared/levels.js';

const MILESTONE_BOSSES = [
  { number: 10, name: '雾林巨拳', originalWaves: 3, maxHp: 162, damageScale: 0.91 },
  { number: 20, name: '地下铁卫', originalWaves: 2, maxHp: 172, damageScale: 0.94 },
  { number: 30, name: '风暴巨兵', originalWaves: 2, maxHp: 181, damageScale: 0.98 },
  { number: 40, name: '深海狂拳', originalWaves: 2, maxHp: 203, damageScale: 1.07 },
  { number: 50, name: '荒原巨灵', originalWaves: 2, maxHp: 213, damageScale: 1.1 },
];

test('five ten-stage milestone bosses gain a separate final wave without replacing chapter bosses', () => {
  assert.deepEqual(LEVELS.filter((level) => level.isBoss).map((level) => level.number),
    [10, 14, 20, 28, 30, 40, 42, 50, 56]);

  for (const { number, name, originalWaves, maxHp, damageScale } of MILESTONE_BOSSES) {
    const level = getLevel(number);
    assert.equal(level.waves.length, originalWaves + 1);
    assert.equal(level.waves.at(-1).index, originalWaves + 1);
    assert.ok(level.waves.slice(0, -1).every((wave) => wave.groups.every((group) => group.kind !== 'boss')));
    assert.deepEqual(level.waves.at(-1).groups, [{
      kind: 'boss', count: 1, name, maxHp, damageScale,
    }]);
    assert.equal(level.enemyCount,
      level.waves.reduce((total, wave) => total + wave.groups.reduce((sum, group) => sum + group.count, 0), 0));
    assert.equal(checkpointFor(number), number === 40 ? 37 : number === 50 ? 47 : number - 1);
  }

  for (const [number, maxHp, damageScale] of [
    [14, 171, 0.95], [28, 190, 1.02], [42, 208, 1.09], [56, 226, 1.16],
  ]) {
    const level = getLevel(number);
    assert.equal(level.waves.length, 2);
    assert.equal(level.waves.at(-1).groups[0].kind, 'boss');
    assert.equal(level.waves.at(-1).groups[0].maxHp, maxHp);
    assert.equal(level.waves.at(-1).groups[0].damageScale, damageScale);
  }
});

test('every even stage has one sparse, deterministic theme-specific falling-hazard configuration', () => {
  const typeByTheme = {
    forest: 'pinecone', city: 'debris', ocean: 'hail', land: 'pebble',
  };
  const configured = LEVELS.filter((level) => level.arena.fallingHazard);
  assert.equal(configured.length, 28);

  for (const level of LEVELS) {
    if (level.number % 2) {
      assert.equal(level.arena.fallingHazard, undefined, `odd stage ${level.number}`);
      continue;
    }
    assert.deepEqual(level.arena.fallingHazard, {
      type: typeByTheme[level.theme], period: 240, firstTick: 120,
      warningTicks: 40, radius: 8, damageFraction: 0.1, seed: level.number,
    });
  }
});
