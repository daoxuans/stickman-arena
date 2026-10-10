import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebSocket } from 'ws';

import { createGameServer } from '../server/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function inboxFor(socket) {
  const messages = [];
  const waiters = [];

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) {
      messages.push(message);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  socket.on('error', () => {});

  return {
    next(predicate, timeoutMs = 3000) {
      const index = messages.findIndex(predicate);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const position = waiters.indexOf(waiter);
          if (position !== -1) waiters.splice(position, 1);
          reject(new Error(`Timed out waiting for server message; seen: ${JSON.stringify(messages.map((item) => item.type))}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = inboxFor(socket);
  await once(socket, 'open');
  return { socket, inbox, send(message) { socket.send(JSON.stringify(message)); } };
}

async function createTestServer(t, options = {}) {
  const instance = await createGameServer({ port: 0, host: '127.0.0.1', ...options });
  t.after(() => instance.close());
  return instance;
}

async function startMatch(game) {
  const a = await connect(game.port);
  const b = await connect(game.port);
  a.send({ type: 'create' });
  const { code } = await a.inbox.next((message) => message.type === 'created');
  b.send({ type: 'join', code });
  await Promise.all([
    a.inbox.next((message) => message.type === 'start'),
    b.inbox.next((message) => message.type === 'start'),
  ]);
  const first = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing');
  return { a, b, code, first };
}

async function sendShortTap(player, key, seq = 0) {
  const pong = once(player.socket, 'pong');
  player.send({ type: 'input', seq, input: { [key]: true } });
  player.send({ type: 'input', seq: seq + 1, input: { [key]: false } });
  // The pong confirms both WebSocket messages were handled before observing
  // the following simulation snapshots; no sleep-based timing is required.
  player.socket.ping();
  await pong;
}

async function rawRequest(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: requestPath }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

test('serves only public and shared files, never server source', async (t) => {
  const game = await createTestServer(t);
  const privateFile = await rawRequest(game.port, '/server/index.js');
  assert.equal(privateFile.status, 404);
  assert.doesNotMatch(privateFile.body, /createGameServer/);

  const traversal = await rawRequest(game.port, '/%2e%2e%2fserver%2findex.js');
  assert.ok([400, 404].includes(traversal.status));
  assert.doesNotMatch(traversal.body, /createGameServer/);

  if (existsSync(path.join(projectRoot, 'public', 'index.html'))) {
    const page = await rawRequest(game.port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<!doctype html/i);
  }
  if (existsSync(path.join(projectRoot, 'shared', 'combat.js'))) {
    const shared = await rawRequest(game.port, '/shared/combat.js');
    assert.equal(shared.status, 200);
    assert.match(shared.body, /stepCombat/);
  }
});

test('creates six-digit room codes and synchronizes two players from one authority', async (t) => {
  const game = await createTestServer(t, { countdownSeconds: 0.05 });
  const a = await connect(game.port);
  const b = await connect(game.port);

  a.send({ type: 'create', theme: 'forest' });
  const created = await a.inbox.next((message) => message.type === 'created');
  assert.match(created.code, /^\d{6}$/);
  assert.equal(created.role, 'p1');
  assert.equal(created.theme, 'forest');
  assert.equal((await a.inbox.next((message) => message.type === 'waiting')).players, 1);

  b.send({ type: 'join', code: created.code });
  const joined = await b.inbox.next((message) => message.type === 'joined');
  assert.equal(joined.role, 'p2');
  assert.equal(joined.code, created.code);
  assert.equal((await a.inbox.next((message) => message.type === 'countdown')).seconds > 0, true);
  assert.equal((await b.inbox.next((message) => message.type === 'countdown')).seconds > 0, true);
  await Promise.all([
    a.inbox.next((message) => message.type === 'start'),
    b.inbox.next((message) => message.type === 'start'),
  ]);

  const [first, second] = await Promise.all([
    a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'),
    b.inbox.next((message) => message.type === 'state' && message.phase === 'playing'),
  ]);
  assert.equal(first.code, created.code);
  assert.equal(first.state.tick, second.state.tick);
  assert.deepEqual(first.state.fighters, second.state.fighters);

  a.send({ type: 'input', seq: 2, input: { right: true } });
  a.send({ type: 'input', seq: 1, input: { left: true } });
  const moved = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing' && message.state.tick >= first.state.tick + 8);
  assert.ok(moved.state.fighters[0].x > first.state.fighters[0].x, 'stale seq must not reverse accepted movement');

  a.send({ type: 'input', seq: 3, input: { kick: 'yes' } });
  assert.equal((await a.inbox.next((message) => message.type === 'error')).message, '输入格式错误');
  a.send({ type: 'input', seq: 4, input: { kick: true } });
  const kicked = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.fighters[0].kickTick > 0);
  assert.ok(kicked.state.fighters[0].kickType, 'valid kick input should reach the authoritative simulation');
});

test('expires idle waiting rooms, rejects the old code, and lets the owner create another room', async (t) => {
  const game = await createTestServer(t, { waitingRoomTimeoutMs: 50 });
  const owner = await connect(game.port);
  const guest = await connect(game.port);

  owner.send({ type: 'create', theme: 'forest' });
  const original = await owner.inbox.next((message) => message.type === 'created');
  await owner.inbox.next((message) => message.type === 'waiting' && message.code === original.code);

  const expired = await owner.inbox.next((message) => message.type === 'room-expired');
  assert.equal(expired.code, original.code);
  assert.match(expired.message, /等待房已过期/);

  guest.send({ type: 'join', code: original.code });
  assert.equal((await guest.inbox.next((message) => message.type === 'error')).message, '房间不存在或已结束');

  owner.send({ type: 'create', theme: 'ocean' });
  const replacement = await owner.inbox.next((message) => message.type === 'created');
  assert.equal(replacement.role, 'p1');
  assert.equal(replacement.theme, 'ocean');
  await owner.inbox.next((message) => message.type === 'waiting' && message.code === replacement.code);
});

test('a press released between simulation ticks still triggers each edge-based action once', async (t) => {
  for (const [key, activated] of [
    ['kick', (state) => state.fighters[0].kickType === 'ground'
      && state.events.some((event) => event.type === 'kick')],
    ['attack', (state) => state.fighters[0].attackStage === 1],
    ['jump', (state) => state.events.some((event) => event.type === 'jump')],
    ['dodge', (state) => state.events.some((event) => event.type === 'dodge')],
  ]) {
    await t.test(key, async (subtest) => {
      const game = await createTestServer(subtest, { tickRate: 10, countdownSeconds: 0.02 });
      const { a, first } = await startMatch(game);
      await sendShortTap(a, key);
      const pressed = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
        && message.state.tick > first.state.tick && activated(message.state));
      assert.equal(pressed.state.fighters[0].prevInput[key], true, `${key} edge must reach combat`);
      const released = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
        && message.state.tick > pressed.state.tick && !message.state.fighters[0].prevInput[key]);
      assert.equal(released.state.fighters[0].prevInput[key], false, `${key} tap must not stay held`);
    });
  }
});

test('a second tap after an already sampled press gets a release frame and a fresh edge', async (t) => {
  const game = await createTestServer(t, { tickRate: 10, countdownSeconds: 0.02 });
  const { a, first } = await startMatch(game);
  a.send({ type: 'input', seq: 0, input: { kick: true } });
  const held = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.tick > first.state.tick && message.state.fighters[0].prevInput.kick);
  a.send({ type: 'input', seq: 1, input: { kick: false } });
  await sendShortTap(a, 'kick', 2);
  const released = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.tick > held.state.tick && !message.state.fighters[0].prevInput.kick);
  const pressedAgain = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.tick > released.state.tick && message.state.fighters[0].prevInput.kick);
  assert.ok(pressedAgain.state.tick > released.state.tick);
});

test('a short tap during hitstop waits for the next step that samples controls', async (t) => {
  const game = await createTestServer(t, { tickRate: 20, countdownSeconds: 0.02, roundSeconds: 20 });
  const { a, b } = await startMatch(game);
  a.send({ type: 'input', seq: 0, input: { right: true } });
  b.send({ type: 'input', seq: 0, input: { left: true } });
  const close = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.fighters[1].x - message.state.fighters[0].x < 90, 5000);
  assert.ok(close.state.fighters[0].facing > 0);
  a.send({ type: 'input', seq: 1, input: {} });
  b.send({ type: 'input', seq: 1, input: {} });
  await sendShortTap(a, 'kick', 2);
  const hit = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.hitstop > 0 && message.state.events.some((event) => event.type === 'hit'));
  await sendShortTap(a, 'jump', 4);
  const sampled = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.tick > hit.state.tick && message.state.hitstop === 0
    && message.state.fighters[0].prevInput.jump);
  assert.equal(sampled.state.fighters[0].prevInput.jump, true);
});

test('two I taps arriving before a server frame aim then commit one bounded PvP spear', async (t) => {
  const game = await createTestServer(t, { tickRate: 20, countdownSeconds: 0.02 });
  const { a, b, first } = await startMatch(game);
  assert.equal(first.state.arena.width, 2880);
  assert.deepEqual(first.state.fighters.map((fighter) => fighter.spearRemaining), [5, 5]);
  const pong = once(a.socket, 'pong');
  for (const [seq, spear] of [[0, true], [1, false], [2, true], [3, false]]) {
    a.send({ type: 'input', seq, input: { spear } });
  }
  a.socket.ping();
  await pong;
  const aimed = await a.inbox.next((message) => message.type === 'state'
    && message.phase === 'playing'
    && message.state.events.some((entry) => entry.type === 'spear-aim'));
  assert.equal(aimed.state.fighters[0].spearAiming, true);
  assert.equal(aimed.state.fighters[0].spearRemaining, 5);
  const committed = await a.inbox.next((message) => message.type === 'state'
    && message.phase === 'playing'
    && message.state.events.some((entry) => entry.type === 'spear-windup'));
  assert.ok(committed.state.tick >= aimed.state.tick + 2,
    'the authority samples a release between the two I edges');
  assert.ok(committed.state.fighters[0].spearWindup > 0);
  assert.equal(committed.state.fighters[0].spearRemaining, 5);
  const thrown = await a.inbox.next((message) => message.type === 'state'
    && message.phase === 'playing'
    && message.state.events.some((entry) => entry.type === 'spear-throw'), 5000);
  assert.equal(thrown.state.fighters[0].spearRemaining, 4);
  assert.equal(thrown.state.fighters[1].spearRemaining, 5);
  assert.equal(thrown.state.events.filter((entry) => entry.type === 'spear-throw').length, 1);
  const synchronized = await b.inbox.next((message) => message.type === 'state'
    && message.state.tick === thrown.state.tick);
  assert.deepEqual(synchronized.state.fighters, thrown.state.fighters);
});

test('Esc or a competing attack clears queued I taps without a ghost throw', async (t) => {
  for (const cancel of ['aimCancel', 'attack']) {
    await t.test(cancel, async (subtest) => {
      const game = await createTestServer(subtest, { tickRate: 10, countdownSeconds: 0.02 });
      const { a, first } = await startMatch(game);
      const pong = once(a.socket, 'pong');
      for (const [seq, input] of [
        [0, { spear: true }], [1, { spear: false }],
        [2, { spear: true }], [3, { spear: false }],
        [4, { [cancel]: true }], [5, { [cancel]: false }],
      ]) a.send({ type: 'input', seq, input });
      a.socket.ping();
      await pong;
      let lastTick = first.state.tick;
      for (let frame = 0; frame < 5; frame++) {
        const next = await a.inbox.next((message) => message.type === 'state'
          && message.phase === 'playing' && message.state.tick > lastTick);
        lastTick = next.state.tick;
        assert.equal(next.state.fighters[0].spearAiming, false, cancel);
        assert.equal(next.state.fighters[0].spearWindup, 0, cancel);
        assert.equal(next.state.fighters[0].spearRemaining, 5, cancel);
        assert.ok(!next.state.events.some((entry) => entry.type.startsWith('spear-')),
          `${cancel} must not produce a delayed spear event`);
      }
    });
  }
});

test('duel inputs reject malformed angles, spoofed roles, private powers and unknown fields', async (t) => {
  const game = await createTestServer(t, { countdownSeconds: 0.02 });
  const { a, b, first } = await startMatch(game);
  for (const input of [
    { special: 1 }, { spear: 'true' }, { aimUp: 'yes' },
    { aimAngle: null }, { aimAngle: 72.1 }, { aimAngle: -8 },
    { bossSkill: 'rock' }, { equipment: true }, { hp: 0 },
    { target: 'p1', attack: true },
  ]) {
    b.send({ type: 'input', seq: 0, input });
    assert.equal((await b.inbox.next((message) => message.type === 'error')).message,
      '输入格式错误', JSON.stringify(input));
  }
  b.send({ type: 'input', seq: 0, role: 'p1', input: { special: true } });
  assert.equal((await b.inbox.next((message) => message.type === 'error')).message, '输入格式错误');
  b.send({ type: 'input', seq: 0, input: { spear: true } });
  const p2Aim = await b.inbox.next((message) => message.type === 'state'
    && message.phase === 'playing' && message.state.tick > first.state.tick
    && message.state.events.some((entry) => entry.type === 'spear-aim' && entry.source === 'p2'));
  assert.equal(p2Aim.state.fighters[0].spearAiming, false);
  assert.equal(p2Aim.state.fighters[1].spearAiming, true);
  b.send({ type: 'input', seq: 1, input: { aimAngle: 57.5 } });
  const adjusted = await b.inbox.next((message) => message.type === 'state'
    && message.phase === 'playing' && message.state.tick > p2Aim.state.tick
    && message.state.fighters[1].spearAimAngle === 57.5);
  assert.equal(adjusted.state.fighters[0].spearRemaining, 5);
});

test('both consented rematches rebuild ammo and wave charge at their initial values', async (t) => {
  const game = await createTestServer(t, {
    countdownSeconds: 0.02, roundSeconds: 0.75,
  });
  const { a, b, code } = await startMatch(game);
  // Two I edges separated by a sampled release, then a real launch.
  await sendShortTap(a, 'spear', 0);
  await sendShortTap(a, 'spear', 2);
  const spent = await a.inbox.next((message) => message.type === 'state'
    && message.state.events.some((entry) => entry.type === 'spear-throw'), 3000);
  assert.equal(spent.state.fighters[0].spearRemaining, 4);
  const finished = await a.inbox.next((message) => message.type === 'finished');
  assert.equal(finished.code, code);
  a.send({ type: 'rematch' });
  b.send({ type: 'rematch' });
  await Promise.all([
    a.inbox.next((message) => message.type === 'start'),
    b.inbox.next((message) => message.type === 'start'),
  ]);
  const fresh = await a.inbox.next((message) => message.type === 'state'
    && message.phase === 'playing' && message.state.tick === 0);
  assert.deepEqual(fresh.state.fighters.map(({ spearRemaining, duelWaveHits,
    duelWaveCharge, spearAiming, spearWindup }) => ({
    spearRemaining, duelWaveHits, duelWaveCharge, spearAiming, spearWindup,
  })), [0, 1].map(() => ({ spearRemaining: 5, duelWaveHits: 0,
    duelWaveCharge: 0, spearAiming: false, spearWindup: 0 })));
  assert.equal(fresh.state.motionTick, 0, 'animated platforms reset their phase with the round');
  assert.equal(fresh.state.projectiles.length, 0);
});

test('invalid and countdown input cannot poison the next round sequence or latch', async (t) => {
  const game = await createTestServer(t, { tickRate: 10, countdownSeconds: 0.3 });
  const a = await connect(game.port);
  const b = await connect(game.port);
  a.send({ type: 'create' });
  const { code } = await a.inbox.next((message) => message.type === 'created');
  b.send({ type: 'join', code });
  await a.inbox.next((message) => message.type === 'countdown');
  a.send({ type: 'input', seq: 99, input: { kick: true } });
  const pong = once(a.socket, 'pong');
  a.socket.ping();
  await pong;
  await a.inbox.next((message) => message.type === 'start');
  const first = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing');
  assert.equal(first.state.fighters[0].kickType, null, 'countdown presses must not leak into play');

  a.send({ type: 'input', seq: 0, input: { kick: 'yes' } });
  assert.equal((await a.inbox.next((message) => message.type === 'error')).message, '输入格式错误');
  await sendShortTap(a, 'kick', 0);
  const kicked = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.tick > first.state.tick && message.state.events.some((event) => event.type === 'kick'));
  assert.equal(kicked.state.fighters[0].kickType, 'ground');
});

test('rejects malformed messages and invalid room access without crashing', async (t) => {
  const game = await createTestServer(t);
  const a = await connect(game.port);
  a.socket.send('{bad json');
  assert.equal((await a.inbox.next((message) => message.type === 'error')).type, 'error');
  a.send({ type: 'join', code: '123' });
  assert.equal((await a.inbox.next((message) => message.type === 'error')).type, 'error');
  a.send({ type: 'input', seq: 0, input: { attack: true } });
  assert.equal((await a.inbox.next((message) => message.type === 'error')).type, 'error');
  a.send({ type: 'create', theme: 'ocean' });
  assert.equal((await a.inbox.next((message) => message.type === 'created')).theme, 'ocean');
});

test('declares timeout and restarts only after both players request a rematch', async (t) => {
  const game = await createTestServer(t, { countdownSeconds: 0.02, roundSeconds: 0.2 });
  const a = await connect(game.port);
  const b = await connect(game.port);
  a.send({ type: 'create' });
  const { code } = await a.inbox.next((message) => message.type === 'created');
  b.send({ type: 'join', code });
  await Promise.all([
    a.inbox.next((message) => message.type === 'start'),
    b.inbox.next((message) => message.type === 'start'),
  ]);
  const [aFinished, bFinished] = await Promise.all([
    a.inbox.next((message) => message.type === 'finished'),
    b.inbox.next((message) => message.type === 'finished'),
  ]);
  assert.equal(aFinished.reason, 'timeout');
  assert.equal(aFinished.state.status, 'finished');
  assert.equal(aFinished.winner, bFinished.winner);

  a.send({ type: 'input', seq: 999, input: { kick: true } });
  a.send({ type: 'rematch' });
  assert.equal((await a.inbox.next((message) => message.type === 'rematch')).ready, 1);
  b.send({ type: 'rematch' });
  assert.equal((await b.inbox.next((message) => message.type === 'rematch' && message.ready === 2)).ready, 2);
  await Promise.all([
    a.inbox.next((message) => message.type === 'start'),
    b.inbox.next((message) => message.type === 'start'),
  ]);
  await sendShortTap(a, 'kick', 0);
  const replayKick = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.events.some((event) => event.type === 'kick'));
  assert.equal(replayKick.state.fighters[0].kickType, 'ground', 'new round accepts seq 0 without replaying old input');
  assert.equal((await a.inbox.next((message) => message.type === 'finished')).reason, 'timeout');
});

test('notifies on disconnect and allows a waiting host to accept a new opponent', async (t) => {
  const game = await createTestServer(t, { countdownSeconds: 0.02 });
  const a = await connect(game.port);
  const b = await connect(game.port);
  a.send({ type: 'create' });
  const { code } = await a.inbox.next((message) => message.type === 'created');
  b.send({ type: 'join', code });
  await a.inbox.next((message) => message.type === 'start');
  await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing' && message.state.tick === 0);
  a.send({ type: 'input', seq: 0, input: { kick: true } });
  a.send({ type: 'input', seq: 1, input: { kick: false } });
  b.socket.close();
  assert.equal((await a.inbox.next((message) => message.type === 'peer-left')).code, code);
  assert.equal((await a.inbox.next((message) => message.type === 'waiting')).players, 1);

  const c = await connect(game.port);
  c.send({ type: 'join', code });
  assert.equal((await c.inbox.next((message) => message.type === 'joined')).role, 'p2');
  await a.inbox.next((message) => message.type === 'start');
  const restarted = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.tick === 0);
  assert.equal(restarted.state.fighters[0].kickType, null, 'old pending taps are cleared after a disconnect');
  await sendShortTap(a, 'kick', 0);
  const newKick = await a.inbox.next((message) => message.type === 'state' && message.phase === 'playing'
    && message.state.events.some((event) => event.type === 'kick'));
  assert.equal(newKick.state.fighters[0].kickType, 'ground');
});
