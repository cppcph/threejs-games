// =====================================================================================
// BowWave —— 船首浪的破碎泡沫与水片飞溅（配合 ocean/vessel 的 SailingYacht）
//
//   物理：船首驻点的水头 ζs = V²/2g（伯努利）给出船首浪的尺度；傅汝德数 Fn = V/√(gL) 越大，
//         船首浪越高、越陡。实船观测与水池试验里，帆船这类较瘦的船首在 Fn ≈ 0.25 以上开始在两舷
//         溢出型破碎（白色浪脊贴着船壳），接近船体速度（Fn ≈ 0.4）时破碎明显并甩出水片。
//         横倾时下风舷浸得更深，船首浪更高（迎风舷相反）。
//   画法：破碎处的泡沫注入白浪场（ocean.addFoam），和白浪一样按 τA → τB 衰减、随水漂流；
//         水片在驻点附近以射流速度（量级 ≈ V，朝外、朝上）发射成毫米级水滴，之后由 Spray 的
//         阻力 + 重力决定轨迹（落回很快）。
//
// 用法：
//   const bow = new BowWave(yacht, { ocean, spray });
//   每帧（yacht.step 之后、ocean.update 之前）：bow.update(dt);
// =====================================================================================
const G = 9.81;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class BowWave {
  constructor(yacht, { ocean = null, spray = null, rate = 1, onset = 0.22, full = 0.42 } = {}) {
    this.yacht = yacht; this.ocean = ocean; this.spray = spray;
    this.rate = rate; this.onset = onset; this.full = full;
    this._acc = 0;
    this.intensity = 0;              // 0–1，给声音等用
  }

  update(dt) {
    const y = this.yacht, w = y.wake, T = y.telemetry;
    if (!(dt > 0) || !w || !T) return;
    const V = w.speed, b = smoothstep(this.onset, this.full, w.Fn);
    this.intensity = b;
    if (b <= 0) return;
    const yaw = T.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), px = Math.cos(yaw), pz = -Math.sin(yaw);   // 船首、左舷（+X）
    const L = y.form?.LWL ?? y.hull.length * 0.9, B = y.hull.beam;
    const heel = (T.heel || 0) * Math.PI / 180;              // + = 右舷下沉
    const zeta = V * V / (2 * G);                            // 驻点水头（m）
    const hb = (d) => 0.5 * B * Math.min(1, Math.pow(d / (0.4 * L), 0.7));   // 距船首 d 处的水线半宽（尖瘦船首近似）
    // —— 泡沫：每舷 3 个点，沿船首浪脊（紧贴船壳外侧的一条窄带，实拍里宽 0.3–0.8 m）——
    if (this.ocean) {
      for (const side of [1, -1]) {                         // +1 左舷，−1 右舷
        const lee = 1 + 0.7 * Math.sin(side > 0 ? -heel : heel);          // 下沉的一舷浪更高
        for (let k = 0; k < 3; k++) {
          const d = 0.3 + 0.6 * k, off = hb(d) + 0.1 + 0.12 * k;
          const x = w.bow.x - fx * d + px * side * off, z = w.bow.z - fz * d + pz * side * off;
          this.ocean.addFoam(x, z, 0.3 + 0.1 * k + 0.25 * zeta, Math.min(1, 0.8 * b * lee * (1 - 0.25 * k)));
        }
      }
    }
    // —— 水片：驻点附近射出的毫米级水滴 ——
    if (this.spray) {
      this._acc += this.rate * b * (V / 3) * (V / 3) * 70 * dt;
      const vx = y.state.velocity.x, vz = y.state.velocity.z;
      while (this._acc >= 1) {
        this._acc -= 1;
        const side = Math.random() < 0.5 ? 1 : -1;
        const lee = Math.max(0.2, 1 + 0.7 * Math.sin(side > 0 ? -heel : heel));
        if (Math.random() > Math.min(1, lee / 1.7)) continue;
        const d = 0.15 + Math.random() * 0.6, off = hb(d) + 0.05;
        const out = V * (0.35 + 0.45 * Math.random()), up = V * (0.3 + 0.5 * Math.random()) * Math.sqrt(lee);
        const fwd = 0.55 + 0.35 * Math.random();
        this.spray.emit(
          { x: w.bow.x - fx * d + px * side * off, y: Math.max(w.bow.y, 0) + 0.12 + 0.25 * zeta, z: w.bow.z - fz * d + pz * side * off },
          { x: vx * fwd + px * side * out, y: up, z: vz * fwd + pz * side * out },
          0.06 + 0.16 * Math.random(), 0.7 + 0.8 * Math.random(), 0.3 + 0.25 * b, 3e-4 + 9e-4 * Math.random());
      }
    }
  }
}
