// 风浪物理模型：风 → 浪 的生长、积累、转涌与衰减
//
// 只依赖 Math，可在浏览器和 Node 中运行。海面渲染（OceanSimulation）每帧读取
// spectrumParams() 得到波谱参数，所以画面上的浪高、周期、方向都由这里的规律决定。
//
// 采用的经验规律（单位：米、秒、弧度；U = 10 m 高处风速）：
//   无量纲风区   X̃ = g·X / U²
//   能量         g²·E / U⁴ = 1.6e-7 · X̃                 （JONSWAP, Hasselmann 1973）
//   谱峰频率     ω_p·U / g = 22 · X̃^-0.33               （JONSWAP）
//   风时↔风区    g·t / U   = 68.8 · X̃^(2/3)              （SPM 1984 风时限制）
//   充分发展     ω_p·U / g = 0.855（Pierson–Moskowitz），对应 X̃_FD ≈ 1.88e4，Hs = 0.219·U²/g
//   有效波高     Hs = 4·√E（E 为海面高度方差 m0）
// 生长：浪的“年龄”用等效风时表示。每一步先由当前能量反求在当前风速下的等效风时，
// 再加上经过的时间，取 风时 / 风区 / 充分发展 三者中最先达到的限制 —— 这就是
// 变风情形下常用的“等效风时法”，风速变化时 Hs 连续，不会跳变。
// 风变弱：当前能量超出新风速能维持的上限时，多出的部分转成涌浪（保留原周期和方向）。
// 风向突变（> 45°）：原风浪整体转为涌浪，新风向上的风浪从零开始生长；小于 45° 时
// 风浪方向以与谱峰周期成正比的时间常数向风向偏转。
// 涌浪：窄谱（γ = 7）、窄方向分布，能量按 e 指数缓慢衰减，周期越长衰减越慢。
// 浅水：TMA 谱修正在 GPU 波谱中完成；这里再按破碎极限 Hs ≤ 0.6·h 封顶。
// 白浪覆盖率：Monahan & O'Muircheartaigh (1980)  W = 3.84e-6 · U^3.41。

export const G = 9.81;
const TAU = Math.PI * 2;

export const GROWTH = {
  energyCoef: 1.6e-7,  // g²E/U⁴ = c·X̃
  peakCoef: 22.0,      // ω_p U/g = c·X̃^peakExp
  peakExp: -0.33,
  durationCoef: 68.8,  // g t/U = c·X̃^(2/3)
  fdPeak: 0.855,       // 充分发展时 ω_p U/g
};
/** 充分发展对应的无量纲风区 ≈ 1.88e4 */
export const X_FD = Math.pow(GROWTH.fdPeak / GROWTH.peakCoef, 1 / GROWTH.peakExp);

export const energyFromFetch = (U, Xt) => GROWTH.energyCoef * Xt * U ** 4 / (G * G);
export const fetchFromEnergy = (U, E) => E * G * G / (GROWTH.energyCoef * U ** 4);
export const durationFromFetch = (U, Xt) => GROWTH.durationCoef * Math.pow(Xt, 2 / 3) * U / G;
export const fetchFromDuration = (U, t) => Math.pow(Math.max(0, G * t / (U * GROWTH.durationCoef)), 1.5);
export const peakOmegaFromFetch = (U, Xt) =>
  Math.max(GROWTH.fdPeak, GROWTH.peakCoef * Math.pow(Math.max(Xt, 1e-6), GROWTH.peakExp)) * G / U;
export const hsFromEnergy = (E) => 4 * Math.sqrt(Math.max(0, E));
export const energyFromHs = (Hs) => (Hs / 4) ** 2;

/** 有限水深色散 ω² = g·k·tanh(k·h)，由 ω 反求 k（牛顿迭代） */
export function wavenumber(omega, depth = Infinity) {
  let k = omega * omega / G;                       // 深水初值
  if (!isFinite(depth) || depth * k > 10) return k;
  for (let i = 0; i < 30; i++) {
    const th = Math.tanh(k * depth);
    const f = G * k * th - omega * omega;
    const df = G * th + G * k * depth * (1 - th * th);
    const dk = f / df;
    k -= dk;
    if (Math.abs(dk) < 1e-10 * k) break;
  }
  return k;
}
/** 相速度与群速度 */
export function waveSpeeds(omega, depth = Infinity) {
  const k = wavenumber(omega, depth);
  const kh = isFinite(depth) ? k * depth : 50;
  const n = kh > 20 ? 0.5 : 0.5 * (1 + 2 * kh / Math.sinh(2 * kh));
  return { k, wavelength: TAU / k, phase: omega / k, group: n * omega / k };
}

