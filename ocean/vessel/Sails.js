// =====================================================================================
// Sails —— 帆的空气动力（ORC / IMS VPP 帆系数模型）+ 近海面对数风廓线 + VPP 式自动调帆
//
// 风廓线：近中性大气表面层的对数律 U(z) = (u*/κ) ln(z/z₀)，κ = 0.40；
//   海面粗糙度用 Charnock (1955) 关系 z₀ = α u*²/g（α 默认 0.0144，开阔海 0.011 … 近岸 / 年轻风浪 0.018），
//   再加光滑流极限 0.11 ν/u*（Smith 1988）。给定 10 m 风速 U10，迭代解 u*（等价于 u*² = C_D U10²，
//   C_D = [κ / ln(10/z₀)]²，10 m/s 时 C_D ≈ 1.2×10⁻³，与 Large & Pond 1981 一致）。
//
// 视风：在每面帆的受力中心处，真风（该高度的风速）减去该点的速度 v + ω × r，所以横摇、纵摇会让视风周期性变化。
//   横倾时只有垂直于桅杆的分量产生帆力（把视风换到船体坐标后丢掉沿桅分量）——即 VPP 里的
//   “有效视风角” tan β_eff = tan β · cos φ 与动压 cos² 修正，这里是三维投影的自然结果。
//
// 帆系数：ORC VPP（继承 IMS / Hazen 1980 模型）的主帆、前帆 C_L(β)、C_D(β) 表，“low” 一组即 Larsson &
//   Eliasson《Principles of Yacht Design》所列 IMS 系数（主帆 0.862 / 1.052 / 1.164 / 1.347 …；
//   前帆 1.0 / 1.375 / 1.45 …）；“high” 一组是 ORC 的高性能帆系数。数据与开源 python-vpp 的 dat/orc/*.dat 一致。
//   组合：C_L = Σ C_Li A_i / A，C_Dp = Σ C_Di A_i / A，
//         C_D = C_Dp·(flat·f(flat)·f_j + 1 − f_j) + C_E·C_L²·flat²·f(flat)，C_L ← flat·C_L
//         C_E = Σ C_Li² A_i k_pi / (A C_L²) + A / (π h_eff²)    （粘性二次项 + 诱导阻力）
//   有效高度 h_eff = (b + HBI)·c_span·k_heff(β)（ORC：b = 帆装高度，HBI = 前三角底边离水高度，
//   k_heff 随视风角从 1.0 → 1.22（18°）→ 0.80（≥ 75°）；c_span 由主帆 roach、分数式比例、前帆搭接算出）。
//   flat（压平，0.5–1）降低升力与诱导阻力；reef（缩帆，0.45–1）按比例缩小帆面（面积 r²、受力中心高度 r）。
//   ORC 的 twist 函数：压平时帆顶扭开，受力中心降低。
//
// 帆脚索：系数表对应“最佳调帆”。手动 sheet 时横杆角与该视风角下的最佳角相比：放得太松 → 前缘抖帆、升力下降；
//   收得太紧 → 攻角过大、分离，阻力上升。自动模式下 sheet 取最佳角，VPP 式地在横倾上限内挑 flat / reef 使驱动力最大。
// =====================================================================================
import { pchip, clamp, smoothstep } from './interp.js';

export const AIR = { rho: 1.225, nu: 1.5e-5 };
const KAPPA = 0.4, G = 9.81, DEG = Math.PI / 180;

