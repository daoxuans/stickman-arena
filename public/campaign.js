import { aiInput, createCombatState, createFighter, stepCombat } from '../shared/combat.js';
import { MAX_LEVEL, checkpointFor, getLevel, isCheckpoint } from '../shared/levels.js';

export const STORAGE_KEY = 'stickman-arena.campaign.v1';
const SPECIAL_INVULNERABLE_TICKS = 36;

const memoryValues = new Map();
const memoryStorage = {
  getItem(key) { return memoryValues.get(key) ?? null; },
  setItem(key, value) { memoryValues.set(key, String(value)); },
  removeItem(key) { memoryValues.delete(key); },
};

function defaultStorage() {
  try {
    return globalThis.localStorage ?? memoryStorage;
  } catch {
    // Private browsing and file:// can deny localStorage access entirely.
    return memoryStorage;
  }
}

function freshProgress() {
  return { currentLevel: 1, checkpointLevel: 1, deaths: 0, completed: false, cleared: [] };
}

function validProgress(value) {
  if (!value || typeof value !== 'object') return freshProgress();
  const currentLevel = getLevel(value.currentLevel) ? value.currentLevel : 1;
  const checkpointLevel = isCheckpoint(value.checkpointLevel) && value.checkpointLevel <= currentLevel
    ? value.checkpointLevel
    : checkpointFor(currentLevel);
  const cleared = Array.isArray(value.cleared)
    ? [...new Set(value.cleared.filter((number) => getLevel(number)))].sort((a, b) => a - b)
    : [];
  return {
    currentLevel,
    checkpointLevel,
    deaths: Number.isSafeInteger(value.deaths) && value.deaths >= 0 ? value.deaths : 0,
    completed: value.completed === true && cleared.includes(MAX_LEVEL),
    cleared,
  };
}

function copyArena(level) {
  return {
    theme: level.theme, groundY: level.groundY,
    platforms: level.platforms.map((platform) => ({ ...platform })),
    hazards: level.hazards.map((hazard) => ({ ...hazard })),
    fallingHazard: level.arena.fallingHazard ? { ...level.arena.fallingHazard } : null,
  };
}

/** A local, fully deterministic campaign. Only the small progress record is saved. */
export class CampaignSession {
  constructor({ storage, storageKey = STORAGE_KEY } = {}) {
    this.storage = storage ?? defaultStorage();
    this.storageKey = storageKey;
    this.progress = freshProgress();
    this.phase = 'idle';
    this.combat = null;
    this.levelNumber = null;
    this.waveIndex = 0;
    this.failedLevel = null;
    this.specialEligible = false;
    this.specialKills = 0;
    this.specialCharges = 0;
    this.specialHeld = false;
    this.#load();
  }

