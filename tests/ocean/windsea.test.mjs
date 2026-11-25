// 风浪物理模型单元测试：node --test tests/ocean/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WindSeaModel, X_FD, G, hsFromEnergy, energyFromFetch, peakOmegaFromFetch, fetchFromDuration,
  wavenumber, waveSpeeds, beaufort, seaStateScale, whitecapCoverage,
} from '../../ocean/WindSeaModel.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} 期望 ${b}±${tol}，实际 ${a}`);

test('充分发展与 PM 谱一致：Hs = 0.219 U²/g，ω_p = 0.855 g/U', () => {
  near(X_FD, 1.88e4, 300, 'X_FD');
  for (const U of [5, 10, 15, 20]) {
    const Hs = hsFromEnergy(energyFromFetch(U, X_FD));
    near(Hs, 0.219 * U * U / G, 0.01 * Hs, `U=${U} Hs`);
    near(peakOmegaFromFetch(U, X_FD), 0.855 * G / U, 1e-3, `U=${U} ω_p`);
  }
  // 常用数值：10 m/s 充分发展 Hs≈2.2 m，Tp≈7.5 s；20 m/s Hs≈8.9 m，Tp≈15 s
  const m = new WindSeaModel({ wind: { x: 10, z: 0 }, fetch: 5e6 });
  m.develop(1);
  near(m.readout.Hs, 2.23, 0.05, 'Hs(10 m/s)');
  near(m.readout.Tp, 7.49, 0.1, 'Tp(10 m/s)');
  assert.equal(m.readout.stage, 'developed');
  near(m.readout.waveAge, 1.17, 0.02, '波龄');
});

test('风区受限：U=10 m/s、风区 50 km → Hs≈1.14 m、Tp≈4.8 s', () => {
  const m = new WindSeaModel({ wind: { x: 10, z: 0 }, fetch: 50e3 });
  m.develop(1);
  near(m.readout.Hs, 1.14, 0.03, 'Hs');
  near(m.readout.Tp, 4.82, 0.1, 'Tp');
  assert.equal(m.readout.stage, 'fetch');
});

test('风时受限的生长：10 m/s 吹 1 h → 0.31 m，6 h → 1.2 m，约 14 h 充分发展', () => {
  const m = new WindSeaModel({ wind: { x: 10, z: 0 }, fetch: 5e6, timeScale: 1 });
  const run = (hours) => { for (let i = 0; i < hours * 360; i++) m.update(10); };
  run(1); near(m.readout.HsWind, 0.313, 0.02, '1 h');
  assert.equal(m.readout.stage, 'duration');
  run(5); near(m.readout.HsWind, 1.20, 0.05, '6 h');
  run(10); near(m.readout.HsWind, 2.23, 0.05, '16 h');
  assert.equal(m.readout.stage, 'developed');
});

test('生长过程单调、步长无关', () => {
  const a = new WindSeaModel({ wind: { x: 12, z: 0 }, timeScale: 1 });
  const b = new WindSeaModel({ wind: { x: 12, z: 0 }, timeScale: 1 });
  let last = 0;
  for (let i = 0; i < 7200; i++) { a.update(1); assert.ok(a.readout.HsWind >= last - 1e-12); last = a.readout.HsWind; }
  for (let i = 0; i < 72; i++) b.update(100);
  near(a.readout.HsWind, b.readout.HsWind, 1e-6, '1 s 步长与 100 s 步长结果一致');
});

test('风速增大时 Hs 连续（等效风时法），随后继续增长', () => {
  const m = new WindSeaModel({ wind: { x: 8, z: 0 }, fetch: 5e6, timeScale: 1 });
  for (let i = 0; i < 360; i++) m.update(10);
  const before = m.readout.HsWind;
  m.setWind(16, 0); m.snapWind();
  m.update(1e-3);
  near(m.readout.HsWind, before, 1e-3, '换风瞬间');
  for (let i = 0; i < 360; i++) m.update(10);
  assert.ok(m.readout.HsWind > before * 1.5, '强风下继续长大');
});

