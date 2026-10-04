import { randomInt } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

import { TICK_RATE, createDuelState, stepCombat } from '../shared/combat.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const sharedRoot = path.join(projectRoot, 'shared');
const themes = new Set(['forest', 'city', 'ocean', 'land']);
const inputKeys = ['left', 'right', 'jump', 'attack', 'kick', 'dodge'];
const edgeKeys = ['jump', 'attack', 'kick', 'dodge'];
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function emptyInput() {
  return { left: false, right: false, jump: false, attack: false, kick: false, dodge: false };
}

function emptyPresses() {
  return { jump: false, attack: false, kick: false, dodge: false };
}

function resetControls(room) {
  room.inputs = { p1: emptyInput(), p2: emptyInput() };
  room.pendingPresses = { p1: emptyPresses(), p2: emptyPresses() };
}

function acceptInput(room, role, input) {
  const previous = room.inputs[role];
  const pending = room.pendingPresses[role];
  // A press and release can both arrive before the next simulation step.
  // Latch at most one rising edge per action, rather than retaining a queue
  // that a rapid or hostile client could grow without bound.
  for (const key of edgeKeys) if (input[key] && !previous[key]) pending[key] = true;
  room.inputs[role] = input;
}

function inputForTick(room, role) {
  const input = { ...room.inputs[role] };
  const pending = room.pendingPresses[role];
  const sampledLastTick = room.state.fighters.find((fighter) => fighter.id === role)?.prevInput ?? {};
  for (const key of edgeKeys) {
    if (!pending[key]) continue;
    if (sampledLastTick[key]) {
      // A release/re-press between steps needs one sampled release before
      // combat's existing edge detector can see the next press.
      input[key] = false;
    } else {
      input[key] = true;
      pending[key] = false;
    }
  }
  return input;
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(socket, message) {
  send(socket, { type: 'error', message });
}

function broadcast(room, message) {
  send(room.p1, message);
  send(room.p2, message);
}

function resolvedFile(urlPath) {
  const isShared = urlPath.startsWith('/shared/');
  const root = isShared ? sharedRoot : publicRoot;
  const suffix = isShared ? urlPath.slice('/shared/'.length) : urlPath.slice(1);
  const decoded = decodeURIComponent(suffix || (isShared ? '' : 'index.html'));
  if (!decoded || decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  if (segments.some((segment) => !segment || segment === '..' || segment.startsWith('.'))) return null;
  const file = path.resolve(root, ...segments);
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  return { root, file };
}

async function serveFile(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  let candidate;
  try {
    candidate = resolvedFile(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  if (!candidate) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  try {
    // realpath also prevents a symlink placed in public/ from escaping the web root.
    const [root, file] = await Promise.all([realpath(candidate.root), realpath(candidate.file)]);
    if (!file.startsWith(`${root}${path.sep}`) || !(await stat(file)).isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const clean = emptyInput();
  for (const key of inputKeys) {
    if (key in input && typeof input[key] !== 'boolean') return null;
    clean[key] = input[key] === true;
  }
  return clean;
}

/**
 * Create a local HTTP + WebSocket game server.
 * countdownSeconds and roundSeconds are configurable so integration tests do
 * not need to wait through a full match; normal play uses three/99 seconds.
 */
export async function createGameServer({
  port = 0,
  host = '127.0.0.1',
  tickRate = TICK_RATE,
  countdownSeconds = 3,
  roundSeconds = 99,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid port');
  if (typeof host !== 'string' || !host) throw new TypeError('Invalid host');
  if (!Number.isInteger(tickRate) || tickRate < 10 || tickRate > 120) throw new RangeError('Invalid tick rate');
  if (!Number.isFinite(countdownSeconds) || countdownSeconds <= 0 || countdownSeconds > 10) {
    throw new RangeError('Invalid countdown duration');
  }
  if (!Number.isFinite(roundSeconds) || roundSeconds <= 0 || roundSeconds > 600) {
    throw new RangeError('Invalid round duration');
  }

  const rooms = new Map();
  const sessions = new WeakMap();
  const server = http.createServer(serveFile);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  let scheduler;
  let closing = false;
  let closePromise;

  function newCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = String(randomInt(1_000_000)).padStart(6, '0');
      if (!rooms.has(code)) return code;
    }
    throw new Error('No available room code');
  }

  function snapshot(room) {
    const state = { ...room.state, events: room.pendingEvents.splice(0) };
    broadcast(room, {
      type: 'state',
      code: room.code,
      phase: room.phase,
      countdown: room.phase === 'countdown' ? Math.ceil(room.countdownTicks / tickRate) : 0,
      state,
    });
  }

  function beginCountdown(room) {
    room.state = createDuelState(room.theme);
    room.state.timerTicks = Math.max(1, Math.round(roundSeconds * TICK_RATE));
    room.phase = 'countdown';
    room.countdownTicks = Math.max(1, Math.round(countdownSeconds * tickRate));
    room.lastCountdown = Math.ceil(room.countdownTicks / tickRate);
    room.snapshotTicks = 0;
    room.pendingEvents = [];
    resetControls(room);
    room.rematch.clear();
    sessions.get(room.p1).lastSeq = -1;
    sessions.get(room.p2).lastSeq = -1;
    broadcast(room, { type: 'countdown', code: room.code, seconds: room.lastCountdown });
    snapshot(room);
  }

  function leaveRoom(socket) {
    const session = sessions.get(socket);
    const room = session?.room;
    if (!room) return;
    session.room = null;
    session.role = null;
    session.lastSeq = -1;
    room.rematch.delete(socket);

    if (room.p1 === socket) {
      rooms.delete(room.code);
      if (room.p2) {
        const peer = sessions.get(room.p2);
        peer.room = null;
        peer.role = null;
        peer.lastSeq = -1;
        send(room.p2, { type: 'peer-left', code: room.code });
      }
    } else {
      room.p2 = null;
      room.state = null;
      room.phase = 'waiting';
      resetControls(room);
      room.pendingEvents = [];
      room.lastActivity = performance.now();
      send(room.p1, { type: 'peer-left', code: room.code });
      send(room.p1, { type: 'waiting', code: room.code, players: 1 });
    }
  }

  function handleMessage(socket, raw, isBinary) {
    const session = sessions.get(socket);
    if (isBinary) return sendError(socket, '只接受 JSON 文本消息');

    const now = performance.now();
    if (now - session.rateWindow > 1000) {
      session.rateWindow = now;
      session.rateCount = 0;
    }
    session.rateCount += 1;
    if (session.rateCount > 120) {
      if (session.rateCount === 121) sendError(socket, '消息过于频繁');
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendError(socket, '消息不是有效 JSON');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      return sendError(socket, '消息格式错误');
    }

    switch (message.type) {
      case 'create': {
        if (session.room) return sendError(socket, '请先离开当前房间');
        if (rooms.size >= 512) return sendError(socket, '房间已满，请稍后再试');
        const theme = message.theme ?? 'city';
        if (!themes.has(theme)) return sendError(socket, '不支持的场景主题');
        const code = newCode();
        const room = {
          code, theme, p1: socket, p2: null, state: null, phase: 'waiting',
          rematch: new Set(), pendingEvents: [], lastActivity: now,
        };
        resetControls(room);
        rooms.set(code, room);
        session.room = room;
        session.role = 'p1';
        session.lastSeq = -1;
        send(socket, { type: 'created', code, role: 'p1', theme });
        send(socket, { type: 'waiting', code, players: 1 });
        return;
      }
      case 'join': {
        if (session.room) return sendError(socket, '请先离开当前房间');
        if (typeof message.code !== 'string' || !/^\d{6}$/.test(message.code)) {
          return sendError(socket, '房间码必须是六位数字');
        }
        const room = rooms.get(message.code);
        if (!room) return sendError(socket, '房间不存在或已结束');
        if (room.p2 || room.phase !== 'waiting') return sendError(socket, '房间已满');
        room.p2 = socket;
        room.lastActivity = now;
        session.room = room;
        session.role = 'p2';
        session.lastSeq = -1;
        send(socket, { type: 'joined', code: room.code, role: 'p2', theme: room.theme });
        send(room.p1, { type: 'joined', code: room.code, role: 'p1', theme: room.theme });
        beginCountdown(room);
        return;
      }
      case 'input': {
        if (!session.room || !session.role) return sendError(socket, '请先加入房间');
        if (!Number.isSafeInteger(message.seq) || message.seq < 0) return sendError(socket, '输入序号无效');
        const input = validateInput(message.input);
        if (!input) return sendError(socket, '输入格式错误');
        // Countdown packets are ignored without consuming the sequence that
        // the browser restarts at zero on the round's `start` message.
        if (session.room.phase !== 'playing') return;
        if (message.seq <= session.lastSeq) return;
        session.lastSeq = message.seq;
        acceptInput(session.room, session.role, input);
        return;
      }
      case 'rematch': {
        const room = session.room;
        if (!room || !room.p2 || room.phase !== 'finished') return sendError(socket, '当前不能重赛');
        room.rematch.add(socket);
        broadcast(room, { type: 'rematch', code: room.code, ready: room.rematch.size, total: 2 });
        if (room.rematch.size === 2) beginCountdown(room);
        return;
      }
      case 'leave': {
        if (!session.room) return sendError(socket, '当前不在房间');
        const code = session.room.code;
        leaveRoom(socket);
        send(socket, { type: 'left', code });
        return;
      }
      default:
        return sendError(socket, '未知消息类型');
    }
  }

  function tickRoom(room, snapshotsEvery) {
    if (!room.p2) return;
    if (room.phase === 'countdown') {
      room.countdownTicks -= 1;
      const seconds = Math.ceil(room.countdownTicks / tickRate);
      if (seconds > 0 && seconds !== room.lastCountdown) {
        room.lastCountdown = seconds;
        broadcast(room, { type: 'countdown', code: room.code, seconds });
      }
      if (room.countdownTicks <= 0) {
        room.phase = 'playing';
        resetControls(room);
        sessions.get(room.p1).lastSeq = -1;
        sessions.get(room.p2).lastSeq = -1;
        send(room.p1, { type: 'start', code: room.code, role: 'p1', theme: room.theme });
        send(room.p2, { type: 'start', code: room.code, role: 'p2', theme: room.theme });
        snapshot(room);
      } else if (++room.snapshotTicks >= snapshotsEvery) {
        room.snapshotTicks = 0;
        snapshot(room);
      }
      return;
    }
    if (room.phase !== 'playing') return;

    // Combat ignores controls during hitstop. Keep the latched presses intact
    // until a step that can actually sample them, including very short taps.
    const sampled = room.state.hitstop > 0 ? room.inputs : {
      p1: inputForTick(room, 'p1'),
      p2: inputForTick(room, 'p2'),
    };
    stepCombat(room.state, sampled);
    if (Array.isArray(room.state.events) && room.state.events.length) {
      room.pendingEvents.push(...room.state.events);
      if (room.pendingEvents.length > 40) room.pendingEvents.splice(0, room.pendingEvents.length - 40);
    }
    if (room.state.status !== 'playing') {
      room.phase = 'finished';
      resetControls(room);
      const state = { ...room.state, events: room.pendingEvents.splice(0) };
      broadcast(room, {
        type: 'finished', code: room.code, state, winner: room.state.winner,
        reason: room.state.finishReason || (room.state.timerTicks <= 0 ? 'timeout' : 'ko'),
      });
    } else if (++room.snapshotTicks >= snapshotsEvery) {
      room.snapshotTicks = 0;
      snapshot(room);
    }
  }

  server.on('upgrade', (request, socket, head) => {
    if (closing) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== request.headers.host) {
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          return;
        }
      } catch {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });

  wss.on('connection', (socket) => {
    sessions.set(socket, { room: null, role: null, lastSeq: -1, rateWindow: performance.now(), rateCount: 0 });
    socket.on('message', (raw, isBinary) => handleMessage(socket, raw, isBinary));
    socket.on('close', () => { if (!closing) leaveRoom(socket); });
    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const frameMs = 1000 / tickRate;
  const snapshotsEvery = Math.max(1, Math.round(tickRate / 20));
  let previous = performance.now();
  let accumulated = 0;
  scheduler = setInterval(() => {
    const now = performance.now();
    accumulated += Math.min(now - previous, 250);
    previous = now;
    let steps = 0;
    while (accumulated >= frameMs && steps < 5) {
      for (const room of rooms.values()) {
        if (room.phase === 'waiting' && now - room.lastActivity > 15 * 60_000) {
          send(room.p1, { type: 'error', message: '房间已过期，请重新创建' });
          const owner = sessions.get(room.p1);
          if (owner) { owner.room = null; owner.role = null; }
          rooms.delete(room.code);
          continue;
        }
        tickRoom(room, snapshotsEvery);
      }
      accumulated -= frameMs;
      steps += 1;
    }
    if (steps === 5) accumulated = Math.min(accumulated, frameMs * 5);
  }, Math.max(4, Math.floor(frameMs / 2)));

  return {
    server,
    wss,
    host,
    port: server.address().port,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(scheduler);
      rooms.clear();
      for (const socket of wss.clients) socket.terminate();
      closePromise = Promise.all([
        new Promise((resolve) => wss.close(resolve)),
        new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
      ]).then(() => {});
      return closePromise;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT ?? '3000');
  createGameServer({ host, port }).then((game) => {
    console.log(`Stickman Arena: http://${host}:${game.port}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
