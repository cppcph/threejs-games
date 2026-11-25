// =====================================================================================
// Spray —— 浪花 / 飞沫粒子（船首砸浪、风暴时从浪尖被风撕下的飞沫）
//
//   物理：重力 + 二次空气阻力（相对风的速度），小水团更容易被风带走；落回海面或寿命到就消失。
//   光照：环境光 + 主光源的 Henyey–Greenstein 前向散射（g = 0.75）——逆光看时水雾发亮，这是电影镜头里
//         “金色水雾”的来源；顺光时只是灰白。软圆点精灵，近大远小，随时间扩散变淡。
//
// 用法：
//   const spray = new Spray({ max: 4000 }); scene.add(spray.object);
//   spray.emit(position, velocity, size = 0.3, life = 1.2, opacity = 0.85);   // Vector3 或 {x,y,z}
//   每帧：spray.update(dt, { camera, keyLightDirection, keyLightColor, ambientColor, wind, waterHeight });
//         wind: Vector2(x, z) m/s；waterHeight(x, z) 可选，返回该处海面高度（没有就按 y < −0.6 回收）
// =====================================================================================
import * as THREE from 'three';

export class Spray {
  constructor({ max = 4000, color = new THREE.Color(0.94, 0.97, 1.0), gravity = 9.81 } = {}) {
    this.max = max; this.count = 0; this.gravity = gravity;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max); this.size = new Float32Array(max);
    this.opacity = new Float32Array(max); this.seed = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this._posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._data = new Float32Array(max * 4);
    this._dataAttr = new THREE.BufferAttribute(this._data, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this._posAttr); g.setAttribute('aData', this._dataAttr);
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 600 }, uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyColor: { value: new THREE.Color(1, 1, 1) },
        uAmb: { value: new THREE.Color(0.4, 0.5, 0.6) }, uColor: { value: color.clone() },
      },
      vertexShader: /* glsl */`
        attribute vec4 aData;   // x: 年龄比例 t, y: 尺寸 (m), z: 不透明度, w: 随机种子
        uniform float uScale; uniform vec3 uKeyDir; uniform vec3 uKeyColor; uniform vec3 uAmb; uniform vec3 uColor;
        varying vec3 vCol; varying float vA; varying float vSeed;
        float hg(float mu, float g){ float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec4 mv = viewMatrix * wp;
          gl_Position = projectionMatrix * mv;
          float t = aData.x;
          vA = aData.z * (1.0 - t) * (1.0 - t * 0.3) * smoothstep(0.0, 0.05, t);
          float sz = aData.y * (0.55 + 1.6 * t);
          gl_PointSize = clamp(sz * uScale / max(-mv.z, 0.1), 0.0, 220.0);
          vec3 V = normalize(cameraPosition - wp.xyz);
          float mu = -dot(uKeyDir, V);                         // 散射角余弦：相机逆光看时 → 1
          float phase = hg(mu, 0.75) * 0.75 + hg(mu, 0.2) * 0.25;
          vCol = uColor * (uAmb * 1.05 + uKeyColor * (phase * 4.5 + 0.22));
          vSeed = aData.w;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol; varying float vA; varying float vSeed;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main(){
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(c, c);
          if (r2 > 1.0) discard;
          // 一团水花 = 淡淡的雾状包络 + 3×3 格子里随机散落的水滴
          float mist = exp(-3.5 * r2) * 0.32;
          vec2 g = (c * 0.5 + 0.5) * 3.0, cell = floor(g), f = fract(g);
          float drops = 0.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 o = vec2(float(i), float(j)), id = cell + o;
            float hs = h21(id + vSeed * 37.0);
            vec2 pos = o + vec2(h21(id + 1.3 + vSeed * 11.0), h21(id + 7.1 + vSeed * 5.0)) - f;
            float rad = 0.1 + 0.24 * hs;
            drops = max(drops, (1.0 - smoothstep(rad * 0.35, rad, length(pos))) * step(0.3, hs));
          }
          float a = (mist + drops * 0.85) * (1.0 - smoothstep(0.55, 1.0, r2)) * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vCol, a);
        }`,
      transparent: true, depthWrite: false,
    });
    this.object = new THREE.Points(g, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    const P11 = new THREE.Vector2();
    this.object.onBeforeRender = (renderer, scene, camera) => {
      renderer.getDrawingBufferSize(P11);
      const p11 = camera.projectionMatrix.elements[5] || 1;
      this.material.uniforms.uScale.value = P11.y * p11 * 0.5;
    };
  }

  emit(position, velocity, size = 0.3, life = 1.2, opacity = 0.85) {
    let i;
    if (this.count < this.max) i = this.count++;
    else i = Math.floor(Math.random() * this.max);       // 满了就随机替换一个
    const k = i * 3;
    this.pos[k] = position.x; this.pos[k + 1] = position.y; this.pos[k + 2] = position.z;
    this.vel[k] = velocity.x; this.vel[k + 1] = velocity.y; this.vel[k + 2] = velocity.z;
    this.age[i] = 0; this.life[i] = Math.max(0.05, life); this.size[i] = size; this.opacity[i] = opacity; this.seed[i] = Math.random();
    return i;
  }

  clear() { this.count = 0; this.geometry.setDrawRange(0, 0); }

  update(dt, { keyLightDirection, keyLightColor, ambientColor, wind, waterHeight } = {}) {
    const u = this.material.uniforms;
    if (keyLightDirection) u.uKeyDir.value.copy(keyLightDirection);
    if (keyLightColor) u.uKeyColor.value.copy(keyLightColor);
    if (ambientColor) u.uAmb.value.copy(ambientColor);
    if (!(dt > 0)) return this;
    const wx = wind ? wind.x : 0, wz = wind ? wind.y : 0, g = this.gravity;
    const P = this.pos, V = this.vel, D = this._data;
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      const k = i * 3;
      let t = this.age[i] / this.life[i];
      let dead = t >= 1;
      if (!dead) {
        // 二次阻力：a = −c·|v_rel|·v_rel，c 与水团尺寸成反比（细雾更跟风）
        const c = 0.05 / Math.max(this.size[i], 0.04);
        const rx = V[k] - wx, ry = V[k + 1], rz = V[k + 2] - wz, rl = Math.hypot(rx, ry, rz);
        const f = Math.min(c * rl * dt, 0.9);
        V[k] -= rx * f; V[k + 1] -= ry * f + g * dt; V[k + 2] -= rz * f;
        P[k] += V[k] * dt; P[k + 1] += V[k + 1] * dt; P[k + 2] += V[k + 2] * dt;
        const floor = waterHeight ? waterHeight(P[k], P[k + 2]) - 0.25 : -0.6;
        if (P[k + 1] < floor && V[k + 1] < 0) dead = true;
      }
      if (dead) {
        const j = --this.count;
        if (j !== i) {
          P[k] = P[j * 3]; P[k + 1] = P[j * 3 + 1]; P[k + 2] = P[j * 3 + 2];
          V[k] = V[j * 3]; V[k + 1] = V[j * 3 + 1]; V[k + 2] = V[j * 3 + 2];
          this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.size[i] = this.size[j]; this.opacity[i] = this.opacity[j]; this.seed[i] = this.seed[j];
          i--;
        }
        continue;
      }
      D[i * 4] = t; D[i * 4 + 1] = this.size[i]; D[i * 4 + 2] = this.opacity[i]; D[i * 4 + 3] = this.seed[i];
    }
    this.geometry.setDrawRange(0, this.count);
    this._posAttr.clearUpdateRanges(); this._posAttr.addUpdateRange(0, this.count * 3); this._posAttr.needsUpdate = true;
    this._dataAttr.clearUpdateRanges(); this._dataAttr.addUpdateRange(0, this.count * 4); this._dataAttr.needsUpdate = true;
    return this;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
