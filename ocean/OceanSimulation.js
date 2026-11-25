// GPU FFT 海浪模拟（Tessendorf 方法，三级尺度）
//
// 每帧流程（全部在 GPU 上，用全屏四边形渲染到浮点纹理）：
//   1. 波谱  h0(k)：由 WindSeaModel.spectrumParams() 给出的风浪 + 涌浪参数，按
//      JONSWAP 频谱 × 方向分布（Hasselmann 1980，随波龄变化）× TMA 浅水修正 计算，
//      乘以固定种子的高斯噪声。噪声不变，所以风浪参数连续变化时海面也连续变化。
//   2. 时间演化  h(k,t) = h0(k)·e^(−iωt) + conj(h0(−k))·e^(iωt)，ω² = g·k·tanh(k·h)，
//      同时在频域求水平位移 D 与各阶导数（∂/∂x ↔ i·kx）。
//   3. 逆 FFT：Stockham 自排序基 2，先 log2N 次横向再 log2N 次纵向；三个级联
//      在纹理里上下叠放，一次就把三级都做完；两张 MRT 纹理同时变换 4 组复数场。
//   4. 组装：位移 (Dx,Dy,Dz)、雅可比 J、坡度一二阶矩（供 LEAN 式抗闪烁），
//      以及水平位移的空间导数 (λDxx, λDzz, λDxz)——白浪场（FoamField）用前两级导数之和
//      在世界坐标里判定破碎，泡沫的生命周期也在那里演化，不再随级联纹理平铺重复。
//   5. 回读：把位移降采样写入浮点纹理并异步读回，CPU 用来算浮力（与画面一致）。
//
// 坐标：级联 c 的纹理坐标 uv = x0 / L_c + 0.5/N（x0 为未位移的水平位置，x→u，z→v）。
import * as THREE from 'three';

export const G = 9.81;
/** 默认三级平铺尺寸（m）：长涌/主浪、中短波、细浪 */
export const DEFAULT_CASCADES = [2048, 160, 24];
const PI = Math.PI;
const REPEAT_T = 2048;   // 频率量化周期（s）：动画每 34 分钟循环一次，但 GPU 相位精度不随运行时间下降

// ---------------------------------------------------------------- GLSL
const VS = /* glsl */`
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */`
precision highp float;
precision highp int;
const float PI = 3.14159265358979;
const float G = 9.81;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

