// =====================================================================================
// Foils —— 龙骨、舵、船体（低展弦比升力体）的有限翼展翼型模型
//
// 升力线斜率：Helmbold (1942) 公式  C_Lα = 2π A / (2 + √(A² + 4))
//   A ≳ 3 时与 Prandtl 升力线 2π A/(A + 2) 相差 < 10%（舵、鳍龙骨）；A → 0 时趋于 Jones 细长翼 πA/2
//   （长龙骨、船体）。龙骨贴在船底，船体相当于端板，有效展弦比 A_e = k_ep · 2 b²/S（k_ep ≈ 0.9）；
//   舵穿出水面，低 Fn 时自由面也起端板作用（k_ep ≈ 0.8）。
// 失速：|α| 超过 α_s 后在 10° 内过渡到平板法向力模型 C_N = C_D90 sin α（C_L = C_N cos α，C_D = C_N sin α），
//   α_s = 14° + 16°·e^{−A_e}（高展弦比舵约 14°，展弦比 < 1 的长龙骨失速晚得多，约 25°）。
//   全 360° 有定义：零速横漂、倒车、掉头时自动变成横流阻力，这正是低速横摇 / 偏航阻尼的来源。
// 阻力：C_D = C_D0 + C_L² / (π e A_e)（诱导阻力，e = 0.9），C_D0 = 2 C_F(Re_c)(1 + 2 t/c + 60 (t/c)⁴)
//   （Hoerner 形状因子，两面湿面积）。
// 下洗：舵位于龙骨尾流中，入流角减去 ε = κ · C_L,keel / (π A_e,keel)（κ ≈ 1，介于翼面处与远尾流的 2 倍之间）。
// 来流：翼型参考点（平均弦 1/4 弦点）处的相对水流速度，含船的角速度 ω × r 与水质点轨道速度，
//   所以横摇时龙骨产生阻尼力，偏航时舵产生阻尼力矩，浪里的轨道速度改变攻角 —— 都是自然结果。
// =====================================================================================
import { ittc57, WATER } from './Resistance.js';
import { smoothstep } from './interp.js';

export const helmbold = (A) => 2 * Math.PI * A / (2 + Math.sqrt(A * A + 4));
export const DEG = Math.PI / 180;

export class Foil {
  /**
   * opts: { name, area, span, chord（平均弦）, ref: [x, y, z]（参考点：前缘处，取在面积形心高度）,
   *         arEff, tc（厚弦比）, stallDeg, cd90, e, rudder（是否可转）, cpFraction（压力中心在弦长上的位置）}
   */
  constructor(o) {
    Object.assign(this, { e: 0.9, tc: 0.1, cd90: 1.2, cpFraction: 0.25, rudder: false, profile: true }, o);
    this.ar = this.span * this.span / this.area;
    this.slope = helmbold(this.arEff);
    this.stall = (this.stallDeg ?? (14 + 16 * Math.exp(-this.arEff))) * DEG;
    this.formFactor = 1 + 2 * this.tc + 60 * this.tc ** 4;
    this.cp0 = [this.ref[0], this.ref[1], this.ref[2] - this.cpFraction * this.chord];   // 来流取样点（零舵角的 1/4 弦点）
    this.out = { fx: 0, fz: 0, px: 0, py: 0, pz: 0, cl: 0, cd: 0, cdi: 0, alpha: 0, q: 0, lift: 0, drag: 0, induced: 0, profile: 0 };
  }

  /** 升力、阻力系数（α：弧度，−π … π）；同时给出诱导阻力系数 */
  coefficients(alpha, U) {
    const a = Math.abs(alpha), s = Math.sign(alpha) || 1;
    // 附着流
    const aLin = Math.min(a, this.stall);
    const clLin = this.slope * aLin * (1 - 0.15 * smoothstep(this.stall * 0.6, this.stall, a));   // 接近失速时斜率略降
    const cdi = clLin * clLin / (Math.PI * this.e * this.arEff);
    let cd0 = 0;
    if (this.profile && U > 1e-3) cd0 = 2 * ittc57(U * this.chord / WATER.nu) * this.formFactor;
    // 分离流（平板）
    const sn = Math.sin(a), cs = Math.cos(a);
    const clFp = this.cd90 * sn * cs, cdFp = this.cd90 * sn * sn;
    const w = smoothstep(this.stall, this.stall + 10 * DEG, a);
    const cl = s * ((1 - w) * clLin + w * clFp);
    const cd = cd0 + (1 - w) * cdi + w * cdFp;
    return { cl, cd, cdi: (1 - w) * cdi, cd0 };
  }

