// 海面着色器
//
// 顶点：按距离选 mip 采样三级位移（远处网格稀，用平均后的位移避免混叠），细级随距离淡出。
// 片元（顺序）：
//   1. 法线：三级坡度相加；阵风场（随风平移的噪声）只调制最细一级和毛细波（猫爪风）。
//   2. 粗糙度：LEAN —— 每级坡度的 mip 二阶矩减一阶矩平方得到亚像素坡度方差，
//      加上未解析的微尺度方差，换算成 GGX α。远处小浪不闪，太阳倒影自然展开成光带。
//   3. 反射：精确水体 Fresnel（n = 1.333）+ Karis 环境 BRDF 近似（粗糙表面在掠射角
//      反射率下降，远处海面不会成一面白镜子）；天空立方体按粗糙度取 mip；可叠平面反射。
//   4. 太阳高光：GGX + Smith 相关可见度，α 下限取太阳视半径，HDR 限幅防半精度溢出。
//   5. 水体：Atlas（GDC 2019）散射模型 —— 浪尖背光透射 k1、视线散射 k2、受光面 k3、环境光，
//      再加泡沫附近的气泡亮色。
//   6. 泡沫：模拟给出的活跃白浪 + 残留泡沫 + 尾迹 + 岸线泡沫，乘随风漂移的气泡纹理。
//   7. 大气透视：雾色取天空立方体在视线方位的地平线颜色（海天无缝）+ 朝太阳方向的米氏散射。
// 输出线性 HDR；直接渲染到屏幕时由 tonemapping/colorspace 块处理，接后期时交给 OutputPass。
import * as THREE from 'three';
import { makeFoamTexture, makeRippleTexture } from './textures.js';

const VERT = /* glsl */`
uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform sampler2D uDisp2;
uniform vec3 uInvL;
uniform vec3 uTexelSize;
uniform vec2 uOriginUV0;
uniform vec2 uOriginUV1;
uniform vec2 uOriginUV2;
uniform vec2 uOrigin;
uniform vec2 uCamLocal;
uniform float uGridScale;
uniform float uGridInner;
uniform float uGridGrowth;
uniform vec4 uDispFade;
uniform vec3 uCascadeWeight;
uniform float uUseBathy;
uniform sampler2D uBathy;
uniform vec4 uBathyRect;
// centroid：MSAA 下像素中心可能落在地平线处细长三角形之外，普通插值会外推出离谱的值（黑线）
centroid varying vec2 vLocal;
centroid varying vec3 vWorld;
centroid varying float vHeight;
centroid varying float vDist;
void main() {
  vec2 local = position.xz * uGridScale;
  float dist = length(local - uCamLocal);
  float spacing = max(uGridInner * uGridScale, dist * uGridGrowth);
  float w1 = 1.0 - smoothstep(uDispFade.x, uDispFade.y, dist);
  float w2 = 1.0 - smoothstep(uDispFade.z, uDispFade.w, dist);
  vec3 d = textureLod(uDisp0, local * uInvL.x + uOriginUV0, max(0.0, log2(spacing / uTexelSize.x))).xyz * uCascadeWeight.x;
  if (w1 > 0.0) d += textureLod(uDisp1, local * uInvL.y + uOriginUV1, max(0.0, log2(spacing / uTexelSize.y))).xyz * (w1 * uCascadeWeight.y);
  if (w2 > 0.0) d += textureLod(uDisp2, local * uInvL.z + uOriginUV2, max(0.0, log2(spacing / uTexelSize.z))).xyz * (w2 * uCascadeWeight.z);
  if (uUseBathy > 0.5) {
    // 浅水消波：水深小于约 1/4 浪高处振幅线性减小，岸上为 0
    vec2 wxz = uOrigin + local;
    float ground = texture2D(uBathy, (wxz - uBathyRect.xy) / uBathyRect.zw).r;
    d *= smoothstep(0.0, 4.0, -ground);
  }
  vec3 world = vec3(uOrigin.x + local.x + d.x, d.y, uOrigin.y + local.y + d.z);
  vLocal = local;
  vWorld = world;
  vHeight = d.y;
  vDist = dist;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const FRAG = /* glsl */`
