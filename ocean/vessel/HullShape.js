// =====================================================================================
// HullShape —— 船体型线（纯数学，不依赖 three.js）
//
// extras/Sailboat.js 里的 HullGenerator 顶部 import 了 three，Node 测试无法直接加载，
// 这里逐字复刻它的型线公式（halfBreadth / keel / sheer / section / zAt / halfWidthAt），
// 测试里用加载钩子把 three 换成空模块后与 HullGenerator 逐点比对，保证物理船体与画面船体同一套参数、同一个形状。
//
// 坐标（船体局部）：原点在水线中心，船首 +Z，左舷 +X，Y 向上；y = 0 是设计水线（Sailboat 的水线漆带就在这里）。
//
// sailboatLayout(p) 复刻 Sailboat 构造函数里写死的布置：桅位、桅高、横杆、主帆 / 前帆角点、
// 长龙骨与艉挂舵的轮廓、舱室尺寸。物理模型的帆、龙骨、舵都按画面上看到的位置和尺寸建模。
// =====================================================================================

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 与 HullGenerator.defaults 完全相同（画面船体的默认参数） */
export const HULL_DEFAULTS = Object.freeze({
  length: 8.6, beam: 2.75, draft: 0.92, freeboard: 0.8, sheerRise: 0.45, transom: 0.66,
  maxBeamAt: 0.42, entry: 1.7, bilge: 2.5, flare: 0.1, stations: 64, girth: 22,
});

/**
 * 物理模型默认船体：只把船体本身的吃水（canoe body draft）从 0.92 m 改为 0.40 m，其余与画面默认值相同。
 * 原因：默认型线在 y = 0 水线下排水 9.3 m³（9.6 t），对 8.6 m 的巡航帆船重了一倍多
 * （同尺度量产船 3–5 t，例如 Beneteau Evasion 28：8.5 m、4.2 t）。吃水 0.40 m 时船体排水 3.4 m³，
 * 加上长龙骨约 4.1 t，L/∇^(1/3) = 5.5、B/T = 5.7、Cp = 0.58，全部落在 DSYHS 阻力回归的适用范围内。
 * 画面船用同一组参数：new Sailboat({ hull: YACHT_HULL })（或 yacht.hull）。
 */
export const YACHT_HULL = Object.freeze({ ...HULL_DEFAULTS, draft: 0.40 });

export const HullShape = {
  defaults: HULL_DEFAULTS,
  halfBreadth(p, s) {
    const sm = p.maxBeamAt;
    if (s <= sm) { const t = (sm - s) / sm; return p.beam / 2 * (p.transom + (1 - p.transom) * (1 - t * t)); }
    const t = (s - sm) / (1 - sm); return p.beam / 2 * Math.max(0, 1 - Math.pow(t, p.entry));
  },
  keel(p, s) { const t = (s - 0.47) / 0.56; return -p.draft * Math.max(0.14, 1 - Math.pow(Math.abs(t), 2.2)); },
  sheer(p, s) { const t = s > 0.45 ? (s - 0.45) / 0.55 : (0.45 - s) / 0.45 * 0.4; return p.freeboard + p.sheerRise * t * t; },
  section(p, s, th) {
    const b = this.halfBreadth(p, s), k = this.keel(p, s), sh = this.sheer(p, s), e = p.bilge;
    const y = sh - (sh - k) * Math.pow(Math.cos(th), 2 / e);
    const x = b * Math.pow(Math.sin(th), 2 / e) * (1 + p.flare * clamp(y / p.freeboard, 0, 1));
    return [x, y];
  },
  zAt(p, s) { return s * p.length - p.length / 2; },
  halfWidthAt(p, s, y) {
    const sh = this.sheer(p, s), k = this.keel(p, s);
    if (y <= k || y >= sh) return y >= sh ? this.section(p, s, Math.PI / 2)[0] : 0;
    const c = Math.pow((sh - y) / (sh - k), p.bilge / 2), th = Math.acos(clamp(c, 0, 1));
    return this.halfBreadth(p, s) * Math.pow(Math.sin(th), 2 / p.bilge) * (1 + p.flare * clamp(y / p.freeboard, 0, 1));
  },
};

// 二次贝塞尔曲线（与 three.js Shape.quadraticCurveTo 相同的参数化）
function quad(p0, p1, p2, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}

