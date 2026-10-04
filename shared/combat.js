/**
 * Deterministic, fixed-step combat shared by the campaign and the room server.
 * Coordinates are logical canvas pixels (960 x 540); a fighter's y is at its feet.
 * Every call to stepCombat advances exactly one 1/60-second simulation tick.
 */
export const TICK_RATE = 60;
export const WORLD_WIDTH = 960;
export const WORLD_HEIGHT = 540;

const GRAVITY = 0.58;
const MAX_FALL_SPEED = 13;
const JUMP_SPEED = -11.7;
const DODGE_SPEED = 10.5;
const DODGE_TICKS = 11;
const DODGE_COOLDOWN = 54;

const ARCHETYPES = {
  hero: { hp: 100, speed: 4.45, mass: 1, damage: 1, height: 88 },
  grunt: { hp: 42, speed: 3.0, mass: 1, damage: 0.72, height: 84 },
  rusher: { hp: 34, speed: 4.4, mass: 0.82, damage: 0.68, height: 81 },
  runner: { hp: 34, speed: 4.4, mass: 0.82, damage: 0.68, height: 81 },
  guard: { hp: 58, speed: 2.7, mass: 1.25, damage: 0.88, height: 88 },
  brute: { hp: 76, speed: 2.4, mass: 1.55, damage: 1.08, height: 96 },
  heavy: { hp: 76, speed: 2.4, mass: 1.55, damage: 1.08, height: 96 },
  boss: { hp: 152, speed: 3.15, mass: 1.65, damage: 1.16, height: 105 },
};

const ATTACKS = [
  null,
  { duration: 22, activeFrom: 5, activeTo: 9, damage: 9, reach: 66, knockback: 5.1, stun: 15, freeze: 4 },
  { duration: 24, activeFrom: 6, activeTo: 11, damage: 11, reach: 71, knockback: 6.3, stun: 18, freeze: 5 },
  { duration: 31, activeFrom: 8, activeTo: 14, damage: 17, reach: 81, knockback: 9.1, stun: 25, freeze: 7 },
];
// Bosses visibly wind up before their strike; PvP and ordinary enemies keep
// the snappier shared move set.
const BOSS_ATTACKS = ATTACKS.map((strike) => strike && {
  ...strike,
  duration: strike.duration + 8,
  activeFrom: strike.activeFrom + 8,
  activeTo: strike.activeTo + 8,
});
const KICKS = Object.freeze({
  ground: Object.freeze({ duration: 20, activeFrom: 6, activeTo: 11, damage: 11, reach: 78, knockback: 6.8, stun: 19, freeze: 5 }),
  air: Object.freeze({ duration: 26, activeFrom: 7, activeTo: 16, damage: 16, reach: 96, knockback: 10.2, stun: 24, freeze: 7 }),
});

const BUTTONS = ['left', 'right', 'jump', 'attack', 'kick', 'dodge'];

function inputOf(value) {
  const input = {};
  for (const button of BUTTONS) input[button] = value?.[button] === true;
  return input;
}

