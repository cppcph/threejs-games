// 帆船在不规则海面上的横摇 / 纵摇统计：与实拍（Elan 431 船首相机地平线跟踪）对照
//   海面：JONSWAP（γ = 3.3）+ cos^2s 方向分布，60 个分量随机相位（与 FFT 海面同一类统计）
//   用法：node tests/compare/yacht-roll.mjs U Hs Tp TWA [seconds]（DUMP=文件 另存时间序列）
import { SailingYacht } from '../../ocean/vessel/SailingYacht.js';
const [U = 7, Hs = 0.5, Tp = 2.6, TWA = 50, SECS = 120] = process.argv.slice(2).map(Number);
const G = 9.81, DEG = Math.PI / 180;
let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function jonswap(w, wp, gamma = 3.3) {
  const s = w <= wp ? 0.07 : 0.09, r = Math.exp(-((w - wp) ** 2) / (2 * s * s * wp * wp));
  return G * G * Math.pow(w, -5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
}
// 分量：频率 0.6–3.5 ωp，方向 ±75°，能量按谱密度 × 方向分布，最后整体缩放到给定 Hs
const wp = 2 * Math.PI / Tp, comps = [];
const windDir = Math.PI / 2;   // 风去向 +z
for (let i = 0; i < 60; i++) {
  const w = wp * (0.6 + 2.9 * (i + rnd()) / 60), th = windDir + (rnd() - 0.5) * 150 * DEG;
  const d = Math.pow(Math.cos((th - windDir) / 2), 10);
  comps.push({ w, k: w * w / G, dx: Math.cos(th), dz: Math.sin(th), e: jonswap(w, wp) * d, ph: rnd() * 2 * Math.PI });
}
const etot = comps.reduce((s, c) => s + c.e, 0);
for (const c of comps) c.a = Math.sqrt(2 * c.e / etot) * Hs / 4;   // Σ a²/2 = (Hs/4)²
const sea = {
  time: 0,
  sampleHeight(x, z) { let h = 0; for (const c of comps) h += c.a * Math.cos(c.k * (x * c.dx + z * c.dz) - c.w * this.time + c.ph); return h; },
  sampleVelocity(x, z, o = { x: 0, y: 0, z: 0 }) { o.x = o.y = o.z = 0; for (const c of comps) { const t = c.k * (x * c.dx + z * c.dz) - c.w * this.time + c.ph, aw = c.a * c.w; o.x += aw * Math.cos(t) * c.dx; o.z += aw * Math.cos(t) * c.dz; o.y += aw * Math.sin(t); } return o; },
};
const wind = { x: 0, z: U }, from = Math.atan2(-wind.x, -wind.z);
const y = new SailingYacht();
y.setControls({ mode: 'twa', target: TWA * DEG, tack: 'starboard' });
y.reset({ yaw: from + TWA * DEG, speed: 2.5 });
const roll = [], pitch = [], spd = [];
const dt = 1 / 30;
for (let i = 0; i < SECS / dt; i++) {
  sea.time += dt; y.step(dt, { ocean: sea, wind, waveNumber: wp * wp / G });
  if (y.time > 30) { const t = y.telemetry; roll.push(t.heel); pitch.push(t.pitch); spd.push(t.speedKn); }
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
function peakPeriod(a) {   // 直接 DFT 求主周期
  const m = mean(a), n = a.length; let best = 0, bp = 0;
  for (let T = 0.6; T <= 12; T += 0.02) { const w = 2 * Math.PI / T; let re = 0, im = 0; for (let i = 0; i < n; i++) { re += (a[i] - m) * Math.cos(w * i * dt); im += (a[i] - m) * Math.sin(w * i * dt); } const p = re * re + im * im; if (p > best) { best = p; bp = T; } }
  return bp;
}
const vk = mean(spd), Tenc = 2 * Math.PI / (wp + (wp * wp / G) * vk * 0.5144 * Math.cos(TWA * DEG)); // 遭遇周期：浪从风的来向来，与船首夹角 = TWA
if (process.env.DUMP) { const fs = await import('node:fs'); fs.writeFileSync(process.env.DUMP, JSON.stringify({ dt, roll, pitch })); }
console.log(JSON.stringify({ U, Hs, Tp, TWA, speedKn: +vk.toFixed(2), heelMean: +mean(roll).toFixed(1), rollStd: +std(roll).toFixed(2), rollPeriod: +peakPeriod(roll).toFixed(2),
  pitchStd: +std(pitch).toFixed(2), pitchPeriod: +peakPeriod(pitch).toFixed(2), encounterPeriodPeak: +Tenc.toFixed(2) }));
