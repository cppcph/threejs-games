// =====================================================================================
// Hydrostatics —— 船体三角面上的水压积分（静水力 + Froude–Krylov），以及面元摩擦、辐射阻尼、砰击
//
// 方法（J. Kerner, "Water interaction model for boats in video games", Gamasutra 2015 第 1 部分；2016 第 2 部分）：
//   1. 每个顶点取其正上方 / 正下方的水面高度 η(x, z)，浸深 d = η − y（> 0 在水下）。
//   2. 三角形三个顶点都在水下 → 整块参与；都在水上 → 跳过；跨水线 → 沿边线性插值找 d = 0 的点，
//      只保留水下部分（1 或 2 个子三角形）。只有跨水线的三角形需要裁剪。
//   3. 子三角形上的压强按顶点线性分布。对线性压强，力与力矩有精确的闭式积分：
//        F = −∫p n dA = −(p₁+p₂+p₃)/3 · S              （S = 面积向量，外法线方向）
//        M = −∫p (r − c) × n dA = −(1/12)[(Σp)(Σρᵢ) + Σ pᵢ ρᵢ] × S   （ρᵢ = rᵢ − 重心）
//      Kerner 原文把力作用在三角形形心，这里用精确的压力中心积分，横倾小角度时复原力矩不会有偏差。
//   闭合网格 + 平静水面时，按散度定理 ΣF 严格等于 ρ g ∇（阿基米德），浮心严格等于排水体积形心。
//
// 压强（Froude–Krylov，含 Smith 效应）：线性 Airy 波的动压随深度按 e^{ky} 衰减，用 Wheeler 拉伸写成
//        p = ρ g [ η · e^{k (y − η)} − y ]          （y < η）
//   在水面 y = η 处 p = 0；k → 0 时退化为 Kerner 的 p = ρ g (η − y)；深处 → −ρ g y。
//   k 取主波波数（由调用者给，默认 0 = 不衰减）。比船长的浪抬起整条船，比船短的浪在船长、船宽上平均掉 ——
//   这是积分本身的结果，不是额外规则。
//
// 面元摩擦（ITTC-1957，Kerner 第 2 部分的“粘性阻力”）：每块浸水的船体壳三角形上
//        dF = −½ ρ C_F (1+k) |v_t| v_t dA，v_t = 该处相对水流速度的切向分量
//   于是横倾、纵倾、波浪中湿表面积的变化都自动进入摩擦阻力；横倾时下风侧湿面积大 → 产生偏航力矩（上风舵）。
//
// 辐射阻尼（线性化）：只取相对水的**竖直**速度（升沉、纵摇、横摇运动产生的那部分），只施加竖直力
//        dF_y = −ρ c_rad e^{k_r y} (v_rel,y · n_y) · n_y dA
//   c_rad [m/s] 由升沉阻尼比标定（见 SailingYacht），纵摇、横摇的阻尼随几何分布自然得到。只用竖直分量，
//   是为了不和龙骨 / 船体的侧向升力、前进阻力重复计算。相对速度里扣掉了水质点速度，所以随长浪一起起伏时没有阻尼。
//
// 砰击（Wagner 1932 思路的简化）：跨水线、竖直方向正在压入水中的面元附加二次压强 p_s = ½ ρ C_s v_n²（竖直分量）；
//   上一子步完全在水上、这一子步入水且 v_n 超过阈值的面元记为“砰击 / 飞溅”事件。
//   Wagner 理论中溅射根部的射流速度约为入水速度的 2 倍，方向沿船壳表面向外、向上。
// =====================================================================================
import { TAG } from './HullMesh.js';

const BINS = 6;   // 砰击事件分区：船首 / 中部 / 船尾 × 左 / 右舷