function event(state, type, fields = {}) {
  state.events.push({ id: `${state.tick}:${state.events.length}`, type, ...fields });
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function approach(value, target, amount) {
  return value < target ? Math.min(target, value + amount) : Math.max(target, value - amount);
}

export function createFighter({
  id, name, x, y = 438, team = 0, kind = 'hero', maxHp, damageScale = 1,
} = {}) {
  if (!id || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError('A fighter needs an id and finite x/y coordinates');
  }
  const stats = ARCHETYPES[kind] ?? ARCHETYPES.grunt;
  const health = Math.max(1, Math.round(maxHp ?? stats.hp));
  return {
    id: String(id), name: name ?? (kind === 'hero' ? '火柴斗士' : '挑战者'),
    team, kind, x, y, vx: 0, vy: 0, facing: team === 0 ? 1 : -1,
    width: kind === 'boss' ? 35 : 29, height: stats.height,
    hp: health, maxHp: health, speed: stats.speed, mass: stats.mass,
    damageScale: stats.damage * damageScale,
    grounded: true, coyote: 6, jumpBuffer: 0,
    stun: 0, invulnerable: 0, hurtFlash: 0, hazardCooldown: 0,
    dodgeTicks: 0, dodgeCooldown: 0,
    attackStage: 0, attackTick: 0, comboStage: 0, comboWindow: 0,
    kickType: null, kickTick: 0, airKickUsed: false,
    attackBuffered: false, hitIds: [],
    prevInput: { left: false, right: false, jump: false, attack: false, kick: false, dodge: false },
  };
}

export function createCombatState({ mode = 'campaign', arena = {}, fighters = [], durationTicks = 0 } = {}) {
  return {
    mode,
    arena: {
      theme: arena.theme ?? 'forest',
      groundY: arena.groundY ?? 438,
      platforms: arena.platforms ?? [],
      hazards: arena.hazards ?? [],
    },
    fighters,
    events: [],
    tick: 0,
    hitstop: 0,
    status: 'playing',
    timerTicks: Math.max(0, Math.floor(durationTicks)),
    winner: null,
    finishReason: null,
  };
}

export function createDuelState(theme = 'city') {
  const selected = ['forest', 'city', 'ocean', 'land'].includes(theme) ? theme : 'city';
  const arena = {
    theme: selected,
    groundY: 438,
    // Symmetrical, hazard-free terrain keeps PvP outcomes about player inputs.
    platforms: [{ x: 410, y: 338, w: 140, h: 14 }],
    hazards: [],
  };
  return createCombatState({
    mode: 'duel', arena, durationTicks: 99 * TICK_RATE,
    fighters: [
      createFighter({ id: 'p1', name: '青色斗士', x: 270, y: arena.groundY, team: 0 }),
      createFighter({ id: 'p2', name: '赤色斗士', x: 690, y: arena.groundY, team: 1 }),
    ],
  });
}

function startAttack(fighter, stage) {
  fighter.attackStage = stage;
  fighter.attackTick = 0;
  fighter.comboStage = stage;
  fighter.comboWindow = 0;
  fighter.attackBuffered = false;
  fighter.hitIds = [];
}

export function attackOf(fighter) {
  return (fighter.kind === 'boss' ? BOSS_ATTACKS : ATTACKS)[fighter.attackStage];
}

/** The renderer and hit detection share one immutable move window. */
export function kickOf(fighter) {
  if (fighter?.kickType === 'ground') return KICKS.ground;
  if (fighter?.kickType === 'air') return KICKS.air;
  return null;
}

function startKick(state, fighter, type) {
  fighter.kickType = type;
  fighter.kickTick = 0;
  fighter.comboStage = 0;
  fighter.comboWindow = 0;
  fighter.attackBuffered = false;
  fighter.hitIds = [];
  if (type === 'air') fighter.airKickUsed = true;
  if (type === 'ground') emitKickEvent(state, fighter, type);
}

function emitKickEvent(state, fighter, type) {
  event(state, type === 'air' ? 'jump-kick' : 'kick', {
    x: fighter.x, y: fighter.y - fighter.height * (type === 'air' ? 0.55 : 0.4),
    source: fighter.id, facing: fighter.facing,
  });
}

function applyDamage(state, target, { amount, direction, knockback, stun, invulnerable = 9, source = null, heavy = false }) {
  if (target.hp <= 0 || target.invulnerable > 0 || target.dodgeTicks > 0) return false;
  const damage = Math.max(1, Math.round(amount));
  target.hp = Math.max(0, target.hp - damage);
  target.stun = Math.max(target.stun, stun);
  target.invulnerable = invulnerable;
  target.hurtFlash = 11;
  target.attackStage = 0;
  target.attackTick = 0;
  target.kickType = null;
  target.kickTick = 0;
  target.attackBuffered = false;
  target.comboWindow = 0;
  target.vx = direction * knockback / target.mass;
  target.vy = Math.min(target.vy, heavy ? -3.5 : -2.2);
  target.grounded = false;
  event(state, 'hit', {
    x: target.x, y: target.y - target.height * 0.57,
    damage, target: target.id, source, heavy,
  });
  if (target.hp === 0) {
    event(state, 'ko', { x: target.x, y: target.y - target.height * 0.45, target: target.id, source });
  }
  return true;
}

function collectAttacks(state) {
  const intents = [];
  for (const attacker of state.fighters) {
    if ((attacker.attackStage === 0 && !attacker.kickType) || attacker.hp <= 0) continue;
    const strike = attacker.kickType ? kickOf(attacker) : attackOf(attacker);
    const moveTick = attacker.kickType ? attacker.kickTick : attacker.attackTick;
    if (!strike || moveTick < strike.activeFrom || moveTick > strike.activeTo) continue;
    for (const target of state.fighters) {
      if (target.team === attacker.team || target.hp <= 0 || attacker.hitIds.includes(target.id)) continue;
      const forward = (target.x - attacker.x) * attacker.facing;
      const verticalOverlap = attacker.kickType
        ? attacker.y - attacker.height * (attacker.kickType === 'air' ? 0.68 : 0.53) < target.y - 10
          && attacker.y + (attacker.kickType === 'air' ? 14 : -6) > target.y - target.height + 12
        : attacker.y - attacker.height + 15 < target.y - 18
          && attacker.y - 17 > target.y - target.height + 12;
      if (forward < -target.width * 0.35 || forward > strike.reach + target.width * 0.45 || !verticalOverlap) continue;
      attacker.hitIds.push(target.id);
      intents.push({
        source: attacker.id, target, strike,
        amount: strike.damage * attacker.damageScale,
        direction: attacker.facing,
        heavy: attacker.kickType === 'air' || (!attacker.kickType && attacker.attackStage === 3),
      });
    }
  }
  // Stable resolution also avoids changing multi-attacker outcomes when the
  // fighters array is reordered (e.g. by network presentation code).
  return intents.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1
    : a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1 : 0));
}

