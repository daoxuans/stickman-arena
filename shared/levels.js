// Campaign data is shared by the browser and the test runner. Coordinates are
// in a 1920 x 540 scrolling world; y is the ground/character-foot coordinate.
export const MAX_LEVEL = 56;
export const CAMPAIGN_WORLD_WIDTH = 1920;

export const THEMES = Object.freeze({
  forest: {
    id: 'forest', name: '森林', chapter: 1,
    palette: { sky: '#153c45', horizon: '#448664', ground: '#31523a', accent: '#b8e66b' },
    scenery: ['远山', '树冠', '藤蔓', '萤火'],
    platformType: 'log', hazardType: 'thorns', bossName: '森林领主',
  },
  city: {
    id: 'city', name: '城市', chapter: 2,
    palette: { sky: '#1c2445', horizon: '#5c6684', ground: '#454b62', accent: '#ffca75' },
    scenery: ['楼群', '路灯', '霓虹', '车流'],
    platformType: 'roof', hazardType: 'traffic', bossName: '钢铁拳王',
  },
  ocean: {
    id: 'ocean', name: '海洋', chapter: 3,
    palette: { sky: '#146780', horizon: '#4aa6ae', ground: '#316b77', accent: '#9de9e5' },
    scenery: ['远岛', '浪花', '帆影', '海鸟'],
    platformType: 'pier', hazardType: 'tide', bossName: '潮汐之主',
  },
  land: {
    id: 'land', name: '陆地', chapter: 4,
    palette: { sky: '#5c3e38', horizon: '#ad704d', ground: '#684b3d', accent: '#f4bb79' },
    scenery: ['群山', '岩柱', '沙尘', '裂谷'],
    platformType: 'rock', hazardType: 'fissure', bossName: '大地守卫',
  },
});

const CHAPTERS = [
  { theme: 'forest', names: [
    '林缘试招', '枝影追击', '苔径夹击', '倒木跃迁', '古树营地', '荆棘窄道', '萤火夜袭',
    '藤桥伏兵', '猎人哨所', '雾林断路', '根须陷阱', '狼影回环', '心树祭坛', '森林领主',
  ] },
  { theme: 'city', names: [
    '清晨街口', '地铁阶梯', '霓虹背巷', '施工围挡', '天台据点', '排水隧道', '高架追逐',
    '广场夹击', '钟楼平台', '电车站台', '雨夜屋顶', '货仓火线', '中央广场', '钢铁拳王',
  ] },
  { theme: 'ocean', names: [
    '海岸登陆', '码头栈桥', '潮间岩带', '灯塔外沿', '浮台锚点', '船舱斜坡', '暴风甲板',
    '珊瑚窄滩', '深蓝补给站', '巨浪回响', '沉船残骸', '漩流边界', '海心祭台', '潮汐之主',
  ] },
  { theme: 'land', names: [
    '荒原起点', '红土峡口', '碎石斜坡', '沙丘伏击', '岩洞营地', '风蚀高台', '熔裂隘口',
    '石柱阵地', '旱谷前哨', '尘暴边缘', '矿坑回声', '赤岩绝壁', '大地之门', '大地守卫',
  ] },
];

// Each of the fourteen positions in a chapter has its own wave composition.
// Groups in the same wave enter together; subsequent waves enter after a KO.
const WAVE_BLUEPRINTS = [
  [[['grunt', 1]]],
  [[['rusher', 1]], [['grunt', 1]]],
  [[['grunt', 2]]],
  [[['guard', 1]], [['rusher', 1], ['grunt', 1]]],
  [[['grunt', 2]], [['guard', 1]]],
  [[['rusher', 2]], [['brute', 1]]],
  [[['guard', 1], ['grunt', 1]], [['rusher', 2]]],
  [[['brute', 1]], [['grunt', 2], ['guard', 1]]],
  [[['rusher', 1], ['guard', 1]], [['brute', 1], ['grunt', 1]]],
  [[['grunt', 2]], [['guard', 2]], [['rusher', 1]]],
  [[['rusher', 2]], [['brute', 1], ['guard', 1]]],
  [[['brute', 1], ['grunt', 1]], [['guard', 1], ['rusher', 2]]],
  [[['guard', 2]], [['rusher', 2]], [['brute', 1]]],
  [[['brute', 1]], [['boss', 1]]],
];