export class HullIntegrator {
  constructor(mesh, { rho = 1025, g = 9.81 } = {}) {
    this.rho = rho; this.g = g;
    const v = mesh.vertices, t = mesh.triangles;
    this.nv = v.length / 3; this.nt = t.length / 3;
    this.bx = new Float64Array(this.nv); this.by = new Float64Array(this.nv); this.bz = new Float64Array(this.nv);
    for (let i = 0; i < this.nv; i++) { this.bx[i] = v[i * 3]; this.by[i] = v[i * 3 + 1]; this.bz[i] = v[i * 3 + 2]; }
    this.tri = t; this.tags = mesh.tags;
    // 每个顶点相邻三角形的最长边：顶点高出“最高水面 + 该长度”时，它所在的三角形必然全在水上，才可以不采样水面
    this.vlen = new Float64Array(this.nv);
    for (let i = 0; i < t.length; i += 3) for (let e = 0; e < 3; e++) {
      const a = t[i + e], b = t[i + (e + 1) % 3];
      const l = Math.hypot(v[a * 3] - v[b * 3], v[a * 3 + 1] - v[b * 3 + 1], v[a * 3 + 2] - v[b * 3 + 2]);
      if (l > this.vlen[a]) this.vlen[a] = l; if (l > this.vlen[b]) this.vlen[b] = l;
    }
    // 每个顶点的世界坐标、水面高度、浸深、压强（每子步更新）
    this.wx = new Float64Array(this.nv); this.wy = new Float64Array(this.nv); this.wz = new Float64Array(this.nv);
    this.eta = new Float64Array(this.nv); this.dep = new Float64Array(this.nv); this.pre = new Float64Array(this.nv);
    this.wasDry = new Uint8Array(this.nt);
    this._first = true;
    this.etaMax = Infinity;
    this.out = {
      F: [0, 0, 0], M: [0, 0, 0],                 // 水压（静水力 + FK），船体坐标，力矩对重心
      Ff: [0, 0, 0], Mf: [0, 0, 0],               // 面元摩擦
      Fd: [0, 0, 0], Md: [0, 0, 0],               // 辐射阻尼 + 砰击
      FyHull: 0,                                  // 船体部分（不含龙骨、舵）的竖直水压力（世界 y）
      wetArea: 0, wetAreaAppendages: 0,
      wpArea: 0, wpX: 0, wpZ: 0,                  // 水线面面积与形心（世界 x, z）
      slamBins: Array.from({ length: BINS }, () => ({ w: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, nx: 0, ny: 0, nz: 0, vmax: 0, area: 0 })),
    };
    this._poly = { x: new Float64Array(4), y: new Float64Array(4), z: new Float64Array(4), p: new Float64Array(4), X: new Float64Array(4), Z: new Float64Array(4), cut: new Uint8Array(4) };
    this._ids = new Int32Array(3); this._ds = new Float64Array(3); this._fwBuf = new Float64Array(9);
  }

  resetSlam() { for (const b of this.out.slamBins) { b.w = b.x = b.y = b.z = b.vx = b.vy = b.vz = b.nx = b.ny = b.nz = b.vmax = b.area = 0; } }

