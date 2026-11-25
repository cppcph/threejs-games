// =====================================================================================
// Autopilot —— 舵机：保持航向或真风角，执行迎风换舷（tack）/ 顺风换舷（gybe）
//
// 串级控制（船用自动舵的常见结构）：
//   外环：航向误差 e → 期望偏航角速度 r* = clamp(K_ψ·s·e, ±r_max·s)（平时 6°/s，换舷 7°/s：巡航船 90° 换舷约 12–15 s；
//         s = V/V_ref ∈ [0.3, 1]：低速时舵效 ∝ V² 而偏航惯性不变，转得慢些才刹得住）
//   内环：舵角 = k(V)·[K_r·(r* − r)] + K_i·∫e dt；k(V) = (V_ref/V)² 补偿舵力 ∝ V²
//   舵角限 ±30°、舵机速率 15°/s。外环把转向角速度限住，接近目标航向时 r* 自动减小，
//   所以长龙骨船（偏航惯性大）换舷后也不会大幅冲过头。积分项吸收稳态的上风舵 / 下风舵。
//   保持真风角时目标航向随真风方向变化（阵风换向时船跟着转）。
//   换舷：只改变“哪一舷受风”并强制转向方向（迎风换舷穿过风眼，顺风换舷穿过正顺风）；
//   船首穿过风时帆自动换边（Sails 按视风侧决定）。
//   上风舵 / 下风舵不在这里设定：稳态舵角是帆的受力中心与水下侧向阻力中心不重合的结果。
//
// 航向约定：yaw 与 three.js rotation.y 相同（船首方向 = (sin yaw, 0, cos yaw)），yaw 增大 = 向左舷转。
// 正舵角（后缘偏向左舷 +X）使船向左转（yaw 增大）。
// =====================================================================================
const TAU = Math.PI * 2, DEG = Math.PI / 180;
export const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);

export class Autopilot {
  constructor({ kHeading = 0.6, kRate = 4.5, ki = 0.06, rateMax = 6 * DEG, rateMaxTurn = 7 * DEG, maxRudder = 30 * DEG, rudderRate = 15 * DEG, vRef = 2.5 } = {}) {
    Object.assign(this, { kHeading, kRate, ki, rateMax, rateMaxTurn, maxRudder, rudderRate, vRef });
    this.mode = 'twa';           // 'twa' | 'heading' | 'manual'
    this.target = 50 * DEG;      // twa：真风角大小；heading：目标 yaw
    this.tack = 'starboard';     // 'port'：左舷受风；'starboard'：右舷受风
    this.manualRudder = 0;
    this.rudder = 0;             // 当前舵角
    this._int = 0; this._turn = 0;
    this.error = 0; this.desired = 0; this.rateCommand = 0;
  }

  /** 真风来向 yaw（风矢量指向下风）→ 该 tack 上的目标 yaw */
  desiredYaw(windFromYaw) {
    if (this.mode === 'heading') return this.target;
    // 左舷受风：风源在船首左侧（局部角 a = windFrom − yaw > 0），yaw = windFrom − twa
    return this.tack === 'port' ? windFromYaw - this.target : windFromYaw + this.target;
  }

  /** 换舷：迎风（|twa| < 90°）为 tack，顺风为 gybe；kind 可强制 'tack' / 'gybe' */
  changeTack(kind) {
    const upwind = this.mode !== 'twa' || this.target < Math.PI / 2;
    const k = kind || (upwind ? 'tack' : 'gybe');
    const fromPort = this.tack === 'port';
    // 迎风换舷：左舷受风 → 右舷受风时 yaw 增大；顺风换舷方向相反
    this._turn = (k === 'tack') === fromPort ? 1 : -1;
    this.tack = fromPort ? 'starboard' : 'port';
    this._int = -this._int;      // 稳态压舵随受风舷镜像
    return k;
  }

  update(dt, { yaw, yawRate, windFromYaw, speed }) {
    if (this.mode === 'manual') { this._slew(dt, this.manualRudder); return this.rudder; }
    const want = this.desiredYaw(windFromYaw);
    let e = wrap(want - yaw);
    if (this._turn) {
      if (Math.sign(e) !== this._turn && Math.abs(e) > 0.05) e += this._turn * TAU;
      if (Math.abs(e) < 10 * DEG) this._turn = 0;
    }
    this.error = e; this.desired = want;
    // 低速时舵效 ∝ V²，偏航惯性却不变：转向角速度上限、航向增益都按船速缩小，否则刹不住、冲过头
    const sv = Math.min(1, Math.max(0.3, speed / this.vRef));
    const rmax = (this._turn ? this.rateMaxTurn : this.rateMax) * Math.max(0.4, sv);
    const rStar = Math.max(-rmax, Math.min(rmax, this.kHeading * sv * e));
    this.rateCommand = rStar;
    const k = Math.min(4, Math.max(0.35, (this.vRef / Math.max(speed, 0.6)) ** 2));
    if (!this._turn && Math.abs(e) < 20 * DEG) this._int = Math.max(-0.25, Math.min(0.25, this._int + this.ki * k * e * dt));
    const cmd = k * this.kRate * (rStar - yawRate) + this._int;
    this._slew(dt, Math.max(-this.maxRudder, Math.min(this.maxRudder, cmd)));
    return this.rudder;
  }

  _slew(dt, cmd) {
    const d = cmd - this.rudder, m = this.rudderRate * dt;
    this.rudder += Math.max(-m, Math.min(m, d));
  }

  get turning() { return this._turn !== 0; }
}