const ENEMY_HP = { grunt: 64, rusher: 52, guard: 80, brute: 104, boss: 140 };
const ENEMY_DAMAGE = { grunt: 0.73, rusher: 0.66, guard: 0.8, brute: 1.04, boss: 0.82 };
const ENEMY_NAMES = { grunt: '斗士', rusher: '疾行者', guard: '盾卫', brute: '重拳手' };
const MILESTONE_BOSSES = Object.freeze({
  10: '雾林巨拳',
  20: '地下铁卫',
  30: '风暴巨兵',
  40: '深海狂拳',
  50: '荒原巨灵',
});
const FALLING_TYPES = Object.freeze({
  forest: 'pinecone', city: 'debris', ocean: 'hail', land: 'pebble',
});
// A small campaign-wide lift; the already-balanced boss stats stay untouched.
const REGULAR_HP_BOOST = 1.04;
const REGULAR_DAMAGE_BOOST = 1.025;

const PLATFORM_LAYOUTS = [
  [[168, 66, 140], [526, 88, 138]],
  [[272, 84, 152], [620, 64, 128]],
  [[126, 91, 118], [430, 61, 161]],
  [[336, 68, 145], [685, 98, 116]],
  [[216, 103, 132], [550, 67, 153]],
  [[105, 72, 142], [472, 102, 137]],
  [[297, 94, 121], [620, 75, 145]],
];

const STAIR_WIDTH = 50;
const STAIR_RISE = 12;

// Each tread touches its neighbours and rises only 12px, so the combat
// simulation can step onto it while the player keeps walking horizontally.
// x/y/w/h remain the platform's baseline rectangle. Floating platforms use
// an explicit x/y axis and a pixel amplitude; rotating wooden bars tilt in
// radians about their horizontal centre. Motion uses deterministic ticks.
function addStairs(platforms, { x, groundY, count, direction, group, type }) {
  const top = groundY - count * STAIR_RISE;
  if (direction === 'down') {
    platforms.push({ x: x - 130, y: top, w: 130, h: 12, type });
  }
  for (let index = 0; index < count; index++) {
    platforms.push({
      x: x + index * STAIR_WIDTH,
      y: groundY - (direction === 'up' ? index + 1 : count - index) * STAIR_RISE,
      w: STAIR_WIDTH, h: 12, type,
      kind: 'stair', stairGroup: group, stairIndex: index, stairDirection: direction,
    });
  }
  if (direction === 'up') {
    platforms.push({ x: x + count * STAIR_WIDTH, y: top, w: 130, h: 12, type });
  }
}

function movingPlatform({ x, y, w, type, motion, axis, period, amplitude }) {
  return {
    x, y, w, h: 12, type, motion,
    baseX: motion === 'rotate' ? x + w / 2 : x,
    baseY: y, period, amplitude, phase: 0,
    ...(motion === 'float' ? { axis } : {}),
    ...(motion === 'rotate' ? { baseAngle: 0, angle: 0 } : {}),
  };
}

