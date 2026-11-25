// 漂浮体：升沉 / 纵摇 / 横摇
//
// 每帧在船体水线采样点下取水面高度，用最小二乘拟合一个平面 h = a + b·x + c·z
// （x 横向、z 纵向，船体坐标），得到目标升沉 a、纵倾 atan(c)、横倾 atan(b)；
// 再用二阶阻尼振子跟随目标。采样点铺满船长和船宽，所以比船短的浪被自然平均掉，
// 比船长的浪会把船抬起、倾侧 —— 这正是船体对波浪的“滤波”。
// 风压倾侧（heel）作为横摇平衡位置的偏移加入。
//
//   const b = new Buoyancy(boat.group, { points: boat.floatPoints });
//   b.update(dt, ocean, { heel });       // 船的 x、z、航向（rotation.y）由外部控制
import * as THREE from 'three';

export class Buoyancy {
  constructor(object, {
    points,                 // 船体坐标的水线采样点（Vector3[]，y 忽略）
    heavePeriod = 2.2,      // 固有周期（s）
    pitchPeriod = 2.8,
    rollPeriod = 3.6,
    damping = 0.35,         // 阻尼比
    draft = 0,              // 水线相对物体原点的高度
  } = {}) {
    this.object = object;
    object.rotation.order = 'YXZ';
    this.points = points.map((p) => new THREE.Vector2(p.x, p.z));
    this.draft = draft;
    this.w = { heave: 2 * Math.PI / heavePeriod, pitch: 2 * Math.PI / pitchPeriod, roll: 2 * Math.PI / rollPeriod };
    this.zeta = damping;
    this.state = { y: 0, vy: 0, pitch: 0, vp: 0, roll: 0, vr: 0 };
    this.target = { y: 0, pitch: 0, roll: 0 };
    this.heights = new Float32Array(points.length);
    // 预先算好最小二乘的法方程矩阵（采样点固定）
    let n = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0;
    for (const p of this.points) { n++; sx += p.x; sz += p.y; sxx += p.x * p.x; szz += p.y * p.y; sxz += p.x * p.y; }
    this._A = new THREE.Matrix3().set(n, sx, sz, sx, sxx, sxz, sz, sxz, szz).invert();
    this._initialized = false;
  }

  /** 采样并拟合水面平面（船体水平坐标系） */
  _fit(ocean) {
    const o = this.object, yaw = o.rotation.y, cy = Math.cos(yaw), sy = Math.sin(yaw);
    let s1 = 0, sx = 0, sz = 0;
    this.points.forEach((p, i) => {
      // 本地 (x, z) → 世界：绕 Y 旋转 yaw（three.js：x' = x·cos + z·sin，z' = −x·sin + z·cos）
      const wx = o.position.x + p.x * cy + p.y * sy;
      const wz = o.position.z - p.x * sy + p.y * cy;
      const h = ocean.sampleHeight(wx, wz);
      this.heights[i] = h;
      s1 += h; sx += h * p.x; sz += h * p.y;
    });
    const e = this._A.elements;   // 列主序
    const a = e[0] * s1 + e[3] * sx + e[6] * sz;
    const b = e[1] * s1 + e[4] * sx + e[7] * sz;
    const c = e[2] * s1 + e[5] * sx + e[8] * sz;
    this.target.y = a;
    this.target.pitch = -Math.atan(c);   // 船首方向水面升高 → 船首抬起（绕 X 轴为负）
    this.target.roll = Math.atan(b);     // 右舷水面升高 → 右舷抬起
  }

  update(dt, ocean, { heel = 0 } = {}) {
    if (!ocean.sim?.ready) return;
    this._fit(ocean);
    const s = this.state, t = this.target, z = this.zeta, w = this.w;
    if (!this._initialized) { s.y = t.y; s.pitch = t.pitch; s.roll = t.roll + heel; this._initialized = true; }
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      s.vy += (w.heave * w.heave * (t.y - s.y) - 2 * z * w.heave * s.vy) * h; s.y += s.vy * h;
      s.vp += (w.pitch * w.pitch * (t.pitch - s.pitch) - 2 * z * w.pitch * s.vp) * h; s.pitch += s.vp * h;
      s.vr += (w.roll * w.roll * (t.roll + heel - s.roll) - 2 * z * w.roll * s.vr) * h; s.roll += s.vr * h;
    }
    const o = this.object;
    o.position.y = s.y - this.draft;
    o.rotation.x = s.pitch;
    o.rotation.z = s.roll;
  }

  /** 船体某个本地点处的水面相对高度（> 0 表示没入水中），可用于判断浪打上甲板、生成浪花 */
  immersion(local, ocean) {
    const p = this.object.localToWorld(local.clone());
    return ocean.sampleHeight(p.x, p.z) - p.y;
  }
}