/** 谱峰增强因子 γ 随波龄 c_p/U 变化：年轻风浪 3.3，充分发展（波龄 1.17）趋于 1（PM 谱） */
export function gammaFromAge(age) {
  const t = Math.min(1, Math.max(0, (1.17 - age) / (1.17 - 0.83)));
  return 1 + 2.3 * t;
}

/**
 * 风浪谱形：Donelan, Hamilton & Hui (1985)，谱峰以上为 ω⁻⁴ 平衡区（Toba），3·ω_p 以上转为 ω⁻⁵ 饱和区。
 * Ω = U/c_p（逆波龄）：γ = 1.7（Ω < 1）或 1.7 + 6·log10 Ω；σ = 0.08·(1 + 4/Ω³)。
 * 年轻风浪谱峰尖、成熟风浪谱峰宽；比 JONSWAP（全段 ω⁻⁵）有更多中短波，均方坡度更接近 Cox–Munk 观测。
 * 返回未归一化的形状，用 windSeaNorm 归一化；GPU 着色器使用同一公式。
 */
export function dhhParams(invAge) {
  const O = Math.min(5, Math.max(0.83, invAge));
  return { gamma: O < 1 ? 1.7 : 1.7 + 6 * Math.log10(O), sigma: 0.08 * (1 + 4 / (O * O * O)), tail: 3 };
}
export function windSeaShape(w, wp, p) {
  const x = wp / w, e = x ** 4;
  if (e > 60) return 0;
  const d = (w - wp) / (p.sigma * wp);
  let s = Math.pow(w, -4) / wp * Math.exp(-e) * Math.pow(p.gamma, Math.exp(-0.5 * d * d));
  if (w > p.tail * wp) s *= p.tail * wp / w;
  return s;
}
/** ∫ windSeaShape dω（对数间隔数值积分） */
export function windSeaNorm(wp, p, depth = Infinity) {
  let sum = 0, sumD = 0, best = 0, omegaPeak = wp;
  const shallow = isFinite(depth) && depth * wp * wp / G < 6;
  const n = 500, w0 = 0.3 * wp, w1 = 60 * wp, r = Math.pow(w1 / w0, 1 / n);
  for (let i = 0, w = w0 * Math.sqrt(r); i < n; i++, w *= r) {
    const s = windSeaShape(w, wp, p), dw = w * (r - 1) / Math.sqrt(r);
    sum += s * dw;
    if (shallow) {
      const sp = s * tmaPhi(w, depth);
      sumD += sp * dw;
      if (sp > best) { best = sp; omegaPeak = w; }
    }
  }
  return { norm: sum, depthFactor: shallow ? sumD / sum : 1, omegaPeak };
}

/** JONSWAP 频谱形状（涌浪用；与 GPU 着色器相同，∫ dω = 1） */
export function jonswapShape(w, wp, gamma) {
  const x = wp / w, e = 1.25 * x ** 4;
  if (e > 60) return 0;
  const sigma = w <= wp ? 0.07 : 0.09, d = (w - wp) / (sigma * wp);
  const I = 0.2 / Math.max(0.05, 1 - 0.287 * Math.log(gamma));
  return x ** 4 / w * Math.exp(-e) * Math.pow(gamma, Math.exp(-0.5 * d * d)) / I;
}
/** TMA 浅水修正（Kitaigorodskii 深度函数，与 GPU 相同） */
export function tmaPhi(w, depth) {
  const wh = w * Math.sqrt(depth / G);
  if (wh <= 1) return 0.5 * wh * wh;
  if (wh < 2) { const t = 2 - wh; return 1 - 0.5 * t * t; }
  return 1;
}
/**
 * 有限水深下的能量保留比例和有效谱峰频率：∫S·Φ dω / ∫S dω。深水时为 1。
 * GPU 波谱用同一个 S·Φ，所以读数与画面一致。
 */
