// =====================================================================================
// three-adapter —— 把 SailingYacht（纯 JS 物理）接到 three.js 画面上（这是 vessel/ 里唯一 import three 的文件）
//
//   import { applyToThree, emitSpray, driveWake } from './ocean/vessel/three-adapter.js';
//   yacht.step(dt, { ocean, wind });
//   applyToThree(yacht, boat, { dt, time, sky });   // boat：extras/Sailboat（或任意 Object3D）
//   emitSpray(yacht, spray);                         // 砰击 / 飞溅事件 → Spray 粒子
//   driveWake(yacht, hullWake, dt);                  // 船行波 → WakeMap 的船体发射器
// =====================================================================================
import * as THREE from 'three';
import { HullShape } from './HullShape.js';

/**
 * 位置、四元数写到 Object3D（Sailboat 时写 boat.group），并用物理的帆状态驱动帆的外观。
 * 物理船体坐标与 Sailboat 局部坐标相同（原点在水线中心，船首 +Z，左舷 +X，Y 向上），所以直接复制即可。
 */
export function applyToThree(yacht, target, { dt = 0, time, sky } = {}) {
  const obj = target && target.isObject3D ? target : target.group;
  const s = yacht.state;
  obj.position.set(s.position.x, s.position.y, s.position.z);
  obj.quaternion.set(s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w);
  obj.updateMatrixWorld();
  if (target && !target.isObject3D) {
    if (!target._vesselChecked) { target._vesselChecked = true; checkHull(yacht, target); }
    if (typeof target.applyPhysics === 'function') target.applyPhysics(dt, yacht.sail, { time, sky });
  }
  return obj;
}

/** 画面船体（Sailboat.params）与物理船体参数不一致时警告一次：两者应来自同一组 HullGenerator 参数 */
export function checkHull(yacht, boat) {
  const p = boat.params;
  if (!p) return true;
  const keys = ['length', 'beam', 'draft', 'freeboard', 'sheerRise', 'transom', 'maxBeamAt', 'entry', 'bilge', 'flare'];
  const bad = keys.filter((k) => Math.abs((p[k] ?? 0) - (yacht.hull[k] ?? 0)) > 1e-9);
  if (bad.length) console.warn(`[vessel] 画面船体与物理船体参数不同（${bad.join(', ')}）：请用 new Sailboat({ hull: yacht.hull })`);
  return bad.length === 0;
}

/** 检查 extras/Sailboat 的 HullGenerator 与 HullShape 的型线公式是否一致（浏览器里调用） */
export function compareHullGenerator(HullGenerator, p) {
  let err = 0;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 10; j++) {
    const s = i / 20, th = j / 10 * Math.PI / 2;
    const a = HullGenerator.section(p, s, th), b = HullShape.section(p, s, th);
    err = Math.max(err, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  }
  return err;
}

const _p = new THREE.Vector3(), _v = new THREE.Vector3();
/**
 * 砰击 / 飞溅事件 → Spray 粒子。事件给出入水点、射流速度（Wagner：≈ 2 × 入水速度，沿船壳向外向上）与强度；
 * 另外按船首波强度（yacht.wake.strength）在船首持续喷一点细碎水花。rate 为整体倍数。
 */
export function emitSpray(yacht, spray, { rate = 1, rng = Math.random, max = 140 } = {}) {
  let emitted = 0;
  for (const e of yacht.events) {
    const n = Math.min(max - emitted, Math.round((4 + 90 * e.intensity) * rate));
    for (let i = 0; i < n; i++) {
      const j = 0.35 + 0.65 * rng(), sp = 0.25 * e.speed;
      _p.set(e.position.x + (rng() - 0.5) * 0.6, e.position.y + 0.05, e.position.z + (rng() - 0.5) * 0.6);
      _v.set(e.velocity.x * j + (rng() - 0.5) * sp, Math.max(0.5, e.velocity.y * j + 1.5 * rng()), e.velocity.z * j + (rng() - 0.5) * sp);
      spray.emit(_p, _v, 0.02 + 0.08 * rng() * (0.5 + e.intensity), 0.6 + 0.9 * rng(), 0.35 + 0.4 * e.intensity);
    }
    emitted += n;
  }
  // 船首波水花（Fn > 0.3 时明显）
  const w = yacht.wake, k = w.strength * w.strength * rate;
  if (k > 0.02 && rng() < k) {
    _p.set(w.bow.x, Math.max(w.bow.y, 0) + 0.1, w.bow.z);
    const side = rng() < 0.5 ? -1 : 1;
    _v.set(w.direction.x * w.speed * 0.6 - side * w.direction.z * (1 + 2 * rng()), 0.8 + 1.6 * rng(), w.direction.z * w.speed * 0.6 + side * w.direction.x * (1 + 2 * rng()));
    spray.emit(_p, _v, 0.03 + 0.06 * rng(), 0.6 + 0.6 * rng(), 0.4);
    emitted++;
  }
  return emitted;
}

/**
 * 船行波 → WakeMap 的船体发射器（船首方向 = 艏向，速度 = 对水速度，强度随兴波阻力推出的波幅变化，
 * 波臂半角 = 开尔文角或高傅汝德数时更窄的表观角，Rabaud & Moisy 2013）
 */
export function driveWake(yacht, hullEmitter, dt) {
  const s = yacht.state, t = yacht.telemetry, w = yacht.wake;
  hullEmitter.intensity = 0.4 + 0.6 * Math.min(1, w.strength * 1.5);
  hullEmitter.update(dt, { x: s.position.x, z: s.position.z, forwardX: Math.sin(t.yaw), forwardZ: Math.cos(t.yaw), speed: w.speed, angle: w.angle });
}
