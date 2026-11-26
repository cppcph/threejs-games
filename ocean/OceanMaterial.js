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
//      再加白浪下方气泡云的散射增亮。
//   6. 泡沫：白浪场（FoamField）给出三类泡沫的面积比例 —— 活跃白浪 A、残留泡沫 B、老化泡沫丝 C。
//      每类用一张均匀分布的图案按“图案值 > 1 − 比例”画出，画面覆盖率严格等于模拟值；
//      反照率：新鲜白浪约 0.55、残留泡沫筏约 0.4（斑块含空洞，整块平均约 0.2，合 Koepke 1984 的有效值 0.22）、泡沫丝更低；
//      反射随波长略降（Frouin 等 1996）。图案细节小于像素时退化为按比例混合（统计意义上不变）。
//      白浪场范围外用全场平均比例 × 主浪浪峰调制。残留泡沫与表面膜抑制毛细波，那里更光滑。
//   7. 大气透视：雾色取天空立方体在视线方位的地平线颜色（海天无缝）+ 朝太阳方向的米氏散射。
// 输出线性 HDR；直接渲染到屏幕时由 tonemapping/colorspace 块处理，接后期时交给 OutputPass。
import * as THREE from 'three';
import { makeFoamTexture, makeRippleTexture } from './textures.js';

/** 远处统计白浪：一个白浪按寿命平均的有效面积 / 尺度²（farBlob 的形状 × (1 − 相位²) 数值积分） */
export const FAR_CAP_AREA = 0.315;

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
uniform sampler2D uFoamField;   // 白浪场：A 活跃、B 残留、C 老化泡沫丝（面积比例）、f
uniform vec2 uFoamUV;           // 白浪场 uv = vLocal / 边长 + uFoamUV
uniform float uFoamInvE;
uniform vec4 uFoamMean;         // 白浪场全图平均（场外远处用）：A、B、C、新鲜度示踪 F
uniform vec4 uFarCap;           // 远处的统计白浪：单个白浪尺度（m）、寿命（s）、时间（s，取模）、主浪方向角
uniform float uFarCell;         // 撒点格子的边长（m）：覆盖率越高格子越小（CPU 按 1/8 倍频程量化，避免连续跳变）
uniform vec2 uFoamDrift;        // 表面累计漂流（m，对周期取模）：远处白浪随水漂
uniform vec3 uFoamAlbedo;       // A、B、C 的反照率
uniform float uFoamDamp;        // 残留泡沫对毛细波的抑制（0–1）
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
uniform vec4 uFoamParams;       // 显示强度、—、—、图案尺度（m）
uniform sampler2D uFoamTex;
uniform vec4 uFoamOff;          // 两层泡沫纹理的 UV 偏移（含风生漂流；CPU 双精度取小数）
uniform vec4 uRippleOff;        // 两层毛细波纹理的 UV 偏移（风坐标系，含随风滚动）
uniform vec2 uStreakOff;        // 泡沫丝图案的 UV 偏移（风坐标系，含漂流）

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

