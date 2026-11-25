// =====================================================================================
// SailingYacht —— 六自由度帆船刚体（纯 JS，Node 可跑）：船体水压积分 + 阻力 + 龙骨 / 舵翼型 + 帆 + 舵机
//
//   const yacht = new SailingYacht({ hull: YACHT_HULL });          // 与画面 new Sailboat({ hull: yacht.hull }) 同一组型线参数
//   yacht.setControls({ mode: 'twa', target: 50 * Math.PI / 180, tack: 'port', sheet: 'auto' });
//   yacht.step(dt, { ocean, wind: { x, z } });                     // wind = 10 m 高真风（U10，指向下风），内部 ≥ 120 Hz 子步
//   yacht.state / yacht.telemetry / yacht.events / yacht.wake / yacht.sail
//
// 力（全部在船体坐标、对重心）：
//   重力；船体水压（静水力 + Froude–Krylov，三角面精确积分，Hydrostatics）；面元摩擦（ITTC-1957 × 1.05）；
//   剩余阻力（DSYHS 2008，作用在水线面形心）；辐射阻尼（竖直相对速度，按升沉阻尼比标定）；砰击；
//   龙骨、舵、船体三个升力面（Helmbold 斜率、失速、诱导阻力、下洗，Foils）；主帆、前帆（ORC 系数，各在自己的受力中心）；
//   船体与桅杆受风阻力。附加质量（切片理论）按体坐标轴加到惯性上，随浸没程度缩放。
// 积分：半隐式欧拉（先速度后位置，辛积分），子步 h ≤ 1/120 s；四元数每步归一化。
// 横倾、纵摇、升沉、速度饱和、漂角、上风舵、换舷时失速 —— 都由上面这些力的平衡得到，没有写死的极曲线或横倾表。
// =====================================================================================
import { HullShape, YACHT_HULL, sailboatLayout } from './HullShape.js';
import { buildYachtMesh, TAG } from './HullMesh.js';
import { HullIntegrator, staticLoads, stabilityCurve, equilibrium } from './Hydrostatics.js';
import { hullFormParameters, ResiduaryResistance, ittc57, WATER, HULL_FORM_FACTOR } from './Resistance.js';
import { Foil, submergedPlanform, chordAt, DEG } from './Foils.js';
import { Rig, rigFromLayout, windProfile, windage, AIR } from './Sails.js';
import { Autopilot, wrap } from './Autopilot.js';
import { quatFromYXZ, quatToMat, matToYXZ, quatIntegrate, mulMV, mulMtV, inv3, bearing } from './vmath.js';
import { pchip, clamp, smoothstep } from './interp.js';

const G = 9.81, KN = 1852 / 3600;

export const YACHT_DEFAULTS = Object.freeze({
  mastHeight: 10.6, stations: 28, girth: 8, keelThickness: 0.16, rudderThickness: 0.07,
  rho: WATER.rho, rhoAir: AIR.rho, charnock: 0.0144,
  ballastRatio: 0.36,                 // 压载 / 排水量（8–9 m 巡航帆船典型 0.35–0.42，如 HR 29：1.6 t / 3.8 t）
  crew: 2, shellDensity: 14, deckDensity: 15,   // kg/m²：实心玻璃钢船壳（含骨架）、甲板与舱室（含五金、护栏、绞盘）
  interiorVCG: 0.3,                   // 内部舾装（舱底板 −0.2 m 到甲板下）质心高度
  heaveDamping: 0.15,                 // 升沉辐射阻尼比（宽浅船体 Lewis 剖面二维辐射理论在共振附近的典型值）
  slamCoefficient: 1.0, slamThreshold: 0.8,
  sailCoefficients: 'low', heelLimit: 20 * DEG,      // 自动调帆的横倾上限（巡航舒适性，VPP 常用 20–25°）
  substepHz: 120,
  position: { x: 0, z: 0 }, yaw: 0, speed: 0,
});

/**
 * 表观尾迹半角（弧度）。Kelvin（1887）：深水中任何恒速扰动的尾迹包络半角 = asin(1/3) = 19.47°；
 * Rabaud & Moisy（2013, PRL 110, 214503）：船体长度 L 限制了能激发的最长波（k ≥ 2π/L），Fn = U/√(gL) 大于约 0.6 时
 * 振幅最大的波臂退化为“马赫角” sin α = c_g(2π/L)/U = 1/(2√(2π)·Fn)，随 Fn⁻¹ 变窄。
 */
export function wakeAngle(Fn) {
  const kelvin = Math.asin(1 / 3);
  return Fn > 0 ? Math.min(kelvin, Math.asin(Math.min(1, 1 / (2 * Math.sqrt(2 * Math.PI) * Fn)))) : kelvin;
}

// 多边形与竖直线 z = const 的交：返回最低、最高的 y
function verticalExtent(outline, z) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [z0, y0] = outline[i], [z1, y1] = outline[(i + 1) % outline.length];
    if ((z0 - z) * (z1 - z) > 0 || z0 === z1) continue;
    const t = (z - z0) / (z1 - z0), y = y0 + t * (y1 - y0);
    lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  return hi >= lo ? { lo, hi } : null;
}

export class SailingYacht {
  constructor(opts = {}) {
    const o = this.options = { ...YACHT_DEFAULTS, ...opts };
    this.hull = Object.freeze({ ...YACHT_HULL, ...(opts.hull || {}) });
    const shape = this.shape = opts.shape || HullShape;
    const L = this.layout = sailboatLayout(this.hull, { mastHeight: o.mastHeight, shape });
    this.parts = buildYachtMesh(this.hull, { layout: L, stations: o.stations, girth: o.girth, keelThickness: o.keelThickness, rudderThickness: o.rudderThickness, shape });
    this.rho = o.rho;
    this.integ = new HullIntegrator(this.parts.mesh, { rho: o.rho, g: G });
    this._static = new HullIntegrator(this.parts.mesh, { rho: o.rho, g: G });   // 静力计算专用，不打扰动态积分器的状态

    // —— 1. 设计水线（y = 0）处的静水力：排水量就是质量 ——
    const d0 = staticLoads(this._static, [0, 0, 0], { y: 0 });
    this.volume = d0.F[1] / (o.rho * G);
    this.mass = o.rho * this.volume;
    this.lcb = -d0.M[0] / d0.F[1];
    this.waterplaneArea = d0.wpArea; this.lcf = d0.wpZ;
    this.form = hullFormParameters(this.hull, { shape });

    // —— 2. 质量分布（各部件真实质量，压载纵向位置使 LCG = LCB），惯性张量 ——
    this._buildMass();
    // —— 3. 翼型、帆装、阻力 ——
    this._buildFoils();
    this.rig = new Rig(rigFromLayout(L), { coefficients: o.sailCoefficients, rhoAir: o.rhoAir });
    this.residuary = new ResiduaryResistance(this.form, { rho: o.rho, g: G });
    // —— 4. 附加质量（切片理论）与辐射阻尼标定 ——
    this._addedMass();
    this._calibrateRadiation();
    // —— 5. 稳性曲线（0–90°，给自动调帆的复原力矩上限）——
    this.stabilityTable = stabilityCurve(this._static, this.mass, this.cg, Array.from({ length: 19 }, (_, i) => i * 5));
    this._RM = pchip(this.stabilityTable.map((r) => r.heel * DEG), this.stabilityTable.map((r) => Math.max(0, r.RM)));
    this.GM = equilibrium(this._static, this.mass, this.cg, { heel: 3 * DEG }).GZ / Math.sin(3 * DEG);
    this._naturalPeriods();

    // —— 控制 ——
    this.autopilot = new Autopilot();
    this.controls = { sheet: 'auto', flat: 'auto', reef: 'auto', heelLimit: o.heelLimit };
    this.substepHz = o.substepHz;

    // —— 输出对象（每步原地更新）——
    this.state = { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, velocity: { x: 0, y: 0, z: 0 }, angularVelocity: { x: 0, y: 0, z: 0 }, cg: { x: 0, y: 0, z: 0 } };
    this.telemetry = {};
    this.events = [];
    this._eventPool = Array.from({ length: 8 }, () => ({ type: 'slam', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, speed: 0, area: 0, areaRate: 0, intensity: 0 }));
    this.wake = { bow: { x: 0, y: 0, z: 0 }, stern: { x: 0, y: 0, z: 0 }, direction: { x: 0, z: 1 }, speed: 0, Fn: 0, kelvinAngle: Math.asin(1 / 3), angle: Math.asin(1 / 3), amplitude: 0, strength: 0 };
    this.sail = { side: 1, boomAngle: 0.3, jibSheet: 0.3, luff: 0, fill: 1, aws: 0, awa: 0, reef: 1, flat: 1, awLocal: { x: 0, z: -1 } };

    // —— 内部缓冲 ——
    this._R = new Float64Array(9); this._Ii = new Float64Array(9); this._Ia = new Float64Array(9);
    this._P = [0, 0, 0]; this._V = [0, 0, 0]; this._W = [0, 0, 0]; this._mo = { V: this._V, W: this._W };
    this._t1 = [0, 0, 0]; this._t2 = [0, 0, 0]; this._t3 = [0, 0, 0]; this._am = [0, 0, 0]; this._aj = [0, 0, 0]; this._ah = [0, 0, 0];
    this._wv = { x: 0, y: 0, z: 0 };
    this._water = { flat: true, k: 0, height: (x, z) => this._ocean.sampleHeight(x, z), field: null };
    this._field = { X0: 0, Z0: 0, W0: [0, 0, 0], Gx: [0, 0, 0], Gz: [0, 0, 0] };
    this._ocean = null; this._wind = { x: 0, z: 0 }; this._profile = windProfile(0, { charnock: o.charnock });
    this._acc = {}; this._clearAcc();
    this._airFn = (ce, out) => this._airAt(ce, out);
    this.time = 0;
    this.reset({ x: o.position.x, z: o.position.z, yaw: o.yaw, speed: o.speed });
  }

