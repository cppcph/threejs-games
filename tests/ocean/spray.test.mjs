// 水滴动力学与近海面风廓线的单元测试（纯 Node）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relaxationTime, stepDroplet, windAtHeight, airSeaRoughness, G } from '../../ocean/droplets.js';

// 静止空气中下落到稳态的速度
function terminalVelocity(r) {
  const v = [0, 0, 0], air = [0, 0, 0];
  for (let i = 0; i < 20000; i++) stepDroplet(v, r, air, 1e-3);
  return -v[1];
}

test('终端速度与 Gunn & Kinzer (1949) 实测相差 < 10%', () => {
  // 直径 (mm) → 实测终端速度 (m/s)
  for (const [dmm, vt] of [[0.1, 0.27], [0.2, 0.72], [0.5, 2.06], [1.0, 4.03]]) {
    const v = terminalVelocity(dmm * 5e-4);
    assert.ok(Math.abs(v / vt - 1) < 0.1, `d = ${dmm} mm：模型 ${v.toFixed(3)} m/s，实测 ${vt} m/s`);
  }
});

test('小水滴几乎立刻随风，大水滴跟不上', () => {
  const small = relaxationTime(25e-6, 1), big = relaxationTime(400e-6, 5);
  assert.ok(small < 0.01, `25 μm：τ = ${small}`);
  assert.ok(big > 0.2, `400 μm：τ = ${big}`);           // 约 0.25 s：被甩出后来不及被风加速就落回
  // 50 μm 的水滴在 15 m/s 的风里 0.2 s 内就达到风速的 95% 以上
  const v = [0, 0, 0];
  for (let i = 0; i < 200; i++) stepDroplet(v, 50e-6, [15, 0, 0], 1e-3);
  assert.ok(v[0] > 0.95 * 15, `vx = ${v[0]}`);
});

test('隐式积分在大步长下稳定', () => {
  const v = [3, 2, 0];
  for (let i = 0; i < 100; i++) stepDroplet(v, 20e-6, [10, 0, 0], 1 / 30);
  assert.ok(Number.isFinite(v[0]) && Math.abs(v[0] - 10) < 0.5, `vx = ${v[0]}`);
});

test('对数风廓线：10 m 处等于 U10，越近水面越小；摩擦速度与 Charnock 粗糙度量级合理', () => {
  for (const U of [5, 10, 20]) {
    assert.ok(Math.abs(windAtHeight(U, 10) - U) < 1e-9);
    assert.ok(windAtHeight(U, 1) < U && windAtHeight(U, 1) > 0.7 * U);
  }
  const { ustar, z0 } = airSeaRoughness(10);
  assert.ok(ustar > 0.3 && ustar < 0.45, `u* = ${ustar}`);       // 10 m/s 时约 0.37 m/s
  assert.ok(z0 > 5e-5 && z0 < 5e-4, `z0 = ${z0}`);               // 约 1.5e-4 m
  assert.equal(G, 9.81);
});
