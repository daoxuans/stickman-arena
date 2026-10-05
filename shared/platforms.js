/** Pure platform geometry shared by the fixed-step simulation and canvas. */
const TAU = Math.PI * 2;
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function platformPose(platform, tick = 0) {
  const x = finite(platform?.x, 0);
  const y = finite(platform?.y, 0);
  const width = Math.max(0, finite(platform?.w, 0));
  const height = Math.max(0, finite(platform?.h, 0));
  const motion = platform?.motion;
  const period = finite(platform?.period, 0);
  const phase = finite(platform?.phase, 0);
  const amplitude = finite(platform?.amplitude, 0);
  const wave = period > 0
    ? Math.sin(TAU * (finite(tick, 0) + phase) / period) : 0;
  const centerX = motion === 'rotate' ? finite(platform.baseX, x + width / 2)
    : motion === 'float' ? finite(platform.baseX, x) + width / 2
      + (platform.axis === 'x' ? amplitude * wave : 0) : x + width / 2;
  const centerY = motion === 'rotate' ? finite(platform.baseY, y)
    : motion === 'float' ? finite(platform.baseY, y)
      + (platform.axis === 'x' ? 0 : amplitude * wave) : y;
  const angle = motion === 'rotate'
    ? finite(platform.baseAngle, finite(platform.angle, 0)) + amplitude * wave : 0;
  const dx = Math.cos(angle) * width / 2;
  const dy = Math.sin(angle) * width / 2;
  return {
    centerX, centerY, angle, width, height,
    left: centerX - dx, right: centerX + dx,
    leftY: centerY - dy, rightY: centerY + dy,
  };
}

/** The walkable top at a world x, or null outside the plank's projection. */
export function platformSurfaceY(pose, x) {
  if (!pose || !Number.isFinite(x) || x < pose.left || x > pose.right) return null;
  return pose.centerY + (x - pose.centerX) * Math.tan(pose.angle);
}