// 两个独立均匀变量的加权和 s = w·a + (1−w)·b（w ≥ 0.5）经其分布函数映射回均匀分布
float uniformSum(float a, float b, float w) {
  float w2 = 1.0 - w, s = w * a + w2 * b;
  if (s < w2) return s * s / (2.0 * w * w2);
  if (s > w) return 1.0 - (1.0 - s) * (1.0 - s) / (2.0 * w * w2);
  return (s - 0.5 * w2) / w;
}
// 面积比例 f 的泡沫遮罩：均匀图案 p 上取“p > 1 − f”，线性过渡带宽随图案的屏幕频率变化；
// 图案细于像素时直接返回 f（期望值处处等于 f）
// 远处的统计白浪：世界坐标里按格子撒点，每格同一时刻最多一个白浪，出现概率使面积比例等于场内实测的 f；
// 每个白浪按寿命 τ 由亮转淡，到期在格内换一个位置重生（随机相位，不会同时闪烁）；形状沿浪峰（垂直主浪方向）拉长。
// 一个白浪按寿命平均的有效面积 = FAR_CAP_AREA·尺度²（下面形状 × (1 − 相位²) 的数值积分），出现概率按它算，
// 期望覆盖率才等于 f。白浪可以伸出自己的格子，所以取离该点最近的 2×2 个格子（格子 ≥ 1.2 倍尺度时这样就不漏）。
// 像素足迹大于白浪尺度时退回平均值 f（统计上一致，远处不闪）
float farBlob(vec2 c, vec2 xw, float f, float size, float cell, float life, float t, vec2 wdir) {
  float age = t / life + hash12(c * 1.37 + 0.5);
  float epoch = floor(age), phase = fract(age);
  float p = clamp(f * cell * cell / (size * size * ${FAR_CAP_AREA.toFixed(4)}), 0.0, 1.0);
  if (hash12(c * 2.11 + epoch * 13.7) >= p) return 0.0;
  vec2 jit = vec2(hash12(c + epoch * 7.13), hash12(c * 0.71 + epoch * 3.31 + 9.2));
  vec2 d = xw - (c + 0.2 + 0.6 * jit) * cell;
  vec2 q = vec2(dot(d, vec2(-wdir.y, wdir.x)), dot(d, wdir));      // 沿浪峰、沿传播
  float r = length(q / (size * vec2(0.7, 0.32)));
  return (1.0 - smoothstep(0.55, 1.0, r * (0.85 + 0.3 * phase))) * (1.0 - phase * phase);   // 先活跃后残留，逐渐变淡
}
float farWhitecaps(vec2 xw, float f, float size, float cell, float life, float t, vec2 wdir, float footprint) {
  if (f <= 0.0) return 0.0;
  float w = 1.0 - smoothstep(0.35 * size, 1.5 * size, footprint);   // 白浪小于像素：用平均值
  if (w <= 0.0) return f;
  vec2 c0 = floor(xw / cell - 0.5);
  float b = max(max(farBlob(c0, xw, f, size, cell, life, t, wdir), farBlob(c0 + vec2(1.0, 0.0), xw, f, size, cell, life, t, wdir)),
                max(farBlob(c0 + vec2(0.0, 1.0), xw, f, size, cell, life, t, wdir), farBlob(c0 + vec2(1.0, 1.0), xw, f, size, cell, life, t, wdir)));
  return mix(f, b, w);
}