const SPECTRUM_FS = COMMON + /* glsl */`
uniform sampler2D uNoise;
uniform int uN;
uniform float uL[3];
uniform vec2 uBand[3];
uniform float uDepth;
uniform vec4 uWind;       // E, ωp, θ, γ
uniform vec2 uWindAge;    // U10, 波龄 cp/U
uniform vec4 uWindShape;  // σ, 尾部转折倍数, 归一化积分, 0（Donelan 1985 谱形）
uniform vec4 uSwell[4];   // E, ωp, θ, γ
uniform float uSwellS[4]; // 方向集中度 s
uniform int uSwellCount;
uniform float uSwellLift; // 远处细浪抑制（0 = 不抑制）
out vec4 outColor;

// JONSWAP 频谱形状，已归一化为 ∫S dω = 1（Goda 1988 的 γ 修正）
float jonswap(float w, float wp, float gamma) {
  float x = wp / w;
  float e = 1.25 * x * x * x * x;
  if (e > 60.0) return 0.0;
  float sigma = w <= wp ? 0.07 : 0.09;
  float d = (w - wp) / (sigma * wp);
  float r = exp(-0.5 * d * d);
  float I = 0.2 / max(0.05, 1.0 - 0.287 * log(gamma));
  return x * x * x * x / w * exp(-e) * pow(gamma, r) / I;
}
// 风浪谱形：Donelan–Hamilton–Hui (1985)，ω⁻⁴ 平衡区，tail·ωp 以上转 ω⁻⁵；除以 CPU 算好的积分归一化
float dhh(float w, float wp, float gamma) {
  float x = wp / w;
  float e = x * x * x * x;
  if (e > 60.0) return 0.0;
  float d = (w - wp) / (uWindShape.x * wp);
  float s = pow(w, -4.0) / wp * exp(-e) * pow(gamma, exp(-0.5 * d * d));
  if (w > uWindShape.y * wp) s *= uWindShape.y * wp / w;
  return s / uWindShape.z;
}
// TMA 浅水修正（Kitaigorodskii 深度函数）
float tma(float w) {
  float wh = w * sqrt(uDepth / G);
  if (wh <= 1.0) return 0.5 * wh * wh;
  if (wh < 2.0) { float t = 2.0 - wh; return 1.0 - 0.5 * t * t; }
  return 1.0;
}
// cos^2s(Δθ/2) 方向分布及其归一化（Γ(s+1)/Γ(s+½) ≈ √(s+¼)）。
// 用 cos²(Δθ/2) = (1 + cosΔθ)/2、cosΔθ = k̂·方向 计算，不用 atan：
// k 落在坐标轴上时 −k 的分量是 −0.0，有的 GPU 上 atan(−0.0, x<0) 的结果不对，
// 镜像波数的能量算错会破坏厄米对称，打包的两个实数场互相串扰（例如高度漏进 ∂Dx/∂z）
float spreading(float cosd, float s) {
  float n = sqrt(s + 0.25) / (2.0 * sqrt(PI));
  return n * pow(max(0.5 + 0.5 * cosd, 0.0), s);
}
// Hasselmann et al. (1980)：方向集中度随相对频率与波龄变化
float hasselmannS(float w, float wp, float invAge) {
  float r = w / wp;
  float s = r < 1.0 ? 6.97 * pow(r, 4.06) : 9.77 * pow(r, -2.33 - 1.45 * (invAge - 1.17));
  return clamp(s, 0.3, 80.0);
}
// 波数谱 Ψ(k)（m⁴）：Ψ = S(ω)·D(θ)·(dω/dk) / k
float psi(vec2 k, int c) {
  float kl = length(k);
  if (kl < 1e-6 || kl < uBand[c].x || kl >= uBand[c].y) return 0.0;
  float th = tanh(min(kl * uDepth, 20.0));
  float w = sqrt(G * kl * th);
  float dwdk = G * (th + kl * uDepth * (1.0 - th * th)) / (2.0 * w);
  vec2 kh = k / kl;
  float S = 0.0;
  if (uWind.x > 0.0) {
    float s = hasselmannS(w, uWind.y, 1.0 / max(uWindAge.y, 0.1));
    S += uWind.x * dhh(w, uWind.y, uWind.w) * spreading(dot(kh, vec2(cos(uWind.z), sin(uWind.z))), s);
  }
  for (int i = 0; i < 4; i++) {
    if (i >= uSwellCount) break;
    vec4 sw = uSwell[i];
    S += sw.x * jonswap(w, sw.y, sw.w) * spreading(dot(kh, vec2(cos(sw.z), sin(sw.z))), uSwellS[i]);
  }
  S *= tma(w);
  // 最细一级在接近奈奎斯特频率处平滑收尾，避免纹理混叠
  if (c == 2) S *= 1.0 - smoothstep(0.75, 1.0, kl / (PI * float(uN) / uL[c]));
  return S * dwdk / kl;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.y / uN;
  int ny = p.y - c * uN;
  // 奈奎斯特行列（k = −N/2）的镜像是自身，打包两个实数场时会串扰；物理上这里本来就几乎没有能量
  if (p.x == 0 || ny == 0) { outColor = vec4(0.0); return; }
  float dk = 2.0 * PI / uL[c];
  vec2 k = dk * vec2(float(p.x - uN / 2), float(ny - uN / 2));
  ivec2 pm = ivec2((uN - p.x) % uN, c * uN + (uN - ny) % uN);
  vec2 xi = texelFetch(uNoise, p, 0).xy;
  vec2 xim = texelFetch(uNoise, pm, 0).xy;
  // E|h0|² = Ψ·Δk²/2  （每个 k 代表一列沿 +k 传播的余弦波）
  outColor = vec4(xi * 0.5 * sqrt(psi(k, c)) * dk, xim * 0.5 * sqrt(psi(-k, c)) * dk);
}`;

