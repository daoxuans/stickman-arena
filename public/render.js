import { attackOf, kickOf, TICK_RATE, SPEAR_GRAVITY, SPEAR_MAX_ANGLE, SPEAR_MIN_ANGLE,
  SPEAR_WINDUP_TICKS, spearAimedFlight, spearFlight, spearOrigin,
  spearTrajectoryPoint } from '../shared/combat.js';
import { platformPose } from '../shared/platforms.js';

// The viewport is 960 × 540, while campaign world coordinates may span 1920px.
// The canvas backing store is scaled for high-density screens only.
const W = 960;
const H = 540;
const TAU = Math.PI * 2;
const HEAD_RADIUS = 22;
const SPEAR_PREVIEW_TICKS = 94;
const SPEAR_RADIUS = 7;
const TOMATO_DROP_MS = 180;
const TOMATO_LIFE_MS = 1080;
const TOMATO_FALL_MS = 270;
const TOMATO_CRUSH_MS = 125;
const TOMATO_SPLASH_MS = 470;
const TOMATO_DROP_TICKS = Math.round(TOMATO_DROP_MS * TICK_RATE / 1000);
const CORPSE_FADE_TICKS = 12;
const BONES_SCATTER_MS = 620;
const BONE_PARTS = [
  { kind: 'head', along: 85, lift: 16, tilt: 0 },
  { kind: 'torso', along: 56, lift: 12, length: 38, tilt: -.1 },
  { kind: 'arm', along: 64, lift: 24, length: 25, tilt: -.42 },
  { kind: 'arm', along: 55, lift: 2, length: 26, tilt: .44 },
  { kind: 'leg', along: 30, lift: 17, length: 29, tilt: -.32 },
  { kind: 'leg', along: 20, lift: 3, length: 28, tilt: .38 },
];
const WANDERER_PALETTES = [
  { capeEdge: '#632029', cape: '#c73642', fold: '#ef6b68',
    scarf: '#b62236', scarfLight: '#eb4a4e', eye: '#fff9f2', eyeAccent: '#ff555a' },
  { capeEdge: '#14394b', cape: '#23758b', fold: '#78b8c5',
    scarf: '#287f98', scarfLight: '#54bfd2', eye: '#e9feff', eyeAccent: '#7be8f1' },
];
const WANDERER_FACE = '#08151b';
const WANDERER_HAT = {
  shadow: '#081219', crown: '#1c2932', facet: '#293640',
  weave: '#567e8d', rim: '#4db2bd',
};

const THEMES = {
  forest: {
    sky: ['#234d59', '#82ada0', '#efc995'],
    sun: '#f6d7a2',
    ground: ['#395845', '#1f3d38'],
    rim: '#a8be87',
    platform: '#554b37',
    platformTop: '#8eaa71',
    label: 'FOREST',
  },
  city: {
    sky: ['#35344f', '#76647c', '#e2a17b'],
    sun: '#f4c3a5',
    ground: ['#455458', '#253c43'],
    rim: '#b8b5a3',
    platform: '#586e76',
    platformTop: '#b5b8ad',
    label: 'CITY',
  },
  ocean: {
    sky: ['#37728b', '#8dc0be', '#f8d3a0'],
    sun: '#fff0c7',
    ground: ['#876b53', '#4b4b44'],
    rim: '#e9c18a',
    platform: '#715948',
    platformTop: '#d6ad78',
    label: 'OCEAN',
  },
  land: {
    sky: ['#845769', '#c98969', '#f3d2a0'],
    sun: '#f9d39b',
    ground: ['#9b6950', '#5f4843'],
    rim: '#e2b881',
    platform: '#86634e',
    platformTop: '#cc9b6c',
    label: 'LAND',
  },
};

// Keep the jade/gold spell language constant; just the small secondary flecks
// borrow a hue from the current landscape so photographs stay legible.
const SPIRIT_TINTS = {
  forest: '#b8ead0',
  city: '#d1d2ee',
  ocean: '#b9f1eb',
  land: '#ffe0ae',
};
const SPIRIT_BEAM_MS = 560;
const SPIRIT_BEAM_CALM_MS = 330;

const PHOTO_THEMES = ['forest', 'city', 'ocean', 'land'];
const PHOTO_BACKGROUNDS = Object.fromEntries(PHOTO_THEMES.map((theme) => [theme,
  ['', '-2', '-3', '-4'].map((suffix) => `./assets/backgrounds/${theme}${suffix}.webp`),
]));
// Keep the existing sixteen assignments, except for the requested first-stage
// photo. The former first-stage forest photo moves to stage 4, and stage 27
// adds a separate city photo without replacing any existing background.
const PHOTO_OVERRIDES = new Map([
  [1, './assets/backgrounds/forest-intro.webp'],
  [4, './assets/backgrounds/forest.webp'],
  [27, './assets/backgrounds/city-5.webp'],
]);

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const PHOTO_STAGES = [];
for (let chapter = 0; chapter < PHOTO_THEMES.length; chapter++) {
  const previousEndsChapter = PHOTO_STAGES[chapter - 1]?.has(14) ?? false;
  const candidates = Array.from({ length: 14 }, (_, index) => index + 1)
    .filter((stage) => !previousEndsChapter || stage !== 1)
    .sort((a, b) => hash(a * 19.19 + chapter * 43.7) - hash(b * 19.19 + chapter * 43.7));
  const chosen = [];
  for (const stage of candidates) {
    if (chosen.length < 4 && chosen.every((previous) => Math.abs(previous - stage) > 1)) chosen.push(stage);
  }
  // Assign each of the chapter's four photos once. Ordering by stage keeps
  // the mapping identical after a refresh or a checkpoint retry.
  const backgrounds = PHOTO_BACKGROUNDS[PHOTO_THEMES[chapter]];
  PHOTO_STAGES.push(new Map(chosen.sort((a, b) => a - b)
    .map((stage, index) => [stage, backgrounds[index]])));
}

// A seeded draw keeps reloads and checkpoint retries visually consistent.
// Most stages retain the illustrated scene; campaign photos always match
// the chapter's theme. Online duels never request photos.
export function photoForLevel(theme, level) {
  if (!Number.isInteger(level) || level < 1 || level > 56) return null;
  const chapter = Math.floor((level - 1) / 14);
  if (PHOTO_THEMES[chapter] !== theme) return null;
  const stage = (level - 1) % 14 + 1;
  return PHOTO_OVERRIDES.get(level) ?? PHOTO_STAGES[chapter].get(stage) ?? null;
}

function normalizedTheme(value) {
  const theme = String(value || 'forest').toLowerCase();
  if (theme.includes('city') || theme.includes('城市')) return 'city';
  if (theme.includes('ocean') || theme.includes('sea') || theme.includes('海')) return 'ocean';
  if (theme.includes('land') || theme.includes('desert') || theme.includes('陆')) return 'land';
  return 'forest';
}

function polygon(ctx, points, color) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function ellipse(ctx, x, y, rx, ry, color, rotation = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(.1, rx), Math.max(.1, ry), rotation, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
}

