// =====================================================================================
// Resistance —— 光体阻力：ITTC-1957 摩擦线 + DSYHS 剩余（兴波）阻力
//
// 摩擦：ITTC-1957 模型–实船相关线  C_F = 0.075 / (log₁₀ Re − 2)²，Re = V · 0.7 L_WL / ν
//   （0.7 L_WL 是 DSYHS / ORC 对帆船船体取的参考长度）。形状因子 1 + k = 1.05（ORC VPP 对光体的取值）。
//   摩擦力在 Hydrostatics 里按每块浸水面元的切向相对流速分布计算；这里只给系数。
//
// 剩余阻力：Delft Systematic Yacht Hull Series（DSYHS）回归，Keuning & Katgert (2008)
//   "A bare hull resistance prediction method derived from the results of the DSYHS extended to higher speeds"
//   （系数表转引自 Fossati, Aero-Hydrodynamics and the Performance of Sailing Yachts, 2009, Table 2.5；
//   开源 VPP python-vpp 的 dat/wr.dat 同一张表）：
//     Rr / (ρ g ∇c) = a0 + (∇c^{1/3} / L_WL) · ( a1·LCB_fpp/L_WL + a2·Cp + a3·∇c^{2/3}/Aw + a4·B_WL/L_WL
//                                              + a5·LCB_fpp/LCF_fpp + a6·B_WL/Tc + a7·Cm )
//   Fn = 0.15 … 0.75。Fn ≈ 0.4（“船体速度”）以上兴波阻力陡增，船速因此饱和 —— 这是回归数据本身的性质。
//   横倾：ORC VPP 的舷边入水修正 Rr·(1 + 0.0004 (φ − 30°)²)（φ > 30°）。横倾导致的湿面积、
//   水线不对称由面元积分自动得到。
// =====================================================================================
import { HullShape } from './HullShape.js';
import { pchip } from './interp.js';

export const WATER = { rho: 1025, nu: 1.19e-6 };     // 15 °C 海水（ITTC 1.1892e-6 m²/s）
export const HULL_FORM_FACTOR = 1.05;

/** ITTC-1957 摩擦系数 */
export function ittc57(Re) {
  const r = Math.max(Re, 1e5);
  const l = Math.log10(r) - 2;
  return 0.075 / (l * l);
}

// Keuning & Katgert (2008) 系数：每行 [Fn, a0 … a7]
export const DSYHS_2008 = [
  [0.15, -0.0005, 0.0023, -0.0086, -0.0015, 0.0061, 0.0010, 0.0001, 0.0052],
  [0.20, -0.0003, 0.0059, -0.0064, 0.0070, 0.0014, 0.0013, 0.0005, -0.0020],
  [0.25, -0.0002, -0.0156, 0.0031, -0.0021, -0.0070, 0.0148, 0.0010, -0.0043],
  [0.30, -0.0009, 0.0016, 0.0337, -0.0285, -0.0367, 0.0218, 0.0015, -0.0172],
  [0.35, -0.0026, -0.0567, 0.0446, -0.1091, -0.0707, 0.0914, 0.0021, -0.0078],
  [0.40, -0.0064, -0.4034, -0.1250, 0.0273, -0.1341, 0.3578, 0.0045, 0.1115],
  [0.45, -0.0218, -0.5261, -0.2945, 0.2485, -0.2428, 0.6293, 0.0081, 0.2086],
  [0.50, -0.0388, -0.5986, -0.3038, 0.6033, -0.0430, 0.8332, 0.0106, 0.1336],
  [0.55, -0.0347, -0.4764, -0.2361, 0.8726, 0.4219, 0.8990, 0.0096, -0.2272],
  [0.60, -0.0361, 0.0037, -0.2960, 0.9661, 0.6123, 0.7534, 0.0100, -0.3352],
  [0.65, 0.0008, 0.3728, -0.3667, 1.3957, 1.0343, 0.3230, 0.0072, -0.4632],
  [0.70, 0.0108, -0.1238, -0.2026, 1.1282, 1.1836, 0.4973, 0.0038, -0.4477],
  [0.75, 0.1023, 0.7726, 0.5040, 1.7867, 2.1934, -1.5479, -0.0115, -0.0977],
];

/**
 * 由型线（不是粗网格）数值积分得到 DSYHS 用的船型参数（正浮、设计水线 y = wl）。
 * 也给出侧投影面积等，供船体升力模型使用。
 */