const EVOLVE_FS = COMMON + /* glsl */`
uniform sampler2D uH0;
uniform int uN;
uniform float uL[3];
uniform float uDepth;
uniform float uTime;   // 已对 REPEAT_T 取模
uniform float uW0;     // 2π / REPEAT_T
layout(location = 0) out vec4 outA;   // (Dx + i·Dz), (h + i·∂Dx/∂z)
layout(location = 1) out vec4 outB;   // (∂h/∂x + i·∂h/∂z), (∂Dx/∂x + i·∂Dz/∂z)
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.y / uN;
  int ny = p.y - c * uN;
  vec2 k = 2.0 * PI / uL[c] * vec2(float(p.x - uN / 2), float(ny - uN / 2));
  float kl = length(k);
  if (kl < 1e-6) { outA = vec4(0.0); outB = vec4(0.0); return; }
  float w = sqrt(G * kl * tanh(min(kl * uDepth, 20.0)));
  w = floor(w / uW0) * uW0;                 // 色散量化：整段动画周期为 REPEAT_T
  float ph = w * uTime;
  vec2 e = vec2(cos(ph), sin(ph));
  vec4 h0 = texelFetch(uH0, p, 0);
  vec2 h = cmul(h0.xy, vec2(e.x, -e.y)) + cmul(vec2(h0.z, -h0.w), e);
  float hr = h.x, hi = h.y;
  float ux = k.x / kl, uz = k.y / kl;
  // D = i·k̂·h（浪峰处水平收缩，形成尖峰），∂/∂x ↔ i·kx
  vec2 dxdz = vec2(-ux * hi - uz * hr, ux * hr - uz * hi);
  float kxz = k.x * k.y / kl;
  vec2 hdxz = vec2(hr + kxz * hi, hi - kxz * hr);
  vec2 hxz = vec2(-k.x * hi - k.y * hr, k.x * hr - k.y * hi);
  float kxx = k.x * k.x / kl, kzz = k.y * k.y / kl;
  vec2 dxxzz = vec2(-kxx * hr + kzz * hi, -kxx * hi - kzz * hr);
  outA = vec4(dxdz, hdxz);
  outB = vec4(hxz, dxxzz);
}`;

const FFT_FS = COMMON + /* glsl */`
uniform sampler2D uInA;
uniform sampler2D uInB;
uniform int uN;
uniform int uSub;          // 子变换长度 S = 2, 4, …, N
uniform int uHorizontal;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int base = (p.y / uN) * uN;
  int idx = uHorizontal == 1 ? p.x : p.y - base;
  int hs = uSub / 2;
  int ev = (idx / uSub) * hs + (idx % hs);
  int od = ev + uN / 2;
  ivec2 pe = uHorizontal == 1 ? ivec2(ev, p.y) : ivec2(p.x, base + ev);
  ivec2 po = uHorizontal == 1 ? ivec2(od, p.y) : ivec2(p.x, base + od);
  float ang = 2.0 * PI * float(idx % uSub) / float(uSub);   // 逆变换：e^(+i…)
  vec2 tw = vec2(cos(ang), sin(ang));
  vec4 ea = texelFetch(uInA, pe, 0), oa = texelFetch(uInA, po, 0);
  vec4 eb = texelFetch(uInB, pe, 0), ob = texelFetch(uInB, po, 0);
  outA = vec4(ea.xy + cmul(tw, oa.xy), ea.zw + cmul(tw, oa.zw));
  outB = vec4(eb.xy + cmul(tw, ob.xy), eb.zw + cmul(tw, ob.zw));
}`;