function resolveAttacks(state) {
  // Capture all valid swings before applying any damage. A same-tick hit can
  // interrupt the next move, but cannot retroactively erase that move's hit.
  for (const intent of collectAttacks(state)) {
    const { target, strike } = intent;
    if (target.hp <= 0) continue;
    if (target.invulnerable > 0 || target.dodgeTicks > 0) {
      event(state, 'evade', { x: target.x, y: target.y - target.height / 2, target: target.id });
      continue;
    }
    if (applyDamage(state, target, {
      amount: intent.amount, direction: intent.direction, knockback: strike.knockback,
      stun: strike.stun, source: intent.source, heavy: intent.heavy,
    })) {
      state.hitstop = Math.max(state.hitstop, strike.freeze);
    }
  }
}

function hazardActive(hazard, tick) {
  if (!Number.isFinite(hazard.period) || hazard.period <= 0) return true;
  const period = Math.max(1, Math.floor(hazard.period));
  const activeTicks = clamp(Math.floor(hazard.activeTicks ?? period * 0.56), 0, period);
  const phase = Math.floor(hazard.phase ?? 0);
  return ((tick + phase) % period + period) % period < activeTicks;
}

function resolveHazards(state, fighter) {
  if (fighter.hp <= 0 || fighter.hazardCooldown > 0) return;
  for (const hazard of state.arena.hazards) {
    if (!hazardActive(hazard, state.tick)) continue;
    // The exposed lower half of the body, rather than a large invisible box.
    const left = fighter.x - fighter.width * 0.43;
    const right = fighter.x + fighter.width * 0.43;
    const top = fighter.y - fighter.height * 0.49;
    if (right <= hazard.x || left >= hazard.x + hazard.w || fighter.y <= hazard.y || top >= hazard.y + hazard.h) continue;
    const direction = fighter.x < hazard.x + hazard.w / 2 ? -1 : 1;
    if (applyDamage(state, fighter, {
      amount: hazard.damage ?? 7, direction, knockback: 4.2, stun: 12,
      invulnerable: 18, source: `hazard:${hazard.type ?? 'terrain'}`,
    })) {
      fighter.hazardCooldown = 42;
      state.hitstop = Math.max(state.hitstop, 2);
    }
    break;
  }
}