  /**
   * 一个子步的积分。
   *  R: 9 元行主序旋转矩阵（船体 → 世界），P: 船体原点的世界坐标 [x, y, z]，cg: 重心（船体坐标）
   *  water: { flat, height(x, z), k（Smith 波数）, field（世界坐标线性水速场，见 SailingYacht._sampleWaterVelocity）}
   *  mo: { V: 重心对地速度（船体坐标）, W: 角速度（船体坐标）}
   *  hp: { cf（C_F·(1+k)）, crad, krad, cslam, slamMin, L（分区用）}
   */
  integrate(R, P, cg, water, mo, hp) {
    const o = this.out, nv = this.nv, rho = this.rho, g = this.g;
    const r00 = R[0], r01 = R[1], r02 = R[2], r10 = R[3], r11 = R[4], r12 = R[5], r20 = R[6], r21 = R[7], r22 = R[8];
    const flat = water.flat, k = water.k || 0, rg = rho * g;
    const bx = this.bx, by = this.by, bz = this.bz, wx = this.wx, wy = this.wy, wz = this.wz;
    const eta = this.eta, dep = this.dep, pre = this.pre;
    // —— 顶点：世界坐标、水面高度、浸深、压强 ——
    // 只有“自己和所有相邻顶点都必然在水上”的顶点才不采样（上一子步采到的最高水面 + 0.25 m 余量 + 相邻最长边）；
    // 否则跨水线三角形会用假的浸深插值水线位置，湿面积随波相位系统性偏差，平均下来变成一个虚假的推力
    const cut = this.etaMax + 0.25, vlen = this.vlen;
    let etaMax = -Infinity;
    for (let i = 0; i < nv; i++) {
      const x = bx[i], y = by[i], z = bz[i];
      const X = P[0] + r00 * x + r01 * y + r02 * z, Y = P[1] + r10 * x + r11 * y + r12 * z, Z = P[2] + r20 * x + r21 * y + r22 * z;
      wx[i] = X; wy[i] = Y; wz[i] = Z;
      let h = 0;
      if (!flat) {
        if (Y - vlen[i] > cut) { eta[i] = h = -1e9; dep[i] = -1; pre[i] = 0; continue; }
        h = water.height(X, Z);
        if (h > etaMax) etaMax = h;
      }
      eta[i] = h;
      const d = h - Y;
      dep[i] = d;
      pre[i] = d > 0 ? (k > 0 ? rg * (h * Math.exp(k * (Y - h)) - Y) : rg * d) : 0;
    }
    this.etaMax = flat ? 0 : (etaMax === -Infinity ? this.etaMax : etaMax);
    // —— 累加器清零 ——
    this._F0 = 0; this._F1 = 0; this._F2 = 0; this._M0 = 0; this._M1 = 0; this._M2 = 0;
    this._f0 = 0; this._f1 = 0; this._f2 = 0; this._m0 = 0; this._m1 = 0; this._m2 = 0;
    this._d0 = 0; this._d1 = 0; this._d2 = 0; this._n0 = 0; this._n1 = 0; this._n2 = 0;
    this._h0 = 0; this._h1 = 0; this._h2 = 0;
    this._wet = 0; this._wetApp = 0; this._wa = 0; this._wcx = 0; this._wcz = 0;
    this._R = R; this._P = P; this._cg = cg; this._water = water; this._mo = mo; this._hp = hp;
    // 水速场换到船体坐标的系数：W_b(c) = R^T (W0 + Gx (X − X0) + Gz (Z − Z0))·衰减
    const fd = water.field;
    if (fd) {
      const ox = P[0] - fd.X0, oz = P[2] - fd.Z0;
      const w0x = fd.W0[0] + fd.Gx[0] * ox + fd.Gz[0] * oz, w0y = fd.W0[1] + fd.Gx[1] * ox + fd.Gz[1] * oz, w0z = fd.W0[2] + fd.Gx[2] * ox + fd.Gz[2] * oz;
      // 世界 X = P.x + r0·c，Z = P.z + r2·c → W(c) = w0 + Gx (r0·c) + Gz (r2·c)
      const b9 = this._fwBuf;
      b9[0] = w0x; b9[1] = w0y; b9[2] = w0z; b9[3] = fd.Gx[0]; b9[4] = fd.Gx[1]; b9[5] = fd.Gx[2]; b9[6] = fd.Gz[0]; b9[7] = fd.Gz[1]; b9[8] = fd.Gz[2];
      this._fw = b9;
    } else this._fw = null;

    const t = this.tri, tags = this.tags, nt = this.nt, wasDry = this.wasDry, first = this._first;
    const Q = this._poly;
    for (let ti = 0; ti < nt; ti++) {
      const a = t[ti * 3], b = t[ti * 3 + 1], c = t[ti * 3 + 2];
      const da = dep[a], db = dep[b], dc = dep[c];
      const tag = tags[ti];
      if (da <= 0 && db <= 0 && dc <= 0) { wasDry[ti] = 1; continue; }
      const entering = !first && wasDry[ti] === 1;
      wasDry[ti] = 0;
      if (da > 0 && db > 0 && dc > 0) {
        this._tri(bx[a], by[a], bz[a], bx[b], by[b], bz[b], bx[c], by[c], bz[c], pre[a], pre[b], pre[c], tag, false, entering);
        continue;
      }
      // —— 跨水线：Sutherland–Hodgman 对 d ≥ 0 半空间裁剪，保持绕序 ——
      let n = 0, wl0 = -1;
      const ids = this._ids, ds = this._ds;
      ids[0] = a; ids[1] = b; ids[2] = c; ds[0] = da; ds[1] = db; ds[2] = dc;
      for (let e = 0; e < 3; e++) {
        const e1 = e === 2 ? 0 : e + 1;
        const i = ids[e], j = ids[e1], di = ds[e], dj = ds[e1];
        if (di > 0) { Q.x[n] = bx[i]; Q.y[n] = by[i]; Q.z[n] = bz[i]; Q.p[n] = pre[i]; Q.X[n] = wx[i]; Q.Z[n] = wz[i]; Q.cut[n] = 0; n++; }
        if ((di > 0) !== (dj > 0)) {
          const s = di / (di - dj);
          Q.x[n] = bx[i] + s * (bx[j] - bx[i]); Q.y[n] = by[i] + s * (by[j] - by[i]); Q.z[n] = bz[i] + s * (bz[j] - bz[i]);
          Q.X[n] = wx[i] + s * (wx[j] - wx[i]); Q.Z[n] = wz[i] + s * (wz[j] - wz[i]);
          Q.p[n] = 0; Q.cut[n] = 1; n++;
        }
      }
      // 水线段：多边形里相邻的两个切点（按绕序），用于水线面面积（Green 公式）
      for (let e = 0; e < n; e++) {
        const f = (e + 1) % n;
        if (Q.cut[e] && Q.cut[f]) { wl0 = e; break; }
      }
      if (wl0 >= 0 && tag <= TAG.DECK) {
        const f = (wl0 + 1) % n, X1 = Q.X[wl0], Z1 = Q.Z[wl0], X2 = Q.X[f], Z2 = Q.Z[f];
        const cr = X1 * Z2 - X2 * Z1;
        this._wa += cr; this._wcx += (X1 + X2) * cr; this._wcz += (Z1 + Z2) * cr;
      }
      for (let e = 1; e < n - 1; e++) {
        this._tri(Q.x[0], Q.y[0], Q.z[0], Q.x[e], Q.y[e], Q.z[e], Q.x[e + 1], Q.y[e + 1], Q.z[e + 1], Q.p[0], Q.p[e], Q.p[e + 1], tag, true, entering);
      }
    }
    this._first = false;
    o.F[0] = this._F0; o.F[1] = this._F1; o.F[2] = this._F2; o.M[0] = this._M0; o.M[1] = this._M1; o.M[2] = this._M2;
    o.Ff[0] = this._f0; o.Ff[1] = this._f1; o.Ff[2] = this._f2; o.Mf[0] = this._m0; o.Mf[1] = this._m1; o.Mf[2] = this._m2;
    o.Fd[0] = this._d0; o.Fd[1] = this._d1; o.Fd[2] = this._d2; o.Md[0] = this._n0; o.Md[1] = this._n1; o.Md[2] = this._n2;
    o.FyHull = r10 * this._h0 + r11 * this._h1 + r12 * this._h2;
    o.wetArea = this._wet; o.wetAreaAppendages = this._wetApp;
    // 水线段按外法线绕序拼成的环，在 (x, z) 平面里为正向（Green 公式直接给出面积与形心）
    const A = this._wa / 2;
    o.wpArea = A;
    if (Math.abs(A) > 1e-6) { o.wpX = this._wcx / (6 * A); o.wpZ = this._wcz / (6 * A); }
    else { o.wpX = P[0]; o.wpZ = P[2]; }
    return o;
  }