#include <common>
uniform sampler2D uSlope0;
uniform sampler2D uSlope1;
uniform sampler2D uSlope2;
uniform sampler2D uFoam0;
uniform sampler2D uFoam1;
uniform sampler2D uFoam2;
uniform float uFoamW2;          // 最细一级计入白浪的权重（年轻风浪）
uniform vec3 uInvL;
uniform vec2 uOriginUV0;
uniform vec2 uOriginUV1;
uniform vec2 uOriginUV2;
uniform vec2 uNoiseOrigin;      // 网格原点对噪声周期取模（CPU 双精度算好）
uniform vec3 uCascadeWeight;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform samplerCube uEnvMap;
uniform float uEnvMaxMip;
uniform float uEnvIntensity;
uniform float uSunRadius;
uniform float uSpecClamp;

uniform vec3 uDeepColor;
uniform vec3 uSSSColor;
uniform vec4 uSSS;              // 浪尖透射 k1、视线散射 k2、受光面 k3、环境
uniform float uBubbles;
uniform float uWaveScale;       // 浪高归一化尺度（约 0.5·Hs）

uniform vec3 uFoamColor;
uniform vec4 uFoamParams;       // 总量、活跃权重、残留权重、纹理尺度（m）
uniform sampler2D uFoamTex;
uniform vec4 uFoamOff;          // 两层泡沫纹理的 UV 偏移（含风生漂流；CPU 双精度取小数）
uniform vec4 uRippleOff;        // 两层毛细波纹理的 UV 偏移（风坐标系，含随风滚动）
uniform vec2 uStreakOff;        // 风向条纹的 UV 偏移（风坐标系）
uniform float uStreaks;         // 条纹强度（随风速，蒲福 7 级起出现）

uniform vec2 uWindDir;
uniform float uRipple;          // 毛细波坡度强度
uniform float uMicroVar;        // 未解析的微尺度坡度方差
uniform float uGustiness;
uniform vec2 uGustOffset;       // 阵风场随风平移的累计位移（m）
uniform sampler2D uRippleTex;
uniform float uTime;

uniform float uFogDensity;
uniform float uMie;
uniform float uMieG;

uniform sampler2D uReflection;
uniform mat4 uReflectionMatrix;
uniform float uReflectionStrength;

uniform float uUseBathy;
uniform sampler2D uBathy;
uniform vec4 uBathyRect;
uniform vec3 uSand;
uniform vec3 uAbsorb;

uniform float uUseWake;
uniform sampler2D uWake;
uniform vec4 uWakeRect;

uniform float uBiolum;
uniform vec3 uBiolumColor;
uniform int uDebug;

centroid varying vec2 vLocal;
centroid varying vec3 vWorld;
centroid varying float vHeight;
centroid varying float vDist;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float fbm3(vec2 p) { return vnoise(p) * 0.55 + vnoise(p * 2.13 + 7.1) * 0.3 + vnoise(p * 4.37 - 3.3) * 0.15; }

// 精确的非偏振 Fresnel（空气 → 水，n = 1.333）
float fresnelWater(float c) {
  float g2 = 1.333 * 1.333 - 1.0 + c * c;
  float g = sqrt(g2);
  float A = (g - c) / (g + c);
  float B = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
  return clamp(0.5 * A * A * (1.0 + B * B), 0.0, 1.0);
}
// Karis 移动端环境 BRDF 近似：返回 F0 的缩放与偏置
vec2 envBRDF(float pr, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = pr * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}
float visSmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

