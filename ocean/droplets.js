// 水滴动力学（纯 JS，无依赖，Node 可测）
//
//   dv/dt = (u_air − v)/τ + g，τ = ρw·d²/(18·μa) / (1 + 0.15·Re^0.687)
//   —— Stokes 弛豫时间 + Schiller–Naumann 有限雷诺数修正（Re < 800 有效，覆盖 1 mm 以下的海洋飞沫）。
//   终端速度与 Gunn & Kinzer (1949) 的实测相差 < 10%（见 tests/ocean/spray.test.mjs）。
//   空气速度取中性对数风廓线 U(z) = U10·ln(z/z0)/ln(10/z0)，z0 = 0.011·u*²/g（Charnock），
//   u* = √Cd·U10，Cd = (0.8 + 0.065·U10)·10⁻³（Wu 1982）。

export const RHO_W = 1025, RHO_A = 1.22, MU_A = 1.8e-5, G = 9.81;

/** 中性大气的拖曳系数（Wu 1982）、摩擦速度与 Charnock 粗糙度 */
export function airSeaRoughness(U10) {
  const Cd = (0.8 + 0.065 * Math.max(U10, 1)) * 1e-3;
  const ustar = Math.sqrt(Cd) * U10;
  const z0 = Math.max(0.011 * ustar * ustar / G, 1e-5);
  return { Cd, ustar, z0 };
}

/** 高度 z（离水面，m）处的风速：中性对数廓线，z 小于 e·z0 时按 e·z0 */
export function windAtHeight(U10, z, z0 = airSeaRoughness(U10).z0) {
  return U10 * Math.log(Math.max(z, z0 * Math.E) / z0) / Math.log(10 / z0);
}

/** 半径 r（m）的水滴在相对速度 vrel（m/s）下的弛豫时间 τ（s） */
export function relaxationTime(r, vrel) {
  const d = 2 * r, Re = RHO_A * vrel * d / MU_A;
  return RHO_W * d * d / (18 * MU_A) / (1 + 0.15 * Math.pow(Re, 0.687));
}

/**
 * 推进一个水滴 dt 秒（隐式欧拉，τ 只有毫秒级的小水滴也稳定）。
 * v = [vx, vy, vz] 原地更新；air = [ax, ay, az] 为水滴所在处的空气速度。
 */
export function stepDroplet(v, r, air, dt) {
  const rx = v[0] - air[0], ry = v[1] - air[1], rz = v[2] - air[2];
  const tau = relaxationTime(r, Math.hypot(rx, ry, rz));
  const f = 1 / (1 + dt / tau);
  v[0] = (v[0] + dt * air[0] / tau) * f;
  v[1] = (v[1] + dt * (air[1] / tau - G)) * f;
  v[2] = (v[2] + dt * air[2] / tau) * f;
  return tau;
}
