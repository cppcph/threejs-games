// 白浪泡沫场：世界坐标中的破碎判定与泡沫生命周期
//
// 每个纹素代表一块随表面漂流的水（漂流坐标 q = x0 − 累计漂流，x0 为未位移的参考位置）。
// 海面位移按参考位置存储，所以泡沫自动随轨道运动前后摆动、在浪峰处被挤密；漂流（Stokes 漂流 +
// 风生流，约 3% U10）体现为整张图的平移。图跟随相机按整纹素重新居中，内容不会因重采样变糊。
//
// 三个通道都是“面积比例”（0–1）：这一格水面有多大比例被该类泡沫覆盖。
//   A  活跃白浪（stage A）：正在破碎的浪峰前坡上翻滚的厚泡沫，衰减时间 τA ≈ 0.5 s
//   B  残留泡沫（stage B）：破碎停止后留在水面的泡沫斑，τB ≈ 3.9 s（Monahan & Lu 1990）
//   C  老化泡沫丝：B 消退时残下的薄泡沫与表面活性物质膜，寿命几十秒，被朗缪尔环流
//      聚到沿风向的辐合线上、被辐合线上更快的顺风流拉长 → 大风时沿风向的泡沫条纹（蒲福 7–9 级描述）
// 第四个通道 f = min(1, A + B)：照片法测得的白浪覆盖率（Monahan 定义，含 A、B，不含很薄的 C）。
//
// 破碎判据：波长 > 约 4 m 的两级合成的总雅可比 J = (1+Dxx)(1+Dzz) − Dxz² 低于阈值，
// 即局部水平压缩（≈ 线性化的浪峰陡度）超过临界值；只在浪峰之上、偏浪前坡，强度沿浪峰分段变化
// （分段噪声随主浪群速度移动：破碎集中在波群能量最大处）。
// 阈值由 Ocean 按观测覆盖率慢速校准；破碎发生在哪里、持续多久、留下什么，都由这里的过程决定。
import * as THREE from 'three';