function moveFighter(state, fighter, input) {
  const was = fighter.prevInput;
  const jumpPressed = input.jump && !was.jump;
  const attackPressed = input.attack && !was.attack;
  const kickPressed = input.kick && !was.kick;
  const dodgePressed = input.dodge && !was.dodge;
  fighter.prevInput = input;

  if (fighter.hp <= 0) {
    fighter.vx *= 0.89;
    fighter.vy = Math.min(MAX_FALL_SPEED, fighter.vy + GRAVITY);
    fighter.x = clamp(fighter.x + fighter.vx, 19, WORLD_WIDTH - 19);
    fighter.y = Math.min(state.arena.groundY, fighter.y + fighter.vy);
    return;
  }

  if (fighter.invulnerable > 0) fighter.invulnerable--;
  if (fighter.hurtFlash > 0) fighter.hurtFlash--;
  if (fighter.hazardCooldown > 0) fighter.hazardCooldown--;
  if (fighter.dodgeCooldown > 0) fighter.dodgeCooldown--;
  if (fighter.comboWindow > 0) {
    fighter.comboWindow--;
    if (fighter.comboWindow === 0 && fighter.attackStage === 0) fighter.comboStage = 0;
  }
  if (fighter.stun > 0) fighter.stun--;
  if (fighter.grounded) fighter.coyote = 6;
  else if (fighter.coyote > 0) fighter.coyote--;
  if (fighter.jumpBuffer > 0) fighter.jumpBuffer--;
  if (jumpPressed && fighter.kickType === null) fighter.jumpBuffer = 8;

  if (dodgePressed && fighter.stun === 0 && fighter.attackStage === 0
      && fighter.kickType === null && fighter.dodgeCooldown === 0 && fighter.dodgeTicks === 0) {
    const direction = Number(input.right) - Number(input.left);
    if (direction !== 0) fighter.facing = direction;
    fighter.dodgeTicks = DODGE_TICKS;
    fighter.dodgeCooldown = DODGE_COOLDOWN;
    fighter.invulnerable = Math.max(fighter.invulnerable, DODGE_TICKS);
    event(state, 'dodge', { x: fighter.x, y: fighter.y - 42, source: fighter.id });
  }

  if (fighter.dodgeTicks > 0) {
    fighter.dodgeTicks--;
    fighter.vx = fighter.facing * DODGE_SPEED * (fighter.dodgeTicks < 3 ? 0.56 : 1);
  } else if (fighter.stun === 0) {
    const direction = Number(input.right) - Number(input.left);
    if (direction !== 0) {
      if (fighter.attackStage === 0 && fighter.kickType === null) fighter.facing = direction;
      const moveScale = fighter.kickType ? 0.38 : fighter.attackStage ? 0.42 : 1;
      fighter.vx = approach(fighter.vx, direction * fighter.speed * moveScale, fighter.grounded ? 0.9 : 0.52);
    } else {
      fighter.vx *= fighter.grounded ? 0.72 : 0.88;
      if (Math.abs(fighter.vx) < 0.06) fighter.vx = 0;
    }
  } else {
    fighter.vx *= 0.94;
  }

  if (fighter.jumpBuffer > 0 && fighter.coyote > 0 && fighter.stun === 0
      && fighter.dodgeTicks === 0 && fighter.kickType === null) {
    fighter.vy = JUMP_SPEED;
    fighter.grounded = false;
    fighter.coyote = 0;
    fighter.jumpBuffer = 0;
    event(state, 'jump', { x: fighter.x, y: fighter.y, source: fighter.id });
  }

  // Jump resolves first, so jump+kick in the same simulation tick is an air kick.
  if (kickPressed && fighter.stun === 0 && fighter.dodgeTicks === 0
      && fighter.attackStage === 0 && fighter.kickType === null
      && (fighter.grounded || !fighter.airKickUsed)) {
    startKick(state, fighter, fighter.grounded ? 'ground' : 'air');
  }

  if (attackPressed && fighter.stun === 0 && fighter.dodgeTicks === 0 && fighter.kickType === null) {
    if (fighter.attackStage > 0) fighter.attackBuffered = fighter.attackStage < 3;
    else startAttack(fighter, fighter.comboWindow > 0 ? Math.min(3, fighter.comboStage + 1) : 1);
  }

  if (fighter.attackStage > 0) {
    fighter.attackTick++;
    const strike = attackOf(fighter);
    if (fighter.attackTick >= strike.duration) {
      if (fighter.attackBuffered && fighter.attackStage < 3) {
        startAttack(fighter, fighter.attackStage + 1);
      } else {
        // The third strike finishes the string; it cannot loop into itself.
        fighter.comboStage = fighter.attackStage === 3 ? 0 : fighter.attackStage;
        fighter.comboWindow = fighter.attackStage === 3 ? 0 : 26;
        fighter.attackStage = 0;
        fighter.attackTick = 0;
        fighter.attackBuffered = false;
      }
    }
  }

  if (fighter.kickType) {
    fighter.kickTick++;
    if (fighter.kickTick >= kickOf(fighter).duration) {
      fighter.kickType = null;
      fighter.kickTick = 0;
    }
  }

  const oldY = fighter.y;
  fighter.x = clamp(fighter.x + fighter.vx, 19, WORLD_WIDTH - 19);
  fighter.vy = Math.min(MAX_FALL_SPEED, fighter.vy + GRAVITY);
  fighter.y += fighter.vy;
  fighter.grounded = false;

  if (fighter.vy >= 0) {
    let landingY = state.arena.groundY;
    for (const platform of state.arena.platforms) {
      if (oldY <= platform.y + 1 && fighter.y >= platform.y
        && fighter.x + fighter.width * 0.35 > platform.x
        && fighter.x - fighter.width * 0.35 < platform.x + platform.w) {
        landingY = Math.min(landingY, platform.y);
      }
    }
    if (fighter.y >= landingY && oldY <= landingY + 1) {
      const fallSpeed = fighter.vy;
      fighter.y = landingY;
      fighter.vy = 0;
      fighter.grounded = true;
      // Landing ends an unfinished jump-kick before the hit pass below, and
      // only actual landing restores the one-air-kick-per-flight allowance.
      fighter.airKickUsed = false;
      if (fighter.kickType === 'air') {
        fighter.kickType = null;
        fighter.kickTick = 0;
      }
      if (fallSpeed > 3.8) event(state, 'land', { x: fighter.x, y: fighter.y, source: fighter.id });
    }
  }
  if (fighter.y > WORLD_HEIGHT + 70) {
    fighter.hp = 0;
    event(state, 'ko', { x: fighter.x, y: WORLD_HEIGHT - 10, target: fighter.id, source: 'fall' });
  }
  // The jump-kick burst belongs to the first real damage frame, not startup.
  // A whiff still has a burst; a kick canceled by landing never reaches here.
  if (fighter.hp > 0 && fighter.kickType === 'air'
      && fighter.kickTick === kickOf(fighter).activeFrom) {
    emitKickEvent(state, fighter, 'air');
  }
}