function makeArena(theme, stage, chapterIndex, number) {
  const groundY = [444, 452, 448, 454][chapterIndex] - ((stage + chapterIndex) % 3) * 3;
  const layout = PLATFORM_LAYOUTS[(stage + chapterIndex - 1) % PLATFORM_LAYOUTS.length];
  const platforms = [
    {
      x: 760 + (layout[0][0] + stage * 13 + chapterIndex * 29) % 90,
      y: groundY - layout[0][1], w: layout[0][2], h: 12, type: theme.platformType,
    },
    {
      x: 1640 + (layout[1][0] + stage * 17 + chapterIndex * 31) % 80,
      y: groundY - layout[1][1], w: layout[1][2], h: 12, type: theme.platformType,
    },
  ];
  const westSteps = stage < 4 ? 3 : stage < 8 ? 4 : stage < 12 ? 5 : 6;
  addStairs(platforms, {
    x: 260 + (stage * 19 + chapterIndex * 31) % 70,
    groundY, count: westSteps, direction: 'up', group: 'west', type: theme.platformType,
  });
  if (stage >= 6) {
    const eastSteps = stage < 9 ? 3 : stage < 13 ? 4 : 5;
    addStairs(platforms, {
      x: 1320 + (stage * 29 + chapterIndex * 17) % 70,
      groundY, count: eastSteps, direction: 'down', group: 'east', type: theme.platformType,
    });
  }
  if (stage >= 5) {
    platforms.push(movingPlatform({
      x: 1080 + (stage * 23 + chapterIndex * 19) % 120,
      y: groundY - 92, w: 128, type: theme.platformType,
      motion: 'float', axis: 'y', period: 220 - stage * 3,
      amplitude: 14 + Math.floor((stage - 5) / 3) * 3,
    }));
  }
  if (stage >= 8) {
    platforms.push(movingPlatform({
      x: 920 + (stage * 21 + chapterIndex * 17) % 60,
      y: groundY - 108, w: 160, type: 'log',
      motion: 'rotate', period: 240 - stage * 4, amplitude: 0.1 + Math.floor((stage - 8) / 2) * 0.015,
    }));
  }
  if (stage >= 11) {
    platforms.push(movingPlatform({
      x: 1260 + (stage * 19 + chapterIndex * 31) % 70,
      y: groundY - 124, w: 112, type: theme.platformType,
      motion: 'float', axis: 'x', period: 205 - stage * 2,
      amplitude: 20 + (stage - 11) * 4,
    }));
  }
  if (stage >= 13) {
    platforms.push(movingPlatform({
      x: 1500 + (stage * 37 + chapterIndex * 11) % 80,
      y: groundY - 126, w: 144, type: 'log',
      motion: 'rotate', period: 190 - stage * 2, amplitude: 0.17,
    }));
  }
  platforms.sort((a, b) => a.x - b.x || a.y - b.y);
  const hazards = [];

  if (stage > 1) {
    const x = 520 + ((stage * 37 + chapterIndex * 67) % 250);
    const periodic = stage >= 5;
    hazards.push({
      x, y: groundY - 14, w: 56 + (stage % 3) * 10, h: 14,
      type: theme.hazardType, damage: 2 + chapterIndex + Math.floor(stage / 6),
      ...(periodic ? { period: 190 + (stage % 3) * 30, activeTicks: 108, phase: stage * 17 } : {}),
    });
  }
  if (stage >= 8) {
    hazards.push({
      x: 1240 + (stage * 43 + chapterIndex * 47) % 300,
      y: groundY - 13, w: 42, h: 13,
      type: theme.hazardType, damage: 2 + chapterIndex,
      period: 240, activeTicks: 92, phase: 64 + stage * 11,
    });
  }

  return {
    theme: theme.id, width: CAMPAIGN_WORLD_WIDTH, groundY, platforms, hazards,
    // A single, telegraphed falling object per four seconds on even-numbered
    // campaign stages. Its seed is the global level number, so retrying a
    // checkpoint reconstructs the same predictable sequence.
    ...(number % 2 === 0 ? { fallingHazard: {
      type: FALLING_TYPES[theme.id], period: 240, firstTick: 120,
      warningTicks: 40, radius: 8, damageFraction: 0.1, seed: number,
    } } : {}),
  };
}

function makeWaves(stage, chapterIndex, theme, number) {
  const makeGroup = (kind, count, name = kind === 'boss' ? theme.bossName : ENEMY_NAMES[kind]) => ({
    kind, count, name,
    maxHp: Math.round(ENEMY_HP[kind] * (1 + chapterIndex * 0.13 + stage * 0.016)
      * (kind === 'boss' ? 1 : REGULAR_HP_BOOST)),
    damageScale: Number((ENEMY_DAMAGE[kind] * (1 + chapterIndex * 0.085 + stage * 0.011)
      * (kind === 'boss' ? 1 : REGULAR_DAMAGE_BOOST)).toFixed(2)),
  });
  const waves = WAVE_BLUEPRINTS[stage - 1].map((blueprint, waveIndex) => ({
    index: waveIndex + 1,
    groups: blueprint.map(([kind, count]) => makeGroup(kind, count)),
  }));
  if (MILESTONE_BOSSES[number]) {
    waves.push({ index: waves.length + 1,
      groups: [makeGroup('boss', 1, MILESTONE_BOSSES[number])] });
  }
  return waves;
}

export const LEVELS = Object.freeze(CHAPTERS.flatMap((chapter, chapterIndex) => {
  const theme = THEMES[chapter.theme];
  return chapter.names.map((name, index) => {
    const stage = index + 1;
    const number = chapterIndex * 14 + stage;
    const arena = makeArena(theme, stage, chapterIndex, number);
    const waves = makeWaves(stage, chapterIndex, theme, number);
    return {
      number, stage, chapter: chapterIndex + 1, name,
      theme: theme.id, themeName: theme.name,
      isBoss: waves.some((wave) => wave.groups.some((group) => group.kind === 'boss')),
      isCheckpoint: [1, 5, 9, 13].includes(stage),
      groundY: arena.groundY, platforms: arena.platforms, hazards: arena.hazards,
      arena, waves,
      enemyCount: waves.reduce((total, wave) => total + wave.groups.reduce((count, group) => count + group.count, 0), 0),
    };
  });
}));

export function getLevel(number) {
  return Number.isInteger(number) && number >= 1 && number <= MAX_LEVEL
    ? LEVELS[number - 1]
    : null;
}

export function isCheckpoint(number) {
  return getLevel(number)?.isCheckpoint ?? false;
}

export function checkpointFor(number) {
  const level = getLevel(number);
  return level ? (level.chapter - 1) * 14 + 1 + Math.floor((level.stage - 1) / 4) * 4 : null;
}