const ASSEMBLE_FS = COMMON + /* glsl */`
uniform sampler2D uFftA;
uniform sampler2D uFftB;
uniform int uN;
uniform int uCascade;
uniform float uLambda;       // 水平位移系数（1 = 拉格朗日真实值）
layout(location = 0) out vec4 outDisp;    // Dx, Dy, Dz, J
layout(location = 1) out vec4 outSlope;   // sx, sz, sx², sz²
layout(location = 2) out vec4 outDeriv;   // λDxx, λDzz, λDxz, J
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  ivec2 p = ivec2(q.x, uCascade * uN + q.y);
  float sgn = ((q.x + q.y) & 1) == 1 ? -1.0 : 1.0;   // 频谱中心化带来的 (−1)^(x+z)
  vec4 A = texelFetch(uFftA, p, 0) * sgn;
  vec4 B = texelFetch(uFftB, p, 0) * sgn;
  vec3 d = clamp(uLambda * vec3(B.z, B.w, A.w), -8.0, 8.0);
  float jxx = 1.0 + d.x;
  float jzz = 1.0 + d.y;
  float J = clamp(jxx * jzz - d.z * d.z, -8.0, 8.0);
  if (isnan(J)) J = 1.0;
  // 坡度限幅：坡度 > 1 已是破碎浪；不限幅时平方可能超出半精度上限变成 Inf，
  // 远处取高级 mip 时 Inf − Inf = NaN，地平线会出现黑线
  vec2 s = clamp(vec2(B.x / max(jxx, 0.2), B.y / max(jzz, 0.2)), -8.0, 8.0);
  outDisp = vec4(uLambda * A.x, A.z, uLambda * A.y, J);
  outSlope = vec4(s, s * s);
  outDeriv = vec4(d, J);
}`;

const READBACK_FS = COMMON + /* glsl */`
uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform int uM0;            // 级联 0 回读分辨率
uniform int uM1;            // 级联 1 回读分辨率（叠在上方）
uniform int uN;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (p.y < uM0) {
    if (p.x >= uM0) { outColor = vec4(0.0); return; }
    outColor = texelFetch(uDisp0, p * (uN / uM0), 0);
  } else {
    ivec2 q = ivec2(p.x, p.y - uM0);
    if (q.x >= uM1) { outColor = vec4(0.0); return; }
    outColor = texelFetch(uDisp1, q * (uN / uM1), 0);
  }
}`;

// 统计：取纹理最高一级 mip（整块平均）——各级均方坡度
const SLOPE_STATS_FS = COMMON + /* glsl */`
uniform sampler2D uSlope0;
uniform sampler2D uSlope1;
uniform sampler2D uSlope2;
out vec4 outColor;
void main() {
  vec4 s0 = textureLod(uSlope0, vec2(0.5), 20.0), s1 = textureLod(uSlope1, vec2(0.5), 20.0), s2 = textureLod(uSlope2, vec2(0.5), 20.0);
  outColor = vec4(s0.z + s0.w, s1.z + s1.w, s2.z + s2.w, 1.0);
}`;

// ---------------------------------------------------------------- helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTarget(w, h, { count = 1, type = THREE.FloatType, mip = false, wrap = THREE.ClampToEdgeWrapping, anisotropy = 1 } = {}) {
  return new THREE.WebGLRenderTarget(w, h, {
    count, type, format: THREE.RGBAFormat,
    minFilter: mip ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter,
    magFilter: mip ? THREE.LinearFilter : THREE.NearestFilter,
    generateMipmaps: mip, depthBuffer: false, stencilBuffer: false,
    wrapS: wrap, wrapT: wrap, anisotropy,
  });
}

function rawMaterial(fragmentShader, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader, uniforms,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
}

/**
 * 三级 FFT 海浪模拟。
 *
 *   const sim = new OceanSimulation(renderer, { size: 256 });
 *   sim.update(dt, seaModel.spectrumParams());      // 每帧
 *   sim.cascades[i].displacement / .slope / .deriv  // 供海面着色器、白浪场采样
 *   sim.heightAt(x, z)                               // CPU 采样（异步回读，延迟 1–2 帧）
 */