  // 一个（子）三角形：顶点船体坐标 + 线性压强
  _tri(ax, ay, az, bx, by, bz, cx, cy, cz, pa, pb, pc, tag, partial, entering) {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const Sx = 0.5 * (uy * vz - uz * vy), Sy = 0.5 * (uz * vx - ux * vz), Sz = 0.5 * (ux * vy - uy * vx);
    const A = Math.sqrt(Sx * Sx + Sy * Sy + Sz * Sz);
    if (A < 1e-12) return;
    const cg = this._cg;
    const rax = ax - cg[0], ray = ay - cg[1], raz = az - cg[2];
    const rbx = bx - cg[0], rby = by - cg[1], rbz = bz - cg[2];
    const rcx = cx - cg[0], rcy = cy - cg[1], rcz = cz - cg[2];
    // —— 水压：精确积分 ——
    const sp = pa + pb + pc;
    const fx = -sp / 3 * Sx, fy = -sp / 3 * Sy, fz = -sp / 3 * Sz;
    this._F0 += fx; this._F1 += fy; this._F2 += fz;
    const qx = (sp * (rax + rbx + rcx) + pa * rax + pb * rbx + pc * rcx) / 12;
    const qy = (sp * (ray + rby + rcy) + pa * ray + pb * rby + pc * rcy) / 12;
    const qz = (sp * (raz + rbz + rcz) + pa * raz + pb * rbz + pc * rcz) / 12;
    this._M0 -= qy * Sz - qz * Sy; this._M1 -= qz * Sx - qx * Sz; this._M2 -= qx * Sy - qy * Sx;
    if (tag <= TAG.DECK) { this._h0 += fx; this._h1 += fy; this._h2 += fz; }
    if (tag >= TAG.KEEL) { this._wetApp += A; return; }       // 龙骨、舵的水动力由翼型模型负责
    if (tag <= TAG.TRANSOM) this._wet += A;
    // —— 形心处相对水流的速度（船体坐标）——
    const px = (rax + rbx + rcx) / 3, py = (ray + rby + rcy) / 3, pz = (raz + rbz + rcz) / 3;   // 形心相对重心
    const R = this._R, mo = this._mo, V = mo.V, W = mo.W;
    let vrx = V[0] + W[1] * pz - W[2] * py, vry = V[1] + W[2] * px - W[0] * pz, vrz = V[2] + W[0] * py - W[1] * px;
    const Cbx = px + cg[0], Cby = py + cg[1], Cbz = pz + cg[2];
    const Yw = this._P[1] + R[3] * Cbx + R[4] * Cby + R[5] * Cbz;
    const fw = this._fw;
    if (fw) {
      const sx = R[0] * Cbx + R[1] * Cby + R[2] * Cbz, sz = R[6] * Cbx + R[7] * Cby + R[8] * Cbz;
      const dec = this._water.k > 0 ? Math.exp(this._water.k * Math.min(Yw, 0)) : 1;
      const Wx = (fw[0] + fw[3] * sx + fw[6] * sz) * dec, Wy = (fw[1] + fw[4] * sx + fw[7] * sz) * dec, Wz = (fw[2] + fw[5] * sx + fw[8] * sz) * dec;
      vrx -= R[0] * Wx + R[3] * Wy + R[6] * Wz; vry -= R[1] * Wx + R[4] * Wy + R[7] * Wz; vrz -= R[2] * Wx + R[5] * Wy + R[8] * Wz;
    }
    const nx = Sx / A, ny = Sy / A, nz = Sz / A;
    const hp = this._hp;
    let Fx = 0, Fy = 0, Fz = 0;
    // —— 面元摩擦（只在船体壳上）——
    if (tag === TAG.HULL && hp.cf > 0) {
      const vn = vrx * nx + vry * ny + vrz * nz;
      const tx = vrx - vn * nx, ty = vry - vn * ny, tz = vrz - vn * nz;
      const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const k = -0.5 * this.rho * hp.cf * vt * A;
      const gx = k * tx, gy = k * ty, gz = k * tz;
      this._f0 += gx; this._f1 += gy; this._f2 += gz;
      this._m0 += py * gz - pz * gy; this._m1 += pz * gx - px * gz; this._m2 += px * gy - py * gx;
    }
    // —— 辐射阻尼 + 砰击：只用竖直相对速度，也只产生竖直力（世界坐标）——
    // 它们是为升沉 / 纵摇 / 横摇建的模型；若沿面元法线施力，迎浪斜浪中左右、首尾不对称的竖直相对运动
    // 会在船首船尾产生虚假的横向力和偏航力矩（舵被打满）。竖直力的分布照样给出纵摇、横摇阻尼。
    const gx = R[3], gy = R[4], gz = R[5];                    // 世界 y 轴在船体坐标中的表示
    const vyW = gx * vrx + gy * vry + gz * vrz;               // 相对水的世界竖直速度
    const nyW = gx * nx + gy * ny + gz * nz;                  // 法线的世界竖直分量
    const vnY = vyW * nyW;                                    // > 0：面元正竖直地压入水中
    const SyW = nyW * A;                                      // 面积向量的竖直分量
    if (hp.crad > 0) {
      const w = hp.krad > 0 ? Math.exp(hp.krad * Math.min(Cby, 0)) : 1;
      const f = -this.rho * hp.crad * w * vnY * SyW;
      Fx += f * gx; Fy += f * gy; Fz += f * gz;
    }
    if (partial && vnY > 0) {
      const f = -0.5 * this.rho * hp.cslam * vnY * vnY * SyW;
      Fx += f * gx; Fy += f * gy; Fz += f * gz;
      if (entering && vnY > hp.slamMin) this._slam(Cbx, Cby, Cbz, nx, ny, nz, vnY, A, vrx, vry, vrz);
    }
    this._d0 += Fx; this._d1 += Fy; this._d2 += Fz;
    this._n0 += py * Fz - pz * Fy; this._n1 += pz * Fx - px * Fz; this._n2 += px * Fy - py * Fx;
  }

