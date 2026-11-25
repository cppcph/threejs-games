// =====================================================================================
// HullMesh —— 物理用的闭合三角网格（船体壳 + 艉板 + 甲板 / 舱室顶，长龙骨、艉挂舵两块实体）
//
// 静水力与 Froude–Krylov 力都来自对这些三角形的水压积分（Kerner 2015/2016），所以网格必须是**闭合**的：
// 闭合曲面上 ∮ p n dA 按散度定理等于 ρ g ∇（阿基米德），浮心、复原力矩也就精确地由几何决定。
//   · 船体壳：沿船长 S 个站位 × 每舷 G 段围长（与 HullGenerator 同一条超椭圆型线），站位均匀，
//     并在舱室前后端插入站位，让舱室前后壁是竖直的。
//   · 艉板：方艉平面，从形心做扇形三角化。
//   · 甲板：舷弧高度的平甲板，舱室范围内升高为舱室顶（大横倾时舱室提供浮力，决定稳性消失角）。
//     甲板外缘与船体壳共用舷弧顶点，所以整体严格闭合（舱室端部用重复站位做出竖直壁）。
//   · 龙骨、舵：轮廓多边形（来自 Sailboat 的画面轮廓）沿 x 拉伸成等厚板（耳切法三角化），各自闭合。
// 三角形绕序使法线朝外；tag 标记部件（0 船体壳、1 艉板、2 甲板、3 龙骨、4 舵），决定摩擦、砰击等是否作用。
// =====================================================================================
import { HullShape, sailboatLayout } from './HullShape.js';

export const TAG = { HULL: 0, TRANSOM: 1, DECK: 2, KEEL: 3, RUDDER: 4 };

class MeshBuilder {
  constructor() { this.v = []; this.t = []; this.tag = []; }
  vert(x, y, z) { this.v.push(x, y, z); return this.v.length / 3 - 1; }
  tri(a, b, c, tag) {
    // 丢掉退化三角形（舱室端部重复站位产生的零面积三角形）
    const v = this.v;
    const ux = v[b * 3] - v[a * 3], uy = v[b * 3 + 1] - v[a * 3 + 1], uz = v[b * 3 + 2] - v[a * 3 + 2];
    const wx = v[c * 3] - v[a * 3], wy = v[c * 3 + 1] - v[a * 3 + 1], wz = v[c * 3 + 2] - v[a * 3 + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) return;
    this.t.push(a, b, c); this.tag.push(tag);
  }
  finish() {
    return { vertices: Float64Array.from(this.v), triangles: Uint16Array.from(this.t), tags: Uint8Array.from(this.tag) };
  }
}

/** 均匀站位，并插入额外站位（距已有站位太近的旧站位被替换，避免细长三角形） */
function stationList(n, extra) {
  let s = [];
  for (let i = 0; i <= n; i++) s.push(i / n);
  for (const e of extra) {
    s = s.filter((x) => Math.abs(x - e) > 0.35 / n || x === 0 || x === 1);
    s.push(e);
  }
  return [...new Set(s)].sort((a, b) => a - b);
}

/**
 * 闭合船体（壳 + 艉板 + 甲板 / 舱室）。
 * opts.stations：沿船长的分段数（默认 28），opts.girth：每舷围长分段数（默认 8）
 */
