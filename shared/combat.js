/**
 * Deterministic, fixed-step combat shared by the campaign and the room server.
 * Coordinates are logical world pixels (campaign 1920 x 540, duel 960 x 540);
 * a fighter's y is at its feet. The canvas viewport remains 960 x 540.
 * Every call to stepCombat advances exactly one 1/60-second simulation tick.
 */
import { platformPose, platformSurfaceY } from './platforms.js';
import { getEquipment } from './equipment.js';

export const TICK_RATE = 60;
export const WORLD_WIDTH = 960;
export const WORLD_HEIGHT = 540;
export const CORPSE_SETTLE_TICKS = 27;
export const CORPSE_HOLD_TICKS = 180;

const GRAVITY = 0.58;
const MAX_FALL_SPEED = 13;
const JUMP_SPEED = -11.7;
const DODGE_SPEED = 10.5;
const DODGE_TICKS = 11;
const DODGE_COOLDOWN = 54;
const FALL_TICKS = 30;
export const SPEAR_WINDUP_TICKS = 20;
export const SPEARS_PER_LEVEL = 5;
const SPEAR_SPEED = 18;
export const SPEAR_GRAVITY = 0.9;
export const SPEAR_MIN_ANGLE = 8;
export const SPEAR_MAX_ANGLE = 72;
const SPEAR_AIMED_SPEED = 26;
const SPEAR_AIM_STEP = 1.25;
const SPEAR_DEFAULT_ANGLE = 42;
const SPEAR_LIFETIME = 94;
export const ROCK_GRAVITY = SPEAR_GRAVITY;
export const BOSS_SUMMON_CAP = 5;
const BOSS_SKILL_ORDER = ['ward', 'volley', 'quake', 'summon', 'rock'];
const BOSS_SKILL_TIER = { rock: 1, summon: 2, quake: 3, volley: 4, ward: 5 };
const BOSS_WINDUP = { rock: 32, summon: 40, quake: 30, volley: 36, ward: 24 };
const BOSS_QUAKE_RANGE = 190;
const BOSS_WARD_TICKS = 90;

const ARCHETYPES = {
  hero: { hp: 100, speed: 4.45, mass: 1, damage: 1, height: 88 },
  grunt: { hp: 42, speed: 3.0, mass: 1, damage: 0.72, height: 84 },
  rusher: { hp: 34, speed: 4.4, mass: 0.82, damage: 0.68, height: 81 },
  runner: { hp: 34, speed: 4.4, mass: 0.82, damage: 0.68, height: 81 },
  leaper: { hp: 58, speed: 4.55, mass: 0.82, damage: 0.76, height: 83 },
  slinger: { hp: 56, speed: 3.2, mass: 0.86, damage: 0.72, height: 84 },
  guard: { hp: 58, speed: 2.7, mass: 1.25, damage: 0.88, height: 88 },
  brute: { hp: 76, speed: 2.4, mass: 1.55, damage: 1.08, height: 96 },
  heavy: { hp: 76, speed: 2.4, mass: 1.55, damage: 1.08, height: 96 },
  boss: { hp: 152, speed: 3.15, mass: 1.65, damage: 1.16, height: 136 },
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
  reach: Math.round(strike.reach * 1.25),
});
const KICKS = Object.freeze({
  ground: Object.freeze({ duration: 20, activeFrom: 6, activeTo: 11, damage: 11, reach: 78, knockback: 6.8, stun: 19, freeze: 5 }),
  air: Object.freeze({ duration: 26, activeFrom: 7, activeTo: 16, damage: 16, reach: 96, knockback: 10.2, stun: 24, freeze: 7 }),
});

const BUTTONS = ['left', 'right', 'jump', 'attack', 'kick', 'dodge', 'spear',
  'aimUp', 'aimDown', 'aimCancel', 'equipment'];

function inputOf(value) {
  const input = {};
  for (const button of BUTTONS) input[button] = value?.[button] === true;
  input.aimAngle = Number.isFinite(value?.aimAngle) ? value.aimAngle : null;
  input.bossSkill = Object.hasOwn(BOSS_SKILL_TIER, value?.bossSkill)
    ? value.bossSkill : null;
  return input;
}