export function hullFormParameters(p, { shape = HullShape, wl = 0, n = 400 } = {}) {
  const L = p.length;
  const sec = (s) => {
    // 截面（水线以下）面积与水线半宽：沿 θ 积分超椭圆
    const N = 160; let A = 0, bwl = 0, prev = shape.section(p, s, 0);
    if (prev[1] >= wl) return { A: 0, b: 0 };
    for (let i = 1; i <= N; i++) {
      let cur = shape.section(p, s, i / N * Math.PI / 2);
      if (cur[1] >= wl) { const t = (wl - prev[1]) / (cur[1] - prev[1]); cur = [prev[0] + t * (cur[0] - prev[0]), wl]; bwl = cur[0]; A += (prev[0] + cur[0]) * (cur[1] - prev[1]); break; }
      A += (prev[0] + cur[0]) * (cur[1] - prev[1]); prev = cur;
    }
    return { A, b: bwl };
  };
  let V = 0, Vz = 0, Aw = 0, Awz = 0, Am = 0, B = 0, Tc = 0, sMin = 1, sMax = 0, IT = 0, lat = 0, latZ = 0;
  const rows = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, w = i === 0 || i === n ? 0.5 : 1, dz = L / n * w, z = shape.zAt(p, s);
    const { A, b } = sec(s), T = Math.max(0, wl - shape.keel(p, s));
    rows.push([z, A, b]);
    V += A * dz; Vz += A * z * dz; Aw += 2 * b * dz; Awz += 2 * b * z * dz; IT += (2 / 3) * b * b * b * dz;
    lat += T * dz; latZ += T * z * dz;
    if (A > 1e-6) { sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); }
    Am = Math.max(Am, A); B = Math.max(B, 2 * b); Tc = Math.max(Tc, T);
  }
  const LCB = Vz / V, LCF = Awz / Aw, LWL = (sMax - sMin) * L, zFPP = shape.zAt(p, sMax);
  let IL = 0; for (const [z, , b] of rows) IL += 2 * b * (z - LCF) ** 2 * (L / n);
  const Cm = Am / (B * Tc), Cp = V / (Am * LWL);
  return {
    LWL, BWL: B, Tc, volume: V, Aw, Am, Cp, Cm, Cb: V / (LWL * B * Tc),
    LCB, LCF, LCBfpp: zFPP - LCB, LCFfpp: zFPP - LCF, zFPP, zAPP: shape.zAt(p, sMin),
    IT, IL, BMt: IT / V, BMl: IL / V,
    // DSYHS 湿表面积公式（Keuning & Sonnenberg 1998）：Sc = (1.97 + 0.171 B/T)(0.65/Cm)^{1/3} √(∇ L)
    wettedAreaDSYHS: (1.97 + 0.171 * B / Tc) * Math.cbrt(0.65 / Cm) * Math.sqrt(V * LWL),
    lateralArea: lat, lateralCentroidZ: latZ / lat,
    slenderness: LWL / Math.cbrt(V), beamDraft: B / Tc,
  };
}

/** DSYHS 剩余阻力：构造时对该船型算好各 Fn 节点的 Rr/(ρg∇)，再做单调三次插值 */
export class ResiduaryResistance {
  constructor(form, { rho = WATER.rho, g = 9.81 } = {}) {
    this.form = form; this.rho = rho; this.g = g;
    const f = form, r = Math.cbrt(f.volume) / f.LWL;
    const terms = [f.LCBfpp / f.LWL, f.Cp, Math.pow(f.volume, 2 / 3) / f.Aw, f.BWL / f.LWL, f.LCBfpp / f.LCFfpp, f.BWL / f.Tc, f.Cm];
    const fn = [0], c = [0];
    for (const row of DSYHS_2008) {
      let s = 0; for (let i = 0; i < 7; i++) s += row[i + 2] * terms[i];
      fn.push(row[0]); c.push(Math.max(0, row[1] + r * s));
    }
    // Fn < 0.15：兴波阻力 ∝ Fn⁴ 地趋于 0（插值节点 0.075 处取 1/16）
    fn.splice(1, 0, 0.075); c.splice(1, 0, c[1] / 16);
    this.table = { fn, c };
    this._f = pchip(fn, c);
  }
  /** 剩余阻力系数 Rr/(ρ g ∇) */
  coefficient(Fn) {
    const t = this.table, last = t.fn[t.fn.length - 1];
    if (Fn <= 0) return 0;
    // 表外（Fn > 0.75，大浪里冲浪）：排水型船体的阻力不再有兴波峰谷，按 ∝ V² 外推（系数 ∝ Fn²）
    if (Fn > last) return Math.max(t.c[t.c.length - 1], t.c[t.c.length - 2]) * (Fn / last) ** 2;
    return Math.max(0, this._f(Fn));
  }
  /** 剩余阻力（N）：Fn、当前排水体积、横倾（弧度） */
  force(Fn, volume = this.form.volume, heel = 0) {
    const phi = Math.abs(heel) * 180 / Math.PI;
    const k = phi > 30 ? 1 + 0.0004 * (phi - 30) ** 2 : 1;
    return this.coefficient(Fn) * this.rho * this.g * volume * k;
  }
}