const VS = /* glsl */`
precision highp float;
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const NOISE = /* glsl */`
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
bool inside(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))); }`;

const UPDATE_FS = /* glsl */`
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform vec2 uShift;          // 重新居中的整纹素平移（UV）
uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform sampler2D uSlope0;
uniform sampler2D uSlope1;
uniform sampler2D uDer0;
uniform sampler2D uDer1;
uniform vec2 uUV0;            // 本图左下角在两级纹理中的 UV（CPU 双精度取小数，含半纹素）
uniform vec2 uUV1;
uniform vec2 uScale;          // 本图边长 / 两级平铺尺寸
uniform vec2 uQOrigin;        // 本图左下角的漂流坐标（对噪声周期取模）
uniform float uExtent;
uniform float uDt;
uniform vec4 uTau;            // τA, τB, τC (s), B 消退量转为 C 的比例
uniform float uThreshold;     // J 阈值
uniform float uGain;
uniform float uSigmaH;        // 两级合成海面高度的标准差（m）
uniform vec2 uWaveDir;        // 主浪传播方向
uniform vec2 uSegOff;         // 分段噪声随群速度的累计位移（m，取模）
uniform float uSegScale;      // 破碎段的尺度（m）
uniform vec2 uWindDir;
uniform vec3 uLangmuir;       // 横风向辐合速度幅值、顺风射流幅值（m/s），辐合线间距（m）
layout(location = 0) out vec4 outState;
` + NOISE + /* glsl */`
void main() {
  vec2 q = uQOrigin + vUv * uExtent;

  // 朗缪尔环流的表面流（风坐标系：a 顺风，b 横风）。辐合线在 b = n·S，线上顺风流最快。
  vec2 cw = vec2(-uWindDir.y, uWindDir.x);
  float a = dot(q, uWindDir), b = dot(q, cw);
  float S = uLangmuir.z;
  // 辐合线弯曲、间距不等、断续、Y 形汇合（两层噪声扭曲相位）
  float wob = (vnoise(vec2(a / (S * 6.0), b / (S * 2.3))) - 0.5) * 2.2 + (vnoise(vec2(a / (S * 2.1), b / (S * 0.9)) + 3.7) - 0.5) * 0.7;
  float ph = 6.2831853 * (b / S + wob);
  vec2 vel = uWindDir * (uLangmuir.y * cos(ph)) - cw * (uLangmuir.x * sin(ph));
  float divergence = -uLangmuir.x * 6.2831853 / S * cos(ph);

  vec2 puv = vUv + uShift;
  vec4 prev = inside(puv) ? texture(uPrev, puv) : vec4(0.0);
  vec2 cuv = puv - vel * uDt / uExtent;                     // 半拉格朗日平流（只对长寿命的 C）
  float C = inside(cuv) ? texture(uPrev, cuv).z : 0.0;
  C *= exp(-divergence * uDt);                              // 面密度守恒：辐合处变浓
  float A = prev.x, B = prev.y;

  // 生命周期（指数衰减按 dt 精确积分）：活跃 → 残留 → 老化泡沫丝
  float kA = exp(-uDt / uTau.x), kB = exp(-uDt / uTau.y), kC = exp(-uDt / uTau.z);
  float dA = A * (1.0 - kA), dB = B * (1.0 - kB);
  A *= kA;
  B = B * kB + dA;
  C = C * kC + dB * uTau.w;

  // 破碎判据
  vec2 uv0 = uUV0 + vUv * uScale.x, uv1 = uUV1 + vUv * uScale.y;
  vec4 d0 = texture(uDer0, uv0), d1 = texture(uDer1, uv1);
  float jxx = 1.0 + d0.x + d1.x, jzz = 1.0 + d0.y + d1.y, jxz = d0.z + d1.z;
  float J = jxx * jzz - jxz * jxz;
  float h = texture(uDisp0, uv0).y + texture(uDisp1, uv1).y;
  vec2 s = texture(uSlope0, uv0).xy + texture(uSlope1, uv1).xy;
  float crest = smoothstep(-0.6, 1.0, h / uSigmaH);     // 长浪峰上的短波更易破碎（调制），浪谷里也会有少量
  float face = mix(0.35, 1.0, smoothstep(0.05, -0.12, dot(s, uWaveDir)));   // 前坡（沿传播方向下降）
  vec2 g = q - uSegOff;
  float seg = vnoise(g / uSegScale) * 0.6 + vnoise(g / (uSegScale * 0.41) + 5.2) * 0.4;
  // 破碎核心几乎全白（面积比例 → 1），边缘渐稀
  float brk = clamp((uThreshold - J) * uGain * mix(0.3, 1.6, smoothstep(0.3, 0.7, seg)) * crest * face * 2.5, 0.0, 1.0);
  A = max(A, brk);
  B = min(B, 1.0 - A * 0.5);     // 活跃白浪盖在残留泡沫之上
  C = clamp(C, 0.0, 1.0);

  outState = vec4(A, B, C, min(1.0, A + B));
}`;

// 统计：最高一级 mip = 全图平均（各通道的平均面积比例）
const STATS_FS = /* glsl */`
precision highp float;
uniform sampler2D uState;
out vec4 outColor;
void main() { outColor = textureLod(uState, vec2(0.5), 20.0); }`;

// 浪峰回读：按 mip 降采样到 M×M（每格的平均面积比例），供 CPU 在破碎处发射飞沫
const CRESTS_FS = /* glsl */`
precision highp float;
uniform sampler2D uState;
uniform float uLod;
uniform float uM;
out vec4 outColor;
void main() { outColor = textureLod(uState, gl_FragCoord.xy / uM, uLod); }`;

function raw(fs, uniforms) {
  return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
}
const frac = (x) => x - Math.floor(x);
const wrapP = (x, p) => ((x % p) + p) % p;

/** 泡沫生命周期的观测值 */
export const FOAM_TIMESCALES = {
  tauA: 0.5,     // 活跃白浪（Monahan & Lu 1990：约 0.53 s）
  tauB: 3.85,    // 残留泡沫的指数衰减时间（Monahan & Lu 1990；实测 2–20 s，随表面活性物质增加）
};

export class FoamField {
  /**
   * @param renderer
   * @param sim       OceanSimulation（读取级联 0、1 的位移、坡度、导数纹理）
   * @param size      分辨率（纹素）
   * @param extent    覆盖边长（m）
   * @param crests    浪峰回读分辨率（0 = 不回读）
   */
  constructor(renderer, sim, { size = 1024, extent = 512, crests = 128 } = {}) {
    this.renderer = renderer;
    this.sim = sim;
    this.size = size;
    this.extent = extent;
    this.texel = extent / size;
    // 32 位浮点：朗缪尔平流每帧只移动千分之几个纹素，半精度会把这么小的变化舍入掉
    const linearFloat = renderer.extensions.has('OES_texture_float_linear');
    const opts = { type: linearFloat ? THREE.FloatType : THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
      depthBuffer: false, stencilBuffer: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, anisotropy: 4 };
    this.targets = [new THREE.WebGLRenderTarget(size, size, opts), new THREE.WebGLRenderTarget(size, size, opts)];
    this.current = 0;
    this.centerQ = new THREE.Vector2(NaN, NaN);   // 本图中心（漂流坐标）
    this.drift = new THREE.Vector2();              // 累计漂流位移（m）
    this.rectMin = new THREE.Vector2();            // 本图左下角对应的参考坐标 x0
    this._segTravel = 0;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad);
    this.updateMat = raw(UPDATE_FS, {
      uPrev: { value: null }, uShift: { value: new THREE.Vector2() },
      uDisp0: { value: null }, uDisp1: { value: null }, uSlope0: { value: null }, uSlope1: { value: null }, uDer0: { value: null }, uDer1: { value: null },
      uUV0: { value: new THREE.Vector2() }, uUV1: { value: new THREE.Vector2() }, uScale: { value: new THREE.Vector2() },
      uQOrigin: { value: new THREE.Vector2() }, uExtent: { value: extent }, uDt: { value: 0 },
      uTau: { value: new THREE.Vector4(FOAM_TIMESCALES.tauA, FOAM_TIMESCALES.tauB, 20, 0) },
      uThreshold: { value: 0.3 }, uGain: { value: 12 }, uSigmaH: { value: 0.5 },
      uWaveDir: { value: new THREE.Vector2(1, 0) }, uSegOff: { value: new THREE.Vector2() }, uSegScale: { value: 8 },
      uWindDir: { value: new THREE.Vector2(1, 0) }, uLangmuir: { value: new THREE.Vector3(0, 0, 20) },
    });
    this.statsMat = raw(STATS_FS, { uState: { value: null } });
    this.statsTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    this._statsBuf = new Float32Array(4);
    this._statsPending = false;
    /** 全图平均面积比例：active = A，residual = B，lace = C，coverage = 照片法白浪覆盖率 f */
    this.stats = { active: 0, residual: 0, lace: 0, coverage: 0, samples: 0 };

    this.crestSize = crests;
    if (crests) {
      this.crestMat = raw(CRESTS_FS, { uState: { value: null }, uLod: { value: Math.log2(size / crests) }, uM: { value: crests } });
      this.crestTarget = new THREE.WebGLRenderTarget(crests, crests, { type: THREE.FloatType, depthBuffer: false });
      this._crestBuf = [new Float32Array(crests * crests * 4), new Float32Array(crests * crests * 4)];
      this._crestPending = false;
      /** 最近一次浪峰回读：data（RGBA = 各格 A、B、C、f），左下角参考坐标 minX/minZ，格宽 cell（m） */
      this.crests = null;
    }
  }

  get texture() { return this.targets[this.current].texture; }

  /** 海面着色器采样用：uv = x0 / extent + offset（originX/Z 为网格原点，CPU 双精度） */
  uvOffsetFor(originX, originZ, out = new THREE.Vector2()) {
    return out.set((originX - this.rectMin.x) / this.extent, (originZ - this.rectMin.y) / this.extent);
  }

  /** 清空（风况突变、切镜头） */
  reset() { this.centerQ.set(NaN, NaN); }

  /**
   * 推进 dt 秒。
   * @param p.cameraX/cameraZ  相机水平位置
   * @param p.drift            累计表面漂流位移 Vector2（m），与海面泡沫纹理同一个
   * @param p.threshold, gain, sigmaH, waveDir, windDir, groupSpeed, segScale
   * @param p.tau              {A, B, C, toC}
   * @param p.langmuir         {converge, jet, spacing}
   */
  update(dt, p) {
    const r = this.renderer, u = this.updateMat.uniforms, sim = this.sim, E = this.extent, T = this.texel;
    this.drift.copy(p.drift);
    const camQx = p.cameraX - this.drift.x, camQz = p.cameraZ - this.drift.y;
    const cx = Math.round(camQx / T) * T, cz = Math.round(camQz / T) * T;
    const prevTarget = r.getRenderTarget(), prevAuto = r.autoClear;
    if (!(Math.abs(cx - this.centerQ.x) < 0.5 * E && Math.abs(cz - this.centerQ.y) < 0.5 * E)) {
      // 首次或跳得太远：清空
      const cc = r.getClearColor(this._cc || (this._cc = new THREE.Color())), ca = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      for (const t of this.targets) { r.setRenderTarget(t); r.clear(); }
      r.setClearColor(cc, ca);
      u.uShift.value.set(0, 0);
    } else {
      u.uShift.value.set((cx - this.centerQ.x) / E, (cz - this.centerQ.y) / E);
    }
    this.centerQ.set(cx, cz);
    const qMinX = cx - E / 2, qMinZ = cz - E / 2;
    this.rectMin.set(qMinX + this.drift.x, qMinZ + this.drift.y);

    const c = sim.cascades, ht = 0.5 / sim.size;
    u.uDisp0.value = c[0].displacement; u.uDisp1.value = c[1].displacement;
    u.uSlope0.value = c[0].slope; u.uSlope1.value = c[1].slope;
    u.uDer0.value = c[0].deriv; u.uDer1.value = c[1].deriv;
    u.uUV0.value.set(frac(this.rectMin.x / c[0].L) + ht, frac(this.rectMin.y / c[0].L) + ht);
    u.uUV1.value.set(frac(this.rectMin.x / c[1].L) + ht, frac(this.rectMin.y / c[1].L) + ht);
    u.uScale.value.set(E / c[0].L, E / c[1].L);
    u.uQOrigin.value.set(wrapP(qMinX, 4096), wrapP(qMinZ, 4096));
    u.uDt.value = dt;
    u.uThreshold.value = p.threshold;
    if (p.gain !== undefined) u.uGain.value = p.gain;
    u.uSigmaH.value = Math.max(0.02, p.sigmaH);
    if (p.waveDir) u.uWaveDir.value.copy(p.waveDir);
    if (p.windDir) u.uWindDir.value.copy(p.windDir);
    this._segTravel = wrapP(this._segTravel + (p.groupSpeed ?? 0) * dt, 4096);
    u.uSegOff.value.copy(u.uWaveDir.value).multiplyScalar(this._segTravel);
    if (p.segScale) u.uSegScale.value = p.segScale;
    if (p.tau) u.uTau.value.set(p.tau.A, p.tau.B, p.tau.C, p.tau.toC);
    if (p.langmuir) u.uLangmuir.value.set(p.langmuir.converge, p.langmuir.jet, Math.max(2, p.langmuir.spacing));

    r.autoClear = false;
    u.uPrev.value = this.targets[this.current].texture;
    this.quad.material = this.updateMat;
    r.setRenderTarget(this.targets[1 - this.current]);
    r.render(this.scene, this.camera);
    this.current = 1 - this.current;
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
  }

  /** 异步统计全图平均面积比例（结果写入 stats） */
  measure() {
    if (this._statsPending) return;
    const r = this.renderer, prev = r.getRenderTarget();
    this.statsMat.uniforms.uState.value = this.texture;
    this.quad.material = this.statsMat;
    r.setRenderTarget(this.statsTarget); r.render(this.scene, this.camera);
    this._statsPending = true;
    r.readRenderTargetPixelsAsync(this.statsTarget, 0, 0, 1, 1, this._statsBuf)
      .then((b) => { Object.assign(this.stats, { active: b[0], residual: b[1], lace: b[2], coverage: b[3] }); this.stats.samples++; })
      .catch(() => {})
      .finally(() => { this._statsPending = false; });
    const gl = r.getContext(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    r.setRenderTarget(prev);
  }

  /** 异步回读浪峰图（降采样），结果写入 crests */
  readCrests() {
    if (!this.crestSize || this._crestPending) return;
    const r = this.renderer, prev = r.getRenderTarget(), M = this.crestSize;
    this.crestMat.uniforms.uState.value = this.texture;
    this.quad.material = this.crestMat;
    r.setRenderTarget(this.crestTarget); r.render(this.scene, this.camera);
    this._crestPending = true;
    const buf = this._crestBuf.find((b) => b !== this.crests?.data);
    const minX = this.rectMin.x, minZ = this.rectMin.y;
    r.readRenderTargetPixelsAsync(this.crestTarget, 0, 0, M, M, buf)
      .then(() => { this.crests = { data: buf, size: M, cell: this.extent / M, minX, minZ }; })
      .catch(() => {})
      .finally(() => { this._crestPending = false; });
    const gl = r.getContext(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    r.setRenderTarget(prev);
  }

  dispose() {
    this.targets.forEach((t) => t.dispose());
    this.statsTarget.dispose(); this.crestTarget?.dispose();
    this.updateMat.dispose(); this.statsMat.dispose(); this.crestMat?.dispose();
    this.quad.geometry.dispose();
  }
}