test('风减弱：超出部分能量转为涌浪，总能量守恒', () => {
  const m = new WindSeaModel({ wind: { x: 18, z: 0 }, fetch: 5e6, timeScale: 1 });
  m.develop(1);
  const E0 = (m.readout.Hs / 4) ** 2;
  m.setWind(6, 0); m.snapWind();
  m.update(1e-3);
  const E1 = (m.readout.Hs / 4) ** 2;
  near(E1, E0, E0 * 1e-3, '能量守恒');
  assert.ok(m.readout.HsSwell > m.readout.HsWind, '大部分变成涌浪');
  near(m.readout.TpSwell, 2 * Math.PI / (0.855 * G / 18), 0.2, '涌浪保留原周期');
  // 之后涌浪缓慢衰减
  const Hsw = m.readout.HsSwell;
  for (let i = 0; i < 360; i++) m.update(10);
  assert.ok(m.readout.HsSwell < Hsw && m.readout.HsSwell > 0.5 * Hsw, '1 h 后衰减但仍明显');
});

test('风向突变 90°：旧浪转涌，新风浪从零开始', () => {
  const m = new WindSeaModel({ wind: { x: 12, z: 0 }, fetch: 5e6, timeScale: 1 });
  m.develop(0.6);
  const Hs0 = m.readout.HsWind;
  m.setWind(0, 12); m.snapWind();
  m.update(60);
  assert.ok(m.readout.HsWind < 0.2 * Hs0, '新风浪很小');
  near(m.readout.HsSwell, Hs0, 0.02 * Hs0, '旧浪变成涌浪');
  near(m.readout.swellTheta, 0, 1e-6, '涌浪保持原方向');
  near(m.readout.waveTheta, Math.PI / 2, 1e-6, '新风浪沿新风向');
});

test('风向小幅偏转：风浪方向逐渐跟随', () => {
  const m = new WindSeaModel({ wind: { x: 12, z: 0 }, fetch: 5e6, timeScale: 1 });
  m.develop(0.5);
  const a = 30 * Math.PI / 180;
  m.setWind(12 * Math.cos(a), 12 * Math.sin(a)); m.snapWind();
  m.update(60);
  assert.ok(m.readout.waveTheta > 0 && m.readout.waveTheta < a * 0.2, '刚开始只偏一点');
  for (let i = 0; i < 400; i++) m.update(30);
  near(m.readout.waveTheta, a, 0.02, '几小时后对齐风向');
  assert.equal(m.swells.length, 0, '小角度偏转不产生涌浪');
});

test('平均风滤掉阵风：短暂阵风不改变大浪', () => {
  const m = new WindSeaModel({ wind: { x: 10, z: 0 }, fetch: 5e6, timeScale: 1, windResponse: 90 });
  m.develop(0.5);
  const Hs0 = m.readout.HsWind;
  m.setWind(20, 0); m.update(3); m.setWind(10, 0); m.update(3);
  assert.ok(Math.abs(m.readout.HsWind - Hs0) < 0.02 * Hs0);
});

test('浅水：Hs 不超过 0.6 h', () => {
  const m = new WindSeaModel({ wind: { x: 20, z: 0 }, fetch: 5e6, depth: 3 });
  m.develop(1);
  assert.ok(m.readout.Hs <= 1.8 + 1e-9);
});

test('色散关系与速度', () => {
  const omega = 2 * Math.PI / 10;                       // 10 s
  near(wavenumber(omega), omega * omega / G, 1e-12);
  near(waveSpeeds(omega).wavelength, 156.1, 0.2, '深水 10 s 波长');
  near(waveSpeeds(omega).group, waveSpeeds(omega).phase / 2, 1e-9, '深水群速 = 相速/2');
  const k = wavenumber(omega, 5);
  near(omega * omega, G * k * Math.tanh(k * 5), 1e-9, '有限水深');
  near(waveSpeeds(omega, 5).phase, Math.sqrt(G * 5), 0.4, '浅水波速 ≈ √(gh)');
});

test('风级、浪级、白浪覆盖率', () => {
  assert.equal(beaufort(0.1).force, 0);
  assert.equal(beaufort(4).force, 3);
  assert.equal(beaufort(9).name, '清劲风');
  assert.equal(beaufort(18).force, 8);
  assert.equal(seaStateScale(0.05).name, '微浪');
  assert.equal(seaStateScale(2.2).name, '中浪');
  assert.equal(seaStateScale(7).name, '狂浪');
  near(whitecapCoverage(10), 0.0099, 0.0005, 'Monahan 10 m/s');
});