export class OceanSimulation {
  constructor(renderer, {
    size = 256,
    cascades = DEFAULT_CASCADES,
    seed = 20261123,
    choppiness = 1.0,
    readback = [256, 128],      // 级联 0、1 的回读分辨率；null 关闭
    outputType = THREE.HalfFloatType,
  } = {}) {
    if (cascades.length !== 3) throw new Error('OceanSimulation: 需要 3 个级联');
    if ((size & (size - 1)) !== 0) throw new Error('OceanSimulation: size 必须是 2 的幂');
    this.renderer = renderer;
    this.size = size;
    this.lengths = cascades.slice();
    this.choppiness = choppiness;
    this.time = 0;
    this.frame = 0;
    const ext = renderer.extensions;
    this.supportsFloat = ext.has('EXT_color_buffer_float');
    if (!this.supportsFloat && !ext.has('EXT_color_buffer_half_float')) {
      throw new Error('OceanSimulation: 设备不支持渲染到浮点纹理（EXT_color_buffer_float / half_float）');
    }
    const fftType = this.supportsFloat ? THREE.FloatType : THREE.HalfFloatType;
    const N = size, H = size * 3;

    // 波段：每级只负责自己的波数区间，三级合起来覆盖全部波长且不重复
    const kb1 = 2 * PI / cascades[1] * 6, kb2 = 2 * PI / cascades[2] * 6;
    this.bands = [new THREE.Vector2(1e-4, kb1), new THREE.Vector2(kb1, kb2), new THREE.Vector2(kb2, 1e9)];

    // 固定种子的复高斯噪声
    const rand = mulberry32(seed);
    const noise = new Float32Array(N * H * 4);
    for (let i = 0; i < N * H; i++) {
      const u1 = Math.max(1e-12, rand()), u2 = rand();
      const r = Math.sqrt(-2 * Math.log(u1));
      noise[i * 4] = r * Math.cos(2 * PI * u2);
      noise[i * 4 + 1] = r * Math.sin(2 * PI * u2);
    }
    this.noiseTexture = new THREE.DataTexture(noise, N, H, THREE.RGBAFormat, THREE.FloatType);
    this.noiseTexture.needsUpdate = true;

    this.spectrumTarget = makeTarget(N, H, { type: fftType });
    this.fftTargets = [makeTarget(N, H, { count: 2, type: fftType }), makeTarget(N, H, { count: 2, type: fftType })];

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.cascades = cascades.map((L, i) => {
      const target = makeTarget(N, N, { count: 3, type: outputType, mip: true, wrap: THREE.RepeatWrapping, anisotropy: Math.min(8, maxAniso) });
      return { index: i, L, band: this.bands[i], target,
        displacement: target.textures[0], slope: target.textures[1], deriv: target.textures[2] };
    });

    // 全屏四边形
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);

