import { aiInput, createCombatState, createFighter, stepCombat } from '../shared/combat.js';
import { MAX_LEVEL, checkpointFor, getLevel, isCheckpoint } from '../shared/levels.js';

export const STORAGE_KEY = 'stickman-arena.campaign.v1';

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

  /** Advance one fixed 1/60-second tick. Inputs are {left,right,attack,jump,dodge}. */
  step(input = {}) {
    if (this.phase !== 'playing') return this.snapshot();
    const player = this.combat.fighters.find((fighter) => fighter.team === 0);
    const inputsById = { [player.id]: input };
    for (const enemy of this.combat.fighters) {
      if (enemy.team === 1 && enemy.hp > 0) inputsById[enemy.id] = aiInput(enemy, player, this.combat);
    }
    stepCombat(this.combat, inputsById);

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
      progress: { ...this.progress, cleared: [...this.progress.cleared] },
    };
  }
}