test('无风时风浪全部转涌并衰减', () => {
  const m = new WindSeaModel({ wind: { x: 10, z: 0 }, fetch: 5e6, timeScale: 1 });
  m.develop(1);
  m.setWind(0, 0); m.snapWind(); m.update(1);
  assert.equal(m.readout.HsWind, 0);
  near(m.readout.HsSwell, 2.23, 0.05);
  assert.equal(m.readout.stage, 'calm');
  for (let i = 0; i < 2000; i++) m.update(60);
  assert.ok(m.readout.HsSwell < 0.6, '一天多后基本平静');
});

test('spectrumParams 结构', () => {
  const m = new WindSeaModel({ wind: { x: 10, z: 5 } });
  m.develop(0.7);
  m.setBackgroundSwell({ Hs: 1.5, Tp: 12, theta: 1 });
  const p = m.spectrumParams();
  assert.ok(p.windSea.E > 0 && p.windSea.omegaP > 0 && p.windSea.gamma >= 1.7 && p.windSea.gamma <= 6 && p.windSea.norm > 0);
  assert.equal(p.swells.length, 1);
  near(p.swells[0].omegaP, 2 * Math.PI / 12, 1e-9);
  assert.ok(fetchFromDuration(10, 3600) > 0);
});

test('浅水：读数按 TMA 修正，与 GPU 波谱一致；周期变短', async () => {
  const { depthResponse, jonswapShape } = await import('../../ocean/WindSeaModel.js');
  const deep = depthResponse(0.56, 3.3, 2000);
  assert.equal(deep.factor, 1);
  const sh = depthResponse(0.56, 3.3, 6);
  assert.ok(sh.factor < 0.5 && sh.factor > 0.05, `factor=${sh.factor}`);
  assert.ok(sh.omegaPeak > 0.56, '有效谱峰频率升高（周期变短）');
  // 形状函数积分为 1
  let s = 0; for (let w = 0.05; w < 20; w += 0.001) s += jonswapShape(w, 0.8, 3.3) * 0.001;
  near(s, 1, 0.01, '∫S dω');
  const m = new WindSeaModel({ wind: { x: 15, z: 0 }, fetch: 5e6, depth: 6 });
  m.develop(1);
  assert.ok(m.readout.Hs <= 3.6 + 1e-6 && m.readout.Hs > 0.5);
  assert.ok(m.readout.Tp < 11, `Tp=${m.readout.Tp}`);
});

test('Donelan 谱形：归一化积分、峰值位置、波龄依赖', async () => {
  const { dhhParams, windSeaShape, windSeaNorm } = await import('../../ocean/WindSeaModel.js');
  const young = dhhParams(3), mature = dhhParams(0.855);
  assert.ok(young.gamma > 4 && mature.gamma === 1.7, '年轻风浪谱峰更尖');
  assert.ok(young.sigma < mature.sigma);
  const wp = 0.9, p = dhhParams(1.5);
  const { norm } = windSeaNorm(wp, p);
  let s = 0, best = 0, arg = 0;
  for (let w = 0.2; w < 60; w += 0.0005) { const v = windSeaShape(w, wp, p) / norm; s += v * 0.0005; if (v > best) { best = v; arg = w; } }
  near(s, 1, 0.01, '∫ = 1');
  near(arg, wp, 0.02, '峰值在 ωp');
  // 平衡区：扣掉低频截断 exp(−(ωp/ω)⁴) 后，ω⁴·S 在 2–2.9 ωp 之间应为常数（ω⁻⁴）
  const flat = (w) => windSeaShape(w, wp, p) * w ** 4 * Math.exp((wp / w) ** 4);
  near(flat(2.9 * wp) / flat(2 * wp), 1, 0.01, 'ω⁻⁴ 平衡区');
  // 饱和区：3ωp 以上 ω⁵·S 为常数（ω⁻⁵）
  const flat5 = (w) => windSeaShape(w, wp, p) * w ** 5 * Math.exp((wp / w) ** 4);
  near(flat5(8 * wp) / flat5(4 * wp), 1, 0.01, 'ω⁻⁵ 饱和区');
});
