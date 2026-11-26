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
// 第四个通道 F：残留泡沫里“新鲜”的部分，与 B 同源（都来自 A 的衰减），但按 τB/2 衰减，所以 F/B = e^(−年龄/τB)。
//   F/B 是两个面积比例之比，在 mip 平均、远处取样时都不变 —— 着色器据此按年龄改变残留泡沫的亮度和透明度，
//   不会因为离得远（mip 把小斑块平均成低比例）而把新鲜泡沫当成老泡沫画暗。
// 照片法覆盖率 f = min(1, A + B)（Monahan 定义，含 A、B，不含很薄的 C）在统计时逐纹素算。
//
// 破碎判据：波长 > 约 4 m 的两级合成的总雅可比 J = (1+Dxx)(1+Dzz) − Dxz² 低于阈值，
// 即局部水平压缩（≈ 线性化的浪峰陡度）超过临界值；只在浪峰之上、偏浪前坡，强度沿浪峰分段变化
// （分段噪声随主浪群速度移动：破碎集中在波群能量最大处）。
// 临界 J 是与风速无关的物理常数（Ocean.params.breakingThreshold）；破碎发生在哪里、持续多久、留下什么，都由这里的过程决定。
// 有水深图时另加浅水破碎：Battjes & Janssen (1978) 的破碎比例 Qb = exp(−(γh / Hrms)²)，γ ≈ 0.78。
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
uniform float uUseBathy;      // 有水深图时：浅水按水深限制破碎（Battjes & Janssen 1978）
uniform sampler2D uBathy;     // R = 地面高度（m，水下为负）
uniform vec4 uBathyRect;      // minX, minZ, sizeX, sizeZ（世界坐标）
uniform vec2 uRectMin;        // 本图左下角的参考坐标 x0（m）
uniform vec2 uSurf;           // 深水 Hrms（m）、破碎指标 γ = Hmax / h
uniform vec4 uSrc[16];        // 外部泡沫源（世界坐标）：x, z, 半径, 活跃白浪面积比例（船首浪破碎、尾流等）
uniform int uSrcCount;
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
  float A = prev.x, B = prev.y, F = prev.w;

  // 生命周期（指数衰减按 dt 精确积分）：活跃 → 残留 → 老化泡沫丝
  float kA = exp(-uDt / uTau.x), kB = exp(-uDt / uTau.y), kC = exp(-uDt / uTau.z);
  float dA = A * (1.0 - kA), dB = B * (1.0 - kB);
  A *= kA;
  B = B * kB + dA;
  F = F * kB * kB + dA;                                    // 新鲜度示踪：τB/2 衰减
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

  // 浅水破碎（Battjes & Janssen 1978；Thornton & Guza 1983）：水深 h 处最大浪高 Hmax = γh，
  // 瑞利分布的浪高超过它的比例 Qb = exp(−(γh / Hrms)²)。破碎发生在入射浪的浪峰前坡上，
  // 所以碎浪随浪峰一排排推向岸边，留下的残留泡沫照常衰减 —— 不再是装饰性的岸线条带
  vec2 xw = uRectMin + vUv * uExtent + texture(uDisp0, uv0).xz + texture(uDisp1, uv1).xz;     // 这块水此刻的世界位置
  for (int i = 0; i < 16; i++) {
    if (i >= uSrcCount) break;
    vec4 sc = uSrc[i];
    brk = max(brk, sc.w * (1.0 - smoothstep(0.55 * sc.z, sc.z, distance(xw, sc.xy))));
  }
  if (uUseBathy > 0.5) {
    float depth = -texture(uBathy, (xw - uBathyRect.xy) / uBathyRect.zw).r;
    if (depth > 0.0) {
      float r = uSurf.y * depth / max(uSurf.x, 0.02);
      float Qb = exp(-r * r);
      float surfCrest = smoothstep(0.0, 0.8, h / uSigmaH);
      brk = max(brk, clamp(Qb * 1.6, 0.0, 1.0) * surfCrest * face);
    } else {
      brk = 0.0; A = 0.0; B *= 0.5; F *= 0.5;     // 陆地上没有水
    }
  }
  A = max(A, brk);
  B = min(B, 1.0 - A * 0.5);     // 活跃白浪盖在残留泡沫之上
  C = clamp(C, 0.0, 1.0);

  F = min(F, B);
  outState = vec4(A, B, C, F);
}`;

// 照片法覆盖率 min(1, A + B) 要逐纹素算（先平均再取 min 会多算活跃白浪与残留泡沫重叠的部分）：
// 每个输出格精确累加 8×8 个纹素，之后的 mip 平均才是线性的
const COVER_FS = /* glsl */`
precision highp float;
uniform sampler2D uState;
out vec4 outColor;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 8;
  float s = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) { vec4 v = texelFetch(uState, b + ivec2(i, j), 0); s += min(1.0, v.x + v.y); }
  outColor = vec4(s / 64.0, 0.0, 0.0, 1.0);
}`;

// 统计：最高一级 mip = 全图平均。第 1 个像素 = 各通道的平均面积比例（A、B、C、F），第 2 个 = 照片法覆盖率
const STATS_FS = /* glsl */`
precision highp float;
uniform sampler2D uState;
uniform sampler2D uCover;
out vec4 outColor;
void main() { outColor = gl_FragCoord.x < 1.0 ? textureLod(uState, vec2(0.5), 20.0) : vec4(textureLod(uCover, vec2(0.5), 20.0).r, 0.0, 0.0, 0.0); }`;

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
      uUseBathy: { value: 0 }, uBathy: { value: null }, uBathyRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uRectMin: { value: new THREE.Vector2() }, uSurf: { value: new THREE.Vector2(0.5, 0.78) },
      uSrc: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) }, uSrcCount: { value: 0 },
    });
    this._sources = [];
    this.coverMat = raw(COVER_FS, { uState: { value: null } });
    this.coverTarget = new THREE.WebGLRenderTarget(size / 8, size / 8, { type: opts.type, format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: false });
    this.statsMat = raw(STATS_FS, { uState: { value: null }, uCover: { value: this.coverTarget.texture } });
    this.statsTarget = new THREE.WebGLRenderTarget(2, 1, { type: THREE.FloatType, depthBuffer: false });
    this._statsBuf = new Float32Array(8);
    this._statsPending = false;
    /** 全图平均面积比例：active = A，residual = B，lace = C，coverage = 照片法白浪覆盖率 f = min(1, A + B)，fresh = 新鲜度示踪 F */
    this.stats = { active: 0, residual: 0, lace: 0, coverage: 0, fresh: 0, samples: 0 };

    this.crestSize = crests;
    if (crests) {
      this.crestMat = raw(CRESTS_FS, { uState: { value: null }, uLod: { value: Math.log2(size / crests) }, uM: { value: crests } });
      this.crestTarget = new THREE.WebGLRenderTarget(crests, crests, { type: THREE.FloatType, depthBuffer: false });
      this._crestBuf = [new Float32Array(crests * crests * 4), new Float32Array(crests * crests * 4)];
      this._crestPending = false;
      /** 最近一次浪峰回读：data（RGBA = 各格 A、B、C、F），左下角参考坐标 minX/minZ，格宽 cell（m） */
      this.crests = null;
    }
  }

  get texture() { return this.targets[this.current].texture; }

  /** 海面着色器采样用：uv = x0 / extent + offset（originX/Z 为网格原点，CPU 双精度） */
  uvOffsetFor(originX, originZ, out = new THREE.Vector2()) {
    return out.set((originX - this.rectMin.x) / this.extent, (originZ - this.rectMin.y) / this.extent);
  }

  /** 水深图（与 Ocean.setBathymetry 相同的约定）：开启浅水按水深限制的破碎；texture = null 关闭 */
  setBathymetry(texture, rect) {
    const u = this.updateMat.uniforms;
    u.uUseBathy.value = texture ? 1 : 0;
    if (texture) { u.uBathy.value = texture; u.uBathyRect.value.copy(rect); }
  }

  /**
   * 本帧的外部泡沫源（世界坐标 x, z，半径 m，活跃白浪面积比例 0–1），例如船首浪破碎、螺旋桨尾流。
   * 注入后与白浪一样按 τA → τB 衰减、随水漂流。每帧最多 16 个，update 之后清空。
   */
  addSource(x, z, radius, amount) {
    if (this._sources.length < 16 && amount > 0) this._sources.push([x, z, radius, Math.min(1, amount)]);
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
    u.uRectMin.value.copy(this.rectMin);
    u.uSrcCount.value = this._sources.length;
    this._sources.forEach((sc, i) => u.uSrc.value[i].set(sc[0], sc[1], sc[2], sc[3]));
    this._sources.length = 0;
    if (p.hrms !== undefined) u.uSurf.value.x = p.hrms;

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
    this.coverMat.uniforms.uState.value = this.texture;
    this.quad.material = this.coverMat;
    r.setRenderTarget(this.coverTarget); r.render(this.scene, this.camera);
    this.statsMat.uniforms.uState.value = this.texture;
    this.quad.material = this.statsMat;
    r.setRenderTarget(this.statsTarget); r.render(this.scene, this.camera);
    this._statsPending = true;
    r.readRenderTargetPixelsAsync(this.statsTarget, 0, 0, 2, 1, this._statsBuf)
      .then((b) => { Object.assign(this.stats, { active: b[0], residual: b[1], lace: b[2], fresh: b[3], coverage: b[4] }); this.stats.samples++; })
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
    this.statsTarget.dispose(); this.coverTarget.dispose(); this.crestTarget?.dispose();
    this.updateMat.dispose(); this.statsMat.dispose(); this.coverMat.dispose(); this.crestMat?.dispose();
    this.quad.geometry.dispose();
  }
}
