// 单调三次 Hermite 插值（Fritsch & Carlson 1980，即 PCHIP）：C¹ 连续、不过冲。
// 用于 ORC 帆系数表、DSYHS 剩余阻力曲线等经验表格 —— 线性插值在表格节点处有折角，
// 会让 VPP 式的最优化（最佳迎风角、调帆）出现假的“台阶”；普通三次样条又会在陡变处过冲出负升力。
export function pchip(xs, ys) {
  const n = xs.length, h = new Float64Array(n - 1), d = new Float64Array(n - 1), m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  // 端点：三点公式，保持单调
  if (n > 2) {
    const end = (h0, h1, d0, d1) => { let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1); if (s * d0 <= 0) s = 0; else if (d0 * d1 <= 0 && Math.abs(s) > Math.abs(3 * d0)) s = 3 * d0; return s; };
    m[0] = end(h[0], h[1], d[0], d[1]);
    m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  }
  const f = (x) => {
    if (x <= xs[0]) return ys[0];                                     // 表外取端值
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] > x) hi = mid; else lo = mid; }
    const t = (x - xs[lo]) / h[lo], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h[lo] * m[lo] + (-2 * t3 + 3 * t2) * ys[lo + 1] + (t3 - t2) * h[lo] * m[lo + 1];
  };
  f.xs = xs; f.ys = ys;
  return f;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