function line(ctx, points, color, width = 1) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function sky(ctx, colors) {
  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(.57, colors[1]);
  gradient.addColorStop(1, colors[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);
}

function sun(ctx, x, y, radius, color) {
  const bloom = ctx.createRadialGradient(x, y, radius * .45, x, y, radius * 3);
  bloom.addColorStop(0, 'rgba(255,225,174,.25)');
  bloom.addColorStop(1, 'rgba(255,225,174,0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(x - radius * 3, y - radius * 3, radius * 6, radius * 6);
  ellipse(ctx, x, y, radius, radius, color);
}

function cloud(ctx, x, y, scale, color) {
  ctx.save();
  ctx.globalAlpha = .48;
  ellipse(ctx, x, y, 46 * scale, 11 * scale, color);
  ellipse(ctx, x - 25 * scale, y + 5 * scale, 38 * scale, 8 * scale, color);
  ellipse(ctx, x + 29 * scale, y + 4 * scale, 42 * scale, 8 * scale, color);
  ctx.restore();
}

function drawTiledWorld(ctx, worldWidth, drawSegment) {
  // Alternate original and mirrored 960px panels: a photo never gets stretched
  // twice as wide, and the illustrated horizons meet at their shared edge.
  for (let tile = 0; tile < Math.ceil(worldWidth / W); tile++) {
    if (tile === 0) {
      drawSegment();
      continue;
    }
    ctx.save();
    ctx.translate((tile + (tile % 2 ? 1 : 0)) * W, 0);
    if (tile % 2) ctx.scale(-1, 1);
    drawSegment();
    ctx.restore();
  }
}

function drawForest(ctx, tick, groundY, seed) {
  sky(ctx, THEMES.forest.sky);
  sun(ctx, 744, 133, 50, THEMES.forest.sun);
  const drift = Math.sin(tick * .002) * 7;
  cloud(ctx, 196 + drift, 83, 1.15, '#d3dad2');
  cloud(ctx, 506 - drift * .5, 133, .58, '#d7e0d0');

  polygon(ctx, [[0, 300], [125, 269], [242, 294], [356, 245], [468, 281], [593, 241], [730, 282], [845, 245], [960, 276], [960, groundY], [0, groundY]], '#71988a');
  polygon(ctx, [[0, 332], [95, 304], [186, 325], [317, 291], [459, 332], [587, 288], [728, 328], [850, 296], [960, 319], [960, groundY], [0, groundY]], '#48776c');

  ctx.save();
  ctx.globalAlpha = .48;
  for (let i = -1; i < 14; i++) {
    const x = i * 83 + hash(i + seed) * 32;
    const top = 181 + hash(i * 8 + seed) * 60;
    const height = groundY - top;
    polygon(ctx, [[x - 6, groundY], [x - 5, top + 42], [x, top], [x + 6, top + 40], [x + 7, groundY]], '#254c4d');
    line(ctx, [[x, top + 95], [x - 22, top + 48]], '#254c4d', 5);
    line(ctx, [[x, top + 74], [x + 18, top + 34]], '#254c4d', 4);
    ellipse(ctx, x, top + 8, 35, 22, '#315d59');
    ellipse(ctx, x - 23, top + 34, 28, 19, '#315d59');
    ellipse(ctx, x + 26, top + 31, 30, 20, '#315d59');
    if (height > 200) ellipse(ctx, x + 3, top + 40, 33, 17, '#315d59');
  }
  ctx.restore();

  const mist = ctx.createLinearGradient(0, 255, 0, groundY);
  mist.addColorStop(0, 'rgba(218,224,190,0)');
  mist.addColorStop(.6, 'rgba(209,224,190,.13)');
  mist.addColorStop(1, 'rgba(210,228,197,.27)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, 255, W, groundY - 255);

  for (let i = 0; i < 19; i++) {
    const x = hash(i * 24 + seed) * W;
    const y = 205 + hash(i * 17 + seed) * (groundY - 235);
    const glimmer = .2 + .2 * Math.sin(tick * .04 + i * 3);
    ellipse(ctx, x, y, 1.4, 1.4, `rgba(246,226,165,${glimmer})`);
  }
}

function drawCity(ctx, tick, groundY, seed) {
  sky(ctx, THEMES.city.sky);
  sun(ctx, 752, 135, 43, THEMES.city.sun);
  cloud(ctx, 174 + Math.sin(tick * .002) * 6, 122, .75, '#a6a0ab');

  for (let layer = 0; layer < 2; layer++) {
    const step = layer ? 72 : 50;
    const color = layer ? '#334552' : '#586475';
    for (let i = -1; i < Math.ceil(W / step) + 1; i++) {
      const x = i * step + (layer ? 0 : -17);
      const width = step - (layer ? 6 : 3);
      const top = (layer ? 198 : 240) - hash(i * 7 + layer * 20 + seed) * (layer ? 115 : 95);
      ctx.fillStyle = color;
      ctx.fillRect(x, top, width, groundY - top);
      if (layer) {
        ctx.fillStyle = '#647580';
        ctx.fillRect(x + 8, top - 5, Math.max(8, width - 16), 5);
        for (let row = top + 15; row < groundY - 16; row += 18) {
          for (let col = x + 11; col < x + width - 7; col += 16) {
            const lit = hash(row * .37 + col * .73 + seed);
            ctx.fillStyle = lit > .55 ? 'rgba(252,205,151,.5)' : 'rgba(158,190,188,.17)';
            ctx.fillRect(col, row, 7, 9);
          }
        }
      }
    }
  }

  line(ctx, [[0, 254], [235, 277], [502, 248], [768, 268], [960, 250]], 'rgba(38,58,68,.75)', 2);
  line(ctx, [[0, 263], [235, 287], [502, 259], [768, 279], [960, 261]], 'rgba(38,58,68,.5)', 1);
  for (const x of [115, 386, 672, 908]) {
    line(ctx, [[x, 263], [x, 226]], '#405260', 3);
    line(ctx, [[x - 13, 226], [x + 14, 226]], '#405260', 2);
  }
  const haze = ctx.createLinearGradient(0, 300, 0, groundY);
  haze.addColorStop(0, 'rgba(245,174,131,0)');
  haze.addColorStop(1, 'rgba(247,183,139,.22)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 300, W, groundY - 300);
}

function drawOcean(ctx, tick, groundY, seed) {
  sky(ctx, THEMES.ocean.sky);
  sun(ctx, 720, 126, 51, THEMES.ocean.sun);
  cloud(ctx, 194 + Math.sin(tick * .0018) * 8, 95, 1.03, '#eff1dc');
  cloud(ctx, 477 - Math.sin(tick * .0015) * 5, 155, .6, '#f9eed6');

  polygon(ctx, [[0, 292], [65, 288], [123, 292], [167, 284], [225, 291], [960, 291], [960, groundY], [0, groundY]], '#6d9897');
  polygon(ctx, [[0, 296], [370, 296], [499, 283], [556, 287], [645, 296], [960, 296], [960, groundY], [0, groundY]], '#427f88');
  const sea = ctx.createLinearGradient(0, 295, 0, groundY);
  sea.addColorStop(0, '#539aa1');
  sea.addColorStop(1, '#1b5a6a');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 295, W, Math.max(0, groundY - 295));

  for (let row = 0; row < 8; row++) {
    const y = 306 + row * 16;
    const alpha = .25 - row * .016;
    ctx.beginPath();
    for (let x = -10; x <= W + 10; x += 6) {
      const waveY = y + Math.sin(x * .02 + tick * .025 + row) * (2 + row * .38);
      if (x === -10) ctx.moveTo(x, waveY); else ctx.lineTo(x, waveY);
    }
    ctx.strokeStyle = `rgba(231,241,210,${alpha})`;
    ctx.lineWidth = row % 3 === 0 ? 2 : 1;
    ctx.stroke();
  }

  // A distant vessel and its rigging keep the ocean legible even when the
  // foreground fight covers most of the water.
  const shipX = 218 + hash(seed) * 42;
  polygon(ctx, [[shipX - 57, 323], [shipX + 64, 323], [shipX + 39, 339], [shipX - 30, 338]], '#315665');
  line(ctx, [[shipX + 3, 323], [shipX + 3, 252]], '#315665', 3);
  polygon(ctx, [[shipX + 7, 261], [shipX + 7, 312], [shipX + 44, 313]], 'rgba(235,222,190,.75)');
  polygon(ctx, [[shipX - 1, 270], [shipX - 1, 307], [shipX - 32, 312]], 'rgba(230,218,188,.48)');
  for (const [x, y] of [[540, 134], [561, 143], [883, 201]]) {
    ctx.beginPath();
    ctx.arc(x, y, 7, Math.PI * 1.08, Math.PI * 1.83);
    ctx.arc(x + 14, y, 7, Math.PI * 1.16, Math.PI * 1.95);
    ctx.strokeStyle = 'rgba(35,74,83,.65)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawLand(ctx, tick, groundY, seed) {
  sky(ctx, THEMES.land.sky);
  sun(ctx, 722, 117, 55, THEMES.land.sun);
  cloud(ctx, 267 + Math.sin(tick * .0012) * 7, 133, .65, '#ead0ba');

  polygon(ctx, [[0, 310], [105, 299], [137, 264], [195, 264], [226, 300], [345, 301], [412, 274], [493, 274], [539, 310], [699, 300], [760, 255], [843, 255], [888, 303], [960, 297], [960, groundY], [0, groundY]], '#ad7a68');
  polygon(ctx, [[0, 327], [70, 311], [109, 277], [133, 278], [154, 320], [301, 322], [364, 291], [385, 291], [418, 329], [601, 315], [659, 282], [682, 281], [731, 320], [960, 317], [960, groundY], [0, groundY]], '#875d59');
  polygon(ctx, [[0, 348], [170, 330], [290, 349], [449, 325], [602, 345], [751, 322], [960, 350], [960, groundY], [0, groundY]], '#b07b61');

  for (let i = 0; i < 7; i++) {
    const x = 40 + i * 151 + hash(i + seed) * 31;
    const y = groundY - 50 - hash(i * 5 + seed) * 22;
    polygon(ctx, [[x - 29, groundY], [x - 20, y + 15], [x - 6, y], [x + 14, y + 8], [x + 33, groundY]], 'rgba(103,70,66,.46)');
    line(ctx, [[x - 18, y + 28], [x + 9, y + 17]], 'rgba(241,189,136,.21)', 2);
  }

  const dust = ctx.createLinearGradient(0, 275, 0, groundY);
  dust.addColorStop(0, 'rgba(239,186,135,0)');
  dust.addColorStop(1, 'rgba(241,197,146,.24)');
  ctx.fillStyle = dust;
  ctx.fillRect(0, 275, W, groundY - 275);
  for (let i = 0; i < 17; i++) {
    const x = hash(i * 3 + seed) * W;
    const y = 286 + hash(i * 9 + seed) * Math.max(15, groundY - 310);
    ellipse(ctx, x + Math.sin(tick * .005 + i) * 4, y, 1.2, 1.2, 'rgba(255,220,170,.25)');
  }
}

function drawPhotoBackdrop(ctx, image, theme, groundY, opacity, worldWidth) {
  const colors = {
    forest: ['rgba(8,30,27,.17)', 'rgba(8,30,27,.47)'],
    city: ['rgba(15,27,37,.16)', 'rgba(13,29,34,.46)'],
    ocean: ['rgba(8,35,48,.14)', 'rgba(8,39,49,.45)'],
    land: ['rgba(15,37,31,.15)', 'rgba(13,38,31,.43)'],
  }[theme];
  ctx.save();
  ctx.globalAlpha = opacity;
  drawTiledWorld(ctx, worldWidth, () => ctx.drawImage(image, 0, 0, W, H));
  const veil = ctx.createLinearGradient(0, 0, 0, groundY);
  veil.addColorStop(0, colors[0]);
  veil.addColorStop(1, colors[1]);
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, worldWidth, groundY);
  ctx.restore();
}

function drawGround(ctx, theme, groundY, tick, seed, photoGrassland = false) {
  const style = THEMES[theme];
  const gradient = ctx.createLinearGradient(0, groundY, 0, H);
  gradient.addColorStop(0, photoGrassland ? '#53694e' : style.ground[0]);
  gradient.addColorStop(1, photoGrassland ? '#253e39' : style.ground[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, groundY, W, H - groundY);
  ctx.fillStyle = photoGrassland ? '#a2bb8d' : style.rim;
  ctx.fillRect(0, groundY, W, theme === 'ocean' ? 8 : 6);

  if (theme === 'forest') {
    ctx.fillStyle = '#253f38';
    ctx.fillRect(0, groundY + 16, W, 8);
    for (let i = 0; i < 54; i++) {
      const x = i * 19 + hash(i + seed) * 8;
      const h = 3 + hash(i * 7) * 8;
      line(ctx, [[x - 3, groundY], [x, groundY - h], [x + 2, groundY - 2]], i % 3 ? '#8fae7b' : '#bed098', 1.5);
    }
    for (let i = 0; i < 12; i++) {
      const x = i * 90 + hash(i + 31) * 31;
      line(ctx, [[x, groundY + 28], [x + 21, groundY + 52], [x + 59, groundY + 57]], 'rgba(15,44,39,.39)', 3);
    }
  } else if (theme === 'city') {
    ctx.fillStyle = '#243d43';
    ctx.fillRect(0, groundY + 17, W, 9);
    for (let x = 0; x < W; x += 72) {
      line(ctx, [[x, groundY + 26], [x + 14, H]], 'rgba(189,201,189,.16)', 1);
      ctx.fillStyle = 'rgba(235,215,157,.42)';
      ctx.fillRect(x + 20, groundY + 11, 25, 2);
    }
    for (let x = 44; x < W; x += 217) {
      ctx.fillStyle = '#293f43';
      ctx.fillRect(x, groundY - 8, 43, 8);
      ctx.fillStyle = '#b3aa8d';
      ctx.fillRect(x + 5, groundY - 9, 34, 2);
    }
  } else if (theme === 'ocean') {
    ctx.fillStyle = '#493d36';
    ctx.fillRect(0, groundY + 21, W, 10);
    for (let y = groundY + 13; y < H; y += 23) {
      line(ctx, [[0, y], [W, y]], 'rgba(239,205,155,.24)', 2);
      for (let x = ((y - groundY) % 46) * 5 - 30; x < W; x += 140) {
        line(ctx, [[x, y], [x, y + 22]], 'rgba(41,48,44,.31)', 2);
        ellipse(ctx, x + 10, y + 7, 1.4, 1.4, 'rgba(247,214,165,.3)');
      }
    }
    for (let x = 95; x < W; x += 215) {
      ctx.fillStyle = '#344a49';
      ctx.fillRect(x, groundY + 14, 6, 53);
    }
  } else if (photoGrassland) {
    for (let i = 0; i < 43; i++) {
      const x = hash(i * 13 + seed) * W;
      const height = 3 + hash(i * 5 + seed) * 9;
      line(ctx, [[x - 3, groundY], [x, groundY - height], [x + 3, groundY - 2]], i % 3 ? '#78936a' : '#b8c99a', 1.4);
    }
    for (let y = groundY + 21; y < H; y += 24) {
      line(ctx, [[0, y], [W, y + 5]], 'rgba(184,206,158,.13)', 2);
    }
  } else {
    for (let i = 0; i < 38; i++) {
      const x = hash(i * 13 + seed) * W;
      const y = groundY + 17 + hash(i * 31 + seed) * (H - groundY - 20);
      line(ctx, [[x, y], [x + 15 + hash(i * 5) * 24, y + 2]], 'rgba(246,207,151,.2)', 1.3);
    }
    for (let x = 23; x < W; x += 66) {
      const height = 3 + hash(x + seed) * 8;
      line(ctx, [[x - 4, groundY], [x, groundY - height]], '#d1aa79', 1.2);
      line(ctx, [[x, groundY - height], [x + 5, groundY - height - 2]], '#d1aa79', 1.2);
    }
    line(ctx, [[0, groundY + 43], [155, groundY + 49], [318, groundY + 41], [489, groundY + 47], [668, groundY + 39], [960, groundY + 48]], 'rgba(57,45,45,.23)', 3);
  }
}

function drawPlatforms(ctx, platforms, theme, motionTick) {
  const style = THEMES[theme];
  for (const platform of platforms || []) {
    const pose = platformPose(platform, motionTick);
    const w = pose.width;
    const h = Math.max(6, pose.height || 14);
    if (!w) continue;
    ctx.save();
    ctx.translate(pose.centerX, pose.centerY);
    if (pose.angle) ctx.rotate(pose.angle);
    const x = -w / 2;
    const y = 0;
    if (platform.motion === 'rotate') {
      // The top edge is y=0 in exactly the same rotated frame as platformPose.
      // Clear wooden end grain and a small pivot make the moving plank legible.
      ctx.fillStyle = 'rgba(12,33,34,.23)';
      ctx.fillRect(x + 5, y + 9, w, h);
      ctx.fillStyle = '#684b37';
      ctx.fillRect(x, y + 2, w, h);
      ctx.fillStyle = '#c99866';
      ctx.fillRect(x, y, w, 5);
      ctx.fillStyle = '#8b6545';
      ctx.fillRect(x + 2, y + 6, 5, h - 5);
      ctx.fillRect(x + w - 7, y + 6, 5, h - 5);
      line(ctx, [[x + 13, y + 8], [x + w - 13, y + 8]], '#a87a50', 1.4);
      ellipse(ctx, 0, y + h * .65, 3.2, 3.2, '#e4be87');
      ctx.restore();
      continue;
    }
    if (platform.motion === 'float') {
      ellipse(ctx, 0, y + h + 12, w * .36, 3, 'rgba(218,244,215,.18)');
      line(ctx, [[x + 12, y + h + 4], [x + w - 12, y + h + 4]],
        'rgba(215,243,220,.42)', 1.5);
    }
    ctx.fillStyle = 'rgba(12,33,34,.18)';
    ctx.fillRect(x + 5, y + 8, w, h);
    ctx.fillStyle = style.platform;
    ctx.fillRect(x, y + 3, w, h);
    ctx.fillStyle = style.platformTop;
    ctx.fillRect(x, y, w, 6);
    if (platform.kind === 'stair') {
      // Each 50px tread is an independent top surface, with an exposed riser.
      ctx.fillStyle = 'rgba(20,39,39,.24)';
      ctx.fillRect(x + (platform.stairDirection === 'down' ? 1 : w - 6), y + 6, 5, h - 3);
      ctx.fillStyle = 'rgba(255,236,196,.25)';
      ctx.fillRect(x + 4, y + 1, Math.max(0, w - 8), 2);
    }
    if (theme === 'forest') {
      for (let i = 0; i < w; i += 27) line(ctx, [[x + i + 9, y + 10], [x + i + 15, y + h - 1]], 'rgba(31,54,42,.27)', 1.5);
    } else if (theme === 'city') {
      for (let i = 12; i < w; i += 28) ellipse(ctx, x + i, y + 10, 2, 2, '#bdc7b9');
      ctx.fillStyle = 'rgba(30,46,48,.45)';
      ctx.fillRect(x + 4, y + h - 3, Math.max(0, w - 8), 3);
    } else if (theme === 'ocean') {
      for (let i = 20; i < w; i += 40) line(ctx, [[x + i, y + 6], [x + i, y + h]], 'rgba(49,45,38,.3)', 2);
    } else {
      polygon(ctx, [[x + w * .2, y + 6], [x + w * .31, y + h], [x + w * .38, y + 6]], 'rgba(66,49,46,.15)');
      line(ctx, [[x + w * .57, y + 7], [x + w * .48, y + h - 2]], 'rgba(245,207,151,.25)', 2);
    }
    ctx.restore();
  }
}

function drawHazards(ctx, hazards, theme, tick) {
  for (const hazard of hazards || []) {
    const x = number(hazard.x);
    const y = number(hazard.y);
    const w = Math.max(0, number(hazard.w));
    const h = Math.max(0, number(hazard.h));
    if (!w || !h) continue;
    const type = String(hazard.type || '').toLowerCase();
    // Match shared/combat.js hazardActive exactly: the graphic is a contract
    // with the player about the ticks on which this rectangle can deal damage.
    const periodic = Number.isFinite(hazard.period) && hazard.period > 0;
    const period = periodic ? Math.max(1, Math.floor(hazard.period)) : 1;
    const activeTicks = clamp(Math.floor(hazard.activeTicks ?? period * .56), 0, period);
    const phase = Math.floor(hazard.phase ?? 0);
    const cycle = ((tick + phase) % period + period) % period;
    const active = !periodic || cycle < activeTicks;
    ctx.save();
    ctx.fillStyle = 'rgba(17,37,39,.66)';
    ctx.fillRect(x, y + h - 3, w, 3);
    if (type.includes('water') || type.includes('tide') || type.includes('wave')) {
      if (active) {
        const gradient = ctx.createLinearGradient(0, y, 0, y + h);
        gradient.addColorStop(0, 'rgba(172,243,229,.9)');
        gradient.addColorStop(1, 'rgba(27,113,134,.84)');
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y + 2, w, h - 2);
        ctx.beginPath();
        for (let px = x; px <= x + w; px += 4) {
          const py = y + 2 + Math.sin(px * .035 + tick * .06) * 2;
          if (px === x) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = '#e0fff0';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = '#335b62';
        ctx.fillRect(x, y + h - 6, w, 6);
        line(ctx, [[x + 2, y + h - 7], [x + w - 2, y + h - 7]], 'rgba(182,218,203,.34)', 1);
      }
    } else if (type.includes('traffic')) {
      ctx.fillStyle = active ? '#4c4544' : '#3c4d50';
      ctx.fillRect(x, y + 1, w, h - 1);
      for (let px = x + 3; px < x + w - 4; px += 14) {
        polygon(ctx, [[px, y + h - 2], [px + 7, y + 2], [px + 12, y + 2], [px + 5, y + h - 2]], active ? '#f6ad60' : '#68777a');
      }
      if (active) {
        ctx.fillStyle = tick % 18 < 9 ? '#ffe7a2' : '#e87b57';
        ctx.fillRect(x + 2, y - 4, 6, 4);
        ctx.fillRect(x + w - 8, y - 4, 6, 4);
        line(ctx, [[x + 2, y], [x + w - 2, y]], '#fce0a7', 2);
      } else {
        line(ctx, [[x + 3, y + 1], [x + w - 3, y + 1]], '#5e7273', 1.4);
      }
    } else if (type.includes('fissure')) {
      ctx.fillStyle = active ? '#5a3c3c' : '#4e4141';
      ctx.fillRect(x, y + 3, w, h - 3);
      const teeth = [];
      for (let i = 0; i <= 8; i++) {
        const px = x + (i / 8) * w;
        teeth.push([px, y + 3 + (i % 2 ? 4 : 0)]);
      }
      line(ctx, teeth, active ? '#ffbd73' : '#735a56', active ? 4 : 2);
      if (active) {
        for (let px = x + 9; px < x + w; px += 19) {
          ellipse(ctx, px, y + h - 3, 3, 2, '#f37250');
          line(ctx, [[px, y + 1], [px + Math.sin(tick * .12 + px) * 3, y - 5]], 'rgba(255,193,116,.66)', 1.5);
        }
      }
    } else if (type.includes('thorn')) {
      ctx.fillStyle = active ? '#315348' : '#334941';
      ctx.fillRect(x, y + h - 5, w, 5);
      const count = Math.max(1, Math.ceil(w / 12));
      for (let i = 0; i < count; i++) {
        const left = x + i * (w / count);
        const height = active ? h - 2 : 4;
        polygon(ctx, [[left, y + h - 4], [left + w / count / 2, y + h - height], [left + w / count, y + h - 4]], active ? (i % 2 ? '#ce765a' : '#db9471') : '#53675b');
      }
    } else if (type.includes('electric') || type.includes('shock')) {
      ctx.fillStyle = active ? 'rgba(52,91,103,.72)' : 'rgba(48,65,70,.52)';
      ctx.fillRect(x, y, w, h);
      if (active) {
        for (let px = x + 7; px < x + w - 7; px += 17) {
          line(ctx, [[px, y + 3], [px + 6, y + h * .4], [px + 1, y + h * .66], [px + 10, y + h - 2]], '#e9db86', 2.5);
        }
      }
    } else if (type.includes('fire') || type.includes('lava')) {
      ctx.fillStyle = active ? 'rgba(194,82,53,.7)' : 'rgba(95,65,59,.58)';
      ctx.fillRect(x, y, w, h);
      if (active) {
        for (let px = x + 4; px < x + w; px += 17) {
          polygon(ctx, [[px, y + h], [px + 3, y + 2 + Math.sin(tick * .08 + px) * 4], [px + 9, y + h]], '#f9bf69');
        }
      }
    } else {
      ctx.fillStyle = 'rgba(53,47,47,.72)';
      ctx.fillRect(x, y + h - 6, w, 6);
      const count = Math.max(1, Math.ceil(w / 17));
      for (let i = 0; i < count; i++) {
        const left = x + i * (w / count);
        polygon(ctx, [[left, y + h - 5], [left + w / count / 2, active ? y + 2 : y + h - 9], [left + w / count, y + h - 5]], active ? (theme === 'city' ? '#f1b174' : '#d77d61') : '#61706a');
      }
    }
    ctx.restore();
  }
}

function fallingColors(kind) {
  switch (kind) {
    case 'pinecone': return { outer: '#5e493c', face: '#b58861', warning: '#ffe0a1', trail: '#dcc7a4' };
    case 'debris': return { outer: '#46575b', face: '#aabbb5', warning: '#ffd5a1', trail: '#c8dfda' };
    case 'hail': return { outer: '#679eaa', face: '#effffa', warning: '#d4fff4', trail: '#d6f5f4' };
    default: return { outer: '#755949', face: '#e1b78a', warning: '#ffe1b2', trail: '#e5caa5' };
  }
}

function drawFallingWarning(ctx, falling, tick, reducedMotion, worldWidth) {
  if (!falling || (falling.phase !== 'warning' && falling.phase !== 'falling')) return;
  const x = clamp(number(falling.x), 12, worldWidth - 12);
  const y = clamp(number(falling.impactY), 18, H - 12);
  const colors = fallingColors(falling.kind);
  const warningTicks = Math.max(1, number(falling.warningTicks, 40));
  const urgency = falling.phase === 'falling' ? 1
    : clamp(1 - number(falling.ticksUntilImpact, warningTicks) / (warningTicks + 30), 0, 1);
  const pulse = reducedMotion ? 0 : Math.sin(tick * .25) * 2;
  const radius = 19 + urgency * 7 + pulse;
  ctx.save();
  ctx.globalAlpha = .58 + urgency * .34;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.strokeStyle = colors.warning;
  ctx.lineWidth = 2.6;
  ctx.stroke();
  for (const side of [-1, 1]) {
    line(ctx, [[x + side * (radius + 5), y - 6], [x + side * (radius + 5), y + 6]], colors.warning, 2.1);
  }
  line(ctx, [[x - 6, y], [x + 6, y]], colors.warning, 2.1);
  ctx.restore();
}

function drawFallingObject(ctx, falling, tick, reducedMotion) {
  if (!falling || falling.phase !== 'falling') return;
  const x = number(falling.x);
  const y = number(falling.y);
  const radius = clamp(number(falling.radius, 8), 5, 14);
  if (y < -radius * 2 || y > H + radius * 2) return;
  const colors = fallingColors(falling.kind);
  if (!reducedMotion) {
    ctx.save();
    ctx.globalAlpha = .52;
    line(ctx, [[x, y - radius], [x - 2, y - radius - 24]], colors.trail, 3.3);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(reducedMotion ? 0 : tick * .12 + number(falling.index) * .7);
  if (falling.kind === 'hail') {
    ellipse(ctx, 0, 0, radius, radius * 1.12, colors.outer);
    ellipse(ctx, -1, -2, radius * .75, radius * .8, colors.face);
    line(ctx, [[-radius * .55, -radius * .35], [0, -radius * .7]], '#ffffff', 1.7);
  } else if (falling.kind === 'pinecone') {
    ellipse(ctx, 0, 0, radius * .82, radius * 1.2, colors.outer);
    for (let row = -1; row <= 1; row++) {
      polygon(ctx, [[-radius * .5, row * radius * .55], [0, (row + .55) * radius * .55],
        [radius * .5, row * radius * .55], [0, (row - .45) * radius * .55]], colors.face);
    }
  } else {
    polygon(ctx, [[-radius, -radius * .6], [-radius * .2, -radius], [radius * .8, -radius * .56],
      [radius, radius * .32], [radius * .1, radius], [-radius * .86, radius * .45]], colors.outer);
    polygon(ctx, [[-radius * .5, -radius * .52], [radius * .2, -radius * .7],
      [radius * .68, 0], [-radius * .1, radius * .48]], colors.face);
  }
  ctx.restore();
}

function drawSpear(ctx, projectile, reducedMotion) {
  if (projectile?.kind !== 'spear') return;
  const x = number(projectile.x);
  const y = number(projectile.y);
  const angle = Math.atan2(number(projectile.vy), number(projectile.vx, 1));
  const friendly = projectile.team === 0;
  const tip = friendly ? '#e5fff1' : '#fff0c6';
  const shaft = friendly ? '#7dd2bd' : '#d79a70';
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (!reducedMotion) {
    ctx.globalAlpha = .56;
    line(ctx, [[-49, 0], [-28, 0]], shaft, 3.2);
    line(ctx, [[-39, -5], [-25, -2]], tip, 1.6);
    ctx.globalAlpha = 1;
  }
  line(ctx, [[-23, 0], [13, 0]], '#473e3c', 6.5);
  line(ctx, [[-22, -1], [13, -1]], shaft, 3.5);
  polygon(ctx, [[11, -7], [26, 0], [11, 7], [15, 0]], tip);
  line(ctx, [[-22, -6], [-22, 6]], tip, 2.6);
  ctx.restore();
}

function aimedSpearPreview(origin, flight, groundY, worldWidth) {
  const points = [[origin.x, origin.y]];
  const ground = groundY - SPEAR_RADIUS;
  let previous = origin;
  // The projectile advances in whole combat ticks. Sampling the same flight
  // makes the guide agree with its launch velocity and discrete gravity.
  for (let tick = 1; tick <= SPEAR_PREVIEW_TICKS; tick++) {
    const next = spearTrajectoryPoint(origin.x, origin.y, flight, tick);
    let fraction = 1;
    let stop = null;
    if (next.x > worldWidth && previous.x <= worldWidth) {
      fraction = (worldWidth - previous.x) / (next.x - previous.x);
      stop = 'edge';
    } else if (next.x < 0 && previous.x >= 0) {
      fraction = (0 - previous.x) / (next.x - previous.x);
      stop = 'edge';
    }
    if (next.y >= ground && next.y > previous.y && previous.y < ground) {
      const groundFraction = (ground - previous.y) / (next.y - previous.y);
      if (groundFraction <= fraction) {
        fraction = groundFraction;
        stop = 'ground';
      }
    }
    // The combat engine removes a spear that leaves the sky bounds, too.
    if (next.y < -80 && previous.y >= -80) {
      const skyFraction = (-80 - previous.y) / (next.y - previous.y);
      if (skyFraction <= fraction) {
        fraction = skyFraction;
        stop = 'edge';
      }
    }
    const point = stop ? {
      x: previous.x + (next.x - previous.x) * fraction,
      y: previous.y + (next.y - previous.y) * fraction,
    } : next;
    points.push([point.x, point.y]);
    if (stop) return { points, endpoint: point, stop };
    previous = next;
  }
  return { points, endpoint: previous, stop: 'limit' };
}

function drawAimedSpearMarker(ctx, preview, cameraX, tick, reducedMotion, color) {
  const { endpoint, stop } = preview;
  const markerX = clamp(endpoint.x, cameraX + 25, cameraX + W - 25);
  const markerY = clamp(endpoint.y, 108, H - 25);
  const outsideView = Math.abs(endpoint.x - markerX) > .01;
  const markerRadius = 8 + (reducedMotion ? 0 : Math.sin(tick * .18) * 1.2);
  ctx.save();
  ctx.beginPath();
  if (outsideView) {
    const direction = endpoint.x > markerX ? 1 : -1;
    ctx.moveTo(markerX - direction * 8, markerY - 7);
    ctx.lineTo(markerX, markerY);
    ctx.lineTo(markerX - direction * 8, markerY + 7);
  } else {
    ctx.arc(markerX, markerY, markerRadius, 0, TAU);
  }
  ctx.strokeStyle = 'rgba(12, 25, 27, .88)';
  ctx.lineWidth = 4.4;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  const label = stop === 'edge' ? '飞出场地' : outsideView ? '参考落点在画面外' : '参考落点';
  const labelWidth = outsideView ? 128 : 78;
  const labelX = clamp(markerX, cameraX + labelWidth / 2 + 8,
    cameraX + W - labelWidth / 2 - 8);
  const labelY = markerY > 145 ? markerY - 29 : markerY + 26;
  ctx.fillStyle = 'rgba(12, 25, 27, .84)';
  ctx.fillRect(labelX - labelWidth / 2, labelY - 11, labelWidth, 21);
  ctx.fillStyle = '#effff4';
  ctx.font = '700 12px "Microsoft YaHei UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, labelX, labelY + 4);
  ctx.restore();
}

function drawSpearWindup(ctx, fighter, tick, reducedMotion, groundY, cameraX, worldWidth) {
  const windup = number(fighter?.spearWindup);
  const aiming = fighter?.team === 0 && fighter?.spearAiming === true;
  if (number(fighter?.hp, 100) <= 0 || (!aiming && windup <= 0)) return;
  const committed = fighter.team === 0 && windup > 0
    && (fighter.spearLaunchFacing === -1 || fighter.spearLaunchFacing === 1);
  const chosenFlight = aiming || committed;
  const facing = number(committed ? fighter.spearLaunchFacing : fighter.facing, 1) < 0 ? -1 : 1;
  const origin = spearOrigin({
    ...fighter,
    x: number(fighter.x), y: number(fighter.y),
    width: number(fighter.width, fighter.kind === 'boss' ? 44 : 29),
    height: number(fighter.height, fighter.kind === 'boss' ? 136 : 88),
  }, facing);
  const { x, y } = origin;
  const aimAngle = clamp(number(fighter.spearAimAngle, 42), SPEAR_MIN_ANGLE, SPEAR_MAX_ANGLE);
  const flight = chosenFlight
    ? spearAimedFlight(facing, aimAngle)
    : spearFlight(x, y, number(fighter.spearAimX, x + facing * 120),
      number(fighter.spearAimY, y));
  const preview = chosenFlight ? aimedSpearPreview(origin, flight, groundY, worldWidth) : null;
  const angle = Math.atan2(flight.vy + SPEAR_GRAVITY, flight.vx || facing);
  const charge = aiming ? 0 : clamp(1 - windup / SPEAR_WINDUP_TICKS, 0, 1);
  const color = fighter.team === 0 ? '#b4f7da' : '#ffca92';
  ctx.save();
  ctx.globalAlpha = aiming ? .78 : .26 + charge * .3;
  if (!reducedMotion && !committed) ctx.setLineDash([6, 7]);
  ctx.beginPath();
  if (preview) {
    preview.points.forEach(([pointX, pointY], index) => {
      if (index === 0) ctx.moveTo(pointX, pointY);
      else ctx.lineTo(pointX, pointY);
    });
  } else {
    // Enemy warnings keep their previously locked target and shared solver.
    const segments = reducedMotion ? 7 : 15;
    for (let index = 0; index <= segments; index++) {
      const point = spearTrajectoryPoint(x, y, flight, flight.ticks * index / segments);
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
  }
  if (chosenFlight) {
    // A dark keyline keeps the guide readable over both photos and painted sky.
    ctx.strokeStyle = 'rgba(12, 25, 27, .88)';
    ctx.lineWidth = 5.2;
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = chosenFlight ? (reducedMotion ? 2.5 : 2.3) : reducedMotion ? 2.2 : 1.8;
  ctx.stroke();
  ctx.restore();
  if (chosenFlight) {
    drawAimedSpearMarker(ctx, preview, cameraX, tick, reducedMotion, color);
    const label = aiming ? `仰角 ${Math.round(aimAngle)}°` : `锁定 ${Math.round(aimAngle)}°`;
    const labelWidth = 88;
    const labelX = clamp(x - labelWidth / 2, cameraX + 8, cameraX + W - labelWidth - 8);
    const labelY = clamp(y - 49, 104, H - 35);
    ctx.save();
    ctx.fillStyle = 'rgba(12, 25, 27, .84)';
    ctx.fillRect(labelX, labelY, labelWidth, 24);
    ctx.fillStyle = '#effff4';
    ctx.font = '700 12px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, labelX + labelWidth / 2, labelY + 16);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  line(ctx, [[-27, 0], [11, 0]], '#54443c', 5.6);
  line(ctx, [[-25, -1], [12, -1]], color, 2.8);
  polygon(ctx, [[11, -6], [23, 0], [11, 6]], '#fff1d5');
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, 11 + (reducedMotion ? 0 : Math.sin(tick * .23) * 1.8), 0, TAU);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8 + charge;
  ctx.stroke();
}

function bone(ctx, joints, outline, core, width = 8) {
  line(ctx, joints, outline, width + 3);
  line(ctx, joints, core, width);
}

function drawWholeTomato(ctx, x, y, tilt) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ellipse(ctx, 0, 1, 17, 15, '#702d2a');
  ellipse(ctx, -2, -1, 14.5, 12.5, '#d6533d');
  ellipse(ctx, 7, 4, 5, 3.5, '#a83f33', -.4);
  ellipse(ctx, -8, -5, 4, 2.2, '#ed9b74', -.5);
  // An uneven calyx and bruised skin keep it a rotten tomato, not a red ball.
  polygon(ctx, [[-13, -11], [-6, -14], [-3, -10], [0, -17], [4, -11],
    [12, -13], [7, -7], [1, -9], [-7, -7]], '#4f7850');
  line(ctx, [[0, -11], [2, -19], [6, -20]], '#315543', 2.7);
  ctx.restore();
}

function drawTomatoOnHead(ctx, head, knockout, time, reducedMotion, crownLift = 0) {
  const elapsed = Math.max(0, time - knockout.born);
  if (elapsed >= TOMATO_LIFE_MS) return;
  const [x, y] = head;
  // A wanderer's broad hat catches the tomato above the scalp; every other
  // fighter keeps the existing bare-head impact point.
  const crown = y - HEAD_RADIUS - crownLift;
  if (elapsed < TOMATO_DROP_MS) {
    const fall = reducedMotion ? 1 : (elapsed / TOMATO_DROP_MS) ** 2.3;
    const tomatoY = crown - 16 - (1 - fall) * 115;
    if (!reducedMotion) {
      ctx.save();
      ctx.globalAlpha *= .15 + fall * .2;
      ellipse(ctx, x, crown + 1, 7 + 11 * fall, 2.5, '#613b36');
      if (fall > .32) {
        line(ctx, [[x - 8, tomatoY - 19], [x - 10, tomatoY - 34]], '#ed9b74', 1.8);
        line(ctx, [[x + 7, tomatoY - 14], [x + 7, tomatoY - 25]], '#b4513b', 2.2);
      }
      ctx.restore();
    }
    drawWholeTomato(ctx, x, tomatoY, -.16 + fall * .19);
    return;
  }

  const age = elapsed - TOMATO_DROP_MS;
  const fade = clamp((TOMATO_LIFE_MS - elapsed) / 300, 0, 1);
  ctx.save();
  ctx.globalAlpha *= fade;
  // Keep the impact locked to the sound cue at 180ms. The peel flattens first,
  // rebounds once, then gives way to a small stain that follows the KO head.
  if (!reducedMotion && age < TOMATO_CRUSH_MS + 35) {
    const crush = clamp(age / 65, 0, 1);
    const rebound = age > 65 ? Math.sin(clamp((age - 65) / 60, 0, 1) * Math.PI) : 0;
    ctx.save();
    ctx.globalAlpha *= 1 - clamp((age - TOMATO_CRUSH_MS + 10) / 45, 0, 1);
    ctx.translate(x, crown - 16 + 14 * crush - 2 * rebound);
    ctx.scale(1 + .64 * crush - .11 * rebound, 1 - .63 * crush + .13 * rebound);
    drawWholeTomato(ctx, 0, 0, .03 + crush * .08);
    ctx.restore();
  }
  const stain = reducedMotion ? 1 : clamp((age - 28) / 95, 0, 1);
  if (stain > 0) {
    ctx.save();
    ctx.globalAlpha *= stain;
    ctx.beginPath();
    ctx.moveTo(x - 29, crown + 1);
    ctx.bezierCurveTo(x - 34, crown - 8, x - 16, crown - 8, x - 9, crown - 5);
    ctx.bezierCurveTo(x + 5, crown - 12, x + 20, crown - 7, x + 29, crown + 2);
    ctx.bezierCurveTo(x + 18, crown + 9, x - 19, crown + 9, x - 29, crown + 1);
    ctx.fillStyle = '#702d2a';
    ctx.fill();
    ellipse(ctx, x - 2, crown - 2, 24, 6.5, '#b14938');
    polygon(ctx, [[x - 28, crown + 1], [x - 33, crown - 2], [x - 26, crown + 7],
      [x - 15, crown + 4], [x + 12, crown + 5], [x + 30, crown + 6],
      [x + 23, crown - 3], [x + 14, crown - 5]], '#a83f33');
    // Uneven pulp, seeds and torn calyx stay above the eyes and away from the mouth.
    ellipse(ctx, x - 11, crown + 10, 6, 4, '#a83f33', -.35);
    ellipse(ctx, x + 12, crown + 7, 5, 3.5, '#d6533d', .42);
    line(ctx, [[x + 15, crown + 10], [x + 16, crown + 17]], '#a83f33', 2.3);
    for (const [sx, sy] of [[-16, -4], [-1, -7], [10, -3]]) {
      ellipse(ctx, x + sx, crown + sy, 1.6, 1, '#e4b27c', -.25);
    }
    polygon(ctx, [[x - 8, crown - 7], [x + 1, crown - 14], [x + 5, crown - 7],
      [x + 15, crown - 10], [x + 9, crown - 3], [x - 5, crown - 4]], '#4f7850');
    ctx.restore();
  }
  ctx.restore();
}

function drawTomatoBurst(ctx, knockout, time, reducedMotion) {
  const age = time - knockout.born - TOMATO_DROP_MS;
  if (age < 0 || age > TOMATO_SPLASH_MS) return;
  const seconds = reducedMotion ? 0 : age / 1000;
  const count = reducedMotion ? 3 : 12;
  ctx.save();
  ctx.globalAlpha *= 1 - age / TOMATO_SPLASH_MS;
  if (!reducedMotion && age < 290) {
    ctx.save();
    ctx.globalAlpha *= .72 * (1 - age / 290);
    const reach = 20 + 32 * clamp(age / 180, 0, 1);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(knockout.impactX + side * 6, knockout.impactY);
      ctx.bezierCurveTo(knockout.impactX + side * 19, knockout.impactY - 13,
        knockout.impactX + side * (reach - 7), knockout.impactY - 30,
        knockout.impactX + side * reach, knockout.impactY - 17);
      ctx.strokeStyle = '#b4513b';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }
  for (let i = 0; i < count; i++) {
    const spread = i - (count - 1) / 2;
    const jitter = hash(i * 17 + knockout.seed) - .5;
    const velocityX = spread * 28 + jitter * 24;
    const velocityY = -115 - hash(i * 11 + knockout.seed) * 80;
    const px = knockout.impactX + spread * 1.7 + velocityX * seconds;
    const py = knockout.impactY - 2 + velocityY * seconds + 620 * seconds * seconds;
    ellipse(ctx, px, py, i % 3 === 0 ? 4 : 2.5, i % 3 === 0 ? 3.1 : 2.3,
      i % 4 === 0 ? '#d6533d' : '#a83f33');
  }
  if (!reducedMotion && age < 410) {
    for (let i = 0; i < 3; i++) {
      const side = i - 1;
      const px = knockout.impactX + side * (8 + 112 * seconds);
      const py = knockout.impactY - (130 + i * 19) * seconds + 540 * seconds * seconds;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(side * seconds * 3.6);
      polygon(ctx, [[-5, -3], [3, -5], [6, 0], [2, 4], [-6, 3]], '#8f3a30');
      ellipse(ctx, 0, -1, 2.8, 1.6, '#d76b4c');
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawBossWindup(ctx, { hand, head, tick, attackTick, activeFrom, stage, bob, reducedMotion }) {
  const charge = clamp((attackTick + 1) / activeFrom, 0, 1);
  const pulse = reducedMotion ? 0 : Math.sin(tick * .65) * .055;
  const intensity = clamp(.38 + charge * .48 + pulse, .3, .95);
  const signal = stage === 3 ? '#f59b77' : '#ffd09a';
  ctx.save();

  // Warm power gathers at the actual fist, never across the whole stage. The
  // existing warning above the head remains the primary dodge instruction.
  if (!reducedMotion) {
    const focus = ctx.createRadialGradient(hand[0], hand[1], 2,
      hand[0], hand[1], 30 + charge * 7);
    focus.addColorStop(0, 'rgba(255,241,199,.55)');
    focus.addColorStop(1, 'rgba(255,208,154,0)');
    ctx.globalAlpha = .16 + charge * .24;
    ellipse(ctx, hand[0], hand[1], 30 + charge * 7, 30 + charge * 7, focus);
  }

  // The raised warning mark stays readable against all four landscapes. Its
  // opacity and the fist arc fill across the exact non-damaging windup ticks.
  const markX = head[0];
  const markY = head[1] - 40;
  const triangle = [[markX, markY - 15], [markX + 17, markY + 13], [markX - 17, markY + 13]];
  ctx.globalAlpha = intensity;
  polygon(ctx, triangle, '#313b3d');
  const inset = [[markX, markY - 9], [markX + 11, markY + 9], [markX - 11, markY + 9]];
  polygon(ctx, inset, signal);
  line(ctx, [[markX, markY - 2], [markX, markY + 3]], '#423b38', 3);
  ellipse(ctx, markX, markY + 6.5, 1.6, 1.6, '#423b38');

  const radius = 12 + charge * 15;
  ctx.beginPath();
  ctx.arc(hand[0], hand[1], radius, -Math.PI / 2, -Math.PI / 2 + TAU * charge);
  ctx.strokeStyle = signal;
  ctx.lineWidth = 2.5 + charge * 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(hand[0], hand[1], radius + 7, -.95, -.95 + 1.7 * charge);
  ctx.strokeStyle = '#fff0c3';
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ellipse(ctx, hand[0], hand[1], 7 + charge * 4, 7 + charge * 4, stage === 3 ? 'rgba(242,112,83,.42)' : 'rgba(255,198,132,.36)');

  if (!reducedMotion) {
    ctx.globalAlpha = .28 + charge * .32;
    for (let i = 0; i < 3; i++) {
      const a = -1.1 + i * 1.05;
      const near = radius + 12 + i * 2;
      line(ctx, [[hand[0] + Math.cos(a) * near, hand[1] + Math.sin(a) * near],
        [hand[0] + Math.cos(a) * (near + 5), hand[1] + Math.sin(a) * (near + 5)]],
      '#ffe8b5', 1.4);
    }
  }

  // The winding air trail warns of reach without reading as a projectile.
  ctx.globalAlpha = .15 + charge * .38;
  ctx.setLineDash([6, 5]);
  line(ctx, [[29, -55 - bob], [58 + stage * 5, -55 - bob]], signal, 2);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(60 + stage * 5, -55 - bob, 7, -.9, .9);
  ctx.strokeStyle = signal;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawPunchWind(ctx, hand, strike, stage, attackTick, index, reducedMotion, boss) {
  const [x, y] = hand;
  // Boss art is enlarged from the feet; convert its physical reach back into
  // local pose space so the gust never promises a hit far beyond the hitbox.
  const end = strike.reach / (boss ? 1.28 : 1) + 9 + stage * 2;
  const span = Math.max(24, end - x);
  const spread = (12 + stage * 2) * (boss ? 1.12 : 1);
  const accent = boss ? '#ef8c72' : index ? '#ec7d6a' : '#f5b66d';
  const core = boss ? '#ffeddb' : index ? '#fff0e7' : '#fff8e8';
  const inTick = attackTick - strike.activeFrom + 1;
  const outTick = strike.activeTo - attackTick + 1;
  const crest = Math.min(1, inTick / 2, outTick / 2);
  const gust = ctx.createLinearGradient(x - 15, y, end, y);
  gust.addColorStop(0, boss || index ? 'rgba(236,125,106,0)' : 'rgba(245,182,109,0)');
  gust.addColorStop(.55, boss || index ? 'rgba(236,125,106,.34)' : 'rgba(245,182,109,.34)');
  gust.addColorStop(1, boss || index ? 'rgba(255,227,206,.09)' : 'rgba(255,248,219,.09)');
  ctx.save();
  ctx.globalAlpha = reducedMotion ? .86 : .62 + crest * .34;
  ctx.lineCap = 'round';
  // Open, curved wake lines turn around the fist; no filled wedge or point
  // can be confused with the former flying arrow.
  ctx.beginPath();
  ctx.moveTo(x - 13, y - spread * .65);
  ctx.bezierCurveTo(x + span * .14, y - spread * 1.8,
    x + span * .73, y - spread * 1.35, end, y - 3);
  ctx.strokeStyle = gust;
  ctx.lineWidth = 9 + stage * 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 10, y - spread * .72);
  ctx.bezierCurveTo(x + span * .2, y - spread * 1.45,
    x + span * .7, y - spread * 1.2, end - 3, y - 5);
  ctx.strokeStyle = core;
  ctx.lineWidth = 2.7 + stage * .4;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 8, y + spread * .45);
  ctx.bezierCurveTo(x + span * .23, y + spread * 1.4,
    x + span * .75, y + spread * 1.13, end - 5, y + 4);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.4 + stage * .25;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(end - 9, y, 5 + stage, spread * .78, 0, -.91, .91);
  ctx.strokeStyle = core;
  ctx.lineWidth = 2;
  ctx.stroke();
  if (!reducedMotion) {
    ctx.globalAlpha *= .72;
    for (let i = 0; i < Math.min(stage + 1, 3); i++) {
      const offset = 6 + i * 8;
      ctx.beginPath();
      ctx.moveTo(x - 26 - i * 5, y - spread - offset);
      ctx.bezierCurveTo(x + span * .1, y - spread - offset * 1.5,
        x + span * .55, y - spread - offset * .9, end - 16 - i * 5, y - spread * .53);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function kickExtension(kick, kickTick) {
  if (!kick) return 0;
  if (kickTick < kick.activeFrom) return clamp((kickTick - kick.activeFrom + 3) / 3, 0, 1) * .34;
  if (kickTick <= kick.activeTo) return 1;
  return clamp(1 - (kickTick - kick.activeTo) / (kick.duration - kick.activeTo), 0, 1);
}

function drawKickEnergy(ctx, foot, kick, kickTick, active, airborne, index, reducedMotion) {
  const accent = airborne ? (index ? '#ffad8b' : '#8de9df') : (index ? '#ffb296' : '#ffe0a3');
  const core = airborne ? '#f7fff0' : '#fff4d6';
  const [x, y] = foot;
  ctx.save();
  if (!active) {
    if (airborne && kickTick > 0 && kickTick < kick.activeFrom) {
      const charge = clamp(kickTick / kick.activeFrom, 0, 1);
      ctx.globalAlpha = reducedMotion ? .33 : .2 + charge * .28;
      ctx.beginPath();
      ctx.arc(x, y, 7 + charge * 11, 0, TAU);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (airborne) {
    // A jade crescent wraps the foot; the former long triangular wedge could
    // read as a projectile and obscure the attacker's thin stick silhouette.
    ctx.globalCompositeOperation = 'screen';
    if (!reducedMotion) {
      const focus = ctx.createRadialGradient(x + 4, y, 1, x + 4, y, 31);
      focus.addColorStop(0, index ? 'rgba(255,180,142,.58)' : 'rgba(224,255,231,.7)');
      focus.addColorStop(1, 'rgba(112,226,222,0)');
      ctx.globalAlpha = .46;
      ellipse(ctx, x + 4, y, 31, 27, focus);
    }
    ctx.globalAlpha = reducedMotion ? .78 : .9;
    ctx.beginPath();
    ctx.arc(x + 4, y, 17, -1.52, 1.1);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 24, -1.62, .92);
    ctx.strokeStyle = index ? '#ffe4c1' : '#f4e2ac';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (!reducedMotion) {
      ctx.beginPath();
      ctx.moveTo(x - 46, y - 18);
      ctx.bezierCurveTo(x - 24, y - 30, x + 2, y - 25, x + 19, y - 15);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 40, y + 17);
      ctx.bezierCurveTo(x - 17, y + 28, x + 4, y + 20, x + 19, y + 12);
      ctx.stroke();
    }
    ellipse(ctx, x + 4, y, 9, 8, core);
  } else {
    ctx.globalAlpha = .7;
    line(ctx, [[x - 25, y - 11], [x + 4, y - 6], [x + 13, y]], accent, 4);
    ellipse(ctx, x + 2, y, 6, 5, core);
  }
  ctx.restore();
}

function drawContactImpact(ctx, mark, time, reducedMotion) {
  const progress = clamp((time - mark.born) / mark.life, 0, 1);
  const calm = reducedMotion || mark.reducedMotion;
  const drift = calm ? 0 : (1 - (1 - progress) ** 2) * (mark.heavy ? 10 : 6);
  ctx.save();
  ctx.translate(mark.x + mark.facing * drift, mark.y);
  ctx.scale(mark.facing, 1);
  ctx.globalCompositeOperation = 'screen';
  if (!calm) {
    const radius = mark.heavy ? 33 : 25;
    const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, radius);
    glow.addColorStop(0, 'rgba(255,249,230,.46)');
    glow.addColorStop(1, 'rgba(255,249,230,0)');
    ctx.globalAlpha = (1 - progress) * .34;
    ellipse(ctx, 0, 0, radius, radius, glow);
  }

  // A short, curved calligraphic strike at the confirmed point of contact.
  // No part travels from the attacker like a projectile or extends the hitbox.
  ctx.globalAlpha = (1 - progress) * (mark.heavy ? .98 : .87);
  ctx.beginPath();
  ctx.moveTo(-11, -12);
  ctx.bezierCurveTo(1, -20, 16, -16, 22, -5);
  ctx.strokeStyle = '#26383c';
  ctx.lineWidth = mark.heavy ? 9 : 7;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.strokeStyle = '#fff9e9';
  ctx.lineWidth = mark.heavy ? 5 : 3.6;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-8, 11);
  ctx.bezierCurveTo(4, 16, 16, 10, 20, 4);
  ctx.strokeStyle = mark.accent;
  ctx.lineWidth = mark.heavy ? 3.4 : 2.4;
  ctx.stroke();
  if (!calm) {
    ctx.globalAlpha = (1 - progress) * .8;
    for (let i = 0; i < (mark.heavy ? 5 : 3); i++) {
      const y = (i - (mark.heavy ? 2 : 1)) * 10;
      const distance = 23 + i * 3 + progress * 9;
      line(ctx, [[distance, y], [distance + (mark.heavy ? 9 : 6), y - 4 + i]],
        i % 2 ? mark.accent : mark.tint, mark.heavy ? 2.1 : 1.6);
    }
  }
  ctx.restore();
}

function drawSpiritWave(ctx, item, progress, worldWidth, reducedMotion) {
  const calm = reducedMotion || item.calm;
  const crest = clamp(1 - progress / (calm ? .85 : .34), 0, 1);
  const radius = calm ? 74 : 18 + item.radius * (1 - (1 - progress) ** 2.4);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  // The cast still affects the whole wave at once. A quieter circular echo
  // explains hits behind the forward-facing beam without becoming the spell's
  // main silhouette or flashing a photograph-sized rectangle.
  ctx.globalAlpha = (1 - progress) * (calm ? .35 : .26);
  ctx.beginPath();
  ctx.arc(item.x, item.y, radius, 0, TAU);
  ctx.strokeStyle = '#72e4df';
  ctx.lineWidth = calm ? 3 : 3.5;
  ctx.stroke();
  ctx.strokeStyle = '#dffff8';
  ctx.lineWidth = calm ? 1.5 : 1.8;
  ctx.stroke();
  if (crest > 0) {
    ctx.globalAlpha = crest * (calm ? .4 : .45);
    ctx.beginPath();
    ctx.moveTo(item.x - 48, item.y - 8);
    ctx.bezierCurveTo(item.x - 22, item.y - 46,
      item.x + 20, item.y - 46, item.x + 48, item.y - 8);
    ctx.strokeStyle = item.tint;
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(item.x - 38, item.y + 22);
    ctx.bezierCurveTo(item.x - 15, item.y + 39,
      item.x + 18, item.y + 39, item.x + 40, item.y + 20);
    ctx.strokeStyle = '#baf5e5';
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  // The release point matches the two extended palms on the fighter. Mirror
  // one bounded world-space path instead of computing viewport coordinates:
  // camera scrolling cannot detach the beam or reverse its facing mid-cast.
  const originX = clamp(item.x + item.facing * 39, 0, worldWidth);
  const distance = item.facing > 0 ? worldWidth - originX : originX;
  const flight = calm ? 1 : clamp((progress - .09) / .45, 0, 1);
  const length = calm ? Math.min(distance, 380)
    : distance * (1 - (1 - flight) ** 2);
  const release = calm ? .66 : clamp(flight * 3.5, 0, 1);
  const fade = clamp((1 - progress) / (calm ? .65 : .29), 0, 1);
  ctx.translate(originX, item.y - 5);
  ctx.scale(item.facing, 1);
  if (!calm && crest > 0) {
    const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 42);
    glow.addColorStop(0, 'rgba(220,255,235,.42)');
    glow.addColorStop(1, 'rgba(116,238,227,0)');
    ctx.globalAlpha = crest * .46;
    ellipse(ctx, 0, 0, 42, 42, glow);
  }
  if (length > 4 && release > 0) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(length * .24, -2, length * .72, 2, length, 0);
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = release * fade * (calm ? .5 : .55);
    ctx.strokeStyle = '#173a42';
    ctx.lineWidth = calm ? 21 : 46;
    ctx.stroke();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = release * fade * (calm ? .62 : .75);
    ctx.strokeStyle = '#72e4df';
    ctx.lineWidth = calm ? 16 : 36;
    ctx.stroke();
    ctx.strokeStyle = '#baf5e5';
    ctx.lineWidth = calm ? 9 : 23;
    ctx.stroke();
    ctx.strokeStyle = '#fffdf0';
    ctx.lineWidth = calm ? 4 : 11;
    ctx.stroke();
    if (!calm && length > 70) {
      // A pair of fine ink-and-gold rails makes this a wuxia energy stroke,
      // not a flat rectangular laser. Only two short curves are drawn.
      ctx.globalAlpha = release * fade * .59;
      ctx.beginPath();
      ctx.moveTo(9, -23);
      ctx.bezierCurveTo(length * .24, -32, length * .69, -18, length * .88, -12);
      ctx.strokeStyle = item.tint;
      ctx.lineWidth = 2.3;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(11, 20);
      ctx.bezierCurveTo(length * .33, 29, length * .67, 18, length * .9, 11);
      ctx.strokeStyle = '#f2d8a6';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
    ctx.globalAlpha = release * fade * (calm ? .7 : .83);
    ellipse(ctx, length, 0, calm ? 8 : 19, calm ? 9 : 19, '#fffdf0');
    ctx.beginPath();
    ctx.arc(length, 0, calm ? 13 : 25, -.95, 1.15);
    ctx.strokeStyle = item.tint;
    ctx.lineWidth = calm ? 2 : 3;
    ctx.stroke();
  }
  // The release remains legible in the first charged frames, before its
  // advancing head has crossed the camera view.
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = fade * (calm ? .7 : .83);
  ellipse(ctx, 0, 0, calm ? 12 : 13 + crest * 4, calm ? 12 : 13 + crest * 4, '#e9fff0');
  if (!calm && crest > 0) {
    ctx.globalAlpha = crest * .8;
    ctx.beginPath();
    ctx.arc(0, 0, 24, -1.45, .2);
    ctx.strokeStyle = '#f2d8a6';
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }
  ctx.restore();
}

function drawSpiritHit(ctx, item, progress, reducedMotion) {
  const calm = reducedMotion || item.calm;
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.scale(item.facing, 1);
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = (1 - progress) * .84;
  const radius = calm ? 17 : 12 + progress * 13;
  ctx.beginPath();
  ctx.arc(0, 0, radius, -1.4, 1.15);
  ctx.strokeStyle = '#e4fff3';
  ctx.lineWidth = calm ? 2.4 : 3.4 - progress;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-9, -18);
  ctx.bezierCurveTo(2, -22, 11, -15, 16, -7);
  ctx.strokeStyle = calm ? '#baf5e5' : item.tint;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function expressionFor(fighter, state, meta) {
  if (number(fighter.hp, 100) <= 0) return 'sad';
  if (state.status === 'finished' && state.winner != null) {
    return state.winner === fighter.id ? 'happy' : 'sad';
  }
  if (meta.mode === 'campaign' && fighter.team === 0) {
    if (meta.campaignPhase === 'failed') return 'sad';
    if (['aftermath', 'cleared', 'completed'].includes(meta.campaignPhase)) return 'happy';
  }
  return number(fighter.attackStage) > 0 ? 'effort' : 'neutral';
}

function curvedMouth(ctx, x, y, edgeY, middleY, color) {
  ctx.beginPath();
  ctx.moveTo(x - 9, y + edgeY);
  ctx.bezierCurveTo(x - 4, y + middleY, x + 4, y + middleY, x + 9, y + edgeY);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawFace(ctx, head, expression, outline, accent, defeated, attackStage) {
  const [x, y] = head;
  ctx.save();
  if (expression === 'happy') {
    for (const eye of [-8, 8]) {
      ctx.beginPath();
      ctx.moveTo(x + eye - 4, y - 2);
      ctx.bezierCurveTo(x + eye - 2, y - 8, x + eye + 2, y - 8, x + eye + 4, y - 2);
      ctx.strokeStyle = outline;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    line(ctx, [[x - 12, y - 12], [x - 4, y - 14]], accent, 2);
    line(ctx, [[x + 4, y - 14], [x + 12, y - 12]], accent, 2);
    curvedMouth(ctx, x, y, 7, 14.5, outline);
    ellipse(ctx, x - 13, y + 4, 2, 1.5, accent);
    ellipse(ctx, x + 13, y + 4, 2, 1.5, accent);
  } else if (expression === 'sad') {
    line(ctx, [[x - 12, y - 12], [x - 5, y - 9]], accent, 2.2);
    line(ctx, [[x + 5, y - 9], [x + 12, y - 12]], accent, 2.2);
    if (defeated) {
      // Keep the familiar KO crosses, but let the mouth tell the losing emotion.
      for (const eye of [-8, 8]) {
        line(ctx, [[x + eye - 3, y - 4], [x + eye + 3, y + 2]], outline, 2.2);
        line(ctx, [[x + eye + 3, y - 4], [x + eye - 3, y + 2]], outline, 2.2);
      }
    } else {
      line(ctx, [[x - 12, y - 3], [x - 5, y + 1]], outline, 2.4);
      line(ctx, [[x + 5, y + 1], [x + 12, y - 3]], outline, 2.4);
    }
    curvedMouth(ctx, x, y, 13, 5, outline);
    ellipse(ctx, x + 13, y + 6, 1.8, 2.7, '#8dbec1');
  } else if (expression === 'effort') {
    const furrow = attackStage >= 2 ? 2 : 0;
    line(ctx, [[x - 12, y - 12], [x - 3, y - 7 + furrow]], accent, 2.7);
    line(ctx, [[x + 3, y - 7 + furrow], [x + 12, y - 12]], accent, 2.7);
    line(ctx, [[x - 12, y - 2], [x - 5, y - 4]], outline, 2.6);
    line(ctx, [[x + 5, y - 4], [x + 12, y - 2]], outline, 2.6);
    curvedMouth(ctx, x, y, 8, 8, outline);
    polygon(ctx, [[x - 8, y + 9], [x + 8, y + 9], [x + 7, y + 14], [x - 7, y + 14]], outline);
    polygon(ctx, [[x - 6, y + 10], [x + 6, y + 10], [x + 5, y + 12], [x - 5, y + 12]], '#fff6e5');
    line(ctx, [[x, y + 10], [x, y + 13]], outline, 1.2);
  } else {
    line(ctx, [[x + 2, y - 1], [x + 11, y - 3]], accent, 3);
    line(ctx, [[x - 10, y - 14], [x + 7, y - 16]], accent, 3);
  }
  ctx.restore();
}

function drawWandererCape(ctx, shoulder, fighter, facing, tick, reducedMotion, defeated, palette) {
  // A single fixed-step pose drives both layers of cloth. Running pulls the
  // red silhouette opposite travel, jumping lifts it, and existing friction
  // settles it; no new physics or network state is needed.
  const calm = reducedMotion || defeated;
  const localVelocity = calm ? 0 : clamp(number(fighter.vx) * facing, -8, 8);
  const airflow = calm ? 0 : clamp(Math.abs(number(fighter.vx)) / 5.4, 0, 1);
  const flutter = calm ? 0 : Math.sin(tick * .32) * airflow * 3.2;
  const ripple = calm ? 0 : Math.sin(tick * .32 + 1.6) * airflow * 2.4;
  const lift = calm || fighter.grounded !== false ? 0
    : clamp(4 - number(fighter.vy) * .75, 0, 13);
  const topX = shoulder[0] - 5;
  const topY = shoulder[1] + 3;
  const tailX = topX - 30 - localVelocity * 2.7 + flutter;
  const hemY = topY + 52 - lift + ripple;

  // A torn, asymmetric hem reads like the reference without widening hitboxes
  // or swallowing the legs. Limbs and attacks paint in front of this layer.
  ctx.beginPath();
  ctx.moveTo(topX - 5, topY);
  ctx.bezierCurveTo(topX - 19 - localVelocity * .3, topY + 11,
    tailX - 18, hemY - 24, tailX - 11, hemY - 7);
  ctx.lineTo(tailX - 2, hemY - 12 + flutter * .2);
  ctx.lineTo(tailX + 6, hemY - 2);
  ctx.lineTo(tailX + 12, hemY - 9);
  ctx.bezierCurveTo(tailX + 13, hemY - 21, topX + 9, topY + 20,
    topX + 7, topY + 2);
  ctx.closePath();
  ctx.fillStyle = palette.capeEdge;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(topX - 3, topY + 3);
  ctx.bezierCurveTo(topX - 15 - localVelocity * .25, topY + 17,
    tailX - 8, hemY - 22, tailX - 5, hemY - 9);
  ctx.lineTo(tailX + 3, hemY - 12);
  ctx.lineTo(tailX + 8, hemY - 8);
  ctx.bezierCurveTo(tailX + 6, hemY - 23,
    topX + 3, topY + 21, topX + 4, topY + 4);
  ctx.closePath();
  ctx.fillStyle = palette.cape;
  ctx.fill();
  line(ctx, [[topX + 1, topY + 8], [topX - 6, topY + 26],
    [tailX + 2, hemY - 17]], palette.fold, 1.4);

  // The scarf's loose ribbon is lighter and shorter than the cape. Its tip
  // follows the same airflow so it never floats independently when idle.
  const ribbonX = tailX - 11 - airflow * 6;
  const ribbonY = topY + 6 - lift * .35 + flutter * .8;
  ctx.beginPath();
  ctx.moveTo(topX + 4, topY + 1);
  ctx.bezierCurveTo(topX - 8, topY - 9, ribbonX + 16, ribbonY - 15,
    ribbonX, ribbonY - 3);
  ctx.lineTo(ribbonX + 7, ribbonY + 5);
  ctx.lineTo(ribbonX + 13, ribbonY + 2);
  ctx.bezierCurveTo(ribbonX + 13, ribbonY - 4, topX - 7, topY + 10,
    topX + 5, topY + 7);
  ctx.closePath();
  ctx.fillStyle = palette.scarf;
  ctx.fill();
  line(ctx, [[topX + 1, topY + 2], [topX - 13, topY + 2],
    [ribbonX + 11, ribbonY - 2]], palette.scarfLight, 1.2);
}

function drawWandererFace(ctx, head, expression, palette, defeated, attackStage) {
  const [x, y] = head;
  // No blur passes: a saturated underlay and crisp pale core make the eyes
  // shine at a 44px head size, including on a bright photo background.
  if (defeated) {
    for (const offset of [-9, 9]) {
      line(ctx, [[x + offset - 4, y - 5], [x + offset + 3, y + 1]],
        palette.eye, 2.2);
      line(ctx, [[x + offset + 3, y - 5], [x + offset - 4, y + 1]],
        palette.eyeAccent, 2.2);
    }
  } else {
    const outerY = expression === 'sad' ? y - 2 : expression === 'happy' ? y - 7 : y - 9;
    const innerY = expression === 'sad' ? y - 5 : expression === 'happy' ? y - 8 : y - 5;
    const eyeDepth = expression === 'effort' ? 3 : 5;
    for (const side of [-1, 1]) {
      const outer = x + side * 17;
      const middle = x + side * 10;
      const inner = x + side * 3;
      polygon(ctx, [[outer, outerY], [middle, innerY - 2],
        [inner, innerY], [middle, innerY + eyeDepth],
        [outer - side * 2, outerY + eyeDepth - 1]], palette.eyeAccent);
      polygon(ctx, [[outer - side * 2, outerY + 1], [middle, innerY],
        [inner + side, innerY + 1], [middle, innerY + eyeDepth - 1]],
      palette.eye);
    }
  }
  if (expression === 'happy' && !defeated) {
    line(ctx, [[x - 15, y - 13], [x - 4, y - 15]], palette.scarfLight, 1.5);
    line(ctx, [[x + 4, y - 15], [x + 15, y - 13]], palette.scarfLight, 1.5);
    curvedMouth(ctx, x, y, 5, 11, palette.eye);
  } else if (expression === 'sad' || defeated) {
    line(ctx, [[x - 14, y - 13], [x - 5, y - 9]], palette.eyeAccent, 1.6);
    line(ctx, [[x + 5, y - 9], [x + 14, y - 13]], palette.eyeAccent, 1.6);
    curvedMouth(ctx, x, y, 13, 5, palette.eye);
    ellipse(ctx, x + 15, y + 7, 1.8, 2.7, '#8dbec1');
  } else if (expression === 'effort') {
    const furrow = attackStage >= 2 ? 1 : 0;
    line(ctx, [[x - 17, y - 13], [x - 5, y - 8 + furrow]], palette.eyeAccent, 2);
    line(ctx, [[x + 5, y - 8 + furrow], [x + 17, y - 13]], palette.eyeAccent, 2);
    curvedMouth(ctx, x, y, 8, 8, palette.eye);
    polygon(ctx, [[x - 7, y + 9], [x + 7, y + 9],
      [x + 6, y + 12], [x - 6, y + 12]], '#fff6e5');
    line(ctx, [[x, y + 9], [x, y + 12]], WANDERER_FACE, 1);
  } else {
    line(ctx, [[x - 2, y + 10], [x + 6, y + 9]], palette.eye, 1.5);
  }
}

function drawWandererScarf(ctx, head, palette) {
  const [x, y] = head;
  // A short front wrap sits below the mouth; the separate back ribbon above
  // supplies movement without concealing eyes or the attack-facing hand.
  polygon(ctx, [[x - 19, y + 16], [x - 8, y + 17], [x + 6, y + 18],
    [x + 18, y + 14], [x + 15, y + 22], [x + 3, y + 25],
    [x - 9, y + 23], [x - 17, y + 21]], palette.scarf);
  polygon(ctx, [[x - 15, y + 17], [x - 2, y + 20], [x + 13, y + 19],
    [x + 5, y + 22], [x - 8, y + 21]], palette.scarfLight);
  polygon(ctx, [[x + 4, y + 22], [x + 13, y + 21],
    [x + 6, y + 30], [x - 1, y + 28]], palette.scarf);
}

function drawWandererHat(ctx, head) {
  const [x, y] = head;
  // Adapt the supplied ink-black straw hat: a low conical crown, imperfect
  // chipped edge, faint woven ribs and a cool rim; no baked-in image asset.
  // The lower edge remains above the eye slits and expression.
  const brimY = y - 16;
  ctx.beginPath();
  ctx.moveTo(x - 44, brimY - 3);
  ctx.lineTo(x - 36, brimY - 7);
  ctx.lineTo(x - 34, brimY - 14);
  ctx.lineTo(x - 28, brimY - 13);
  ctx.lineTo(x - 14, brimY - 26);
  ctx.lineTo(x + 2, brimY - 34);
  ctx.lineTo(x + 6, brimY - 41);
  ctx.lineTo(x + 9, brimY - 30);
  ctx.lineTo(x + 28, brimY - 14);
  ctx.lineTo(x + 42, brimY - 7);
  ctx.lineTo(x + 39, brimY - 3);
  ctx.lineTo(x + 45, brimY - 1);
  ctx.lineTo(x + 33, brimY - 1);
  ctx.lineTo(x + 29, brimY + 3);
  ctx.lineTo(x + 16, brimY + 1);
  ctx.lineTo(x + 13, brimY + 4);
  ctx.lineTo(x - 3, brimY + 2);
  ctx.lineTo(x - 23, brimY + 3);
  ctx.lineTo(x - 30, brimY - 1);
  ctx.lineTo(x - 38, brimY + 1);
  ctx.closePath();
  ctx.fillStyle = WANDERER_HAT.shadow;
  ctx.fill();
  polygon(ctx, [[x - 36, brimY - 7], [x + 4, brimY - 34],
    [x + 28, brimY - 13], [x + 38, brimY - 6],
    [x + 9, brimY - 4], [x - 31, brimY - 4]], WANDERER_HAT.crown);
  polygon(ctx, [[x + 5, brimY - 32], [x + 27, brimY - 12],
    [x + 33, brimY - 6], [x + 12, brimY - 8]], WANDERER_HAT.facet);
  ctx.save();
  ctx.globalAlpha *= .58;
  for (const rib of [-29, -13, 1, 15, 29]) {
    line(ctx, [[x + 4, brimY - 30], [x + rib, brimY - 6]], WANDERER_HAT.weave, .85);
  }
  for (const [height, span] of [[19, 15], [11, 27]]) {
    ctx.beginPath();
    ctx.moveTo(x - span, brimY - height);
    ctx.bezierCurveTo(x - span / 3, brimY - height + 4,
      x + span / 3, brimY - height + 4, x + span, brimY - height);
    ctx.strokeStyle = WANDERER_HAT.weave;
    ctx.lineWidth = .7;
    ctx.stroke();
  }
  ctx.restore();
  line(ctx, [[x - 40, brimY - 4], [x - 24, brimY - 1],
    [x - 6, brimY], [x + 13, brimY + 1], [x + 31, brimY - 2],
    [x + 42, brimY - 3]], WANDERER_HAT.rim, 1.55);
  line(ctx, [[x - 30, brimY - 9], [x - 10, brimY - 19]], WANDERER_HAT.rim, .9);
}

function drawFighter(ctx, fighter, index, groundY, tick, reducedMotion = false,
  knockout = null, time = 0, expression = 'neutral', corpsePose = null) {
  const x = number(fighter.x, index ? 684 : 284);
  const y = number(fighter.y, groundY);
  const vx = number(fighter.vx);
  const vy = number(fighter.vy);
  const grounded = fighter.grounded !== false;
  const facing = number(fighter.facing, index ? -1 : 1) < 0 ? -1 : 1;
  const dodge = number(fighter.dodgeTicks) > 0;
  const stun = number(fighter.stun) > 0;
  const attackStage = clamp(Math.floor(number(fighter.attackStage)), 0, 3);
  const attackTick = number(fighter.attackTick);
  const strike = attackStage ? attackOf({ kind: fighter.kind, attackStage }) : null;
  const attacking = Boolean(strike);
  const strikeActive = Boolean(strike && attackTick >= strike.activeFrom && attackTick <= strike.activeTo);
  const kick = kickOf(fighter);
  const kickTick = number(fighter.kickTick);
  const kicking = Boolean(kick);
  const airKick = fighter.kickType === 'air' && kicking;
  const kickActive = Boolean(kick && kickTick >= kick.activeFrom && kickTick <= kick.activeTo);
  const hit = number(fighter.hurtFlash) > 0;
  const boss = fighter.kind === 'boss';
  const wanderer = fighter.kind === 'hero';
  const wandererPalette = WANDERER_PALETTES[fighter.team === 1 ? 1 : 0];
  const figureScale = boss ? 1.28 : 1;
  const invulnerable = Boolean(fighter.invulnerable) || dodge;
  const defeated = number(fighter.hp, 100) <= 0;
  const spearing = (number(fighter.spearWindup) > 0 || fighter.spearAiming === true) && !defeated;
  const waveCasting = number(fighter.specialWaveTicks) > 19 && !defeated;
  const bossWindup = boss && attacking
    && attackTick < strike.activeFrom && !defeated;
  const core = hit ? '#fff9e8' : wanderer ? '#35454b'
    : boss ? '#e6c9b9' : index ? '#f5ddcf' : '#f5ecd7';
  const outline = wanderer ? WANDERER_FACE
    : boss ? '#482d34' : index ? '#663f41' : '#173b3b';
  const accent = wanderer ? wandererPalette.scarfLight
    : boss ? '#ef8c72' : index ? '#ec7d6a' : '#f5b66d';

  const altitude = clamp(groundY - y, 0, 180);
  ellipse(ctx, x, groundY + 6, Math.max(15, (boss ? 34 : 25) - altitude * .05),
    boss ? 6 : 5, `rgba(10,28,28,${Math.max(.09,.3 - altitude * .001)})`);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing * figureScale, figureScale);
  if (defeated) {
    const elapsed = knockout ? time - knockout.born : Infinity;
    const progress = corpsePose ? corpsePose.fallProgress : knockout
      ? reducedMotion ? Number(elapsed >= TOMATO_DROP_MS)
        : clamp((elapsed - TOMATO_DROP_MS) / TOMATO_FALL_MS, 0, 1)
      : 1;
    const fall = progress * progress * (3 - 2 * progress);
    ctx.translate(0, -6 * fall);
    ctx.rotate(-Math.PI * .46 * fall * (corpsePose?.fallDirection ?? 1));
  }

  const stride = grounded && !stun ? Math.sin(tick * .29 + index) * clamp(Math.abs(vx) / 3.2, 0, 1) : 0;
  const bob = grounded && !defeated ? Math.abs(stride) * 2 + Math.sin(tick * .065 + index) * 1.2 : 0;
  const lean = dodge ? 13 : waveCasting ? -4 : bossWindup ? -7 : airKick ? 11 : kicking ? -5
    : attacking ? 6 : stun ? -9 : clamp(vx * 1.05, -6, 6);
  const hip = [lean * .45, -36 - bob];
  const shoulder = [lean, -68 - bob];
  // Keep the crown near its old height while making the head unmistakably
  // larger than the slim, single-stroke body.
  const head = [lean + 1, -83 - bob];

  if (dodge) {
    ctx.save();
    ctx.globalAlpha = .27;
    line(ctx, [[-28, -11], [-25, -60], [-13, -84]], accent, 5);
    ellipse(ctx, -12, -84, 19, 19, accent);
    ctx.restore();
    for (let i = 0; i < 3; i++) line(ctx, [[-28 - i * 12, -45 + i * 12], [-56 - i * 10, -45 + i * 12]], 'rgba(249,226,181,.65)', 2 - i * .3);
  }

  if (wanderer) drawWandererCape(ctx, shoulder, fighter, facing, tick,
    reducedMotion, defeated, wandererPalette);

  const rearElbow = waveCasting ? [10 + lean * .4, -61 - bob]
    : kicking ? [-13 + lean * .5, -65 - bob] : [-13 + lean * .5, -55 - bob];
  const rearHand = waveCasting ? [31 + lean * .3, -49 - bob]
    : kicking ? [-8 + lean * .4, -75 - bob]
    : [-19 + lean * .42, attacking ? -36 - bob : -39 - bob];
  bone(ctx, [shoulder, rearElbow, rearHand], outline, core, 4.2);

  let kneeBack, footBack, kneeFront, footFront;
  if (kicking && !defeated) {
    const extension = kickExtension(kick, kickTick);
    kneeBack = airKick ? [-18, -22] : [-13, -20];
    footBack = airKick ? [-31, -30] : [-25, -2];
    kneeFront = [17 + extension * (airKick ? 25 : 20), -20 - extension * (airKick ? 7 : 12)];
    footFront = [airKick ? 27 + extension * (kick.reach - 27) : 22 + extension * (kick.reach - 25),
      (airKick ? -14 : -1) - extension * (airKick ? 24 : 38)];
  } else if (!grounded && !defeated) {
    kneeBack = [-17, -16]; footBack = [-24, -26 + clamp(vy * .8, -5, 7)];
    kneeFront = [15, -21]; footFront = [27, -14 - clamp(vy * .5, -4, 5)];
  } else if (dodge) {
    kneeBack = [-25, -18]; footBack = [-42, -3];
    kneeFront = [24, -22]; footFront = [40, -3];
  } else {
    kneeBack = [-12 - stride * 11, -18]; footBack = [-(boss ? 27 : 21) - stride * 18, -1 + Math.max(0, stride) * 5];
    kneeFront = [12 + stride * 11, -18]; footFront = [(boss ? 28 : 22) + stride * 18, -1 + Math.max(0, -stride) * 5];
  }
  bone(ctx, [hip, kneeBack, footBack], outline, core, 4.8);
  bone(ctx, [hip, kneeFront, footFront], outline, core, 4.8);
  if (kicking && !defeated) drawKickEnergy(ctx, footFront, kick, kickTick, kickActive, airKick, index, reducedMotion);
  bone(ctx, [hip, shoulder], outline, core, 4.8);
  if (wanderer) {
    // A hairline cyan edge separates the inky, still-thin frame from dark
    // forest/ocean photos without painting it into a broad armored body.
    ctx.save();
    ctx.globalAlpha *= hit ? 1 : .72;
    line(ctx, [[hip[0] + 2, hip[1] - 1], [shoulder[0] + 2, shoulder[1] + 2]],
      WANDERER_HAT.rim, 1.05);
    ctx.restore();
  }
  if (boss && !defeated) {
    // Broader shoulders and a split collar give the boss a powerful silhouette
    // while the torso and limbs remain unmistakably thin stick-figure strokes.
    line(ctx, [[shoulder[0] - 19, -69 - bob], [shoulder[0] - 2, -75 - bob],
      [shoulder[0] + 20, -69 - bob]], outline, 4.6);
    line(ctx, [[shoulder[0] - 15, -71 - bob], [shoulder[0] - 2, -75 - bob],
      [shoulder[0] + 16, -71 - bob]], accent, 1.6);
    line(ctx, [[hip[0] - 6, -52 - bob], [hip[0] + 6, -47 - bob]], accent, 1.8);
  }

  ctx.beginPath();
  ctx.arc(head[0], head[1], HEAD_RADIUS, 0, TAU);
  ctx.fillStyle = outline;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(head[0], head[1], HEAD_RADIUS - 4, 0, TAU);
  // Hurt flash brightens the rim and limbs, but the face stays dark enough for
  // both teams' pale eyes to remain readable for those few impact frames.
  ctx.fillStyle = wanderer ? hit ? '#314954' : '#15252e' : core;
  ctx.fill();
  if (wanderer) {
    ctx.beginPath();
    ctx.arc(head[0], head[1], HEAD_RADIUS - 1, Math.PI * .52, Math.PI * 1.42);
    ctx.strokeStyle = WANDERER_HAT.weave;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    drawWandererFace(ctx, head, defeated ? 'sad' : expression,
      wandererPalette, defeated, attackStage);
    drawWandererScarf(ctx, head, wandererPalette);
    drawWandererHat(ctx, head);
  } else {
    drawFace(ctx, head, defeated ? 'sad' : expression, outline, accent, defeated, attackStage);
  }
  if (defeated && knockout) drawTomatoOnHead(ctx, head, knockout, time,
    reducedMotion, wanderer ? 16 : 0);

  const recovery = attacking && attackTick > strike.activeTo
    ? clamp((attackTick - strike.activeTo) / (strike.duration - strike.activeTo), 0, 1) : 0;
  const reach = strikeActive ? 25 + 25 * clamp((attackTick - strike.activeFrom + 1) / 2, 0, 1)
    : recovery ? 50 - 28 * recovery : 12;
  const armHeight = attackStage === 2 ? -4 : attackStage === 3 ? 5 : 0;
  const frontElbow = waveCasting ? [22 + lean * .3, -63 - bob]
    : kicking ? [15 + lean * .3, -64 - bob]
    : spearing ? [14 + lean * .3, -68 - bob]
    : bossWindup ? [-3 + lean * .5, -72 - bob]
    : attacking ? [12 + reach * .23 + lean * .35, -68 - bob + armHeight * .5] : [15 + lean * .5, -55 - bob];
  const frontHand = waveCasting ? [41 + lean * .2, -50 - bob]
    : kicking ? [20 + lean * .25, -80 - bob]
    : spearing ? [26 + lean * .2, -65 - bob]
    : bossWindup ? [-12 + lean * .5, -57 - bob]
    : attacking ? [reach, -63 - bob + armHeight] : [22 + lean * .4, -39 - bob];
  bone(ctx, [shoulder, frontElbow, frontHand], outline, core, 4.4);
  if (wanderer) {
    ctx.save();
    ctx.globalAlpha *= hit ? 1 : .64;
    line(ctx, [[shoulder[0] + 3, shoulder[1] + 2],
      [frontElbow[0] + 2, frontElbow[1]], [frontHand[0] + 1, frontHand[1]]],
    WANDERER_HAT.rim, 1);
    ctx.restore();
  }
  ellipse(ctx, frontHand[0], frontHand[1], 4.4, 4.4, accent);
  ellipse(ctx, rearHand[0], rearHand[1], 3.8, 3.8, accent);

  if (bossWindup) {
    drawBossWindup(ctx, {
      hand: frontHand, head, tick, attackTick: number(fighter.attackTick),
      activeFrom: strike.activeFrom, stage: attackStage, bob, reducedMotion,
    });
  }
  if (strikeActive && !defeated) drawPunchWind(ctx, frontHand, strike, attackStage, attackTick, index, reducedMotion, boss);
  if (number(fighter.specialWaveTicks) > 0 && !defeated) {
    const pulse = reducedMotion ? 0 : Math.sin(tick * .4) * 2;
    ctx.save();
    ctx.globalAlpha = .18;
    ellipse(ctx, lean * .5, -48, 32 + pulse, 60 + pulse, '#8de9df');
    ctx.beginPath();
    ctx.ellipse(lean * .5, -48, 30 + pulse, 58 + pulse, 0, 0, TAU);
    ctx.strokeStyle = '#ddfff3';
    ctx.lineWidth = 3.1;
    ctx.stroke();
    ctx.restore();
  }
  if (invulnerable && !defeated) {
    ctx.save();
    ctx.setLineDash([5, 8]);
    ctx.lineDashOffset = -tick * .8;
    ctx.strokeStyle = 'rgba(222,247,218,.65)';
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.ellipse(lean * .5, -47, 26, 51, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  if (hit && !defeated) {
    ctx.save();
    ctx.globalAlpha = .28;
    ellipse(ctx, x, y - 48, 29, 52, '#fff5d4');
    ctx.restore();
  }
}

function corpseFallDirection(x, facing, kind, worldWidth) {
  // The head lies behind the feet. At an arena edge, tip inward instead of
  // leaving a three-second corpse (or its skull) outside the world.
  const reach = (83 + HEAD_RADIUS) * (kind === 'boss' ? 1.28 : 1);
  const naturalHeadX = x - facing * reach;
  return naturalHeadX < 10 || naturalHeadX > worldWidth - 10 ? -1 : 1;
}

function drawCampaignCorpse(ctx, corpse, knockout, groundY, motionTick, time, worldWidth, reducedMotion) {
  const born = number(corpse.bornTick, motionTick);
  const settle = Math.max(born + 1, number(corpse.settleTick, born + 27));
  const expire = Math.max(settle + 1, number(corpse.expireTick, settle + 180));
  if (motionTick >= expire) return;

  const restingX = clamp(number(corpse.x), 22, worldWidth - 22);
  const restingY = number(corpse.y, groundY);
  const koX = clamp(number(corpse.koX, restingX), 22, worldWidth - 22);
  const koY = number(corpse.koY, restingY);
  const dropTick = Math.min(settle, born + TOMATO_DROP_TICKS);
  const calm = Boolean(knockout?.reducedMotion ?? reducedMotion);
  const travel = calm ? Number(motionTick >= dropTick)
    : clamp((motionTick - born) / (settle - born), 0, 1);
  const smoothTravel = travel * travel * (3 - 2 * travel);
  const fallProgress = calm ? Number(motionTick >= dropTick)
    : dropTick === settle ? Number(motionTick >= settle)
      : clamp((motionTick - dropTick) / (settle - dropTick), 0, 1);
  const facing = number(corpse.facing, 1) < 0 ? -1 : 1;
  const pose = {
    ...corpse,
    x: koX + (restingX - koX) * smoothTravel,
    y: koY + (restingY - koY) * smoothTravel,
    hp: 0, vx: 0, vy: 0, grounded: true, stun: 0,
    dodgeTicks: 0, attackStage: 0, attackTick: 0,
    kickType: null, kickTick: 0, hurtFlash: 0, invulnerable: 0,
    spearAiming: false, spearWindup: 0, specialWaveTicks: 0,
  };
  ctx.save();
  ctx.globalAlpha *= clamp((expire - motionTick) / CORPSE_FADE_TICKS, 0, 1);
  drawFighter(ctx, pose, 1, restingY, motionTick, calm, knockout, time, 'sad', {
    fallProgress,
    fallDirection: corpseFallDirection(restingX, facing, corpse.kind, worldWidth),
  });
  ctx.restore();
}

function drawScatteredBones(ctx, burst, knockout, time, worldWidth, reducedMotion) {
  const progress = clamp((time - burst.born) / BONES_SCATTER_MS, 0, 1);
  const calm = burst.reducedMotion || reducedMotion;
  const scale = burst.kind === 'boss' ? 1.28 : 1;
  const facing = burst.facing < 0 ? -1 : 1;
  const fallDirection = corpseFallDirection(burst.x, facing, burst.kind, worldWidth);
  const axis = -facing * fallDirection;
  const outline = burst.kind === 'boss' ? '#482d34' : '#663f41';
  const core = burst.kind === 'boss' ? '#e6c9b9' : '#f5ddcf';
  const ease = 1 - (1 - progress) ** 2;
  const alpha = clamp((1 - progress) / .28, 0, 1);

  BONE_PARTS.forEach((part, index) => {
    const spread = calm ? 0 : (hash(burst.seed + index * 23) - .5) * 46 * ease;
    const hop = calm ? 0 : (7 + hash(burst.seed + index * 37) * 9) * Math.sin(progress * Math.PI);
    const x = clamp(burst.x + axis * part.along * scale + spread,
      22 * scale, worldWidth - 22 * scale);
    const y = burst.y - part.lift * scale - hop;
    const turn = calm ? 0 : (hash(burst.seed + index * 41) - .5) * .8 * ease;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x, y);
    ctx.rotate(part.tilt * axis + turn);
    if (part.kind === 'head') {
      ellipse(ctx, 0, 0, HEAD_RADIUS * scale, 20 * scale, outline);
      ellipse(ctx, 0, 0, (HEAD_RADIUS - 4) * scale, 16 * scale, core);
      ellipse(ctx, -6 * scale, -2 * scale, 2.6 * scale, 3 * scale, outline);
      ellipse(ctx, 6 * scale, -2 * scale, 2.6 * scale, 3 * scale, outline);
      line(ctx, [[-5 * scale, 8 * scale], [0, 10 * scale], [5 * scale, 8 * scale]],
        outline, 1.8 * scale);
      // The tomato's short-lived stain remains attached to the detached head;
      // scattering must not shorten (or extend) its original 1.08s lifespan.
      if (knockout) {
        ctx.save();
        ctx.scale(scale, scale);
        drawTomatoOnHead(ctx, [0, 0], knockout, time, calm);
        ctx.restore();
      }
    } else {
      const length = part.length * scale;
      bone(ctx, [[-length / 2, 0], [length / 2, 0]], outline, core, 3.2 * scale);
      ellipse(ctx, -length / 2, 0, 2.3 * scale, 2.3 * scale, core);
      ellipse(ctx, length / 2, 0, 2.3 * scale, 2.3 * scale, core);
    }
    ctx.restore();
  });
}

function drawAtmosphere(ctx, theme, tick, level) {
  // A quiet front layer integrates the figures with the background without
  // covering their silhouette or making the collision plane ambiguous.
  const vignette = ctx.createRadialGradient(W / 2, H / 2, 160, W / 2, H / 2, 620);
  vignette.addColorStop(0, 'rgba(8,27,28,0)');
  vignette.addColorStop(1, 'rgba(8,27,28,.25)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = .78;
  ctx.fillStyle = '#f7f0d8';
  ctx.font = '800 10px Bahnschrift, Arial, sans-serif';
  ctx.letterSpacing = '2px';
  const stage = Number.isFinite(Number(level)) ? ` / ${String(level).padStart(2, '0')}` : '';
  ctx.fillText(`${THEMES[theme].label}${stage}`, 28, H - 24);
  line(ctx, [[28, H - 40], [112, H - 40]], 'rgba(248,234,197,.72)', 2);
  ctx.restore();
}

export function createRenderer(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('createRenderer 需要有效的 Canvas 元素');
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');

  const particles = [];
  const rings = [];
  const impactMarks = [];
  const seenIds = new Set();
  const seenOrder = [];
  const recentAnonymous = new Map();
  const photoCache = new Map();
  const knockouts = new Map();
  const boneBursts = new Map();
  const scatteredTargets = new Set();
  const seenCorpseIds = new Set();
  let lastFighters = new Map();
  let lastTick = -1;
  let lastScene = '';
  let sceneTheme = 'forest';
  let worldWidth = W;
  let cameraX = 0;
  let cameraAt = 0;
  let shakeUntil = 0;
  let shakeStrength = 0;
  let pixelRatio = 0;
  const motionMedia = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reducedMotion = Boolean(motionMedia?.matches);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function scaleCanvas() {
    const next = clamp(number(globalThis.devicePixelRatio, 1), 1, 2);
    if (next !== pixelRatio || canvas.width !== Math.round(W * next) || canvas.height !== Math.round(H * next)) {
      pixelRatio = next;
      canvas.width = Math.round(W * next);
      canvas.height = Math.round(H * next);
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function loadedPhoto(path) {
    if (!path || typeof Image !== 'function') return null;
    let entry = photoCache.get(path);
    if (!entry) {
      const image = new Image();
      entry = { image, readyAt: 0, failed: false };
      image.decoding = 'async';
      image.onload = () => { entry.readyAt = now(); };
      image.onerror = () => { entry.failed = true; };
      image.src = new URL(path, import.meta.url).href;
      photoCache.set(path, entry);
    }
    if (entry.failed || !entry.image.complete || !entry.image.naturalWidth) return null;
    if (!entry.readyAt) entry.readyAt = now();
    return entry;
  }

  function effect(event) {
    if (!event || typeof event !== 'object') return;
    reducedMotion = Boolean(motionMedia?.matches);
    const type = String(event.type || '').toLowerCase();
    if (!['hit', 'dodge', 'land', 'ko', 'bones-scatter', 'kick', 'jump-kick', 'special-wave', 'fall-impact',
      'spear-windup', 'spear-throw', 'spear-impact'].includes(type)) return;

    const stamp = now();
    const stableId = event.id ?? event.eventId ?? event.uid;
    if (stableId != null) {
      const key = String(stableId);
      if (seenIds.has(key)) return;
      seenIds.add(key);
      seenOrder.push(key);
      if (seenOrder.length > 700) seenIds.delete(seenOrder.shift());
    } else {
      const key = `${type}:${number(event.tick, -1)}:${Math.round(number(event.x))}:${Math.round(number(event.y))}`;
      if (stamp - (recentAnonymous.get(key) ?? -Infinity) < 180) return;
      recentAnonymous.set(key, stamp);
      if (recentAnonymous.size > 120) {
        for (const [oldKey, oldTime] of recentAnonymous) if (stamp - oldTime > 800) recentAnonymous.delete(oldKey);
      }
    }

    const x = clamp(number(event.x, worldWidth / 2), -50, worldWidth + 50);
    const y = clamp(number(event.y, H / 2), -50, H + 50);
    if (type === 'ko') {
      const target = String(event.target ?? `ko:${stableId ?? `${Math.round(x)}:${Math.round(y)}:${stamp}`}`);
      const previous = lastFighters.get(target);
      const facing = number(previous?.fighter.facing ?? event.facing, 1) < 0 ? -1 : 1;
      // Normal KO events report the point above the feet. Use their current
      // height, not a stale interpolated frame, so an airborne fighter never
      // snaps backward just as the tomato arrives. A pit fall stays at the rim.
      const footY = event.source === 'fall' ? H + 8
        : event.y == null ? number(previous?.fighter.y, y + 40)
          : y + number(previous?.fighter.height ?? event.height, 88) * .45;
      const pose = {
        ...(previous?.fighter ?? {}), id: target, kind: previous?.fighter.kind ?? event.kind ?? 'hero',
        x: clamp(x, 22, worldWidth - 22),
        // Off-screen falls get a visible, bounded final gag at the arena edge.
        y: clamp(footY, 80, H + 8), facing,
        hp: 0, vx: 0, vy: 0, grounded: true, stun: 0, dodgeTicks: 0,
        attackStage: 0, attackTick: 0, kickType: null, kickTick: 0,
        hurtFlash: 0, invulnerable: 0,
      };
      knockouts.set(target, {
        target, born: stamp, fighter: pose, index: previous?.index ?? (pose.team === 1 ? 1 : 0),
        reducedMotion,
        seed: Array.from(target).reduce((seed, character) =>
          (seed * 31 + character.charCodeAt(0)) % 997, 0),
        impactX: pose.x + facing,
        impactY: pose.y - (83 + HEAD_RADIUS) * (pose.kind === 'boss' ? 1.28 : 1)
          - (pose.kind === 'hero' ? 16 : 0),
      });
      if (knockouts.size > 24) knockouts.delete(knockouts.keys().next().value);
      return;
    }
    if (type === 'bones-scatter') {
      const target = String(event.target ?? stableId ?? `bones:${Math.round(x)}:${Math.round(y)}`);
      if (scatteredTargets.has(target)) return;
      scatteredTargets.add(target);
      seenCorpseIds.add(target);
      boneBursts.set(target, {
        born: stamp, target,
        // Store world coordinates, not the camera-clamped position above. An
        // event can arrive before the first frame establishes a 1920px arena.
        x: number(event.x, x), y: number(event.y, y),
        kind: event.kind, facing: number(event.facing, 1) < 0 ? -1 : 1,
        reducedMotion,
        seed: Array.from(target).reduce((seed, character) =>
          (seed * 31 + character.charCodeAt(0)) % 997, 0),
      });
      if (boneBursts.size > 24) boneBursts.delete(boneBursts.keys().next().value);
      return;
    }
    if (type === 'special-wave') {
      const source = lastFighters.get(String(event.source))?.fighter;
      const facing = number(event.facing, number(source?.facing, 1)) < 0 ? -1 : 1;
      // The event may precede the first 1920px render; keep its reported
      // world position instead of clipping it to the default 960px viewport.
      const castX = clamp(number(event.x, x), -50, Math.max(worldWidth + 50, 4096));
      rings.push({ x: castX, y, facing, born: stamp,
        life: reducedMotion ? SPIRIT_BEAM_CALM_MS : SPIRIT_BEAM_MS,
        radius: clamp(Math.max(number(event.radius, W), worldWidth), 160,
          Math.max(worldWidth + 200, 4096)),
        tint: SPIRIT_TINTS[sceneTheme], calm: reducedMotion, type });
      if (!reducedMotion) {
        shakeStrength = 3.5;
        shakeUntil = stamp + 120;
      }
      if (rings.length > 45) rings.splice(0, rings.length - 45);
      return;
    }
    if (type.startsWith('spear-')) {
      const impact = type === 'spear-impact';
      const throwSpear = type === 'spear-throw';
      const count = reducedMotion ? impact ? 4 : 2 : impact ? 14 : throwSpear ? 9 : 5;
      const palette = impact ? ['#fff4ce', '#efb66e', '#8fe5d3']
        : throwSpear ? ['#dffff0', '#8fe5d3', '#ffdd9e'] : ['#fff1c9', '#efba80'];
      const facing = number(event.facing, number(event.vx, 1)) < 0 ? -1 : 1;
      for (let i = 0; i < count; i++) {
        const angle = throwSpear
          ? Math.atan2(number(event.vy), number(event.vx, facing))
            + (i / Math.max(1, count - 1) - .5) * 1.45
          : i / count * TAU + hash(i * 17 + x) * .24;
        const speed = (impact ? 115 : throwSpear ? 90 : 38) * (.55 + hash(i * 7 + y) * .65);
        particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          size: impact ? 2.4 : 1.8, color: palette[i % palette.length], born: stamp,
          life: impact ? 310 : throwSpear ? 210 : 180, dust: false });
      }
      rings.push({ x, y, born: stamp, life: impact ? 280 : throwSpear ? 200 : 230,
        radius: impact ? 48 : throwSpear ? 31 : 23, color: palette[0], type, facing });
      if (impact && !reducedMotion) {
        shakeStrength = 3.2;
        shakeUntil = stamp + 130;
      }
      if (particles.length > 450) particles.splice(0, particles.length - 450);
      if (rings.length > 45) rings.splice(0, rings.length - 45);
      return;
    }
    const ultimate = type === 'jump-kick';
    const heavy = type === 'hit' && Boolean(event.heavy);
    const specialHit = type === 'hit' && event.special === true;
    const fallingImpact = type === 'fall-impact';
    const targetX = specialHit ? clamp(number(event.x, x), -50, Math.max(worldWidth + 50, 4096)) : x;
    const source = specialHit ? lastFighters.get(String(event.source))?.fighter : null;
    const facing = specialHit ? targetX < number(source?.x, targetX) ? -1 : 1
      : number(event.facing, 1) < 0 ? -1 : 1;
    if (type === 'hit' && !specialHit && event.delivery !== 'spear'
      && !String(event.source ?? '').startsWith('hazard:')) {
      const source = lastFighters.get(String(event.source))?.fighter;
      const direction = number(event.facing, number(source?.facing, 1)) < 0 ? -1 : 1;
      const accent = source?.kind === 'hero' && source.team === 1 ? '#b7f2f2'
        : source?.team === 1 ? '#ffc0a0' : '#f8cf8c';
      impactMarks.push({ x: clamp(x - direction * 5, 0, worldWidth), y,
        born: stamp, life: reducedMotion ? 145 : heavy ? 245 : 185,
        facing: direction, heavy, accent,
        tint: SPIRIT_TINTS[sceneTheme], reducedMotion });
      if (impactMarks.length > 24) impactMarks.splice(0, impactMarks.length - 24);
    }
    // The jump-kick event is emitted on its first damaging frame. Its origin
    // is the fighter's torso, so shift only the decoration toward the foot.
    const fx = ultimate ? clamp(x + facing * 84, 0, worldWidth) : targetX;
    const fy = ultimate ? clamp(y + 10, 0, H) : y;
    const count = reducedMotion ? 5 : ultimate ? 20
      : specialHit ? 11 : fallingImpact ? 8 : heavy ? 18
        : type === 'hit' ? 12 : type === 'land' ? 10 : type === 'kick' ? 7 : 9;
    const speed = ultimate ? 205 : fallingImpact ? 75 : type === 'hit' ? 180
      : type === 'dodge' ? 80 : 60;
    const palette = ultimate ? ['#eaffec', '#8de9df', '#f5d995']
      : specialHit ? ['#eafff4', '#80e4df', '#d9f8ed']
        : fallingImpact ? ['#f8e7c7', '#cbd7ca', '#a6bdba']
      : type === 'dodge' ? ['#e9f9df', '#8bbec0', '#c1e6d6']
      : type === 'land' ? ['#e9d1a5', '#b4a580', '#f6e9c8']
      : ['#fff4ca', '#f5a96c', '#e97157'];
    for (let i = 0; i < count; i++) {
      const angle = ultimate
        ? (facing < 0 ? Math.PI : 0) + (i / Math.max(1, count - 1) - .5) * 1.65
        : (i / count) * TAU + hash(i * 11 + x + y) * .3;
      const force = speed * (.35 + hash(i * 7 + fx) * .8);
      particles.push({ x: fx, y: fy, vx: Math.cos(angle) * force,
        vy: Math.sin(angle) * force - (type === 'land' || fallingImpact ? 45 : 0),
        size: 1.5 + hash(i * 13 + fy) * (ultimate ? 4 : 3),
        color: palette[i % palette.length], born: stamp,
        life: ultimate ? 320 : fallingImpact ? 250 : type === 'kick' ? 210
          : type === 'land' ? 340 : type === 'dodge' ? 330 : type === 'hit' ? 320 : 480,
        dust: type === 'land' || type === 'dodge' || fallingImpact });
    }
    rings.push({ x: fx, y: fy, born: stamp,
      life: ultimate ? 320 : fallingImpact ? 220 : type === 'kick' ? 190 : type === 'hit' ? 250 : 300,
      radius: ultimate ? 66 : fallingImpact ? 28 : heavy ? 57 : type === 'hit' ? 43 : type === 'kick' ? 25 : 34,
      color: palette[0], type: specialHit ? 'special-hit' : type, facing,
      tint: specialHit ? SPIRIT_TINTS[sceneTheme] : undefined,
      calm: specialHit && reducedMotion });
    if (!reducedMotion && (type === 'hit' || ultimate)) {
      shakeStrength = ultimate ? 4 : clamp(3 + number(event.damage) * .13, 3, heavy ? 8 : 7);
      shakeUntil = stamp + (ultimate ? 150 : 220);
    }
    // Prevent long sessions with an inactive tab from accumulating particles.
    if (particles.length > 450) particles.splice(0, particles.length - 450);
    if (rings.length > 45) rings.splice(0, rings.length - 45);
  }

  function drawEffects(time) {
    for (let i = rings.length - 1; i >= 0; i--) {
      const item = rings[i];
      const progress = (time - item.born) / item.life;
      if (progress >= 1) { rings.splice(i, 1); continue; }
      if (item.type === 'special-wave') {
        drawSpiritWave(ctx, item, clamp(progress, 0, 1), worldWidth, reducedMotion);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = (1 - progress) * (item.type === 'hit' || item.type === 'jump-kick' ? .74 : .45);
      ctx.beginPath();
      // Under the system's reduced-motion preference, keep one fixed ring
      // rather than expanding it across the figure while the cue fades.
      ctx.arc(item.x, item.y, 7 + item.radius * (reducedMotion ? .38 : progress), 0, TAU);
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.type === 'ko' || item.type === 'jump-kick' ? 5 - 3 * progress : 3 - 2 * progress;
      ctx.stroke();
      if (item.type === 'special-hit') drawSpiritHit(ctx, item, progress, reducedMotion);
      if (item.type === 'jump-kick' && !reducedMotion) {
        ctx.translate(item.x, item.y);
        ctx.scale(item.facing, 1);
        ctx.globalAlpha = (1 - progress) * .57;
        ctx.beginPath();
        ctx.moveTo(-23, -12);
        ctx.bezierCurveTo(-5, -28, 13 + 22 * progress, -25, 28 + 24 * progress, -11);
        ctx.strokeStyle = '#a7f3e5';
        ctx.lineWidth = 3.5 - 1.8 * progress;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-20, 11);
        ctx.bezierCurveTo(1, 26, 18 + 18 * progress, 19, 27 + 24 * progress, 8);
        ctx.strokeStyle = '#f4e2ac';
        ctx.lineWidth = 2.8 - 1.4 * progress;
        ctx.stroke();
      }
      ctx.restore();
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const item = particles[i];
      const elapsed = (time - item.born) / 1000;
      const progress = (time - item.born) / item.life;
      if (progress >= 1) { particles.splice(i, 1); continue; }
      const px = item.x + item.vx * elapsed;
      const py = item.y + item.vy * elapsed + (item.dust ? 70 : 230) * elapsed * elapsed;
      ctx.save();
      ctx.globalAlpha = (1 - progress) * .94;
      if (item.dust) ellipse(ctx, px, py, item.size * (1 + progress), item.size * .55, item.color);
      else line(ctx, [[px, py], [px - item.vx * .027, py - item.vy * .027]], item.color, item.size);
      ctx.restore();
    }
    for (let i = impactMarks.length - 1; i >= 0; i--) {
      const mark = impactMarks[i];
      if (time - mark.born >= mark.life) { impactMarks.splice(i, 1); continue; }
      drawContactImpact(ctx, mark, time, reducedMotion);
    }
  }

  function render(state = {}, meta = {}) {
    reducedMotion = Boolean(motionMedia?.matches);
    const arena = state.arena || {};
    const theme = normalizedTheme(meta.theme || arena.theme);
    const level = meta.level;
    const groundY = clamp(number(arena.groundY, 430), 280, 510);
    const tick = number(state.tick);
    const motionTick = number(state.motionTick, tick);
    const scene = `${meta.mode || ''}:${theme}:${level || ''}`;
    const sceneChanged = lastTick >= 0 && (tick < lastTick || scene !== lastScene);
    if (sceneChanged) {
      seenIds.clear();
      seenOrder.length = 0;
      recentAnonymous.clear();
      knockouts.clear();
      boneBursts.clear();
      scatteredTargets.clear();
      seenCorpseIds.clear();
      lastFighters.clear();
      particles.length = 0;
      rings.length = 0;
      impactMarks.length = 0;
      shakeUntil = 0;
      cameraX = 0;
      cameraAt = 0;
    }
    const firstFrame = lastTick < 0 || sceneChanged;
    lastTick = tick;
    lastScene = scene;
    sceneTheme = theme;
    worldWidth = Math.max(W, number(arena.width, W));
    if (firstFrame) {
      // A cast can arrive before the first frame provides its chapter theme.
      for (const ring of rings) {
        if (ring.type === 'special-wave' || ring.type === 'special-hit') ring.tint = SPIRIT_TINTS[theme];
      }
    }
    scaleCanvas();

    const time = now();
    const fighters = Array.isArray(state.fighters) ? state.fighters : [
      { x: 295, y: groundY, vx: 0, facing: 1, hp: 100, grounded: true },
      { x: 675, y: groundY, vx: 0, facing: -1, hp: 100, grounded: true },
    ];
    const player = meta.mode === 'campaign'
      ? fighters.find((fighter) => fighter?.team === 0) ?? fighters[0] : null;
    const cameraTarget = player ? clamp(number(player.x) - W / 2, 0, worldWidth - W) : 0;
    if (firstFrame || reducedMotion || worldWidth === W) cameraX = cameraTarget;
    else {
      // Ease the viewport, not the authoritative simulation or collision pose.
      const elapsed = clamp(time - cameraAt, 8, 50);
      cameraX += (cameraTarget - cameraX) * (1 - Math.exp(-elapsed / 95));
      if (player) cameraX = clamp(cameraX,
        clamp(number(player.x) - W + 160, 0, worldWidth - W),
        clamp(number(player.x) - 160, 0, worldWidth - W));
      if (Math.abs(cameraTarget - cameraX) < .25) cameraX = cameraTarget;
    }
    cameraAt = time;
    for (const [key, knockout] of knockouts) {
      if (time - knockout.born >= TOMATO_LIFE_MS) knockouts.delete(key);
    }
    for (const [key, burst] of boneBursts) {
      if (time - burst.born >= BONES_SCATTER_MS) boneBursts.delete(key);
    }
    let tomatoShake = 0;
    if (!reducedMotion) {
      for (const knockout of knockouts.values()) {
        if (knockout.reducedMotion) continue;
        const sinceImpact = time - knockout.born - TOMATO_DROP_MS;
        if (sinceImpact >= 0 && sinceImpact < 170) {
          tomatoShake = Math.max(tomatoShake, 5 * (1 - sinceImpact / 170));
        }
      }
    }
    const strength = reducedMotion ? 0
      : Math.max(Math.max(0, (shakeUntil - time) / 250) * shakeStrength, tomatoShake);
    const seed = number(level, 1) * 37;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    if (strength) ctx.translate(Math.sin(time * .093) * strength, Math.cos(time * .127) * strength * .65);
    ctx.save();
    ctx.translate(-cameraX, 0);
    const photo = loadedPhoto(meta.mode === 'campaign' ? photoForLevel(theme, level) : null);
    const photoOpacity = photo ? reducedMotion ? 1 : clamp((time - photo.readyAt) / 250, 0, 1) : 0;
    if (photoOpacity < 1) {
      drawTiledWorld(ctx, worldWidth, () => {
        if (theme === 'city') drawCity(ctx, tick, groundY, seed);
        else if (theme === 'ocean') drawOcean(ctx, tick, groundY, seed);
        else if (theme === 'land') drawLand(ctx, tick, groundY, seed);
        else drawForest(ctx, tick, groundY, seed);
      });
    }
    if (photo) drawPhotoBackdrop(ctx, photo.image, theme, groundY, photoOpacity, worldWidth);
    drawTiledWorld(ctx, worldWidth, () => drawGround(ctx, theme, groundY, tick, seed,
      Boolean(photo) && theme === 'land'));
    drawPlatforms(ctx, arena.platforms, theme, motionTick);
    drawHazards(ctx, arena.hazards, theme, tick);
    if (meta.mode === 'campaign') drawFallingWarning(ctx, state.fallingObject, tick, reducedMotion, worldWidth);

    if (meta.mode === 'campaign' && Array.isArray(state.corpses)) {
      for (const corpse of state.corpses) {
        if (corpse?.id == null || corpse.team !== 1) continue;
        const id = String(corpse.id);
        seenCorpseIds.add(id);
        if (scatteredTargets.has(id)) continue;
        drawCampaignCorpse(ctx, corpse, knockouts.get(id), groundY,
          motionTick, time, worldWidth, reducedMotion);
      }
      for (const burst of boneBursts.values()) {
        drawScatteredBones(ctx, burst, knockouts.get(burst.target), time, worldWidth, reducedMotion);
      }
    }

    const visibleIds = new Set(fighters.map((fighter) => String(fighter?.id)));
    // The next campaign wave can replace a KO'd enemy immediately. Its brief
    // visual echo holds the head in place until the tomato lands and fades.
    for (const knockout of knockouts.values()) {
      if (meta.mode === 'campaign' && seenCorpseIds.has(knockout.target)) continue;
      if (visibleIds.has(knockout.target)) continue;
      ctx.save();
      ctx.globalAlpha *= .88 * clamp((TOMATO_LIFE_MS - (time - knockout.born)) / 360, 0, 1);
      drawFighter(ctx, knockout.fighter, knockout.index, groundY, tick, knockout.reducedMotion,
        knockout, time, 'sad');
      ctx.restore();
    }
    fighters.forEach((fighter, index) => {
      const current = fighter || {};
      if (meta.mode === 'campaign' && current.team === 1 && number(current.hp, 100) <= 0
        && seenCorpseIds.has(String(current.id))) return;
      const knockout = number(current.hp, 100) <= 0 ? knockouts.get(String(current.id)) : null;
      drawFighter(ctx, knockout?.fighter ?? current, index, groundY, tick,
        knockout?.reducedMotion ?? reducedMotion, knockout, time,
        expressionFor(current, state, meta));
      if (meta.mode === 'campaign') {
        drawSpearWindup(ctx, current, tick, reducedMotion, groundY, cameraX, worldWidth);
      }
    });
    for (const projectile of state.projectiles || []) drawSpear(ctx, projectile, reducedMotion);
    if (meta.mode === 'campaign') drawFallingObject(ctx, state.fallingObject, tick, reducedMotion);
    for (const knockout of knockouts.values()) drawTomatoBurst(ctx, knockout, time, knockout.reducedMotion);
    drawEffects(time);
    ctx.restore();
    ctx.restore();
    drawAtmosphere(ctx, theme, tick, level);
    lastFighters = new Map(fighters.map((fighter, index) => fighter?.id == null ? null
      : [String(fighter.id), { fighter: { ...fighter }, index }]).filter(Boolean));
  }

  return { render, effect };
}
