import { aiInput, cancelSpearAim, createCombatState, createFighter, stepCombat } from '../shared/combat.js';
import { MAX_LEVEL, checkpointFor, getLevel, isCheckpoint } from '../shared/levels.js';

export const STORAGE_KEY = 'stickman-arena.campaign.v1';
const SPECIAL_INVULNERABLE_TICKS = 36;
const SCATTER_FINISH_TICKS = 36;

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
    theme: level.theme, width: level.arena.width, groundY: level.groundY,
    platforms: level.platforms.map((platform) => ({ ...platform })),
    hazards: level.hazards.map((hazard) => ({ ...hazard })),
    fallingHazard: level.arena.fallingHazard ? { ...level.arena.fallingHazard } : null,
  };
}

function safeSpawnX(level, desired, playerX, occupied, direction) {
  const width = level.arena.width ?? 960;
  const clampX = (x) => Math.max(46, Math.min(width - 46, x));
  for (let step = 0; step <= 20; step++) {
    for (const side of step === 0 ? [0] : [direction, -direction]) {
      const x = clampX(desired + side * step * 66);
      if (Math.abs(x - playerX) < 190 || occupied.some((other) => Math.abs(other - x) < 58)) continue;
      if (level.hazards.some((hazard) => x + 22 > hazard.x - 8
        && x - 22 < hazard.x + hazard.w + 8)) continue;
      return x;
    }
  }
  return clampX(desired);
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
    this.aftermathUntilTick = null;
    // A replay is a temporary fight. Keep the official scene itself in memory
    // so leaving practice can resume it without rewinding its combat state.
    this.replayLevel = null;
    this.officialState = null;
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
    if (this.replayLevel !== null) return this.snapshot();
    if (this.progress.completed) {
      this.phase = 'completed';
      return this.snapshot();
    }
    const level = getLevel(this.progress.currentLevel);
    if (isCheckpoint(level.number)) this.progress.checkpointLevel = level.number;
    return this.#startLevel(level, true);
  }

  #startLevel(level, saveProgress) {
    this.levelNumber = level.number;
    this.waveIndex = 0;
    this.failedLevel = null;
    this.specialEligible = level.enemyCount > 3;
    this.specialKills = 0;
    this.specialCharges = 0;
    this.specialHeld = false;
    this.aftermathUntilTick = null;
    this.phase = 'playing';
    const player = createFighter({
      id: 'hero', name: '火柴斗士', x: 170, y: level.groundY, team: 0, kind: 'hero', maxHp: 100,
    });
    this.combat = createCombatState({
      mode: 'campaign', arena: copyArena(level), fighters: [player],
    });
    this.#spawnWave();
    if (saveProgress) this.#save();
    return this.snapshot();
  }

  /** Fight an already-cleared stage without modifying the official save/run. */
  replay(levelNumber) {
    if (!this.progress.cleared.includes(levelNumber)) return this.snapshot();
    if (this.officialState === null) {
      this.officialState = {
        phase: this.phase, combat: this.combat, levelNumber: this.levelNumber,
        waveIndex: this.waveIndex, failedLevel: this.failedLevel,
        specialEligible: this.specialEligible, specialKills: this.specialKills,
        specialCharges: this.specialCharges, specialHeld: this.specialHeld,
        aftermathUntilTick: this.aftermathUntilTick,
      };
    }
    this.replayLevel = levelNumber;
    return this.#startLevel(getLevel(levelNumber), false);
  }

  /** Rebuild the selected practice level, irrespective of the saved checkpoint. */
  retryReplay() {
    return this.replayLevel === null
      ? this.snapshot() : this.#startLevel(getLevel(this.replayLevel), false);
  }

  /** Return to the exact official scene/result that was paused for practice. */
  exitReplay() {
    if (this.officialState === null) return this.snapshot();
    Object.assign(this, this.officialState);
    this.officialState = null;
    this.replayLevel = null;
    return this.snapshot();
  }

  #spawnWave() {
    const level = getLevel(this.levelNumber);
    const wave = level.waves[this.waveIndex];
    const player = this.combat.fighters.find((fighter) => fighter.team === 0);
    // A new wave is a fresh aiming situation; do not keep an old arc or a
    // confirmed throw pointed at a fighter that no longer exists.
    cancelSpearAim(player);
    player.spearWindup = 0;
    player.spearAimAngle = null;
    player.spearLaunchFacing = null;
    player.spearAimX = null;
    player.spearAimY = null;
    const count = wave.groups.reduce((total, group) => total + group.count, 0);
    const width = this.combat.arena.width;
    const spawnOnRight = player.x < width * 0.62;
    const direction = spawnOnRight ? 1 : -1;
    const baseX = this.waveIndex === 0 && width > 960
      ? width * 0.78 : width <= 960
        ? (spawnOnRight ? 710 : 250)
        : player.x + direction * 480;
    this.combat.fighters = this.combat.fighters.filter((fighter) => fighter.team === 0 || fighter.hp > 0);
    this.combat.projectiles = [];
    let serial = 0;
    const occupied = [];

    for (const group of wave.groups) {
      for (let index = 0; index < group.count; index++) {
        const distance = count === 1 ? 0 : serial * (width > 960 ? 84 : 70);
        const x = safeSpawnX(level, baseX + direction * distance, player.x, occupied, direction);
        occupied.push(x);
        this.combat.fighters.push(createFighter({
          id: `enemy-${level.number}-${wave.index}-${serial}`,
          name: group.name, kind: group.kind, team: 1,
          x, y: level.groundY, maxHp: group.maxHp, damageScale: group.damageScale,
          bossTier: group.bossTier ?? 0,
          spearEnabled: level.number >= 15 && !['boss', 'slinger'].includes(group.kind)
            && serial === 0 && (level.number + wave.index) % 2 === 0,
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
    cancelSpearAim(player);
    player.spearWindup = 0;
    player.spearAimAngle = null;
    player.spearLaunchFacing = null;
    player.spearAimX = null;
    player.spearAimY = null;
    player.attackBuffered = false;
    player.comboWindow = 0;
    player.dodgeTicks = 0;
    player.invulnerable = Math.max(player.invulnerable, SPECIAL_INVULNERABLE_TICKS + 1);
    player.specialWaveTicks = SPECIAL_INVULNERABLE_TICKS;

    const hits = targets.map((target) => {
      const before = target.hp;
      // Bosses withstand the campaign-only light wave: lose one third of
      // current HP rather than the half taken by an ordinary enemy.
      target.hp = target.kind === 'boss' ? Math.ceil(before * 2 / 3) : Math.ceil(before / 2);
      target.stun = Math.max(target.stun, 16);
      target.invulnerable = Math.max(target.invulnerable, 12);
      target.hurtFlash = 11;
      target.attackStage = 0;
      target.attackTick = 0;
      target.kickType = null;
      target.kickTick = 0;
      target.bossCast = null;
      target.spearWindup = 0;
      target.spearAimX = null;
      target.spearAimY = null;
      target.attackBuffered = false;
      target.comboWindow = 0;
      const direction = Math.sign(target.x - player.x) || player.facing;
      target.vx = direction * 6 / target.mass;
      target.vy = Math.min(target.vy, -3);
      target.grounded = false;
      return { target: target.id, x: target.x, y: target.y - target.height * .57, damage: before - target.hp };
    });
    return { hits };
  }

  #beginAftermath(player) {
    this.phase = 'aftermath';
    this.combat.aftermath = true;
    this.aftermathUntilTick = Math.max(this.combat.motionTick,
      ...this.combat.corpses.map((corpse) => corpse.expireTick));
    this.combat.projectiles = [];
    this.combat.fallingObject = null;
    cancelSpearAim(player);
    // The finishing hit remains in the event stream (and its hitstop stays),
    // but no buffered combo, kick or dodge can start another active move while
    // the player is only meant to walk/jump through the victory aftermath.
    player.attackStage = 0;
    player.attackTick = 0;
    player.attackBuffered = false;
    player.comboStage = 0;
    player.comboWindow = 0;
    player.kickType = null;
    player.kickTick = 0;
    player.dodgeTicks = 0;
    player.jumpBuffer = 0;
    for (const fighter of this.combat.fighters) {
      fighter.spearWindup = 0;
      fighter.spearLaunchFacing = null;
    }
  }

  #completeLevel() {
    const level = getLevel(this.levelNumber);
    if (this.replayLevel === null) {
      if (!this.progress.cleared.includes(level.number)) this.progress.cleared.push(level.number);
      this.progress.cleared.sort((a, b) => a - b);
      this.progress.completed = level.number === MAX_LEVEL;
      if (!this.progress.completed) this.progress.currentLevel = level.number + 1;
    }
    this.phase = this.replayLevel !== null ? 'cleared'
      : this.progress.completed ? 'completed' : 'cleared';
    this.combat.aftermath = false;
    this.aftermathUntilTick = null;
    this.combat.events.push({
      id: `${this.combat.tick}:level-clear`, type: 'level-clear', level: level.number,
    });
    if (this.replayLevel === null) this.#save();
  }

  /** Advance one fixed 1/60-second tick. The light wave is campaign-only. */
  step(input = {}) {
    if (this.phase !== 'playing' && this.phase !== 'aftermath') return this.snapshot();
    const player = this.combat.fighters.find((fighter) => fighter.team === 0);
    if (this.phase === 'aftermath') {
      const beforeTick = this.combat.motionTick;
      stepCombat(this.combat, { [player.id]: {
        left: input.left === true, right: input.right === true, jump: input.jump === true,
      } });
      if (this.combat.motionTick > beforeTick && player.specialWaveTicks > 0) {
        player.specialWaveTicks--;
      }
      if (this.combat.events.some((outcome) => outcome.type === 'bones-scatter')) {
        this.aftermathUntilTick = Math.max(this.aftermathUntilTick,
          this.combat.motionTick + SCATTER_FINISH_TICKS);
      }
      if (this.combat.motionTick >= this.aftermathUntilTick) this.#completeLevel();
      return this.snapshot();
    }
    // Hitstop does not sample actions. The browser retains short taps until
    // the next live tick, so an edge-triggered action is not lost while frozen.
    const samplingInput = this.combat.hitstop === 0;
    const specialDown = input.special === true;
    const special = samplingInput && specialDown && !this.specialHeld
      && this.specialEligible && this.specialCharges > 0 && player.hp > 0
      ? this.#castSpecial(player) : null;
    if (samplingInput) this.specialHeld = specialDown;
    const inputsById = { [player.id]: special
      ? { ...input, attack: false, kick: false, dodge: false, spear: false } : input };
    for (const enemy of this.combat.fighters) {
      if (enemy.team === 1 && enemy.hp > 0) inputsById[enemy.id] = aiInput(enemy, player, this.combat);
    }
    stepCombat(this.combat, inputsById);
    if (samplingInput && player.specialWaveTicks > 0) player.specialWaveTicks--;
    if (special) {
      this.combat.events.push({
        id: `${this.combat.tick}:special-wave`, type: 'special-wave',
        x: player.x, y: player.y - player.height * .52, source: player.id,
        facing: player.facing < 0 ? -1 : 1, radius: this.combat.arena.width,
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
      if (this.replayLevel === null) {
        this.progress.deaths++;
        this.progress.currentLevel = this.progress.checkpointLevel;
      }
      this.phase = 'failed';
      this.combat.events.push({
        id: `${this.combat.tick}:campaign-fail`, type: 'campaign-fail',
        failedLevel: this.failedLevel,
        checkpointLevel: this.replayLevel ?? this.progress.checkpointLevel,
      });
      if (this.replayLevel === null) this.#save();
    } else if (this.combat.fighters.every((fighter) => fighter.team === 0 || fighter.hp <= 0)) {
      const level = getLevel(this.levelNumber);
      if (this.waveIndex + 1 < level.waves.length) {
        const nextWave = level.waves[this.waveIndex + 1];
        const bossEntering = nextWave.groups.some((group) => group.kind === 'boss');
        this.waveIndex++;
        player.hp = Math.min(player.maxHp, player.hp + (bossEntering ? 30 : 12));
        this.#spawnWave();
      } else if (this.combat.events.some((outcome) => outcome.type === 'ko'
        && this.combat.fighters.some((fighter) => fighter.id === outcome.target && fighter.team === 1))) {
        this.#beginAftermath(player);
      } else this.#completeLevel();
    }
    return this.snapshot();
  }

  /** Continue from a clear screen, activating a checkpoint on entry. */
  next() {
    return this.phase === 'cleared' && this.replayLevel === null
      ? this.start() : this.snapshot();
  }

  /** A failed run always retries at the saved checkpoint, never the failed room. */
  retry() {
    return this.phase !== 'failed' ? this.snapshot()
      : this.replayLevel !== null ? this.retryReplay() : this.start();
  }

  /** Explicit new-game action; ordinary failure never erases achievement history. */
  reset() {
    this.officialState = null;
    this.replayLevel = null;
    this.progress = freshProgress();
    try { this.storage.removeItem(this.storageKey); } catch { /* #save below will use fallback */ }
    return this.start();
  }

  snapshot() {
    const level = getLevel(this.levelNumber ?? this.progress.currentLevel);
    return {
      phase: this.phase,
      replaying: this.replayLevel !== null,
      replayLevel: this.replayLevel,
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
      spearRemaining: this.combat?.spearRemaining ?? 0,
      aftermathRemainingTicks: this.phase === 'aftermath'
        ? Math.max(0, this.aftermathUntilTick - this.combat.motionTick) : 0,
      progress: { ...this.progress, cleared: [...this.progress.cleared] },
    };
  }
}