  /**
   * vx, vz：参考点相对水的速度（船体坐标，翼型平面内）；delta：舵角（左舷为正：后缘偏向 +X）；
   * downwash：下洗角（弧度，与龙骨升力同号）；immersion：浸没比例（0–1，按湿面积）。
   * 结果（船体坐标）写入 this.out：力 (fx, 0, fz) 与作用点 (px, py, pz)
   */
  evaluate(vx, vz, delta = 0, downwash = 0, immersion = 1, rho = WATER.rho) {
    const o = this.out;
    const wx = -vx, wz = -vz, U = Math.hypot(wx, wz);
    if (U < 1e-6 || immersion <= 0) { o.fx = o.fz = 0; o.cl = o.cd = o.alpha = o.q = o.lift = o.drag = o.induced = o.profile = 0; this._cp(0, delta); return o; }
    const ux = wx / U, uz = wz / U;
    // 弦向（前缘 → 后缘）：龙骨 (0, −1)；舵 (sin δ, −cos δ)
    const cx = Math.sin(delta), cz = -Math.cos(delta);
    let alpha = Math.atan2(cx * uz - cz * ux, cx * ux + cz * uz);
    alpha -= downwash;
    if (alpha > Math.PI) alpha -= 2 * Math.PI; else if (alpha < -Math.PI) alpha += 2 * Math.PI;
    const c = this.coefficients(alpha, U);
    const q = 0.5 * rho * U * U, S = this.area * immersion;
    // 升力垂直于来流（ŵ 逆时针转 90°），阻力沿来流
    const L = q * S * c.cl, D = q * S * c.cd;
    o.fx = L * -uz + D * ux; o.fz = L * ux + D * uz;
    o.cl = c.cl; o.cd = c.cd; o.alpha = alpha; o.q = q; o.lift = L; o.drag = D;
    o.induced = q * S * c.cdi; o.profile = q * S * c.cd0;
    this._cp(smoothstep(this.stall, this.stall + 10 * DEG, Math.abs(alpha)), delta);
    return o;
  }

  // 压力中心：附着流在 1/4 弦，完全分离时移到 1/2 弦
  _cp(sep, delta) {
    const f = this.cpFraction + 0.25 * sep, d = f * this.chord, o = this.out;
    o.px = this.ref[0] + Math.sin(delta) * d; o.py = this.ref[1]; o.pz = this.ref[2] - Math.cos(delta) * d;
  }

  /** 在参考点附近的升力线斜率（给调帆的横向阻力中心估计用） */
  get liftArea() { return this.slope * this.area; }
}

/** 由 (z, y) 轮廓多边形求 y 处的弦（前缘 z、后缘 z） */
export function chordAt(outline, y) {
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [z0, y0] = outline[i], [z1, y1] = outline[(i + 1) % outline.length];
    if ((y0 - y) * (y1 - y) > 0 || y0 === y1) continue;
    const t = (y - y0) / (y1 - y0), z = z0 + t * (z1 - z0);
    zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
  }
  return zmax > zmin ? { le: zmax, te: zmin, chord: zmax - zmin } : null;
}

/** 轮廓在 y < yCut 部分的面积、形心、展长 */
export function submergedPlanform(outline, yCut = 0) {
  // 用水平条带积分
  let ymin = Infinity, ymax = -Infinity;
  for (const [, y] of outline) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
  const top = Math.min(ymax, yCut), n = 80;
  let A = 0, Ay = 0, Az = 0;
  for (let i = 0; i < n; i++) {
    const y = ymin + (top - ymin) * (i + 0.5) / n, c = chordAt(outline, y);
    if (!c) continue;
    const dA = c.chord * (top - ymin) / n;
    A += dA; Ay += dA * y; Az += dA * (c.le + c.te) / 2;
  }
  return { area: A, yc: Ay / A, zc: Az / A, span: top - ymin, top, bottom: ymin };
}

