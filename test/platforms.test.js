import test from 'node:test';
import assert from 'node:assert/strict';
import { platformPose, platformSurfaceY } from '../shared/platforms.js';

test('floating platform moves vertically by simulation tick without mutating its baseline', () => {
  const platform = { x: 300, y: 360, w: 120, h: 12,
    motion: 'float', baseX: 300, baseY: 360, period: 120, amplitude: 18, phase: 0 };
  assert.equal(platformPose(platform, 0).centerY, 360);
  assert.equal(platformPose(platform, 30).centerY, 378);
  assert.equal(platformPose(platform, 90).centerY, 342);
  assert.deepEqual(platformPose(platform, 150), platformPose(platform, 30));
  assert.equal(platform.y, 360);
});

test('horizontal float translates its full walkable surface left and right on the same fixed tick', () => {
  const platform = { x: 300, y: 360, w: 120, h: 12,
    motion: 'float', axis: 'x', baseX: 300, baseY: 360,
    period: 120, amplitude: 24, phase: 0 };
  const baseline = platformPose(platform, 0);
  const right = platformPose(platform, 30);
  const left = platformPose(platform, 90);
  assert.deepEqual([baseline.left, baseline.right, baseline.centerY], [300, 420, 360]);
  assert.deepEqual([right.left, right.right, right.centerY], [324, 444, 360]);
  assert.deepEqual([left.left, left.right, left.centerY], [276, 396, 360]);
  assert.equal(platformSurfaceY(right, 430), 360);
  assert.equal(platformSurfaceY(right, 300), null);
  assert.deepEqual(platformPose(platform, 150), right);
  assert.equal(platform.x, 300);
});

test('rotating wood has one sloped walkable surface and a fixed pivot', () => {
  const beam = { x: 420, y: 310, w: 160, h: 12, motion: 'rotate',
    baseX: 500, baseY: 310, baseAngle: 0, period: 120, amplitude: 0.16, phase: 0 };
  const pose = platformPose(beam, 30);
  assert.equal(pose.centerX, 500);
  assert.equal(pose.centerY, 310);
  assert.ok(Math.abs(pose.angle - 0.16) < 1e-12);
  assert.ok(Math.abs(platformSurfaceY(pose, pose.left) - pose.leftY) < 1e-10);
  assert.ok(Math.abs(platformSurfaceY(pose, pose.right) - pose.rightY) < 1e-10);
  assert.equal(platformSurfaceY(pose, pose.left - 1), null);
  assert.deepEqual(platformPose(beam, 150), pose);
});