export function buildHull(p, layout, { stations = 28, girth = 8, shape = HullShape, cabin = true } = {}) {
  const B = new MeshBuilder(), G = girth, cols = 2 * G + 1;
  const cab = cabin ? layout.cabin : null;
  const sc0 = cab ? (cab.z0 + p.length / 2) / p.length : -1, sc1 = cab ? (cab.z1 + p.length / 2) / p.length : -1;
  const S = stationList(stations, cab ? [sc0, sc1] : []);
  // —— 船体壳：j = −G（右舷舷弧）… 0（龙骨）… +G（左舷舷弧），与 HullGenerator 相同 ——
  const idx = [];
  for (const s of S) {
    const z = shape.zAt(p, s), row = [];
    for (let j = -G; j <= G; j++) {
      const [x, y] = shape.section(p, s, Math.abs(j) / G * Math.PI / 2);
      row.push(B.vert(Math.sign(j) * x, y, z));
    }
    idx.push(row);
  }
  for (let i = 0; i < S.length - 1; i++) for (let c = 0; c < cols - 1; c++) {
    const a = idx[i][c], b = idx[i][c + 1], cc = idx[i + 1][c], d = idx[i + 1][c + 1];
    B.tri(a, b, cc, 0); B.tri(b, d, cc, 0);           // HullGenerator 的外法线绕序
  }
  // —— 艉板（s = 0，法线 −Z）：凸多边形，从形心做扇形 ——
  {
    const row = idx[0], z0 = shape.zAt(p, 0);
    let cy = 0; for (const k of row) cy += B.v[k * 3 + 1]; cy /= row.length;
    const c = B.vert(0, cy, z0);
    for (let k = 0; k < row.length - 1; k++) B.tri(c, row[k + 1], row[k], 1);
    B.tri(c, row[0], row[row.length - 1], 1);           // 顶边：左舷舷弧 → 右舷舷弧
  }
  // —— 甲板：每个站位 7 个点 [左舷舷弧, (fb, sh), (fb, top), (0, top), (−fb, top), (−fb, sh), 右舷舷弧] ——
  // 舱室外 top = sh（零高度的“墙”是退化三角形，会被丢掉）；舱室两端重复站位：一份 top = sh，一份 top = 舱顶。
  const deckRows = [];
  const deckSection = (i, inside) => {
    const s = S[i], z = shape.zAt(p, s), sh = shape.sheer(p, s), bx = shape.section(p, s, Math.PI / 2)[0];
    const xc = cab ? Math.min(cab.halfWidth, 0.85 * bx) : 0.5 * bx;
    const top = inside ? cab.top : sh;
    deckRows.push([idx[i][cols - 1], B.vert(xc, sh, z), B.vert(xc, top, z), B.vert(0, top, z), B.vert(-xc, top, z), B.vert(-xc, sh, z), idx[i][0]]);
  };
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    if (cab && Math.abs(s - sc0) < 1e-9) { deckSection(i, false); deckSection(i, true); }
    else if (cab && Math.abs(s - sc1) < 1e-9) { deckSection(i, true); deckSection(i, false); }
    else deckSection(i, cab && s > sc0 && s < sc1);
  }
  for (let d = 0; d < deckRows.length - 1; d++) for (let q = 0; q < 6; q++) {
    const a = deckRows[d][q], b = deckRows[d][q + 1], c = deckRows[d + 1][q], e = deckRows[d + 1][q + 1];
    B.tri(a, b, c, 2); B.tri(b, e, c, 2);              // 法线朝上（舱壁朝外）
  }
  return B.finish();
}

// —— 平面多边形耳切三角化（(u, v) 坐标，返回同绕序三角形索引）——
function signedArea(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
function earClip(P) {
  const n = P.length, ccw = signedArea(P) > 0, V = [...Array(n).keys()], out = [];
  const cross = (o, a, b) => (P[a][0] - P[o][0]) * (P[b][1] - P[o][1]) - (P[a][1] - P[o][1]) * (P[b][0] - P[o][0]);
  const inside = (p, a, b, c) => {
    const s1 = cross(a, b, p), s2 = cross(b, c, p), s3 = cross(c, a, p);
    return ccw ? (s1 > 1e-12 && s2 > 1e-12 && s3 > 1e-12) : (s1 < -1e-12 && s2 < -1e-12 && s3 < -1e-12);
  };
  let guard = 0;
  while (V.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < V.length; i++) {
      const a = V[(i + V.length - 1) % V.length], b = V[i], c = V[(i + 1) % V.length];
      const cr = cross(a, b, c);
      if (ccw ? cr <= 1e-12 : cr >= -1e-12) continue;            // 凹角或共线：不是耳
      let ok = true;
      for (const k of V) if (k !== a && k !== b && k !== c && inside(k, a, b, c)) { ok = false; break; }
      if (!ok) continue;
      out.push([a, b, c]); V.splice(i, 1); cut = true; break;
    }
    if (!cut) { // 数值退化：剩下的直接扇形
      for (let i = 1; i < V.length - 1; i++) out.push([V[0], V[i], V[i + 1]]);
      return out;
    }
  }
  if (V.length === 3) out.push([V[0], V[1], V[2]]);
  return out;
}

/**
 * (z, y) 轮廓沿 x 拉伸成厚 t 的闭合板（龙骨、舵）。返回 { vertices, triangles, tags } 与平面几何量。
 */