// ORC VPP 帆系数（视风角 β，度）
export const ORC_SAIL_COEFFS = {
  main: {
    awa: [0, 7, 9, 12, 28, 60, 90, 120, 150, 180], kp: 0.01379,
    low: { cl: [0, 0.86207, 1.05172, 1.16379, 1.34698, 1.35345, 1.26724, 0.93103, 0.38793, -0.11207],
           cd: [0.04310, 0.02586, 0.02328, 0.02328, 0.03259, 0.11302, 0.38250, 0.96888, 1.31578, 1.34483] },
    high: { cl: [0, 0.94828, 1.13793, 1.25000, 1.42681, 1.38319, 1.26724, 0.93103, 0.38793, -0.11207],
            cd: [0.03448, 0.01724, 0.01466, 0.01466, 0.02586, 0.11302, 0.38250, 0.96888, 1.31578, 1.34483] },
  },
  jib: {
    awa: [0, 7, 15, 20, 27, 50, 60, 100, 150, 180], kp: 0.016,
    low: { cl: [0, 0, 1.0, 1.375, 1.45, 1.45, 1.25, 0.4, 0, -0.1], cd: [0.003, 0.05, 0.032, 0.031, 0.037, 0.25, 0.35, 0.73, 0.95, 0.9] },
    high: { cl: [0, 0, 1.1, 1.475, 1.5, 1.45, 1.25, 0.4, 0, -0.1], cd: [0.003, 0.05, 0.032, 0.031, 0.037, 0.25, 0.35, 0.73, 0.95, 0.9] },
  },
};
// ORC 有效高度系数 k_heff(β)（β ≤ 90°）与压平阻力乘子 f(flat)
export const ORC_KHEFF = {
  awa: [0, 2.4413, 4.5316, 6.7198, 9.2673, 12.1414, 15.0155, 17.8896, 20.7637, 23.6378, 26.512, 29.3861, 32.2602, 35.1343, 38.0084, 40.8825, 43.7566, 46.6307, 49.5048, 52.3789, 55.253, 58.1271, 61.0012, 63.8753, 66.7495, 69.6236, 72.4977, 75.3718, 78.2459, 81.12, 83.9941, 86.8682, 90],
  k: [1.0058, 1.0458, 1.0853, 1.1246, 1.1625, 1.1924, 1.2129, 1.2221, 1.2177, 1.1955, 1.1621, 1.1268, 1.0936, 1.058, 1.0226, 0.9897, 0.9549, 0.9251, 0.9029, 0.8853, 0.8695, 0.855, 0.8418, 0.8298, 0.8194, 0.8108, 0.8047, 0.8013, 0.8001, 0.8001, 0.8001, 0.8006, 0.7997],
};
export const ORC_FCDMULT = { flat: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0], f: [1.06, 1.06, 1.06, 1.06, 1.06, 1.06, 1.06, 1.055, 1.048, 1.035, 1.02, 1.008, 1.002, 1.0, 1.004, 1.06] };

const kheff = pchip(ORC_KHEFF.awa, ORC_KHEFF.k), fcdmult = pchip(ORC_FCDMULT.flat, ORC_FCDMULT.f);

/** Charnock 对数风廓线：由 U10 求 u*、z₀，返回 { ustar, z0, cd10, at(z) } */
export function windProfile(U10, { charnock = 0.0144, nuAir = AIR.nu } = {}) {
  const U = Math.max(U10, 0);
  let us = Math.max(0.035 * U, 1e-3), z0 = 1e-4;
  for (let i = 0; i < 16; i++) {
    z0 = charnock * us * us / G + 0.11 * nuAir / us;
    us = Math.max(KAPPA * U / Math.log(10 / z0), 1e-4);
  }
  const ratioAt = (z) => Math.log(Math.max(z, 0.5) / z0) / Math.log(10 / z0);
  return { ustar: us, z0, cd10: (us / Math.max(U, 1e-6)) ** 2, ratioAt, at: (z) => U * ratioAt(z) };
}

/** 由 Sailboat 布置求帆装参数（面积、受力中心、ORC 尺寸） */
export function rigFromLayout(layout) {
  const m = layout.main, j = layout.jib, HBI = layout.deckY;
  // 主帆：沿桅（v）积分画面上的弦长函数
  let A = 0, Av = 0, Ad = 0; const n = 200;
  for (let i = 0; i < n; i++) { const v = (i + 0.5) / n, c = m.chord(v); A += c; Av += c * v; Ad += c * c / 2; }
  const P = m.luffLength, mainArea = A / n * P, vBar = Av / A;
  const tack = [layout.boomPivot[0], layout.boomPivot[1] + m.yOffset, layout.boomPivot[2]];
  const E = m.chord(0), BAD = tack[1] - HBI;
  // 前帆：近收紧（0.2 rad）时三个角点围成的面积
  const clewAt = (ang, side = 1) => [side * Math.sin(ang) * j.clewRadius, j.clewY, j.clewPivotZ - Math.cos(ang) * j.clewRadius];
  const T = j.tack, H = j.head, C = clewAt(0.2);
  const u = [H[0] - T[0], H[1] - T[1], H[2] - T[2]], w = [C[0] - T[0], C[1] - T[1], C[2] - T[2]];
  const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const jibArea = 0.5 * Math.hypot(...cr), luff = Math.hypot(...u);
  const I = H[1] - HBI, J = T[2] - layout.zMast, LPG = 2 * jibArea / luff, jibVce = (T[1] + H[1] + C[1]) / 3 - HBI;
  const roach = mainArea / (0.5 * P * E) - 1, fractionality = Math.min(1, I / (P + BAD)), overlap = LPG / J;
  // ORC 有效翼展修正
  const spanCorr = 1.1 + 0.08 * (roach - 0.2) + 0.5 * (0.68 + 0.31 * fractionality + 0.075 * overlap - 1.1);
  return {
    HBI, mastZ: layout.zMast, mastTop: layout.mastTop,
    main: { area: mainArea, P, E, BAD, roach, tack, vce: P * vBar, ceAft: Ad / A, sheetToAngle: m.sheetToAngle, boomLength: layout.boomLength },
    jib: { area: jibArea, I, J, LPG, vce: jibVce, tack: T, head: H, clewAt, sheetToAngle: j.sheetToAngle },
    fractionality, overlap, spanCorr, b: Math.max(P + BAD, I),
    windage: { hullHeight: 0.55, hullFbav: 1.1, mastArea: 0.13 * (layout.mastTop - layout.mastBase) + 0.4 },
  };
}