void main() {
  vec2 uv0 = vLocal * uInvL.x + uOriginUV0;
  vec2 uv1 = vLocal * uInvL.y + uOriginUV1;
  vec2 uv2 = vLocal * uInvL.z + uOriginUV2;
  vec2 np = vLocal + uNoiseOrigin;
  vec4 s0 = texture2D(uSlope0, uv0) * uCascadeWeight.x;
  vec4 s1 = texture2D(uSlope1, uv1) * uCascadeWeight.y;
  vec4 s2 = texture2D(uSlope2, uv2) * uCascadeWeight.z;

  // 阵风（猫爪风）：随风平移的噪声，只改变短波
  float gust = 1.0;
  if (uGustiness > 0.0) {
    float n = fbm3((np - uGustOffset) / 85.0);
    gust = mix(1.0, mix(0.3, 1.75, smoothstep(0.28, 0.72, n)), uGustiness);
  }

  vec2 slope = s0.xy + s1.xy + s2.xy * gust;
  vec2 var = max(s0.zw - s0.xy * s0.xy, 0.0) + max(s1.zw - s1.xy * s1.xy, 0.0) + max(s2.zw - s2.xy * s2.xy, 0.0) * gust * gust;

  // 毛细波：沿风向的可平铺坡度纹理，随距离由 mip 自然平均掉，损失的坡度方差另计
  mat2 rot = mat2(uWindDir.x, uWindDir.y, -uWindDir.y, uWindDir.x);          // 风坐标 → 世界
  vec2 lp = vec2(dot(vLocal, uWindDir), dot(vLocal, vec2(-uWindDir.y, uWindDir.x)));
  vec2 r1 = texture2D(uRippleTex, lp / 1.7 + uRippleOff.xy).xy * 2.0 - 1.0;
  vec2 r2 = texture2D(uRippleTex, lp / 0.53 + uRippleOff.zw).xy * 2.0 - 1.0;
  float near = 1.0 - smoothstep(25.0, 160.0, vDist);
  slope += rot * (r1 * 0.6 + r2 * 0.4) * (uRipple * gust * near);
  // 未解析坡度方差：近处约六成由上面的毛细波法线真实画出（细碎闪光），其余与远处一样计入粗糙度
  var += vec2(uMicroVar * gust * gust * mix(1.0, 0.4, near));

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  float alpha = clamp(sqrt(min(var.x + var.y, 4.0)), 0.008, 0.85);
  if (isnan(alpha) || any(isnan(N))) { N = vec3(0.0, 1.0, 0.0); alpha = 0.3; }
  vec3 V = normalize(cameraPosition - vWorld);
  float NoV = clamp(dot(N, V), 1e-3, 1.0);
  vec3 L = normalize(uSunDir);

  // ---- 泡沫覆盖
  vec4 f0 = texture2D(uFoam0, uv0);
  vec4 f1 = texture2D(uFoam1, uv1);
  // 主浪（级联 0）浪峰的大片白浪被次级短波的挤压程度打散：破碎发生在长浪峰上短波也最陡的地方
  float c1 = clamp((1.0 - f1.z) * 3.0, 0.0, 1.0);
  vec4 f2 = uFoamW2 > 0.0 ? texture2D(uFoam2, uv2) : vec4(0.0);
  float act = clamp(f0.x * (0.3 + 1.4 * c1) + f1.x + f2.x * uFoamW2, 0.0, 1.0);
  float res = clamp(max(max(f0.y * (0.45 + c1), f1.y), f2.y * uFoamW2), 0.0, 1.0);
  // 大风（8 级以上）泡沫沿风向成条：在风坐标系里拉长的泡沫斑，随风生漂流移动
  // 细丝（Worley 边缘）沿风向拉长 ~20 倍，再乘一层世界空间低频噪声，使条纹成片出现、不显重复
  float streak = 0.0;
  if (uStreaks > 0.0) {
    vec2 wl = lp + vec2(0.0, (fbm3(lp / 45.0) - 0.5) * 7.0);                  // 轻微扭曲，条纹略带弯曲
    float fil = texture2D(uFoamTex, wl / vec2(110.0, 2.4) + uStreakOff).r;
    float patchy = smoothstep(0.42, 0.8, fbm3((np - uGustOffset * 0.05) / 90.0));
    streak = smoothstep(0.82, 0.985, fil) * patchy * uStreaks * 0.75;
  }
  res = max(res, streak * 0.85);
  float wakeFoam = 0.0;
  vec2 wakeGrad = vec2(0.0);
  if (uUseWake > 0.5) {
    vec2 wuv = (vWorld.xz - uWakeRect.xy) / uWakeRect.zw;
    if (all(greaterThan(wuv, vec2(0.0))) && all(lessThan(wuv, vec2(1.0)))) {
      vec4 wk = texture2D(uWake, wuv);
      float edge = smoothstep(0.0, 0.08, min(min(wuv.x, wuv.y), min(1.0 - wuv.x, 1.0 - wuv.y)));
      wakeFoam = clamp(wk.r, 0.0, 1.0) * edge;
      vec2 px = 1.0 / vec2(textureSize(uWake, 0));
      wakeGrad = vec2(texture2D(uWake, wuv + vec2(px.x, 0.0)).g - texture2D(uWake, wuv - vec2(px.x, 0.0)).g,
                      texture2D(uWake, wuv + vec2(0.0, px.y)).g - texture2D(uWake, wuv - vec2(0.0, px.y)).g) * edge;
      N = normalize(N - vec3(wakeGrad.x, 0.0, wakeGrad.y) * 2.5);
      NoV = clamp(dot(N, V), 1e-3, 1.0);
    }
  }
  float shoreFoam = 0.0, waterDepth = 1e4;
  if (uUseBathy > 0.5) {
    float ground = texture2D(uBathy, (vWorld.xz - uBathyRect.xy) / uBathyRect.zw).r;
    waterDepth = max(0.0, vWorld.y - ground);
    float band = 0.5 + 0.5 * sin(waterDepth * 4.0 - uTime * 1.3 + fbm3(np * 0.15) * 6.0);
    shoreFoam = smoothstep(1.6, 0.0, waterDepth) * (0.35 + 0.65 * band);
  }
  vec4 ft = texture2D(uFoamTex, vLocal / uFoamParams.w + uFoamOff.xy);
  vec4 ft2 = texture2D(uFoamTex, vec2(0.8 * vLocal.x - 0.6 * vLocal.y, 0.6 * vLocal.x + 0.8 * vLocal.y) / (uFoamParams.w * 0.29) + uFoamOff.zw);
  float pattern = clamp(ft.r * 0.62 + ft2.r * 0.38, 0.0, 1.0) * (0.75 + 0.5 * fbm3(np / 23.0));
  float cov = act * uFoamParams.y + res * uFoamParams.z + wakeFoam + shoreFoam;
  float foam = clamp(cov * 1.35 - (1.0 - pattern) * (1.05 - 0.6 * min(cov, 1.0)), 0.0, 1.0) * uFoamParams.x;
  foam = clamp(foam, 0.0, 1.0);
  alpha = mix(alpha, 0.6, foam);

  // ---- 反射
  float F = fresnelWater(NoV);
  vec3 R = reflect(-V, N);
  R = normalize(vec3(R.x, max(R.y, 0.0) + 0.002, R.z));
  float pr = sqrt(alpha);
  vec3 env = textureLod(uEnvMap, R, pr * uEnvMaxMip).rgb * uEnvIntensity;
  if (uReflectionStrength > 0.0) {
    vec4 rc = uReflectionMatrix * vec4(vWorld.x, 0.0, vWorld.z, 1.0);
    vec4 pc = texture2D(uReflection, rc.xy / rc.w + N.xz * 0.05);
    env = mix(env, pc.rgb, pc.a * uReflectionStrength * (1.0 - smoothstep(150.0, 500.0, vDist)));
  }
  vec2 AB = envBRDF(pr, NoV);
  float Fenv = clamp(0.02 * AB.x + AB.y, 0.0, 1.0);
  vec3 spec = env * Fenv;

  // ---- 太阳（或月亮）高光
  vec3 H = normalize(L + V);
  float NoL = max(dot(N, L), 0.0);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float a = max(alpha, uSunRadius);
  float a2 = a * a;
  float dd = NoH * NoH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float Fs = 0.02 + 0.98 * pow(1.0 - VoH, 5.0);
  vec3 sunSpec = min(uSunColor * (D * visSmithGGX(NoV, NoL, a) * Fs * NoL), vec3(uSpecClamp)) * (1.0 - foam);

  // ---- 水体散射（Atlas）
  float h = clamp(vHeight / max(uWaveScale, 0.05), 0.0, 2.5);
  float k1 = uSSS.x * h * pow(max(dot(L, -V), 0.0), 4.0) * pow(0.5 - 0.5 * dot(L, N), 3.0);
  float k2 = uSSS.y * pow(max(dot(V, N), 0.0), 2.0);
  float k3 = uSSS.z * NoL;
  vec3 scatter = k1 * uSSSColor * uSunColor
               + (k2 + k3) * uDeepColor * uSunColor
               + uSSS.w * uDeepColor * uAmbient
               + uBubbles * res * uSSSColor * (uSunColor * 0.35 + uAmbient);
  if (uUseBathy > 0.5) {
    // 浅水：按吸收系数透出沙底（视线路径 ≈ 水深·(1 + 1/cosθ)）
    vec3 T = exp(-uAbsorb * waterDepth * (1.0 + 1.0 / max(NoV, 0.2)));
    vec3 sand = uSand * (uSunColor * max(L.y, 0.0) * 0.32 + uAmbient * 0.9);
    scatter = mix(scatter, sand, T);
  }
  vec3 water = spec + (1.0 - Fenv) * scatter + sunSpec;

  // ---- 泡沫着色（漫反射白，背光处略透青）
  vec3 foamLight = uSunColor * (0.18 + 0.82 * max(dot(N, L), 0.0)) * 0.32 + uAmbient * 0.95;
  vec3 foamCol = uFoamColor * foamLight * (0.82 + 0.18 * ft.b);
  vec3 col = mix(water, foamCol, foam);

  // ---- 夜光藻（尾迹与碎浪）
  col += uBiolumColor * uBiolum * (wakeFoam * 1.4 + act * 0.25) * (0.6 + 0.4 * ft.g);

  // ---- 大气透视：雾色取视线方位上的地平线天空色，海天无缝
  // 与 SkyEnvironment.applyFog 相同的取色方式：视线方向抬高 0.012、mip 2.5
  vec3 horizon = textureLod(uEnvMap, normalize(vec3(-V.x, max(-V.y, 0.0) + 0.012, -V.z)), 2.5).rgb * uEnvIntensity;
  float mu = dot(-V, L);
  float g = uMieG;
  vec3 haze = horizon + uSunColor * uMie * (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * mu, 1e-3), 1.5);
  float fog = clamp(1.0 - exp(-uFogDensity * max(vDist, 0.0)), 0.0, 1.0);
  col = mix(col, haze, fog);

  if (uDebug == 9) {
    // NaN/Inf 定位：红 = 水体项，绿 = 高光，蓝 = 反射，白 = 雾
    vec3 bad = vec3(any(isnan(scatter)) || any(isinf(scatter)) ? 1.0 : 0.0, any(isnan(sunSpec)) || any(isinf(sunSpec)) ? 1.0 : 0.0, any(isnan(spec)) || any(isinf(spec)) ? 1.0 : 0.0);
    if (any(isnan(haze)) || any(isinf(haze))) bad = vec3(1.0);
    if (isnan(foam) || isinf(foam)) bad = vec3(1.0, 0.0, 1.0);
    if (any(isnan(col)) || any(isinf(col))) bad += vec3(0.0, 0.5, 0.5);
    col = bad + vec3(0.02);
  }
  else if (uDebug == 1) col = N * 0.5 + 0.5;
  else if (uDebug == 2) col = vec3(foam);
  else if (uDebug == 3) col = vec3(alpha * 3.0);
  else if (uDebug == 4) col = vec3(Fenv);
  else if (uDebug == 5) col = vec3(wakeFoam, abs(wakeGrad) * 20.0);
  else if (uDebug == 6) col = vec3(exp(-waterDepth * 0.15));
  else if (uDebug == 7) col = vec3(gust * 0.5);
  else if (uDebug == 8) col = vec3(clamp(f0.z, 0.0, 1.5) / 1.5);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** 海水光学参数（线性颜色），可在运行时改 material.uniforms */
