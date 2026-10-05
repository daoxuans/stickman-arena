import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMPAIGN_WORLD_WIDTH, LEVELS, checkpointFor, getLevel } from '../shared/levels.js';

const MILESTONE_BOSSES = [
  { number: 10, name: '雾林巨拳', originalWaves: 3, maxHp: 162, damageScale: 0.91, bossTier: 1 },
  { number: 20, name: '地下铁卫', originalWaves: 2, maxHp: 172, damageScale: 0.94, bossTier: 2 },
  { number: 30, name: '风暴巨兵', originalWaves: 2, maxHp: 181, damageScale: 0.98, bossTier: 3 },
  { number: 40, name: '深海狂拳', originalWaves: 2, maxHp: 203, damageScale: 1.07, bossTier: 4 },
  { number: 50, name: '荒原巨灵', originalWaves: 2, maxHp: 213, damageScale: 1.1, bossTier: 5 },
];

test('five ten-stage milestone bosses gain a separate final wave without replacing chapter bosses', () => {
  assert.deepEqual(LEVELS.filter((level) => level.isBoss).map((level) => level.number),
    [10, 14, 20, 28, 30, 40, 42, 50, 56]);

  for (const { number, name, originalWaves, maxHp, damageScale, bossTier } of MILESTONE_BOSSES) {
    const level = getLevel(number);
    assert.equal(level.waves.length, originalWaves + 1);
    assert.equal(level.waves.at(-1).index, originalWaves + 1);
    assert.ok(level.waves.slice(0, -1).every((wave) => wave.groups.every((group) => group.kind !== 'boss')));
    assert.deepEqual(level.waves.at(-1).groups, [{
      kind: 'boss', count: 1, name, maxHp, damageScale, bossTier,
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
    assert.equal(level.waves.at(-1).groups[0].bossTier, undefined,
      'chapter bosses retain their existing role and do not inherit milestone skills');
    assert.equal(level.waves.at(-1).groups[0].maxHp, maxHp);
    assert.equal(level.waves.at(-1).groups[0].damageScale, damageScale);
  }
});

test('two new regular archetypes enter in stages 8 and 18 without changing the 56-stage structure', () => {
  const introductions = { leaper: 8, slinger: 18 };
  const names = { leaper: '跃袭者', slinger: '石掷手' };
  const regularKinds = new Set(['grunt', 'rusher', 'guard', 'brute', 'leaper', 'slinger']);
  const chapterCounts = [1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 4, 5, 5, 2];
  const chapterWaves = [1, 2, 1, 2, 2, 2, 2, 2, 2, 3, 2, 2, 3, 2];
  const milestoneNumbers = new Set(MILESTONE_BOSSES.map(({ number }) => number));

  for (const [kind, first] of Object.entries(introductions)) {
    assert.equal(LEVELS.find((level) => level.waves.some((wave) => wave.groups.some((group) => group.kind === kind)))?.number,
      first, `${names[kind]} has a deliberate introduction`);
    assert.ok(LEVELS.slice(first - 1).filter((level) =>
      level.waves.some((wave) => wave.groups.some((group) => group.kind === kind))).length > 10,
    `${names[kind]} remains a recurring threat`);
  }

  for (const level of LEVELS) {
    const bossBonus = Number(milestoneNumbers.has(level.number));
    assert.equal(level.enemyCount, chapterCounts[level.stage - 1] + bossBonus,
      `level ${level.number} retains its planned encounter count`);
    assert.equal(level.waves.length, chapterWaves[level.stage - 1] + bossBonus,
      `level ${level.number} retains its wave count`);
    for (const group of level.waves.flatMap((wave) => wave.groups)) {
      assert.ok(group.count >= 1);
      assert.ok(group.kind === 'boss' || regularKinds.has(group.kind),
        `level ${level.number} contains only known units`);
      if (group.kind === 'leaper' || group.kind === 'slinger') {
        assert.equal(group.name, names[group.kind]);
        assert.equal(group.bossTier, undefined);
      }
    }
  }

  const eligible = LEVELS.filter((level) => level.enemyCount > 3).map((level) => level.number);
  assert.equal(eligible.length, 29, 'replacing units does not change the light-wave gate');
  assert.equal(eligible[0], 7);
  assert.equal(getLevel(30).enemyCount, 3, 'the chapter-three milestone retains no light wave');
  assert.equal(LEVELS.filter((level) => level.isCheckpoint).length, 16);

  for (const [kind, numbers] of [
    ['leaper', [8, 22, 36, 50]],
    ['slinger', [18, 32, 46]],
  ]) {
    const groups = numbers.map((number) => getLevel(number).waves
      .flatMap((wave) => wave.groups).find((group) => group.kind === kind));
    assert.ok(groups.every(Boolean), `${kind} remains present across later chapters`);
    for (let index = 1; index < groups.length; index++) {
      assert.ok(groups[index].maxHp > groups[index - 1].maxHp,
        `${kind} gains health with the chapter`);
      assert.ok(groups[index].damageScale > groups[index - 1].damageScale,
        `${kind} gains damage with the chapter`);
    }
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

test('all 56 campaign arenas span 1920px with bounded, connected walkable stairs', () => {
  assert.equal(CAMPAIGN_WORLD_WIDTH, 1920);
  assert.equal(LEVELS.length, 56);
  for (const level of LEVELS) {
    assert.equal(level.arena.width, CAMPAIGN_WORLD_WIDTH);
    assert.equal(level.platforms, level.arena.platforms);
    assert.ok(level.platforms.some((platform) => platform.x > 1600), `level ${level.number} uses the far end`);
    for (const item of [...level.platforms, ...level.hazards]) {
      assert.ok(item.x >= 0 && item.x + item.w <= CAMPAIGN_WORLD_WIDTH, `level ${level.number} x bounds`);
      assert.ok(item.y >= 0 && item.y + item.h <= 540, `level ${level.number} y bounds`);
      assert.ok(item.w > 0 && item.h > 0);
    }

    const groups = new Map();
    for (const step of level.platforms.filter((platform) => platform.kind === 'stair')) {
      assert.ok(['west', 'east'].includes(step.stairGroup));
      assert.ok(['up', 'down'].includes(step.stairDirection));
      if (!groups.has(step.stairGroup)) groups.set(step.stairGroup, []);
      groups.get(step.stairGroup).push(step);
    }
    assert.ok(groups.has('west'));
    assert.equal(groups.has('east'), level.stage >= 6);
    for (const [group, unsorted] of groups) {
      const steps = unsorted.sort((a, b) => a.stairIndex - b.stairIndex);
      const direction = group === 'west' ? 'up' : 'down';
      const last = steps.at(-1);
      assert.equal(steps[0].stairIndex, 0);
      assert.ok(steps.every((step) => step.stairDirection === direction && step.w === 50));
      for (let index = 1; index < steps.length; index++) {
        assert.equal(steps[index].stairIndex, index);
        assert.equal(steps[index].x, steps[index - 1].x + steps[index - 1].w);
        assert.equal(steps[index].y - steps[index - 1].y, direction === 'up' ? -12 : 12);
      }
      assert.equal(direction === 'up' ? steps[0].y : last.y, level.groundY - 12);
      assert.ok(level.platforms.some((platform) => platform.kind !== 'stair'
        && platform.y === (direction === 'up' ? last.y : steps[0].y)
        && (direction === 'up' ? platform.x === last.x + last.w
          : platform.x + platform.w === steps[0].x)), `level ${level.number} ${group} landing`);
    }
  }
});

test('platform challenge grows through the chapter without changing waves or falling hazards', () => {
  const expected = [
    [1, 3, 0, 0], [4, 4, 0, 0], [5, 4, 1, 0], [6, 7, 1, 0],
    [8, 8, 1, 1], [9, 9, 1, 1], [11, 9, 2, 1], [12, 10, 2, 1],
    [13, 11, 2, 2], [14, 11, 2, 2],
  ];
  for (let chapter = 0; chapter < 4; chapter++) {
    let previousScore = -1;
    for (let stage = 1; stage <= 14; stage++) {
      const level = LEVELS[chapter * 14 + stage - 1];
      const stairCount = level.platforms.filter((platform) => platform.kind === 'stair').length;
      const floating = level.platforms.filter((platform) => platform.motion === 'float');
      const rotating = level.platforms.filter((platform) => platform.motion === 'rotate');
      assert.deepEqual(floating.map((platform) => platform.axis).sort(),
        stage >= 11 ? ['x', 'y'] : stage >= 5 ? ['y'] : [],
        `level ${level.number} introduces sideways drift only in the later stages`);
      const score = stairCount + floating.length * 2 + rotating.length * 2;
      assert.ok(score >= previousScore, `level ${level.number} must not lose platform complexity`);
      previousScore = score;
      const tier = expected.find(([position]) => position === stage);
      if (tier) assert.deepEqual([stairCount, floating.length, rotating.length], tier.slice(1));
      if (stage === 1) assert.equal(level.hazards.length, 0);

      for (const platform of [...floating, ...rotating]) {
        assert.equal(platform.baseY, platform.y);
        assert.equal(platform.phase, 0);
        assert.ok(Number.isInteger(platform.period) && platform.period > 0);
        assert.ok(platform.amplitude > 0);
        if (platform.motion === 'rotate') {
          assert.equal(platform.baseX, platform.x + platform.w / 2);
          assert.equal(platform.type, 'log');
          assert.equal(platform.baseAngle, 0);
          assert.equal(platform.angle, 0);
          assert.ok(platform.amplitude <= 0.2, `level ${level.number} bar remains standable`);
        } else {
          assert.equal(platform.baseX, platform.x);
          assert.equal(platform.angle, undefined);
          if (platform.axis === 'x') {
            assert.equal(platform.amplitude, 20 + (stage - 11) * 4,
              `level ${level.number} horizontal travel grows by stage`);
            assert.equal(platform.period, 205 - stage * 2);
            assert.ok(platform.x - platform.amplitude >= 0);
            assert.ok(platform.x + platform.w + platform.amplitude <= CAMPAIGN_WORLD_WIDTH);
          } else {
            assert.equal(platform.axis, 'y');
            assert.ok(platform.amplitude <= 24, `level ${level.number} vertical float stays reachable`);
          }
        }
      }
    }
  }
  assert.equal(LEVELS.flatMap((level) => level.platforms)
    .filter((platform) => platform.motion === 'float' && platform.axis === 'x').length, 16);
});