// 最佳横杆 / 前帆角（与 Sailboat.update 的自动调帆同一公式：β 0.35 rad 以上按 0.62 倍放出）
export const optimalBoom = (beta) => clamp((beta - 0.35) * 0.62, 0.06, 1.45);
export const optimalJib = (beta) => 0.12 + 0.75 * clamp((beta - 0.35) / 2.6, 0, 1);

/**
 * 帆装：每面帆在自己的受力中心处受力（船体坐标）。
 * 调用 compute() 前设好 this.flat / this.reef / this.sheet（'auto' 或 0–1）。
 */
export class Rig {
  constructor(rig, { coefficients = 'low', rhoAir = AIR.rho } = {}) {
    this.g = rig; this.rho = rhoAir;
    const M = ORC_SAIL_COEFFS.main, J = ORC_SAIL_COEFFS.jib, set = coefficients === 'high' ? 'high' : 'low';
    this.cl = { main: pchip(M.awa, M[set].cl), jib: pchip(J.awa, J[set].cl) };
    this.cd = { main: pchip(M.awa, M[set].cd), jib: pchip(J.awa, J[set].cd) };
    this.kp = { main: M.kp, jib: J.kp };
    this.flat = 1; this.reef = 1; this.sheet = 'auto'; this.side = 1;
    this.state = { boom: 0.3, jibAngle: 0.3, luff: 0, fill: 1, cl: 0, cd: 0, beta: 0, aws: 0 };
    this.main = { ce: [0, 0, 0], f: [0, 0, 0], beta: 0, aws: 0, cl: 0, cd: 0 };
    this.jib = { ce: [0, 0, 0], f: [0, 0, 0], beta: 0, aws: 0, cl: 0, cd: 0 };
  }

  /** 横倾上限内的组合系数（β：度，0–180） */
  _combined(betaMain, betaJib, flat, reef) {
    const g = this.g, Am = g.main.area * reef * reef, Aj = g.jib.area * reef * reef, A = Am + Aj;
    const clm = this.cl.main(betaMain), cdm = this.cd.main(betaMain), clj = this.cl.jib(betaJib), cdj = this.cd.jib(betaJib);
    const CL = (clm * Am + clj * Aj) / A, CDp = (cdm * Am + cdj * Aj) / A;
    const P = g.main.P * reef, I = g.jib.I * reef, b = Math.max(P + g.main.BAD, I);
    const beta = (betaMain * Am + betaJib * Aj) / A;
    const heff = (b + g.HBI) * g.spanCorr * kheff(Math.min(beta, 90));
    const CE = (CL * CL > 1e-9 ? (clm * clm * Am * this.kp.main + clj * clj * Aj * this.kp.jib) / (A * CL * CL) : 0) + A / (Math.PI * heff * heff);
    const fj = CDp > 1e-9 ? cdj * Aj / (CDp * A) : 0, fm = fcdmult(flat);
    // 各帆的最终系数（总和与 ORC 组合公式一致）
    const kInd = CE * CL * flat * flat * fm;
    return {
      A, Am, Aj, CL: flat * CL, CD: CDp * (flat * fm * fj + 1 - fj) + kInd * CL,
      main: { cl: flat * clm, cd: cdm + kInd * clm }, jib: { cl: flat * clj, cd: cdj * flat * fm + kInd * clj },
      heff, P, I,
    };
  }