export function depthResponse(wp, gamma, depth) {
  if (depth * (wp * wp / G) > 6) return { factor: 1, omegaPeak: wp };   // 深水：k_p·h > 6
  let num = 0, den = 0, best = 0, wBest = wp;
  const n = 400, w0 = 0.35 * wp, w1 = 8 * wp, r = Math.pow(w1 / w0, 1 / n);
  for (let i = 0, w = w0; i < n; i++, w *= r) {
    const dw = w * (r - 1), s = jonswapShape(w, wp, gamma), sp = s * tmaPhi(w, depth);
    num += sp * dw; den += s * dw;
    if (sp > best) { best = sp; wBest = w; }
  }
  return { factor: den > 0 ? num / den : 1, omegaPeak: wBest };
}

/**
 * Young & Verhagen (1996) 有限水深生长律：ε̃ = g²E/U⁴，ν̃ = f_p·U/g，χ = gX/U²，δ = g·d/U²
 *   ε̃ = 3.64e-3 · [tanh(A1)·tanh(B1/tanh(A1))]^1.74，A1 = 0.493 δ^0.75，B1 = 3.13e-3 χ^0.57
 *   ν̃ = 0.133  · [tanh(A2)·tanh(B2/tanh(A2))]^−0.37，A2 = 0.331 δ^1.01，B2 = 5.215e-4 χ^0.73
 * 深水、短风区时 ε̃ ≈ 1.6e-7·χ，与 JONSWAP 一致。这里只取它的“浅水/深水”比值，
 * 乘到深水生长律上：深水时比值为 1，结果不变；浅水时能量和周期都被水深限制。
 */
export function depthLimitation(chi, delta) {
  if (!(delta < 200)) return { energy: 1, frequency: 1 };
  const A1 = 0.493 * delta ** 0.75, B1 = 3.13e-3 * chi ** 0.57;
  const A2 = 0.331 * delta ** 1.01, B2 = 5.215e-4 * chi ** 0.73;
  const t1 = Math.tanh(A1), t2 = Math.tanh(A2);
  const tb1 = Math.tanh(B1), tb2 = Math.tanh(B2);
  if (tb1 <= 0 || tb2 <= 0) return { energy: 1, frequency: 1 };
  return {
    energy: Math.pow(t1 * Math.tanh(B1 / t1) / tb1, 1.74),
    frequency: Math.pow(t2 * Math.tanh(B2 / t2) / tb2, -0.37),
  };
}

/** Monahan & O'Muircheartaigh (1980) 白浪覆盖率（0–1） */
export const whitecapCoverage = (U) => Math.min(1, 3.84e-6 * Math.pow(Math.max(0, U), 3.41));