  // 砰击事件：按区域累加（入水能量 ∝ v_n² A 加权的位置、射流速度）
  _slam(x, y, z, nx, ny, nz, vn, A, vrx, vry, vrz) {
    const hp = this._hp, L = hp.L || 8;
    const zone = z > L / 6 ? 0 : z < -L / 6 ? 2 : 1, side = x >= 0 ? 0 : 1;
    const b = this.out.slamBins[zone * 2 + side];
    const w = vn * vn * A;
    // 射流方向：世界“上”在面元平面内的投影（沿船壳向外、向上），船体坐标
    const R = this._R, ux = R[3], uy = R[4], uz = R[5];       // 世界 y 轴在船体坐标里的表示 = R 的第二行
    const d = ux * nx + uy * ny + uz * nz;
    let tx = ux - d * nx, ty = uy - d * ny, tz = uz - d * nz;
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const js = 2 * vn;                                         // Wagner：射流速度 ≈ 2 × 入水速度（相对船体）
    b.w += w; b.area += A; b.x += w * x; b.y += w * y; b.z += w * z;
    b.vx += w * tx * js; b.vy += w * ty * js; b.vz += w * tz * js;
    b.nx += w * nx; b.ny += w * ny; b.nz += w * nz;
    if (vn > b.vmax) b.vmax = vn;
  }
}