export function buildSlab(outline, thickness, tag) {
  // 去掉首尾重复点
  const P = outline.filter((p, i) => i === 0 || Math.hypot(p[0] - outline[i - 1][0], p[1] - outline[i - 1][1]) > 1e-6);
  if (Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1e-6) P.pop();
  const B = new MeshBuilder(), h = thickness / 2, n = P.length;
  const L = P.map(([z, y]) => B.vert(h, y, z)), R = P.map(([z, y]) => B.vert(-h, y, z));
  // 多边形在 (u, v) = (z, y) 平面：从 +x 看过去，(z, y) 的逆时针在屏幕上是顺时针（屏幕右方 = −z）
  const ccw = signedArea(P) > 0;
  for (const [a, b, c] of earClip(P)) {
    // +x 面法线要朝 +x：(z, y) 平面里顺时针的三角形在 3D 中法线朝 +x
    if (ccw) { B.tri(L[a], L[c], L[b], tag); B.tri(R[a], R[b], R[c], tag); }
    else { B.tri(L[a], L[b], L[c], tag); B.tri(R[a], R[c], R[b], tag); }
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (ccw) { B.tri(L[i], L[j], R[j], tag); B.tri(L[i], R[j], R[i], tag); }
    else { B.tri(L[i], R[j], L[j], tag); B.tri(L[i], R[i], R[j], tag); }
  }
  const m = B.finish();
  // 平面几何：面积、形心、展长（翼型模型用）
  let A = 0, cz = 0, cy = 0;
  for (let i = 0; i < n; i++) { const [z0, y0] = P[i], [z1, y1] = P[(i + 1) % n], c = z0 * y1 - z1 * y0; A += c; cz += (z0 + z1) * c; cy += (y0 + y1) * c; }
  A /= 2; cz /= 6 * A; cy /= 6 * A;
  m.planform = { outline: P, area: Math.abs(A), centroid: [cz, cy] };
  return m;
}

/** 合并若干网格（顶点索引平移） */
export function mergeMeshes(list) {
  let nv = 0, nt = 0;
  for (const m of list) { nv += m.vertices.length; nt += m.triangles.length; }
  const vertices = new Float64Array(nv), triangles = new Uint16Array(nt), tags = new Uint8Array(nt / 3);
  let ov = 0, ot = 0;
  for (const m of list) {
    vertices.set(m.vertices, ov);
    const base = ov / 3;
    for (let i = 0; i < m.triangles.length; i++) triangles[ot + i] = m.triangles[i] + base;
    tags.set(m.tags, ot / 3);
    ov += m.vertices.length; ot += m.triangles.length;
  }
  if (nv / 3 > 65535) throw new Error('HullMesh: 顶点太多');
  return { vertices, triangles, tags };
}

/** 闭合网格的体积、形心、表面积（散度定理），以及 ∮n dA（闭合时应为 0） */
export function meshProperties(m, tagFilter = null) {
  const v = m.vertices, t = m.triangles;
  let V = 0, cx = 0, cy = 0, cz = 0, A = 0, nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < t.length; i += 3) {
    if (tagFilter && !tagFilter(m.tags[i / 3])) continue;
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ax = v[a], ay = v[a + 1], az = v[a + 2], bx = v[b], by = v[b + 1], bz = v[b + 2], qx = v[c], qy = v[c + 1], qz = v[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = qx - ax, wy = qy - ay, wz = qz - az;
    const sx = (uy * wz - uz * wy) / 2, sy = (uz * wx - ux * wz) / 2, sz = (ux * wy - uy * wx) / 2;
    A += Math.hypot(sx, sy, sz); nx += sx; ny += sy; nz += sz;
    const d = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;   // 四面体（原点, a, b, c）体积
    V += d; cx += d * (ax + bx + qx) / 4; cy += d * (ay + by + qy) / 4; cz += d * (az + bz + qz) / 4;
  }
  return { volume: V, centroid: [cx / V, cy / V, cz / V], area: A, closure: Math.hypot(nx, ny, nz) };
}

/** 建好整条船的物理网格（船体 + 龙骨 + 舵），返回合并网格与各部件 */
export function buildYachtMesh(p, { layout = sailboatLayout(p), stations = 28, girth = 8, keelThickness = 0.16, rudderThickness = 0.07, shape = HullShape } = {}) {
  const hull = buildHull(p, layout, { stations, girth, shape });
  const keel = buildSlab(layout.keel.outline, keelThickness, TAG.KEEL);
  const rudder = buildSlab(layout.rudder.outline, rudderThickness, TAG.RUDDER);
  return { mesh: mergeMeshes([hull, keel, rudder]), hull, keel, rudder, layout };
}