export const OCEAN_LOOK = {
  deepColor: new THREE.Color(0.0045, 0.022, 0.034),
  sssColor: new THREE.Color(0.03, 0.17, 0.18),
  sss: new THREE.Vector4(3.6, 0.55, 0.2, 0.6),
  bubbles: 0.35,
  foamColor: new THREE.Color(0.92, 0.95, 0.96),
  sand: new THREE.Color(0.55, 0.47, 0.32),
  absorb: new THREE.Vector3(0.45, 0.09, 0.06),
  biolumColor: new THREE.Color(0.05, 0.55, 1.1),
};

export function createOceanMaterial(sim, options = {}) {
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;
  const blankCube = new THREE.CubeTexture();
  const c = sim.cascades;
  const uniforms = {
    uDisp0: { value: c[0].displacement }, uDisp1: { value: c[1].displacement }, uDisp2: { value: c[2].displacement },
    uSlope0: { value: c[0].slope }, uSlope1: { value: c[1].slope }, uSlope2: { value: c[2].slope },
    uFoam0: { value: c[0].foam }, uFoam1: { value: c[1].foam }, uFoam2: { value: c[2].foam }, uFoamW2: { value: 0 },
    uInvL: { value: new THREE.Vector3(1 / c[0].L, 1 / c[1].L, 1 / c[2].L) },
    uTexelSize: { value: new THREE.Vector3(c[0].L / sim.size, c[1].L / sim.size, c[2].L / sim.size) },
    uOriginUV0: { value: new THREE.Vector2() }, uOriginUV1: { value: new THREE.Vector2() }, uOriginUV2: { value: new THREE.Vector2() },
    uOrigin: { value: new THREE.Vector2() }, uCamLocal: { value: new THREE.Vector2() }, uNoiseOrigin: { value: new THREE.Vector2() },
    uGridScale: { value: 1 }, uGridInner: { value: 0.45 }, uGridGrowth: { value: 0.075 },
    uDispFade: { value: new THREE.Vector4(900, 2600, 90, 260) },
    uCascadeWeight: { value: new THREE.Vector3(1, 1, 1) },

    uSunDir: { value: new THREE.Vector3(0.3, 0.4, -0.8).normalize() },
    uSunColor: { value: new THREE.Color(3, 2.7, 2.3) },
    uAmbient: { value: new THREE.Color(0.25, 0.32, 0.42) },
    uEnvMap: { value: blankCube }, uEnvMaxMip: { value: 8 }, uEnvIntensity: { value: 1 },
    uSunRadius: { value: 0.02 }, uSpecClamp: { value: 3000 },

    uDeepColor: { value: OCEAN_LOOK.deepColor.clone() },
    uSSSColor: { value: OCEAN_LOOK.sssColor.clone() },
    uSSS: { value: OCEAN_LOOK.sss.clone() },
    uBubbles: { value: OCEAN_LOOK.bubbles },
    uWaveScale: { value: 1 },

    uFoamColor: { value: OCEAN_LOOK.foamColor.clone() },
    uFoamParams: { value: new THREE.Vector4(1, 1, 0.55, 7.5) },
    uFoamTex: { value: options.foamTexture ?? makeFoamTexture() },
    uFoamOff: { value: new THREE.Vector4() },
    uRippleOff: { value: new THREE.Vector4() },
    uStreakOff: { value: new THREE.Vector2() },
    uStreaks: { value: 0 },

    uWindDir: { value: new THREE.Vector2(1, 0) },
    uRipple: { value: 0.06 }, uMicroVar: { value: 0.0015 },
    uGustiness: { value: 0.6 }, uGustOffset: { value: new THREE.Vector2() },
    uRippleTex: { value: options.rippleTexture ?? makeRippleTexture() },
    uTime: { value: 0 },

    uFogDensity: { value: 0.00009 }, uMie: { value: 0.02 }, uMieG: { value: 0.76 },

    uReflection: { value: blank }, uReflectionMatrix: { value: new THREE.Matrix4() }, uReflectionStrength: { value: 0 },
    uUseBathy: { value: 0 }, uBathy: { value: blank }, uBathyRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uSand: { value: OCEAN_LOOK.sand.clone() }, uAbsorb: { value: OCEAN_LOOK.absorb.clone() },
    uUseWake: { value: 0 }, uWake: { value: blank }, uWakeRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uBiolum: { value: 0 }, uBiolumColor: { value: OCEAN_LOOK.biolumColor.clone() },
    uDebug: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.FrontSide });
  material.name = 'OceanMaterial';
  material._blank = blank;
  return material;
}