// ------------------------------------------------------------------------------------------------
// 静水力：给定姿态在平静水面上的合力，平衡吃水 / 纵倾求解，稳性曲线 GZ(φ)
// ------------------------------------------------------------------------------------------------
const FLAT = { flat: true, k: 0, height: () => 0, field: null };
const ZERO_MOTION = { V: [0, 0, 0], W: [0, 0, 0] };
const NO_DYN = { cf: 0, crad: 0, krad: 0, cslam: 0, slamMin: 1e9, L: 8 };

/** 欧拉角（three.js 'YXZ' 顺序：R = Ry(yaw)·Rx(pitch)·Rz(roll)）→ 行主序矩阵 */
export function matFromYXZ(yaw, pitch, roll, out = new Float64Array(9)) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(roll), sz = Math.sin(roll);
  out[0] = cy * cz + sy * sx * sz; out[1] = sy * sx * cz - cy * sz; out[2] = sy * cx;
  out[3] = cx * sz; out[4] = cx * cz; out[5] = -sx;
  out[6] = cy * sx * sz - sy * cz; out[7] = sy * sz + cy * sx * cz; out[8] = cy * cx;
  return out;
}

/** 平静水面上、给定姿态与原点高度时的水压合力（世界坐标）与对重心的力矩（世界坐标） */
export function staticLoads(integ, cg, { y = 0, heel = 0, trim = 0 } = {}) {
  const R = matFromYXZ(0, trim, heel);
  const c = [R[0] * cg[0] + R[1] * cg[1] + R[2] * cg[2], R[3] * cg[0] + R[4] * cg[1] + R[5] * cg[2], R[6] * cg[0] + R[7] * cg[1] + R[8] * cg[2]];
  integ._first = true;
  const o = integ.integrate(R, [0, y, 0], cg, FLAT, ZERO_MOTION, NO_DYN);
  const F = o.F, M = o.M;
  return {
    F: [R[0] * F[0] + R[1] * F[1] + R[2] * F[2], R[3] * F[0] + R[4] * F[1] + R[5] * F[2], R[6] * F[0] + R[7] * F[1] + R[8] * F[2]],
    M: [R[0] * M[0] + R[1] * M[1] + R[2] * M[2], R[3] * M[0] + R[4] * M[1] + R[5] * M[2], R[6] * M[0] + R[7] * M[1] + R[8] * M[2]],
    cgWorld: [c[0], y + c[1], c[2]], wpArea: o.wpArea, wpZ: o.wpZ, wetArea: o.wetArea, wetAreaApp: o.wetAreaAppendages,
  };
}