function event(state, type, fields = {}) {
  state.events.push({ id: `${state.tick}:${state.events.length}`, type, ...fields });
  if (type === 'ko') rememberEnemyCorpse(state, fields.target);
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function approach(value, target, amount) {
  return value < target ? Math.min(target, value + amount) : Math.max(target, value - amount);
}

function standingSurface(platform, tick, fighter, x) {
  const pose = platformPose(platform, tick);
  const halfFoot = fighter.width * 0.35;
  if (x + halfFoot <= pose.left || x - halfFoot >= pose.right) return null;
  const y = platformSurfaceY(pose, clamp(x, pose.left, pose.right));
  return y === null ? null : { y, pose };
}

export function createFighter({
  id, name, x, y = 438, team = 0, kind = 'hero', maxHp, damageScale = 1,
  spearEnabled = false, bossTier = 0, summonedBy = null,
} = {}) {
  if (!id || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError('A fighter needs an id and finite x/y coordinates');
  }
  const stats = ARCHETYPES[kind] ?? ARCHETYPES.grunt;
  const health = Math.max(1, Math.round(maxHp ?? stats.hp));
  const tier = kind === 'boss' && team === 1 && Number.isFinite(bossTier)
    ? clamp(Math.floor(bossTier), 0, 5) : 0;
  return {
    id: String(id), name: name ?? (kind === 'hero' ? '火柴斗士' : '挑战者'),
    team, kind, x, y, vx: 0, vy: 0, facing: team === 0 ? 1 : -1,
    width: kind === 'boss' ? 44 : 29, height: stats.height,
    hp: health, maxHp: health, speed: stats.speed, mass: stats.mass,
    damageScale: stats.damage * damageScale,
    grounded: true, coyote: 6, jumpBuffer: 0,
    stun: 0, invulnerable: 0, hurtFlash: 0, hazardCooldown: 0,
    dodgeTicks: 0, dodgeCooldown: 0,
    attackStage: 0, attackTick: 0, comboStage: 0, comboWindow: 0,
    kickType: null, kickTick: 0, airKickUsed: false,
    equipmentAttackId: null, equipmentTick: 0, equipmentCooldown: 0, equipmentHit: false,
    spearEnabled: spearEnabled === true,
    spearWindup: 0, spearCooldown: 0, spearAimX: null, spearAimY: null,
    spearAiming: false, spearAimAngle: SPEAR_DEFAULT_ANGLE, spearLaunchFacing: null,
    bossTier: tier, summonedBy: typeof summonedBy === 'string' ? summonedBy : null,
    bossCast: null, bossAbilityCooldown: tier ? 42 : kind === 'slinger' ? 70 : 0,
    bossSkillIndex: 0, wardTicks: 0,
    attackBuffered: false, hitIds: [],
    prevInput: { left: false, right: false, jump: false, attack: false, kick: false,
      dodge: false, spear: false, aimUp: false, aimDown: false, aimCancel: false,
      equipment: false, aimAngle: null },
  };
}

export function createCombatState({ mode = 'campaign', arena = {}, fighters = [], durationTicks = 0 } = {}) {
  return {
    mode,
    arena: {
      theme: arena.theme ?? 'forest',
      width: Number.isFinite(arena.width) && arena.width >= WORLD_WIDTH
        ? Math.floor(arena.width) : WORLD_WIDTH,
      groundY: arena.groundY ?? 438,
      platforms: arena.platforms ?? [],
      hazards: arena.hazards ?? [],
      fallingHazard: mode === 'campaign' && arena.fallingHazard
        ? { ...arena.fallingHazard } : null,
    },
    fighters,
    events: [],
    tick: 0,
    motionTick: 0,
    hitstop: 0,
    fallingClock: 0,
    fallingIndex: 0,
    fallingObject: null,
    projectiles: [],
    projectileSerial: 0,
    summonSerial: 0,
    ...(mode === 'campaign' ? {
      spearRemaining: SPEARS_PER_LEVEL, equippedEquipmentId: null, equipmentDrops: [],
    } : {}),
    corpses: [],
    aftermath: false,
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

function startAttack(state, fighter, stage) {
  fighter.attackStage = stage;
  fighter.attackTick = 0;
  fighter.comboStage = stage;
  fighter.comboWindow = 0;
  fighter.attackBuffered = false;
  fighter.hitIds = [];
  // A single warning cue follows the committed boss windup, never a missed
  // hit or a client-side animation frame. It carries no combat consequence.
  if (fighter.kind === 'boss') event(state, 'boss-windup', {
    x: fighter.x, y: fighter.y - fighter.height * 0.62,
    source: fighter.id, stage, facing: fighter.facing,
  });
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

function startEquipmentAttack(state, fighter, equipment) {
  fighter.equipmentAttackId = equipment.id;
  fighter.equipmentTick = 0;
  fighter.equipmentHit = false;
  fighter.equipmentCooldown = equipment.cooldown;
  fighter.comboStage = 0;
  fighter.comboWindow = 0;
  fighter.attackBuffered = false;
  fighter.jumpBuffer = 0;
  event(state, 'equipment-swing', {
    x: fighter.x + fighter.facing * 18,
    y: fighter.y - fighter.height * 0.54,
    source: fighter.id, facing: fighter.facing,
    equipmentId: equipment.id, style: equipment.style,
    color: equipment.color, tier: equipment.tier, duration: equipment.duration,
  });
}

export function spearOrigin(fighter, facing = fighter.facing) {
  const direction = facing < 0 ? -1 : 1;
  return {
    x: fighter.x + direction * (fighter.width * 0.44 + 14),
    y: fighter.y - fighter.height * 0.65,
  };
}

/** The player's chosen angle sets velocity; both preview and projectile use it. */
export function spearAimedFlight(facing, angleDegrees) {
  const angle = clamp(Number.isFinite(angleDegrees) ? angleDegrees : SPEAR_DEFAULT_ANGLE,
    SPEAR_MIN_ANGLE, SPEAR_MAX_ANGLE) * Math.PI / 180;
  return {
    vx: (facing < 0 ? -1 : 1) * SPEAR_AIMED_SPEED * Math.cos(angle),
    vy: -SPEAR_AIMED_SPEED * Math.sin(angle),
  };
}

/** Match the projectile's discrete gravity step, including its landing tick. */
export function spearFlight(originX, originY, aimX, aimY) {
  const dx = aimX - originX;
  const dy = aimY - originY;
  const ticks = clamp(Math.abs(dx) / SPEAR_SPEED, 14, 40);
  return {
    vx: dx / ticks,
    vy: dy / ticks - SPEAR_GRAVITY * (ticks + 1) / 2,
    ticks,
  };
}

export function spearTrajectoryPoint(originX, originY, flight, elapsedTicks) {
  return {
    x: originX + flight.vx * elapsedTicks,
    y: originY + flight.vy * elapsedTicks
      + SPEAR_GRAVITY * elapsedTicks * (elapsedTicks + 1) / 2,
  };
}

function corpseSurface(state, x, koY) {
  const groundY = state.arena.groundY;
  let chosen = { x, y: groundY, platformIndex: null, supportT: null };
  for (const [index, platform] of state.arena.platforms.entries()) {
    const pose = platformPose(platform, state.motionTick);
    const y = platformSurfaceY(pose, x);
    // A plank overhead must not catch a body already below it.
    if (y === null || y < Math.min(koY, groundY) - 3 || y >= chosen.y) continue;
    const span = pose.right - pose.left;
    chosen = {
      x, y, platformIndex: index,
      supportT: span > 0 ? clamp((x - pose.left) / span, 0, 1) : 0.5,
    };
  }
  return chosen;
}

function corpseContactOffsets(corpse, hero, worldWidth, footX = corpse.x) {
  // Match the prone silhouette's foot-to-head span (including its inward
  // flip at an arena edge); the player's half-width adds contact tolerance.
  const facing = corpse.facing < 0 ? -1 : 1;
  const reach = (83 + 22) * (corpse.kind === 'boss' ? 1.28 : 1);
  const naturalHeadX = footX - facing * reach;
  const fallDirection = naturalHeadX < 10 || naturalHeadX > worldWidth - 10 ? -1 : 1;
  const headOffset = -facing * fallDirection * reach;
  const padding = 10 + hero.width * 0.35;
  return {
    low: Math.min(0, headOffset) - padding,
    high: Math.max(0, headOffset) + padding,
  };
}

function standsOnCorpseSupport(state, corpse, hero) {
  if (!hero.grounded) return false;
  const tolerance = 2;
  if (corpse.platformIndex === null) {
    return Math.abs(hero.y - state.arena.groundY) <= tolerance;
  }
  const platform = state.arena.platforms[corpse.platformIndex];
  if (!platform) return false;
  const current = standingSurface(platform, state.motionTick, hero, hero.x);
  // A sloped or moving plank's foot height is evaluated at the current x and
  // simulation frame; it need not match the corpse's foot y at another x.
  return Boolean(current && Math.abs(hero.y - current.y) <= tolerance);
}

/** Record a genuine enemy KO before a new wave removes the dead fighter. */
function rememberEnemyCorpse(state, targetId) {
  if (state.mode !== 'campaign' || !Array.isArray(state.corpses)
      || state.corpses.some((corpse) => corpse.id === targetId)) return;
  const fighter = state.fighters.find((candidate) => candidate.id === targetId);
  if (!fighter || fighter.team !== 1 || fighter.hp > 0) return;
  const support = corpseSurface(state, fighter.x, fighter.y);
  const hero = state.fighters.find((candidate) => candidate.team === 0 && candidate.hp > 0);
  const bornTick = state.motionTick;
  const corpse = {
    id: fighter.id, kind: fighter.kind, team: fighter.team,
    facing: fighter.facing, width: fighter.width, height: fighter.height,
    x: support.x, y: support.y, koX: fighter.x, koY: fighter.y,
    bornTick, settleTick: bornTick + CORPSE_SETTLE_TICKS,
    expireTick: bornTick + CORPSE_SETTLE_TICKS + CORPSE_HOLD_TICKS,
    // Internal support/entry bookkeeping is deterministic simulation state.
    platformIndex: support.platformIndex, supportT: support.supportT,
    wasInside: false,
  };
  if (hero) {
    const { low, high } = corpseContactOffsets(corpse, hero, state.arena.width);
    corpse.wasInside = hero.x - corpse.x >= low && hero.x - corpse.x <= high
      && hero.stun === 0 && hero.dodgeTicks === 0
      && standsOnCorpseSupport(state, corpse, hero);
  }
  state.corpses.push(corpse);
}

function advanceCorpses(state, heroBefore = null) {
  if (state.mode !== 'campaign' || !state.corpses.length) return;
  const hero = state.fighters.find((fighter) => fighter.team === 0 && fighter.hp > 0);
  const remaining = [];
  for (const corpse of state.corpses) {
    const previousX = corpse.x;
    if (corpse.platformIndex !== null) {
      const platform = state.arena.platforms[corpse.platformIndex];
      if (platform) {
        const pose = platformPose(platform, state.motionTick);
        corpse.x = pose.left + (pose.right - pose.left) * corpse.supportT;
        corpse.y = pose.leftY + (pose.rightY - pose.leftY) * corpse.supportT;
      } else {
        corpse.platformIndex = null;
        corpse.y = state.arena.groundY;
      }
    }
    if (state.motionTick >= corpse.expireTick) continue;
    if (hero) {
      const { low, high } = corpseContactOffsets(corpse, hero, state.arena.width);
      const previousOffsets = corpseContactOffsets(corpse, hero, state.arena.width, previousX);
      const relativeX = hero.x - corpse.x;
      const inside = relativeX >= low && relativeX <= high;
      const validSupport = hero.stun === 0 && hero.dodgeTicks === 0
        && standsOnCorpseSupport(state, corpse, hero);
      const previousRelativeX = heroBefore ? heroBefore.x - previousX : relativeX;
      const crossedEntireBody = previousRelativeX < previousOffsets.low && relativeX > high
        || previousRelativeX > previousOffsets.high && relativeX < low;
      const entered = !corpse.wasInside && validSupport && (inside || crossedEntireBody);
      const walked = heroBefore?.grounded && Math.abs(hero.x - heroBefore.x) > 0.35
        && Math.abs(hero.vx) > 0.35 && heroBefore.stun === 0 && hero.stun === 0
        && heroBefore.dodgeTicks === 0 && hero.dodgeTicks === 0;
      if (state.motionTick >= corpse.settleTick && entered && walked) {
        event(state, 'bones-scatter', {
          target: corpse.id, x: corpse.x, y: corpse.y, kind: corpse.kind,
          facing: corpse.facing, width: corpse.width, height: corpse.height,
        });
        continue;
      }
      // Off-support/airborne contact does not consume a later valid entry;
      // stationary landing does occupy the body until the player leaves again.
      corpse.wasInside = inside && validSupport;
    }
    remaining.push(corpse);
  }
  state.corpses = remaining;
}

function spearTarget(state, fighter) {
  return state.fighters.filter((other) => other.hp > 0 && other.team !== fighter.team
    && (other.x - fighter.x) * fighter.facing >= -other.width * 0.35)
    .sort((a, b) => {
      const distanceA = Math.hypot(a.x - fighter.x, (a.y - fighter.y) * 0.8);
      const distanceB = Math.hypot(b.x - fighter.x, (b.y - fighter.y) * 0.8);
      return distanceA - distanceB || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    })[0];
}

function startingSpearAngle(origin, target, facing) {
  if (!target) return SPEAR_DEFAULT_ANGLE;
  const distance = (target.x - origin.x) * facing;
  if (distance <= 0 || distance > 800) return SPEAR_DEFAULT_ANGLE;
  const targetY = target.y - target.height * 0.57;
  let bestAngle = SPEAR_DEFAULT_ANGLE;
  let bestError = Infinity;
  // Seed the lower ballistic solution; the player may still raise the arc.
  for (let angle = SPEAR_MIN_ANGLE; angle <= 45; angle += 0.5) {
    const flight = spearAimedFlight(facing, angle);
    const ticks = distance / Math.abs(flight.vx);
    const error = Math.abs(spearTrajectoryPoint(origin.x, origin.y, flight, ticks).y - targetY);
    if (error < bestError) {
      bestError = error;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/** Escape, window blur or mode switch can drop an unconfirmed aim without a tick. */
export function cancelSpearAim(fighter) {
  if (!fighter?.spearAiming) return false;
  fighter.spearAiming = false;
  fighter.spearLaunchFacing = null;
  return true;
}

function cancelSpear(state, fighter) {
  if (cancelSpearAim(fighter)) {
    const origin = spearOrigin(fighter);
    event(state, 'spear-aim-cancel', {
      x: origin.x, y: origin.y, source: fighter.id,
    });
  }
  fighter.spearWindup = 0;
  fighter.spearAimX = null;
  fighter.spearAimY = null;
  fighter.spearLaunchFacing = null;
}

function beginPlayerAim(state, fighter) {
  const origin = spearOrigin(fighter);
  fighter.spearAiming = true;
  fighter.spearAimAngle = startingSpearAngle(origin, spearTarget(state, fighter), fighter.facing);
  event(state, 'spear-aim', {
    x: origin.x, y: origin.y, source: fighter.id,
    facing: fighter.facing, angle: fighter.spearAimAngle,
  });
}

function confirmPlayerSpear(state, fighter) {
  fighter.spearAiming = false;
  fighter.spearLaunchFacing = fighter.facing < 0 ? -1 : 1;
  fighter.spearWindup = SPEAR_WINDUP_TICKS;
  const origin = spearOrigin(fighter, fighter.spearLaunchFacing);
  event(state, 'spear-windup', {
    x: origin.x, y: origin.y, source: fighter.id,
    facing: fighter.spearLaunchFacing, angle: fighter.spearAimAngle,
    windupTicks: SPEAR_WINDUP_TICKS,
  });
}

function beginSpear(state, fighter) {
  const origin = spearOrigin(fighter);
  const target = spearTarget(state, fighter);
  fighter.spearAimX = target
    ? target.x + (Math.abs(target.x - fighter.x) < 30 ? fighter.facing * 14 : 0)
    : fighter.x + fighter.facing * 480;
  fighter.spearAimY = target ? target.y - target.height * 0.57 : origin.y;
  fighter.spearWindup = SPEAR_WINDUP_TICKS;
  // The player's twenty-frame throw is its own recovery; enemy throws stay
  // paced so their telegraph is a readable, occasional threat.
  fighter.spearCooldown = fighter.team === 0 ? 0 : 156;
  event(state, 'spear-windup', {
    x: origin.x, y: origin.y, source: fighter.id, facing: fighter.facing,
    targetX: fighter.spearAimX, targetY: fighter.spearAimY,
    windupTicks: SPEAR_WINDUP_TICKS,
  });
}

function launchSpear(state, fighter) {
  const facing = fighter.spearLaunchFacing ?? fighter.facing;
  const origin = spearOrigin(fighter, facing);
  // The warning locks its landing point at startup. Movement during windup
  // must not silently retarget the throw after the player has read its arc.
  const flight = fighter.team === 0 && fighter.spearLaunchFacing !== null
    ? spearAimedFlight(facing, fighter.spearAimAngle)
    : spearFlight(origin.x, origin.y, fighter.spearAimX, fighter.spearAimY);
  const projectile = {
    id: `spear-${++state.projectileSerial}`, kind: 'spear',
    source: fighter.id, team: fighter.team,
    x: origin.x, y: origin.y,
    vx: flight.vx,
    vy: flight.vy,
    radius: 7, damage: (fighter.team === 0 ? 22 : 14 * fighter.damageScale),
    ttl: SPEAR_LIFETIME,
  };
  state.projectiles.push(projectile);
  // Aiming and windup are free; only a real player launch spends this room's
  // shared allowance. Enemy telegraphed throws and duels have no such resource.
  if (state.mode === 'campaign' && fighter.team === 0) {
    state.spearRemaining = Math.max(0, state.spearRemaining - 1);
  }
  event(state, 'spear-throw', {
    x: projectile.x, y: projectile.y, source: fighter.id,
    projectileId: projectile.id, vx: projectile.vx, vy: projectile.vy,
    facing,
  });
  fighter.spearLaunchFacing = null;
}

function activeBossSummons(state, boss) {
  return state.fighters.filter((fighter) => fighter.hp > 0 && fighter.summonedBy === boss.id).length;
}

function bossSkills(fighter) {
  return BOSS_SKILL_ORDER.filter((skill) => fighter.bossTier >= BOSS_SKILL_TIER[skill]);
}

function bossSkillAvailable(state, fighter, target, skill) {
  const gap = Math.abs(target.x - fighter.x);
  if (skill === 'rock' || skill === 'volley') return gap > 115 && gap < 700;
  if (skill === 'summon') return fighter.grounded && activeBossSummons(state, fighter) < BOSS_SUMMON_CAP;
  if (skill === 'quake') return fighter.grounded && gap <= BOSS_QUAKE_RANGE + 15
    && Math.abs(target.y - fighter.y) <= 34;
  return skill === 'ward' && fighter.wardTicks <= 0;
}

function nextBossSkill(state, fighter, target) {
  if (fighter.kind !== 'boss' || fighter.bossTier <= 0) return null;
  const unlocked = bossSkills(fighter);
  for (let offset = 0; offset < unlocked.length; offset++) {
    const skill = unlocked[(fighter.bossSkillIndex + offset) % unlocked.length];
    if (bossSkillAvailable(state, fighter, target, skill)) return skill;
  }
  return null;
}

function rockOrigin(fighter, facing) {
  return {
    x: fighter.x + facing * (fighter.kind === 'boss' ? 31 : 21),
    y: fighter.y - fighter.height * (fighter.kind === 'boss' ? 0.67 : 0.63),
  };
}

function updateRockCastGeometry(fighter, cast) {
  const origin = rockOrigin(fighter, cast.facing);
  const targetX = cast.stage === 1 ? cast.secondTargetX : cast.targetX;
  const flight = spearFlight(origin.x, origin.y, targetX, cast.targetY);
  cast.originX = origin.x;
  cast.originY = origin.y;
  cast.vx = flight.vx;
  cast.vy = flight.vy;
}

function beginBossCast(state, fighter, target, skill) {
  if (state.mode !== 'campaign' || fighter.team !== 1 || !target || target.hp <= 0
      || fighter.bossCast || fighter.bossAbilityCooldown > 0 || fighter.stun > 0
      || fighter.attackStage > 0 || fighter.kickType || fighter.dodgeTicks > 0
      || fighter.spearWindup > 0 || !fighter.grounded) return false;
  const slingerRock = fighter.kind === 'slinger' && skill === 'rock';
  if (!slingerRock && (fighter.kind !== 'boss' || fighter.bossTier < BOSS_SKILL_TIER[skill]
      || !bossSkillAvailable(state, fighter, target, skill))) return false;
  const windupTicks = slingerRock ? 22 : BOSS_WINDUP[skill];
  const facing = fighter.facing < 0 ? -1 : 1;
  const cast = {
    type: skill, ticks: windupTicks, totalTicks: windupTicks, facing,
    tier: fighter.bossTier, stage: 0,
  };
  if (skill === 'rock' || skill === 'volley') {
    cast.targetX = target.x;
    cast.targetY = target.y - target.height * 0.53;
    cast.secondTargetX = cast.targetX + facing * 48;
    cast.radius = slingerRock ? 8 : 13 + Math.floor(fighter.bossTier / 3);
    cast.volley = skill === 'volley' ? 2 : 1;
    updateRockCastGeometry(fighter, cast);
  } else if (skill === 'summon') {
    cast.count = Math.min(BOSS_SUMMON_CAP - activeBossSummons(state, fighter),
      fighter.bossTier >= 4 ? 3 : 2);
  } else if (skill === 'quake') cast.range = BOSS_QUAKE_RANGE;
  else if (skill === 'ward') cast.durationTicks = BOSS_WARD_TICKS;
  fighter.bossCast = cast;
  fighter.bossAbilityCooldown = slingerRock ? 170 : 190 - 12 * fighter.bossTier;
  if (!slingerRock) {
    const unlocked = bossSkills(fighter);
    fighter.bossSkillIndex = (unlocked.indexOf(skill) + 1) % unlocked.length;
  }
  const cueType = skill === 'rock' || skill === 'volley'
    ? slingerRock ? 'rock-windup' : 'boss-rock-windup'
    : `boss-${skill}-windup`;
  event(state, cueType, {
    source: fighter.id, x: cast.originX ?? fighter.x,
    y: cast.originY ?? fighter.y, facing, tier: cast.tier,
    windupTicks,
    ...(cast.targetX === undefined ? {} : {
      targetX: cast.targetX, targetY: cast.targetY,
      vx: cast.vx, vy: cast.vy, radius: cast.radius, volley: cast.volley,
    }),
    ...(cast.count === undefined ? {} : { count: cast.count }),
    ...(cast.range === undefined ? {} : { range: cast.range }),
  });
  return true;
}

function launchRock(state, fighter, cast) {
  updateRockCastGeometry(fighter, cast);
  const projectile = {
    id: `rock-${++state.projectileSerial}`, kind: 'rock',
    source: fighter.id, team: fighter.team,
    x: cast.originX, y: cast.originY, vx: cast.vx, vy: cast.vy,
    radius: cast.radius, ttl: SPEAR_LIFETIME,
    damage: fighter.kind === 'slinger' ? 9 * fighter.damageScale
      : (11 + fighter.bossTier * 2) * fighter.damageScale,
    tier: cast.tier,
  };
  state.projectiles.push(projectile);
  event(state, fighter.kind === 'slinger' ? 'rock-throw' : 'boss-rock-throw', {
    source: fighter.id, projectileId: projectile.id,
    x: projectile.x, y: projectile.y, vx: projectile.vx, vy: projectile.vy,
    radius: projectile.radius, facing: cast.facing, tier: cast.tier,
    volley: cast.volley, volleyIndex: cast.stage + 1,
  });
}

function summonBossMinions(state, boss, cast) {
  // Only active summons consume slots. A defeated boss cannot start another
  // cast; surviving summons remain ordinary, killable wave enemies.
  const freeSlots = BOSS_SUMMON_CAP - activeBossSummons(state, boss);
  const kinds = boss.bossTier >= 3 ? ['leaper', 'slinger', 'grunt'] : ['leaper', 'grunt'];
  for (let index = 0; index < Math.min(cast.count, freeSlots); index++) {
    const kind = kinds[state.summonSerial % kinds.length];
    const fighter = createFighter({
      id: `summon-${boss.id}-${++state.summonSerial}`,
      name: kind === 'leaper' ? '召唤跃袭者' : kind === 'slinger' ? '召唤石掷手' : '召唤斗士',
      x: boss.x,
      y: boss.y, team: boss.team, kind,
      maxHp: Math.round(ARCHETYPES[kind].hp * (0.8 + boss.bossTier * 0.07)),
      damageScale: 0.76 + boss.bossTier * 0.055,
      summonedBy: boss.id,
    });
    // Spread living allies on safe strips near the boss instead of stacking
    // successive summons at the same x. Later trap contact still hurts them.
    const blocked = (x) => state.arena.hazards.some((hazard) =>
      hazardActive(hazard, state.tick) && hazardTouchesFighter(hazard, fighter, x, fighter.y));
    const candidates = [-1, 1, -2, 2, -3, 3, -4, 4].map((slot) =>
      clamp(boss.x + Math.sign(slot) * (76 + (Math.abs(slot) - 1) * 68),
        25, state.arena.width - 25));
    const separate = (x) => state.fighters.every((other) => other.hp <= 0
      || other.team !== boss.team || Math.abs(other.x - x) >= 42);
    fighter.x = candidates.find((x) => separate(x) && !blocked(x))
      ?? candidates.find((x) => !blocked(x)) ?? candidates[0];
    state.fighters.push(fighter);
    event(state, 'boss-summon', {
      source: boss.id, target: fighter.id, x: fighter.x,
      y: fighter.y, kind: fighter.kind, tier: cast.tier,
    });
  }
}

function footing(state, fighter) {
  if (!fighter.grounded) return null;
  if (Math.abs(fighter.y - state.arena.groundY) <= 3) return 'ground';
  let found = null;
  for (const platform of state.arena.platforms) {
    const surface = standingSurface(platform, state.motionTick, fighter, fighter.x);
    if (!surface || Math.abs(fighter.y - surface.y) > 3) continue;
    found = platform;
    if (fighter.x >= surface.pose.left && fighter.x <= surface.pose.right) break;
  }
  return found;
}

function releaseBossQuake(state, boss, cast) {
  const support = footing(state, boss);
  let victim = null;
  let damage = 0;
  let blocked = false;
  for (const target of state.fighters.filter((fighter) => fighter.team !== boss.team
      && fighter.hp > 0).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!support || footing(state, target) !== support
        || Math.abs(target.x - boss.x) > cast.range
        || Math.abs(target.y - boss.y) > 34) continue;
    victim = target.id;
    const before = target.hp;
    const landed = applyDamage(state, target, {
      amount: (14 + boss.bossTier) * boss.damageScale,
      direction: Math.sign(target.x - boss.x) || cast.facing,
      knockback: 6.4, stun: 18, source: boss.id,
      heavy: true, delivery: 'quake',
    });
    if (landed) {
      damage += before - target.hp;
      state.hitstop = Math.max(state.hitstop, 3);
    } else blocked = true;
  }
  event(state, 'boss-quake', {
    source: boss.id, x: boss.x, y: boss.y, range: cast.range,
    target: victim, damage, blocked, tier: cast.tier,
  });
}

function advanceBossCast(state, fighter) {
  const cast = fighter.bossCast;
  if (!cast || fighter.hp <= 0) return;
  if (cast.type === 'rock' || cast.type === 'volley') updateRockCastGeometry(fighter, cast);
  cast.ticks--;
  if (cast.ticks > 0) return;
  if (cast.type === 'rock' || cast.type === 'volley') {
    launchRock(state, fighter, cast);
    if (cast.type === 'volley' && cast.stage === 0) {
      cast.stage = 1;
      cast.ticks = 12;
      cast.totalTicks = 12;
      updateRockCastGeometry(fighter, cast);
      return;
    }
  } else if (cast.type === 'summon') summonBossMinions(state, fighter, cast);
  else if (cast.type === 'quake') releaseBossQuake(state, fighter, cast);
  else if (cast.type === 'ward') {
    fighter.wardTicks = BOSS_WARD_TICKS;
    event(state, 'boss-ward', {
      source: fighter.id, x: fighter.x, y: fighter.y,
      durationTicks: BOSS_WARD_TICKS, tier: cast.tier,
    });
  }
  fighter.bossCast = null;
}

function applyDamage(state, target, { amount, direction, knockback, stun, invulnerable = 9,
  source = null, heavy = false, delivery = null, equipmentId = null }) {
  if (target.hp <= 0 || target.invulnerable > 0 || target.dodgeTicks > 0) return false;
  const rawDamage = Math.max(1, Math.round(amount));
  const warded = state.mode === 'campaign' && target.kind === 'boss' && target.wardTicks > 0;
  const damage = warded ? Math.max(1, Math.ceil(rawDamage / 2)) : rawDamage;
  target.hp = Math.max(0, target.hp - damage);
  target.stun = Math.max(target.stun, stun);
  target.invulnerable = invulnerable;
  target.hurtFlash = 11;
  target.attackStage = 0;
  target.attackTick = 0;
  target.kickType = null;
  target.kickTick = 0;
  target.equipmentAttackId = null;
  target.equipmentTick = 0;
  target.equipmentHit = false;
  target.bossCast = null;
  cancelSpear(state, target);
  target.attackBuffered = false;
  target.comboWindow = 0;
  target.vx = direction * knockback / target.mass;
  target.vy = Math.min(target.vy, heavy ? -3.5 : -2.2);
  target.grounded = false;
  event(state, 'hit', {
    x: target.x, y: target.y - target.height * 0.57,
    damage, target: target.id, source, heavy,
    ...(delivery ? { delivery } : {}),
    ...(delivery === 'equipment' && equipmentId ? { equipmentId } : {}),
  });
  if (warded) event(state, 'boss-ward-hit', {
    x: target.x, y: target.y - target.height * 0.57,
    target: target.id, source, absorbed: rawDamage - damage,
  });
  if (target.hp === 0) {
    event(state, 'ko', { x: target.x, y: target.y - target.height * 0.45, target: target.id, source });
  }
  return true;
}

function verticalHitOverlap(attacker, target, kickType = null) {
  if (kickType) {
    return attacker.y - attacker.height * (kickType === 'air' ? 0.68 : 0.53) < target.y - 10
      && attacker.y + (kickType === 'air' ? 14 : -6) > target.y - target.height + 12;
  }
  return attacker.y - attacker.height + 15 < target.y - 18
    && attacker.y - 17 > target.y - target.height + 12;
}

function collectAttacks(state) {
  const intents = [];
  for (const attacker of state.fighters) {
    if (state.mode === 'campaign' && attacker.team === 0 && attacker.kind === 'hero'
        && attacker.equipmentAttackId !== null) {
      const equipment = getEquipment(attacker.equipmentAttackId);
      if (equipment && attacker.hp > 0 && !attacker.equipmentHit
          && attacker.equipmentTick >= equipment.activeFrom
          && attacker.equipmentTick <= equipment.activeTo) {
        // A weapon blow chooses the nearest valid foe in its facing direction.
        // It never turns its larger reach into a full-wave multi-target strike.
        const target = state.fighters.filter((other) => other.team !== attacker.team
          && other.hp > 0 && verticalHitOverlap(attacker, other)
          && (other.x - attacker.x) * attacker.facing >= -other.width * 0.35
          && (other.x - attacker.x) * attacker.facing <= equipment.reach + other.width * 0.45)
          .sort((a, b) => (a.x - attacker.x) * attacker.facing
            - (b.x - attacker.x) * attacker.facing
            || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
        if (target) {
          attacker.equipmentHit = true;
          intents.push({
            source: attacker.id, target, strike: equipment,
            amount: equipment.damage * attacker.damageScale,
            direction: attacker.facing, heavy: equipment.tier >= 4,
            delivery: 'equipment', equipmentId: equipment.id,
          });
        }
      }
      continue;
    }
    if ((attacker.attackStage === 0 && !attacker.kickType) || attacker.hp <= 0) continue;
    const strike = attacker.kickType ? kickOf(attacker) : attackOf(attacker);
    const moveTick = attacker.kickType ? attacker.kickTick : attacker.attackTick;
    if (!strike || moveTick < strike.activeFrom || moveTick > strike.activeTo) continue;
    for (const target of state.fighters) {
      if (target.team === attacker.team || target.hp <= 0 || attacker.hitIds.includes(target.id)) continue;
      const forward = (target.x - attacker.x) * attacker.facing;
      const verticalOverlap = verticalHitOverlap(attacker, target, attacker.kickType);
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
      delivery: intent.delivery, equipmentId: intent.equipmentId,
    })) {
      state.hitstop = Math.max(state.hitstop, strike.freeze);
    }
  }
}

function sweptBoxHit(startX, startY, nextX, nextY, left, right, top, bottom) {
  const bounds = [
    [startX, nextX - startX, left, right],
    [startY, nextY - startY, top, bottom],
  ];
  let entry = 0;
  let exit = 1;
  for (const [start, delta, min, max] of bounds) {
    if (Math.abs(delta) < 1e-9) {
      if (start < min || start > max) return null;
      continue;
    }
    const near = (min - start) / delta;
    const far = (max - start) / delta;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
    if (entry > exit) return null;
  }
  return entry;
}

function sweptFighterHit(projectile, target, nextX, nextY) {
  return sweptBoxHit(projectile.x, projectile.y, nextX, nextY,
    target.x - target.width * 0.44 - projectile.radius,
    target.x + target.width * 0.44 + projectile.radius,
    target.y - target.height - projectile.radius,
    target.y - 8 + projectile.radius);
}

function sweptPlatformHit(projectile, platform, nextX, nextY, motionTick) {
  const pose = platformPose(platform, motionTick);
  const cosine = Math.cos(pose.angle);
  const sine = Math.sin(pose.angle);
  const local = (x, y) => ({
    x: (x - pose.centerX) * cosine + (y - pose.centerY) * sine,
    y: (y - pose.centerY) * cosine - (x - pose.centerX) * sine,
  });
  const start = local(projectile.x, projectile.y);
  const end = local(nextX, nextY);
  return sweptBoxHit(start.x, start.y, end.x, end.y,
    -pose.width / 2 - projectile.radius, pose.width / 2 + projectile.radius,
    -projectile.radius, Math.max(6, pose.height) + projectile.radius);
}

/** A swept path prevents fast spears and rocks from tunnelling through a thin fighter. */
function resolveProjectiles(state) {
  if (state.mode !== 'campaign') {
    state.projectiles = [];
    return;
  }
  const active = [];
  const impacts = [];
  for (const projectile of state.projectiles) {
    const nextVy = projectile.vy + (projectile.kind === 'rock' ? ROCK_GRAVITY : SPEAR_GRAVITY);
    const nextX = projectile.x + projectile.vx;
    const nextY = projectile.y + nextVy;
    let victim = null;
    let collisionTime = Infinity;
    let surface = null;
    for (const target of state.fighters) {
      if (target.hp <= 0 || target.team === projectile.team) continue;
      const time = sweptFighterHit(projectile, target, nextX, nextY);
      if (time !== null && (time < collisionTime
        || (time === collisionTime && target.id < victim.id))) {
        victim = target;
        collisionTime = time;
      }
    }
    for (const platform of state.arena.platforms) {
      const time = sweptPlatformHit(projectile, platform, nextX, nextY, state.motionTick);
      if (time !== null && time <= collisionTime) {
        victim = null;
        collisionTime = time;
        surface = 'platform';
      }
    }
    const groundY = state.arena.groundY - projectile.radius;
    const groundTime = nextY > projectile.y && nextY >= groundY
      ? Math.max(0, (groundY - projectile.y) / (nextY - projectile.y)) : Infinity;
    if (groundTime < collisionTime) {
      victim = null;
      collisionTime = groundTime;
      surface = 'ground';
    }
    if (collisionTime <= 1) {
      impacts.push({ projectile, victim, surface,
        x: projectile.x + (nextX - projectile.x) * collisionTime,
        y: projectile.y + (nextY - projectile.y) * collisionTime });
    } else if (projectile.ttl <= 1 || nextX < -40 || nextX > state.arena.width + 40
      || nextY < -80 || nextY > WORLD_HEIGHT + 40) {
      impacts.push({ projectile, victim: null, surface: 'air', x: nextX, y: nextY });
    } else {
      projectile.x = nextX;
      projectile.y = nextY;
      projectile.vy = nextVy;
      projectile.ttl--;
      active.push(projectile);
    }
  }
  state.projectiles = active;
  // Detect every trajectory before damage interrupts fighters, so simultaneous
  // opposite-direction throws can trade a KO regardless of presentation order.
  impacts.sort((a, b) => a.projectile.id.localeCompare(b.projectile.id));
  for (const { projectile, victim, surface, x, y } of impacts) {
    const before = victim?.hp ?? 0;
    const damaged = victim && applyDamage(state, victim, {
      amount: projectile.damage, direction: Math.sign(projectile.vx) || 1,
      knockback: projectile.kind === 'rock' ? 5.6 : 6,
      stun: projectile.kind === 'rock' ? 17 : 19,
      source: projectile.source, heavy: true, delivery: projectile.kind,
    });
    if (victim && !damaged) {
      event(state, 'evade', { x: victim.x, y: victim.y - victim.height / 2, target: victim.id });
    }
    if (damaged) state.hitstop = Math.max(state.hitstop, 3);
    event(state, projectile.kind === 'rock' ? 'rock-impact' : 'spear-impact', {
      x, y, source: projectile.source, projectileId: projectile.id,
      target: victim?.id ?? null, damage: damaged ? before - victim.hp : 0,
      blocked: Boolean(victim && !damaged), surface,
      ...(projectile.kind === 'rock' ? { radius: projectile.radius, tier: projectile.tier } : {}),
    });
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

function fallingVictim(state, object, previousY, nextY) {
  return state.fighters.filter((fighter) => fighter.hp > 0
    && Math.abs(fighter.x - object.x) <= fighter.width * 0.43 + object.radius
    && previousY - object.radius <= fighter.y
    && nextY + object.radius >= fighter.y - fighter.height)
    .sort((a, b) => (a.y - a.height) - (b.y - b.height)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

/** One seeded object at a time; the clock advances only on simulated, non-hitstop frames. */
function advanceFallingHazard(state) {
  const config = state.mode === 'campaign' ? state.arena.fallingHazard : null;
  if (!config) return;
  state.fallingClock++;
  const object = state.fallingObject;
  if (object?.phase === 'warning') {
    object.warningRemaining--;
    object.ticksUntilImpact--;
    if (object.warningRemaining === 0) object.phase = 'falling';
    return;
  }
  if (object?.phase === 'falling') {
    const previousY = object.y;
    object.fallTick++;
    const progress = clamp(object.fallTick / FALL_TICKS, 0, 1);
    const nextY = -object.radius + (object.impactY + object.radius) * progress * progress;
    object.y = nextY;
    object.ticksUntilImpact = FALL_TICKS - object.fallTick;
    const victim = fallingVictim(state, object, previousY, nextY);
    if (victim || nextY >= object.impactY) {
      const impactY = victim
        ? clamp(victim.y - victim.height - object.radius, previousY, nextY) : object.impactY;
      const damageFraction = Number.isFinite(config.damageFraction)
        ? clamp(config.damageFraction, 0, 1) : 0.1;
      const damage = victim ? Math.max(1, Math.round(victim.maxHp * damageFraction)) : 0;
      const damaged = victim && applyDamage(state, victim, {
        amount: damage, direction: victim.x < object.x ? -1 : 1,
        knockback: 3.4, stun: 9, source: `hazard:${object.kind}`,
      });
      if (victim && !damaged) {
        event(state, 'evade', { x: victim.x, y: victim.y - victim.height / 2, target: victim.id });
      }
      event(state, 'fall-impact', {
        kind: object.kind, x: object.x, y: impactY, radius: object.radius,
        index: object.index, target: victim?.id ?? null, damage: damaged ? damage : 0,
      });
      state.fallingObject = null;
    }
    return;
  }

  const firstTick = Number.isFinite(config.firstTick) ? Math.max(1, Math.floor(config.firstTick)) : 120;
  const period = Number.isFinite(config.period) ? Math.max(1, Math.floor(config.period)) : 240;
  if (state.fallingClock < firstTick + state.fallingIndex * period) return;
  const index = state.fallingIndex++;
  const candidates = state.fighters.filter((fighter) => fighter.hp > 0)
    .sort((a, b) => a.team - b.team || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (candidates.length === 0) return;
  const seed = Number.isFinite(config.seed) ? Math.floor(config.seed) : 0;
  const target = candidates[((seed + index) % candidates.length + candidates.length) % candidates.length];
  const scatter = [-8, 0, 8, -4, 4][((seed * 17 + index * 7) % 5 + 5) % 5];
  const x = clamp(target.x + scatter, 20, state.arena.width - 20);
  const warningTicks = Number.isFinite(config.warningTicks)
    ? Math.max(1, Math.floor(config.warningTicks)) : 40;
  // Mark the projected impact plane, not a plank's stale baseline. The mark
  // remains fixed once warned, preserving the existing sidestep rule.
  const predictedTick = state.motionTick + warningTicks + FALL_TICKS;
  let impactY = state.arena.groundY;
  for (const platform of state.arena.platforms) {
    const pose = platformPose(platform, predictedTick);
    const surface = platformSurfaceY(pose, x);
    if (surface !== null) impactY = Math.min(impactY, surface);
  }
  const radius = Number.isFinite(config.radius) ? clamp(config.radius, 2, 20) : 8;
  state.fallingObject = {
    kind: config.type ?? 'hail', x, y: -radius, impactY, radius, index,
    phase: 'warning', warningTicks, warningRemaining: warningTicks,
    fallTick: 0, ticksUntilImpact: warningTicks + FALL_TICKS,
  };
  event(state, 'fall-warning', {
    kind: state.fallingObject.kind, x, y: impactY, radius, index, warningTicks,
  });
}

function moveFighter(state, fighter, input) {
  const was = fighter.prevInput;
  const actionBusyAtTickStart = fighter.attackStage > 0 || fighter.kickType !== null
    || fighter.dodgeTicks > 0 || fighter.spearWindup > 0 || fighter.equipmentAttackId !== null;
  const jumpPressed = input.jump && !was.jump;
  const attackPressed = input.attack && !was.attack;
  const kickPressed = input.kick && !was.kick;
  const dodgePressed = input.dodge && !was.dodge;
  const spearPressed = input.spear && !was.spear;
  const equipped = state.mode === 'campaign' && fighter.team === 0 && fighter.kind === 'hero'
    ? getEquipment(state.equippedEquipmentId) : null;
  const equipmentPressed = Boolean(equipped && input.equipment && !was.equipment);
  fighter.prevInput = input;

  if (fighter.hp <= 0) {
    cancelSpear(state, fighter);
    fighter.equipmentAttackId = null;
    fighter.equipmentTick = 0;
    fighter.equipmentHit = false;
    fighter.bossCast = null;
    fighter.vx *= 0.89;
    fighter.vy = Math.min(MAX_FALL_SPEED, fighter.vy + GRAVITY);
    fighter.x = clamp(fighter.x + fighter.vx, 19, state.arena.width - 19);
    fighter.y = Math.min(state.arena.groundY, fighter.y + fighter.vy);
    return;
  }

  if (fighter.invulnerable > 0) fighter.invulnerable--;
  if (fighter.hurtFlash > 0) fighter.hurtFlash--;
  if (fighter.hazardCooldown > 0) fighter.hazardCooldown--;
  if (fighter.dodgeCooldown > 0) fighter.dodgeCooldown--;
  if (fighter.spearCooldown > 0) fighter.spearCooldown--;
  if (fighter.equipmentCooldown > 0) fighter.equipmentCooldown--;
  if (fighter.bossAbilityCooldown > 0) fighter.bossAbilityCooldown--;
  if (fighter.wardTicks > 0) fighter.wardTicks--;
  if (fighter.comboWindow > 0) {
    fighter.comboWindow--;
    if (fighter.comboWindow === 0 && fighter.attackStage === 0) fighter.comboStage = 0;
  }
  if (fighter.stun > 0) fighter.stun--;
  if (input.bossSkill) {
    const target = state.fighters.find((other) => other.team !== fighter.team && other.hp > 0);
    if (target) beginBossCast(state, fighter, target, input.bossSkill);
  }
  if (fighter.grounded) fighter.coyote = 6;
  else if (fighter.coyote > 0) fighter.coyote--;
  if (fighter.jumpBuffer > 0) fighter.jumpBuffer--;
  const otherActionPressed = jumpPressed || attackPressed || kickPressed || dodgePressed
    || equipmentPressed;
  if (fighter.spearAiming && (input.aimCancel || otherActionPressed)) cancelSpear(state, fighter);
  if (fighter.spearAiming) {
    const nextAngle = input.aimAngle ?? fighter.spearAimAngle
      + (Number(input.aimUp) - Number(input.aimDown)) * SPEAR_AIM_STEP;
    fighter.spearAimAngle = clamp(nextAngle, SPEAR_MIN_ANGLE, SPEAR_MAX_ANGLE);
  }
  if (jumpPressed && fighter.kickType === null && !fighter.bossCast
      && fighter.equipmentAttackId === null) fighter.jumpBuffer = 8;

  if (dodgePressed && !fighter.bossCast && fighter.stun === 0 && fighter.attackStage === 0
      && fighter.kickType === null && fighter.equipmentAttackId === null
      && fighter.spearWindup === 0
      && fighter.dodgeCooldown === 0 && fighter.dodgeTicks === 0) {
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
  } else if (fighter.stun === 0 && (fighter.spearWindup > 0 || fighter.bossCast)) {
    fighter.vx *= fighter.grounded ? 0.55 : 0.82;
  } else if (fighter.stun === 0) {
    const direction = Number(input.right) - Number(input.left);
    if (direction !== 0) {
      if (fighter.attackStage === 0 && fighter.kickType === null
          && fighter.equipmentAttackId === null) fighter.facing = direction;
      const moveScale = fighter.kickType ? 0.38
        : fighter.attackStage || fighter.equipmentAttackId ? 0.42 : 1;
      fighter.vx = approach(fighter.vx, direction * fighter.speed * moveScale, fighter.grounded ? 0.9 : 0.52);
    } else {
      fighter.vx *= fighter.grounded ? 0.72 : 0.88;
      if (Math.abs(fighter.vx) < 0.06) fighter.vx = 0;
    }
  } else {
    fighter.vx *= 0.94;
  }

  if (fighter.jumpBuffer > 0 && fighter.coyote > 0 && fighter.stun === 0
      && !fighter.bossCast && fighter.dodgeTicks === 0
      && fighter.kickType === null && fighter.equipmentAttackId === null
      && fighter.spearWindup === 0) {
    fighter.vy = JUMP_SPEED;
    fighter.grounded = false;
    fighter.coyote = 0;
    fighter.jumpBuffer = 0;
    event(state, 'jump', { x: fighter.x, y: fighter.y, source: fighter.id });
  }

  // Jump resolves first, so jump+kick in the same simulation tick is an air kick.
  if (kickPressed && !fighter.bossCast && fighter.stun === 0 && fighter.dodgeTicks === 0
      && fighter.attackStage === 0 && fighter.kickType === null
      && fighter.equipmentAttackId === null && fighter.spearWindup === 0
      && (fighter.grounded || !fighter.airKickUsed)) {
    startKick(state, fighter, fighter.grounded ? 'ground' : 'air');
  }

  if (attackPressed && !fighter.bossCast && fighter.stun === 0 && fighter.dodgeTicks === 0
      && fighter.kickType === null && fighter.equipmentAttackId === null
      && fighter.spearWindup === 0) {
    if (fighter.attackStage > 0) fighter.attackBuffered = fighter.attackStage < 3;
    else startAttack(state, fighter, fighter.comboWindow > 0 ? Math.min(3, fighter.comboStage + 1) : 1);
  }

  if (fighter.attackStage > 0) {
    fighter.attackTick++;
    const strike = attackOf(fighter);
    if (fighter.attackTick >= strike.duration) {
      if (fighter.attackBuffered && fighter.attackStage < 3) {
        startAttack(state, fighter, fighter.attackStage + 1);
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

  // Equipment is a committed single-target move, not a projectile or an
  // extension of the punch combo. A held button cannot repeat it.
  const equipmentBusyThisTick = fighter.equipmentAttackId !== null;
  if (equipmentPressed && !jumpPressed && !attackPressed && !kickPressed && !dodgePressed
      && !actionBusyAtTickStart && fighter.stun === 0 && fighter.dodgeTicks === 0
      && fighter.attackStage === 0 && fighter.kickType === null
      && fighter.equipmentAttackId === null && fighter.equipmentCooldown === 0
      && fighter.spearWindup === 0 && !fighter.spearAiming && !fighter.bossCast) {
    startEquipmentAttack(state, fighter, equipped);
  }
  if (fighter.equipmentAttackId !== null) {
    fighter.equipmentTick++;
    const equipment = getEquipment(fighter.equipmentAttackId);
    if (!equipment || fighter.equipmentTick >= equipment.duration) {
      fighter.equipmentAttackId = null;
      fighter.equipmentTick = 0;
      fighter.equipmentHit = false;
    }
  }

  if (state.mode === 'campaign' && !fighter.bossCast && spearPressed
      && (fighter.team !== 0 || (!input.aimCancel && !otherActionPressed))
      && fighter.stun === 0
      && fighter.dodgeTicks === 0 && fighter.attackStage === 0
      && fighter.kickType === null && fighter.equipmentAttackId === null
      && !equipmentBusyThisTick && fighter.spearWindup === 0 && fighter.spearCooldown === 0
      && (fighter.team !== 0 || state.spearRemaining > 0)
      && (fighter.team === 0 || fighter.spearEnabled)) {
    if (fighter.team === 0) {
      if (fighter.spearAiming) confirmPlayerSpear(state, fighter);
      else beginPlayerAim(state, fighter);
    } else beginSpear(state, fighter);
  }
  if (fighter.spearWindup > 0) {
    fighter.spearWindup--;
    if (fighter.spearWindup === 0) {
      launchSpear(state, fighter);
      fighter.spearAimX = null;
      fighter.spearAimY = null;
    }
  }

  const oldX = fighter.x;
  const oldY = fighter.y;
  const wasGrounded = fighter.grounded;
  // A rider inherits horizontal platform displacement before their own
  // movement. The previous and current poses are the same geometry used by
  // rendering, projectile collision and the AI's platform routes.
  let platformCarryX = 0;
  if (wasGrounded && fighter.vy >= 0) {
    let closestSurface = Infinity;
    for (const platform of state.arena.platforms) {
      if (platform.motion !== 'float' || platform.axis !== 'x') continue;
      const previous = standingSurface(platform, state.motionTick - 1, fighter, oldX);
      if (!previous) continue;
      const distance = Math.abs(oldY - previous.y);
      if (distance > 2.5 || distance >= closestSurface) continue;
      const currentPose = platformPose(platform, state.motionTick);
      platformCarryX = currentPose.centerX - previous.pose.centerX;
      closestSurface = distance;
    }
  }
  fighter.x = clamp(fighter.x + fighter.vx + platformCarryX, 19, state.arena.width - 19);
  fighter.vy = Math.min(MAX_FALL_SPEED, fighter.vy + GRAVITY);
  fighter.y += fighter.vy;
  fighter.grounded = false;

  // A standing fighter follows the same fixed-tick surface drawn by the
  // renderer. This also lets a grounded fighter step onto adjacent 12px
  // treads; ordinary high platforms remain one-way jump landings.
  let support = null;
  if (wasGrounded && fighter.vy >= 0) {
    for (const platform of state.arena.platforms) {
      const previous = standingSurface(platform, state.motionTick - 1, fighter, oldX);
      const current = standingSurface(platform, state.motionTick, fighter, fighter.x);
      if (!previous || !current || Math.abs(oldY - previous.y) > 2.5) continue;
      const difference = Math.abs(oldY - previous.y);
      if (!support || difference < support.difference) support = { y: current.y, difference };
    }
    for (const platform of state.arena.platforms) {
      if (platform.kind !== 'stair') continue;
      const current = standingSurface(platform, state.motionTick, fighter, fighter.x);
      if (!current || fighter.x < current.pose.left || fighter.x >= current.pose.right
          || Math.abs(current.y - oldY) > 12.5) continue;
      support = { y: current.y, difference: Math.abs(current.y - oldY) };
      break;
    }
    if (!support && state.arena.groundY >= oldY
        && state.arena.groundY - oldY <= 12.5) {
      support = { y: state.arena.groundY, difference: state.arena.groundY - oldY };
    }
  }
  if (support) {
    fighter.y = support.y;
    fighter.vy = 0;
    fighter.grounded = true;
  } else if (fighter.vy >= 0) {
    let landingY = state.arena.groundY;
    for (const platform of state.arena.platforms) {
      const current = standingSurface(platform, state.motionTick, fighter, fighter.x);
      if (!current) continue;
      const previous = standingSurface(platform, state.motionTick - 1, fighter, oldX)
        ?? standingSurface(platform, state.motionTick - 1, fighter, fighter.x);
      if (oldY <= (previous?.y ?? current.y) + 1 && fighter.y >= current.y)
        landingY = Math.min(landingY, current.y);
    }
    if (fighter.y >= landingY && (landingY < state.arena.groundY
      || oldY <= state.arena.groundY + 1)) {
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
    fighter.bossCast = null;
    fighter.equipmentAttackId = null;
    fighter.equipmentTick = 0;
    fighter.equipmentHit = false;
    cancelSpear(state, fighter);
    event(state, 'ko', { x: fighter.x, y: WORLD_HEIGHT - 10, target: fighter.id, source: 'fall' });
  }
  // The jump-kick burst belongs to the first real damage frame, not startup.
  // A whiff still has a burst; a kick canceled by landing never reaches here.
  if (fighter.hp > 0 && fighter.kickType === 'air'
      && fighter.kickTick === kickOf(fighter).activeFrom) {
    emitKickEvent(state, fighter, 'air');
  }
  if (fighter.hp > 0) advanceBossCast(state, fighter);
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

  const hero = state.mode === 'campaign'
    ? state.fighters.find((fighter) => fighter.team === 0) : null;
  const heroBefore = hero ? {
    x: hero.x, y: hero.y, grounded: hero.grounded,
    stun: hero.stun, dodgeTicks: hero.dodgeTicks,
  } : null;
  state.motionTick++;

  if (state.mode === 'campaign' && state.aftermath) {
    // The victory walk runs in simulation time, but no remaining enemy,
    // projectile or environmental hazard can undo an already earned KO.
    const controls = inputsById[hero?.id];
    if (hero) moveFighter(state, hero, inputOf({
      left: controls?.left, right: controls?.right, jump: controls?.jump,
    }));
    advanceCorpses(state, heroBefore);
    return state;
  }

  // Summons are appended during a cast; they enter the AI loop on the next
  // tick instead of acting before the player sees their entry cue.
  for (const fighter of [...state.fighters]) moveFighter(state, fighter, inputOf(inputsById[fighter.id]));
  resolveAttacks(state);
  resolveProjectiles(state);
  for (const fighter of state.fighters) resolveHazards(state, fighter);
  advanceFallingHazard(state);
  advanceCorpses(state, heroBefore);
  if (state.mode === 'duel') resolveDuel(state);
  return state;
}

function ascentRoute(fighter, target, state) {
  const routes = (state.arena.platforms ?? []).flatMap((platform) => {
    const pose = platformPose(platform, state.motionTick);
    if (pose.right - pose.left < 42) return [];
    const margin = Math.min(24, (pose.right - pose.left) * 0.28);
    const landingX = clamp(target.x, pose.left + margin, pose.right - margin);
    const surface = platformSurfaceY(pose, landingX);
    const rise = fighter.y - surface;
    if (rise <= 20 || rise >= 124) return [];
    return [{
      platform, pose, landingX,
      score: Math.abs(landingX - fighter.x) + Math.abs(landingX - target.x) * 0.25
        + rise * 0.06,
    }];
  }).sort((a, b) => a.score - b.score || a.pose.centerY - b.pose.centerY
    || a.pose.left - b.pose.left);
  return routes[0] ?? null;
}

function supportingPlatform(fighter, state) {
  let support = null;
  for (const platform of state.arena.platforms ?? []) {
    const surface = standingSurface(platform, state.motionTick, fighter, fighter.x);
    if (!surface || Math.abs(fighter.y - surface.y) >= 3) continue;
    const current = { left: surface.pose.left, right: surface.pose.right,
      containsCenter: fighter.x >= surface.pose.left && fighter.x <= surface.pose.right };
    // A foot can touch two adjacent treads. Route from the one carrying the
    // fighter's centre, not the neighbouring plank found first in the array.
    if (!support || (current.containsCenter && !support.containsCenter)) support = current;
  }
  return support;
}

const HAZARD_ROUTE_MARGIN = 3;
const HAZARD_PHASE_MARGIN = 6;
const HAZARD_FLIGHT_TICKS = 52;

function hazardTouchesFighter(hazard, fighter, x, y) {
  return x + fighter.width * 0.43 > hazard.x
    && x - fighter.width * 0.43 < hazard.x + hazard.w
    && y > hazard.y && y - fighter.height * 0.49 < hazard.y + hazard.h;
}

// Forecast the fixed-step jump/dodge arc against the shared one-way platform
// geometry. A route must end outside *every* ground hazard, even one that
// happens to be dormant on its landing tick.
function predictHazardFlight(fighter, state, direction, { jump = false, dodgeAt = 0 } = {}) {
  if (dodgeAt && (fighter.dodgeCooldown > 0 || direction === 0)) return null;
  let { x, y, vx } = fighter;
  let vy = jump ? JUMP_SPEED : fighter.vy;
  let dodgeTicks = fighter.dodgeTicks;
  for (let tick = 1; tick <= HAZARD_FLIGHT_TICKS; tick++) {
    const oldX = x;
    const oldY = y;
    if (tick === dodgeAt) dodgeTicks = DODGE_TICKS;
    const protectedByDodge = dodgeTicks > 0 || (dodgeAt > 0
      && tick - dodgeAt < DODGE_TICKS);
    if (dodgeTicks > 0) {
      dodgeTicks--;
      vx = direction * DODGE_SPEED * (dodgeTicks < 3 ? 0.56 : 1);
    } else if (direction === 0) vx *= 0.88;
    else vx = approach(vx, direction * fighter.speed,
      jump && tick === 1 && fighter.grounded ? 0.9 : 0.52);
    x = clamp(x + vx, 19, state.arena.width - 19);
    vy = Math.min(MAX_FALL_SPEED, vy + GRAVITY);
    y += vy;

    let landed = false;
    if (vy >= 0) {
      let landingY = state.arena.groundY;
      for (const platform of state.arena.platforms) {
        const current = standingSurface(platform, state.motionTick + tick, fighter, x);
        if (!current) continue;
        const previous = standingSurface(platform, state.motionTick + tick - 1, fighter, oldX)
          ?? standingSurface(platform, state.motionTick + tick - 1, fighter, x);
        if (oldY <= (previous?.y ?? current.y) + 1 && y >= current.y)
          landingY = Math.min(landingY, current.y);
      }
      if (y >= landingY && (landingY < state.arena.groundY
          || oldY <= state.arena.groundY + 1)) {
        y = landingY;
        landed = true;
      }
    }

    if (!protectedByDodge && state.arena.hazards.some((hazard) =>
      hazardActive(hazard, state.tick + tick)
      && hazardTouchesFighter(hazard, fighter, x, y))) return null;
    if (landed) {
      if (state.arena.hazards.some((hazard) => hazardTouchesFighter(hazard, fighter, x, y)))
        return null;
      return { x, y, tick };
    }
  }
  return null;
}

function canWalkPastHazard(fighter, state, direction, farX) {
  let { x, vx } = fighter;
  for (let tick = 1; tick <= 110; tick++) {
    vx = approach(vx, direction * fighter.speed, 0.9);
    const nextX = clamp(x + vx, 19, state.arena.width - 19);
    if (nextX === x) return false;
    x = nextX;
    for (const hazard of state.arena.hazards) {
      if (!hazardTouchesFighter(hazard, fighter, x, fighter.y)) continue;
      // A periodic trap must stay off for the entire passage, with room for
      // a brief hitstop elsewhere in the fight; its current phase alone is
      // not enough to make walking into it safe.
      for (let margin = 0; margin <= HAZARD_PHASE_MARGIN; margin++) {
        if (hazardActive(hazard, state.tick + tick + margin)) return false;
      }
    }
    if (direction * (x - farX) >= 0) return true;
  }
  return false;
}

function hazardRouteForGround(fighter, state, walking, destinationX, freeToAct) {
  if (!fighter.grounded) return null;
  const touching = state.arena.hazards.find((hazard) =>
    hazardTouchesFighter(hazard, fighter, fighter.x, fighter.y));
  if (touching) {
    const left = touching.x - fighter.width * 0.43 - HAZARD_ROUTE_MARGIN;
    const right = touching.x + touching.w + fighter.width * 0.43 + HAZARD_ROUTE_MARGIN;
    const momentum = Math.sign(fighter.vx);
    const escape = momentum || (fighter.x - left < right - fighter.x ? -1 : 1);
    const dodge = freeToAct && fighter.dodgeCooldown === 0
      && hazardActive(touching, state.tick + 1);
    return { walking: escape, jump: false, dodge, suppressOffense: true };
  }
  if (walking === 0) return null;
  const direction = Math.sign(walking);
  const candidate = state.arena.hazards.filter((hazard) => fighter.y > hazard.y
    && fighter.y - fighter.height * 0.49 < hazard.y + hazard.h)
    .map((hazard) => {
      const clearance = fighter.width * 0.43 + HAZARD_ROUTE_MARGIN;
      const nearX = direction > 0 ? hazard.x - clearance : hazard.x + hazard.w + clearance;
      const farX = direction > 0 ? hazard.x + hazard.w + clearance : hazard.x - clearance;
      return { hazard, nearX, farX, distance: direction * (nearX - fighter.x) };
    }).filter(({ nearX, distance }) => direction * (destinationX - nearX) > 0
      && distance > -3 && distance < 72)
    .sort((a, b) => a.distance - b.distance)[0];
  if (!candidate) return null;
  const { nearX, farX, distance } = candidate;
  const launchBuffer = Math.max(fighter.speed * 2 + 3,
    Math.abs(fighter.vx) * 2.6 + 4);
  const walkSafe = freeToAct && canWalkPastHazard(fighter, state, direction, farX);
  if (walkSafe) return { walking: direction, jump: false, dodge: false, suppressOffense: true };

  const crosses = (flight) => flight && (direction * (flight.x - farX) >= 0
    || flight.y <= candidate.hazard.y);
  const jump = predictHazardFlight(fighter, state, direction, { jump: true });
  const jumpDodge = jump ? null
    : predictHazardFlight(fighter, state, direction, { jump: true, dodgeAt: 8 });
  if (freeToAct && !fighter.prevInput.jump && distance <= launchBuffer
      && (crosses(jump) || crosses(jumpDodge))) {
    return { walking: direction, jump: true, dodge: false, suppressOffense: true };
  }

  // If the current position is not yet a safe takeoff, see whether a running
  // takeoff at the near edge will be. Otherwise brake before the hazard and
  // wait for a full dormant window or for dodge to recharge.
  const launchX = nearX - direction * launchBuffer;
  const launchFighter = { ...fighter, x: launchX, vx: direction * fighter.speed };
  const laterJump = predictHazardFlight(launchFighter, state, direction, { jump: true });
  const laterDodge = laterJump ? null
    : predictHazardFlight(launchFighter, state, direction, { jump: true, dodgeAt: 8 });
  if (distance > launchBuffer && freeToAct && (crosses(laterJump) || crosses(laterDodge)))
    return null; // Continue the run-up; the next AI tick will reassess.
  const brake = Math.max(10, Math.abs(fighter.vx) * 2.6 + 5);
  if (distance > launchBuffer + brake) return null;
  return { walking: distance < fighter.speed + 3 ? -direction : 0,
    jump: false, dodge: false, suppressOffense: true };
}

function hazardRouteInAir(fighter, state, walking, freeToAct) {
  if (fighter.grounded || fighter.stun > 0 || fighter.dodgeTicks > 0) return null;
  const nearHazard = state.arena.hazards.some((hazard) => fighter.y < hazard.y + 20
    && fighter.x > hazard.x - 175 && fighter.x < hazard.x + hazard.w + 175);
  if (!nearHazard) return null;
  const direction = Math.sign(walking);
  const momentum = Math.sign(fighter.vx) || direction;
  const closeToTrap = state.arena.hazards.some((hazard) => fighter.y < hazard.y + 20
    && fighter.x > hazard.x - fighter.width * 0.43 - 18
    && fighter.x < hazard.x + hazard.w + fighter.width * 0.43 + 18);
  if (predictHazardFlight(fighter, state, direction)) {
    return closeToTrap ? { walking, jump: false, dodge: false, suppressOffense: true } : null;
  }
  if (momentum !== direction && predictHazardFlight(fighter, state, momentum)) {
    return { walking: momentum, jump: false, dodge: false, suppressOffense: true };
  }
  if (freeToAct && fighter.dodgeCooldown === 0 && momentum !== 0) {
    const jumpAge = (fighter.vy - JUMP_SPEED) / GRAVITY;
    const delay = jumpAge < 8 ? Math.max(1, Math.ceil(8 - jumpAge)) : 1;
    if (predictHazardFlight(fighter, state, momentum, { dodgeAt: delay })) {
      return { walking: momentum, jump: false, dodge: delay === 1, suppressOffense: true };
    }
    if (delay !== 1 && predictHazardFlight(fighter, state, momentum, { dodgeAt: 1 })) {
      return { walking: momentum, jump: false, dodge: true, suppressOffense: true };
    }
  }
  if (momentum !== 0 && predictHazardFlight(fighter, state, -momentum)) {
    return { walking: -momentum, jump: false, dodge: false, suppressOffense: true };
  }
  return { walking: momentum, jump: false, dodge: false, suppressOffense: true };
}

function safePlatformExit(fighter, state, exitX, direction) {
  if (state.arena.hazards.length === 0) return true;
  // The fighter leaves the plank at its edge, then keeps moving while falling.
  // Testing the ground directly beneath the edge would wrongly reject safe
  // exits whose landing point is beyond the trap (and send the AI backwards).
  const falling = { ...fighter, x: exitX, vx: direction * fighter.speed,
    vy: 0, grounded: false };
  return Boolean(predictHazardFlight(falling, state, direction));
}

/** Deterministic pursuit: align with a reachable platform before jumping; never punch empty air. */
export function aiInput(fighter, target, state) {
  if (!fighter || !target || fighter.hp <= 0 || target.hp <= 0) return inputOf();
  const distance = target.x - fighter.x;
  const gap = Math.abs(distance);
  const verticalGap = fighter.y - target.y;
  // Fighter heights differ (especially the boss). A fixed 65px cutoff leaves
  // a dead zone where a shorter enemy cannot punch but no longer tries to
  // climb the platform directly overhead.
  const punchOverlap = verticalHitOverlap(fighter, target);
  const targetAbove = verticalGap > 0 && !punchOverlap;
  const targetBelow = verticalGap < 0 && !punchOverlap;
  const isBoss = fighter.kind === 'boss';
  const isLeaper = fighter.kind === 'leaper';
  const isSlinger = fighter.kind === 'slinger';
  const isRusher = fighter.kind === 'rusher' || fighter.kind === 'runner' || isLeaper;
  const isGuard = fighter.kind === 'guard';
  const cadence = isBoss ? 54 : isLeaper ? 37 : isRusher ? 43 : isGuard ? 55 : 63;
  const idSeed = [...fighter.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const offset = idSeed % cadence;
  const kickCadence = isRusher ? 198 : 224;
  const phase = (state.tick + offset) % cadence;
  const wantedGap = isBoss ? 59 : isSlinger ? 215 : isRusher ? 48 : 57;
  const targetDirection = Math.sign(distance);
  const needsTurn = gap > (target.width ?? 29) * 0.35 && targetDirection !== fighter.facing;
  const canTurn = fighter.stun === 0 && fighter.dodgeTicks === 0
    && fighter.attackStage === 0 && fighter.kickType === null
    && fighter.spearWindup === 0 && !fighter.bossCast;
  let walking = gap > wantedGap || (needsTurn && canTurn) ? targetDirection : 0;
  let destinationX = target.x - targetDirection * wantedGap;
  if (isSlinger && !targetAbove && !targetBelow) {
    // The stone thrower keeps a readable firing lane, but cannot kite forever
    // into a world edge or abandon route safety around a ground trap.
    walking = gap < 135 && fighter.x - targetDirection * 88 > 30
      && fighter.x - targetDirection * 88 < state.arena.width - 30
      ? -targetDirection : gap > 235 ? targetDirection : 0;
    destinationX = walking === -targetDirection
      ? fighter.x - targetDirection * 88 : target.x - targetDirection * wantedGap;
  }
  let route = null;
  if (targetAbove) {
    route = ascentRoute(fighter, target, state);
    destinationX = route?.landingX ?? target.x;
    walking = Math.abs(destinationX - fighter.x) > 25 ? Math.sign(destinationX - fighter.x) : 0;
  } else if (targetBelow && fighter.grounded) {
    const support = supportingPlatform(fighter, state);
    if (support) {
      const leftExit = support.left - fighter.width;
      const rightExit = support.right + fighter.width;
      const leftDanger = !safePlatformExit(fighter, state, leftExit, -1);
      const rightDanger = !safePlatformExit(fighter, state, rightExit, 1);
      // A player below the plank should be approached via the exit nearest
      // their position, not the edge nearest the pursuer. Prefer a safe exit
      // when one edge would drop directly into a ground trap.
      const exitRight = leftDanger !== rightDanger ? leftDanger
        : Math.abs(rightExit - target.x) < Math.abs(leftExit - target.x);
      const exitX = exitRight ? rightExit : leftExit;
      walking = Math.sign(exitX - fighter.x);
      destinationX = exitX;
    }
  }
  const freeToAct = fighter.stun === 0 && fighter.dodgeTicks === 0
    && fighter.attackStage === 0 && fighter.kickType === null
    && fighter.spearWindup === 0 && !fighter.bossCast;
  const hazardRoute = state.mode === 'campaign' && fighter.team === 1
    && state.arena.hazards.length > 0
    ? hazardRouteForGround(fighter, state, walking, destinationX, freeToAct)
      ?? hazardRouteInAir(fighter, state, walking, freeToAct) : null;
  if (hazardRoute) walking = hazardRoute.walking;
  const jumpForHeight = targetAbove && fighter.grounded && freeToAct
    && (route ? Math.abs(fighter.x - route.landingX) <= 30
      : verticalGap <= 130 && gap <= 72)
    && (state.tick + idSeed) % 36 === 7;
  const special = !hazardRoute?.suppressOffense && !needsTurn && freeToAct
    && fighter.grounded
    && fighter.bossAbilityCooldown === 0 && state.mode === 'campaign'
    && fighter.team === 1
    ? isBoss ? nextBossSkill(state, fighter, target)
      : isSlinger && gap > 135 && gap < 660 ? 'rock' : null
    : null;
  return {
    left: walking < 0,
    right: walking > 0,
    jump: hazardRoute?.jump || (!hazardRoute?.suppressOffense
      && (jumpForHeight || (!targetAbove && isRusher
        && gap > (isLeaper ? 75 : 120) && gap < (isLeaper ? 265 : 225)
        && phase === 3))),
    attack: !hazardRoute?.suppressOffense && !needsTurn && fighter.spearWindup === 0
      && !fighter.bossCast && gap < (isBoss ? 100 : isSlinger ? 65 : 83)
      && punchOverlap && phase < (isBoss ? 5 : 3),
    kick: !hazardRoute?.suppressOffense && !needsTurn && !isBoss && freeToAct
      && ((fighter.grounded && verticalHitOverlap(fighter, target, 'ground') && gap < 80
        && (state.tick + idSeed % kickCadence) % kickCadence === 0)
        || (isLeaper && !fighter.grounded && !fighter.airKickUsed
          && verticalHitOverlap(fighter, target, 'air') && gap < 95
          && (state.tick + idSeed) % 15 === 0)),
    dodge: hazardRoute?.dodge || (!hazardRoute?.suppressOffense && !needsTurn
      && !targetAbove && !targetBelow && (isBoss || isGuard || isRusher || isSlinger)
      && gap < 104 && target.attackStage > 0 && phase === 19),
    spear: !hazardRoute?.suppressOffense && state.mode === 'campaign'
      && fighter.team === 1 && fighter.spearEnabled
      && freeToAct && !needsTurn && gap > 140 && gap < 640
      && (state.tick + idSeed * 11) % 127 === 0,
    ...(special ? { bossSkill: special } : {}),
  };
}