/**
 * Sailboat 构造函数里写死的布置（见 extras/Sailboat.js 的“长龙骨 + 艉挂舵”“桅、撑臂”“帆”各段）。
 * 返回的轮廓都在 (z, y) 平面内，单位 m。
 */
export function sailboatLayout(p, { mastHeight = 10.6, shape = HullShape } = {}) {
  const sAt = (s) => shape.sheer(p, s), zAt = (s) => shape.zAt(p, s);
  const deckY = sAt(0.5), zMast = zAt(0.6), zBow = zAt(1), zStern = zAt(0);

  // —— 长龙骨：上缘贴着船体龙骨线（s = 0.2 → 0.72），下缘 y = −1.36（s = 0.3 → 0.66），前后缘是二次曲线 ——
  // 画面上的龙骨上缘比船体龙骨线高 6 cm（藏接缝），物理模型取船体龙骨线本身，避免与船体体积重叠。
  const kb = -1.36, keel = [];
  for (let i = 0; i <= 10; i++) { const s = 0.2 + 0.52 * i / 10; keel.push([zAt(s), shape.keel(p, s)]); }
  const leA = keel[keel.length - 1], leC = [zAt(0.74), kb + 0.25], leB = [zAt(0.66), kb];
  for (let i = 1; i <= 6; i++) keel.push(quad(leA, leC, leB, i / 6));
  const teA = [zAt(0.3), kb], teC = [zAt(0.2), kb + 0.05], teB = keel[0];
  keel.push(teA.slice());
  for (let i = 1; i < 6; i++) keel.push(quad(teA, teC, teB, i / 6));

  // —— 艉挂舵：舵杆在艉板后 2 cm，前缘竖直，下角与后缘是二次曲线 ——
  const top = sAt(0) - 0.15, rudder = [[zStern - 0.02, top], [zStern - 0.02, -0.95]];
  const r1 = [zStern - 0.02, -0.95], r1c = [zStern - 0.1, -1.08], r1e = [zStern - 0.42, -0.98];
  for (let i = 1; i <= 4; i++) rudder.push(quad(r1, r1c, r1e, i / 4));
  const r2c = [zStern - 0.6, -0.5], r2e = [zStern - 0.36, 0.05];
  for (let i = 1; i <= 5; i++) rudder.push(quad(r1e, r2c, r2e, i / 5));
  rudder.push([zStern - 0.18, top]);

  // —— 桅、横杆、帆（Sailboat：boomPivot、_mainGeo 的弦长函数、前帆 T / Hd / C 三个角点）——
  const boomPivot = [0, deckY + 1.25, zMast - 0.08], boomLength = 3.9;
  const stem = [0, sAt(0.995) + 0.05, zBow - 0.12];
  const jib = {
    tack: [0, stem[1] + 0.05, stem[2] - 0.08],
    head: [0, deckY + 8.3, zMast + 0.06],
    clewRadius: 2.7, clewY: deckY + 0.95, clewPivotZ: zBow - 0.3,      // C = (side·sin a·2.7, deckY + 0.95, zBow − 0.3 − cos a·2.7)
    sheetToAngle: (sheet) => 0.12 + sheet * 0.75,                       // Sailboat：ang = 0.12 + jibSheet·0.75
  };
  const main = {
    luffLength: mastHeight - 1.6, footLength: boomLength - 0.15, yOffset: 0.1,
    chord: (v) => (boomLength - 0.15) * Math.pow(1 - v, 0.95) + 0.18 + 0.35 * Math.sin(Math.PI * v) * (1 - v),
    sheetToAngle: (sheet) => 0.06 + (1.45 - 0.06) * sheet,              // Sailboat：mag = lerp(0.06, 1.45, sheet)
  };
  // 舱室（Sailboat：RoundedBoxGeometry(1.55, 0.62, 2.5)，中心 cabinZ = zMast − 0.55，顶在 deckY + 0.55）
  const cabin = { halfWidth: 0.775, z0: zMast - 0.55 - 1.25, z1: zMast - 0.55 + 1.25, top: deckY + 0.6 };
  return {
    deckY, zMast, zBow, zStern, mastHeight, mastBase: deckY, mastTop: deckY + mastHeight,
    keel: { outline: keel, tipY: kb, thickness: 0.2 }, rudder: { outline: rudder, stockZ: zStern - 0.02, thickness: 0.09 },
    boomPivot, boomLength, main, jib, cabin,
    cockpit: [0, deckY + 0.5, zStern + 1.55],
  };
}