/**
 * 固定横倾 φ，求自由浮态（升沉 y、纵倾 θ）：竖直力 = m g，对重心的纵倾力矩 = 0（牛顿迭代，有限差分雅可比）。
 * 返回 { y, trim, GZ（复原力臂，m，正值 = 扶正）, RM（N·m）}
 */
export function equilibrium(integ, mass, cg, { heel = 0, y = 0, trim = 0, g = 9.81, iterations = 12 } = {}) {
  const W = mass * g;
  const res = (yy, tt) => { const L = staticLoads(integ, cg, { y: yy, heel, trim: tt }); return [L.F[1] - W, L.M[0], L]; };
  let r = res(y, trim);
  for (let it = 0; it < iterations; it++) {
    const ey = 1e-3, et = 1e-3;
    const ry = res(y + ey, trim), rt = res(y, trim + et);
    const j00 = (ry[0] - r[0]) / ey, j01 = (rt[0] - r[0]) / et, j10 = (ry[1] - r[1]) / ey, j11 = (rt[1] - r[1]) / et;
    const det = j00 * j11 - j01 * j10;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) break;
    let dy = -(j11 * r[0] - j01 * r[1]) / det, dt = -(-j10 * r[0] + j00 * r[1]) / det;
    // 步长限制，防止大横倾时跳出水面
    const s = Math.min(1, 0.25 / Math.max(Math.abs(dy), 1e-9), 0.15 / Math.max(Math.abs(dt), 1e-9));
    y += dy * s; trim += dt * s;
    r = res(y, trim);
    if (Math.abs(r[0]) < 1e-4 * W && Math.abs(r[1]) < 1e-3 * W) break;
  }
  const L = r[2];
  const RM = -L.M[2];                    // 横倾绕 +Z（桅顶倒向 −X）时，扶正力矩绕 −Z
  return { y, trim, GZ: RM / W, RM, wpArea: L.wpArea, wetArea: L.wetArea, residual: [r[0] / W, r[1] / W] };
}

/** 稳性曲线：heels（度）→ [{ heel, GZ, RM, trim, y }] */
export function stabilityCurve(integ, mass, cg, heels = Array.from({ length: 37 }, (_, i) => i * 5)) {
  const out = [];
  let y = 0, trim = 0;
  for (const h of heels) {
    const e = equilibrium(integ, mass, cg, { heel: h * Math.PI / 180, y, trim });
    out.push({ heel: h, GZ: e.GZ, RM: e.RM, trim: e.trim * 180 / Math.PI, y: e.y });
    y = e.y; trim = e.trim;                // 用上一个角度的解作初值
  }
  return out;
}
