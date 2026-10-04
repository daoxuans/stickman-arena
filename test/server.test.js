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