  /** ORC twist：压平时帆顶扭开、受力中心降低 */
  _twist(flat) {
    const g = this.g, olap = 1 - clamp((g.overlap - 0.9) / 0.6, 0, 1) / 3;
    return 1 - (0.5 * (1 - flat) + 0.902 * (1 - flat) * (1 - g.fractionality)) * olap;
  }

  /** 受力中心（船体坐标）：主帆随横杆转动，前帆随前帆脚索转动 */
  _centres(boom, jibAngle, side, flat, reef) {
    const g = this.g, tw = this._twist(flat);
    const mt = g.main.tack, d = g.main.ceAft * reef;
    this.main.ce[0] = side * d * Math.sin(boom); this.main.ce[1] = mt[1] + g.main.vce * tw * reef; this.main.ce[2] = mt[2] - d * Math.cos(boom);
    const C = g.jib.clewAt(jibAngle, side), T = g.jib.tack, H = g.jib.head;
    this.jib.ce[0] = (T[0] + H[0] + C[0]) / 3; this.jib.ce[1] = g.HBI + ((T[1] + H[1] + C[1]) / 3 - g.HBI) * tw * reef; this.jib.ce[2] = (T[2] + H[2] + C[2]) / 3;
  }

  /**
   * 计算帆力。airAt(ce, out) → 该点的视风（空气相对该点的速度，船体坐标 [x, y, z]，已含风廓线与 v + ω×r）。
   * 结果：this.main.f / this.jib.f（船体坐标力），受力中心 this.main.ce / this.jib.ce
   */
  compute(airAt, bufMain = this._bm || (this._bm = [0, 0, 0]), bufJib = this._bj || (this._bj = [0, 0, 0])) {
    const st = this.state;
    // 先用上一步的受力中心求视风角，确定帆在哪一舷，再按调帆更新受力中心
    this._centres(st.boom, st.jibAngle, this.side, this.flat, this.reef);
    const am = airAt(this.main.ce, bufMain), aj = airAt(this.jib.ce, bufJib);
    const awsM = Math.hypot(am[0], am[2]), awsJ = Math.hypot(aj[0], aj[2]);
    const betaM = Math.atan2(am[0], -am[2]), betaJ = Math.atan2(aj[0], -aj[2]);      // 视风来向，顺时针为正（右舷来风 > 0）
    // 帆在下风舷；接近正顺风时保持原侧（越过约 10° 才“换舷”，即顺风换舷）
    if (Math.abs(betaM) < 170 * DEG && awsM > 0.05) this.side = betaM >= 0 ? 1 : -1;
    const side = this.side;
    const bm = Math.abs(betaM), bj = Math.abs(betaJ);
    // 帆脚索
    let boom, jibAngle;
    if (this.sheet === 'auto' || this.sheet == null) { boom = optimalBoom(bm); jibAngle = optimalJib(bj); }
    else { const s = clamp(this.sheet, 0, 1); boom = this.g.main.sheetToAngle(s); jibAngle = this.g.jib.sheetToAngle(s); }
    st.boom = boom; st.jibAngle = jibAngle;
    this._centres(boom, jibAngle, side, this.flat, this.reef);
    const c = this._combined(bm / DEG, bj / DEG, this.flat, this.reef);
    let clm = c.main.cl, cdm = c.main.cd, clj = c.jib.cl, cdj = c.jib.cd, luff = 0;
    if (this.sheet !== 'auto' && this.sheet != null) {
      // 偏离最佳角：Δ > 0 放得太松（抖帆），Δ < 0 收得太紧（失速）
      const dm = boom - optimalBoom(bm), dj = jibAngle - optimalJib(bj);
      [clm, cdm] = this._trimPenalty(clm, cdm, dm); [clj, cdj] = this._trimPenalty(clj, cdj, dj);
      luff = clamp(Math.max(dm, dj) / 0.2, 0, 1);
    }
    // 迎风过高（视风角很小）时前缘抖帆
    luff = Math.max(luff, 1 - smoothstep(10 * DEG, 24 * DEG, bm), 0.3 * (1 - this.flat));
    this._force(this.main, am, awsM, betaM, c.Am, clm, cdm, side);
    this._force(this.jib, aj, awsJ, betaJ, c.Aj, clj, cdj, side);
    const aws = (awsM * c.Am + awsJ * c.Aj) / c.A;
    st.luff = luff; st.fill = smoothstep(0.4, 3.5, aws) * (1 - 0.55 * luff) * (0.7 + 0.3 * this.flat);
    st.cl = (clm * c.Am + clj * c.Aj) / c.A; st.cd = (cdm * c.Am + cdj * c.Aj) / c.A;
    st.beta = (betaM * c.Am + betaJ * c.Aj) / c.A; st.aws = aws; st.heff = c.heff; st.area = c.A;
    return this;
  }