  // ------------------------------------------------------------------ 质量模型
  _buildMass() {
    const o = this.options, L = this.layout, p = this.hull, M = this.mass, sh = this.shape;
    const comps = [];
    const point = (name, m, c, own = null) => comps.push({ name, mass: m, c: c.slice(), own });
    const box = (name, m, c, hx, hy, hz) => point(name, m, c, [m * (hy * hy + hz * hz) / 3, m * (hx * hx + hz * hz) / 3, m * (hx * hx + hy * hy) / 3]);
    // 分布质量：船壳、甲板（按三角形面积分到形心）
    const dist = (name, tagOk, density) => {
      const m = this.parts.hull, v = m.vertices, t = m.triangles;
      let mass = 0; const s = [0, 0, 0], S = new Float64Array(9);
      for (let i = 0; i < t.length; i += 3) {
        if (!tagOk(m.tags[i / 3])) continue;
        const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
        const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
        const A = 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx), dm = A * density;
        const cx = (v[a] + v[b] + v[c]) / 3, cy = (v[a + 1] + v[b + 1] + v[c + 1]) / 3, cz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3;
        mass += dm; s[0] += dm * cx; s[1] += dm * cy; s[2] += dm * cz;
        S[0] += dm * cx * cx; S[1] += dm * cx * cy; S[2] += dm * cx * cz; S[4] += dm * cy * cy; S[5] += dm * cy * cz; S[8] += dm * cz * cz;
      }
      S[3] = S[1]; S[6] = S[2]; S[7] = S[5];
      comps.push({ name, mass, c: s.map((x) => x / mass), S, distributed: true });
    };
    dist('船壳（玻璃钢 + 骨架）', (tg) => tg === TAG.HULL || tg === TAG.TRANSOM, o.shellDensity);
    dist('甲板与舱室', (tg) => tg === TAG.DECK, o.deckDensity);
    // 帆装：铝桅 3.1 kg/m（含配件），横杆 2.4 kg/m
    const mastM = 3.1 * L.mastHeight, mastC = [0, L.mastBase + L.mastHeight / 2, L.zMast];
    point('桅杆', mastM, mastC, [mastM * L.mastHeight ** 2 / 12, 0, mastM * L.mastHeight ** 2 / 12]);
    point('横杆', 2.4 * L.boomLength, [0, L.boomPivot[1], L.boomPivot[2] - L.boomLength / 2]);
    point('静索', 22, [0, L.deckY + 0.55 * L.mastHeight, L.zMast - 0.2]);
    point('帆、卷帆器、动索', 30, [0, L.deckY + 4.0, L.zMast + 0.4]);
    point('柴油机与轴系', 125, [0, -0.02, L.cabin.z0 - 0.35]);
    point('水箱、油箱', 95, [0, -0.2, -0.3]);
    point('蓄电池', 45, [0, -0.1, L.cabin.z0 - 0.8]);
    point('锚与锚链', 45, [0, 0.85, L.zBow - 0.7]);
    point(`船员 ×${o.crew}`, 80 * o.crew, L.cockpit);
    const fixed = comps.reduce((a, c) => a + c.mass, 0);
    // 压载：铅，铸在长龙骨下部
    const mb = o.ballastRatio * M, kt = o.keelThickness;
    const tipY = L.keel.tipY, zLo = sh.zAt(p, 0.3), zHi = sh.zAt(p, 0.66), halfLen = Math.min(1.2, (zHi - zLo) / 2 - 0.05);
    const interior = M - fixed - mb;
    if (interior < 0) throw new Error(`SailingYacht：部件质量 ${(fixed + mb).toFixed(0)} kg 超过排水量 ${M.toFixed(0)} kg`);
    // 内部舾装、设备、给养：船舱内的均匀长方体
    const iz0 = sh.zAt(p, 0.14), iz1 = sh.zAt(p, 0.84);
    let izc = (iz0 + iz1) / 2 - 0.3;
    // 纵向平衡：压载放在使 LCG = LCB 的位置（设计者正是这样决定龙骨 / 压载位置的）
    let mz = comps.reduce((a, c) => a + c.mass * c.c[2], 0) + interior * izc;
    let zb = (M * this.lcb - mz) / mb;
    const zbMin = zLo + halfLen, zbMax = zHi - halfLen;
    if (zb < zbMin || zb > zbMax) { const zc = clamp(zb, zbMin, zbMax); izc += (zb - zc) * mb / Math.max(interior, 1); zb = zc; }
    box('压载（铅）', mb, [0, tipY + 0.15, zb], kt / 2, 0.15, halfLen);
    box('内部舾装、设备、给养', interior, [0, o.interiorVCG, izc], 0.8, 0.5, (iz1 - iz0) / 2);
    // 合成：重心、对重心的惯性张量
    let m = 0; const s = [0, 0, 0], S = new Float64Array(9), J = [0, 0, 0];
    for (const c of comps) {
      m += c.mass; for (let k = 0; k < 3; k++) s[k] += c.mass * c.c[k];
      if (c.distributed) for (let k = 0; k < 9; k++) S[k] += c.S[k];
      else for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i * 3 + j] += c.mass * c.c[i] * c.c[j];
      if (c.own) for (let k = 0; k < 3; k++) J[k] += c.own[k];
    }
    const cg = s.map((x) => x / m);
    const tr = S[0] + S[4] + S[8];
    const I = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[i * 3 + j] = (i === j ? tr : 0) - S[i * 3 + j] - m * ((i === j ? cg[0] ** 2 + cg[1] ** 2 + cg[2] ** 2 : 0) - cg[i] * cg[j]);
    I[0] += J[0]; I[4] += J[1]; I[8] += J[2];
    I[1] = I[3] = 0.5 * (I[1] + I[3]); I[2] = I[6] = 0.5 * (I[2] + I[6]); I[5] = I[7] = 0.5 * (I[5] + I[7]);
    I[1] = I[3] = 0; I[5] = I[7] = 0;            // 左右对称：含 x 的惯性积为零
    cg[0] = 0;
    this.components = comps.map((c) => ({ name: c.name, mass: c.mass, position: c.c }));
    this.cg = cg; this.inertia = I;
    this.massCheck = m;                          // 应等于 this.mass
  }

  // ------------------------------------------------------------------ 翼型：龙骨、舵、船体
  _buildFoils() {
    const L = this.layout, f = this.form;
    // 龙骨：长龙骨轮廓（全部在水下），船体作端板：A_e = 0.9 · 2b²/S
    const kp = submergedPlanform(L.keel.outline, 0), kc = chordAt(L.keel.outline, kp.yc);
    this.keel = new Foil({ name: 'keel', area: kp.area, span: kp.span, chord: kp.area / kp.span, ref: [0, kp.yc, kc.le], arEff: 0.9 * 2 * kp.span ** 2 / kp.area, tc: 0.06, cd90: 1.1 });
    // 舵：水线以下部分；艉挂舵穿出水面，低速时自由面起端板作用：A_e = 0.8 · 2b²/S
    const rp = submergedPlanform(L.rudder.outline, 0), rc = chordAt(L.rudder.outline, rp.yc);
    this.rudderFoil = new Foil({ name: 'rudder', area: rp.area, span: rp.span, chord: rp.area / rp.span, ref: [0, rp.yc, rc.le], arEff: 0.8 * 2 * rp.span ** 2 / rp.area, tc: 0.12, cd90: 1.25, rudder: true });
    // 船体：极低展弦比升力体（展长 = 船体吃水，面积 = 船体侧投影），压力中心在侧面积形心前 0.12 L（细长体理论：升力产生在前部）
    const zcp = f.lateralCentroidZ + 0.12 * f.LWL, chord = f.lateralArea / f.Tc;
    this.hullFoil = new Foil({ name: 'canoe body', area: f.lateralArea, span: f.Tc, chord, ref: [0, -f.Tc / 3, zcp + 0.25 * chord], arEff: 2 * f.Tc ** 2 / f.lateralArea, cd90: 0.8, stallDeg: 35, profile: false });
    // 设计状态下龙骨、舵的湿面积（浸没比例的分母）
    const d = staticLoads(this._static, this.cg || [0, 0, 0], { y: 0 });
    this._wetApp0 = d.wetAreaApp; this._wetHull0 = d.wetArea;
    const foils = [this.keel, this.rudderFoil, this.hullFoil];
    const la = foils.reduce((a, x) => a + x.liftArea, 0);
    this.clrDepth = -foils.reduce((a, x) => a + x.liftArea * (x.ref[1]), 0) / la;   // 横向阻力中心在水线下的深度
    this.clrZ = foils.reduce((a, x) => a + x.liftArea * (x.ref[2] - 0.25 * x.chord), 0) / la;
  }

  // ------------------------------------------------------------------ 附加质量（切片理论）
  // 每个横剖面的二维高频附加质量：升沉按半圆等效 ρπB²/8（Lewis 1929，系数≈1），横荡按带水面镜像的平板 ρπT²/2，
  // 横摇（绕水线）ρπT⁴/16（Newman, Marine Hydrodynamics 1977，平板绕中心转动 ρπa⁴/8 的一半）；
  // 三维修正：升沉、纵摇 J = 0.75（L/B ≈ 3.7）；横荡、偏航 J = 0.7（横向附加质量主要来自长龙骨，带水面镜像后
  // 长 / 深 ≈ 1.6 的矩形平板，Brennen 1982 的系数约 0.7）；纵荡取 5% 质量。
  _addedMass() {
    const p = this.hull, L = this.layout, rho = this.rho, cg = this.cg, sh = this.shape, n = 96;
    let A33 = 0, A55 = 0, A22 = 0, A66 = 0, A44 = 0;
    const strip = (z, B, T, dz) => {
      const a33 = rho * Math.PI * B * B / 8, a22 = rho * Math.PI * T * T / 2, a44 = rho * Math.PI * T ** 4 / 16, r = z - cg[2];
      A33 += a33 * dz; A55 += a33 * r * r * dz; A22 += a22 * dz; A66 += a22 * r * r * dz; A44 += a44 * dz;
    };
    for (let i = 0; i <= n; i++) {
      const s = i / n, z = sh.zAt(p, s), dz = p.length / n * (i === 0 || i === n ? 0.5 : 1);
      const B = 2 * sh.halfWidthAt(p, s, 0), Th = Math.max(0, -sh.keel(p, s)), ke = verticalExtent(L.keel.outline, z);
      strip(z, B, Math.max(Th, ke ? -ke.lo : 0), dz);
    }
    // 舵（在艉板之后）：展长大于弦长，二维剖面应取弦向 —— 平板法向附加质量 ρ(π/4)c²·b·k(A)（k ≈ 0.85，Newman 1977），
    // 若仍按船长方向切片会高估约 5 倍（偏航附加惯性被舵的力臂放大）
    const rf = this.rudderFoil, ma = rho * Math.PI / 4 * rf.chord * rf.chord * rf.span * 0.85, rr = rf.cp0[2] - cg[2];
    A22 += ma / 0.7; A66 += ma * rr * rr / 0.7; A44 += ma * (rf.span / 2) ** 2;
    const m = this.mass;
    // 体坐标轴：x 横向（横荡 / 纵摇轴），y 竖直（升沉 / 偏航轴），z 纵向（纵荡 / 横摇轴）
    this.addedMass = { lin: [0.7 * A22, 0.75 * A33, 0.05 * m], rot: [0.75 * A55, 0.7 * A66, A44] };
  }

  // 辐射阻尼标定：c_rad 使升沉阻尼比 = heaveDamping；纵摇、横摇阻尼由同一面元分布自然得到
  _calibrateRadiation() {
    const rho = this.rho, m = this.mass, A33 = this.addedMass.lin[1];
    const C33 = rho * G * this.waterplaneArea, omega = Math.sqrt(C33 / (m + A33));
    const krad = omega * omega / G;              // 辐射压强随深度按 e^{ky} 衰减（深水波数 k = ω²/g）
    const I = this._static; I._first = true;
    const R = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const out = I.integrate(R, [0, 0, 0], this.cg, { flat: true, k: 0, height: () => 0, field: null }, { V: [0, -1, 0], W: [0, 0, 0] },
      { cf: 0, crad: 1, krad, cslam: 0, slamMin: 1e9, L: this.hull.length });
    const K = out.Fd[1] / rho;                   // Σ w n_y² A（m²）
    const B33 = 2 * this.options.heaveDamping * Math.sqrt(C33 * (m + A33));
    this.radiation = { crad: B33 / (rho * K), krad, B33, K, omegaHeave: omega };
  }

  _naturalPeriods() {
    const m = this.mass, I = this.inertia, A = this.addedMass, rho = this.rho;
    const C33 = rho * G * this.waterplaneArea;
    // 纵稳性高 GM_L：设计水线处强迫纵倾 0.5°，由复原力矩求
    const th = 0.5 * DEG, Lp = staticLoads(this._static, this.cg, { y: 0, trim: th });
    this.GML = Math.abs(Lp.M[0]) / (m * G * Math.sin(th));
    this.naturalPeriods = {
      heave: 2 * Math.PI * Math.sqrt((m + A.lin[1]) / C33),
      roll: 2 * Math.PI * Math.sqrt((I[8] + A.rot[2]) / (m * G * this.GM)),
      pitch: 2 * Math.PI * Math.sqrt((I[0] + A.rot[0]) / (m * G * this.GML)),
    };
  }

  // ------------------------------------------------------------------ 公共 API
  /** 把船放到 (x, z)，航向 yaw，前进速度 speed（m/s），设计水线正浮，静止 */
  reset({ x = 0, z = 0, yaw = 0, speed = 0, heel = 0, pitch = 0, y = 0 } = {}) {
    this._q = quatFromYXZ(yaw, pitch, heel);
    const R = quatToMat(this._q, this._R), cg = this.cg;
    this._x = [x + R[0] * cg[0] + R[1] * cg[1] + R[2] * cg[2], y + R[3] * cg[0] + R[4] * cg[1] + R[5] * cg[2], z + R[6] * cg[0] + R[7] * cg[1] + R[8] * cg[2]];
    this._v = [Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed];
    this._w = [0, 0, 0];
    this.integ._first = true; this.integ.etaMax = Infinity;
    this._awsF = null; this._trimTimer = 0; this._imm = 1; this._heel2 = heel * heel; this._limAdj = 0;
    if (this.autopilot) { this.autopilot.rudder = 0; this.autopilot._int = 0; this.autopilot._turn = 0; }
    this._publish();
    return this;
  }

  /**
   * 控制：
   *   mode 'twa'（target = 真风角大小，弧度，tack = 'port' | 'starboard'）| 'heading'（target = yaw，弧度）| 'manual'（rudder，弧度）
   *   sheet：'auto' 或 0（收紧）… 1（放松）；flat / reef：'auto' 或 0.5–1 / 0.45–1；heelLimit：自动调帆的横倾上限（弧度）
   */
  setControls(c = {}) {
    const ap = this.autopilot;
    if (c.mode) ap.mode = c.mode;
    if (c.target !== undefined) ap.target = c.target;
    if (c.tack) ap.tack = c.tack;
    if (c.rudder !== undefined) ap.manualRudder = c.rudder;
    for (const k of ['sheet', 'flat', 'reef', 'heelLimit']) if (c[k] !== undefined) this.controls[k] = c[k];
    return this;
  }
  /** 迎风换舷 / 顺风换舷（不传则按当前真风角自动判断） */
  tack() { return this.autopilot.changeTack('tack'); }
  gybe() { return this.autopilot.changeTack('gybe'); }
  changeTack() { return this.autopilot.changeTack(); }

  /** 完整稳性曲线（默认 0–180°，每 5°）：[{ heel, GZ, RM, trim, y }] */
  stability(heels) { return stabilityCurve(this._static, this.mass, this.cg, heels); }

  /**
   * 推进 dt 秒。env：{ ocean（sampleHeight / sampleVelocity，可省略 = 平静水面）, wind: { x, z }（U10，指向下风）,
   *                    waveNumber（Smith 效应波数 rad/m，可省略：取海况主波）}
   */
  step(dt, env = {}) {
    dt = Math.min(Math.max(+dt || 0, 0), 0.25);
    if (dt === 0) return this;
    const ocean = env.ocean || null;
    const ready = !!ocean && typeof ocean.sampleHeight === 'function' && !(ocean.sim && ocean.sim.ready === false);
    const W = this._water;
    if (W.flat !== !ready) this.integ.etaMax = Infinity;
    W.flat = !ready; this._ocean = ready ? ocean : null;
    W.k = env.waveNumber ?? (ready ? this._dominantK(ocean) : 0);
    const wind = env.wind || { x: 0, z: 0 };
    this._wind.x = wind.x || 0; this._wind.z = wind.z || 0;
    const U10 = Math.hypot(this._wind.x, this._wind.z);
    if (Math.abs(U10 - this._profileU) > 0.05 || this._profileU === undefined) { this._profile = windProfile(U10, { charnock: this.options.charnock }); this._profileU = U10; }
    this._sampleWaterVelocity(ready && typeof ocean.sampleVelocity === 'function' ? ocean : null);
    this.integ.resetSlam();
    this._clearAcc();
    const n = Math.max(1, Math.ceil(dt * this.substepHz - 1e-9)), h = dt / n;
    for (let i = 0; i < n; i++) this._substep(h);
    this.time += dt;
    this._publish(dt, n);
    return this;
  }

  // ------------------------------------------------------------------ 水
  _dominantK(ocean) {
    if (this._kTimer > 0 && this._kCache !== undefined) { this._kTimer -= 1; return this._kCache; }
    this._kTimer = 30;
    const r = ocean.model && ocean.model.readout;
    let k = 0;
    if (r) {
      const T = (r.HsSwell > r.HsWind ? r.TpSwell : r.Tp) || r.Tp;
      if (T > 0) k = (2 * Math.PI / T) ** 2 / G;
    }
    this._kCache = k;
    return k;
  }

  // 每步在船体水线面上 5 × 3 个点取水质点速度：最小二乘拟合成线性场（世界坐标，子步里给面元、翼型按位置插值），
  // 拟合（而不是单点取样）使比船短的浪在船长上平均掉 —— 与压强积分对短波的处理一致
  _sampleWaterVelocity(ocean) {
    const f = this._field;
    if (!ocean) { this._water.field = null; return; }
    const R = this._R, yaw = Math.atan2(R[2], R[8]), fx = Math.sin(yaw), fz = Math.cos(yaw), px = Math.cos(yaw), pz = -Math.sin(yaw);
    const X0 = this._x[0], Z0 = this._x[2], dl = 0.45 * this.hull.length, db = 0.4 * this.hull.beam, v = this._wv;
    const m = [0, 0, 0], gf = [0, 0, 0], gp = [0, 0, 0];
    let sf2 = 0, sp2 = 0, n = 0;
    for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) {
      const a = i / 2 * dl, b = j * db;
      v.x = v.y = v.z = 0; ocean.sampleVelocity(X0 + fx * a + px * b, Z0 + fz * a + pz * b, v);
      const w = [v.x || 0, v.y || 0, v.z || 0];
      for (let k = 0; k < 3; k++) { m[k] += w[k]; gf[k] += a * w[k]; gp[k] += b * w[k]; }
      sf2 += a * a; sp2 += b * b; n++;
    }
    f.X0 = X0; f.Z0 = Z0;
    for (let k = 0; k < 3; k++) {
      const g1 = gf[k] / sf2, g2 = gp[k] / sp2;
      f.W0[k] = m[k] / n; f.Gx[k] = g1 * fx + g2 * px; f.Gz[k] = g1 * fz + g2 * pz;
    }
    this._water.field = f;
  }

  _waterVel(x, y, z, out) {
    const f = this._water.field;
    if (!f) { out[0] = out[1] = out[2] = 0; return out; }
    const dx = x - f.X0, dz = z - f.Z0, k = this._water.k, dec = k > 0 ? Math.exp(k * Math.min(y, 0)) : 1;
    for (let i = 0; i < 3; i++) out[i] = (f.W0[i] + f.Gx[i] * dx + f.Gz[i] * dz) * dec;
    return out;
  }

  // 船体坐标点 r 处相对水的速度（船体坐标）
  _relVelBody(r, out) {
    const R = this._R, P = this._P, cg = this.cg, V = this._V, Wb = this._W;
    const rx = r[0] - cg[0], ry = r[1] - cg[1], rz = r[2] - cg[2];
    let vx = V[0] + Wb[1] * rz - Wb[2] * ry, vy = V[1] + Wb[2] * rx - Wb[0] * rz, vz = V[2] + Wb[0] * ry - Wb[1] * rx;
    if (this._water.field) {
      const X = P[0] + R[0] * r[0] + R[1] * r[1] + R[2] * r[2], Y = P[1] + R[3] * r[0] + R[4] * r[1] + R[5] * r[2], Z = P[2] + R[6] * r[0] + R[7] * r[1] + R[8] * r[2];
      const w = this._waterVel(X, Y, Z, this._t3);
      vx -= R[0] * w[0] + R[3] * w[1] + R[6] * w[2]; vy -= R[1] * w[0] + R[4] * w[1] + R[7] * w[2]; vz -= R[2] * w[0] + R[5] * w[1] + R[8] * w[2];
    }
    out[0] = vx; out[1] = vy; out[2] = vz;
    return out;
  }

  // 船体坐标点 ce 处的视风（空气相对该点的速度，船体坐标）：对数风廓线 + 该点速度 v + ω × r
  _airAt(ce, out) {
    const R = this._R, P = this._P, cg = this.cg, V = this._V, Wb = this._W;
    const Y = P[1] + R[3] * ce[0] + R[4] * ce[1] + R[5] * ce[2];
    const k = this._profile.ratioAt(Math.max(Y, 0.5));
    const ux = this._wind.x * k, uz = this._wind.z * k;
    const bx = R[0] * ux + R[6] * uz, by = R[1] * ux + R[7] * uz, bz = R[2] * ux + R[8] * uz;   // 真风换到船体坐标
    const rx = ce[0] - cg[0], ry = ce[1] - cg[1], rz = ce[2] - cg[2];
    out[0] = bx - (V[0] + Wb[1] * rz - Wb[2] * ry); out[1] = by - (V[1] + Wb[2] * rx - Wb[0] * rz); out[2] = bz - (V[2] + Wb[0] * ry - Wb[1] * rx);
    return out;
  }

  // ------------------------------------------------------------------ 一个子步
  _substep(h) {
    const R = quatToMat(this._q, this._R), cg = this.cg, x = this._x, v = this._v, w = this._w, P = this._P, m = this.mass;
    P[0] = x[0] - (R[0] * cg[0] + R[1] * cg[1] + R[2] * cg[2]); P[1] = x[1] - (R[3] * cg[0] + R[4] * cg[1] + R[5] * cg[2]); P[2] = x[2] - (R[6] * cg[0] + R[7] * cg[1] + R[8] * cg[2]);
    mulMtV(R, v, this._V); mulMtV(R, w, this._W);
    const Vb = this._V, Wb = this._W, acc = this._acc;
    let Fx = 0, Fy = 0, Fz = 0, Mx = 0, My = 0, Mz = 0;
    const addF = (f0, f1, f2, px, py, pz) => {   // 船体坐标的力 f 作用在船体坐标点 p
      Fx += f0; Fy += f1; Fz += f2;
      const rx = px - cg[0], ry = py - cg[1], rz = pz - cg[2];
      Mx += ry * f2 - rz * f1; My += rz * f0 - rx * f2; Mz += rx * f1 - ry * f0;
    };
    // —— 船体相对水的水平速度（雷诺数、Froude 数、剩余阻力方向）——
    const wc = this._waterVel(x[0], 0, x[2], this._t1);
    const vhx = v[0] - wc[0], vhz = v[2] - wc[2], Vh = Math.hypot(vhx, vhz);
    const LWL = this.form.LWL, Re = Vh * 0.7 * LWL / WATER.nu;
    // —— 1. 水压积分（静水力 + FK）+ 面元摩擦 + 辐射阻尼 + 砰击 ——
    const hp = this._hp || (this._hp = { cf: 0, crad: this.radiation.crad, krad: this.radiation.krad, cslam: this.options.slamCoefficient, slamMin: this.options.slamThreshold, L: this.hull.length });
    hp.cf = ittc57(Re) * HULL_FORM_FACTOR;
    const o = this.integ.integrate(R, P, cg, this._water, this._mo, hp);
    Fx += o.F[0] + o.Ff[0] + o.Fd[0]; Fy += o.F[1] + o.Ff[1] + o.Fd[1]; Fz += o.F[2] + o.Ff[2] + o.Fd[2];
    Mx += o.M[0] + o.Mf[0] + o.Md[0]; My += o.M[1] + o.Mf[1] + o.Md[1]; Mz += o.M[2] + o.Mf[2] + o.Md[2];
    const FyWorld = R[3] * o.F[0] + R[4] * o.F[1] + R[5] * o.F[2];
    this._imm += (clamp(FyWorld / (m * G), 0, 1.3) - this._imm) * Math.min(1, h / 0.05);   // 浸没程度（附加质量缩放）
    const immApp = clamp(o.wetAreaAppendages / this._wetApp0, 0, 1), immHull = clamp(o.wetArea / this._wetHull0, 0, 1.2);
    // —— 2. 翼型：龙骨、船体、舵（舵在龙骨下洗中）——
    const t = this._t2;
    const K = this.keel, Hf = this.hullFoil, Rf = this.rudderFoil;
    this._relVelBody(K.cp0, t);
    K.evaluate(t[0], t[2], 0, 0, immApp, this.rho);
    addF(K.out.fx, 0, K.out.fz, K.out.px, K.out.py, K.out.pz);
    this._relVelBody(Hf.cp0, t);
    Hf.evaluate(t[0], t[2], 0, 0, immHull, this.rho);
    addF(Hf.out.fx, 0, Hf.out.fz, Hf.out.px, Hf.out.py, Hf.out.pz);
    const delta = this.autopilot.rudder;
    const eps = K.out.cl / (Math.PI * K.arEff) * smoothstep(0.05, 0.3, Vh);   // 龙骨下洗（低速时尾流不成形）
    this._relVelBody(Rf.cp0, t);
    Rf.evaluate(t[0], t[2], delta, eps, immApp, this.rho);
    addF(Rf.out.fx, 0, Rf.out.fz, Rf.out.px, Rf.out.py, Rf.out.pz);
    // —— 3. 剩余（兴波）阻力：DSYHS，作用在水线面形心、水线下 0.3 Tc，方向与相对水流相反 ——
    let Rr = 0;
    if (Vh > 1e-3) {
      const Fn = Vh / Math.sqrt(G * LWL);
      const heel = Math.atan2(R[3], R[4]);
      Rr = this.residuary.force(Fn, this.form.volume * clamp(o.FyHull / (this.rho * G * this.form.volume), 0, 2), heel);
      const fwx = -Rr * vhx / Vh, fwz = -Rr * vhz / Vh;
      const bx = R[0] * fwx + R[6] * fwz, by = R[1] * fwx + R[7] * fwz, bz = R[2] * fwx + R[8] * fwz;
      const dx = o.wpX - P[0], dz = o.wpZ - P[2];
      const lx = R[0] * dx + R[6] * dz, lz = R[2] * dx + R[8] * dz;
      addF(bx, by, bz, lx, -0.3 * this.form.Tc, lz);
    }
    // —— 4. 帆与受风 ——
    const rig = this.rig, ctl = this.controls;
    rig.sheet = ctl.sheet;
    if (ctl.flat !== 'auto') rig.flat = clamp(+ctl.flat, 0.4, 1);
    if (ctl.reef !== 'auto') rig.reef = clamp(+ctl.reef, 0.45, 1);
    rig.compute(this._airFn, this._am, this._aj);
    addF(rig.main.f[0], rig.main.f[1], rig.main.f[2], rig.main.ce[0], rig.main.ce[1], rig.main.ce[2]);
    addF(rig.jib.f[0], rig.jib.f[1], rig.jib.f[2], rig.jib.ce[0], rig.jib.ce[1], rig.jib.ce[2]);
    const g = rig.g, wp = this._wpHull || (this._wpHull = [0, g.windage.hullHeight, -0.3]), mp = this._wpMast || (this._wpMast = [0, this.layout.deckY + 5, this.layout.zMast]);
    let windDrag = 0;
    const wdgDims = this._wdg || (this._wdg = { beam: this.hull.beam, length: this.hull.length, fbav: g.windage.hullFbav, mastArea: g.windage.mastArea });
    for (let iw = 0; iw < 2; iw++) {
      const pt = iw === 0 ? wp : mp;
      const a = this._airAt(pt, this._ah), aws = Math.hypot(a[0], a[2]);
      if (aws < 1e-3) continue;
      const wdg = windage(aws, Math.abs(Math.atan2(a[0], -a[2])), wdgDims, this.options.rhoAir);
      const D = iw === 0 ? wdg.hull : wdg.mast;
      addF(D * a[0] / aws, 0, D * a[2] / aws, pt[0], pt[1], pt[2]);
      windDrag += D * (-(a[0] * Vb[0] + a[2] * Vb[2]) / aws) / Math.max(Math.hypot(Vb[0], Vb[2]), 1e-3);
    }
    // —— 5. 重力 ——
    Fx -= m * G * R[3]; Fy -= m * G * R[4]; Fz -= m * G * R[5];
    // —— 6. 控制（舵机每子步，调帆 4 Hz）——
    const yaw = Math.atan2(R[2], R[8]);
    const windFromYaw = Math.atan2(-this._wind.x, -this._wind.z);
    this.autopilot.update(h, { yaw, yawRate: w[1], windFromYaw, speed: Vh });
    this._trimTimer -= h;
    if (this._trimTimer <= 0) { this._autoTrim(0.25); this._trimTimer += 0.25; }
    // —— 7. 动力学：刚体按世界坐标积分，附加质量放在“艏向坐标系”（只随航向转、不随横倾纵倾转）里 ——
    //   自由面附加质量是兴波辐射的惯性：升沉附加质量沿世界竖直、纵荡 / 横荡沿水平面（耐波性理论的平衡坐标系）。
    //   若把它固定在船体轴上，纵倾 / 横倾时竖直的波浪力、阻尼力会被各向异性的质量“转”成水平加速度，
    //   在浪里平均下来变成虚假的推力（或阻力）。
    //   线运动（艏向系 h，以偏航角速度 ψ̇ 转动）：M_h·v̇_h = F_h − ψ̇ ŷ × p_h，p_h = M_h v_h，M_h = m + A（横荡、升沉、纵荡）
    //     —— 转弯时向心项用 m + A11（Fossen / MMG 操纵方程），世界加速度 = H (v̇_h + ψ̇ ŷ × v_h)
    //   转动（世界系）：(I_w + A_w) ω̇ = τ − ω × (I_w ω)，I_w = R I Rᵀ，A_w = H diag(纵摇, 偏航, 横摇) Hᵀ
    //   Munk 力矩不单列：龙骨、船体升力作用在 1/4 弦点已经包含了这部分。
    const A = this.addedMass, r = this._imm;
    const yawH = Math.atan2(R[2], R[8]), ch = Math.cos(yawH), sh = Math.sin(yawH), psiDot = w[1];
    // 力、力矩：船体 → 世界 → 艏向
    const Fwx = R[0] * Fx + R[1] * Fy + R[2] * Fz, Fwy = R[3] * Fx + R[4] * Fy + R[5] * Fz, Fwz = R[6] * Fx + R[7] * Fy + R[8] * Fz;
    const Twx = R[0] * Mx + R[1] * My + R[2] * Mz, Twy = R[3] * Mx + R[4] * My + R[5] * Mz, Twz = R[6] * Mx + R[7] * My + R[8] * Mz;
    const Fhx = ch * Fwx - sh * Fwz, Fhy = Fwy, Fhz = sh * Fwx + ch * Fwz;
    const uhx = ch * v[0] - sh * v[2], uhz = sh * v[0] + ch * v[2];
    const Mhx = m + r * A.lin[0], Mhy = m + r * A.lin[1], Mhz = m + r * A.lin[2];
    const ahx = (Fhx - psiDot * Mhz * uhz) / Mhx + psiDot * uhz;
    const ahy = Fhy / Mhy;
    const ahz = (Fhz + psiDot * Mhx * uhx) / Mhz - psiDot * uhx;
    // 转动
    const I = this.inertia, Iw = this._Ia, T = this._Ii;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[i * 3 + j] = R[i * 3] * I[j] + R[i * 3 + 1] * I[3 + j] + R[i * 3 + 2] * I[6 + j];      // R I
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Iw[i * 3 + j] = T[i * 3] * R[j * 3] + T[i * 3 + 1] * R[j * 3 + 1] + T[i * 3 + 2] * R[j * 3 + 2];   // (R I) Rᵀ
    const Lx = Iw[0] * w[0] + Iw[1] * w[1] + Iw[2] * w[2], Ly = Iw[3] * w[0] + Iw[4] * w[1] + Iw[5] * w[2], Lz = Iw[6] * w[0] + Iw[7] * w[1] + Iw[8] * w[2];
    const tx = Twx - (w[1] * Lz - w[2] * Ly), ty = Twy - (w[2] * Lx - w[0] * Lz), tz = Twz - (w[0] * Ly - w[1] * Lx);
    // A_w = H diag(a_x, a_y, a_z) Hᵀ，H = R_y(ψ)：x 轴 (ch, 0, −sh)、z 轴 (sh, 0, ch)
    const apx = r * A.rot[0], apy = r * A.rot[1], apz = r * A.rot[2];
    Iw[0] += apx * ch * ch + apz * sh * sh; Iw[2] += (apz - apx) * ch * sh; Iw[6] += (apz - apx) * ch * sh; Iw[8] += apx * sh * sh + apz * ch * ch; Iw[4] += apy;
    const Ii = inv3(Iw, this._Iinv || (this._Iinv = new Float64Array(9)));
    const al0 = Ii[0] * tx + Ii[1] * ty + Ii[2] * tz, al1 = Ii[3] * tx + Ii[4] * ty + Ii[5] * tz, al2 = Ii[6] * tx + Ii[7] * ty + Ii[8] * tz;
    // 半隐式欧拉：先速度后位置
    v[0] += (ch * ahx + sh * ahz) * h; v[1] += ahy * h; v[2] += (-sh * ahx + ch * ahz) * h;
    x[0] += v[0] * h; x[1] += v[1] * h; x[2] += v[2] * h;
    w[0] += al0 * h; w[1] += al1 * h; w[2] += al2 * h;
    quatIntegrate(this._q, w[0], w[1], w[2], h);
    // —— 遥测累加（子步平均）——
    acc.n++;
    acc.Rf += o.Ff[0] !== 0 || o.Ff[2] !== 0 ? -(o.Ff[0] * Vb[0] + o.Ff[2] * Vb[2]) / Math.max(Math.hypot(Vb[0], Vb[2]), 1e-3) : 0;
    acc.Rr += Rr; acc.Rw += windDrag;
    acc.Ri += K.out.induced + Rf.out.induced + Hf.out.induced; acc.Ra += K.out.profile + Rf.out.profile;
    acc.Rd += -(o.Fd[0] * Vb[0] + o.Fd[2] * Vb[2]) / Math.max(Math.hypot(Vb[0], Vb[2]), 1e-3);
    acc.drive += rig.main.f[2] + rig.jib.f[2]; acc.side += rig.main.f[0] + rig.jib.f[0];
    acc.hm += this._rollMoment(rig.main) + this._rollMoment(rig.jib);
    acc.rm += o.M[2]; acc.disp += FyWorld / G; acc.wet += o.wetArea + o.wetAreaAppendages; acc.wetHull += o.wetArea; acc.wp += o.wpArea;
    acc.keelSide += K.out.fx; acc.rudSide += Rf.out.fx; acc.hullSide += Hf.out.fx;
  }

  // 帆力对重心、绕船体纵轴（z）的力矩分量
  _rollMoment(sail) { const cg = this.cg; return (sail.ce[0] - cg[0]) * sail.f[1] - (sail.ce[1] - cg[1]) * sail.f[0]; }

  // VPP 式自动调帆（见 Sails.Rig.optimize）
  _autoTrim(dt) {
    const rig = this.rig, ctl = this.controls;
    if (ctl.flat !== 'auto' && ctl.reef !== 'auto') return;
    // 上身直立时受力中心高度处的视风（水平面内、船首方向坐标系）
    const R = this._R, v = this._v, yaw = Math.atan2(R[2], R[8]), fx = Math.sin(yaw), fz = Math.cos(yaw);
    const zce = (rig.main.ce[1] * rig.g.main.area + rig.jib.ce[1] * rig.g.jib.area) / (rig.g.main.area + rig.g.jib.area);
    const k = this._profile.ratioAt(zce);
    const ax = this._wind.x * k - v[0], az = this._wind.z * k - v[2];
    const along = ax * fx + az * fz, across = ax * fz - az * fx;
    const aws = Math.hypot(ax, az), beta = Math.atan2(Math.abs(across), -along);
    if (this._awsF == null) { this._awsF = aws; this._betaF = beta; }
    const a = Math.min(1, dt / 2.0);
    this._awsF += (aws - this._awsF) * a; this._betaF += (beta - this._betaF) * a;
    // 实测横倾反馈：浪和阵风里动态横倾大于静态预测时（均方根横倾超过上限），像水手一样再多缩一点帆 ——
    // 慢速积分地降低给优化器用的横倾上限（只降不升，横倾回落后再慢慢恢复）
    const lim0 = clamp(ctl.heelLimit, 5 * DEG, 85 * DEG), heel = Math.atan2(R[3], R[4]);
    this._heel2 += (heel * heel - this._heel2) * Math.min(1, dt / 6);
    this._limAdj = clamp(this._limAdj - (Math.sqrt(this._heel2) - lim0) * 0.08 * dt, -(lim0 - 5 * DEG), 0);
    const lim = lim0 + this._limAdj;
    const best = rig.optimize(this._awsF, this._betaF, { heelLimit: lim, RM: this._RM(lim), lever0: this.clrDepth });
    // 压平快（约 1.5 s），缩帆慢（约 6 s）
    if (ctl.flat === 'auto') rig.flat += (best.flat - rig.flat) * Math.min(1, dt / 1.5);
    if (ctl.reef === 'auto') rig.reef += (best.reef - rig.reef) * Math.min(1, dt / 6);
  }

  _clearAcc() {
    const a = this._acc;
    for (const k of ['n', 'Rf', 'Rr', 'Rw', 'Ri', 'Ra', 'Rd', 'drive', 'side', 'hm', 'rm', 'disp', 'wet', 'wetHull', 'wp', 'keelSide', 'rudSide', 'hullSide']) a[k] = 0;
  }

  // ------------------------------------------------------------------ 输出
  _publish(dt = 0, n = 0) {
    const R = quatToMat(this._q, this._R), cg = this.cg, x = this._x, v = this._v, w = this._w, q = this._q, s = this.state;
    const P = this._P;
    P[0] = x[0] - (R[0] * cg[0] + R[1] * cg[1] + R[2] * cg[2]); P[1] = x[1] - (R[3] * cg[0] + R[4] * cg[1] + R[5] * cg[2]); P[2] = x[2] - (R[6] * cg[0] + R[7] * cg[1] + R[8] * cg[2]);
    mulMtV(R, v, this._V); mulMtV(R, w, this._W);
    s.position.x = P[0]; s.position.y = P[1]; s.position.z = P[2];
    s.quaternion.x = q.x; s.quaternion.y = q.y; s.quaternion.z = q.z; s.quaternion.w = q.w;
    s.velocity.x = v[0]; s.velocity.y = v[1]; s.velocity.z = v[2];
    s.angularVelocity.x = w[0]; s.angularVelocity.y = w[1]; s.angularVelocity.z = w[2];
    s.cg.x = x[0]; s.cg.y = x[1]; s.cg.z = x[2];
    const e = matToYXZ(R);
    const T = this.telemetry, acc = this._acc, an = Math.max(1, acc.n || 0);
    // 力、力矩、阻力分解：子步平均后再做 τ = 0.5 s 的指数平滑（浪里这些量逐帧剧烈起伏，读数需要平稳）
    const F = this._tf || (this._tf = {}), kf = n > 0 ? 1 - Math.exp(-dt / 0.5) : 1;
    const sm = (key, val) => (F[key] = !Number.isFinite(F[key]) || n === 0 ? (Number.isFinite(val) ? val : 0) : F[key] + (val - F[key]) * kf);
    const yaw = e.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw);
    const wc = this._waterVel(x[0], 0, x[2], this._t1);
    const ux = v[0] - wc[0], uz = v[2] - wc[2], stw = Math.hypot(ux, uz), sog = Math.hypot(v[0], v[2]);
    const U10 = Math.hypot(this._wind.x, this._wind.z);
    // 真风角：风源方向相对船首，顺时针为正（右舷来风 > 0）
    const twa = U10 > 1e-6 ? wrap(yaw - Math.atan2(-this._wind.x, -this._wind.z)) : 0;
    const rig = this.rig, st = rig.state, LWL = this.form.LWL, Fn = stw / Math.sqrt(G * LWL);
    const leeway = stw > 0.05 ? Math.atan2(-(ux * fz - uz * fx), ux * fx + uz * fz) : 0;   // 顺时针为正：向右舷横漂
    // 桅顶视风（直立、水平）
    const at = this._airAt([0, this.layout.mastTop, this.layout.zMast], this._ah);
    Object.assign(T, {
      time: this.time,
      speed: stw, speedKn: stw / KN, sog, sogKn: sog / KN,
      yaw, heading: bearing(fx, fz), cog: sog > 0.02 ? bearing(v[0], v[2]) : bearing(fx, fz),
      leeway: leeway / DEG, heel: e.roll / DEG, pitch: -e.pitch / DEG,
      heaveVelocity: v[1], rollRate: this._W[2] / DEG, pitchRate: -this._W[0] / DEG, yawRate: w[1] / DEG,
      tws: U10, twsKn: U10 / KN, twa: twa / DEG, tack: twa >= 0 ? 'starboard' : 'port',
      aws: st.aws, awsKn: st.aws / KN, awa: st.beta / DEG,
      awsMasthead: Math.hypot(at[0], at[2]), awaMasthead: Math.atan2(at[0], -at[2]) / DEG,
      vmg: (v[0] * -this._wind.x + v[2] * -this._wind.z) / Math.max(U10, 1e-6), vmgKn: (v[0] * -this._wind.x + v[2] * -this._wind.z) / Math.max(U10, 1e-6) / KN,
      sailCL: st.cl, sailCD: st.cd, flat: rig.flat, reef: rig.reef, sheet: this._sheetValue(), boomAngle: st.boom / DEG,
      driveForce: sm('drive', acc.drive / an), sideForce: sm('side', acc.side / an),
      heelingMoment: Math.abs(sm('hm', acc.hm / an)), rightingMoment: Math.abs(sm('rm', acc.rm / an)),
      resistance: {
        friction: sm('Rf', acc.Rf / an), residuary: sm('Rr', acc.Rr / an), induced: sm('Ri', acc.Ri / an), appendage: sm('Ra', acc.Ra / an),
        radiation: sm('Rd', acc.Rd / an), windage: sm('Rw', acc.Rw / an), total: sm('Rt', (acc.Rf + acc.Rr + acc.Ri + acc.Ra + acc.Rd + acc.Rw) / an),
      },
      sideForceKeel: sm('ks', acc.keelSide / an), sideForceRudder: sm('rs', acc.rudSide / an), sideForceHull: sm('hs', acc.hullSide / an),
      rudderAngle: this.autopilot.rudder / DEG, helm: this.autopilot.rudder / DEG * (twa >= 0 ? 1 : -1),
      Fn, hullSpeedKn: 0.4 * Math.sqrt(G * LWL) / KN,
      displacement: sm('disp', acc.n ? acc.disp / an : this.mass), mass: this.mass,
      wettedArea: sm('wet', acc.n ? acc.wet / an : this._wetHull0 + this._wetApp0), wettedAreaHull: sm('wetH', acc.n ? acc.wetHull / an : this._wetHull0),
      waterplaneArea: sm('wp', acc.n ? acc.wp / an : this.waterplaneArea),
      substeps: n, autopilot: this.autopilot.mode, turning: this.autopilot.turning,
    });
    // —— 帆的外观状态 ——
    const S = this.sail;
    S.side = rig.side; S.boomAngle = rig.side * st.boom; S.jibSheet = clamp((st.jibAngle - 0.12) / 0.75, 0, 1);
    S.luff = st.luff; S.fill = st.fill; S.aws = st.aws; S.awa = st.beta; S.reef = rig.reef; S.flat = rig.flat;
    const al = Math.hypot(at[0], at[2]) || 1; S.awLocal.x = at[0]; S.awLocal.z = at[2]; S.awLocal.len = al;
    // —— 砰击 / 飞溅事件 ——
    this.events.length = 0;
    if (n > 0) {
      const bins = this.integ.out.slamBins;
      for (let i = 0; i < bins.length; i++) {
        const b = bins[i]; if (!(b.w > 0)) continue;
        const ev = this._eventPool[i], iw = 1 / b.w;
        const lp = [b.x * iw, b.y * iw, b.z * iw], jet = [b.vx * iw, b.vy * iw, b.vz * iw], nn = [b.nx * iw, b.ny * iw, b.nz * iw];
        const pw = mulMV(R, lp, [0, 0, 0]), jw = mulMV(R, jet, [0, 0, 0]), nw = mulMV(R, nn, [0, 0, 0]);
        const r = [pw[0] + P[0] - x[0], pw[1] + P[1] - x[1], pw[2] + P[2] - x[2]];
        ev.position.x = pw[0] + P[0]; ev.position.y = pw[1] + P[1]; ev.position.z = pw[2] + P[2];
        ev.velocity.x = v[0] + w[1] * r[2] - w[2] * r[1] + jw[0]; ev.velocity.y = v[1] + w[2] * r[0] - w[0] * r[2] + jw[1]; ev.velocity.z = v[2] + w[0] * r[1] - w[1] * r[0] + jw[2];
        const nl = Math.hypot(nw[0], nw[1], nw[2]) || 1;
        ev.normal.x = nw[0] / nl; ev.normal.y = nw[1] / nl; ev.normal.z = nw[2] / nl;
        // 强度：入水速度² × 新浸湿面积的速率（m²/s）—— 正比于被排开、溅起的水的动量通量；2 m/s、1 m²/s 约为 0.5
        ev.speed = b.vmax; ev.area = b.area; ev.areaRate = b.area / Math.max(dt, 1e-6);
        ev.intensity = clamp(b.vmax * b.vmax * ev.areaRate / 8, 0, 1);
        this.events.push(ev);
      }
    }
    // —— 船行波（尾迹）源 ——
    const Wk = this.wake, f = this.form;
    const bow = mulMV(R, [0, 0, f.zFPP], [0, 0, 0]), stern = mulMV(R, [0, 0, f.zAPP], [0, 0, 0]);
    Wk.bow.x = bow[0] + P[0]; Wk.bow.y = bow[1] + P[1]; Wk.bow.z = bow[2] + P[2];
    Wk.stern.x = stern[0] + P[0]; Wk.stern.y = stern[1] + P[1]; Wk.stern.z = stern[2] + P[2];
    if (stw > 1e-3) { Wk.direction.x = ux / stw; Wk.direction.z = uz / stw; } else { Wk.direction.x = fx; Wk.direction.z = fz; }
    Wk.speed = stw; Wk.Fn = Fn;
    // Kelvin 角 19.47°；Fn 大于约 0.6 时随 Fn⁻¹ 变窄（Rabaud & Moisy 2013，见 wakeAngle）
    Wk.angle = wakeAngle(Fn);
    // 兴波能量：每单位航程留在尾迹里的能量 = 兴波阻力，R_w ≈ ¼ ρ g A² L → 波幅 A
    const Rr = acc.n ? acc.Rr / an : 0;
    Wk.amplitude = Math.sqrt(4 * Rr / (this.rho * G * LWL));
    Wk.strength = clamp(Wk.amplitude / 0.25, 0, 1);
  }

  _sheetValue() {
    const c = this.controls.sheet;
    if (c !== 'auto' && c != null) return clamp(+c, 0, 1);
    return clamp((this.rig.state.boom - 0.06) / (1.45 - 0.06), 0, 1);
  }

  /** 主要参数（排水量、重心、惯性、附加质量、固有周期等），供 README / 调试 */
  get particulars() {
    const f = this.form;
    return {
      LOA: this.hull.length, LWL: f.LWL, BWL: f.BWL, Tc: f.Tc, draft: -this.layout.keel.tipY,
      displacement: this.mass, volume: this.volume, ballast: this.options.ballastRatio * this.mass,
      cg: this.cg, lcb: this.lcb, GM: this.GM, inertia: [this.inertia[0], this.inertia[4], this.inertia[8]],
      addedMass: this.addedMass, radiation: this.radiation, naturalPeriods: this.naturalPeriods,
      sailArea: this.rig.g.main.area + this.rig.g.jib.area, mainArea: this.rig.g.main.area, jibArea: this.rig.g.jib.area,
      keelArea: this.keel.area, keelAR: this.keel.arEff, rudderArea: this.rudderFoil.area, rudderAR: this.rudderFoil.arEff,
      wettedArea: this._wetHull0 + this._wetApp0, wettedAreaHull: this._wetHull0, waterplaneArea: this.waterplaneArea,
      form: f, components: this.components,
    };
  }
}
