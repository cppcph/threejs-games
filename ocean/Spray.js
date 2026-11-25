// =====================================================================================
// Spray —— 飞沫粒子（浪尖被风撕下的飞沫、船首砸浪溅起的水花）
//
//   物理：每个粒子代表一团同尺寸的水滴（半径 r）。水滴受重力与空气阻力：
//         dv/dt = (u_air(z) − v)/τ + g，τ = ρw·d²/(18·μa) / (1 + 0.15·Re^0.687)
//         （Stokes 弛豫时间 + Schiller–Naumann 有限雷诺数修正；隐式积分，小水滴 τ 只有毫秒级也稳定）
//         u_air(z)：中性对数风廓线，z0 按 Charnock（0.011·u*²/g），u* = √Cd·U10，Cd 按 Wu (1982)。
//         所以 50 μm 的水滴几乎立刻随风飘、悬浮成雾，500 μm 的水滴被甩出后很快落回海面
//         （Veron 2015 综述；Mostert 等 2022 数值模拟中水滴初速可达相速度数倍）。
//         不给 r 时按“水团”处理（二次阻力，大团不太受风影响），用于船首整片溅起的水。
//   画法：速度方向拉长的运动模糊条（快门时间 exposure），条越长单位面积越淡（能量守恒）；
//         光照为环境光 + 主光源的 Henyey–Greenstein 前向散射 —— 逆光时水雾发亮。
//
// 用法：
//   const spray = new Spray({ max: 4000 }); scene.add(spray.object);
//   spray.emit(position, velocity, size = 0.3, life = 1.2, opacity = 0.85, radius = 0);
//   每帧：spray.update(dt, { keyLightDirection, keyLightColor, ambientColor, wind, waterHeight });
//         wind: Vector2(x, z) 为 10 m 高度风速（m/s）；waterHeight(x, z) 返回海面高度（可选）
// =====================================================================================
import * as THREE from 'three';
import { airSeaRoughness, windAtHeight, stepDroplet } from './droplets.js';

export { airSeaRoughness };

