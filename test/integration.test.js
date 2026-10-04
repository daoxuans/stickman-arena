import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CampaignSession } from '../public/campaign.js';
import { LEVELS, checkpointFor } from '../shared/levels.js';

function seededStorage(number) {
  const record = JSON.stringify({
    currentLevel: number, checkpointLevel: checkpointFor(number),
    deaths: 0, completed: false, cleared: [],
  });
  return {
    getItem: () => record,
    setItem: () => {},
    removeItem: () => {},
  };
}

test('every configured stage can instantiate and simulate a live fight', () => {
  for (const stage of LEVELS) {
    const session = new CampaignSession({ storage: seededStorage(stage.number) });
    let view = session.start();
    assert.equal(view.level.number, stage.number);
    assert.equal(view.combat.arena.theme, stage.theme);
    assert.ok(view.combat.fighters.some((fighter) => fighter.team === 1));
    for (let tick = 0; tick < 120 && view.phase === 'playing'; tick++) {
      view = session.step({ right: tick < 50, attack: tick % 27 === 0, dodge: tick % 81 === 20 });
      for (const fighter of view.combat.fighters) {
        assert.ok(Number.isFinite(fighter.x) && Number.isFinite(fighter.y), `stage ${stage.number} has finite positions`);
        assert.ok(fighter.hp >= 0 && fighter.hp <= fighter.maxHp, `stage ${stage.number} has valid health`);
      }
    }
    assert.ok(['playing', 'failed', 'cleared', 'completed'].includes(view.phase));
  }
});

test('the campaign advances consecutively from stage 1 through all 56 bosses and checkpoints', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const session = new CampaignSession({ storage });
  let view = session.start();
  for (let number = 1; number <= 56; number++) {
    assert.equal(view.level.number, number);
    assert.equal(view.progress.checkpointLevel, checkpointFor(number));
    while (view.phase === 'playing') {
      for (const enemy of view.combat.fighters) if (enemy.team === 1) enemy.hp = 0;
      view = session.step();
    }
    if (number < 56) {
      assert.equal(view.phase, 'cleared');
      view = session.next();
    }
  }
  assert.equal(view.phase, 'completed');
  assert.equal(view.progress.cleared.length, 56);
  assert.equal(view.progress.currentLevel, 56);
});

test('the browser entry point contains each control used by its controller', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const idsLiteral = app.match(/const IDS = \[([\s\S]*?)\];/);
  assert.ok(idsLiteral, 'app controller exposes a required-ID list');
  const ids = [...idsLiteral[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(ids.length > 25);
  for (const id of ids) {
    assert.match(page, new RegExp(`id="${id}"`), `missing controller target #${id}`);
  }
  for (const control of ['left', 'right', 'attack', 'jump', 'dodge']) {
    assert.match(page, new RegExp(`data-key="${control}"`));
  }
  assert.match(page, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(page, /href="\.\/styles\.css"/);
});