/** 蒲福风级（中国气象标准名称），阈值单位 m/s */
const BEAUFORT = [
  [0.3, '无风'], [1.6, '软风'], [3.4, '轻风'], [5.5, '微风'], [8.0, '和风'], [10.8, '清劲风'], [13.9, '强风'],
  [17.2, '疾风'], [20.8, '大风'], [24.5, '烈风'], [28.5, '狂风'], [32.7, '暴风'], [Infinity, '飓风'],
];
export function beaufort(U) {
  for (let i = 0; i < BEAUFORT.length; i++) if (U < BEAUFORT[i][0]) return { force: i, name: BEAUFORT[i][1] };
  return { force: 12, name: '飓风' };
}
/** 浪级（与道格拉斯海况等级阈值一致），按有效波高 */
const DOUGLAS = [[0.0001, '无浪'], [0.1, '微浪'], [0.5, '小浪'], [1.25, '轻浪'], [2.5, '中浪'], [4, '大浪'], [6, '巨浪'], [9, '狂浪'], [14, '狂涛'], [Infinity, '怒涛']];
export function seaStateScale(Hs) {
  for (let i = 0; i < DOUGLAS.length; i++) if (Hs < DOUGLAS[i][0]) return { degree: i, name: DOUGLAS[i][1] };
  return { degree: 9, name: '怒涛' };
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * 风浪状态机。所有“海况时间”= 真实时间 × timeScale，用来在演示里把几小时的起浪过程压缩到几分钟。
 *
 *   const sea = new WindSeaModel({ wind: { x: 8, z: -3 }, fetch: 300e3, depth: 2000, timeScale: 120 });
 *   sea.update(dt);               // 每帧
 *   sea.spectrumParams();         // → GPU 波谱
 *   sea.readout;                  // Hs、Tp、波龄、风级、浪级、发展阶段……
 */
export class WindSeaModel {
  constructor({
    wind = { x: 8, z: 0 },
    fetch = 300e3,          // 地理风区（m）：上风方向开阔水面长度
    depth = 2000,           // 水深（m）
    timeScale = 60,         // 海况时间加速倍数
    windResponse = 600,     // 平均风的时间常数（海况时间，s）：U10 按气象惯例是 10 分钟平均风；阵风只影响细小波纹
    swellDecayHours = 5,    // 周期 8 s 的涌浪能量 e 折减时间（海况时间，h），按 (T/8)² 缩放
    maxSwells = 3,
  } = {}) {
    this.wind = { x: wind.x, z: wind.z };
    this.meanWind = { x: wind.x, z: wind.z };
    this.fetch = fetch;
    this.depth = depth;
    this.timeScale = timeScale;
    this.windResponse = windResponse;
    this.swellDecayHours = swellDecayHours;
    this.maxSwells = maxSwells;
    this.seaTime = 0;
    const U = Math.hypot(wind.x, wind.z);
    // Edeep：深水等效能量（等效风时法的状态量）；E、omegaP：经水深限制后的实际值
    this.windSea = { E: 0, Edeep: 0, theta: Math.atan2(wind.z, wind.x), omegaP: U > 0.5 ? peakOmegaFromFetch(U, 1) : 4, Xt: 0, limit: 'duration' };
    this.swells = [];            // { E, omegaP, theta, gamma, s, age }
    this.background = null;      // 远方传来的恒定涌浪 { E, omegaP, theta, gamma, s }
    this.readout = {};
    this.history = [];           // [{ t, Hs }]，用于画生长曲线
    this._histTimer = 0;
    this._computeReadout();
  }

  /** 设置瞬时风（x, z 分量，m/s，指向下风方向） */
  setWind(x, z) { this.wind.x = x; this.wind.z = z; }
  /** 立即把平均风也设成当前风（切换预设时用，避免等待滤波） */
  snapWind() { this.meanWind.x = this.wind.x; this.meanWind.z = this.wind.z; }
  setFetch(m) { this.fetch = Math.max(100, m); }
  setDepth(m) { this.depth = Math.max(0.5, m); }
  setTimeScale(s) { this.timeScale = Math.max(0, s); }

  /** 远方涌浪（不随本地风变化）：Hs (m)、Tp (s)、传播方向 theta (rad)，spread 为方向集中度 s */
  setBackgroundSwell(opts) {
    if (!opts || !(opts.Hs > 0)) { this.background = null; this._computeReadout(); return; }
    this.background = { E: energyFromHs(opts.Hs), omegaP: TAU / opts.Tp, theta: opts.theta, gamma: 5, s: opts.spread ?? 60 };
    this._computeReadout();
  }

  /** 清除所有浪（平静海面） */
  calm() {
    this.windSea.E = 0; this.windSea.Edeep = 0; this.windSea.Xt = 0; this.swells.length = 0; this.history.length = 0;
    this._computeReadout();
  }

  /**
   * 直接把风浪设为某个发展程度（0–1，按等效风时比例），切换镜头预设时不用等待。
   * 1 = 达到当前风速和风区允许的极限（风区受限或充分发展）。
   */
  develop(fraction = 1) {
    const U = Math.max(0.5, Math.hypot(this.meanWind.x, this.meanWind.z));
    const Xlim = Math.min(G * this.fetch / (U * U), X_FD);
    const tLim = durationFromFetch(U, Xlim);
    const Xt = Math.min(Xlim, fetchFromDuration(U, tLim * Math.min(1, Math.max(0, fraction))));
    this.windSea.theta = Math.atan2(this.meanWind.z, this.meanWind.x);
    this._setWindSeaFromFetch(U, Xt, Xlim);
    this._computeReadout();
  }

  _setWindSeaFromFetch(U, Xt, Xlim) {
    const ws = this.windSea;
    ws.Xt = Xt;
    ws.Edeep = energyFromFetch(U, Xt);
    const lim = depthLimitation(Math.max(Xt, 1), G * this.depth / (U * U));
    ws.omegaP = peakOmegaFromFetch(U, Math.max(Xt, 1)) * lim.frequency;
    ws.E = Math.min(ws.Edeep * lim.energy, this._depthEnergyCap());
    ws.limit = Xt >= Xlim * 0.999 ? (Xlim >= X_FD * 0.999 ? 'developed' : 'fetch') : 'duration';
  }

  /** 破碎极限：Hs ≤ 0.6·h */
  _depthEnergyCap() { return energyFromHs(0.6 * this.depth); }

  _clearWindSea(theta) {
    const ws = this.windSea;
    ws.E = 0; ws.Edeep = 0; ws.Xt = 0; ws.theta = theta;
  }

  /** 把一份能量转成涌浪：与方向、周期相近的已有涌浪合并 */
  _toSwell(E, omegaP, theta) {
    if (!(E > 1e-6)) return;
    for (const s of this.swells) {
      if (Math.abs(wrapAngle(s.theta - theta)) < 0.35 && Math.abs(s.omegaP / omegaP - 1) < 0.2) {
        const w = E / (s.E + E);
        s.theta = wrapAngle(s.theta + wrapAngle(theta - s.theta) * w);
        s.omegaP = s.omegaP + (omegaP - s.omegaP) * w;
        s.E += E;
        return;
      }
    }
    this.swells.push({ E, omegaP, theta, gamma: 7, s: 15, age: 0 });
    if (this.swells.length > this.maxSwells) {
      this.swells.sort((a, b) => b.E - a.E);
      const weakest = this.swells.pop();
      this.swells[this.swells.length - 1].E += weakest.E * 0.5; // 合并一半能量，避免突然消失
    }
  }

  /** dtReal：真实经过的秒数 */
  update(dtReal) {
    const dt = Math.max(0, dtReal) * this.timeScale;
    if (dt <= 0) { this._computeReadout(); return; }
    this.seaTime += dt;

    // 1. 平均风：大浪只响应持续的平均风，阵风由渲染层的细小波纹体现
    const a = 1 - Math.exp(-dt / this.windResponse);
    this.meanWind.x += (this.wind.x - this.meanWind.x) * a;
    this.meanWind.z += (this.wind.z - this.meanWind.z) * a;
    const U = Math.hypot(this.meanWind.x, this.meanWind.z);
    const thetaW = Math.atan2(this.meanWind.z, this.meanWind.x);
    const ws = this.windSea;

    if (U < 0.5) {
      // 无风：现有风浪全部转为涌浪
      if (ws.E > 0) this._toSwell(ws.E, ws.omegaP, ws.theta);
      this._clearWindSea(thetaW);
      ws.limit = 'calm';
    } else {
      // 2. 风向：突变 > 45° 时旧风浪转涌；否则风浪方向向风向偏转
      const d = wrapAngle(thetaW - ws.theta);
      if (ws.E > 0 && Math.abs(d) > Math.PI / 4) {
        this._toSwell(ws.E, ws.omegaP, ws.theta);
        this._clearWindSea(thetaW);
      } else {
        const Tp = TAU / ws.omegaP;
        const tauDir = 1800 * Math.max(0.25, Tp / 8);      // 周期 8 s 的浪约半小时转向
        ws.theta = wrapAngle(ws.theta + d * (1 - Math.exp(-dt / tauDir)));
        if (ws.E <= 0) ws.theta = thetaW;
      }
      const Ueff = U * Math.max(0.3, Math.cos(wrapAngle(thetaW - ws.theta)));

      // 3. 生长：等效风时法
      const Xlim = Math.min(G * this.fetch / (Ueff * Ueff), X_FD);
      let Xe = fetchFromEnergy(Ueff, ws.Edeep);
      if (Xe > Xlim) {
        // 风变弱或风区变短：超出维持上限的能量转为涌浪（按实际能量比例）
        const keep = energyFromFetch(Ueff, Xlim) / ws.Edeep;
        this._toSwell(ws.E * (1 - keep), ws.omegaP, ws.theta);
        Xe = Xlim;
      }
      const t = durationFromFetch(Ueff, Xe) + dt;
      this._setWindSeaFromFetch(Ueff, Math.min(fetchFromDuration(Ueff, t), Xlim), Xlim);
    }

    // 4. 涌浪衰减（周期越长越持久）并逐渐变窄
    for (const s of this.swells) {
      const T = TAU / s.omegaP;
      const tau = this.swellDecayHours * 3600 * (T / 8) ** 2;
      s.E *= Math.exp(-dt / tau);
      s.age += dt;
      s.s = Math.min(75, 15 + (s.age / 3600) * 12);
    }
    this.swells = this.swells.filter((s) => s.E > 1e-5);

    // 5. 水深封顶（破碎极限）
    const cap = this._depthEnergyCap();
    if (ws.E > cap) ws.E = cap;

    this._histTimer += dtReal;
    this._computeReadout();
    if (this._histTimer >= 0.5) {
      this._histTimer = 0;
      this.history.push({ t: this.seaTime, Hs: this.readout.Hs, HsWind: this.readout.HsWind });
      if (this.history.length > 240) this.history.shift();
    }
  }

  _computeReadout() {
    const ws = this.windSea;
    const U = Math.hypot(this.meanWind.x, this.meanWind.z);
    const Uinst = Math.hypot(this.wind.x, this.wind.z);
    // 浅水时按 TMA 修正后的能量统计（与 GPU 波谱一致）
    let Esw = 0, dom = null, domE = 0;
    for (const s of [...this.swells, ...(this.background ? [this.background] : [])]) {
      const e = s.E * depthResponse(s.omegaP, s.gamma, this.depth).factor;
      Esw += e;
      if (e > domE) { domE = e; dom = s; }
    }
    const sp0 = ws.E > 0 ? waveSpeeds(ws.omegaP, this.depth) : null;
    const age = sp0 && U > 0.5 ? sp0.phase / U : 0;
    // 风浪：GPU 按 TMA 保留比例归一化，渲染出的能量正好是 ws.E；TMA 只让谱峰略向高频移
    const resp = ws.E > 0 ? windSeaNorm(ws.omegaP, dhhParams(age > 0 ? 1 / age : 0.855), this.depth) : { omegaPeak: ws.omegaP };
    const Ews = ws.E;
    const sp = ws.E > 0 ? waveSpeeds(resp.omegaPeak, this.depth) : null;
    const Xlim = U > 0.5 ? Math.min(G * this.fetch / (U * U), X_FD) : 0;
    const tRemain = U > 0.5 && ws.limit === 'duration' ? Math.max(0, durationFromFetch(U, Xlim) - durationFromFetch(U, ws.Xt)) : 0;
    const Hs = hsFromEnergy(Ews + Esw);
    const stageNames = { calm: '无风，浪在衰减', duration: '发展中（受风时限制）', fetch: '受风区限制', developed: '充分发展' };
    this.readout = {
      U10: U, U10Instant: Uinst,
      windTheta: Math.atan2(this.meanWind.z, this.meanWind.x),
      beaufort: beaufort(U),
      Hs, HsWind: hsFromEnergy(Ews), HsSwell: hsFromEnergy(Esw),
      Tp: ws.E > 0 ? TAU / resp.omegaPeak : 0,
      depthFactor: resp.factor,
      TpSwell: dom ? TAU / dom.omegaP : 0,
      swellTheta: dom ? dom.theta : 0,
      waveTheta: ws.theta,
      wavelength: sp ? sp.wavelength : 0,
      phaseSpeed: sp ? sp.phase : 0,
      groupSpeed: sp ? sp.group : 0,
      waveAge: age,
      dimensionlessFetch: ws.Xt,
      stage: ws.limit, stageName: stageNames[ws.limit] || '',
      timeToLimit: tRemain,
      whitecap: whitecapCoverage(U),
      seaState: seaStateScale(Hs),
      windDrift: 0.03 * U,          // 风生表面漂流 ≈ 3% 风速
      seaTime: this.seaTime,
    };
  }

  /**
   * 供 GPU 波谱使用的参数（方向为传播方向）。
   * 风浪能量除以 TMA 保留比例，GPU 乘上 TMA 后正好得到 ws.E（浅水生长律给出的能量）；
   * 涌浪不归一化，浅水对长周期涌浪的削弱由 TMA 体现，读数里同样计入。
   */
  spectrumParams() {
    const ws = this.windSea;
    const U = Math.max(0.5, Math.hypot(this.meanWind.x, this.meanWind.z));
    const age = ws.E > 0 ? waveSpeeds(ws.omegaP, this.depth).phase / U : 1.17;
    const shape = dhhParams(1 / age);
    const nr = windSeaNorm(ws.omegaP, shape, this.depth);
    const swells = this.swells.map((s) => ({ E: s.E, omegaP: s.omegaP, theta: s.theta, gamma: s.gamma, s: s.s }));
    if (this.background) swells.unshift({ ...this.background });
    return {
      depth: this.depth,
      windSea: {
        E: ws.E / Math.max(nr.depthFactor, 1e-3), omegaP: ws.omegaP, theta: ws.theta,
        gamma: shape.gamma, sigma: shape.sigma, tail: shape.tail, norm: nr.norm, U10: U, age,
      },
      swells: swells.slice(0, 4),
      gust: { x: this.wind.x, z: this.wind.z },   // 瞬时风：驱动细小波纹（猫爪风）
    };
  }
}
