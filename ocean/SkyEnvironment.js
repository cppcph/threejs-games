// =====================================================================================
// SkyEnvironment —— 天空、云、星、月、闪电；给水面反射用的天空立方体 + 给 PBR 材质用的 PMREM
//
// 用法：
//   const sky = new SkyEnvironment(renderer, { cubeSize: 256 });
//   scene.add(sky.object);            // 天穹（永远画在最远处，跟随相机）
//   scene.add(sky.lights);            // 可选：主光源（DirectionalLight，白天太阳 / 夜里月亮）
//   每帧：sky.update(dt, { camera, timeOfDay: 17.5, cloudCover: 0.45, storm: 0, wind: new THREE.Vector2(6, 2) });
//         scene.environment = sky.environment; scene.environmentIntensity = sky.environmentIntensity;
//
// 约定：米、秒、Y 向上、海平面 y = 0；风 wind 是 Vector2(x, z)，单位 m/s，指向空气流动的去向。
// 颜色全部是线性 HDR，标定沿用《信风》：后期 ACES / AgX，曝光 ≈ 0.5。
//
// 输出（update 之后有效）与量级：
//   sunDirection / moonDirection    Vector3，指向太阳 / 月亮（单位向量）
//   sunColor                        太阳直射光（海平面处，已含大气消光、云遮挡、风暴）：晴天正午 ≈ (0.97, 0.97, 0.96)，
//                                   黄金时刻 ≈ (0.7, 0.45, 0.13)，太阳在地平线以下为 0；云飘过太阳时最多减弱 82%（平滑过渡）。
//                                   给 DirectionalLight 用时强度 ≈ 3.1 × max(rgb)（sky.keyLight 已经这样设好）
//   moonColor                       月光，满月高挂时 ≈ (0.12, 0.14, 0.22)
//   keyLightDirection / keyLightColor  水面用的主光源：白天是太阳，日落后换月亮；切换发生在两者都接近 0 的时刻，不会跳变。
//                                   方向的 y 至少 0.02
//   ambientColor                    上半球余弦加权平均辐亮度（含云）。由 GPU 探针从 envMap 积分后异步读回，与 envMap 完全一致，
//                                   直接乘反照率即可。实测：晴天正午 ≈ (1.0, 1.4, 1.9)，黄金时刻 ≈ (0.45, 0.55, 0.6)，
//                                   风暴 ≈ (0.08, 0.1, 0.13)，月夜 ≈ (0.1, 0.12, 0.17)
//   horizonColor                    地平线一圈（仰角 2°）的平均辐亮度，含云（雾 / 大气透视用的单一颜色）
//   horizonKeyColor                 朝主光源方位那一侧的地平线颜色（日落时是橙色）
//   skyAmbient / skyHorizon         同上但不含云（只有 Preetham 天空）；云自己的环境光用它们，避免“云照亮云”的正反馈
//   strikes / lastStrike            闪电计数与最近一次的 { azimuth, distance(m) }（可按距离延迟播放雷声：distance / 343 秒）
//   envMap                          HalfFloat 立方体贴图（带 mipmap）：天空 + 云 + 星 + 月，不含太阳盘（太阳反射交给水面的
//                                   解析高光，否则会出现两个太阳）。数值上限 40。地平线以下是暗色地面，水面一般用不到
//   environment                     PMREM 纹理，给 scene.environment
//   environmentIntensity            建议的 scene.environmentIntensity（0.2–0.75）
//   lightning                       本帧闪电亮度 0–1（storm > 0.6 才会出现）；lightningDirection 指向闪电方位
//   night                           0 白天 → 1 夜晚
//
// 水面着色器需要知道的：
//   · 反射：textureLod(envMap, R, roughness * maxMip)，maxMip = log2(cubeSize)
//   · 雾 / 大气透视：沿视线方向取地平线颜色 fogDir = normalize(vec3(v.x, max(v.y, 0.0) + 0.012, v.z))，
//     textureLod(envMap, fogDir, 2.5)，混合系数 1 − exp(−density · 距离)；applyFog(material) 给普通材质打的是同一个补丁，
//     共享 fogUniforms.uSkyFogDensity，这样船、岛、海在远处融成一色
//   · 闪电不会画进 envMap（避免反射里闪烁不同步），需要的话在反射项上加 lightning × (0.75, 0.8, 1.0) × 强度
// =====================================================================================
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------- 可平铺噪声（CPU 生成一次）：周期梯度噪声 + Worley ----------------
function gradNoise(x, y, period, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const w = (a) => ((a % period) + period) % period;
  const g = (cx, cy, dx, dy) => { const a = hash2(w(cx), w(cy), seed) * TAU; return Math.cos(a) * dx + Math.sin(a) * dy; };
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = g(ix, iy, fx, fy), b = g(ix + 1, iy, fx - 1, fy), c = g(ix, iy + 1, fx, fy - 1), d = g(ix + 1, iy + 1, fx - 1, fy - 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);   // 约 [-0.7, 0.7]
}
function fbmP(u, v, base, oct, seed, gain = 0.5) {
  let s = 0, a = 1, n = 0, f = base;
  for (let i = 0; i < oct; i++) { s += a * gradNoise(u * f, v * f, f, seed + i * 31); n += a; a *= gain; f *= 2; }
  return s / n;
}
function worleyP(u, v, cells, seed) {
  const x = u * cells, y = v * cells, ix = Math.floor(x), iy = Math.floor(y);
  let d1 = 9;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const cx = ix + ox, cy = iy + oy, wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells;
    const px = cx + hash2(wx, wy, seed), py = cy + hash2(wx, wy, seed + 7);
    const d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < d1) d1 = d;
  }
  return Math.sqrt(d1);
}
// R：大尺度 FBM  G：中尺度 FBM  B：积云团块（Worley 反相 + FBM）  A：细节 FBM（边缘侵蚀）
function makeCloudNoise(size = 256, seed = 13) {
  const ch = [new Float32Array(size * size), new Float32Array(size * size), new Float32Array(size * size), new Float32Array(size * size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, i = y * size + x;
    ch[0][i] = fbmP(u, v, 4, 6, seed);
    ch[1][i] = fbmP(u, v, 8, 5, seed + 101);
    ch[2][i] = (1 - worleyP(u, v, 6, seed + 211)) * 0.7 + fbmP(u, v, 12, 3, seed + 307) * 0.6 + (1 - worleyP(u, v, 13, seed + 401)) * 0.3;
    ch[3][i] = fbmP(u, v, 32, 3, seed + 503);
  }
  // 每个通道拉满到 [0,1]
  const data = new Uint8Array(size * size * 4);
  for (let c = 0; c < 4; c++) {
    let lo = Infinity, hi = -Infinity;
    for (const val of ch[c]) { if (val < lo) lo = val; if (val > hi) hi = val; }
    const k = 1 / Math.max(hi - lo, 1e-6);
    for (let i = 0; i < size * size; i++) { const t = (ch[c][i] - lo) * k; ch[c][i] = t; data[i * 4 + c] = Math.round(t * 255); }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4; tex.needsUpdate = true;
  return { tex, ch, size };
}
function sampleCh(noise, c, u, v) {   // 与 GPU 一致的双线性 + 平铺
  const s = noise.size, x = u * s - 0.5, y = v * s - 0.5, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const w = (a) => ((a % s) + s) % s, d = noise.ch[c];
  const a = d[w(iy) * s + w(ix)], b = d[w(iy) * s + w(ix + 1)], cc = d[w(iy + 1) * s + w(ix)], dd = d[w(iy + 1) * s + w(ix + 1)];
  return lerp(lerp(a, b, fx), lerp(cc, dd, fx), fy);
}

// ---------------- 云的着色器（与 CPU 版 cloudDensity 用同一个公式） ----------------
const CLOUD_GLSL = /* glsl */`
  uniform sampler2D uNoise;
  uniform vec2 uOfs;
  uniform float uLo;
  uniform float uW;
  uniform float uStorm;
  float cloudDensity(vec2 p) {
    vec2 warp = (texture2D(uNoise, p * 0.47 + vec2(0.13, 0.71)).rg - 0.5) * 0.13;
    vec2 q = p + warp;
    float base = texture2D(uNoise, q).r;
    float puff = texture2D(uNoise, q * 1.73 + vec2(0.31, 0.17)).b;
    float detail = texture2D(uNoise, q * 4.1 + vec2(0.77, 0.4)).g;
    float n = base * 0.5 + puff * 0.36 + detail * 0.14;
    float d = smoothstep(uLo, uLo + uW, n);          // uLo / uW 由 CPU 按噪声分布的分位数标定：覆盖率 ≈ 天空被云遮住的比例
    float fine = texture2D(uNoise, q * 9.7 + vec2(0.5, 0.21)).a;
    d = clamp(d - (1.0 - d) * (fine - 0.35) * 0.7, 0.0, 1.0);
    return d;
  }
`;

const _v = new THREE.Vector3(), _c = new THREE.Color();

export class SkyEnvironment {
  constructor(renderer, { cubeSize = 256, quality = 'high', shadows = false, seed = 13 } = {}) {
    this.renderer = renderer;
    this.cubeSize = cubeSize;
    this.quality = quality;
    // —— 输出 ——
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.moonDirection = new THREE.Vector3(0, -1, 0);
    this.keyLightDirection = new THREE.Vector3(0, 1, 0);
    this.lightningDirection = new THREE.Vector3(1, 0.1, 0).normalize();
    this.sunColor = new THREE.Color(1, 1, 1);
    this.moonColor = new THREE.Color(0, 0, 0);
    this.keyLightColor = new THREE.Color(1, 1, 1);
    this.ambientColor = new THREE.Color(0.35, 0.5, 0.75);
    this.horizonColor = new THREE.Color(0.6, 0.7, 0.85);
    this.horizonKeyColor = new THREE.Color(0.8, 0.75, 0.7);
    this.environmentIntensity = 0.75;
    this.lightning = 0;
    this.night = 0;
    this.strikes = 0;                 // 闪电计数（每次新的一击 +1，可用来延迟播放雷声）
    this.lastStrike = { azimuth: 0, distance: 5000 };
    // —— 内部状态 ——
    this.timeOfDay = 12; this.cloudCover = 0.4; this.storm = 0;
    this.latitude = 0.26; this.sunAzimuth = 0;
    this._cloudOfs = new THREE.Vector2(0.37, 0.61);
    this._cirrusOfs = new THREE.Vector2(0.11, 0.29);
    this._sunOcc = 1;                 // 云对太阳的遮挡（平滑后）
    this._flash = { t: 99, next: 6, pulses: [] };
    this._probeReady = false; this._probeBusy = false;
    this._probeAmb = new THREE.Color(); this._probeHor = new THREE.Color(); this._probeHorKey = new THREE.Color();
    this._elapsed = 0;

    this.noise = makeCloudNoise(256, seed);
    const noiseTex = this.noise.tex;
    // 覆盖率标定：在 CPU 上按着色器同样的组合方式采样 n，排序得到分位数；
    // 阈值取 1 − cover 分位数，这样 cloudCover 就近似等于“天空被云遮住的比例”
    {
      const N = 6144, arr = new Float32Array(N), r = mulberry32(seed + 991);
      for (let i = 0; i < N; i++) arr[i] = this._cloudN(r() * 8, r() * 8);
      arr.sort(); this._nq = arr;
    }
    this._lo = 0.5; this._w = 0.1;
    this.skyAmbient = new THREE.Color(0.35, 0.5, 0.75);   // 不含云的天空平均亮度（给云的环境光用，避免“云照亮云”的正反馈）
    this._probeSkyAmb = new THREE.Color();
    this.skyHorizon = new THREE.Color(0.6, 0.7, 0.85);    // 不含云的地平线颜色（云的大气透视用）
    this._probeSkyHor = new THREE.Color();
    this._probeQueued = false; this._probeId = 0; this._snapAfter = 1;   // 第一次读回直接采用

    this.object = new THREE.Group();
    this.object.name = 'SkyEnvironment';

    // —— Preetham 天空（补丁：日面开关、夜空渐变 + 银河、月晕、风暴变灰、上限 40）——
    const sky = new Sky();
    // 用细分球代替 Sky.js 自带的 12 个三角形的盒子：大三角形横跨相机平面时，z = w 技巧下的裁剪会把插值方向算错
    // （软件光栅器上表现为一整块灰色面），细分球每个三角形都很小，不会出这个问题
    sky.geometry.dispose(); sky.geometry = new THREE.SphereGeometry(1, 64, 32);
    sky.scale.setScalar(40000); sky.frustumCulled = false; sky.renderOrder = -10;
    const su = sky.material.uniforms;
    su.turbidity.value = 4.0; su.rayleigh.value = 2.0; su.mieCoefficient.value = 0.0018; su.mieDirectionalG.value = 0.76;
    Object.assign(su, {
      uSunDisk: { value: 1 }, uNight: { value: 0 }, uMoonDir: { value: this.moonDirection }, uStorm: { value: 0 },
      uNightZenith: { value: new THREE.Color(0.0011, 0.0024, 0.0068) }, uNightHorizon: { value: new THREE.Color(0.0055, 0.011, 0.024) },
      uNoise: { value: noiseTex }, uGround: { value: new THREE.Color(0.02, 0.03, 0.04) },
    });
    let fs = sky.material.fragmentShader;
    fs = fs.replace('uniform vec3 up;', `uniform vec3 up;
      uniform float uSunDisk; uniform float uNight; uniform vec3 uMoonDir; uniform vec3 uNightZenith; uniform vec3 uNightHorizon;
      uniform float uStorm; uniform sampler2D uNoise; uniform vec3 uGround;`);
    fs = fs.replace('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', 'L0 += ( vSunE * 19000.0 * Fex ) * sundisk * uSunDisk * ( 1.0 - 0.97 * uStorm );');
    fs = fs.replace('gl_FragColor = vec4( retColor, 1.0 );', `
      float hz = clamp(direction.y, 0.0, 1.0);
      vec3 nightC = mix(uNightHorizon, uNightZenith, sqrt(hz));
      // 银河：一条倾斜的大圆带，用噪声打散
      vec3 bandN = normalize(vec3(0.32, 0.52, 0.79));
      float bd = dot(direction, bandN);
      vec2 nuv = vec2(atan(direction.z, direction.x) * 0.3183, direction.y) * vec2(3.0, 1.6);
      float mw = exp(-bd * bd / 0.035) * (0.35 + 0.65 * texture2D(uNoise, nuv).g) * smoothstep(0.0, 0.25, direction.y);
      nightC += vec3(0.010, 0.011, 0.016) * mw;
      float md = max(dot(direction, uMoonDir), 0.0);
      nightC += vec3(0.40, 0.48, 0.66) * (pow(md, 48.0) * 0.05 + pow(md, 6.0) * 0.012) * smoothstep(-0.1, 0.1, uMoonDir.y);
      retColor += nightC * uNight;
      float lum = dot(retColor, vec3(0.3, 0.55, 0.15));
      retColor = mix(retColor, vec3(lum) * vec3(0.76, 0.82, 0.9) * 0.62, uStorm * 0.82);
      // 地平线以下：暗色“海面”方向，避免 Preetham 在下半球给出奇怪的颜色
      retColor = mix(retColor, uGround, 1.0 - smoothstep(-0.06, 0.0, direction.y));
      retColor = min(retColor, vec3(40.0));   // 半精度上限 65504：日面不限幅会变 Inf，经 bloom 扩散成黑块
      gl_FragColor = vec4( retColor, 1.0 );`);
    if (!fs.includes('uSunDisk;') || !fs.includes('vec3(40.0)')) console.warn('SkyEnvironment: Sky shader patch failed');
    sky.material.fragmentShader = fs;
    sky.material.needsUpdate = true;
    this.sky = sky;
    this.object.add(sky);

    // —— 星空 ——
    const NS = 3200, sp = new Float32Array(NS * 3), sa = new Float32Array(NS * 4), rnd = mulberry32(seed + 77);
    for (let i = 0; i < NS; i++) {
      const y = Math.pow(rnd(), 0.75), a = rnd() * TAU, r = Math.sqrt(1 - y * y);
      sp.set([Math.cos(a) * r * 26000, y * 26000, Math.sin(a) * r * 26000], i * 3);
      sa.set([0.5 + Math.pow(rnd(), 7) * 3.6, rnd() * TAU, 0.6 + rnd() * 2.5, rnd()], i * 4);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('aStar', new THREE.BufferAttribute(sa, 4));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uNight: { value: 0 }, uTime: { value: 0 }, uPR: { value: 1 } },
      vertexShader: /* glsl */`attribute vec4 aStar; uniform float uTime; uniform float uPR; varying float vB; varying float vY; varying vec3 vTint;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_Position.z = gl_Position.w * 0.99997;
          vY = normalize(position).y;
          float tw = 1.0 - (0.25 + 0.35 * (1.0 - vY)) * (0.5 + 0.5 * sin(uTime * aStar.z + aStar.y));
          vB = aStar.x * tw;
          vTint = mix(vec3(1.0, 0.82, 0.66), vec3(0.75, 0.85, 1.0), aStar.w);   // 星的色温
          gl_PointSize = (1.1 + aStar.x * 0.7) * uPR; }`,
      fragmentShader: /* glsl */`uniform float uNight; varying float vB; varying float vY; varying vec3 vTint;
        void main(){ vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(c));
          gl_FragColor = vec4(vTint * vB * 0.55, a * uNight * smoothstep(0.0, 0.14, vY)); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false; this.stars.renderOrder = -9;
    this.object.add(this.stars);

    // —— 月亮（按太阳方向算月相，带临边昏暗和地照）——
    this.moonMat = new THREE.ShaderMaterial({
      uniforms: { uNoise: { value: noiseTex }, uSunDir: { value: this.sunDirection }, uBright: { value: 2.2 } },
      vertexShader: /* glsl */`varying vec3 vN; varying vec2 vUv; varying vec3 vV;
        void main(){ vN = normalize(mat3(modelMatrix) * normal); vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vV = normalize(cameraPosition - w.xyz);
          gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w * 0.99996; }`,
      fragmentShader: /* glsl */`uniform sampler2D uNoise; uniform vec3 uSunDir; uniform float uBright; varying vec3 vN; varying vec2 vUv; varying vec3 vV;
        void main(){
          float m = texture2D(uNoise, vUv * vec2(2.0, 1.0)).g;
          float lit = smoothstep(-0.08, 0.25, dot(vN, normalize(uSunDir + vec3(0.0, 0.0001, 0.0))));
          float limb = 0.65 + 0.35 * pow(max(dot(vN, vV), 0.0), 0.5);
          vec3 c = mix(vec3(0.55, 0.57, 0.62), vec3(1.0, 0.98, 0.93), smoothstep(0.35, 0.68, m));
          gl_FragColor = vec4(c * (lit * limb + 0.025) * uBright, 1.0);
        }`,
      depthWrite: false,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(300, 40, 20), this.moonMat);
    this.moon.renderOrder = -8; this.moon.frustumCulled = false;
    this.object.add(this.moon);
    this.glowTex = SkyEnvironment._glowTexture();
    this.moonGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: new THREE.Color(0.45, 0.52, 0.7), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 }));
    this.moonGlow.scale.setScalar(5200); this.moonGlow.renderOrder = -8; this.moonGlow.frustumCulled = false;
    this.object.add(this.moonGlow);

    // —— 云：积云层（1.5 km）+ 卷云层（8 km），二维“光线步进”算自阴影，双瓣 HG 相函数出银边 ——
    const lightSteps = quality === 'low' ? 2 : 3;
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uNoise: { value: noiseTex }, uOfs: { value: this._cloudOfs }, uCirrusOfs: { value: this._cirrusOfs }, uLo: { value: 0.5 }, uW: { value: 0.1 }, uStorm: { value: 0 },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) }, uLightColor: { value: new THREE.Color(1, 1, 1) },
        uAmbTop: { value: new THREE.Color(0.4, 0.5, 0.7) }, uAmbBottom: { value: new THREE.Color(0.1, 0.12, 0.15) }, uHorizon: { value: new THREE.Color(0.6, 0.7, 0.8) },
        uWindDir: { value: new THREE.Vector2(1, 0) }, uCirrus: { value: 0.5 },
        uFlashDir: { value: this.lightningDirection }, uFlash: { value: 0 },
      },
      vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.99998; }`,
      fragmentShader: /* glsl */`
        ${CLOUD_GLSL}
        uniform vec2 uCirrusOfs; uniform vec3 uLightDir; uniform vec3 uLightColor; uniform vec3 uAmbTop; uniform vec3 uAmbBottom; uniform vec3 uHorizon;
        uniform vec2 uWindDir; uniform float uCirrus; uniform vec3 uFlashDir; uniform float uFlash;
        varying vec3 vDir;
        float hg(float mu, float g){ float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5); }
        void main(){
          vec3 d = normalize(vDir);
          if (d.y < 0.004 * (1.0 - uStorm)) discard;
          // —— 积云层 ——
          float t = 1500.0 / (d.y + 0.035);                 // 到云底平面的距离（近地平线压平）
          vec2 p = d.xz * t / 14000.0 + uOfs;                // 1 个噪声周期 = 14 km
          float dens = cloudDensity(p);
          float mu = dot(d, uLightDir);
          vec3 col = vec3(0.0); float alpha = 0.0;
          if (dens > 0.002) {
            vec2 ld = normalize(uLightDir.xz + vec2(1e-4, 0.0));
            float stepLen = 0.010 + 0.022 * (1.0 - clamp(uLightDir.y, 0.0, 1.0));
            float sh = 0.0;
            for (int i = 1; i <= ${lightSteps}; i++) sh += cloudDensity(p + ld * stepLen * float(i));
            sh *= 3.0 / float(${lightSteps});
            float thick = mix(1.0, 3.2, uStorm);
            float od = dens * thick * (1.2 + 1.6 * (1.0 - d.y));
            float beer = exp(-sh * thick * 0.9) * 0.85 + 0.15 * exp(-sh * thick * 0.25);   // 多次散射的近似：加一个弱衰减分量
            float powder = 1.0 - exp(-dens * 4.0);
            float phase = mix(hg(mu, 0.72), hg(mu, -0.18), 0.4) * 0.6 + 0.15;
            vec3 direct = uLightColor * beer * mix(0.5, 1.0, powder) * phase * 1.25 * (1.0 - 0.85 * uStorm);
            // 云底更暗：越厚越接近“下方海面反光”的颜色
            vec3 amb = mix(uAmbTop, uAmbBottom, clamp(dens * thick * 0.45, 0.0, 1.0));
            col = direct + amb * 0.95;
            // 风暴：大块明暗起伏的低云，越靠近地平线越暗
            float roll = texture2D(uNoise, p * 0.33 + vec2(0.21, 0.63)).r;
            col *= mix(1.0, (0.42 + 0.72 * smoothstep(0.15, 0.85, roll)) * (0.8 + 0.2 * smoothstep(0.0, 0.5, d.y)), uStorm * 0.85);
            // 闪电：从云层内部照亮
            float fl = pow(max(dot(d, uFlashDir), 0.0), 10.0);
            col += vec3(0.72, 0.78, 1.0) * uFlash * (fl * 1.8 + 0.08) * (0.25 + dens);
            alpha = (1.0 - exp(-od * 3.2));
          }
          // —— 卷云层（沿风向拉长的纤维）——
          float t2 = 8000.0 / (d.y + 0.035);
          vec2 p2 = d.xz * t2 / 42000.0;
          vec2 wd = normalize(uWindDir + vec2(1e-4, 0.0));
          vec2 r2 = vec2(dot(p2, wd), dot(p2, vec2(-wd.y, wd.x))) * vec2(0.35, 2.4) + uCirrusOfs;
          float ci = texture2D(uNoise, r2).g * 0.7 + texture2D(uNoise, r2 * 2.3 + 0.4).a * 0.3;
          float cd = smoothstep(0.6, 0.92, ci) * uCirrus * (1.0 - uStorm);
          vec3 ccol = uLightColor * (0.45 + 1.3 * pow(max(mu, 0.0), 6.0)) + uAmbTop * 0.85;
          float ca = cd * 0.3;
          // 合成：积云盖在卷云上
          vec3 outc = mix(ccol, col, alpha);
          float outa = alpha + ca * (1.0 - alpha);
          if (outa > 0.0) outc = (col * alpha + ccol * ca * (1.0 - alpha)) / outa;
          // 大气透视：越远越接近地平线颜色、越透明
          float haze = 1.0 - exp(-t / 52000.0);
          outc = mix(outc, uHorizon, haze * 0.8);
          // 全阴的风暴天云层一直盖到地平线（CIE 全阴天空：地平线亮度只有天顶的 1/3），不露出后面的亮天
          outa *= (1.0 - haze * 0.55 * (1.0 - uStorm)) * mix(smoothstep(0.004, 0.06, d.y), 1.0, uStorm);
          if (outa < 0.003) discard;
          gl_FragColor = vec4(min(outc, vec3(40.0)), outa);
        }`,
      transparent: true, depthWrite: false, side: THREE.BackSide,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(30000, 64, 32, 0, TAU, 0, Math.PI * 0.52), this.cloudMat);
    this.clouds.frustumCulled = false; this.clouds.renderOrder = -7;
    this.object.add(this.clouds);

    // —— 闪电：一条带分叉的折线，只在闪的那几帧可见 ——
    this.boltMat = new THREE.LineBasicMaterial({ color: new THREE.Color(14, 15, 20), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.boltGeo = new THREE.BufferGeometry();
    this.boltGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(400 * 3), 3));
    this.bolt = new THREE.LineSegments(this.boltGeo, this.boltMat);
    this.bolt.frustumCulled = false; this.bolt.renderOrder = -6; this.bolt.visible = false;
    this.object.add(this.bolt);

    // —— 主光源（可选加入场景）——
    this.keyLight = new THREE.DirectionalLight(0xffffff, 3);
    this.keyLight.castShadow = !!shadows;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    const sc = this.keyLight.shadow.camera; sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 450;
    this.keyLight.shadow.bias = -0.0004; this.keyLight.shadow.normalBias = 0.04;
    this.lights = new THREE.Group(); this.lights.name = 'SkyEnvironment.lights';
    this.lights.add(this.keyLight, this.keyLight.target);

    // —— 天空立方体 + PMREM ——
    this.cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    this.cubeCam = new THREE.CubeCamera(1, 60000, this.cubeRT);
    // 只含天空（不含云）的小立方体：探针用它算 skyAmbient，给云打环境光
    this.skyCubeRT = new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    this.skyCubeCam = new THREE.CubeCamera(1, 60000, this.skyCubeRT);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this._cubeTimer = 99; this._pmremTimer = 99;
    this._lastCubeSun = new THREE.Vector3(9, 9, 9); this._lastEnvSun = new THREE.Vector3(9, 9, 9);
    this._lastCubeCover = -1; this._lastCubeStorm = -1;

    // —— 雾补丁共享的 uniform ——
    this.fogUniforms = { uSkyFogCube: { value: this.cubeRT.texture }, uSkyFogDensity: { value: 0.00016 } };

    // —— 环境探针：从立方体积分出 ambient / horizon，异步读回 CPU ——
    this._setupProbe();
  }

  get envMap() { return this.cubeRT.texture; }
  get environment() { return this.envRT ? this.envRT.texture : null; }
  get maxMipLevel() { return Math.log2(this.cubeSize); }
  get fogDensity() { return this.fogUniforms.uSkyFogDensity.value; }
  set fogDensity(v) { this.fogUniforms.uSkyFogDensity.value = v; }

  // 时刻 → 太阳方向。纬度 lat（弧度）让正午太阳偏向 +z；azimuth 绕 y 轴整体旋转太阳轨迹（方便把太阳放到镜头想要的位置）
  // 默认：6 点日出在东（+x），18 点日落在西（−x）
  static sunDirectionAt(hours, out = new THREE.Vector3(), lat = 0.26, azimuth = 0) {
    const H = (hours - 12) / 24 * TAU;
    out.set(-Math.sin(H), Math.cos(H) * Math.cos(lat), Math.cos(H) * Math.sin(lat));
    if (azimuth) { const c = Math.cos(azimuth), s = Math.sin(azimuth), x = out.x, z = out.z; out.x = c * x - s * z; out.z = s * x + c * z; }
    return out.normalize();
  }

  // 太阳在海平面的颜色：Kasten–Young 大气质量 + 分通道消光（高度角越低越红）
  static sunColorForElevation(e, out = new THREE.Color()) {
    const elev = Math.asin(clamp(e, -1, 1)), zenDeg = 90 - elev * 180 / Math.PI;
    const am = 1 / (Math.max(Math.cos((zenDeg * Math.PI) / 180), 0) + 0.15 * Math.pow(Math.max(93.885 - zenDeg, 0.05), -1.253));
    return out.setRGB(Math.exp(-0.032 * am) / 0.968, Math.exp(-0.075 * am) / 0.928, Math.exp(-0.19 * am) / 0.827);
  }

  // 噪声组合值 n（与着色器 cloudDensity 里的 n 相同）
  _cloudN(u, v) {
    const N = this.noise;
    const wx = (sampleCh(N, 0, u * 0.47 + 0.13, v * 0.47 + 0.71) - 0.5) * 0.13, wy = (sampleCh(N, 1, u * 0.47 + 0.13, v * 0.47 + 0.71) - 0.5) * 0.13;
    const qu = u + wx, qv = v + wy;
    return sampleCh(N, 0, qu, qv) * 0.5 + sampleCh(N, 2, qu * 1.73 + 0.31, qv * 1.73 + 0.17) * 0.36 + sampleCh(N, 1, qu * 4.1 + 0.77, qv * 4.1 + 0.4) * 0.14;
  }
  _quantile(q) { const a = this._nq; return a[clamp(Math.round(q * (a.length - 1)), 0, a.length - 1)]; }
  // 覆盖率 → 着色器阈值 (lo, w)
  _coverThresholds(cover) {
    const spread = this._quantile(0.97) - this._quantile(0.03);
    const w = spread * 0.42;
    const q = this._quantile(clamp(1 - cover, 0.001, 0.999));
    this._lo = q - w * 0.5; this._w = w;
  }
  // CPU 版云密度（与着色器 cloudDensity 同一公式），用于太阳被云挡住时减弱直射光
  cloudDensityAtDirection(dir) {
    if (dir.y < 0.004) return 0;
    const t = 1500 / (dir.y + 0.035);
    const u = dir.x * t / 14000 + this._cloudOfs.x, v = dir.z * t / 14000 + this._cloudOfs.y;
    const N = this.noise;
    const wx = (sampleCh(N, 0, u * 0.47 + 0.13, v * 0.47 + 0.71) - 0.5) * 0.13, wy = (sampleCh(N, 1, u * 0.47 + 0.13, v * 0.47 + 0.71) - 0.5) * 0.13;
    const qu = u + wx, qv = v + wy;
    const n = this._cloudN(u, v);
    let d = smoothstep(this._lo, this._lo + this._w, n);
    const fine = sampleCh(N, 3, qu * 9.7 + 0.5, qv * 9.7 + 0.21);
    d = clamp(d - (1 - d) * (fine - 0.35) * 0.7, 0, 1);
    return d;
  }

  update(dt, { camera, timeOfDay = this.timeOfDay, cloudCover = this.cloudCover, storm = this.storm, wind, latitude = this.latitude, sunAzimuth = this.sunAzimuth, shadowTarget } = {}) {
    dt = Math.max(0, dt || 0);
    this._elapsed += dt;
    this.timeOfDay = timeOfDay; this.cloudCover = clamp(cloudCover, 0, 1); this.storm = clamp(storm, 0, 1);
    this.latitude = latitude; this.sunAzimuth = sunAzimuth;
    const st = this.storm;

    // —— 太阳 / 月亮方向 ——
    SkyEnvironment.sunDirectionAt(timeOfDay, this.sunDirection, latitude, sunAzimuth);
    SkyEnvironment.sunDirectionAt(timeOfDay - 11.4, this.moonDirection, latitude + 0.16, sunAzimuth);   // 黄昏时满月从东边升起
    const e = this.sunDirection.y;
    this.night = smoothstep(0.03, -0.16, e);

    // —— 云随风漂移（云层的风比海面大一些）——
    if (wind) {
      const k = dt / 14000 * 1.6;
      this._cloudOfs.x = (this._cloudOfs.x + wind.x * k) % 1; this._cloudOfs.y = (this._cloudOfs.y + wind.y * k) % 1;
      const k2 = dt / 42000 * 2.4, wl = Math.hypot(wind.x, wind.y) || 1;
      this._cirrusOfs.x = (this._cirrusOfs.x + wl * k2 * 0.35) % 1;   // 卷云坐标已对齐风向
      this.cloudMat.uniforms.uWindDir.value.set(wind.x, wind.y);
    }

    // —— 太阳光：大气消光 × 云遮挡 × 风暴 ——
    this._coverThresholds(lerp(this.cloudCover, 0.97, st * 0.9));
    const sunUp = smoothstep(-0.035, 0.05, e);
    SkyEnvironment.sunColorForElevation(e, this.sunColor);
    const occ = 1 - 0.82 * this.cloudDensityAtDirection(this.sunDirection);
    this._sunOcc = lerp(this._sunOcc, occ, 1 - Math.exp(-dt * 2.5));
    this.sunColor.multiplyScalar(sunUp * (1 - st * 0.78) * this._sunOcc);

    // —— 月光：日落后再淡入，保证主光源切换时两者都接近 0 ——
    const moonUp = smoothstep(-0.04, 0.12, this.moonDirection.y);
    const moonIn = smoothstep(-0.02, -0.12, e);
    this.moonColor.setRGB(0.5, 0.6, 0.92).multiplyScalar(0.24 * moonUp * moonIn * (1 - st * 0.75));

    const useMoon = e < -0.025;
    this.keyLightDirection.copy(useMoon ? this.moonDirection : this.sunDirection);
    if (this.keyLightDirection.y < 0.02) this.keyLightDirection.y = 0.02;
    this.keyLightDirection.normalize();
    this.keyLightColor.copy(useMoon ? this.moonColor : this.sunColor);

    // —— 环境光：探针读回之前先用解析近似 ——
    const day = smoothstep(-0.05, 0.35, e), dusk = smoothstep(-0.12, 0.02, e) * (1 - smoothstep(0.05, 0.3, e));
    const ambGuess = _c.setRGB(0.010, 0.016, 0.03).lerp(new THREE.Color(0.32, 0.25, 0.30), dusk).lerp(new THREE.Color(0.36, 0.5, 0.74), day);
    ambGuess.lerp(new THREE.Color(0.17, 0.19, 0.22), st * 0.7);
    const kA = 1 - Math.exp(-dt * 3);
    if (this._probeReady) { this.skyAmbient.lerp(this._probeSkyAmb, kA); this.skyHorizon.lerp(this._probeSkyHor, kA); }
    else { this.skyAmbient.copy(ambGuess); this.skyHorizon.copy(ambGuess).multiplyScalar(1.5); }
    if (this._probeReady) {
      this.ambientColor.lerp(this._probeAmb, kA); this.horizonColor.lerp(this._probeHor, kA); this.horizonKeyColor.lerp(this._probeHorKey, kA);
    } else {
      this.ambientColor.copy(ambGuess);
      this.horizonColor.copy(ambGuess).multiplyScalar(1.5);
      this.horizonKeyColor.copy(this.horizonColor).lerp(this.sunColor, 0.3);
    }
    this.environmentIntensity = lerp(0.2, 0.75, smoothstep(-0.1, 0.25, e));

    // —— 闪电 ——
    this._updateLightning(dt, st);

    // —— 天空 uniform ——
    const su = this.sky.material.uniforms;
    su.sunPosition.value.copy(this.sunDirection).multiplyScalar(450000);
    su.uNight.value = this.night; su.uStorm.value = st;
    su.turbidity.value = lerp(lerp(5.0, 2.4, smoothstep(0.05, 0.5, e)), 9, st);
    su.rayleigh.value = lerp(lerp(2.6, 1.9, smoothstep(0.05, 0.5, e)), 0.6, st);
    su.uGround.value.copy(this.horizonColor).multiplyScalar(0.18);

    // —— 云的光照：白天用“高处的太阳色”（太阳落下后云还被照着 → 晚霞），夜里用月光 ——
    const cu = this.cloudMat.uniforms;
    const eCloud = e + 0.06;
    const cloudSun = SkyEnvironment.sunColorForElevation(eCloud, new THREE.Color()).multiplyScalar(smoothstep(-0.03, 0.06, eCloud) * (1 - st * 0.72));
    const moonForClouds = this.moonColor.clone().multiplyScalar(1.6);
    if (useMoon) { cu.uLightDir.value.copy(this.moonDirection); cu.uLightColor.value.copy(moonForClouds).add(cloudSun.multiplyScalar(0.9)); }
    else { cu.uLightDir.value.copy(this.sunDirection); if (cu.uLightDir.value.y < 0.01) { cu.uLightDir.value.y = 0.01; cu.uLightDir.value.normalize(); } cu.uLightColor.value.copy(cloudSun); }
    // 风暴时云层上方的晴空光照不到云底：环境光整体压暗；但全阴天的云底仍是天顶最亮、地平线最暗
    // （CIE 全阴天空），不能让地平线的亮带比头顶亮 —— 否则海面掠射反光比泡沫还亮，白浪看不见
    cu.uAmbTop.value.copy(this.skyAmbient).multiplyScalar(lerp(1.05, 0.62, st));
    cu.uAmbBottom.value.copy(this.skyAmbient).multiplyScalar(lerp(0.32, 0.3, st)).lerp(_c.setRGB(0.05, 0.055, 0.06), st * 0.15);
    cu.uHorizon.value.copy(this.skyHorizon).multiplyScalar(1 - 0.45 * st);
    cu.uLo.value = this._lo; cu.uW.value = this._w; cu.uStorm.value = st;
    cu.uCirrus.value = smoothstep(0.05, 0.35, this.cloudCover) * (1 - smoothstep(0.7, 0.95, this.cloudCover));
    cu.uFlash.value = this.lightning;

    this.starMat.uniforms.uNight.value = this.night * (1 - st) * (1 - this.cloudCover * 0.5);
    this.starMat.uniforms.uTime.value = this._elapsed;
    this.starMat.uniforms.uPR.value = this.renderer.getPixelRatio();

    // —— 跟随相机 ——
    const camPos = camera ? camera.position : _v.set(0, 0, 0);
    this.object.position.copy(camPos);
    this.object.updateMatrixWorld();
    const r = 24000;
    this.moon.position.copy(this.moonDirection).multiplyScalar(r);
    this.moonGlow.position.copy(this.moon.position);
    this.moon.visible = this.moonGlow.visible = this.moonDirection.y > 0.005;
    this.moonGlow.material.opacity = (0.1 + 0.45 * this.night) * smoothstep(0.005, 0.06, this.moonDirection.y) * (1 - st * 0.8);
    this.moonMat.uniforms.uBright.value = (1.2 + 2.4 * this.night) * (1 - st * 0.85);

    // —— 主光源 ——
    const kc = this.keyLightColor, km = Math.max(kc.r, kc.g, kc.b, 1e-4);
    this.keyLight.color.setRGB(kc.r / km, kc.g / km, kc.b / km);
    this.keyLight.intensity = 3.1 * km + this.lightning * 1.5;
    const tgt = shadowTarget || camPos;
    this.keyLight.position.copy(tgt).addScaledVector(this.keyLightDirection, 200);
    this.keyLight.target.position.copy(tgt);
    this.keyLight.target.updateMatrixWorld();

    // —— 立方体 / PMREM 刷新 ——
    this._cubeTimer += dt; this._pmremTimer += dt;
    const sunMoved = this._lastCubeSun.distanceToSquared(this.sunDirection) > 4e-6;
    if (this._lastCubeSun.distanceToSquared(this.sunDirection) > 1e-3 || Math.abs(this._lastCubeCover - this.cloudCover) > 0.15 || Math.abs(this._lastCubeStorm - st) > 0.15) this._snapAfter = this._probeId + 1;
    const cloudChanged = Math.abs(this._lastCubeCover - this.cloudCover) > 0.01 || Math.abs(this._lastCubeStorm - st) > 0.01;
    if (this._cubeTimer > 0.5 || sunMoved || cloudChanged) this._renderCube();
    if (this._pmremTimer > 2.5 || this._lastEnvSun.distanceToSquared(this.sunDirection) > 4e-4 || !this.envRT) this._renderEnv();
    return this;
  }

  forceUpdate() { this._renderCube(); this._renderEnv(); }

  _renderCube() {
    const su = this.sky.material.uniforms, cu = this.cloudMat.uniforms;
    const flash = cu.uFlash.value, boltVis = this.bolt.visible;
    su.uSunDisk.value = 0; cu.uFlash.value = 0; this.bolt.visible = false;
    this.cubeCam.position.copy(this.object.position);
    this.cubeCam.updateMatrixWorld();
    this.cubeCam.update(this.renderer, this.object);
    this.skyCubeCam.position.copy(this.object.position); this.skyCubeCam.updateMatrixWorld();
    this.skyCubeCam.update(this.renderer, this.sky);
    su.uSunDisk.value = 1; cu.uFlash.value = flash; this.bolt.visible = boltVis;
    this._cubeTimer = 0; this._lastCubeSun.copy(this.sunDirection);
    this._lastCubeCover = this.cloudCover; this._lastCubeStorm = this.storm;
    this._runProbe();
  }

  _renderEnv() {
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    this._pmremTimer = 0; this._lastEnvSun.copy(this.sunDirection);
  }

  // —— 探针：在立方体上按余弦权重积分上半球、按一圈取地平线，结果读回 CPU ——
  _setupProbe() {
    const r = this.renderer, ext = r.extensions;
    const floatOK = ext.has('EXT_color_buffer_float');
    const halfOK = floatOK || ext.has('EXT_color_buffer_half_float');
    if (!halfOK || typeof r.readRenderTargetPixelsAsync !== 'function') { this._probeRT = null; return; }
    this._probeType = floatOK ? THREE.FloatType : THREE.HalfFloatType;
    this._probeRT = new THREE.WebGLRenderTarget(8, 1, { type: this._probeType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this._probeBuf = this._probeType === THREE.FloatType ? new Float32Array(32) : new Uint16Array(32);
    // 余弦加权的上半球方向（Fibonacci）+ 地平线一圈
    const hemi = [], N = 48;
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N, phi = i * 2.399963;          // 黄金角
      const ct = Math.sqrt(1 - u), st2 = Math.sqrt(u);       // 余弦分布：cosθ = sqrt(1−u)
      hemi.push(new THREE.Vector3(Math.cos(phi) * st2, ct, Math.sin(phi) * st2));
    }
    const ring = [];
    for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; ring.push(new THREE.Vector3(Math.cos(a), 0.035, Math.sin(a)).normalize()); }
    const lod = Math.max(0, Math.log2(this.cubeSize) - 4);
    this._probeMat = new THREE.ShaderMaterial({
      uniforms: { uCube: { value: this.cubeRT.texture }, uHemi: { value: hemi }, uRing: { value: ring }, uKey: { value: new THREE.Vector3(1, 0, 0) }, uLod: { value: lod }, uSkyCube: { value: this.skyCubeRT.texture } },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`uniform samplerCube uCube; uniform vec3 uHemi[48]; uniform vec3 uRing[16]; uniform vec3 uKey; uniform float uLod; uniform samplerCube uSkyCube;
        void main(){
          float x = floor(gl_FragCoord.x);
          vec3 s = vec3(0.0);
          if (x < 0.5) { for (int i = 0; i < 48; i++) s += textureLod(uCube, uHemi[i], uLod).rgb; s /= 48.0; }
          else if (x < 1.5) { for (int i = 0; i < 16; i++) s += textureLod(uCube, uRing[i], uLod).rgb; s /= 16.0; }
          else if (x < 2.5) {
            vec2 k = normalize(uKey.xz + vec2(1e-4, 0.0));
            for (int i = -2; i <= 2; i++) { float a = float(i) * 0.25; vec2 r = vec2(k.x * cos(a) - k.y * sin(a), k.x * sin(a) + k.y * cos(a)); s += textureLod(uCube, normalize(vec3(r.x, 0.035, r.y)), uLod).rgb; }
            s /= 5.0;
          } else if (x < 3.5) { s = textureLod(uCube, vec3(0.0, 1.0, 0.0), uLod).rgb; }
          else if (x < 4.5) { for (int i = 0; i < 48; i++) s += textureLod(uSkyCube, uHemi[i], 1.0).rgb; s /= 48.0; }
          else { for (int i = 0; i < 16; i++) s += textureLod(uSkyCube, uRing[i], 1.0).rgb; s /= 16.0; }
          gl_FragColor = vec4(s, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._probeMat); quad.frustumCulled = false;
    this._probeScene = new THREE.Scene(); this._probeScene.add(quad);
    this._probeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  _runProbe() {
    if (!this._probeRT) return;
    if (this._probeBusy) { this._probeQueued = true; return; }
    const id = ++this._probeId;
    const r = this.renderer;
    this._probeMat.uniforms.uKey.value.copy(this.keyLightDirection);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this._probeRT); r.render(this._probeScene, this._probeCam); r.setRenderTarget(prev);
    this._probeBusy = true;
    r.readRenderTargetPixelsAsync(this._probeRT, 0, 0, 8, 1, this._probeBuf).then((buf) => {
      const f = this._probeType === THREE.FloatType ? (i) => buf[i] : (i) => THREE.DataUtils.fromHalfFloat(buf[i]);
      const ok = [0, 1, 2, 4, 5, 6, 8, 9, 10].every((i) => Number.isFinite(f(i)));
      if (ok) {
        this._probeAmb.setRGB(f(0), f(1), f(2));
        this._probeHor.setRGB(f(4), f(5), f(6));
        this._probeHorKey.setRGB(f(8), f(9), f(10));
        this._probeSkyAmb.setRGB(f(16), f(17), f(18));
        this._probeSkyHor.setRGB(f(20), f(21), f(22));
        if (!this._probeReady || (this._snapAfter && id >= this._snapAfter)) {
          this.ambientColor.copy(this._probeAmb); this.horizonColor.copy(this._probeHor); this.horizonKeyColor.copy(this._probeHorKey);
          this.skyAmbient.copy(this._probeSkyAmb); this.skyHorizon.copy(this._probeSkyHor); this._snapAfter = 0;
        }
        this._probeReady = true;
      }
      this._probeBusy = false;
      if (this._probeQueued) { this._probeQueued = false; this._runProbe(); }
    }).catch(() => { this._probeBusy = false; this._probeRT = null; });
    // three r170 发起异步读取后没有解绑 PIXEL_PACK_BUFFER，之后任何同步 readPixels 都会失败（与 OceanSimulation 相同的处理）
    const gl = r.getContext(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  // —— 闪电：storm > 0.6 时随机触发，每次 2–3 个脉冲 ——
  _updateLightning(dt, st) {
    const F = this._flash;
    F.t += dt;
    if (st > 0.6) {
      F.next -= dt * (0.5 + (st - 0.6) * 2.5);
      if (F.next <= 0) {
        F.next = 2.5 + Math.random() * 7;
        F.t = 0;
        const n = 1 + Math.floor(Math.random() * 3);
        // 每个脉冲至少持续 ~0.12 s：低帧率（10–20 fps）下也不会被跳过
        let at = 0;
        F.pulses = Array.from({ length: n }, (_, i) => { const p = { at, amp: i === 0 ? 1 : 0.45 + Math.random() * 0.55, dur: 0.12 + Math.random() * 0.15 }; at += 0.1 + Math.random() * 0.18; return p; });
        const az = Math.random() * TAU, dist = 3000 + Math.random() * 9000;
        this.lightningDirection.set(Math.cos(az), 1500 / dist, Math.sin(az)).normalize();
        this.lastStrike = { azimuth: az, distance: dist };
        this.strikes++;
        this._buildBolt(az, dist);
      }
    }
    let L = 0;
    for (const p of F.pulses) { const x = (F.t - p.at) / p.dur; if (x >= 0) L = Math.max(L, p.amp * (x < 0.25 ? 0.6 + 1.6 * x : Math.exp(-(x - 0.25) * 1.3))); }
    this.lightning = clamp(L, 0, 1) * smoothstep(0.55, 0.75, st);
    this.bolt.visible = this.lightning > 0.25;
    this.boltMat.opacity = clamp(this.lightning * 1.3, 0, 1);
  }

  _buildBolt(az, dist) {
    const pos = this.boltGeo.attributes.position.array; let n = 0;
    const dirX = Math.cos(az), dirZ = Math.sin(az), sideX = -dirZ, sideZ = dirX;
    const seg = (a, b) => { if (n + 6 > pos.length) return; pos.set([a[0], a[1], a[2], b[0], b[1], b[2]], n); n += 6; };
    const walk = (x, y, z, steps, spread, branchP) => {
      let px = x, py = y, pz = z;
      for (let i = 0; i < steps && py > -20; i++) {
        const nx = px + sideX * (Math.random() - 0.5) * spread + dirX * (Math.random() - 0.5) * spread * 0.4;
        const nz = pz + sideZ * (Math.random() - 0.5) * spread + dirZ * (Math.random() - 0.5) * spread * 0.4;
        const ny = py - (1500 / steps) * (0.6 + Math.random() * 0.8);
        seg([px, py, pz], [nx, ny, nz]);
        if (Math.random() < branchP) walk(nx, ny, nz, Math.floor(steps * 0.35), spread * 0.7, 0);
        px = nx; py = ny; pz = nz;
      }
    };
    walk(dirX * dist, 1500, dirZ * dist, 26, 110, 0.12);
    this.boltGeo.setDrawRange(0, n / 3);
    this.boltGeo.attributes.position.needsUpdate = true;
  }

  // 给任意内置材质（MeshStandard / Physical / Lambert / Basic…）换上“按视线方向取天空色”的雾：
  // 和海面同一个公式，所以船、岛、海在远处融成一色
  applyFog(material) {
    const shared = this.fogUniforms;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (sh, r) => {
      if (prev) prev(sh, r);
      sh.uniforms.uSkyFogCube = shared.uSkyFogCube; sh.uniforms.uSkyFogDensity = shared.uSkyFogDensity;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSkyFogW;')
        .replace('#include <fog_vertex>', `#include <fog_vertex>
          vec4 skyFogP = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            skyFogP = instanceMatrix * skyFogP;
          #endif
          vSkyFogW = (modelMatrix * skyFogP).xyz;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vSkyFogW; uniform samplerCube uSkyFogCube; uniform float uSkyFogDensity;')
        .replace('#include <fog_fragment>', `{
          vec3 fdv = vSkyFogW - cameraPosition; float fdist = length(fdv); fdv /= max(fdist, 1e-3);
          vec3 fhd = normalize(vec3(fdv.x, max(fdv.y, 0.0) + 0.012, fdv.z));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, textureLod(uSkyFogCube, fhd, 2.5).rgb, 1.0 - exp(-uSkyFogDensity * fdist));
        }`);
    };
    const prevKey = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : () => '';
    material.customProgramCacheKey = () => prevKey() + '|skyfog';
    material.needsUpdate = true;
    return material;
  }

  static _glowTexture() {
    const s = 128, data = new Uint8Array(s * s * 4);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = (x + 0.5) / s * 2 - 1, dy = (y + 0.5) / s * 2 - 1, r = Math.sqrt(dx * dx + dy * dy);
      const a = r >= 1 ? 0 : Math.pow(1 - r, 2.2) * 0.75 + Math.exp(-r * r * 40) * 0.25;
      const i = (y * s + x) * 4; data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
    const t = new THREE.DataTexture(data, s, s, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  }

  dispose() {
    this.object.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.noise.tex.dispose(); this.glowTex.dispose();
    this.cubeRT.dispose(); this.skyCubeRT.dispose(); if (this.envRT) this.envRT.dispose(); this.pmrem.dispose();
    if (this._probeRT) { this._probeRT.dispose(); this._probeMat.dispose(); this._probeScene.children[0].geometry.dispose(); }
    this.keyLight.dispose();
  }
}
