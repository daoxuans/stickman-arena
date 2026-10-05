/**
 * Guaranteed campaign Boss rewards. All attack numbers come from this catalog,
 * never from a saved inventory entry or a browser input packet.
 */
export const BOSS_EQUIPMENT = Object.freeze([
  {
    id: 'mist-gauntlet', bossLevel: 10, name: '雾林拳甲', tier: 1,
    damage: 15, reach: 88, cooldown: 44, duration: 24,
    activeFrom: 7, activeTo: 11, knockback: 5.6, stun: 16, freeze: 4,
    color: '#b5edb0', style: 'sweep',
  },
  {
    id: 'forest-vine', bossLevel: 14, name: '森王藤刃', tier: 1,
    damage: 16, reach: 91, cooldown: 46, duration: 25,
    activeFrom: 7, activeTo: 12, knockback: 5.8, stun: 16, freeze: 4,
    color: '#c4f3a0', style: 'pierce',
  },
  {
    id: 'metro-spike', bossLevel: 20, name: '地铁灵刺', tier: 2,
    damage: 17, reach: 95, cooldown: 48, duration: 25,
    activeFrom: 8, activeTo: 12, knockback: 6.0, stun: 17, freeze: 4,
    color: '#e8c2ef', style: 'pierce',
  },
  {
    id: 'city-ring', bossLevel: 28, name: '钢城战轮', tier: 2,
    damage: 18, reach: 99, cooldown: 50, duration: 26,
    activeFrom: 8, activeTo: 13, knockback: 6.2, stun: 17, freeze: 5,
    color: '#efca8e', style: 'sweep',
  },
  {
    id: 'storm-blade', bossLevel: 30, name: '风暴潮刃', tier: 3,
    damage: 19, reach: 103, cooldown: 52, duration: 26,
    activeFrom: 8, activeTo: 13, knockback: 6.4, stun: 18, freeze: 5,
    color: '#93e6ed', style: 'sweep',
  },
  {
    id: 'deepsea-arc', bossLevel: 40, name: '深海回锋', tier: 3,
    damage: 20, reach: 109, cooldown: 54, duration: 27,
    activeFrom: 9, activeTo: 14, knockback: 6.6, stun: 18, freeze: 5,
    color: '#a6dcf4', style: 'pierce',
  },
  {
    id: 'tidal-halo', bossLevel: 42, name: '潮汐震环', tier: 4,
    damage: 21, reach: 114, cooldown: 56, duration: 28,
    activeFrom: 9, activeTo: 14, knockback: 6.8, stun: 19, freeze: 5,
    color: '#b8f8ed', style: 'pulse',
  },
  {
    id: 'wasteland-fist', bossLevel: 50, name: '荒原破岩臂', tier: 4,
    damage: 22, reach: 120, cooldown: 58, duration: 29,
    activeFrom: 10, activeTo: 15, knockback: 7.0, stun: 19, freeze: 6,
    color: '#f2bf8b', style: 'pulse',
  },
  {
    id: 'earth-seal', bossLevel: 56, name: '大地守卫玄印', tier: 5,
    damage: 24, reach: 126, cooldown: 60, duration: 30,
    activeFrom: 10, activeTo: 16, knockback: 7.2, stun: 20, freeze: 6,
    color: '#f5d9a1', style: 'pulse',
  },
].map((equipment) => Object.freeze(equipment)));

const byId = new Map(BOSS_EQUIPMENT.map((equipment) => [equipment.id, equipment]));
const byLevel = new Map(BOSS_EQUIPMENT.map((equipment) => [equipment.bossLevel, equipment]));

export function getEquipment(id) {
  return typeof id === 'string' ? byId.get(id) ?? null : null;
}

export function equipmentForBoss(levelNumber) {
  return Number.isInteger(levelNumber) ? byLevel.get(levelNumber) ?? null : null;
}
