// 小型向量 / 四元数 / 旋转矩阵工具（纯 JS，不依赖 three.js）。
// 约定与 three.js 一致：四元数 {x, y, z, w} 把船体坐标旋转到世界坐标；欧拉角 'YXZ' 顺序（yaw 绕 Y、pitch 绕 X、roll 绕 Z）。
// 矩阵为 9 元行主序数组：world = M · body。

/** three.js Quaternion.setFromEuler(order 'YXZ') */
export function quatFromYXZ(yaw, pitch, roll, out = { x: 0, y: 0, z: 0, w: 1 }) {
  const c1 = Math.cos(pitch / 2), c2 = Math.cos(yaw / 2), c3 = Math.cos(roll / 2);
  const s1 = Math.sin(pitch / 2), s2 = Math.sin(yaw / 2), s3 = Math.sin(roll / 2);
  out.x = s1 * c2 * c3 + c1 * s2 * s3;
  out.y = c1 * s2 * c3 - s1 * c2 * s3;
  out.z = c1 * c2 * s3 - s1 * s2 * c3;
  out.w = c1 * c2 * c3 + s1 * s2 * s3;
  return out;
}

/** 四元数 → 行主序旋转矩阵 */
export function quatToMat(q, m = new Float64Array(9)) {
  const { x, y, z, w } = q, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = 1 - (yy + zz); m[1] = xy - wz; m[2] = xz + wy;
  m[3] = xy + wz; m[4] = 1 - (xx + zz); m[5] = yz - wx;
  m[6] = xz - wy; m[7] = yz + wx; m[8] = 1 - (xx + yy);
  return m;
}

/** 旋转矩阵 → 'YXZ' 欧拉角 { yaw, pitch, roll }（three.js Euler.setFromRotationMatrix） */
export function matToYXZ(m, out = { yaw: 0, pitch: 0, roll: 0 }) {
  const m12 = Math.max(-1, Math.min(1, m[5]));
  out.pitch = Math.asin(-m12);
  if (Math.abs(m12) < 0.9999999) { out.yaw = Math.atan2(m[2], m[8]); out.roll = Math.atan2(m[3], m[4]); }
  else { out.yaw = Math.atan2(-m[6], m[0]); out.roll = 0; }
  return out;
}

/** q ← normalize(q + ½ h (ω ⊗ q))，ω 为世界坐标角速度 */
export function quatIntegrate(q, wx, wy, wz, h) {
  const { x, y, z, w } = q, k = 0.5 * h;
  const nx = x + k * (wx * w + wy * z - wz * y);
  const ny = y + k * (wy * w + wz * x - wx * z);
  const nz = z + k * (wz * w + wx * y - wy * x);
  const nw = w - k * (wx * x + wy * y + wz * z);
  const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
  q.x = nx * l; q.y = ny * l; q.z = nz * l; q.w = nw * l;
  return q;
}

/** out = M v / out = Mᵀ v（v、out 为长度 3 的数组，可相同） */
export function mulMV(m, v, out) { const x = v[0], y = v[1], z = v[2]; out[0] = m[0] * x + m[1] * y + m[2] * z; out[1] = m[3] * x + m[4] * y + m[5] * z; out[2] = m[6] * x + m[7] * y + m[8] * z; return out; }
export function mulMtV(m, v, out) { const x = v[0], y = v[1], z = v[2]; out[0] = m[0] * x + m[3] * y + m[6] * z; out[1] = m[1] * x + m[4] * y + m[7] * z; out[2] = m[2] * x + m[5] * y + m[8] * z; return out; }
export const cross = (a, b, out = [0, 0, 0]) => { const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]; out[0] = x; out[1] = y; out[2] = z; return out; };

/** 3×3 矩阵求逆（行主序） */
export function inv3(a, out = new Float64Array(9)) {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7], a8 = a[8];
  const c0 = a4 * a8 - a5 * a7, c1 = a5 * a6 - a3 * a8, c2 = a3 * a7 - a4 * a6;
  const d = a0 * c0 + a1 * c1 + a2 * c2, k = 1 / d;
  out[0] = c0 * k; out[1] = (a2 * a7 - a1 * a8) * k; out[2] = (a1 * a5 - a2 * a4) * k;
  out[3] = c1 * k; out[4] = (a0 * a8 - a2 * a6) * k; out[5] = (a2 * a3 - a0 * a5) * k;
  out[6] = c2 * k; out[7] = (a1 * a6 - a0 * a7) * k; out[8] = (a0 * a4 - a1 * a3) * k;
  return out;
}

/** 罗盘方位（度）：0 = 北（−Z），90 = 东（+X）；输入世界水平向量 (x, z) */
export const bearing = (x, z) => ((Math.atan2(x, -z) * 180 / Math.PI) % 360 + 360) % 360;