    const Ls = this.lengths;
    this.spectrumMat = rawMaterial(SPECTRUM_FS, {
      uNoise: { value: this.noiseTexture }, uN: { value: N }, uL: { value: Ls }, uBand: { value: this.bands },
      uDepth: { value: 2000 }, uWind: { value: new THREE.Vector4() }, uWindAge: { value: new THREE.Vector2(8, 1) },
      uWindShape: { value: new THREE.Vector4(0.08, 3, 1, 0) },
      uSwell: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 1, 0, 1)) }, uSwellS: { value: [10, 10, 10, 10] },
      uSwellCount: { value: 0 }, uSwellLift: { value: 0 },
    });
    this.evolveMat = rawMaterial(EVOLVE_FS, {
      uH0: { value: this.spectrumTarget.texture }, uN: { value: N }, uL: { value: Ls }, uDepth: { value: 2000 },
      uTime: { value: 0 }, uW0: { value: 2 * PI / REPEAT_T },
    });
    this.fftMat = rawMaterial(FFT_FS, {
      uInA: { value: null }, uInB: { value: null }, uN: { value: N }, uSub: { value: 2 }, uHorizontal: { value: 1 },
    });
    this.assembleMat = rawMaterial(ASSEMBLE_FS, {
      uFftA: { value: null }, uFftB: { value: null }, uN: { value: N }, uCascade: { value: 0 }, uLambda: { value: choppiness },
    });

    // 回读
    this.readbackSizes = readback ? readback.slice() : null;
    if (readback) {
      const [m0, m1] = readback;
      this.readbackTarget = makeTarget(Math.max(m0, m1), m0 + m1, { type: THREE.FloatType });
      this.readbackMat = rawMaterial(READBACK_FS, {
        uDisp0: { value: null }, uDisp1: { value: null }, uM0: { value: m0 }, uM1: { value: m1 }, uN: { value: N },
      });
      const n = Math.max(m0, m1) * (m0 + m1) * 4;
      // 三个缓冲轮换：正在读、最近一次、上一次（两次回读之差 / 时间差 = 水质点速度）
      this._rbBuffers = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      this._rbReady = null;       // 最近一次完成的回读
      this._rbPrev = null;        // 上一次
      this._rbPending = false;
      this._rbTime = 0;
      this._rbPrevTime = 0;
      this._rbGen = 0;
    }
    this.cascadeWeights = [1, 1, 1];   // CPU 采样时与着色器一致的级联权重
    this.measured = { Hs: 0, samples: 0, mss: 0, mssCascades: null, statsSamples: 0 };
    this.statsTarget = makeTarget(1, 1, { type: THREE.FloatType });
    this.statsMat = rawMaterial(SLOPE_STATS_FS, { uSlope0: { value: null }, uSlope1: { value: null }, uSlope2: { value: null } });
    this._statsBuf = new Float32Array(4);
    this._statsPending = false;
  }

  /** 异步测量各级均方坡度（写入 measured.mssCascades / mss），供粗糙度补足 Cox–Munk 与白浪阈值初值 */
  measureSlopes() {
    if (this._statsPending || !this.supportsFloat) return;
    const r = this.renderer, prev = r.getRenderTarget();
    const su = this.statsMat.uniforms;
    su.uSlope0.value = this.cascades[0].slope;
    su.uSlope1.value = this.cascades[1].slope;
    su.uSlope2.value = this.cascades[2].slope;
    this._pass(this.statsMat, this.statsTarget);
    this._statsPending = true;
    r.readRenderTargetPixelsAsync(this.statsTarget, 0, 0, 1, 1, this._statsBuf)
      .then((b) => {
        this.measured.mssCascades = [b[0], b[1], b[2]];
        this.measured.mss = b[0] + b[1] + b[2];          // 已解析波段的均方坡度
        this.measured.statsSamples++;
      })
      .catch(() => {})
      .finally(() => { this._statsPending = false; });
    const gl = r.getContext();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    r.setRenderTarget(prev);
  }

  /** 设置波谱参数（来自 WindSeaModel.spectrumParams()） */
  setSpectrum(p) {
    const u = this.spectrumMat.uniforms;
    u.uDepth.value = p.depth;
    this.evolveMat.uniforms.uDepth.value = p.depth;
    const w = p.windSea;
    u.uWind.value.set(w.E, w.omegaP, w.theta, w.gamma);
    u.uWindAge.value.set(w.U10, w.age);
    u.uWindShape.value.set(w.sigma ?? 0.08, w.tail ?? 3, w.norm ?? 1, 0);
    const n = Math.min(4, p.swells.length);
    for (let i = 0; i < 4; i++) {
      const s = p.swells[i];
      if (i < n) { u.uSwell.value[i].set(s.E, s.omegaP, s.theta, s.gamma); u.uSwellS.value[i] = s.s; }
      else { u.uSwell.value[i].set(0, 1, 0, 1); u.uSwellS.value[i] = 10; }
    }
    u.uSwellCount.value = n;
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  /** 推进 dt 秒；params 为 spectrumParams()（可省略，沿用上次） */
  update(dt, params) {
    const r = this.renderer;
    if (params) this.setSpectrum(params);
    this.time += dt;
    this.frame++;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevXr = r.xr.enabled;
    r.autoClear = false;
    r.xr.enabled = false;

    // 1–2. 波谱与时间演化
    this._pass(this.spectrumMat, this.spectrumTarget);
    this.evolveMat.uniforms.uTime.value = this.time % REPEAT_T;
    this._pass(this.evolveMat, this.fftTargets[0]);

    // 3. 逆 FFT（横向 log2N 次 + 纵向 log2N 次）
    let src = 0;
    const fu = this.fftMat.uniforms;
    for (const horizontal of [1, 0]) {
      fu.uHorizontal.value = horizontal;
      for (let sub = 2; sub <= this.size; sub *= 2) {
        fu.uSub.value = sub;
        fu.uInA.value = this.fftTargets[src].textures[0];
        fu.uInB.value = this.fftTargets[src].textures[1];
        this._pass(this.fftMat, this.fftTargets[1 - src]);
        src = 1 - src;
      }
    }

    // 4. 组装三级输出
    const au = this.assembleMat.uniforms;
    au.uFftA.value = this.fftTargets[src].textures[0];
    au.uFftB.value = this.fftTargets[src].textures[1];
    au.uLambda.value = this.choppiness;
    for (const c of this.cascades) {
      au.uCascade.value = c.index;
      this._pass(this.assembleMat, c.target);
    }

    // 5. 回读（上一次完成后才发起下一次）
    if (this.readbackTarget && !this._rbPending) {
      const ru = this.readbackMat.uniforms;
      ru.uDisp0.value = this.cascades[0].displacement;
      ru.uDisp1.value = this.cascades[1].displacement;
      this._pass(this.readbackMat, this.readbackTarget);
      this._rbPending = true;
      const buf = this._rbBuffers.find((b) => b !== this._rbReady && b !== this._rbPrev);
      const t = this.time, gen = this._rbGen;
      r.readRenderTargetPixelsAsync(this.readbackTarget, 0, 0, this.readbackTarget.width, this.readbackTarget.height, buf)
        .then(() => {
          if (gen !== this._rbGen) return;       // 发起之后海况被重置过：这份数据作废
          this._rbPrev = this._rbReady; this._rbPrevTime = this._rbTime;
          this._rbReady = buf; this._rbTime = t;
          this._measure();
        })
        .catch(() => {})
        .finally(() => { this._rbPending = false; });
      // three r170 发起异步读取后没有解绑 PIXEL_PACK_BUFFER，之后任何同步 readPixels 都会失败
      const gl = r.getContext();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.xr.enabled = prevXr;
  }

  // 由回读数据估算模拟出的有效波高（级联 0+1，各自方差相加）
  _measure() {
    const d = this._rbReady, [m0, m1] = this.readbackSizes, W = this.readbackTarget.width;
    let v = 0;
    for (const [y0, m] of [[0, m0], [m0, m1]]) {
      let s = 0, s2 = 0;
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) { const h = d[((y0 + y) * W + x) * 4 + 1]; s += h; s2 += h * h; }
      const n = m * m, mean = s / n;
      v += s2 / n - mean * mean;
    }
    this.measured.Hs = 4 * Math.sqrt(Math.max(0, v));
    this.measured.samples++;
  }

  /** 回读数据是否可用 */
  get ready() { return !!this._rbReady; }

  /** CPU 采样：未位移水平位置 x0 处的位移（级联 0、1 之和），写入 out = {x, y, z} */
  displacementAt(x0, z0, out = { x: 0, y: 0, z: 0 }, d = this._rbReady) {
    out.x = 0; out.y = 0; out.z = 0;
    if (!d) return out;
    const [m0, m1] = this.readbackSizes, W = this.readbackTarget.width;
    const layers = [[0, m0, this.lengths[0], this.cascadeWeights[0]], [m0, m1, this.lengths[1], this.cascadeWeights[1]]];
    for (const [y0, m, L, wgt] of layers) {
      if (wgt <= 0) continue;
      let fx = (x0 / L) * m, fz = (z0 / L) * m;
      fx -= Math.floor(fx / m) * m; fz -= Math.floor(fz / m) * m;
      const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
      const ix1 = (ix + 1) % m, iz1 = (iz + 1) % m;
      const i00 = ((y0 + iz) * W + ix) * 4, i10 = ((y0 + iz) * W + ix1) * 4;
      const i01 = ((y0 + iz1) * W + ix) * 4, i11 = ((y0 + iz1) * W + ix1) * 4;
      for (let k = 0; k < 3; k++) {
        const v = (d[i00 + k] * (1 - tx) + d[i10 + k] * tx) * (1 - tz) + (d[i01 + k] * (1 - tx) + d[i11 + k] * tx) * tz;
        if (k === 0) out.x += v * wgt; else if (k === 1) out.y += v * wgt; else out.z += v * wgt;
      }
    }
    return out;
  }

  /** 世界坐标 (x, z) 处的水面点对应的未位移参考位置 x0（反解水平位移，4 次不动点迭代） */
  referenceAt(x, z, out = { x: 0, z: 0 }) {
    const o = this._tmp || (this._tmp = { x: 0, y: 0, z: 0 });
    let x0 = x, z0 = z;
    for (let i = 0; i < 4; i++) {
      this.displacementAt(x0, z0, o);
      x0 = x - o.x; z0 = z - o.z;
    }
    out.x = x0; out.z = z0;
    return out;
  }

  /** CPU 采样：世界坐标 (x, z) 处的水面高度 */
  heightAt(x, z) {
    const r = this.referenceAt(x, z, this._ref || (this._ref = { x: 0, z: 0 }));
    return this.displacementAt(r.x, r.z, this._tmp).y;
  }

  /**
   * CPU 采样：参考位置 x0 处水质点的速度（m/s）= 位移对时间的导数。
   * 位移按拉格朗日参考点存储，所以两次回读之差就是质点的轨道速度（不含最细一级）。
   */
  /**
   * 海况突变（切镜头、从零起浪、直接充分发展）后调用：丢掉旧的回读。
   * 否则新旧两个海面的位移之差会被当成水质点速度（几十 m/s），把船打转。
   */
  invalidateReadback() {
    this._rbGen = (this._rbGen || 0) + 1;
    this._rbReady = null; this._rbPrev = null;
    this._rbTime = 0; this._rbPrevTime = 0;
  }

  velocityAt(x0, z0, out = { x: 0, y: 0, z: 0 }) {
    out.x = 0; out.y = 0; out.z = 0;
    const dt = this._rbTime - this._rbPrevTime;
    // 两份回读相隔太久（卡顿、后台标签页）时差分不再代表瞬时速度
    if (!this._rbPrev || !(dt > 1e-4) || dt > 0.5) return out;
    const a = this.displacementAt(x0, z0, this._va || (this._va = { x: 0, y: 0, z: 0 }), this._rbReady);
    const b = this.displacementAt(x0, z0, this._vb || (this._vb = { x: 0, y: 0, z: 0 }), this._rbPrev);
    out.x = (a.x - b.x) / dt; out.y = (a.y - b.y) / dt; out.z = (a.z - b.z) / dt;
    return out;
  }

  /** 调试/测试：直接上传 h0（Float32Array，N×3N×4：h0(k).re, im, h0(−k).re, im） */
  debugSetH0(data) {
    const t = new THREE.DataTexture(data, this.size, this.size * 3, THREE.RGBAFormat, THREE.FloatType);
    t.needsUpdate = true;
    this.evolveMat.uniforms.uH0.value = t;
    this._debugH0 = t;
    this.spectrumMat.uniforms.uWind.value.x = 0;
  }

  dispose() {
    for (const t of [this.spectrumTarget, ...this.fftTargets, this.readbackTarget, this.statsTarget]) t?.dispose();
    for (const c of this.cascades) c.target.dispose();
    for (const m of [this.spectrumMat, this.evolveMat, this.fftMat, this.assembleMat, this.readbackMat, this.statsMat]) m?.dispose();
    this.noiseTexture.dispose();
    this._debugH0?.dispose();
    this.quad.geometry.dispose();
  }
}