  _trimPenalty(cl, cd, d) {
    if (d > 0) { const f = clamp(1 - d / 0.2, 0, 1); return [cl * f, cd * f + 0.09 * (1 - f)]; }   // 抖帆：升力消失，剩下拍打的阻力
    const e = Math.min(-d, Math.PI / 2);
    return [cl * (1 - 0.35 * Math.min(1, e / 0.6) ** 2), cd + 0.9 * Math.sin(e) ** 2];               // 收太紧：分离
  }

  // 力 = q A (C_L·L̂ + C_D·D̂)：D̂ 沿空气运动方向 = (sin β, −cos β)，L̂ = side·(cos β, sin β) ⊥ D̂，指向下风且偏前
  _force(sail, air, aws, beta, A, cl, cd, side) {
    const q = 0.5 * this.rho * aws * aws, f = sail.f;
    sail.aws = aws; sail.beta = beta; sail.cl = cl; sail.cd = cd;
    if (aws < 1e-6) { f[0] = f[1] = f[2] = 0; return; }
    const dx = air[0] / aws, dz = air[2] / aws, lx = -side * dz, lz = side * dx;
    f[0] = q * A * (cl * lx + cd * dx); f[1] = 0; f[2] = q * A * (cl * lz + cd * dz);
  }

  /**
   * VPP 式自动调帆：在当前（滤波后的）视风下，枚举 flat × reef，选出在横倾上限 φ_max 处
   * 横倾力矩 ≤ 复原力矩 RM(φ_max) 的组合中驱动力最大的一个。
   *   aws、beta：上身直立时、受力中心高度处的视风（beta：0–π）；lever0：横向阻力中心在水线下的深度（m）
   */
  optimize(aws, beta, { heelLimit, RM, lever0 }) {
    const g = this.g, cphi = Math.cos(heelLimit), sb = Math.sin(beta), cb = Math.cos(beta);
    // 横倾时垂直于桅的视风分量（cos φ 投影）
    const bn = Math.atan2(sb * cphi, cb), qn = 0.5 * this.rho * aws * aws * (cb * cb + sb * sb * cphi * cphi);
    let best = null, fallback = null;
    for (let fi = 0; fi <= 10; fi++) {
      const flat = 1 - 0.05 * fi;
      for (let ri = 0; ri <= 11; ri++) {
        const reef = 1 - 0.05 * ri;                // 1 … 0.45（面积 20%，约等于暴风前帆 + 三缩主帆）
        const c = this._combined(bn / DEG, bn / DEG, flat, reef);
        const drive = qn * c.A * (c.CL * Math.sin(bn) - c.CD * Math.cos(bn));
        const sideF = qn * c.A * (c.CL * Math.cos(bn) + c.CD * Math.sin(bn));
        const tw = this._twist(flat);
        const zce = ((g.main.tack[1] + g.main.vce * tw * reef) * c.Am + (g.HBI + g.jib.vce * tw * reef) * c.Aj) / c.A;
        const hm = sideF * (zce + lever0);
        const cand = { flat, reef, drive, hm };
        if (hm <= RM && (!best || drive > best.drive)) best = cand;
        if (!fallback || hm < fallback.hm) fallback = cand;
      }
    }
    return best || fallback;
  }
}

/** 船体 + 桅杆受风阻力（ORC 的船体受风面积公式：A = fbav·((1−d)·B + d·L)，d = ½(1 − cos 2β)，C_D = 0.816） */
export function windage(aws, beta, { beam, length, fbav, mastArea }, rho = AIR.rho) {
  const d = 0.5 * (1 - Math.cos(2 * beta));
  const q = 0.5 * rho * aws * aws;
  return { hull: q * fbav * ((1 - d) * beam + d * length) * 0.816, mast: q * mastArea * 1.0 };
}

