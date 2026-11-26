// 帆船动力学（ocean/vessel）测试：node --test tests/ocean/vessel.test.mjs
//
// 平静水面、解析 Airy 规则波两种“海”；不依赖 three.js、GPU。
// 参考极曲线：ORC 俱乐部证书（非球帆）Beneteau Evasion 28（GRE 1505，LOA 8.50 m、B 2.73 m、T 1.25 m、Δ 4204 kg、
// 帆面积 36.8 m²），数据取自开源 ORC 证书库 jieter/orc-data（site/data/GRE/GRE1505.json）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import {
  SailingYacht, HullShape, YACHT_HULL, HULL_DEFAULTS, buildYachtMesh, meshProperties, hullFormParameters,
  ittc57, windProfile, helmbold, wakeAngle, HullIntegrator, staticLoads,
} from '../../ocean/vessel/index.js';

const DEG = Math.PI / 180, KN = 1852 / 3600, G = 9.81;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} 期望 ${b}±${tol}，实际 ${a}`);
const within = (v, lo, hi, msg) => assert.ok(v >= lo && v <= hi, `${msg ?? ''} 期望 ${lo} … ${hi}，实际 ${v}`);

// —— 模拟海面 ——
class FlatOcean {
  sampleHeight() { return 0; }
  sampleVelocity(x, z, out = { x: 0, y: 0, z: 0 }) { out.x = out.y = out.z = 0; return out; }
}
/** 深水线性 Airy 波：η = a cos(k·x − ωt)，水面质点速度 u = aω cos(…)·k̂，w = aω sin(…)；ω² = g k */
class AiryOcean {
  constructor({ amplitude = 0.5, wavelength = 50, direction = 0 } = {}) {
    this.a = amplitude; this.k = 2 * Math.PI / wavelength; this.w = Math.sqrt(G * this.k);
    this.dx = Math.cos(direction); this.dz = Math.sin(direction); this.time = 0;
  }
  get period() { return 2 * Math.PI / this.w; }
  sampleHeight(x, z) { return this.a * Math.cos(this.k * (x * this.dx + z * this.dz) - this.w * this.time); }
  sampleVelocity(x, z, out = { x: 0, y: 0, z: 0 }) {
    const th = this.k * (x * this.dx + z * this.dz) - this.w * this.time, aw = this.a * this.w;
    out.x = aw * Math.cos(th) * this.dx; out.z = aw * Math.cos(th) * this.dz; out.y = aw * Math.sin(th); return out;
  }
}

// 风从北（−Z）吹来，风矢量指向下风 +Z
const windOf = (kn) => ({ x: 0, z: kn * KN });
const windFrom = (w) => Math.atan2(-w.x, -w.z);

/** 稳态航行：固定真风角，自动舵 + 自动调帆，平均最后 20 s */
function steady(twsKn, twaDeg, { T = 60, opts = {} } = {}) {
  const wind = windOf(twsKn), y = new SailingYacht(opts);
  y.setControls({ mode: 'twa', target: twaDeg * DEG, tack: 'port' });
  y.reset({ yaw: windFrom(wind) - twaDeg * DEG, speed: Math.min(3, 0.15 * twsKn + 0.5) });
  const a = { v: 0, vmg: 0, heel: 0, lee: 0, helm: 0, flat: 0, reef: 0, awa: 0, Fn: 0, n: 0 };
  for (let i = 0; i < 60 * T; i++) {
    y.step(1 / 60, { wind });
    if (y.time > T - 20) {
      const t = y.telemetry;
      a.v += t.speedKn; a.vmg += t.vmgKn; a.heel += Math.abs(t.heel); a.lee += Math.abs(t.leeway); a.helm += t.helm;
      a.flat += t.flat; a.reef += t.reef; a.awa += Math.abs(t.awa); a.Fn += t.Fn; a.n++;
    }
  }
  for (const k in a) if (k !== 'n') a[k] /= a.n;
  return a;
}

test('型线：HullShape 与 extras/Sailboat 的 HullGenerator 逐点一致', async () => {
  // Sailboat.js 顶部 import three；HullGenerator 的型线函数本身不用 three。用加载钩子把 three 换成空模块再导入。
  const stub = 'export class RoundedBoxGeometry {} export function mergeGeometries() { return null; }';
  const hooks = `export async function resolve(s, c, next) {
    if (s === 'three' || s.startsWith('three/')) return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true };
    return next(s, c);
  }`;
  register('data:text/javascript,' + encodeURIComponent(hooks));
  const { HullGenerator } = await import('../../ocean/extras/Sailboat.js');
  for (const p of [{ ...HULL_DEFAULTS }, { ...YACHT_HULL }]) {
    let err = 0;
    for (let i = 0; i <= 40; i++) {
      const s = i / 40;
      for (const f of ['halfBreadth', 'keel', 'sheer', 'zAt']) err = Math.max(err, Math.abs(HullGenerator[f](p, s) - HullShape[f](p, s)));
      for (let j = 0; j <= 12; j++) {
        const th = j / 12 * Math.PI / 2, a = HullGenerator.section(p, s, th), b = HullShape.section(p, s, th);
        err = Math.max(err, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
        const yy = -0.5 + j * 0.15;
        err = Math.max(err, Math.abs(HullGenerator.halfWidthAt(p, s, yy) - HullShape.halfWidthAt(p, s, yy)));
      }
    }
    assert.ok(err < 1e-12, `型线最大偏差 ${err}`);
  }
});

test('物理网格闭合：散度定理、排水体积、湿表面积与 DSYHS 公式一致', () => {
  const p = { ...YACHT_HULL }, Y = buildYachtMesh(p), f = hullFormParameters(p);
  for (const part of ['hull', 'keel', 'rudder']) {
    const m = meshProperties(Y[part]);
    assert.ok(m.closure < 1e-9, `${part} ∮n dA = ${m.closure}`);
    assert.ok(m.volume > 0, `${part} 体积为正（外法线）`);
  }
  const y = new SailingYacht();
  // 粗网格（28 站 × 每舷 8 段）水下船体体积与型线精确积分相差 < 3%
  near(y.form.volume, f.volume, 1e-9);
  const hullOnly = staticLoads(new HullIntegrator(Y.hull), [0, 0, 0], { y: 0 }).F[1] / (1025 * G);
  near(hullOnly / f.volume, 1, 0.03, '船体水下体积 / 型线积分');
  near(y.particulars.wettedAreaHull / f.wettedAreaDSYHS, 1, 0.05, '船体湿面积 / DSYHS 公式');
  // DSYHS 适用范围
  within(f.slenderness, 4.34, 8.5, 'L/∇^(1/3)'); within(f.beamDraft, 2.46, 19.4, 'B/T'); within(f.Cp, 0.52, 0.6, 'Cp');
});

test('质量模型：排水量 = 质量，压载比 35–40%，LCG = LCB', () => {
  const y = new SailingYacht();
  near(y.massCheck, y.mass, 1e-6, '部件质量之和');
  within(y.mass, 3500, 4800, '排水量（kg），8.6 m 巡航帆船');
  const ballast = y.components.find((c) => c.name.startsWith('压载'));
  within(ballast.mass / y.mass, 0.35, 0.40, '压载比');
  near(y.cg[2], y.lcb, 1e-6, 'LCG = LCB');
  within(y.GM, 0.6, 1.3, '初稳性高 GM（m）');
});

test('平静水面：从偏离状态释放后浮在设计水线（吃水误差 < 2 cm），排水量 = 质量', () => {
  const y = new SailingYacht(), ocean = new FlatOcean();
  y.reset({ y: 0.15, heel: 6 * DEG, pitch: 2 * DEG });
  for (let i = 0; i < 60 * 40; i++) y.step(1 / 60, { ocean });
  const t = y.telemetry;
  assert.ok(Math.abs(y.state.position.y) < 0.02, `水线原点高度 ${y.state.position.y}`);
  assert.ok(Math.abs(t.heel) < 0.3 && Math.abs(t.pitch) < 0.3, `横倾 ${t.heel}° 纵倾 ${t.pitch}°`);
  near(t.displacement / y.mass, 1, 0.005, '排水量 / 质量');
  // 没有 ocean 参数（平静水面的快速路径）结果相同
  const z = new SailingYacht();
  z.reset({ y: 0.15 });
  for (let i = 0; i < 60 * 30; i++) z.step(1 / 60, {});
  assert.ok(Math.abs(z.state.position.y) < 0.02);
});

test('静稳性曲线 GZ(φ)：正值、最大值在 50–80°、稳性消失角 > 110°', () => {
  const y = new SailingYacht();
  const c = y.stability(Array.from({ length: 37 }, (_, i) => i * 5));
  let max = c[0], avs = 180;
  for (let i = 1; i < c.length; i++) {
    if (c[i].GZ > max.GZ) max = c[i];
    if (avs === 180 && c[i].GZ < 0 && c[i - 1].GZ >= 0) avs = c[i - 1].heel + 5 * c[i - 1].GZ / (c[i - 1].GZ - c[i].GZ);
  }
  console.log('  GZ(φ):', c.filter((r) => r.heel % 10 === 0).map((r) => `${r.heel}°:${r.GZ.toFixed(2)}`).join(' '), `  max ${max.GZ.toFixed(3)} m @ ${max.heel}°, AVS ${avs.toFixed(1)}°`);
  for (const r of c) if (r.heel > 0 && r.heel <= 110) assert.ok(r.GZ > 0, `GZ(${r.heel}°) = ${r.GZ}`);
  // 高干舷、舷侧外飘、深压载的长龙骨船：GZ 在 50° 以后形成平台，最大值约 75°（50° 时已达最大值的 85%）
  within(max.heel, 50, 80, 'GZ 最大值所在角度'); within(max.GZ, 0.4, 1.0, 'GZ 最大值（m）');
  assert.ok(c.find((r) => r.heel === 50).GZ > 0.8 * max.GZ, '50° 时接近平台');
  assert.ok(avs > 110, `稳性消失角 ${avs}`);
  // 小角度：GZ ≈ GM sin φ
  near(c[1].GZ, y.GM * Math.sin(5 * DEG), 0.01, 'GZ(5°)');
});

test('平静水面稳态航行：速度极曲线由力平衡得到（6 / 10 / 16 kn 真风）', () => {
  // ORC 证书 Beneteau Evasion 28（非球帆）：TWA → [6, 10, 16 kn 真风时的船速 kn]
  const orc = { 52: [3.80, 4.99, 5.88], 60: [4.10, 5.34, 6.11], 75: [4.30, 5.63, 6.31], 90: [4.27, 5.67, 6.46], 120: [3.74, 5.25, 6.34], 150: [2.85, 4.39, 5.94] };
  const orcBeat = [47.2, 44.9, 45.8];
  const sets = { 6: [30, 40, 45, 52, 60, 90, 120, 150, 180], 10: [25, 30, 35, 40, 45, 52, 60, 75, 90, 120, 150, 180], 16: [30, 35, 40, 45, 52, 60, 90, 120, 150, 180] };
  const rows = [];
  for (const [w, twas] of Object.entries(sets)) {
    const res = {};
    for (const a of twas) res[a] = steady(+w, a);
    const beat = twas.filter((a) => a <= 60).reduce((b, a) => (res[a].vmg > res[b].vmg ? a : b));
    const vmax = Math.max(...twas.map((a) => res[a].v));
    const wi = { 6: 0, 10: 1, 16: 2 }[w];
    rows.push(`  TWS ${w} kn：` + twas.map((a) => `${a}°:${res[a].v.toFixed(2)}`).join(' ') + `\n            最佳迎风 ${beat}°（ORC ${orcBeat[wi]}°）VMG ${res[beat].vmg.toFixed(2)} kn，漂角 ${res[beat].lee.toFixed(1)}°，横倾 ${res[beat].heel.toFixed(1)}°，舵 ${res[beat].helm.toFixed(1)}°，flat ${res[beat].flat.toFixed(2)}；最高 ${vmax.toFixed(2)} kn`);
    // 迎风：过于贴风（30° 以内）VMG 下降；最佳 VMG 角在 35–50°
    within(beat, 35, 50, `TWS ${w} 最佳迎风角`);
    assert.ok(res[30].vmg < res[beat].vmg, `TWS ${w}：30° 的 VMG 应低于最佳`);
    assert.ok(res[30].v < 0.85 * res[52].v, `TWS ${w}：30° 船速明显下降`);
    if (res[25]) assert.ok(res[25].vmg < 0.9 * res[beat].vmg && res[25].v < 0.7 * res[52].v, '25°：基本到不了上风');
    // 漂角、横倾
    within(res[beat].lee, 3, 7.5, `TWS ${w} 迎风漂角`);
    if (+w >= 10) within(res[beat].heel, 8, 22, `TWS ${w} 迎风横倾`);
    // 与 ORC 极曲线对比（不同船：本船帆面积 30 m² 比 36.8 m² 小、水线 8.6 m 比约 7.3 m 长）：横风到尾风 ±25%
    for (const a of [60, 90, 120, 150]) if (res[a]) near(res[a].v / orc[a][wi], 1, 0.25, `TWS ${w} TWA ${a} 对 ORC`);
    if (+w === 16) {
      // 强风：船速饱和在船体速度附近（Fn ≈ 0.4），自动调帆压平 / 缩帆把横倾限制在 20° 左右
      within(Math.max(...twas.map((a) => res[a].Fn)), 0.37, 0.43, '16 kn 最高 Fn');
      assert.ok(res[beat].flat < 0.97 || res[beat].reef < 0.97, '16 kn 迎风应自动减力');
    }
  }
  console.log(rows.join('\n'));
});

test('固有周期：升沉 1.5–3 s、横摇 3–5 s，自由衰减', () => {
  const run = (kind) => {
    const y = new SailingYacht();
    if (kind === 'heave') y.reset({ y: 0.1 }); else y.reset({ heel: 10 * DEG });
    const s = [];
    for (let i = 0; i < 120 * 30; i++) { y.step(1 / 120, {}); s.push([y.time, kind === 'heave' ? y.state.cg.y - y.cg[1] : y.telemetry.heel]); }
    const up = [], pk = [];
    for (let i = 1; i < s.length - 1; i++) {
      if (s[i - 1][1] < 0 && s[i][1] >= 0) up.push(s[i - 1][0] + (s[i][0] - s[i - 1][0]) * -s[i - 1][1] / (s[i][1] - s[i - 1][1]));
      if (s[i][1] > s[i - 1][1] && s[i][1] >= s[i + 1][1] && s[i][1] > 0) pk.push(s[i][1]);
    }
    return { T: (up[3] - up[0]) / 3, ratio: pk[1] / pk[0], zeta: Math.log(pk[0] / pk[1]) / (2 * Math.PI), y };
  };
  const h = run('heave'), r = run('roll');
  console.log(`  升沉 T = ${h.T.toFixed(2)} s，ζ ≈ ${h.zeta.toFixed(3)}；横摇 T = ${r.T.toFixed(2)} s，ζ ≈ ${r.zeta.toFixed(3)}；理论估计 ${JSON.stringify(h.y.naturalPeriods, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v))}`);
  within(h.T, 1.5, 3.0, '升沉周期'); within(r.T, 3.0, 5.0, '横摇周期');
  assert.ok(h.ratio < 0.8 && r.ratio < 0.9, '振荡衰减');
  near(h.T, h.y.naturalPeriods.heave, 0.2, '升沉周期与 √((m + A33)/ρgAw) 一致');
});

test('规则波：升沉 RAO 在长波中 → 1，在短波中 → 小（船长平均）', () => {
  const rao = (lambda, a) => {
    const y = new SailingYacht(), oc = new AiryOcean({ amplitude: a, wavelength: lambda, direction: -Math.PI / 2 });  // 迎浪
    y.setControls({ mode: 'heading', target: 0 });
    const T = Math.max(40, 12 * oc.period);
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < T; t += 1 / 120) {
      oc.time = t; y.step(1 / 120, { ocean: oc, waveNumber: oc.k });
      if (t > T - 6 * oc.period) { lo = Math.min(lo, y.state.cg.y); hi = Math.max(hi, y.state.cg.y); }
    }
    return (hi - lo) / 2 / a;
  };
  const r = { 150: rao(150, 0.5), 8.6: rao(8.6, 0.1), 2.5: rao(2.5, 0.03) };
  console.log(`  升沉 RAO：λ/L = 17 → ${r[150].toFixed(3)}，λ/L = 1 → ${r[8.6].toFixed(3)}，λ/L = 0.29 → ${r[2.5].toFixed(3)}`);
  within(r[150], 0.9, 1.15, '长波 RAO'); assert.ok(r[8.6] < 0.8, '船长波 RAO'); assert.ok(r[2.5] < 0.25, '短波 RAO');
});

test('迎风换舷：完成换舷并重新加速到原速', () => {
  const wind = windOf(10), y = new SailingYacht();
  y.setControls({ mode: 'twa', target: 45 * DEG, tack: 'port' });
  y.reset({ yaw: windFrom(wind) - 45 * DEG, speed: 2.5 });
  for (let i = 0; i < 60 * 70; i++) y.step(1 / 60, { wind });
  const v0 = y.telemetry.speedKn;
  assert.ok(y.telemetry.twa < 0 && y.sail.side === -1, '左舷受风，帆在右舷');
  assert.equal(y.tack(), 'tack');
  let done = null, vmin = Infinity, maxTwa = 0;
  for (let i = 0; i < 60 * 70; i++) {
    y.step(1 / 60, { wind });
    const t = y.telemetry;
    vmin = Math.min(vmin, t.speedKn);
    if (done === null && t.twa > 0 && Math.abs(t.twa - 45) < 8 && !y.autopilot.turning) done = y.time;
    if (done !== null) maxTwa = Math.max(maxTwa, t.twa);
  }
  const v1 = y.telemetry.speedKn;
  console.log(`  换舷用时 ${(done - 70).toFixed(1)} s，最低 ${vmin.toFixed(2)} kn（原 ${v0.toFixed(2)}），70 s 后 ${v1.toFixed(2)} kn，最大真风角 ${maxTwa.toFixed(1)}°`);
  assert.ok(done !== null && done - 70 < 40, '换舷在 40 s 内完成');
  assert.ok(y.sail.side === 1 && y.telemetry.tack === 'starboard', '右舷受风，帆换到左舷');
  assert.ok(vmin > 0.3 * v0, '换舷中没有停住');
  assert.ok(v1 > 0.92 * v0, '重新加速到原速');
  assert.ok(maxTwa < 60, '没有大幅冲过头');
});

test('波浪中航行：砰击 / 飞溅事件、尾迹源、帆的外观状态', () => {
  // 浪从上风来、船以真风角 60° 迎浪偏 60° 航行：1 m 高、22 m 长的陡浪（ka ≈ 0.14），船首周期性砸浪
  const wind = windOf(16), y = new SailingYacht(), oc = new AiryOcean({ amplitude: 0.5, wavelength: 22, direction: Math.PI / 2 });
  y.setControls({ mode: 'twa', target: 60 * DEG, tack: 'port' });
  y.reset({ yaw: windFrom(wind) - 60 * DEG, speed: 3 });
  let n = 0, jetOk = 0;
  for (let i = 0; i < 60 * 40; i++) {
    oc.time += 1 / 60; y.step(1 / 60, { ocean: oc, wind, waveNumber: oc.k });
    if (y.time < 10) continue;
    for (const e of y.events) {
      n++;
      assert.ok(Number.isFinite(e.position.x + e.velocity.y + e.intensity) && e.intensity >= 0 && e.intensity <= 1);
      if (e.speed > 0) jetOk++;
    }
  }
  assert.ok(n > 20 && jetOk === n, `砰击事件 ${n}`);
  within(Math.abs(y.telemetry.twa), 45, 75, '浪里仍保持真风角');
  assert.ok(y.telemetry.speedKn > 4, '浪里仍在航行');
  const w = y.wake;
  near(w.kelvinAngle / DEG, 19.47, 0.01); near(w.angle, wakeAngle(w.Fn), 1e-12);
  assert.ok(w.amplitude > 0 && w.strength > 0 && w.speed > 1);
  const s = y.sail;
  assert.ok([1, -1].includes(s.side) && Math.abs(s.boomAngle) < 1.5 && s.fill >= 0 && s.fill <= 1 && s.luff >= 0 && s.luff <= 1);
  // Rabaud & Moisy：Fn > 0.6 时表观尾迹角 ∝ 1/Fn
  near(wakeAngle(0.3) / DEG, 19.47, 0.01); near(wakeAngle(1.0) / DEG, 11.5, 0.1); near(wakeAngle(2.0) * 2, wakeAngle(1.0), 0.005);
});

test('经验公式：ITTC-1957、Charnock 风廓线、Helmbold 升力线', () => {
  near(ittc57(1e7), 0.075 / 25, 1e-12, 'C_F(1e7)');
  const w = windProfile(10);
  within(w.cd10, 1.0e-3, 1.6e-3, 'C_D10（10 m/s）'); within(w.at(5) / 10, 0.9, 0.97, 'U(5 m)/U10');
  near(w.z0 / (0.0144 * w.ustar ** 2 / G + 0.11 * 1.5e-5 / w.ustar), 1, 1e-6, 'Charnock z0 = α u*²/g + 0.11 ν/u*');
  near(w.ustar, 0.4 * 10 / Math.log(10 / w.z0), 1e-6, 'U10 = (u*/κ) ln(10/z0)');
  const ll = (A) => 2 * Math.PI * A / (A + 2);
  near(helmbold(6) / ll(6), 1, 0.08, 'A = 6：Helmbold ≈ 升力线'); near(helmbold(0.1) / (Math.PI * 0.1 / 2), 1, 0.02, 'A → 0：Jones 细长翼');
});

test('性能：120 Hz 子步远低于 1 ms（规则波，含水速采样）', () => {
  const y = new SailingYacht(), oc = new AiryOcean({ amplitude: 0.4, wavelength: 30 }), wind = windOf(12);
  y.setControls({ mode: 'twa', target: 60 * DEG, tack: 'port' });
  for (let i = 0; i < 240; i++) { oc.time += 1 / 120; y.step(1 / 120, { ocean: oc, wind }); }   // 预热
  const N = 2400, t0 = performance.now();
  for (let i = 0; i < N; i++) { oc.time += 1 / 120; y.step(1 / 120, { ocean: oc, wind }); }
  const ms = (performance.now() - t0) / N;
  console.log(`  每个 1/120 s 步：${ms.toFixed(3)} ms`);
  assert.ok(ms < 1, `${ms} ms`);
});

test('辅机：平静水面全速正车 5–6 kn、推力 = 阻力；倒车后退；油门为 0 时与没有辅机逐位相同', () => {
  const ocean = new FlatOcean();
  const y = new SailingYacht();
  y.setControls({ mode: 'heading', target: 0, motor: 1 });
  y.reset({ yaw: 0 });
  for (let i = 0; i < 60 * 90; i++) y.step(1 / 60, { ocean });
  const t = y.telemetry;
  console.log(`  全速正车 ${t.speedKn.toFixed(2)} kn，推力 ${t.thrust.toFixed(0)} N，总阻力 ${t.resistance.total.toFixed(0)} N，纵倾 ${t.pitch.toFixed(2)}°`);
  within(t.speedKn, 5, 6.2, '全速正车航速（kn）');
  near(t.thrust / t.resistance.total, 1, 0.05, '稳态：推力 = 阻力');
  assert.ok(t.thrust < y.motor.thrust, '推力随航速下降（低于系柱推力）');
  // 倒车：先刹住，再向后走
  y.setControls({ motor: -1 });
  for (let i = 0; i < 60 * 60; i++) y.step(1 / 60, { ocean });
  const v = y.state.velocity, surge = v.x * Math.sin(y.telemetry.yaw) + v.z * Math.cos(y.telemetry.yaw);
  console.log(`  全速倒车 ${(surge / KN).toFixed(2)} kn（负 = 后退）`);
  within(surge / KN, -4.5, -2, '倒车航速（kn）');
  // 油门 0：与从没碰过辅机的船逐位相同（风中航行 30 s）
  const wind = windOf(10), a = new SailingYacht(), b = new SailingYacht();
  for (const s of [a, b]) { s.setControls({ mode: 'twa', target: 60 * DEG, tack: 'port' }); s.reset({ yaw: windFrom(wind) - 60 * DEG, speed: 2.5 }); }
  b.setControls({ motor: 0 });
  for (let i = 0; i < 60 * 30; i++) { a.step(1 / 60, { wind }); b.step(1 / 60, { wind }); }
  assert.deepEqual(b.state, a.state, '油门 0 不改变任何状态');
  assert.equal(b.telemetry.thrust, 0);
  // 低速舵效：漂着几乎不动时满舵转不动，开正车后滑流冲到舵上就能转
  const c = new SailingYacht();
  c.setControls({ mode: 'manual', rudder: 30 * DEG });
  c.reset({ yaw: 0, speed: 0.3 });
  for (let i = 0; i < 60 * 6; i++) c.step(1 / 60, { ocean });
  const r0 = Math.abs(c.telemetry.yawRate);
  c.setControls({ motor: 1 });
  for (let i = 0; i < 60 * 6; i++) c.step(1 / 60, { ocean });
  const r1 = Math.abs(c.telemetry.yawRate);
  console.log(`  满舵：漂流 ${r0.toFixed(2)}°/s，开正车 6 s 后 ${r1.toFixed(1)}°/s`);
  assert.ok(r0 < 1.5 && r1 > 5 * Math.max(r0, 0.5), '正车滑流给舵效');
});

test('触底：冲上缓坡停住、撞上陡岸弹回不发散；深水里与不给地形逐位相同', () => {
  const ny = (slope) => 1 / Math.hypot(1, slope);
  const depthAlongNormal = (y, ground, slope) => {
    // 接触点在地面以下的最大深度（沿法线）
    const s = y.state, q = s.quaternion, { x, y: qy, z, w } = q;
    const R = [1 - 2 * (qy * qy + z * z), 2 * (x * qy - w * z), 2 * (x * z + w * qy), 2 * (x * qy + w * z), 1 - 2 * (x * x + z * z), 2 * (qy * z - w * x), 2 * (x * z - w * qy), 2 * (qy * z + w * x), 1 - 2 * (x * x + qy * qy)];
    let m = 0;
    for (const c of y.contactPoints) {
      const r = c.r, px = s.position.x + R[0] * r[0] + R[1] * r[1] + R[2] * r[2], py = s.position.y + R[3] * r[0] + R[4] * r[1] + R[5] * r[2], pz = s.position.z + R[6] * r[0] + R[7] * r[1] + R[8] * r[2];
      m = Math.max(m, (ground(px, pz) - py) * ny(slope));
    }
    return m;
  };
  const finite = (y) => [y.state.position.x, y.state.position.y, y.state.velocity.x, y.state.velocity.y, y.state.quaternion.w, y.state.angularVelocity.y].every(Number.isFinite);
  // 风从北来，船以真风角 90° 向东（+X）全速驶向一道岸坡：x > 40 后地面按 slope 升高
  const run = (slope, kn, T) => {
    const y = new SailingYacht(), wind = windOf(kn), ground = (x) => Math.min(5, -10 + Math.max(0, x - 40) * slope);
    y.setControls({ mode: 'twa', target: 90 * DEG, tack: 'port' });
    y.reset({ x: 0, yaw: Math.PI / 2, speed: 3 });
    const r = { first: null, vIn: 0, vMinAfter: Infinity, rebound: 0, pen: 0, xmax: -Infinity, ok: true, heel: 0 };
    for (let i = 0; i < 60 * T; i++) {
      const vx0 = y.state.velocity.x;
      y.step(1 / 60, { wind, ground });
      if (!finite(y)) { r.ok = false; break; }
      if (y.ground.contact && r.first === null) { r.first = y.time; r.vIn = vx0; }
      if (r.first !== null && y.time < r.first + 5) { r.vMinAfter = Math.min(r.vMinAfter, Math.hypot(y.state.velocity.x, y.state.velocity.z)); r.rebound = Math.min(r.rebound, y.state.velocity.x); }
      r.pen = Math.max(r.pen, depthAlongNormal(y, ground, slope)); r.xmax = Math.max(r.xmax, y.state.position.x); r.heel = Math.max(r.heel, Math.abs(y.telemetry.heel));
    }
    return r;
  };
  const a = run(0.25, 12, 45);      // 1:4 沙坡
  console.log(`  1:4 坡：${(a.vIn / KN).toFixed(1)} kn 冲上去，5 s 内最低 ${a.vMinAfter.toFixed(2)} m/s，最远 x = ${a.xmax.toFixed(1)} m（水线在 x = 80），压入 ${(a.pen * 100).toFixed(1)} cm，最大横倾 ${a.heel.toFixed(0)}°`);
  assert.ok(a.ok && a.first !== null, '应当触底且不出现 NaN');
  assert.ok(a.vMinAfter < 0.3, '触底后停住');
  assert.ok(a.xmax < 80, '没有冲上干岸');
  assert.ok(a.pen < 0.15, '压入地面不超过 15 cm');
  const b = run(3, 16, 25);         // 3:1 陡岸，船首直撞
  console.log(`  3:1 陡岸：撞击 ${b.vIn.toFixed(2)} m/s，弹回 ${(-b.rebound).toFixed(2)} m/s，压入 ${(b.pen * 100).toFixed(1)} cm`);
  assert.ok(b.ok && b.first !== null);
  assert.ok(-b.rebound < 0.3 * b.vIn, '弹回速度远小于撞击速度（不会被弹飞）');
  assert.ok(b.pen < 0.4, '压入陡岸不超过 40 cm');
  // 瞬移进陆地（龙骨在地下 3.4 m）：被慢慢推出来
  const c = new SailingYacht();
  c.reset({ y: -1 });
  let vmax = 0;
  for (let i = 0; i < 60 * 15; i++) { c.step(1 / 60, { ground: () => 1 }); assert.ok(finite(c)); vmax = Math.max(vmax, Math.hypot(c.state.velocity.x, c.state.velocity.y, c.state.velocity.z)); }
  assert.ok(vmax < 4, `被推出地面的速度 ${vmax}`);
  // 深水（−36 m）：粗检跳过接触计算，结果与不给地形逐位相同
  const wind = windOf(12), d = new SailingYacht(), e = new SailingYacht();
  for (const s of [d, e]) { s.setControls({ mode: 'twa', target: 70 * DEG, tack: 'port' }); s.reset({ yaw: windFrom(wind) - 70 * DEG, speed: 3 }); }
  for (let i = 0; i < 60 * 20; i++) { d.step(1 / 60, { wind }); e.step(1 / 60, { wind, ground: () => -36 }); }
  assert.deepEqual(e.state, d.state);
  assert.equal(e.ground.contact, false);
});