export class Spray {
  constructor({ max = 4000, color = new THREE.Color(0.94, 0.97, 1.0), gravity = 9.81, exposure = 1 / 60 } = {}) {
    this.max = max; this.count = 0; this.gravity = gravity;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max); this.size = new Float32Array(max);
    this.opacity = new Float32Array(max); this.seed = new Float32Array(max); this.radius = new Float32Array(max);
    const g = new THREE.InstancedBufferGeometry();
    // 单位四边形：x ∈ {0,1}（尾 → 头），y ∈ {−1,1}（横向）
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this._posAttr = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._velAttr = new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage);
    this._data = new Float32Array(max * 4);
    this._dataAttr = new THREE.InstancedBufferAttribute(this._data, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this._posAttr); g.setAttribute('iVel', this._velAttr); g.setAttribute('iData', this._dataAttr);
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 600 }, uViewport: { value: new THREE.Vector2(1280, 720) }, uExposure: { value: exposure },
        uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyColor: { value: new THREE.Color(1, 1, 1) },
        uAmb: { value: new THREE.Color(0.4, 0.5, 0.6) }, uColor: { value: color.clone() },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec3 iVel;
        attribute vec4 iData;   // x: 年龄比例 t, y: 尺寸 (m), z: 不透明度, w: 随机种子
        uniform float uScale; uniform vec2 uViewport; uniform float uExposure;
        uniform vec3 uKeyDir; uniform vec3 uKeyColor; uniform vec3 uAmb; uniform vec3 uColor;
        varying vec3 vCol; varying float vA; varying vec2 vQ; varying float vLen; varying float vSeed;
        float hg(float mu, float g){ float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }
        void main(){
          float t = iData.x;
          float size = iData.y * (0.6 + 1.4 * t);                    // 水团随时间扩散
          mat4 vp = projectionMatrix * viewMatrix;
          vec4 ch = vp * vec4(iPos, 1.0);
          vec4 ct = vp * vec4(iPos - iVel * uExposure, 1.0);          // 快门开启时的位置
          if (ct.w < 0.05) ct = ch;
          vec2 sh = ch.xy / ch.w * 0.5 * uViewport, st = ct.xy / ct.w * 0.5 * uViewport;   // 像素
          vec2 dir = sh - st;
          float len = length(dir);
          vec2 d = len > 1e-3 ? dir / len : vec2(1.0, 0.0), n = vec2(-d.y, d.x);
          float r = clamp(size * uScale / max(ch.w, 0.1), 0.6, 160.0);
          vec2 p = mix(st, sh, position.x) + d * r * (position.x * 2.0 - 1.0) + n * r * position.y;
          vec4 c = mix(ct, ch, position.x);
          gl_Position = vec4(p / (0.5 * uViewport) * c.w, c.z, c.w);
          vQ = vec2(mix(-r, len + r, position.x), position.y * r) / r; // 以半径为单位
          vLen = len / r;
          // 拉长后同样的水量摊在更长的条上
          vA = iData.z * (1.0 - t) * (1.0 - t * 0.3) * smoothstep(0.0, 0.04, t) * 2.0 / (2.0 + vLen);
          if (ch.w < 0.1) vA = 0.0;
          vec3 V = normalize(cameraPosition - iPos);
          float mu = -dot(uKeyDir, V);                                // 逆光看时 → 1
          float phase = hg(mu, 0.75) * 0.75 + hg(mu, 0.2) * 0.25;
          vCol = uColor * (uAmb * 1.05 + uKeyColor * (phase * 4.5 + 0.22));
          vSeed = iData.w;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol; varying float vA; varying vec2 vQ; varying float vLen; varying float vSeed;
        float h11(float x){ return fract(sin(x * 127.1) * 43758.5453); }
        void main(){
          // 到线段（运动轨迹）的距离，以半径为单位
          float u = max(0.0, max(-vQ.x, vQ.x - vLen));
          float r2 = u * u + vQ.y * vQ.y;
          if (r2 > 1.0) discard;
          // 一团水滴的运动模糊：几条沿速度方向的细丝 + 淡雾
          float lines = 0.0;
          for (int i = 0; i < 5; i++) {
            float fi = float(i);
            float y0 = h11(vSeed * 13.0 + fi) * 1.6 - 0.8, w = 0.06 + 0.1 * h11(vSeed * 7.0 + fi);
            float along = smoothstep(-0.2, 0.3, vQ.x - h11(vSeed * 3.0 + fi) * vLen * 0.5);
            lines += exp(-pow((vQ.y - y0) / w, 2.0)) * along * step(0.35, h11(vSeed * 5.0 + fi));
          }
          float a = (exp(-3.0 * r2) * 0.45 + min(lines, 1.0) * 0.7) * (1.0 - smoothstep(0.6, 1.0, r2)) * vA;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vCol, a);
        }`,
      transparent: true, depthWrite: false,
    });
    this.object = new THREE.Mesh(g, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    const P11 = new THREE.Vector2();
    this.object.onBeforeRender = (renderer, scene, camera) => {
      renderer.getDrawingBufferSize(P11);
      const u = this.material.uniforms;
      u.uViewport.value.copy(P11);
      u.uScale.value = P11.y * (camera.projectionMatrix.elements[5] || 1) * 0.5;
    };
  }

  /** radius：水滴半径（m，例如 1e-4 = 100 μm）；0 = 水团（二次阻力） */
  emit(position, velocity, size = 0.3, life = 1.2, opacity = 0.85, radius = 0) {
    let i;
    if (this.count < this.max) i = this.count++;
    else i = Math.floor(Math.random() * this.max);       // 满了就随机替换一个
    const k = i * 3;
    this.pos[k] = position.x; this.pos[k + 1] = position.y; this.pos[k + 2] = position.z;
    this.vel[k] = velocity.x; this.vel[k + 1] = velocity.y; this.vel[k + 2] = velocity.z;
    this.age[i] = 0; this.life[i] = Math.max(0.05, life); this.size[i] = size; this.opacity[i] = opacity;
    this.seed[i] = Math.random(); this.radius[i] = radius;
    return i;
  }

  clear() { this.count = 0; this.geometry.instanceCount = 0; }

  update(dt, { keyLightDirection, keyLightColor, ambientColor, wind, waterHeight } = {}) {
    const u = this.material.uniforms;
    if (keyLightDirection) u.uKeyDir.value.copy(keyLightDirection);
    if (keyLightColor) u.uKeyColor.value.copy(keyLightColor);
    if (ambientColor) u.uAmb.value.copy(ambientColor);
    if (!(dt > 0)) return this;
    const wx = wind ? wind.x : 0, wz = wind ? wind.y : 0, g = this.gravity;
    const U10 = Math.hypot(wx, wz), ex = U10 > 1e-3 ? wx / U10 : 1, ez = U10 > 1e-3 ? wz / U10 : 0;
    const { z0 } = airSeaRoughness(U10);
    const P = this.pos, V = this.vel, D = this._data, v3 = this._v3 || (this._v3 = [0, 0, 0]), a3 = this._a3 || (this._a3 = [0, 0, 0]);
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      const k = i * 3;
      const t = this.age[i] / this.life[i];
      let dead = t >= 1;
      if (!dead) {
        const surf = waterHeight ? waterHeight(P[k], P[k + 2]) : 0;
        const r = this.radius[i];
        if (r > 0) {
          // 对数风廓线中的空气速度（离水面高度 z）
          const Ua = windAtHeight(U10, P[k + 1] - surf, z0);
          a3[0] = ex * Ua; a3[1] = 0; a3[2] = ez * Ua;
          v3[0] = V[k]; v3[1] = V[k + 1]; v3[2] = V[k + 2];
          stepDroplet(v3, r, a3, dt);
          V[k] = v3[0]; V[k + 1] = v3[1]; V[k + 2] = v3[2];
        } else {
          // 水团：二次阻力 a = −c·|v_rel|·v_rel，c 与尺寸成反比
          const c = 0.05 / Math.max(this.size[i], 0.04);
          const rx = V[k] - wx, ry = V[k + 1], rz = V[k + 2] - wz, rl = Math.hypot(rx, ry, rz);
          const f = Math.min(c * rl * dt, 0.9);
          V[k] -= rx * f; V[k + 1] -= ry * f + g * dt; V[k + 2] -= rz * f;
        }
        P[k] += V[k] * dt; P[k + 1] += V[k + 1] * dt; P[k + 2] += V[k + 2] * dt;
        const floor = waterHeight ? surf - 0.15 : -0.6;
        if (P[k + 1] < floor && V[k + 1] < 0) dead = true;
      }
      if (dead) {
        const j = --this.count;
        if (j !== i) {
          P[k] = P[j * 3]; P[k + 1] = P[j * 3 + 1]; P[k + 2] = P[j * 3 + 2];
          V[k] = V[j * 3]; V[k + 1] = V[j * 3 + 1]; V[k + 2] = V[j * 3 + 2];
          this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.size[i] = this.size[j]; this.opacity[i] = this.opacity[j];
          this.seed[i] = this.seed[j]; this.radius[i] = this.radius[j];
          i--;
        }
        continue;
      }
      D[i * 4] = t; D[i * 4 + 1] = this.size[i]; D[i * 4 + 2] = this.opacity[i]; D[i * 4 + 3] = this.seed[i];
    }
    this.geometry.instanceCount = this.count;
    for (const [attr, n] of [[this._posAttr, 3], [this._velAttr, 3], [this._dataAttr, 4]]) {
      attr.clearUpdateRanges(); attr.addUpdateRange(0, this.count * n); attr.needsUpdate = true;
    }
    return this;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

/**
 * 浪尖飞沫（spume）发射器：从白浪场里正在破碎的浪峰处撕下水滴。
 *   起始：蒲福 6–7 级（U10 ≈ 10 m/s）以上开始，产量随 (U10 − 9)^2.5 增加（量级取自 Andreas 1998、
 *         Veron 2015 综述的飞沫生成函数随风速的陡增）；
 *   位置：破碎格子里随机取 3 个点，选最高的（飞沫从浪尖被撕下）；
 *   初速：沿主浪方向约 0.8 倍相速度（破碎浪峰处水质点速度接近相速度）+ 向上 0.5–3 m/s；
 *   尺寸：水滴半径 40–400 μm 按对数均匀取样；之后的运动全由 Spray 的阻力 + 风廓线决定。
 */
export class SpumeEmitter {
  constructor(spray, { rate = 1.6, maxRate = 1400, radius = 170, onsetWind = 9 } = {}) {
    this.spray = spray;
    this.rate = rate;           // 每平方米活跃白浪每秒的水团数（U10 = 19 m/s 时）
    this.maxRate = maxRate;     // 每秒上限（性能）
    this.radius = radius;       // 只在相机周围这么远发射（m）
    this.onsetWind = onsetWind;
    this._acc = 0;
    this._p = { x: 0, y: 0, z: 0 };
    this._v = { x: 0, y: 0, z: 0 };
    this.emitted = 0;
  }

  update(dt, ocean, camera) {
    const U = ocean.model.readout.U10;
    if (U <= this.onsetWind || !ocean.sim.ready || !(dt > 0)) return 0;
    const perArea = this.rate * Math.pow((U - this.onsetWind) / 10, 2.5);
    const cx = camera.position.x, cz = camera.position.z, R2 = this.radius * this.radius;
    const cells = [];
    let total = 0;
    ocean.forEachBreaking((x, z, A, cell) => {
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz > R2) return;
      const w = A * cell * cell * perArea;
      cells.push(x, z, cell, w); total += w;
    }, 0.004);
    if (!total) return 0;
    const scale = Math.min(1, this.maxRate / total);
    const { dir, c } = ocean.dominantWave;
    const W = ocean.model.wind, sim = ocean.sim, d = this._p, v = this._v;
    let n = 0;
    for (let i = 0; i < cells.length; i += 4) {
      this._acc += cells[i + 3] * scale * dt;
      // 随机取整：保留小数部分到下次
      while (this._acc >= 1 || (this._acc > 0 && Math.random() < this._acc)) {
        this._acc -= 1;
        let bx = 0, bz = 0, by = -1e9;
        for (let k = 0; k < 3; k++) {
          const x0 = cells[i] + (Math.random() - 0.5) * cells[i + 2], z0 = cells[i + 1] + (Math.random() - 0.5) * cells[i + 2];
          sim.displacementAt(x0, z0, d);
          if (d.y > by) { by = d.y; bx = x0 + d.x; bz = z0 + d.z; }
        }
        const cs = c * (0.6 + 0.3 * Math.random());
        v.x = dir.x * cs + (Math.random() - 0.5) * 1.5 + W.x * 0.1;
        v.y = 0.5 + Math.random() * 2.5;
        v.z = dir.y * cs + (Math.random() - 0.5) * 1.5 + W.z * 0.1;
        const radius = 4e-5 * Math.pow(10, Math.random());               // 40–400 μm
        const big = (radius - 4e-5) / 3.6e-4;
        this.spray.emit({ x: bx, y: by + 0.15, z: bz }, v, 0.12 + 0.35 * Math.random(), 1.2 + 2.5 * (1 - big) * Math.random(),
          0.16 + 0.2 * big, radius);
        n++;
      }
    }
    this.emitted += n;
    return n;
  }
}