float coverMask(float p, float f) {
  float w = clamp(fwidth(p) * 0.75, 0.02, 0.5);
  float m = clamp((p - 1.0 + f) / (2.0 * w) + 0.5, 0.0, 1.0) * smoothstep(0.0, 0.02, f);
  return mix(m, f, smoothstep(0.2, 0.45, w));
}

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

  // ---- 白浪场：三类泡沫的面积比例（近处取场，场外取全场平均 × 主浪浪峰调制）
  vec2 fuv = vLocal * uFoamInvE + uFoamUV;
  float edgeD = max(abs(fuv.x - 0.5), abs(fuv.y - 0.5)) * 2.0;
  float wNear = 1.0 - smoothstep(0.8, 0.97, edgeD);
  vec4 fld = wNear > 0.0 ? texture2D(uFoamField, fuv) : vec4(0.0);
  float crestMod = clamp(1.0 + 1.8 * vHeight / max(uWaveScale, 0.05), 0.0, 3.0);   // 浪高 / σ 的线性调制，均值约 1
  vec3 far = vec3(uFoamMean.x * crestMod, uFoamMean.y * mix(1.0, crestMod, 0.5), uFoamMean.z);
  if (wNear < 1.0 && uFoamMean.x + uFoamMean.y > 0.0) {
    // 场外：把活跃 + 残留的平均比例换成一个个离散的白浪（实拍里远处的“白马”是一个个亮点，不是一层灰）
    float fp = length(fwidth(vWorld.xz));
    vec2 xs = vWorld.xz - uFoamDrift;
    vec2 wd = vec2(cos(uFarCap.w), sin(uFarCap.w));
    float cap = farWhitecaps(xs, (uFoamMean.x + uFoamMean.y) * clamp(crestMod, 0.3, 2.0), uFarCap.x, uFarCell, uFarCap.y, uFarCap.z, wd, fp);
    float share = uFoamMean.x / max(uFoamMean.x + uFoamMean.y, 1e-4);
    far.x = cap * share; far.y = cap * (1.0 - share);
  }
  vec3 frc = mix(far, fld.xyz, wNear);
  // 残留泡沫的新鲜度 F/B（两个面积比例之比，mip 平均和远近都不改变它）；场外用全图平均
  float freshRatio = clamp(mix(far.y * uFoamMean.w / max(uFoamMean.y, 1e-5), fld.w, wNear) / max(frc.y, 1e-4), 0.0, 1.0);

  // 阵风（猫爪风）：随风平移的噪声，只改变短波；残留泡沫与表面膜处毛细波被抑制
  float gust = 1.0;
  if (uGustiness > 0.0) {
    float n = fbm3((np - uGustOffset) / 85.0);
    gust = mix(1.0, mix(0.3, 1.75, smoothstep(0.28, 0.72, n)), uGustiness);
  }
  gust *= 1.0 - uFoamDamp * clamp((frc.y + frc.z) * 1.5, 0.0, 1.0);

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

  // ---- 泡沫
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
    // 岸边碎浪由白浪场的浅水破碎给出；这里只留水线处一圈很窄的冲流泡沫
    shoreFoam = smoothstep(0.25, 0.0, waterDepth) * (0.6 + 0.4 * fbm3(np * 0.4 + uTime * 0.2));
  }
  // 图案（随表面漂流）：两层不同尺度、旋转 37° 的同一张均衡纹理，合成后再映射回均匀分布
  vec2 l2 = vec2(0.8 * vLocal.x - 0.6 * vLocal.y, 0.6 * vLocal.x + 0.8 * vLocal.y);
  vec4 ft2 = texture2D(uFoamTex, l2 / (uFoamParams.w * 0.29) + uFoamOff.zw);
  // 粗层的细胞边按第二层的细节弯一弯（约 ±0.2 m）：近看不再是直边的多边形网
  vec4 ft = texture2D(uFoamTex, vLocal / uFoamParams.w + uFoamOff.xy + (ft2.ba - 0.5) * 0.035);
  // 近处的细节层：第二层的 1/3 尺度（泡沫花边里 10 cm 量级的小洞、碎边），图案细于几个像素时淡出，
  // 远处与原来完全相同。尺度比取整数，漂流偏移按同一倍数放大后仍无缝
  vec2 uvF = l2 / (uFoamParams.w * 0.29 / 3.0) + uFoamOff.zw * 3.0 + vec2(0.37, 0.71) + (ft.ab - 0.5) * 0.6;
  float ftF = texture2D(uFoamTex, uvF).r;
  float wF = 1.0 - smoothstep(0.02, 0.05, length(fwidth(uvF)));
  // 泡沫丝：实拍里是弯曲、分叉、断续的“大理石纹”，不是直线。沿风向只拉长 3 倍，再做两层扭曲；
  // 成条成带的走向由白浪场里的朗缪尔环流决定，图案只负责细丝的样子
  vec2 wl = lp + vec2((fbm3(lp / 23.0 + 3.1) - 0.5) * 6.0, (fbm3(lp / 9.0) - 0.5) * 3.0 + (fbm3(lp / 45.0) - 0.5) * 4.0);
  float fil = texture2D(uFoamTex, wl / vec2(uFoamParams.w * 3.0, uFoamParams.w * 0.45) + uStreakOff).r;
  float fA = clamp(frc.x * uFoamParams.x, 0.0, 1.0);
  float fB = clamp(max(frc.y * uFoamParams.x, max(wakeFoam, shoreFoam)), 0.0, 1.0);
  float fC = clamp(frc.z * uFoamParams.x, 0.0, 1.0);
  float mA = coverMask(uniformSum(ft.g, ft2.b, 0.6), fA);
  float pB = uniformSum(ft.r, ft2.r, 0.62);
  pB = mix(pB, uniformSum(pB, ftF, 0.6), wF);
  float mB = coverMask(pB, fB);
  float mC = coverMask(uniformSum(fil, ft.r, 0.65), fC);
  // 残留泡沫随时间变薄：气泡破裂，泡沫筏变稀、变透明，反射率下降（Koepke 1984：新鲜 0.55，
  // 按寿命平均的有效值只有 0.22）。年龄来自白浪场的新鲜度示踪：F/B = e^(−年龄/τB)。
  // 尾迹与岸线泡沫越浓越接近新鲜白浪
  float fresh = smoothstep(0.08, 0.75, freshRatio);
  float rhoB = mix(uFoamAlbedo.y * (0.45 + 0.55 * fresh), uFoamAlbedo.x, clamp(max(wakeFoam, shoreFoam) * 1.3 - 0.3, 0.0, 1.0));
  float opB = mix(0.45, 0.9, max(fresh, clamp(max(wakeFoam, shoreFoam) * 1.3, 0.0, 1.0)));
  // 不透明度：厚白浪 1，残留泡沫 0.45–0.9（随年龄），薄泡沫丝 0.5
  float oB = (1.0 - mA) * mB, oC = (1.0 - mA) * (1.0 - mB) * mC;
  float foam = clamp(mA + opB * oB + 0.5 * oC, 0.0, 1.0);
  float foamRho = mA * uFoamAlbedo.x + oB * rhoB * opB / 0.85 + oC * uFoamAlbedo.z;
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
               + uBubbles * (frc.x + 0.6 * frc.y) * uSSSColor * (uSunColor * 0.35 + uAmbient);   // 白浪下的气泡云
  if (uUseBathy > 0.5) {
    // 浅水：按吸收系数透出沙底（视线路径 ≈ 水深·(1 + 1/cosθ)）
    vec3 T = exp(-uAbsorb * waterDepth * (1.0 + 1.0 / max(NoV, 0.2)));
    vec3 sand = uSand * (uSunColor * max(L.y, 0.0) * 0.32 + uAmbient * 0.9);
    scatter = mix(scatter, sand, T);
  }
  vec3 water = spec + (1.0 - Fenv) * scatter + sunSpec;

  // ---- 泡沫着色：多次散射的漫反射体（背光处仍有透光），反射随波长略降
  vec3 foamLight = uSunColor * (0.18 + 0.82 * max(dot(N, L), 0.0)) * 0.32 + uAmbient * 0.95;
  vec3 col = water * (1.0 - foam) + uFoamColor * foamLight * foamRho * (0.85 + 0.3 * ft.b);

  // ---- 夜光藻（尾迹与碎浪）
  col += uBiolumColor * uBiolum * (wakeFoam * 1.4 + mA * 0.35) * (0.6 + 0.4 * ft.g);

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
  else if (uDebug == 8) col = sqrt(frc);
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
  foamColor: new THREE.Color(0.9, 0.96, 1.0),          // 泡沫反射的光谱形状（Frouin 等 1996：随波长略降）
  // 泡沫本身的反照率：新鲜厚白浪 ≈ 0.55（Whitlock 等 1982；Koepke 1984），残留泡沫筏更薄 ≈ 0.4，
  // 老化泡沫丝 ≈ 0.25；残留斑块里一半左右是空洞，整块平均 ≈ 0.2，与 Koepke 的有效反照率 0.22 相符
  foamAlbedo: new THREE.Vector3(0.55, 0.4, 0.25),
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
    uFoamField: { value: blank }, uFoamUV: { value: new THREE.Vector2(-10, -10) }, uFoamInvE: { value: 1 / 512 },
    uFoamMean: { value: new THREE.Vector4() }, uFoamAlbedo: { value: OCEAN_LOOK.foamAlbedo.clone() }, uFoamDamp: { value: 0.6 },
    uFarCap: { value: new THREE.Vector4(6, 4.5, 0, 0) }, uFarCell: { value: 20 }, uFoamDrift: { value: new THREE.Vector2() },
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
    uFoamParams: { value: new THREE.Vector4(1, 0, 0, 12) },
    uFoamTex: { value: options.foamTexture ?? makeFoamTexture() },
    uFoamOff: { value: new THREE.Vector4() },
    uRippleOff: { value: new THREE.Vector4() },
    uStreakOff: { value: new THREE.Vector2() },

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