  #load() {
    let saved;
    try {
      saved = this.storage.getItem(this.storageKey);
    } catch {
      this.storage = memoryStorage;
      try {
        saved = this.storage.getItem(this.storageKey);
      } catch {
        saved = null;
      }
    }
    if (saved) {
      try { this.progress = validProgress(JSON.parse(saved)); }
      catch { this.progress = freshProgress(); }
    }
  }

  #save() {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.progress));
    } catch {
      this.storage = memoryStorage;
      this.storage.setItem(this.storageKey, JSON.stringify(this.progress));
    }
  }

  /** Start the saved level from its original positions, with fresh health and hazards. */
  start() {
    if (this.progress.completed) {
      this.phase = 'completed';
      return this.snapshot();
    }
    const level = getLevel(this.progress.currentLevel);
    if (isCheckpoint(level.number)) this.progress.checkpointLevel = level.number;
    this.levelNumber = level.number;
    this.waveIndex = 0;
    this.failedLevel = null;
    this.specialEligible = level.enemyCount > 3;
    this.specialKills = 0;
    this.specialCharges = 0;
    this.specialHeld = false;
    this.phase = 'playing';
    const player = createFighter({
      id: 'hero', name: '火柴斗士', x: 170, y: level.groundY, team: 0, kind: 'hero', maxHp: 100,
    });
    this.combat = createCombatState({
      mode: 'campaign', arena: copyArena(level), fighters: [player],
    });
    this.#spawnWave();
    this.#save();
    return this.snapshot();
  }

  #spawnWave() {
    const level = getLevel(this.levelNumber);
    const wave = level.waves[this.waveIndex];
    const player = this.combat.fighters.find((fighter) => fighter.team === 0);
    const count = wave.groups.reduce((total, group) => total + group.count, 0);
    const spawnOnRight = player.x < 490;
    this.combat.fighters = this.combat.fighters.filter((fighter) => fighter.team === 0 || fighter.hp > 0);
    let serial = 0;

    for (const group of wave.groups) {
      for (let index = 0; index < group.count; index++) {
        const distance = count === 1 ? 0 : serial * 70;
        const x = spawnOnRight ? 710 + distance : 250 - distance;
        this.combat.fighters.push(createFighter({
          id: `enemy-${level.number}-${wave.index}-${serial}`,
          name: group.name, kind: group.kind, team: 1,
          x, y: level.groundY, maxHp: group.maxHp, damageScale: group.damageScale,
        }));
        serial++;
      }
    }
    this.combat.events.push({
      id: `${this.combat.tick}:wave-${wave.index}`,
      type: 'wave', wave: wave.index, totalWaves: level.waves.length,
    });
  }

  #castSpecial(player) {
    const targets = this.combat.fighters.filter((fighter) => fighter.team !== player.team && fighter.hp > 0);
    if (!targets.length) return null;
    this.specialCharges--;
    player.stun = 0;
    player.attackStage = 0;
    player.attackTick = 0;
    player.kickType = null;
    player.kickTick = 0;
    player.attackBuffered = false;
    player.comboWindow = 0;
    player.dodgeTicks = 0;
    player.invulnerable = Math.max(player.invulnerable, SPECIAL_INVULNERABLE_TICKS + 1);
    player.specialWaveTicks = SPECIAL_INVULNERABLE_TICKS;

    const hits = targets.map((target) => {
      const before = target.hp;
      target.hp = Math.ceil(before / 2);
      target.stun = Math.max(target.stun, 16);
      target.invulnerable = Math.max(target.invulnerable, 12);
      target.hurtFlash = 11;
      target.attackStage = 0;
      target.attackTick = 0;
      target.kickType = null;
      target.kickTick = 0;
      target.attackBuffered = false;
      target.comboWindow = 0;
      const direction = Math.sign(target.x - player.x) || player.facing;
      target.vx = direction * 6 / target.mass;
      target.vy = Math.min(target.vy, -3);
      target.grounded = false;
      return { target: target.id, x: target.x, y: target.y - target.height * .57, damage: before - target.hp };
    });
    return { x: player.x, y: player.y - player.height * .52, hits };
  }

  /** Advance one fixed 1/60-second tick. The light wave is campaign-only. */
  step(input = {}) {
    if (this.phase !== 'playing') return this.snapshot();
    const player = this.combat.fighters.find((fighter) => fighter.team === 0);
    // Hitstop does not sample actions. The browser retains short taps until
    // the next live tick, so a held button must not spend charges while frozen.
    const samplingInput = this.combat.hitstop === 0;
    const specialDown = input.special === true;
    const special = samplingInput && specialDown && !this.specialHeld
      && this.specialEligible && this.specialCharges > 0 && player.hp > 0
      ? this.#castSpecial(player) : null;
    if (samplingInput) this.specialHeld = specialDown;
    const inputsById = { [player.id]: special
      ? { ...input, attack: false, kick: false, dodge: false } : input };
    for (const enemy of this.combat.fighters) {
      if (enemy.team === 1 && enemy.hp > 0) inputsById[enemy.id] = aiInput(enemy, player, this.combat);
    }
    stepCombat(this.combat, inputsById);
    if (samplingInput && player.specialWaveTicks > 0) player.specialWaveTicks--;
    if (special) {
      this.combat.events.push({
        id: `${this.combat.tick}:special-wave`, type: 'special-wave',
        x: special.x, y: special.y, source: player.id, radius: 960,
      });
      for (const hit of special.hits) {
        this.combat.events.push({
          id: `${this.combat.tick}:special-hit:${hit.target}`, type: 'hit',
          ...hit, source: player.id, heavy: true, special: true,
        });
      }
    }
    if (this.specialEligible && player.hp > 0) {
      for (const outcome of this.combat.events) {
        if (outcome.type !== 'ko' || outcome.source !== player.id
          || !this.combat.fighters.some((fighter) => fighter.id === outcome.target && fighter.team === 1)) continue;
        this.specialKills++;
        if (this.specialKills % 2 === 0) {
          this.specialCharges++;
          this.combat.events.push({
            id: `${this.combat.tick}:special-ready:${this.specialKills}`,
            type: 'special-ready', charges: this.specialCharges,
          });
        }
      }
    }

    // Failure takes precedence even if the last blow knocked both sides out.
    if (player.hp <= 0) {
      this.failedLevel = this.levelNumber;
      this.progress.deaths++;
      this.progress.currentLevel = this.progress.checkpointLevel;
      this.phase = 'failed';
      this.combat.events.push({
        id: `${this.combat.tick}:campaign-fail`, type: 'campaign-fail',
        failedLevel: this.failedLevel, checkpointLevel: this.progress.checkpointLevel,
      });
      this.#save();
    } else if (this.combat.fighters.every((fighter) => fighter.team === 0 || fighter.hp <= 0)) {
      const level = getLevel(this.levelNumber);
      if (this.waveIndex + 1 < level.waves.length) {
        const nextWave = level.waves[this.waveIndex + 1];
        const bossEntering = nextWave.groups.some((group) => group.kind === 'boss');
        this.waveIndex++;
        player.hp = Math.min(player.maxHp, player.hp + (bossEntering ? 30 : 12));
        this.#spawnWave();
      } else {
        if (!this.progress.cleared.includes(level.number)) this.progress.cleared.push(level.number);
        this.progress.cleared.sort((a, b) => a - b);
        this.progress.completed = level.number === MAX_LEVEL;
        if (!this.progress.completed) this.progress.currentLevel = level.number + 1;
        this.phase = this.progress.completed ? 'completed' : 'cleared';
        this.combat.events.push({
          id: `${this.combat.tick}:level-clear`, type: 'level-clear', level: level.number,
        });
        this.#save();
      }
    }
    return this.snapshot();
  }

  /** Continue from a clear screen, activating a checkpoint on entry. */
  next() {
    return this.phase === 'cleared' ? this.start() : this.snapshot();
  }

  /** A failed run always retries at the saved checkpoint, never the failed room. */
  retry() {
    return this.phase === 'failed' ? this.start() : this.snapshot();
  }

  /** Explicit new-game action; ordinary failure never erases achievement history. */
  reset() {
    this.progress = freshProgress();
    try { this.storage.removeItem(this.storageKey); } catch { /* #save below will use fallback */ }
    return this.start();
  }

  snapshot() {
    const level = getLevel(this.levelNumber ?? this.progress.currentLevel);
    return {
      phase: this.phase,
      level,
      combat: this.combat,
      events: this.combat?.events ?? [],
      waveIndex: this.waveIndex,
      waveNumber: this.waveIndex + 1,
      waveCount: level.waves.length,
      failedLevel: this.failedLevel,
      specialEligible: this.specialEligible,
      specialKills: this.specialKills,
      specialCharges: this.specialCharges,
      progress: { ...this.progress, cleared: [...this.progress.cleared] },
    };
  }
}