function resolveDuel(state) {
  const [first, second] = state.fighters;
  if (!first || !second) return;
  let reason = null;
  if (first.hp <= 0 || second.hp <= 0) reason = 'ko';
  else if (state.timerTicks <= 0) reason = 'timeout';
  if (!reason) return;
  state.status = 'finished';
  state.finishReason = reason;
  if (first.hp === second.hp) state.winner = null;
  else state.winner = first.hp > second.hp ? first.id : second.id;
  event(state, 'finish', { winner: state.winner, reason });
}

export function stepCombat(state, inputsById = {}) {
  if (state.status !== 'playing') {
    state.events = [];
    return state;
  }
  state.events = [];
  state.tick++;
  if (state.mode === 'duel' && state.timerTicks > 0) state.timerTicks--;
  if (state.hitstop > 0) {
    state.hitstop--;
    if (state.mode === 'duel') resolveDuel(state);
    return state;
  }

  for (const fighter of state.fighters) moveFighter(state, fighter, inputOf(inputsById[fighter.id]));
  resolveAttacks(state);
  for (const fighter of state.fighters) resolveHazards(state, fighter);
  if (state.mode === 'duel') resolveDuel(state);
  return state;
}

/** Predictable sparring AI: distinct tempos, readable attacks and occasional evasions. */
export function aiInput(fighter, target, state) {
  if (!fighter || !target || fighter.hp <= 0 || target.hp <= 0) return inputOf();
  const distance = target.x - fighter.x;
  const gap = Math.abs(distance);
  const isBoss = fighter.kind === 'boss';
  const isRusher = fighter.kind === 'rusher' || fighter.kind === 'runner';
  const isGuard = fighter.kind === 'guard';
  const cadence = isBoss ? 54 : isRusher ? 43 : isGuard ? 55 : 63;
  const offset = [...fighter.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % cadence;
  const kickCadence = isRusher ? 198 : 224;
  const kickOffset = [...fighter.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % kickCadence;
  const phase = (state.tick + offset) % cadence;
  const wantedGap = isBoss ? 59 : isRusher ? 48 : 57;
  const walking = gap > wantedGap ? Math.sign(distance) : 0;
  return {
    left: walking < 0,
    right: walking > 0,
    jump: (target.y < fighter.y - 36 && gap < 190 && phase === 13)
      || (isRusher && gap > 120 && gap < 225 && phase === 3),
    attack: gap < (isBoss ? 100 : 83) && phase < (isBoss ? 5 : 3),
    kick: !isBoss && fighter.grounded && fighter.attackStage === 0 && fighter.kickType === null
      && gap < 80 && (state.tick + kickOffset) % kickCadence === 0,
    dodge: (isBoss || isGuard || isRusher) && gap < 104
      && target.attackStage > 0 && phase === 19,
  };
}
