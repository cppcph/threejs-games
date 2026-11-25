// =====================================================================================
// WakeMap —— 世界对齐的尾迹图（乒乓渲染目标），从《信风》抽出
//
//   覆盖 worldSize × worldSize 米，中心跟随船并吸附到纹素；中心移动时用 UV 偏移把上一帧内容搬过去，
//   所以尾迹固定在世界里，不会跟着船走。每帧：衰减 + 轻微扩散 → 用实例化软圆片“盖章”（ONE/ONE 叠加）。
//     R：持久的湍流泡沫（船尾、船首浪），默认半衰期 5 s
//     G：短命的船行波脊高度（给海面做法线扰动），默认半衰期 0.4 s
//     B：备用（半衰期 2.5 s），A：不用
//   开尔文波臂：船首两侧发射的粒子以 0.354·v（tan 19.47°）横向散开，它们此刻的位置连起来就是 V 形波臂。
//   全部按时间计算（衰减、扩散、盖章量），帧率高低结果一致。
//
// 用法：
//   const wake = new WakeMap(renderer, { resolution: 512, worldSize: 256 });
//   const hullWake = wake.createHullEmitter({ beam: 2.75, length: 8.6 });
//   每帧（在 wake.update 之前）：hullWake.update(dt, { x, z, forwardX, forwardZ, speed });
//   wake.update(dt, boatX, boatZ);
//   海面着色器：vec2 uv = (p.xz - rect.xy) / rect.zw; 只在 0 ≤ uv ≤ 1 时取 texture(uWake, uv)
//   （rect = wake.rect：minX, minZ, sizeX, sizeZ；纹理 u 对应 +x，v 对应 +z）
// =====================================================================================
import * as THREE from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class WakeMap {
  constructor(renderer, { resolution = 512, worldSize = 256, maxStamps = 4000, halfLife = { foam: 5, ridge: 0.4, extra: 2.5 }, diffusion = 4.5 } = {}) {
    this.renderer = renderer;
    this.resolution = resolution; this.worldSize = worldSize; this.texel = worldSize / resolution;
    this.halfLife = { foam: 5, ridge: 0.4, extra: 2.5, ...halfLife };
    this.diffusion = diffusion;
    const o = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    this.rtA = new THREE.WebGLRenderTarget(resolution, resolution, o);
    this.rtB = new THREE.WebGLRenderTarget(resolution, resolution, o);
    this.center = new THREE.Vector2();
    this.rect = new THREE.Vector4(-worldSize / 2, -worldSize / 2, worldSize, worldSize);
    this._inited = false;
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // —— 衰减 + 扩散 + 平移 ——
    this._updMat = new THREE.ShaderMaterial({
      uniforms: { uPrev: { value: null }, uOffset: { value: new THREE.Vector2() }, uDecay: { value: new THREE.Vector4(1, 1, 1, 1) }, uTexel: { value: 1 / resolution }, uDiffuse: { value: 0.18 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`uniform sampler2D uPrev; uniform vec2 uOffset; uniform vec4 uDecay; uniform float uTexel; uniform float uDiffuse; varying vec2 vUv;
        void main(){
          vec2 uv = vUv + uOffset;
          vec4 c = texture2D(uPrev, uv);
          vec4 b = (texture2D(uPrev, uv + vec2(uTexel, 0.0)) + texture2D(uPrev, uv - vec2(uTexel, 0.0))
                  + texture2D(uPrev, uv + vec2(0.0, uTexel)) + texture2D(uPrev, uv - vec2(0.0, uTexel))) * 0.25;
          c = mix(c, b, vec4(uDiffuse, uDiffuse * 0.35, uDiffuse, 0.0));
          float inside = step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
          gl_FragColor = min(c * uDecay * inside, vec4(4.0));
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._updMat); quad.frustumCulled = false;
    this._updScene = new THREE.Scene(); this._updScene.add(quad);

    // —— 盖章：实例化软圆片，ONE/ONE 叠加（three 的 AdditiveBlending 会乘源 alpha，这里不能用）——
    this.maxStamps = maxStamps; this._n = 0;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this._iA = new Float32Array(maxStamps * 4); this._iB = new Float32Array(maxStamps * 4);
    this._attrA = new THREE.InstancedBufferAttribute(this._iA, 4).setUsage(THREE.DynamicDrawUsage);
    this._attrB = new THREE.InstancedBufferAttribute(this._iB, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this._attrA); g.setAttribute('iB', this._attrB); g.instanceCount = 0;
    this._stampGeo = g;
    this._stampMat = new THREE.ShaderMaterial({
      uniforms: { uCenter: { value: this.center }, uHalf: { value: worldSize / 2 } },
      vertexShader: /* glsl */`attribute vec4 iA; attribute vec4 iB; uniform vec2 uCenter; uniform float uHalf; varying vec2 vL; varying vec3 vVal;
        void main(){ float c = cos(iB.x), s = sin(iB.x); vec2 o = vec2(position.x * iA.z, position.y * iA.w);
          vec2 w = vec2(c * o.x - s * o.y, s * o.x + c * o.y) + iA.xy; vL = position.xy; vVal = iB.yzw;
          gl_Position = vec4((w - uCenter) / uHalf, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`varying vec2 vL; varying vec3 vVal;
        void main(){ float r2 = dot(vL, vL); float a = exp(-3.0 * r2) * (1.0 - smoothstep(0.8, 1.0, r2)); gl_FragColor = vec4(vVal * a, 0.0); }`,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, depthTest: false, depthWrite: false, transparent: true,
    });
    const mesh = new THREE.Mesh(g, this._stampMat); mesh.frustumCulled = false;
    this._stampScene = new THREE.Scene(); this._stampScene.add(mesh);
  }

  get texture() { return this.rtA.texture; }

  // 在世界坐标 (x, z) 盖一个椭圆章：长轴半长 halfLength 沿 (cos angle, sin angle)（xz 平面，angle = atan2(dz, dx)），
  // 短轴半宽 halfWidth；foam 写入 R，ridge 写入 G，extra 写入 B。
  // “速率型”的章（每帧都盖）请把强度乘 dt，这样帧率不同累积量一样。
  stamp(x, z, halfLength, halfWidth, angle, foam, ridge = 0, extra = 0) {
    if (this._n >= this.maxStamps) return false;
    const i = this._n++ * 4;
    this._iA[i] = x; this._iA[i + 1] = z; this._iA[i + 2] = halfLength; this._iA[i + 3] = halfWidth;
    this._iB[i] = angle; this._iB[i + 1] = foam; this._iB[i + 2] = ridge; this._iB[i + 3] = extra;
    return true;
  }

  // 船体尾迹发射器：船尾湍流、船首浪、船舷、开尔文波臂。每条船一个。
  createHullEmitter({ beam = 2.75, length = 8.6, intensity = 1, maxParticles = 700 } = {}) {
    return new HullWakeEmitter(this, { beam, length, intensity, maxParticles });
  }

  reset() { this._inited = false; }

  update(dt, centerX, centerZ) {
    const r = this.renderer, t = this.texel;
    const nx = Math.round(centerX / t) * t, nz = Math.round(centerZ / t) * t;
    const u = this._updMat.uniforms;
    const prevTarget = r.getRenderTarget(), ac = r.autoClear;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    if (!this._inited) {
      this.center.set(nx, nz); this._inited = true;
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(this.rtA); r.clear();
      r.setRenderTarget(this.rtB); r.clear();
    }
    u.uOffset.value.set((nx - this.center.x) / this.worldSize, (nz - this.center.y) / this.worldSize);
    this.center.set(nx, nz);
    const hl = this.halfLife;
    u.uDecay.value.set(Math.pow(0.5, dt / hl.foam), Math.pow(0.5, dt / hl.ridge), Math.pow(0.5, dt / hl.extra), 1);
    u.uDiffuse.value = 1 - Math.exp(-dt * this.diffusion);   // 扩散按时间算
    u.uPrev.value = this.rtA.texture;
    r.autoClear = true;
    r.setRenderTarget(this.rtB); r.render(this._updScene, this._cam);
    if (this._n > 0) {
      const n = this._n;
      this._stampGeo.instanceCount = n;
      this._attrA.clearUpdateRanges(); this._attrA.addUpdateRange(0, n * 4); this._attrA.needsUpdate = true;
      this._attrB.clearUpdateRanges(); this._attrB.addUpdateRange(0, n * 4); this._attrB.needsUpdate = true;
      r.autoClear = false; r.render(this._stampScene, this._cam);
    }
    r.autoClear = ac; r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    this._n = 0;
    const tmp = this.rtA; this.rtA = this.rtB; this.rtB = tmp;
    const half = this.worldSize / 2;
    this.rect.set(nx - half, nz - half, this.worldSize, this.worldSize);
    return this;
  }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose();
    this._updMat.dispose(); this._updScene.children[0].geometry.dispose();
    this._stampMat.dispose(); this._stampGeo.dispose();
  }
}

class HullWakeEmitter {
  constructor(wake, { beam, length, intensity, maxParticles }) {
    this.wake = wake; this.beam = beam; this.length = length; this.intensity = intensity; this.maxParticles = maxParticles;
    this.parts = []; this._emit = 0; this._prevSx = null; this._prevSz = null;
  }
  reset() { this.parts.length = 0; this._emit = 0; this._prevSx = this._prevSz = null; }
  // x, z：船中心（水线）；forwardX/forwardZ：船首方向（会归一化）；speed：对水速度 m/s
  update(dt, { x, z, forwardX, forwardZ, speed = 0 }) {
    const w = this.wake;
    if (!(dt > 0)) return;
    let fl = Math.hypot(forwardX, forwardZ) || 1; const fx = forwardX / fl, fz = forwardZ / fl;
    const rx = -fz, rz = fx;                                         // 船舷方向（垂直于航向）
    const spd = Math.max(0, speed), sf = clamp(spd / 6, 0, 1.3) * this.intensity;
    const L2 = this.length / 2, B = this.beam;
    const sx = x - fx * (L2 - 0.3), sz = z - fz * (L2 - 0.3), bx = x + fx * (L2 - 0.4), bz = z + fz * (L2 - 0.4);
    // 船尾湍流：沿上一帧→这一帧的船尾线段盖一个拉长的章；按覆盖率缩放，帧率高低累积量一样
    if (this._prevSx !== null) {
      const ddx = sx - this._prevSx, ddz = sz - this._prevSz, seg = Math.hypot(ddx, ddz);
      if (seg > 0.01 && seg < 20) {
        const cov = seg / (seg + 0.6);
        w.stamp((sx + this._prevSx) / 2, (sz + this._prevSz) / 2, seg / 2 + 0.3, B * 0.3 + spd * 0.025, Math.atan2(ddz, ddx), 0.6 * sf * cov, 0.12 * sf * cov);
      }
    }
    this._prevSx = sx; this._prevSz = sz;
    // 船首浪与船舷：速率型（× dt）
    w.stamp(bx, bz, 1.2, 1.2, 0, 0.45 * sf * dt, 1.3 * sf * dt);
    for (const s of [-1, 1]) w.stamp(x + rx * s * B * 0.5, z + rz * s * B * 0.5, 2.2, 0.6, Math.atan2(fz, fx), 0.2 * sf * dt, 0.8 * sf * dt);
    // 开尔文波臂：船首两侧发射、以 0.354·v 横向散开的粒子
    this._emit += dt * 22 * Math.min(1, spd / 2);
    while (this._emit > 1) {
      this._emit -= 1;
      for (const s of [-1, 1]) this.parts.push({ x: bx + rx * s * 0.4, z: bz + rz * s * 0.4, vx: rx * s * 0.354 * spd, vz: rz * s * 0.354 * spd, age: 0, k: sf });
    }
    if (this.parts.length > this.maxParticles) this.parts.splice(0, this.parts.length - this.maxParticles);
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt; if (p.age > 7) { this.parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.z += p.vz * dt;
      const fade = (1 - p.age / 7) * p.k, r = 0.7 + p.age * 0.18;
      // 波臂只写 G（快衰减）；刚离开船首的一小段带一点泡沫
      w.stamp(p.x, p.z, r, r, 0, p.age < 1.0 ? 0.3 * fade * dt : 0, 1.25 * fade * dt);
    }
  }
}
