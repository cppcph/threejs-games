// =====================================================================================
// 信风 Windpost · 群岛邮船
//
// 海面、天空、帆船都来自仓库里的共享模块：
//   ocean/Ocean.js              风驱动的 GPU FFT 海面（WindSeaModel）：白浪场、泡沫光学、浅滩与岸线泡沫、平面反射、尾迹
//   ocean/SkyEnvironment.js     天空、云、日月星、闪电、反射立方体、PMREM（光照单位与 Ocean 一致）
//   ocean/vessel/               SailingYacht：六自由度帆船（船体水压积分、阻力、龙骨 / 舵、ORC 帆、辅机、触底）
//   ocean/extras/Sailboat.js    画面船体（与物理同一组型线参数）
//   ocean/WakeMap.js、Spray.js  尾迹图、飞沫；extras/BowWave.js 船首浪破碎泡沫与水片；CinematicComposer.js 后期
// 游戏自己负责：群岛地形、码头、灯塔、浮标、漂流瓶、任务、相机、输入、HUD、声音、渲染面板。
//
// 坐标：世界 −Z 为北、+X 为东；船体坐标船首 +Z、左舷 +X；yaw = three.js rotation.y，船首方向 (sin yaw, cos yaw)。
// 罗经方位 0° = 北，顺时针；真风角 / 视风角带符号，+ = 右舷来风。
// =====================================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Ocean, OCEAN_QUALITY } from '../../ocean/Ocean.js';
import { OCEAN_LOOK } from '../../ocean/OceanMaterial.js';
import { Buoyancy } from '../../ocean/Buoyancy.js';
import { SkyEnvironment } from '../../ocean/SkyEnvironment.js';
import { CinematicComposer } from '../../ocean/CinematicComposer.js';
import { WakeMap } from '../../ocean/WakeMap.js';
import { Spray, SpumeEmitter } from '../../ocean/Spray.js';
import { Sailboat } from '../../ocean/extras/Sailboat.js';
import { BowWave } from '../../ocean/extras/BowWave.js';
import { SailingYacht } from '../../ocean/vessel/index.js';
import { optimalBoom } from '../../ocean/vessel/Sails.js';
import { applyToThree, emitSpray, driveWake } from '../../ocean/vessel/three-adapter.js';

// =====================================================================================
// 0. 小工具：随机数、插值、值噪声
// =====================================================================================
const TAU = Math.PI * 2, DEG = Math.PI / 180;
const KN2MS = 1852 / 3600, MS2KN = 3600 / 1852;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function mulberry32(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function hash2(ix, iy, seed) { let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
}
function fbm(x, y, seed = 0, oct = 4) { let s = 0, a = 0.5, f = 1, n = 0; for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; } return s / n; }
const fmtTime = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('windpost.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('windpost.' + k, JSON.stringify(v)); } catch (e) { /* 存储不可用 */ } },
};
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
// 气象习惯的“来向”方位（0° 北、90° 东）→ 风矢量（指向下风；x 东、y 南）
const windVector = (U, fromDeg, out = new THREE.Vector2()) => { const b = fromDeg * DEG; return out.set(-Math.sin(b) * U, Math.cos(b) * U); };
const bearingOf = (x, z) => ((Math.atan2(x, -z) / DEG) % 360 + 360) % 360;          // 世界水平向量 → 罗经方位（度）
const yawOfBearing = (deg) => Math.PI - deg * DEG;                                    // 罗经方位 → yaw

// =====================================================================================
// 1. IslandField —— 群岛地形 / 水深
//    解析函数 height(x,z) 生成岛屿网格；同一函数烘焙成半精度纹理交给海面（ocean.setBathymetry：浅滩颜色、
//    岸线泡沫、浅水消波）。CPU 侧 sample() 按与 GPU 相同的纹素中心做双线性插值，船的触底、相机、小地图都用它。
// =====================================================================================
class IslandField {
  constructor(defs, { min = -1150, size = 2300, res = 1024 } = {}) {
    this.defs = defs; this.min = min; this.size = size; this.res = res;
    this.data = null; this.texture = null;
  }
  islandH(is, x, z) {
    const dx = x - is.x, dz = z - is.z, d = Math.hypot(dx, dz), R = is.r;
    if (d > R * (1.75 + is.shelf)) return -1e9;
    const ang = Math.atan2(dz, dx);
    const warp = 1 + 0.2 * fbm(Math.cos(ang) * 1.4 + is.seed, Math.sin(ang) * 1.4 - is.seed, is.seed, 3) + 0.13 * fbm(x * 0.011, z * 0.011, is.seed + 5, 3);
    let u = d / (R * warp);
    if (is.bay !== undefined) {   // 月牙形海湾
      const bx = is.x + Math.cos(is.bay) * R * 0.92, bz = is.z + Math.sin(is.bay) * R * 0.92;
      const bd = Math.hypot(x - bx, z - bz) / (R * 0.6);
      u = lerp(u, Math.max(u, 1.3), smoothstep(1.0, 0.5, bd));
    }
    if (u < 1) {
      const hills = 0.7 + 0.55 * fbm(x * 0.014, z * 0.014, is.seed + 9, 4);
      return 0.45 + is.peak * Math.pow(1 - u, is.rocky ? 0.85 : 1.5) * hills;
    }
    const s1 = smoothstep(1.0, 1.0 + is.shelf, u);
    const reef = 0.8 * fbm(x * 0.05, z * 0.05, is.seed + 3, 2);
    const hs = 0.45 - 3.7 * s1 + reef * s1;
    const s2 = smoothstep(1.0 + is.shelf * 0.8, 1.0 + is.shelf + 0.55, u);
    return lerp(hs, -36, s2);
  }
  height(x, z) {
    let h = -36 + 3 * fbm(x * 0.002, z * 0.002, 99, 2);
    for (const is of this.defs) { const v = this.islandH(is, x, z); if (v > h) h = v; }
    return h;
  }
  bake() {
    const n = this.res, half = new Uint16Array(n * n), data = new Float32Array(n * n);
    const step = this.size / n;
    for (let j = 0; j < n; j++) {
      const z = this.min + (j + 0.5) * step;
      for (let i = 0; i < n; i++) {
        const x = this.min + (i + 0.5) * step;
        const h16 = THREE.DataUtils.toHalfFloat(clamp(this.height(x, z), -60, 200));
        half[j * n + i] = h16; data[j * n + i] = THREE.DataUtils.fromHalfFloat(h16);
      }
    }
    this.data = data;
    const tex = new THREE.DataTexture(half, n, n, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
    this.texture = tex;
    this.rect = new THREE.Vector4(this.min, this.min, this.size, this.size);   // Ocean.setBathymetry：minX, minZ, sizeX, sizeZ
    return tex;
  }
  // 与 GPU 线性过滤一致的双线性采样（纹素中心在 (i+0.5)/n）
  sample(x, z) {
    const n = this.res;
    const u = (x - this.min) / this.size, v = (z - this.min) / this.size;
    if (u < 0 || v < 0 || u > 1 || v > 1 || !this.data) return -40;
    const fx = u * n - 0.5, fz = v * n - 0.5;
    const i0 = clamp(Math.floor(fx), 0, n - 1), j0 = clamp(Math.floor(fz), 0, n - 1);
    const i1 = Math.min(i0 + 1, n - 1), j1 = Math.min(j0 + 1, n - 1);
    const tx = clamp(fx - i0, 0, 1), tz = clamp(fz - j0, 0, 1), D = this.data;
    return lerp(lerp(D[j0 * n + i0], D[j0 * n + i1], tx), lerp(D[j1 * n + i0], D[j1 * n + i1], tx), tz);
  }
  gradient(x, z, e = 2) { return [(this.sample(x + e, z) - this.sample(x - e, z)) / (2 * e), (this.sample(x, z + e) - this.sample(x, z - e)) / (2 * e)]; }
}

// =====================================================================================
// 2. PlanarReflection —— y=0 平面的镜像相机（斜近裁剪面，Lengyel 方法），把船、岛、码头渲染到半分辨率目标，
//    背景透明；交给 ocean.setReflection，海面着色器按 alpha 在天空反射与平面反射之间混合，并按法线扰动 UV。
// =====================================================================================
class PlanarReflection {
  constructor(w, h) {
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
    this.cam = new THREE.PerspectiveCamera(); this.textureMatrix = new THREE.Matrix4();
    this._n = new THREE.Vector3(0, 1, 0); this._p = new THREE.Vector3(); this._cp = new THREE.Vector3(); this._view = new THREE.Vector3(); this._look = new THREE.Vector3();
    this._target = new THREE.Vector3(); this._rot = new THREE.Matrix4(); this._plane = new THREE.Plane(); this._clip = new THREE.Vector4(); this._q = new THREE.Vector4();
    this._clear = new THREE.Color();
  }
  setSize(w, h) { this.rt.setSize(Math.max(2, w), Math.max(2, h)); }
  render(renderer, scene, camera, hide) {
    const n = this._n, cp = this._cp.setFromMatrixPosition(camera.matrixWorld);
    this._p.set(cp.x, 0, cp.z);
    const view = this._view.subVectors(this._p, cp);
    if (view.dot(n) > 0) return;
    view.reflect(n).negate().add(this._p);
    this._rot.extractRotation(camera.matrixWorld);
    const look = this._look.set(0, 0, -1).applyMatrix4(this._rot).add(cp);
    const target = this._target.subVectors(this._p, look).reflect(n).negate().add(this._p);
    const vc = this.cam;
    vc.position.copy(view); vc.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(n); vc.lookAt(target);
    vc.far = camera.far; vc.updateMatrixWorld(); vc.projectionMatrix.copy(camera.projectionMatrix);
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    this._plane.setFromNormalAndCoplanarPoint(n, this._p).applyMatrix4(vc.matrixWorldInverse);
    const clip = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const pm = vc.projectionMatrix, q = this._q;
    q.x = (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0]; q.y = (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1; q.w = (1 + pm.elements[10]) / pm.elements[14];
    clip.multiplyScalar(2 / clip.dot(q));
    pm.elements[2] = clip.x; pm.elements[6] = clip.y; pm.elements[10] = clip.z + 1; pm.elements[14] = clip.w;
    const vis = hide.map(o => o.visible); hide.forEach(o => { o.visible = false; });
    const prevAlpha = renderer.getClearAlpha(); renderer.getClearColor(this._clear);
    renderer.setRenderTarget(this.rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, vc);
    renderer.setRenderTarget(null); renderer.setClearColor(this._clear, prevAlpha);
    hide.forEach((o, i) => { o.visible = vis[i]; });
  }
}

// =====================================================================================
// 3. 群岛：岛屿网格（顶点色：湿沙/干沙/草/岩）、椰子树（实例化 + 顶点摆动）、岩石、灌木、
//    码头（栈桥 + 小屋 + 灯笼）、灯塔（旋转光束）、浮标、漂流瓶、目标标记、雨。
//    所有材质都打上 SkyEnvironment 的雾补丁，远处与海面、天空融成一色。
// =====================================================================================
const ISLANDS = [
  { id: 'harbor', name: '灯塔岛', x: -60, z: 40, r: 150, peak: 30, seed: 3, shelf: 0.32, dock: { ang: 0.12, name: '灯塔岛邮局' }, lighthouse: { ang: -0.75 } },
  { id: 'palm', name: '椰影岛', x: 560, z: -340, r: 105, peak: 15, seed: 11, shelf: 0.45, dock: { ang: Math.PI * 0.78, name: '椰影岛码头' } },
  { id: 'whale', name: '鲸背礁', x: 330, z: 420, r: 52, peak: 8, seed: 5, shelf: 0.5, rocky: true },
  { id: 'stone', name: '石门岛', x: -640, z: -380, r: 125, peak: 40, seed: 21, shelf: 0.25, dock: { ang: 0.25, name: '石门岛渡口' }, rocky: true },
  { id: 'moon', name: '月湾岛', x: -560, z: 560, r: 140, peak: 22, seed: 8, shelf: 0.38, bay: -0.55, dock: { ang: -0.62, name: '月湾小筑' } },
  { id: 'fisher', name: '渔村岛', x: 860, z: 260, r: 95, peak: 13, seed: 17, shelf: 0.42, dock: { ang: Math.PI * 1.02, name: '渔村栈桥' } },
  { id: 'i1', name: '小沙洲', x: 90, z: -660, r: 36, peak: 5, seed: 31, shelf: 0.9 },
  { id: 'i2', name: '双子礁', x: -250, z: -820, r: 30, peak: 9, seed: 33, shelf: 0.3, rocky: true },
  { id: 'i3', name: '鸥岛', x: 940, z: -640, r: 46, peak: 10, seed: 35, shelf: 0.5 },
];

function taperedTube(points, radial, r0, r1) {
  const curve = new THREE.CatmullRomCurve3(points), segs = 14, pos = [], col = [], idx = [];
  const frames = curve.computeFrenetFrames(segs, false);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, P = curve.getPointAt(t), N = frames.normals[i], B = frames.binormals[i], r = lerp(r0, r1, t) * (1 + 0.08 * Math.sin(i * 2.6));
    const shade = 0.75 + 0.25 * ((i % 2) ? 1 : 0.7);
    for (let j = 0; j <= radial; j++) { const a = j / radial * TAU; pos.push(P.x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * r, P.y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * r, P.z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * r); col.push(0.42 * shade, 0.32 * shade, 0.22 * shade); }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) { const a = i * (radial + 1) + j, b = a + 1, c = a + radial + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
  return { geo: g, top: curve.getPointAt(1) };
}
function palmCrown(top) {
  const pos = [], col = [], idx = []; let base = 0; const rnd = mulberry32(4);
  for (let f = 0; f < 9; f++) {
    const a = f / 9 * TAU + rnd() * 0.3, len = 3.2 + rnd() * 1.2, droop = 0.9 + rnd() * 0.6, segs = 9;
    const dx = Math.cos(a), dz = Math.sin(a);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, w = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.62 + 0.04;
      const x = top.x + dx * len * t, z = top.z + dz * len * t, y = top.y + Math.sin(t * 1.4) * 0.9 - droop * t * t * 2.2;
      const px = -dz * w, pz = dx * w;
      pos.push(x + px, y - w * 0.25, z + pz, x, y + 0.06, z, x - px, y - w * 0.25, z - pz);
      const g = 0.55 + 0.45 * t; for (let k = 0; k < 3; k++) col.push(0.13 * g + 0.05, 0.36 * g + 0.08, 0.1 * g + 0.03);
    }
    for (let i = 0; i < segs; i++) { const a0 = base + i * 3, b0 = a0 + 3; idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1, a0 + 1, b0 + 1, a0 + 2, a0 + 2, b0 + 1, b0 + 2); }
    base += (segs + 1) * 3;
  }
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU; pos.push(top.x + Math.cos(a) * 0.22, top.y - 0.2, top.z + Math.sin(a) * 0.22); col.push(0.3, 0.2, 0.1); }
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// 椰子树、灌木随风摆动（顶点着色器）
function swayPatch(uTime) {
  return (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.07;
        #else
          float ph = 0.0;
        #endif
        float sw = max(transformed.y, 0.0) * 0.012;
        transformed.x += sin(uTime * 1.3 + ph) * sw * (1.0 + 0.4 * sin(uTime * 3.1 + ph));
        transformed.z += cos(uTime * 1.1 + ph * 1.3) * sw * 0.6;`);
  };
}

function buildWorld(scene, field, sky, quality) {
  const world = { islands: [], docks: [], buoys: [], beams: [], uTime: { value: 0 }, lanterns: [] };
  // 标准材质 + 天空雾（可选再叠一个摆动补丁；补丁要在 applyFog 之前挂上，程序缓存键才会区分开）
  const fogStd = (opts, patch) => {
    const m = new THREE.MeshStandardMaterial(opts);
    if (patch) { m.onBeforeCompile = patch; m.customProgramCacheKey = () => 'sway'; }
    return sky.applyFog(m);
  };
  const glowTex = sky.glowTex;
  const terrainMat = fogStd({ vertexColors: true, roughness: 0.93, metalness: 0 });
  const rnd = mulberry32(2024);
  const C = (h) => new THREE.Color(h);
  const cWet = C('#9d8a64'), cSand = C('#e3cf9c'), cSand2 = C('#d7bf88'), cGrass = C('#5c8b3a'), cGrass2 = C('#7a9b3f'), cGrass3 = C('#3f6f35'), cRock = C('#7a7266'), cRock2 = C('#5f594f'), cUnder = C('#c9b17f');
  const palmPos = [], rockPos = [], bushPos = [];
  for (const is of ISLANDS) {
    const ext = is.r * (1.3 + is.shelf);
    const N = clamp(Math.round(ext * 2 / (quality === 'high' ? 2.0 : 3.2)), 50, 220);
    const pos = [], col = [], idx = [];
    const hs = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const x = is.x - ext + (i / N) * ext * 2, z = is.z - ext + (j / N) * ext * 2;
      const h = field.height(x, z); hs[j * (N + 1) + i] = h; pos.push(x, h, z);
    }
    const step = ext * 2 / N;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const h = hs[j * (N + 1) + i];
      const hx = hs[j * (N + 1) + Math.min(N, i + 1)] - hs[j * (N + 1) + Math.max(0, i - 1)], hz = hs[Math.min(N, j + 1) * (N + 1) + i] - hs[Math.max(0, j - 1) * (N + 1) + i];
      const slope = Math.hypot(hx, hz) / (2 * step);
      const x = pos[(j * (N + 1) + i) * 3], z = pos[(j * (N + 1) + i) * 3 + 2];
      const n1 = fbm(x * 0.05, z * 0.05, 7, 3) * 0.5 + 0.5, n2 = fbm(x * 0.21, z * 0.21, 8, 2) * 0.5 + 0.5;
      let c;
      if (h < -0.3) c = cUnder.clone().lerp(cWet, smoothstep(-3, -0.3, h));
      else if (h < 0.75) c = cWet.clone().lerp(cSand, smoothstep(0.1, 0.75, h));
      else if (h < 2.0 + n1 * 1.5 && slope < 0.5) c = cSand.clone().lerp(cSand2, n2);
      else c = cGrass.clone().lerp(cGrass2, n1).lerp(cGrass3, n2 * 0.6);
      const rocky = smoothstep(0.55, 0.95, slope) + (is.rocky ? smoothstep(2, 6, h) * 0.7 : 0) + smoothstep(is.peak * 0.75, is.peak * 0.95, h);
      if (h > 0.6) c.lerp(cRock.clone().lerp(cRock2, n2), clamp(rocky, 0, 1));
      c.multiplyScalar(0.92 + n2 * 0.16);
      col.push(c.r, c.g, c.b);
      // 植被
      if (h > 1.6 && h < 9 && slope < 0.42 && !is.rocky && rnd() < 0.012) palmPos.push([x, h, z, is]);
      else if (h > 2.2 && slope < 0.6 && rnd() < (is.rocky ? 0.004 : 0.016)) bushPos.push([x, h, z]);
      if (h > -1.6 && h < 1.4 && rnd() < 0.006) rockPos.push([x, h, z, 0.6 + rnd() * 1.3]);
      if (is.rocky && h > 1 && slope > 0.4 && rnd() < 0.01) rockPos.push([x, h, z, 1.2 + rnd() * 2.5]);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      if (Math.max(hs[a], hs[b], hs[c], hs[d]) < -5.5) continue;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, terrainMat); m.receiveShadow = true; m.castShadow = false; scene.add(m);
    world.islands.push({ def: is, mesh: m });
  }
  // —— 椰子树 ——
  const trunk = taperedTube([new THREE.Vector3(0, -0.4, 0), new THREE.Vector3(0.25, 2.5, 0), new THREE.Vector3(0.9, 5.4, 0), new THREE.Vector3(1.9, 7.6, 0)], 7, 0.24, 0.13);
  const crownGeo = palmCrown(trunk.top);
  const trunkMat = fogStd({ vertexColors: true, roughness: 0.9 }, swayPatch(world.uTime)), crownMat = fogStd({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide }, swayPatch(world.uTime));
  const palmT = new THREE.InstancedMesh(trunk.geo, trunkMat, palmPos.length), palmC = new THREE.InstancedMesh(crownGeo, crownMat, palmPos.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), E = new THREE.Euler();
  palmPos.forEach(([x, h, z, is], i) => {
    const out = Math.atan2(z - is.z, x - is.x);     // 朝海倾斜
    E.set(0, -out + (rnd() - 0.5) * 0.9, 0); Q.setFromEuler(E); const s = 0.75 + rnd() * 0.55; S.set(s, s * (0.9 + rnd() * 0.25), s); P.set(x, h, z);
    M.compose(P, Q, S); palmT.setMatrixAt(i, M); palmC.setMatrixAt(i, M);
  });
  palmT.castShadow = palmC.castShadow = true; palmT.receiveShadow = palmC.receiveShadow = true; scene.add(palmT, palmC);
  // —— 岩石、灌木 ——
  const rockGeo = new THREE.IcosahedronGeometry(1, 1); { const pa = rockGeo.attributes.position; for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i), k = 1 + 0.28 * fbm(x * 1.7 + 3, z * 1.7 + y, 4, 2); pa.setXYZ(i, x * k * 1.25, y * k * 0.75, z * k); } rockGeo.computeVertexNormals(); }
  const rocks = new THREE.InstancedMesh(rockGeo, fogStd({ color: 0x6f675c, roughness: 0.95, flatShading: true }), rockPos.length);
  rockPos.forEach(([x, h, z, s], i) => { E.set(rnd() * 0.5, rnd() * TAU, rnd() * 0.5); Q.setFromEuler(E); S.set(s, s, s); P.set(x, h - s * 0.2, z); M.compose(P, Q, S); rocks.setMatrixAt(i, M); });
  rocks.castShadow = rocks.receiveShadow = true; scene.add(rocks);
  const bushGeo = new THREE.IcosahedronGeometry(1, 1);
  const bushes = new THREE.InstancedMesh(bushGeo, fogStd({ color: 0x3c6a2e, roughness: 0.9, flatShading: true }), bushPos.length);
  bushPos.forEach(([x, h, z], i) => { const s = 0.8 + rnd() * 1.4; E.set(0, rnd() * TAU, 0); Q.setFromEuler(E); S.set(s * 1.3, s * 0.8, s); P.set(x, h + s * 0.25, z); M.compose(P, Q, S); bushes.setMatrixAt(i, M); bushes.setColorAt(i, new THREE.Color().setHSL(0.27 + rnd() * 0.06, 0.45, 0.25 + rnd() * 0.1)); });
  bushes.castShadow = true; scene.add(bushes);
  // —— 码头 ——
  const woodGeos = [], hutGeos = [], roofGeos = [];
  const lanternMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.62, 0.28) });
  const lanternGeos = [];
  const addBox = (arr, w, h, d, x, y, z, rotY = 0, color) => { const g = new THREE.BoxGeometry(w, h, d); if (rotY) g.rotateY(rotY); g.translate(x, y, z); if (color) { const c = new THREE.Color(color); const n = g.attributes.position.count; g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [c.r, c.g, c.b]), 3)); } arr.push(g); return g; };
  for (const is of ISLANDS) {
    if (!is.dock) continue;
    const a = is.dock.ang, dx = Math.cos(a), dz = Math.sin(a);
    let rShore = 0, rEnd = 0;
    for (let r = 10; r < is.r * 2.4; r += 1) { const h = field.height(is.x + dx * r, is.z + dz * r); if (!rShore && h < 1.1) rShore = r; if (rShore && h < -3.2) { rEnd = r; break; } }
    if (!rEnd) rEnd = rShore + 30;
    rEnd = Math.max(rEnd, rShore + 18);
    const len = rEnd - rShore + 4, rot = -a;
    const deckY = 1.35;
    for (let t = 0; t < len; t += 0.5) { const px = is.x + dx * (rShore - 2 + t), pz = is.z + dz * (rShore - 2 + t); addBox(woodGeos, 0.46, 0.1, 2.6, px, deckY, pz, rot, (Math.floor(t * 2) % 3) ? '#8a6038' : '#7a5230'); }
    for (let t = 0; t < len; t += 3) for (const sgn of [-1, 1]) { const px = is.x + dx * (rShore - 2 + t) - dz * sgn * 1.2, pz = is.z + dz * (rShore - 2 + t) + dx * sgn * 1.2; const g = new THREE.CylinderGeometry(0.13, 0.15, 6, 6); g.translate(px, deckY - 2.6, pz); const c = new THREE.Color('#4f3a26'); g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(0).flatMap(() => [c.r, c.g, c.b]), 3)); woodGeos.push(g); }
    // 码头尽头的灯笼柱
    const ex = is.x + dx * (rEnd + 1.5), ez = is.z + dz * (rEnd + 1.5);
    for (const sgn of [-1, 1]) {
      const px = ex - dz * sgn * 1.15, pz = ez + dx * sgn * 1.15;
      addBox(woodGeos, 0.12, 1.6, 0.12, px, deckY + 0.8, pz, 0, '#3c2a1a');
      const lg = new THREE.BoxGeometry(0.26, 0.34, 0.26); lg.translate(px, deckY + 1.75, pz); lanternGeos.push(lg);
      world.lanterns.push(new THREE.Vector3(px, deckY + 1.75, pz));
    }
    // 小屋（在岸上）
    const hx = is.x + dx * (rShore - 9), hz = is.z + dz * (rShore - 9), hh = field.height(hx, hz);
    addBox(hutGeos, 4.2, 2.8, 3.4, hx, hh + 1.2, hz, rot, '#e8e0cf');
    const roof = new THREE.ConeGeometry(3.6, 1.8, 4); roof.rotateY(Math.PI / 4 + rot); roof.translate(hx, hh + 3.5, hz);
    const rc = new THREE.Color(is.id === 'harbor' ? '#b5482f' : '#2f6f73'); roof.setAttribute('color', new THREE.Float32BufferAttribute(new Array(roof.attributes.position.count).fill(0).flatMap(() => [rc.r, rc.g, rc.b]), 3)); roofGeos.push(roof);
    // 停靠区：栈桥尽头外侧的水面
    const zone = new THREE.Vector3(is.x + dx * (rEnd + 9), 0, is.z + dz * (rEnd + 9));
    world.docks.push({ id: is.id, name: is.dock.name, island: is.name, pos: zone, pierEnd: new THREE.Vector3(ex, deckY, ez), dir: a });
  }
  const strip = (g) => { g.deleteAttribute('uv'); if (!g.attributes.color) { const n = g.attributes.position.count; g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(0.5), 3)); } return g; };
  if (woodGeos.length) { const wm = new THREE.Mesh(mergeGeometries(woodGeos.map(strip)), fogStd({ vertexColors: true, roughness: 0.85 })); wm.castShadow = wm.receiveShadow = true; scene.add(wm); }
  if (hutGeos.length) { const hm = new THREE.Mesh(mergeGeometries([...hutGeos, ...roofGeos].map(strip)), fogStd({ vertexColors: true, roughness: 0.8 })); hm.castShadow = hm.receiveShadow = true; scene.add(hm); }
  if (lanternGeos.length) { const lm = new THREE.Mesh(mergeGeometries(lanternGeos), lanternMat); scene.add(lm); world.lanternMesh = lm; }
  world.lanternMat = lanternMat;
  // 灯笼光晕（夜里由泛光放大）
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(1, 0.55, 0.22), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
  world.glows = world.lanterns.map(p => { const s = new THREE.Sprite(glowMat); s.position.copy(p); s.scale.setScalar(4.5); scene.add(s); return s; });
  world.glowMat = glowMat;
  // —— 灯塔 ——
  const H = ISLANDS[0], la = H.lighthouse.ang;
  let lx = 0, lz = 0, lh = 0;
  for (let r = H.r * 0.4; r < H.r * 0.95; r += 2) { const x = H.x + Math.cos(la) * r, z = H.z + Math.sin(la) * r, h = field.height(x, z); if (h > 3) { lx = x; lz = z; lh = h; } }
  const tower = new THREE.CylinderGeometry(1.5, 2.2, 15, 28, 10);
  { const pa = tower.attributes.position, cols = []; for (let i = 0; i < pa.count; i++) { const y = pa.getY(i) + 7.5, band = Math.floor(y / 2.5) % 2; const c = band ? new THREE.Color('#e9e4d8') : new THREE.Color('#b8372b'); cols.push(c.r, c.g, c.b); } tower.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); }
  const lt = new THREE.Group(); lt.position.set(lx, lh - 0.5, lz); scene.add(lt);
  const towerM = new THREE.Mesh(tower, fogStd({ vertexColors: true, roughness: 0.6 })); towerM.position.y = 7.5; towerM.castShadow = true; lt.add(towerM);
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.3, 24), fogStd({ color: 0x2d2d2d, roughness: 0.6, metalness: 0.5 })); gallery.position.y = 15.1; lt.add(gallery);
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.85, 0.55) });
  const lampRoom = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1.7, 16), lampMat); lampRoom.position.y = 16.1; lt.add(lampRoom);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.25, 16, 8, 0, TAU, 0, Math.PI / 2), fogStd({ color: 0x8a2a22, roughness: 0.5 })); dome.position.y = 16.95; lt.add(dome);
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying float vT; varying vec3 vN; varying vec3 vV; void main(){ vT = 1.0 - uv.y; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float uI; varying float vT; varying vec3 vN; varying vec3 vV; void main(){ float rim = pow(abs(dot(vN, vV)), 1.5); float a = (1.0 - vT) * (1.0 - vT) * rim * uI; gl_FragColor = vec4(vec3(1.0, 0.86, 0.6) * a, a); }',
  });
  const beamGeo = new THREE.ConeGeometry(9, 160, 24, 1, true); beamGeo.translate(0, -80, 0); beamGeo.rotateZ(Math.PI / 2);
  const beamPivot = new THREE.Group(); beamPivot.position.y = 16.1; lt.add(beamPivot);
  const b1 = new THREE.Mesh(beamGeo, beamMat), b2 = new THREE.Mesh(beamGeo, beamMat); b2.rotation.y = Math.PI; beamPivot.add(b1, b2);
  const lhLight = new THREE.PointLight(0xffd9a0, 0, 60, 1.5); lhLight.position.y = 16.1; lt.add(lhLight);
  world.lighthouse = { group: lt, beamPivot, beamMat, lampMat, light: lhLight, pos: new THREE.Vector3(lx, lh + 16, lz) };
  // —— 浮标（实例化；每个都有自己的 ocean/Buoyancy 漂浮状态）——
  const buoyGeo = mergeGeometries([new THREE.CylinderGeometry(0.55, 0.7, 1.6, 12).translate(0, 0.3, 0), new THREE.ConeGeometry(0.45, 1.0, 12).translate(0, 1.6, 0), new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6).translate(0, 2.4, 0)]);
  world.buoyMesh = new THREE.InstancedMesh(buoyGeo, fogStd({ color: 0xffffff, roughness: 0.5 }), 64);
  world.buoyMesh.count = 0; world.buoyMesh.castShadow = true; world.buoyMesh.frustumCulled = false; scene.add(world.buoyMesh);
  world.buoyLights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), 64);
  world.buoyLights.count = 0; world.buoyLights.frustumCulled = false; scene.add(world.buoyLights);
  // —— 漂流瓶 ——
  const bottleGeo = mergeGeometries([new THREE.CylinderGeometry(0.16, 0.16, 0.55, 10), new THREE.CylinderGeometry(0.06, 0.13, 0.22, 10).translate(0, 0.38, 0), new THREE.CylinderGeometry(0.065, 0.065, 0.08, 8).translate(0, 0.52, 0)]);
  bottleGeo.rotateZ(Math.PI / 2);
  world.bottleMesh = new THREE.InstancedMesh(bottleGeo, fogStd({ color: 0x5fae8e, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85, emissive: 0x0b3326 }), 16);
  world.bottleMesh.count = 0; world.bottleMesh.frustumCulled = false; scene.add(world.bottleMesh);
  world.bottleGlow = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: glowTex, color: new THREE.Color(1.0, 0.85, 0.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 }), 16);
  world.bottleGlow.count = 0; world.bottleGlow.frustumCulled = false; scene.add(world.bottleGlow);
  // —— 目标标记：水面光环 + 光柱 ——
  const ringMat = new THREE.ShaderMaterial({ uniforms: { uT: { value: 0 }, uC: { value: new THREE.Color(1.0, 0.75, 0.35) } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uT; uniform vec3 uC; varying vec2 vUv; void main(){ float r = length(vUv - 0.5) * 2.0; float ring = smoothstep(0.08, 0.0, abs(r - 0.92)) + smoothstep(0.05, 0.0, abs(r - fract(uT * 0.5) * 0.92)) * (1.0 - fract(uT * 0.5)); gl_FragColor = vec4(uC * ring * 1.6, ring); }' });
  world.ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), ringMat); world.ring.visible = false; world.ring.renderOrder = 12; scene.add(world.ring);
  const pillarMat = new THREE.ShaderMaterial({ uniforms: { uC: { value: new THREE.Color(1.0, 0.7, 0.3) }, uT: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uC; uniform float uT; varying vec2 vUv; void main(){ float a = pow(1.0 - vUv.y, 2.2) * (0.55 + 0.45 * sin(uT * 2.0)) * 0.55; gl_FragColor = vec4(uC * a, a); }' });
  world.pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 90, 16, 1, true).translate(0, 45, 0), pillarMat); world.pillar.visible = false; world.pillar.renderOrder = 12; scene.add(world.pillar);
  world.ringMat = ringMat; world.pillarMat = pillarMat;
  // 浮标门之间的引导线
  const gateLineMat = new THREE.ShaderMaterial({ uniforms: { uT: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uT; varying vec2 vUv; void main(){ float d = step(0.5, fract(vUv.x * 9.0 - uT * 1.5)); float a = d * smoothstep(0.5, 0.0, abs(vUv.y - 0.5)) * 0.9; gl_FragColor = vec4(vec3(1.0, 0.8, 0.4) * a * 1.4, a); }' });
  world.gateLine = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.5).rotateX(-Math.PI / 2), gateLineMat); world.gateLine.visible = false; world.gateLine.renderOrder = 12; scene.add(world.gateLine);
  world.gateLineMat = gateLineMat;
  // —— 雨（风暴时）——
  const NR = 2600, rp = new Float32Array(NR * 6); world.rainSeed = new Float32Array(NR * 3);
  for (let i = 0; i < NR; i++) { world.rainSeed.set([rnd() * 70 - 35, rnd() * 40, rnd() * 70 - 35], i * 3); }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3).setUsage(THREE.DynamicDrawUsage));
  world.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0x9fb3c4, transparent: true, opacity: 0.32, depthWrite: false }));
  world.rain.frustumCulled = false; world.rain.visible = false; world.rain.renderOrder = 3; scene.add(world.rain);
  return world;
}

// =====================================================================================
// 4. 声音：全部用 Web Audio 合成
//    海浪底噪、船体破水（随对水速度）、风声与索具呼啸（随视风速度）、帆抖（随 luff）、横杆换舷吱呀与甩帆闷响、
//    砰击水花（随砰击事件强度）、辅机（随油门）、触底刮擦、浮标铃、海鸥、雷声（按闪电距离延迟）；
//    音乐：离线 Karplus–Strong 拨弦 + 三角波和弦垫。
// =====================================================================================
class AudioEngine {
  constructor() { this.ctx = null; this.muted = false; this.step = 0; this.t = 0; this.gullT = 6; }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.85;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3.5; comp.attack.value = 0.01; comp.release.value = 0.3;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master);
    this.amb = ctx.createGain(); this.amb.gain.value = 0.9; this.amb.connect(this.master);
    this.mus = ctx.createGain(); this.mus.gain.value = 0.32; this.mus.connect(this.master);
    // 简单混响：两路反馈延迟
    this.verb = ctx.createGain(); this.verb.gain.value = 0.32;
    const d1 = ctx.createDelay(1), d2 = ctx.createDelay(1), fb1 = ctx.createGain(), fb2 = ctx.createGain(), lp = ctx.createBiquadFilter();
    d1.delayTime.value = 0.137; d2.delayTime.value = 0.211; fb1.gain.value = 0.42; fb2.gain.value = 0.38; lp.type = 'lowpass'; lp.frequency.value = 2400;
    this.verb.connect(d1); this.verb.connect(d2); d1.connect(fb1).connect(lp); d2.connect(fb2).connect(lp); lp.connect(d1); lp.connect(d2); lp.connect(this.master);
    const len = ctx.sampleRate * 2, nb = ctx.createBuffer(1, len, ctx.sampleRate), nd = nb.getChannelData(0);
    let b = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; nd[i] = w * 0.6 + b * 2.2; }
    this.noise = nb;
    const loop = (type, f, q) => { const s = ctx.createBufferSource(); s.buffer = nb; s.loop = true; s.loopStart = Math.random(); const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; s.connect(fl).connect(g).connect(this.amb); s.start(0, Math.random() * 1.5); return { fl, g }; };
    this.ocean = loop('lowpass', 480, 0.5); this.surf = loop('highpass', 2600, 0.4);
    this.rush = loop('bandpass', 900, 0.7); this.wind = loop('bandpass', 520, 1.1);
    this.luff = loop('bandpass', 210, 0.9);
    this.grind = loop('bandpass', 260, 2.2);
    this.wash = loop('highpass', 1500, 0.6);
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 7.5; const lg = ctx.createGain(); lg.gain.value = 0; lfo.connect(lg); lg.connect(this.luff.g.gain); lfo.start(); this.luffLfo = lg;
    this.whistle = ctx.createOscillator(); this.whistle.type = 'sine'; this.whistle.frequency.value = 1100; this.whG = ctx.createGain(); this.whG.gain.value = 0; this.whistle.connect(this.whG).connect(this.amb); this.whistle.start();
    // 辅机：两缸柴油机，锯齿波过低通 + 按发火频率的“突突”调幅
    const eo = ctx.createOscillator(); eo.type = 'sawtooth'; eo.frequency.value = 36;
    const elp = ctx.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 320; elp.Q.value = 2;
    const eam = ctx.createGain(); eam.gain.value = 0.6;
    const echug = ctx.createOscillator(); echug.type = 'square'; echug.frequency.value = 18; const echugG = ctx.createGain(); echugG.gain.value = 0.4; echug.connect(echugG).connect(eam.gain);
    const eg = ctx.createGain(); eg.gain.value = 0;
    eo.connect(elp).connect(eam).connect(eg).connect(this.amb); eo.start(); echug.start();
    this.engine = { osc: eo, chug: echug, g: eg, lp: elp };
    // 拨弦音色（离线 Karplus–Strong）
    this.scale = [146.83, 164.81, 185.0, 220.0, 246.94, 293.66, 329.63, 369.99, 440.0, 493.88, 587.33, 659.25, 739.99];
    this.plucks = this.scale.map(f => this.ks(f, 2.6));
    this.nextNote = ctx.currentTime + 0.6;
  }
  ks(freq, dur) {
    const ctx = this.ctx, sr = ctx.sampleRate, n = Math.floor(sr * dur), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    const P = Math.max(2, Math.round(sr / freq)), ring = new Float32Array(P);
    let lp = 0; for (let i = 0; i < P; i++) { lp = lp * 0.5 + (Math.random() * 2 - 1) * 0.5; ring[i] = lp; }
    let k = 0, peak = 0;
    for (let i = 0; i < n; i++) { const a = ring[k], b = ring[(k + 1) % P]; ring[k] = (a + b) * 0.5 * 0.9965; d[i] = a; peak = Math.max(peak, Math.abs(a)); k = (k + 1) % P; }
    for (let i = 0; i < n; i++) d[i] = d[i] / (peak || 1) * Math.min(1, i / 60);
    return buf;
  }
  setMuted(m) { this.muted = m; if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05); }
  set(g, v, tc = 0.25) { g.setTargetAtTime(v, this.ctx.currentTime, tc); }
  update(dt, s) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.t += dt; const sea = s.sea;
    this.set(this.ocean.g.gain, (0.13 + sea * 0.22) * (0.75 + 0.25 * Math.sin(this.t * 0.45) * Math.sin(this.t * 0.17 + 1)), 0.6);
    this.set(this.surf.g.gain, 0.012 + sea * 0.05 + s.storm * 0.05, 0.6);
    this.set(this.rush.g.gain, clamp(s.speed / 3.5, 0, 1.2) * 0.16, 0.3); this.set(this.rush.fl.frequency, 500 + s.speed * 220, 0.3);
    this.set(this.wash.g.gain, s.bowWash * 0.11, 0.25);                 // 船首浪破碎的嘶嘶声
    this.set(this.wind.g.gain, clamp(s.aws / 10, 0, 1.4) * 0.12 + s.storm * 0.08, 0.4); this.set(this.wind.fl.frequency, 300 + s.aws * 45, 0.5);
    this.set(this.whG.gain, smoothstep(7, 13, s.aws) * 0.012, 0.6); this.set(this.whistle.frequency, 850 + s.aws * 32 + Math.sin(this.t * 0.7) * 40, 0.4);
    this.set(this.luffLfo.gain, s.luff * 0.09, 0.15); this.set(this.luff.g.gain, s.luff * 0.09, 0.15);
    // 辅机：油门越大转速越高
    const m = Math.abs(s.motor);
    this.set(this.engine.g.gain, m > 0.02 ? 0.05 + 0.09 * m : 0, 0.3);
    this.set(this.engine.osc.frequency, 30 + 16 * m, 0.4); this.set(this.engine.chug.frequency, 15 + 8 * m, 0.4); this.set(this.engine.lp.frequency, 260 + 260 * m, 0.4);
    // 触底刮擦：随接触处滑动速度
    this.set(this.grind.g.gain, clamp(s.grind / 0.6, 0, 1) * 0.22, 0.12); this.set(this.grind.fl.frequency, 180 + s.grind * 260, 0.2);
    // 海鸥（白天、靠近岛）
    this.gullT -= dt; if (this.gullT < 0) { this.gullT = 7 + Math.random() * 12; if (s.day > 0.4 && s.nearLand) this.gull(); }
    // 音乐调度
    const ctx = this.ctx;
    while (this.nextNote < ctx.currentTime + 0.25) { this.musicStep(this.nextNote, s); this.nextNote += 60 / 74 / 2; }
  }
  musicStep(t, s) {
    const CH = [[0, 2, 4, 7, 9], [4, 5, 7, 9, 11], [3, 5, 7, 8, 10], [3, 4, 6, 8, 10]];   // 和弦里可用的音阶序号
    const ROOT = [[73.42, 110.0, 138.59], [61.74, 92.5, 110.0], [98.0, 123.47, 146.83], [110.0, 146.83, 164.81]];
    const bar = Math.floor(this.step / 16) % 4;
    if (this.step % 16 === 0) this.pad(t, ROOT[bar], s.night);
    const pat = [0, -1, 2, -1, 1, 3, -1, 2, 0, -1, 4, 2, -1, 1, -1, 3];
    const pi = pat[this.step % 16];
    const dens = s.night > 0.5 ? 0.45 : 0.85;
    if (pi >= 0 && Math.random() < dens) {
      const notes = CH[bar]; let ni = notes[(pi + (Math.random() < 0.2 ? 1 : 0)) % notes.length];
      if (s.night > 0.5 && Math.random() < 0.5) ni = Math.max(0, ni - 5);
      this.pluck(t, ni, 0.22 + Math.random() * 0.08, true);
    }
    this.step++;
  }
  pad(t, freqs, night) {
    const ctx = this.ctx, dur = 16 * 60 / 74 / 2, f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = night > 0.5 ? 650 : 1000; f.connect(this.mus);
    for (const fr of freqs) for (const det of [-4, 4]) {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = fr * 2; o.detune.value = det;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.045, t + 1.6); g.gain.setValueAtTime(0.045, t + dur - 1.2); g.gain.linearRampToValueAtTime(0, t + dur + 0.4);
      o.connect(g).connect(f); o.start(t); o.stop(t + dur + 0.5);
    }
  }
  pluck(t, i, vol = 0.3, toMusic = false) {
    const ctx = this.ctx; if (!ctx) return; const s = ctx.createBufferSource(); s.buffer = this.plucks[clamp(i, 0, this.plucks.length - 1)];
    const g = ctx.createGain(); g.gain.value = vol; s.connect(g); g.connect(toMusic ? this.mus : this.sfx); g.connect(this.verb); s.start(t || ctx.currentTime);
  }
  env(node, t, a, peak, dec) { node.gain.setValueAtTime(0, t); node.gain.linearRampToValueAtTime(peak, t + a); node.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); }
  noiseBurst(type, f0, f1, dur, vol, q = 0.7) {
    const ctx = this.ctx; if (!ctx) return; const t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = this.noise;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(f0, t); fl.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain(); this.env(g, t, 0.01, vol, dur); s.connect(fl).connect(g).connect(this.sfx); s.start(t, Math.random()); s.stop(t + dur + 0.1);
  }
  bell(base = 520, vol = 0.22) {
    const ctx = this.ctx; if (!ctx) return; const t = ctx.currentTime;
    [[0.5, 1], [1, 0.8], [1.19, 0.5], [1.56, 0.35], [2, 0.3], [2.51, 0.2], [2.66, 0.18], [3.01, 0.12]].forEach(([r, a], k) => {
      const o = ctx.createOscillator(); o.frequency.value = base * r; const g = ctx.createGain(); this.env(g, t, 0.004, vol * a * 0.5, 2.8 - k * 0.22);
      o.connect(g); g.connect(this.sfx); g.connect(this.verb); o.start(t); o.stop(t + 3.2);
    });
  }
  creak(heavy = false) {
    const ctx = this.ctx; if (!ctx) return; const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(heavy ? 70 : 105, t); o.frequency.linearRampToValueAtTime(heavy ? 52 : 80, t + 0.4);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = heavy ? 260 : 420; f.Q.value = 9;
    const g = ctx.createGain(); this.env(g, t, 0.03, heavy ? 0.22 : 0.12, 0.45); o.connect(f).connect(g).connect(this.sfx); o.start(t); o.stop(t + 0.6);
    if (heavy) { const o2 = ctx.createOscillator(); o2.frequency.setValueAtTime(90, t); o2.frequency.exponentialRampToValueAtTime(40, t + 0.3); const g2 = ctx.createGain(); this.env(g2, t, 0.005, 0.35, 0.35); o2.connect(g2).connect(this.sfx); o2.start(t); o2.stop(t + 0.5); }
  }
  splash(k = 1) { this.noiseBurst('lowpass', 2600, 300, 0.5 + k * 0.3, 0.06 + 0.12 * Math.min(k, 1.5)); }
  scrape(k = 1) { this.noiseBurst('bandpass', 380, 160, 0.7, 0.08 + 0.14 * Math.min(k, 1.5), 2.5); }
  thunder(vol = 0.5) { this.noiseBurst('lowpass', 420, 60, 3.2, vol, 0.4); }
  chime() { const t = this.ctx?.currentTime || 0; this.pluck(t, 9, 0.35); this.pluck(t + 0.09, 11, 0.3); this.pluck(t + 0.18, 12, 0.28); }
  gull() {
    const ctx = this.ctx; if (!ctx) return; let t = ctx.currentTime;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
      const o = ctx.createOscillator(); o.type = 'triangle'; const g = ctx.createGain();
      o.frequency.setValueAtTime(1500, t); o.frequency.exponentialRampToValueAtTime(820, t + 0.22); o.frequency.exponentialRampToValueAtTime(1050, t + 0.32);
      this.env(g, t, 0.02, 0.025, 0.32); o.connect(g); g.connect(this.sfx); g.connect(this.verb); o.start(t); o.stop(t + 0.4); t += 0.36 + Math.random() * 0.1;
    }
  }
}

// =====================================================================================
// 5. 游戏状态、渲染器、参数
// =====================================================================================
const canvas = $('gl');
const QUALITIES = ['high', 'medium', 'low'];
const QUALITY_NAMES = { high: '高', medium: '中', low: '低' };
const PIXEL_RATIO = { high: 1.5, medium: 1.25, low: 1 };
let quality = store.get('quality', IS_TOUCH ? 'medium' : 'high');
if (!OCEAN_QUALITY[quality] || quality === 'ultra') quality = IS_TOUCH ? 'medium' : 'high';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
renderer.info.autoReset = false;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.5, 60000);
const clock = new THREE.Clock();
const LINEAR_HEX = (c) => '#' + c.getHexString();    // 线性颜色 → 色板用的 sRGB 十六进制
// 海水外观默认值：在模块的 OCEAN_LOOK 上略偏热带（更蓝的深水、更白的珊瑚沙）
const LOOK = {
  deep: new THREE.Color(0.0035, 0.026, 0.05), sss: OCEAN_LOOK.sssColor.clone().multiplyScalar(1.1), sand: new THREE.Color(0.62, 0.55, 0.38),
};
const DEFAULTS = {
  sea: 0.3, windFrom: 70, windKn: 14, chop: 1.0, foam: 1.0, foamLife: 1.0, gust: 0.7,
  // 夜光藻 2 倍：真实航速（4–7 节）下船尾湍流泡沫比旧版（十几节）少，夜光尾迹要亮一些才看得出来
  deep: LINEAR_HEX(LOOK.deep), sand: LINEAR_HEX(LOOK.sand), sss: LINEAR_HEX(LOOK.sss), sssI: 1.0, biolum: 2.0,
  refl: 1.0, planar: true, planarStr: 0.9, daySpeed: 1, cloud: 0.3, fog: 1.0, expo: 0.5, bloom: 0.55, debug: 0,
  assist: false,                    // 稳舵辅助默认关：船的上风舵很小，松开舵时自己基本能走直（见 WATER.md）
};
// 参数换了含义（Gerstner → FFT 海面），用新的存储键，旧版本存下的值不再套用
let P = { ...DEFAULTS, ...store.get('params2', {}) };
const SEA_NAMES = ['无涌浪', '小涌', '中涌', '大涌', '风暴'];
const LETTERS = [
  { from: 'harbor', to: 'palm', cargo: '寄往椰影岛的家书', note: '守塔人的女儿写给远嫁的姐姐。' },
  { from: 'palm', to: 'fisher', cargo: '一包修补渔网的铜钉', note: '椰影岛的铁匠托你捎去渔村。' },
  { from: 'fisher', to: 'moon', cargo: '一张婚礼请柬', note: '渔村的阿海要在满月那天成亲。' },
  { from: 'moon', to: 'stone', cargo: '一包凤凰花种子', note: '月湾小筑的老师傅说石门岛缺一点红色。' },
  { from: 'stone', to: 'harbor', cargo: '画家的明信片', note: '画的是你昨天傍晚的帆。' },
];
const BOTTLE_NOTES = ['“今天的海是蜂蜜色的。”', '“如果你捡到这个，替我看一眼月湾的日落。”', '“灯塔的光转一圈是十二秒，我数过。”', '“风从东边来，信从西边走。”',
  '“别忘了给帆补补那个小洞。”', '“渔村的阿海喜欢吃椰子糖。”', '“星星落进海里，就成了会发光的浪。”', '“这瓶子漂了三年，终于有人捡到啦。”'];
const DOCK_SPEED_KN = 3;            // 靠港：在光圈里对水速度低于这个值并保持 1 秒
const MAX_RUDDER = 30 * DEG;        // 手操舵的最大舵角

let field, ocean, sky, wake, hullWake, planar, yacht, boat, spray, spume, bowWave, world, post;
const audio = new AudioEngine();
const S = {
  mode: 'loading', hours: 17.2, storm: 0, elapsed: 0,
  windU: 14 * KN2MS, windNow: new THREE.Vector2(), windMean: new THREE.Vector2(), gustT: Math.random() * 100,
  boat: { x: 175, y: 0, z: 85, yaw: Math.PI, speed: 0, speedKn: 0, surge: 0, heading: 0, heel: 0, twa: 0, awa: 0, aws: 0, irons: false },
  sheetAuto: true, sheet: 0.4, helm: { mode: 'manual', target: 0, intSign: 0 }, motor: 0,
  stamps: store.get('stamps', 0), delivered: store.get('delivered', 0), dist: 0, playTime: 0, bottles: 0, letterIdx: store.get('letterIdx', 0),
  best: { race: store.get('raceBest', null) }, tutorialDone: store.get('tutorialDone', false),
  home: { x: 0, z: 0 }, mission: null, hudHidden: false, panel: false, toastT: 0, bottleList: [],
  ground: { on: false, stuckT: 0, toastT: 0, scrapeT: 0 }, ironsT: 0, ironsCool: 0, prevSide: 1, splashT: 0, strikes: 0, thunder: [],
};
const input = { keys: new Set(), stickX: 0, motorTouch: false, asternTouch: false };

// ---------- 小工具 ----------
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const fmtClock = (h) => { const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); };
function ensureWater(x, z, minDepth = 7) {
  if (field.sample(x, z) < -minDepth) return [x, z];
  for (let r = 6; r < 400; r += 6) for (let a = 0; a < TAU; a += 0.4) { const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r; if (field.sample(px, pz) < -minDepth) return [px, pz]; }
  return [x, z];
}
function toast(text, dur = 2.6) { const el = $('toast'); el.textContent = text; el.classList.add('show'); S.toastT = dur; }
function dockById(id) { return world.docks.find(d => d.id === id); }
// 船首方向与右舷方向（世界水平面）
const fwdOf = (yaw) => [Math.sin(yaw), Math.cos(yaw)];
const rightOf = (yaw) => [-Math.cos(yaw), Math.sin(yaw)];

// 船和浮标看到的海面：GPU 回读的高度 × 与海面着色器相同的浅水消波（水深 0–4 m 内振幅线性减小，岸上为 0）
const shoreDamp = (x, z) => smoothstep(0, 4, -field.sample(x, z));
const sea = {
  get sim() { return ocean.sim; },
  get model() { return ocean.model; },
  sampleHeight(x, z) { return ocean.sampleHeight(x, z) * shoreDamp(x, z); },
  sampleVelocity(x, z, out = { x: 0, y: 0, z: 0 }) { ocean.sampleVelocity(x, z, out); const k = shoreDamp(x, z); out.x *= k; out.y *= k; out.z *= k; return out; },
};
const waterAt = (x, z) => (ocean && ocean.sim.ready ? sea.sampleHeight(x, z) : 0);
const groundAt = (x, z) => field.sample(x, z);

// =====================================================================================
// 6. 天气与海况
//    风是唯一的源头：平均风（面板的风速、风向，风暴时加大）→ WindSeaModel 按风区与持续时间起浪；
//    “海况”滑块给远方涌浪（无 → 2 m）与风暴（≥ 0.62 起：风加大、下雨、打雷）。
//    瞬时风 = 平均风 + 阵风（±12% 风速、±5° 风向，风暴时更大），同时喂给海面（毛细波、猫爪风）和帆船。
// =====================================================================================
function swellFor(sea01) { return { Hs: 2.0 * Math.pow(clamp(sea01, 0, 1), 1.3), Tp: lerp(9, 12.5, sea01) }; }
const towardTheta = (fromDeg) => { const v = windVector(1, fromDeg); return Math.atan2(v.y, v.x); };
function applyWeather(jump = false) {
  S.storm = smoothstep(0.62, 1.0, P.sea);
  S.windU = P.windKn * KN2MS * (1 + 0.8 * S.storm);
  windVector(S.windU, P.windFrom, S.windMean);
  if (!ocean) return;
  const m = ocean.model;
  m.setWind(S.windMean.x, S.windMean.y);           // 平均风变了：风浪按生长律慢慢跟上（不是跳变）
  if (!jump) return;
  // 海况跳变（松开滑块）：涌浪换成新值，风浪直接到当前风况的极限海况，并丢掉旧回读
  // （否则新旧两个海面的位移差会被当成水流，把船打转）。拖动滑块时不改涌浪，免得每一下都是一次跳变
  const sw = swellFor(P.sea);
  // 涌浪来自远方的天气系统：比本地信风偏 25°
  m.setBackgroundSwell(sw.Hs > 0.05 ? { Hs: sw.Hs, Tp: sw.Tp, theta: towardTheta(P.windFrom + 25) } : null);
  m.snapWind(); m.calm(); m.develop(1); ocean.resetSea();
  S.windNow.copy(S.windMean);
}
function updateWind(dt) {
  S.gustT += dt;
  const g = S.gustT, k = 1 + S.storm * 0.8;
  const gu = 1 + k * (0.1 * Math.sin(g * 0.31) * Math.sin(g * 0.083 + 1.7) + 0.04 * Math.sin(g * 1.3 + 0.4));
  const gd = k * (Math.sin(g * 0.17 + 0.6) * 3.5 + Math.sin(g * 0.61) * 1.5);
  windVector(S.windU * gu, P.windFrom + gd, S.windNow);
  if (ocean) ocean.model.setWind(S.windNow.x, S.windNow.y);   // 模型自己做 10 分钟平均，大浪只响应平均风
}

// 估计航段用时（只用于奖章时限，不参与物理）。极曲线是 14 节信风、默认海况（Hs ≈ 1.2 m）下在游戏里实测的稳态船速
// （稳舵辅助保持航向，与 node 里的不规则浪对照，见 WATER.md）：浪里迎风比平静水面慢得多（40° 约 3 节，平静水面 6 节），
// 横风、顺风差得不多。风速按 (U/14)^0.55 缩放；目标在最佳迎风角以内时按该角的 VMG 走之字形，每 400 m 算一次换舷（浪里约 20 s）
const POLAR_SEA = [[40, 3.2], [45, 3.9], [52, 4.8], [60, 5.45], [75, 5.9], [90, 5.9], [110, 6.0], [135, 5.7], [160, 4.9], [180, 4.9]];
function polarKn(twa) {
  const a = clamp(Math.abs(twa), 40, 180);
  for (let i = 1; i < POLAR_SEA.length; i++) if (a <= POLAR_SEA[i][0]) { const [a0, v0] = POLAR_SEA[i - 1], [a1, v1] = POLAR_SEA[i]; return lerp(v0, v1, (a - a0) / (a1 - a0)); }
  return POLAR_SEA[POLAR_SEA.length - 1][1];
}
const BEAT = (() => { let b = { twa: 40, vmg: 0 }; for (let a = 40; a <= 90; a++) { const v = polarKn(a) * Math.cos(a * DEG); if (v > b.vmg) b = { twa: a, vmg: v }; } return b; })();   // 约 52°，VMG 3.0 节
function legTime(x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0, d = Math.hypot(dx, dz);
  if (d < 1) return 0;
  const wf = Math.atan2(-S.windMean.x, -S.windMean.y), twa = Math.abs(wrapAngle(Math.atan2(dx, dz) - wf)) / DEG;
  const k = Math.pow(clamp(P.windKn / 14, 0.4, 2), 0.55);
  let v = polarKn(twa) * k, extra = 0;
  if (twa < BEAT.twa) { v = BEAT.vmg * k / Math.cos(twa * DEG); extra = 20 * Math.ceil(d / 400); }
  return d / (Math.min(v, 7.2) * KN2MS * 0.85) + extra;
}

// =====================================================================================
// 7. 船：舵、帆、辅机、触底
//    物理全部在 SailingYacht 里：舵角 → 舵的升力（低速时舵效 ∝ V²，几乎转不动）；帆的受力中心与侧向阻力中心的偏差
//    给出上风舵；船首进入逆风区时帆抖、减速、停住（停滞）—— 都不是脚本写死的转向速率。
//    游戏只把按键换成控制量：A/D → 舵角目标（±30°，舵机 30°/s，松开回中）；W/S → 手动帆脚索；Shift / X → 油门。
//    稳舵辅助（F，可选）：松开舵键时让舵机保持此刻的航向（SailingYacht 的 'heading' 模式），按键时立即交还手操。
// =====================================================================================
function setHelm(steer) {
  const h = S.helm, ap = yacht.autopilot;
  if (steer !== 0 || !P.assist) {
    if (h.mode === 'hold') h.intSign = Math.sign(yacht.telemetry.twa) || 1;
    h.mode = 'manual';
    yacht.setControls({ mode: 'manual', rudder: -steer * MAX_RUDDER });    // 舵角 + = 后缘偏向左舷 → 船向左转；D（右转）给负舵角
  } else if (h.mode !== 'hold') {
    h.mode = 'hold';
    // 目标航向：此刻航向 + 转向惯性（约 0.6 s 的偏航角速度），松手后不会被拽回去
    h.target = yacht.telemetry.yaw + yacht.state.angularVelocity.y * 0.6;
    // 舵机积分项里存的是稳态压舵角，换了舷就要镜像
    const side = Math.sign(yacht.telemetry.twa) || 1;
    if (h.intSign && side !== h.intSign) ap._int = -ap._int;
    yacht.setControls({ mode: 'heading', target: h.target });
  }
}
function setSheet(dir, dt) {
  if (dir !== 0) {
    if (S.sheetAuto) { S.sheet = yacht.telemetry.sheet ?? 0.4; S.sheetAuto = false; }
    S.sheet = clamp(S.sheet + dir * 0.5 * dt, 0, 1);
  }
  yacht.setControls({ sheet: S.sheetAuto ? 'auto' : S.sheet });
}
// 当前视风下的最佳帆脚索（与自动调帆同一公式：横杆角 → sheet）
function optimalSheet() {
  const beta = Math.abs(yacht.rig.main.beta || 0);
  return clamp((optimalBoom(beta) - 0.06) / (1.45 - 0.06), 0, 1);
}
function syncBoat() {
  const st = yacht.state, t = yacht.telemetry, b = S.boat;
  b.x = st.position.x; b.y = st.position.y; b.z = st.position.z; b.yaw = t.yaw;
  b.speed = t.speed; b.speedKn = t.speedKn; b.heading = t.heading; b.heel = t.heel;
  b.surge = st.velocity.x * Math.sin(t.yaw) + st.velocity.z * Math.cos(t.yaw);
  b.twa = t.twa; b.awa = t.awa; b.aws = t.aws;
  b.irons = Math.abs(t.twa) < 35 && t.speedKn < 2 && Math.abs(t.motor || 0) < 0.05;
}
function resetBoatAt(x, z, yaw, speed = 2) {
  yacht.reset({ x, z, yaw, speed });
  S.helm.mode = 'manual'; S.helm.intSign = 0;
  yacht.setControls({ mode: 'manual', rudder: 0, motor: 0 });
  applyToThree(yacht, boat, { dt: 0, time: S.elapsed, sky });
  syncBoat();
  wake.reset(); hullWake.reset(); spray.clear();
  S.prevSide = yacht.sail.side; S.ground.on = false; S.ground.stuckT = 0;
  CAM.snap = true;
}
// 拖船：搁浅太死（倒车也退不出来）时，沿地形下坡方向把船拖到水深 8 m 以外，船首朝外
function towToDeepWater() {
  let x = S.boat.x, z = S.boat.z, dx = 0, dz = 0;
  for (let i = 0; i < 300 && field.sample(x, z) > -8; i++) {
    const [gx, gz] = field.gradient(x, z, 4), gl = Math.hypot(gx, gz);
    if (gl < 1e-4) break;
    dx = -gx / gl; dz = -gz / gl; x += dx * 2; z += dz * 2;
  }
  [x, z] = ensureWater(x, z, 8);
  const yaw = (dx || dz) ? Math.atan2(dx, dz) : S.boat.yaw;
  resetBoatAt(x, z, yaw, 0.5);
  $('btnTow').hidden = true;
  toast('渔船把你拖回了深水', 2.2);
}
function updateGrounding(dt) {
  const g = yacht.ground, G = S.ground;
  if (g.contact && !G.on && (g.impact > 0.25 || g.force > 2500)) {
    // 新的一次触底：刮擦声、轻微震动、提示
    audio.scrape(clamp(g.impact / 1.5 + g.force / 2e4, 0.3, 1.5));
    CAM.shake = Math.max(CAM.shake, clamp(g.impact * 0.25, 0.05, 0.4));
    if (S.mode === 'play' && G.toastT <= 0) { toast(IS_TOUCH ? '搁浅了！按“倒车”退出，或转向深水。' : '搁浅了！按 X 倒车退出，或转向深水。'); G.toastT = 4; }
  }
  G.on = g.contact;
  G.toastT -= dt;
  // 卡住不动：提示可以请求拖船
  if (g.contact && S.boat.speedKn < 0.4) G.stuckT += dt; else G.stuckT = Math.max(0, G.stuckT - dt * 2);
  const stuck = G.stuckT > 6 && S.mode === 'play';
  if (stuck && $('btnTow').hidden) { $('btnTow').hidden = false; toast('搁得太死了：点“请求拖船”（R），渔船会把你拖回深水。', 4); }
  else if (!stuck && !$('btnTow').hidden && !g.contact) $('btnTow').hidden = true;
}
// 逆风停滞超过 2 s：提示怎么脱困（每 30 s 最多一次）。浪里换舷时船速掉得快，最容易停在风眼里
function updateIronsHint(dt) {
  S.ironsT = S.boat.irons && !yacht.ground.contact ? S.ironsT + dt : 0;
  S.ironsCool = Math.max(0, S.ironsCool - dt);
  if (S.ironsT > 2 && S.ironsCool === 0 && S.mode === 'play') {
    toast(IS_TOUCH ? '逆风停滞：舵盘打到底，等风把船首压开（船往后退时舵是反的），或按住“马达”。'
      : '逆风停滞：舵打到底，等风把船首压开（船往后退时舵是反的），或按住 Shift 开马达。', 4.5);
    S.ironsCool = 30;
  }
}
// 目标在上风（真风角 < 42°）：提示走之字形
function upwindHint(tg, dist) {
  if (!tg || dist < 60) return '';
  const wf = Math.atan2(-S.windMean.x, -S.windMean.y), twa = Math.abs(wrapAngle(Math.atan2(tg.x - S.boat.x, tg.z - S.boat.z) - wf)) / DEG;
  return twa < 42 ? '目标在上风：走之字形（真风角 50°–60°）。换舷前先把船速跑起来，舵一直打到帆换边；出弯后先偏下风加速。' : '';
}

// =====================================================================================
// 8. 任务：出港教学（三道门）→ 送信（取信 / 送达，计时奖章）；环岛赛；漂流瓶
// =====================================================================================
function makeGate(cx, cz, dirx, dirz, half = 10, colors = ['red', 'green']) {
  const l = Math.hypot(dirx, dirz) || 1; dirx /= l; dirz /= l;
  const lx = dirz, lz = -dirx;     // 左手方向
  return { a: { x: cx + lx * half, z: cz + lz * half }, b: { x: cx - lx * half, z: cz - lz * half }, mid: { x: cx, z: cz }, dir: { x: dirx, z: dirz }, colors };
}
function crossed(g, x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0, ex = g.b.x - g.a.x, ez = g.b.z - g.a.z, den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-9) return false;
  const qx = g.a.x - x0, qz = g.a.z - z0, t = (qx * ez - qz * ex) / den, u = (qx * dz - qz * dx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
const BUOY_POINTS = [new THREE.Vector3(0.5, 0, 0), new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0, 0, 0.5), new THREE.Vector3(0, 0, -0.5)];
function setGates(gates) {
  const list = [];
  const COL = { red: '#c63a2c', green: '#2f8f55', yellow: '#e0b23a' };
  gates.forEach((g, gi) => { list.push({ x: g.a.x, z: g.a.z, color: COL[g.colors[0]], gate: gi }); list.push({ x: g.b.x, z: g.b.z, color: COL[g.colors[1]], gate: gi }); });
  world.buoys = list.map(b => {
    const obj = new THREE.Object3D(); obj.position.set(b.x, 0, b.z); obj.rotation.y = Math.random() * TAU;
    // 浮标：1.6 m 高的浮筒，升沉周期约 1.3 s，比船短的浪也能把它晃起来
    return { ...b, obj, float: new Buoyancy(obj, { points: BUOY_POINTS, heavePeriod: 1.3, pitchPeriod: 1.7, rollPeriod: 1.7, damping: 0.3 }) };
  });
  world.buoyMesh.count = world.buoyLights.count = world.buoys.length;
  world.buoys.forEach((b, i) => { world.buoyMesh.setColorAt(i, new THREE.Color(b.color)); });
  if (world.buoyMesh.instanceColor) world.buoyMesh.instanceColor.needsUpdate = true;
}
function startTutorial() {
  const pts = [[175, -110], [60, -300], [250, -120]].map(([x, z]) => ensureWater(x, z));
  let px = S.boat.x, pz = S.boat.z; const gates = [];
  for (const [x, z] of pts) { gates.push(makeGate(x, z, x - px, z - pz, 11)); px = x; pz = z; }
  setGates(gates);
  S.mission = { type: 'tutorial', gates, idx: 0, t: 0, hints: IS_TOUCH ? [
    '左右拖动左下角的舵盘转舵（松手回中），从红绿两只浮标中间穿过去。罗盘上青色箭头是真风，白色是视风，红色扇区是逆风区。',
    '横风最快。船速越快舵越灵；船首转进红色扇区，帆会抖、船会停下来（逆风停滞）。',
    '这一段要稍微迎风：真风角 50°–60° 最划算，再往上风抢，船在浪里就慢下来。右下角滑条手动收放帆，失速时按住“马达”。'] : [
    '按 A / D（或 ← →）转舵，松开回中，从红绿两只浮标中间穿过去。罗盘上青色箭头是真风，白色是视风，红色扇区是逆风区。',
    '横风最快。船速越快舵越灵；船首转进红色扇区，帆会抖、船会停下来（逆风停滞）。',
    '这一段要稍微迎风：真风角 50°–60° 最划算，再往上风抢，船在浪里就慢下来。W / S 手动收放帆（E 恢复自动），F 打开稳舵辅助。'] };
}
function startDelivery() {
  const L = S.letterIdx < LETTERS.length ? LETTERS[S.letterIdx] : (() => { const ids = world.docks.map(d => d.id); const r = mulberry32(S.letterIdx * 7 + 3); const f = ids[Math.floor(r() * ids.length)]; let t = f; while (t === f) t = ids[Math.floor(r() * ids.length)]; return { from: f, to: t, cargo: ['一盒岛上的蜂蜜', '修好的怀表', '一卷海图', '药铺的方子', '孩子画的鲸鱼'][Math.floor(r() * 5)], note: '收信人在码头等着你。' }; })();
  setGates([]);
  S.mission = { type: 'pickup', letter: L, from: dockById(L.from), to: dockById(L.to), t: 0, hold: 0 };
}
function startRace() {
  const c = ISLANDS.find(i => i.id === 'whale'), gates = [], n = 6;
  for (let i = 0; i <= n; i++) {
    const a = Math.PI / 2 + i / n * TAU, r = 142;
    const cx = c.x + Math.cos(a) * r, cz = c.z + Math.sin(a) * r;
    gates.push(makeGate(cx, cz, -Math.sin(a), Math.cos(a), 15, i === 0 || i === n ? ['yellow', 'yellow'] : ['red', 'green']));
  }
  setGates(gates.slice(0, n));
  const g0 = gates[0];
  resetBoatAt(g0.mid.x - g0.dir.x * 70, g0.mid.z - g0.dir.z * 70, Math.atan2(g0.dir.x, g0.dir.z), 2.5);
  // 时限：按当前风况估计一圈（6 段）的用时
  let par = 0; for (let i = 0; i < n; i++) par += legTime(gates[i].mid.x, gates[i].mid.z, gates[i + 1].mid.x, gates[i + 1].mid.z);
  S.mission = { type: 'race', gates, idx: 0, started: false, t: 0, n, par: Math.round(par + 20) };
  toast('驶过黄色起点浮标开始计时');
}
function spawnBottles() {
  const r = mulberry32(Math.floor(S.elapsed * 13) + 5); S.bottleList = [];
  let guard = 0;
  while (S.bottleList.length < 8 && guard++ < 500) {
    const x = (r() * 2 - 1) * 900, z = (r() * 2 - 1) * 900;
    if (field.sample(x, z) < -12 && Math.hypot(x - S.boat.x, z - S.boat.z) > 120) S.bottleList.push({ x, z, ph: r() * TAU, got: false });
  }
}
function missionTarget() {
  const m = S.mission; if (!m) return null;
  if (m.type === 'tutorial' || m.type === 'race') { const g = m.gates[Math.min(m.idx, m.gates.length - 1)]; return { x: g.mid.x, z: g.mid.z, gate: g }; }
  const d = m.type === 'pickup' ? m.from : m.to; return { x: d.pos.x, z: d.pos.z, dock: d };
}
function medalFor(t, par) { return t <= par ? ['gold', '金章', 3] : t <= par * 1.35 ? ['silver', '银章', 2] : ['bronze', '铜章', 1]; }
function updateMission(dt, x0, z0) {
  const m = S.mission; if (!m) return;
  const b = S.boat, x1 = b.x, z1 = b.z; m.t += dt;
  if (m.type === 'tutorial') {
    const g = m.gates[m.idx];
    if (crossed(g, x0, z0, x1, z1)) {
      m.idx++; audio.bell(560 + m.idx * 60); toast(`浮标门 ${m.idx}/3`);
      if (m.idx >= m.gates.length) {
        S.tutorialDone = true; store.set('tutorialDone', true);
        showCard({ kicker: 'Harbour Out · 出港', title: '出港完成', body: `<p class="lede">你已经会看风使舵了。灯塔岛邮局有第一封信等你去取。</p><dl class="stats"><dt>用时</dt><dd>${fmtTime(m.t)}</dd></dl>`,
          actions: [{ label: '去取信', primary: true, fn: () => startDelivery() }] });
      }
    }
  } else if (m.type === 'pickup' || m.type === 'deliver') {
    const d = m.type === 'pickup' ? m.from : m.to;
    const dist = Math.hypot(d.pos.x - x1, d.pos.z - z1);
    if (dist < 20 && b.speedKn < DOCK_SPEED_KN) { m.hold += dt; if (m.hold > 1.0) arrive(m); }
    else m.hold = Math.max(0, m.hold - dt * 2);
    if (dist < 45 && b.speedKn > DOCK_SPEED_KN && m.t % 5 < dt) toast(IS_TOUCH ? `靠港要减速到 ${DOCK_SPEED_KN} 节以下：转向迎风让帆抖，或按“倒车”刹住` : `靠港要减速到 ${DOCK_SPEED_KN} 节以下：转向迎风、S 放松帆，或 X 倒车刹住`);
  } else if (m.type === 'race') {
    const g = m.gates[m.idx];
    if (crossed(g, x0, z0, x1, z1)) {
      if (!m.started) { m.started = true; m.t = 0; m.idx = 1; audio.bell(700); toast('开始计时！'); }
      else {
        m.idx++; audio.bell(560 + m.idx * 40);
        if (m.idx > m.n) {
          const t = m.t, [cls, name] = medalFor(t, m.par), prev = S.best.race, isBest = !prev || t < prev;
          if (isBest) { S.best.race = t; store.set('raceBest', t); }
          S.stamps += 2; store.set('stamps', S.stamps);
          showCard({ kicker: 'Regatta · 环岛赛', title: '完赛', body: `<dl class="stats"><dt>用时</dt><dd>${fmtTime(t)}</dd><dt>金章时限</dt><dd>${fmtTime(m.par)}</dd><dt>最佳</dt><dd>${fmtTime(S.best.race)}${isBest ? ' · 新纪录' : ''}</dd><dt>奖章</dt><dd><span class="medal ${cls}">${name}</span></dd></dl>`,
            actions: [{ label: '再赛一次', primary: true, fn: () => startRace() }, { label: '继续送信', fn: () => startDelivery() }] });
        } else toast(`第 ${m.idx - 1}/${m.n - 1} 门`);
        if (m.idx === m.n) toast('最后冲过黄色终点！');
      }
    }
    const c = ISLANDS.find(i => i.id === 'whale');
    if (Math.hypot(x1 - c.x, z1 - c.z) > 750) { toast('离赛道太远，比赛取消'); startDelivery(); }
  }
}
function arrive(m) {
  if (m.type === 'pickup') {
    m.type = 'deliver'; m.t = 0; m.hold = 0;
    m.par = Math.round(legTime(m.from.pos.x, m.from.pos.z, m.to.pos.x, m.to.pos.z) + 30);
    audio.bell(620); toast(`已取信：${m.letter.cargo}`);
  } else {
    const [cls, name, st] = medalFor(m.t, m.par);
    S.stamps += st; S.delivered++; S.letterIdx++;
    store.set('stamps', S.stamps); store.set('delivered', S.delivered); store.set('letterIdx', S.letterIdx);
    audio.bell(480); audio.chime();
    showCard({ kicker: 'Delivered · 送达', title: '送达', body: `<p class="letter">${m.letter.cargo}<br><span class="small">${m.letter.note}</span></p>
      <dl class="stats"><dt>收件</dt><dd>${m.to.name}</dd><dt>用时</dt><dd>${fmtTime(m.t)}</dd><dt>金章时限</dt><dd>${fmtTime(m.par)}</dd><dt>奖章</dt><dd><span class="medal ${cls}">${name}</span> +${st} 邮票</dd></dl>`,
      actions: [{ label: '下一封信', primary: true, fn: () => startDelivery() }, { label: '环岛赛', fn: () => startRace() }] });
  }
}

// =====================================================================================
// 9. 相机：追尾 / 环绕 / 电影镜头；不穿水、不穿山
// =====================================================================================
const CAM = { mode: 'chase', yawOff: 0, orbitYaw: 0.6, pitch: 0.2, dist: 17, lastDrag: -10, cineIdx: 0, cineT: 0, shake: 0, pos: new THREE.Vector3(200, 8, 120), look: new THREE.Vector3(), snap: true };
const _v = new THREE.Vector3(), _l = new THREE.Vector3(), _look = new THREE.Vector3();
function updateCamera(dt) {
  const b = S.boat, [fx, fz] = fwdOf(b.yaw), [rx, rz] = rightOf(b.yaw);
  const tgt = _l.set(b.x, b.y + 2.6, b.z);
  const desired = _v, look = _look.copy(tgt);
  let k = 1 - Math.exp(-dt * 4.5);
  if (CAM.mode === 'cine' || S.mode === 'title') {
    CAM.cineT += dt; if (CAM.cineT > 9) { CAM.cineT = 0; CAM.cineIdx = (CAM.cineIdx + 1) % 5; }
    const t = CAM.cineT, i = CAM.cineIdx;
    if (i === 0) desired.set(b.x + rx * 13 - fx * (3 - t * 0.5), b.y + 1.6, b.z + rz * 13 - fz * (3 - t * 0.5));
    else if (i === 1) { desired.set(b.x + fx * 10 + rx * 4, b.y + 2.4, b.z + fz * 10 + rz * 4); look.set(b.x - fx * 2, b.y + 4.5, b.z - fz * 2); }
    else if (i === 2) { const a = S.elapsed * 0.05; desired.set(b.x + Math.cos(a) * 80, b.y + 30, b.z + Math.sin(a) * 80); }
    else if (i === 3) { desired.set(b.x + fx * (32 - t * 1.5) - rx * 6, b.y + 1.0, b.z + fz * (32 - t * 1.5) - rz * 6); look.set(b.x, b.y + 3.2, b.z); }
    else { desired.set(b.x - fx * 11 - rx * 6, b.y + 2.0, b.z - fz * 11 - rz * 6); look.set(b.x + fx * 6, b.y + 3.5, b.z + fz * 6); }
    k = 1 - Math.exp(-dt * 1.4);
  } else {
    if (CAM.mode === 'chase' && S.elapsed - CAM.lastDrag > 2.5) CAM.yawOff *= Math.exp(-dt * 1.1);
    const yaw = CAM.mode === 'chase' ? b.yaw + Math.PI + CAM.yawOff : CAM.orbitYaw, cp = Math.cos(CAM.pitch);
    desired.set(tgt.x + Math.sin(yaw) * cp * CAM.dist, tgt.y + Math.sin(CAM.pitch) * CAM.dist, tgt.z + Math.cos(yaw) * cp * CAM.dist);
    const ahead = Math.min(CAM.dist * 0.25, 6); look.set(tgt.x + fx * ahead, tgt.y, tgt.z + fz * ahead);
  }
  if (CAM.snap) { CAM.pos.copy(desired); CAM.look.copy(look); CAM.snap = false; }
  CAM.pos.lerp(desired, k); CAM.look.lerp(look, k);
  const wh = waterAt(CAM.pos.x, CAM.pos.z); if (CAM.pos.y < wh + 0.8) CAM.pos.y = wh + 0.8;
  const th = field.sample(CAM.pos.x, CAM.pos.z); if (CAM.pos.y < th + 2.5) CAM.pos.y = th + 2.5;
  camera.position.copy(CAM.pos);
  if (CAM.shake > 0) { const s = CAM.shake * (REDUCED_MOTION ? 0.2 : 1); camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s; CAM.shake = Math.max(0, CAM.shake - dt * 1.5); }
  camera.lookAt(CAM.look);
  const fov = 50 + clamp((b.speed - 2.5) / 1.2, 0, 1) * 4;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = lerp(camera.fov, fov, 1 - Math.exp(-dt * 2)); camera.updateProjectionMatrix(); }
}

// =====================================================================================
// 10. 每帧：船（姿态、帆、尾迹、飞沫、声音事件）、浮标、漂流瓶、标记、天空与世界特效
// =====================================================================================
const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _E = new THREE.Euler(0, 0, 0, 'YXZ'), _P = new THREE.Vector3(), _S1 = new THREE.Vector3(1, 1, 1), _off = new THREE.Vector3();
const _bio = new THREE.Color(), _sprayCol = new THREE.Color(0.94, 0.97, 1.0);
function updateBoatFx(dt) {
  applyToThree(yacht, boat, { dt, time: S.elapsed, sky });
  syncBoat();
  boat.lantern = sky.night > 0.35;
  if (!(dt > 0)) return;
  // 尾迹：船行波半角与强度来自兴波阻力（driveWake），尾迹图跟着船走
  driveWake(yacht, hullWake, dt);
  wake.update(dt, S.boat.x, S.boat.z);
  ocean.setWake(wake.texture, wake.rect);
  // 砰击飞溅：入水点、射流速度、强度都由船体水压积分给出；船首浪：Fn > 0.22 后两舷溢出破碎，泡沫注入白浪场，船首甩出水片
  emitSpray(yacht, spray, { rate: IS_TOUCH ? 0.5 : 1 });
  bowWave.update(dt);
  let imax = 0; for (const e of yacht.events) imax = Math.max(imax, e.intensity);
  S.splashT -= dt;
  if (imax > 0.06 && S.splashT <= 0) { audio.splash(0.3 + imax * 1.6); S.splashT = 0.35; }
  // 换舷：帆换边时横杆甩过去（顺风换舷 = 甩帆，闷响 + 镜头一震）
  const side = yacht.sail.side;
  if (side !== S.prevSide && S.mode !== 'loading') {
    const gybe = Math.abs(S.boat.twa) > 100;
    audio.creak(gybe); if (gybe) CAM.shake = Math.max(CAM.shake, 0.35);
    S.prevSide = side;
  }
  S.dist += Math.hypot(yacht.state.velocity.x, yacht.state.velocity.z) * dt;
}
function updateBuoysAndBottles(dt) {
  const cam = camera.position, nightBlink = sky.night;
  world.buoys.forEach((bb, i) => {
    const o = bb.obj;
    if (dt > 0 && Math.hypot(o.position.x - cam.x, o.position.z - cam.z) < 900) bb.float.update(dt, sea);
    _P.set(o.position.x, o.position.y - 0.2, o.position.z);
    _M.compose(_P, o.quaternion, _S1); world.buoyMesh.setMatrixAt(i, _M);
    _off.set(0, 2.95, 0).applyQuaternion(o.quaternion).add(_P); _M.compose(_off, o.quaternion, _S1); world.buoyLights.setMatrixAt(i, _M);
    const m = S.mission, target = m && (m.type === 'tutorial' || m.type === 'race') && bb.gate === Math.min(m.idx, m.gates.length - 1);
    const blink = (Math.sin(S.elapsed * (target ? 9 : 3) + i) > 0.2 ? 1 : 0.15) * (0.4 + nightBlink * 2.6) * (target ? 2 : 0.8);
    world.buoyLights.setColorAt(i, new THREE.Color(bb.color).multiplyScalar(blink));
  });
  world.buoyMesh.instanceMatrix.needsUpdate = true; world.buoyLights.instanceMatrix.needsUpdate = true;
  if (world.buoyLights.instanceColor) world.buoyLights.instanceColor.needsUpdate = true;
  // 漂流瓶：漂在 FFT 海面上（GPU 回读的高度）
  let k = 0; const q = camera.quaternion;
  for (const bt of S.bottleList) {
    if (bt.got) continue;
    const y = waterAt(bt.x, bt.z);
    _E.set(Math.sin(S.elapsed * 1.3 + bt.ph) * 0.3, bt.ph + S.elapsed * 0.2, Math.sin(S.elapsed * 0.9 + bt.ph) * 0.25, 'YXZ'); _Q.setFromEuler(_E);
    _P.set(bt.x, y + 0.05, bt.z); _M.compose(_P, _Q, _S1); world.bottleMesh.setMatrixAt(k, _M);
    _P.y += 0.35; _M.compose(_P, q, _S1.set(2.6, 2.6, 2.6)); world.bottleGlow.setMatrixAt(k, _M); _S1.set(1, 1, 1);
    k++;
    if (S.mode === 'play' && Math.hypot(bt.x - S.boat.x, bt.z - S.boat.z) < 7) {
      bt.got = true; S.bottles++; S.stamps++; store.set('stamps', S.stamps); audio.chime();
      toast('漂流瓶：' + BOTTLE_NOTES[(S.bottles - 1) % BOTTLE_NOTES.length], 4.2);
      if (S.bottleList.every(b => b.got)) spawnBottles();
    }
  }
  world.bottleMesh.count = world.bottleGlow.count = k;
  world.bottleMesh.instanceMatrix.needsUpdate = true; world.bottleGlow.instanceMatrix.needsUpdate = true;
  world.bottleGlow.material.opacity = 0.25 + sky.night * 0.6;
}
function updateMarkers(dt) {
  const tg = (S.mode === 'play') ? missionTarget() : null;
  world.ringMat.uniforms.uT.value += dt; world.pillarMat.uniforms.uT.value += dt; world.gateLineMat.uniforms.uT.value += dt;
  world.ring.visible = world.pillar.visible = world.gateLine.visible = false;
  if (!tg) return;
  if (tg.dock) {
    const y = waterAt(tg.x, tg.z) + 0.15;
    world.ring.visible = world.pillar.visible = true; world.ring.position.set(tg.x, y, tg.z); world.ring.scale.setScalar(40); world.pillar.position.set(tg.x, y, tg.z);
  } else if (tg.gate) {
    const g = tg.gate, len = Math.hypot(g.b.x - g.a.x, g.b.z - g.a.z);
    world.gateLine.visible = true; world.gateLine.position.set(g.mid.x, waterAt(g.mid.x, g.mid.z) + 0.2, g.mid.z);
    world.gateLine.scale.set(len, 1, 2.4); world.gateLine.rotation.y = -Math.atan2(g.b.z - g.a.z, g.b.x - g.a.x);
    world.pillar.visible = true; world.pillar.position.set(g.mid.x, 0, g.mid.z);
  }
}
function updateWorldFx(dt) {
  world.uTime.value += dt;
  const n = sky.night, lh = world.lighthouse;
  lh.beamPivot.rotation.y += dt * 0.52;
  lh.beamMat.uniforms.uI.value = smoothstep(0.15, 0.8, n) * 0.55 + S.storm * 0.3;
  lh.lampMat.color.setRGB(1.0, 0.85, 0.55).multiplyScalar(0.8 + n * 6);
  lh.light.intensity = n * 30;
  world.lanternMat.color.setRGB(1.0, 0.62, 0.28).multiplyScalar(0.5 + n * 4.5);
  world.glowMat.opacity = n * 0.9;
  // 雨（风暴时，随风倾斜）
  world.rain.visible = S.storm > 0.15; world.rain.material.opacity = S.storm * 0.4;
  if (world.rain.visible) {
    const pa = world.rain.geometry.attributes.position.array, sd = world.rainSeed, c = camera.position;
    const wl = Math.max(S.windNow.length(), 1e-3), wx = S.windNow.x / wl * 0.35, wz = S.windNow.y / wl * 0.35;
    for (let i = 0; i < sd.length / 3; i++) {
      let y = sd[i * 3 + 1] - (S.elapsed * 22 + i * 0.37) % 40; y = ((y % 40) + 40) % 40;
      const x = c.x + sd[i * 3] + wx * y, z = c.z + sd[i * 3 + 2] + wz * y, yy = c.y - 12 + y;
      pa.set([x, yy, z, x + wx * 1.2, yy + 1.4, z + wz * 1.2], i * 6);
    }
    world.rain.geometry.attributes.position.needsUpdate = true;
  }
  // 闪电由 SkyEnvironment 产生（storm > 0.6）：画面闪光；雷声按闪电距离 / 声速延迟（最多 9 s），越远越轻
  if (sky.strikes !== S.strikes) {
    S.strikes = sky.strikes;
    const d = sky.lastStrike.distance;
    S.thunder.push({ t: Math.min(d / 343, 9), vol: clamp(0.65 * 4000 / d, 0.15, 0.6) });
  }
  for (let i = S.thunder.length - 1; i >= 0; i--) { const th = S.thunder[i]; th.t -= dt; if (th.t <= 0) { audio.thunder(th.vol); S.thunder.splice(i, 1); } }
}

// =====================================================================================
// 11. HUD：罗盘（船首朝上：真风青、视风白、逆风区红、横杆金、舵角）、小地图（北朝上）、读数
// =====================================================================================
const compassCtx = $('compass').getContext('2d'), mapCtx = $('minimap').getContext('2d');
let mapImage = null, hudT = 0;
function buildMapImage() {
  const n = 512, c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d'), img = g.createImageData(n, n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = field.min + (i + 0.5) / n * field.size, z = field.min + (j + 0.5) / n * field.size, h = field.sample(x, z), o = (j * n + i) * 4;
    let r = 8, gg = 28, b = 42; const a = 210;
    if (h > 0.5) { r = 214; gg = 196; b = 150; if (h > 2) { r = 92; gg = 128; b = 74; } if (h > 18) { r = 128; gg = 122; b = 108; } }
    else if (h > -6) { const t = smoothstep(-6, 0.5, h); r = lerp(20, 70, t); gg = lerp(90, 175, t); b = lerp(110, 170, t); }
    img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = a;
  }
  g.putImageData(img, 0, 0); mapImage = c;
}
function relAngle(dx, dz) { const b = S.boat, [fx, fz] = fwdOf(b.yaw), [rx, rz] = rightOf(b.yaw); return Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz); }
function pointOfSail(twa, irons) {
  const a = Math.abs(twa);
  if (a < 35) return [irons ? '逆风停滞' : '逆风', true];
  return a < 62 ? ['迎风', false] : a < 118 ? ['横风', false] : a < 152 ? ['侧顺风', false] : ['顺风', false];
}
function drawCompass() {
  const g = compassCtx, W = 420, cx = 210, cy = 210, R = 180, b = S.boat;
  g.clearRect(0, 0, W, W);
  g.fillStyle = 'rgba(6,18,28,0.62)'; g.beginPath(); g.arc(cx, cy, R + 18, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(221,166,81,0.85)'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, R + 16, 0, TAU); g.stroke();
  const at = (a, r) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
  // 逆风区（真风来向 ±35°）：船首在扇区里就走不动
  const tw = b.twa * DEG;
  g.fillStyle = b.irons ? 'rgba(238,90,67,0.45)' : 'rgba(238,90,67,0.22)'; g.beginPath(); g.moveTo(cx, cy);
  for (let a = tw - 35 * DEG; a <= tw + 35 * DEG + 1e-6; a += 0.05) { const [x, y] = at(a, R); g.lineTo(x, y); } g.closePath(); g.fill();
  // 刻度与方位（北 = 世界 −z）
  for (let d = 0; d < 360; d += 10) {
    const a = relAngle(Math.sin(d * DEG), -Math.cos(d * DEG));
    const [x0, y0] = at(a, R), [x1, y1] = at(a, R - (d % 30 === 0 ? 18 : 9));
    g.strokeStyle = 'rgba(241,233,216,0.55)'; g.lineWidth = d % 90 === 0 ? 3 : 1.5; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    if (d % 90 === 0) { const [tx, ty] = at(a, R - 38); g.fillStyle = d === 0 ? '#dda651' : 'rgba(241,233,216,0.85)'; g.font = '600 26px "Noto Sans SC",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(['北', '东', '南', '西'][d / 90], tx, ty); }
  }
  const arrow = (a, color, len, wid) => { const [x0, y0] = at(a, R + 8), [x1, y1] = at(a, R - len); g.strokeStyle = color; g.fillStyle = color; g.lineWidth = wid; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    const [hx, hy] = at(a, R - len - 18); const px = Math.cos(a) * 11, py = Math.sin(a) * 11; g.beginPath(); g.moveTo(hx, hy); g.lineTo(x1 + px, y1 + py); g.lineTo(x1 - px, y1 - py); g.closePath(); g.fill(); };
  arrow(tw, '#58c9c0', 52, 7);
  arrow(b.awa * DEG, 'rgba(241,233,216,0.95)', 34, 4);
  // 船形、舵、横杆（屏幕坐标：上 = 船首，右 = 右舷）
  g.save(); g.translate(cx, cy + 6); g.fillStyle = 'rgba(241,233,216,0.18)'; g.strokeStyle = 'rgba(241,233,216,0.6)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, -46); g.quadraticCurveTo(20, -10, 14, 34); g.lineTo(-14, 34); g.quadraticCurveTo(-20, -10, 0, -46); g.fill(); g.stroke();
  const rd = yacht.autopilot.rudder;                                   // + = 后缘偏向左舷（屏幕左）
  g.strokeStyle = '#ee5a43'; g.lineWidth = 5; g.beginPath(); g.moveTo(0, 34); g.lineTo(-Math.sin(rd) * 16, 34 + Math.cos(rd) * 16); g.stroke();
  const bm = yacht.sail.boomAngle;                                     // + = 横杆甩向左舷
  g.strokeStyle = '#dda651'; g.lineWidth = 4; g.beginPath(); g.moveTo(0, -8); g.lineTo(-Math.sin(bm) * 40, -8 + Math.cos(bm) * 40); g.stroke(); g.restore();
}
function drawMap() {
  const g = mapCtx, W = 352, b = S.boat, span = 900, sc = W / span;
  g.clearRect(0, 0, W, W); g.save(); g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 2, 0, TAU); g.clip();
  g.fillStyle = '#081c2a'; g.fillRect(0, 0, W, W);
  if (mapImage) { const px = (b.x - span / 2 - field.min) / field.size * 512, pz = (b.z - span / 2 - field.min) / field.size * 512, ps = span / field.size * 512; g.drawImage(mapImage, px, pz, ps, ps, 0, 0, W, W); }
  const toM = (x, z) => [(x - b.x) * sc + W / 2, (z - b.z) * sc + W / 2];
  for (const d of world.docks) { const [x, y] = toM(d.pos.x, d.pos.z); g.fillStyle = '#dda651'; g.beginPath(); g.arc(x, y, 5, 0, TAU); g.fill(); }
  for (const bt of S.bottleList) if (!bt.got) { const [x, y] = toM(bt.x, bt.z); g.fillStyle = '#ffd27a'; g.fillRect(x - 2.5, y - 2.5, 5, 5); }
  const m = S.mission;
  if (m && (m.type === 'tutorial' || m.type === 'race')) m.gates.forEach((gt, i) => { if (i < m.idx && m.type === 'tutorial') return; const [x0, y0] = toM(gt.a.x, gt.a.z), [x1, y1] = toM(gt.b.x, gt.b.z); g.strokeStyle = i === Math.min(m.idx, m.gates.length - 1) ? '#ffd27a' : 'rgba(241,233,216,0.5)'; g.lineWidth = 4; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); });
  const tg = missionTarget();
  if (tg) {
    let [x, y] = toM(tg.x, tg.z); const dx = x - W / 2, dy = y - W / 2, dl = Math.hypot(dx, dy), lim = W / 2 - 16;
    if (dl > lim) { x = W / 2 + dx / dl * lim; y = W / 2 + dy / dl * lim; }
    const pulse = 10 + Math.sin(S.elapsed * 5) * 3; g.strokeStyle = '#ffd27a'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, pulse, 0, TAU); g.stroke();
  }
  // 船（箭头按罗经方位旋转）
  g.translate(W / 2, W / 2); g.rotate(b.heading * DEG); g.fillStyle = '#f1e9d8'; g.beginPath(); g.moveTo(0, -12); g.lineTo(7, 9); g.lineTo(0, 5); g.lineTo(-7, 9); g.closePath(); g.fill();
  g.restore();
  // 风向小箭头（指向下风）
  g.save(); g.translate(W - 36, 36); g.rotate(Math.atan2(-S.windMean.x, S.windMean.y)); g.strokeStyle = '#58c9c0'; g.lineWidth = 4; g.beginPath(); g.moveTo(0, -16); g.lineTo(0, 16); g.moveTo(-8, 6); g.lineTo(0, 16); g.lineTo(8, 6); g.stroke(); g.restore();
  g.strokeStyle = 'rgba(221,166,81,0.7)'; g.lineWidth = 3; g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 2, 0, TAU); g.stroke();
}
function updateHUD(dt) {
  if (S.toastT > 0) { S.toastT -= dt; if (S.toastT <= 0) $('toast').classList.remove('show'); }
  hudT -= dt; if (hudT > 0) return; hudT = 1 / 20;
  const b = S.boat, T = yacht.telemetry, ro = ocean.readout;
  $('spd').textContent = (b.surge < -0.15 ? '−' : '') + b.speedKn.toFixed(1);
  const [pos, nogo] = pointOfSail(b.twa, b.irons); const pe = $('pos'); pe.textContent = pos; pe.classList.toggle('nogo', nogo);
  $('heel').textContent = `倾角 ${Math.round(Math.abs(b.heel))}°`;
  const rd = Math.round(T.rudderAngle);   // + = 后缘偏向左舷 → 船向左转（左舵）
  $('rudderLbl').textContent = `舵 ${rd > 0 ? '左' : rd < 0 ? '右' : ''}${Math.abs(rd)}°${S.helm.mode === 'hold' ? ' 稳舵' : ''}`;
  const mot = yacht.controls.motor || 0;
  $('motorLbl').hidden = Math.abs(mot) < 0.01; $('motorLbl').textContent = mot < 0 ? '倒车' : '马达';
  const opt = optimalSheet();
  if (S.sheetAuto) $('trimLbl').textContent = T.reef < 0.95 ? `自动调帆 · 缩帆 ${Math.round((1 - T.reef * T.reef) * 100)}%` : '自动调帆';
  else { const e = S.sheet - opt; $('trimLbl').textContent = `手动调帆 · ${e > 0.08 ? '太松（抖帆）' : e < -0.12 ? '太紧（失速）' : '正好'}（E 自动）`; }
  $('trimOpt').style.left = `calc(${(opt * 100).toFixed(1)}% - 2px)`; $('trimCur').style.left = `calc(${((S.sheetAuto ? T.sheet : S.sheet) * 100).toFixed(1)}% - 4px)`;
  $('clock').textContent = fmtClock(S.hours);
  $('sea').textContent = `信风 ${Math.round(S.windU * MS2KN)} 节 · 浪高 ${ro.Hs.toFixed(1)} m${S.storm > 0.5 ? ' · 风暴' : ''}`;
  $('stampCount').textContent = S.stamps;
  const m = S.mission, tg = missionTarget();
  const dist = tg ? Math.hypot(tg.x - b.x, tg.z - b.z) : 0;
  $('objDist').textContent = tg ? (dist > 1000 ? (dist / 1000).toFixed(2) + ' km' : Math.round(dist) + ' m') : '—';
  if (m) {
    let k = '', ti = '', tx = '', tm = '';
    if (m.type === 'tutorial') { k = `出港 · ${Math.min(m.idx + 1, 3)}/3`; ti = '穿过发光的浮标门'; tx = m.hints[Math.min(m.idx, 2)]; tm = fmtTime(m.t); }
    else if (m.type === 'pickup') { k = '取信'; ti = `前往 ${m.from.name}`; tx = (dist > 150 && upwindHint(tg, dist)) || (IS_TOUCH ? `${m.letter.cargo}。减速到 ${DOCK_SPEED_KN} 节以下驶进码头外的光圈：转向迎风让帆抖，或按“倒车”刹住。` : `${m.letter.cargo}。减速到 ${DOCK_SPEED_KN} 节以下驶进码头外的光圈：转向迎风、S 放松帆，或 X 倒车刹住。`); tm = fmtTime(m.t); }
    else if (m.type === 'deliver') { k = '送信'; ti = `送往 ${m.to.name}`; tx = (dist > 150 && upwindHint(tg, dist)) || `${m.letter.cargo}——${m.letter.note}`; tm = `${fmtTime(m.t)} / 金 ${fmtTime(m.par)}`; }
    else if (m.type === 'race') { k = '环岛赛'; ti = m.started ? `第 ${Math.min(m.idx, m.n)}/${m.n} 门` : '驶过黄色起点线'; tx = b.irons ? '逆风停滞：先转出红色扇区让帆吃上风，再左右交替偏 50°–60° 走之字形。' : '绕鲸背礁一圈，按顺序穿过浮标门。'; tm = m.started ? `${fmtTime(m.t)} / 金 ${fmtTime(m.par)}` : '—'; }
    $('objKicker').textContent = k; $('objTitle').textContent = ti; $('objText').textContent = tx; $('objTime').textContent = tm;
  }
  drawCompass(); drawMap();
  if (S.panel) {
    const info = renderer.info, q = OCEAN_QUALITY[ocean.quality];
    $('stats').textContent = `绘制调用 ${info.render.calls}  三角形 ${(info.render.triangles / 1000).toFixed(0)}k  帧率 ${fps.toFixed(0)}\n`
      + `FFT ${q.size}²×3  白浪场 ${q.foam.size}²  有效波高 ${ro.Hs.toFixed(2)} m（模拟 ${ro.simulatedHs.toFixed(2)}）\n`
      + `谱峰周期 ${ro.Tp ? ro.Tp.toFixed(1) : '—'} s  白浪覆盖 ${(ro.whitecapMeasured * 100).toFixed(2)}%  ${ro.beaufort.force} 级${ro.beaufort.name}\n`
      + `船速 ${b.speedKn.toFixed(2)} kn  视风 ${T.awsKn.toFixed(1)} kn  漂角 ${T.leeway.toFixed(1)}°  Fn ${T.Fn.toFixed(2)}`;
  }
}

// =====================================================================================
// 12. 菜单 / 卡片 / 面板 / 输入
// =====================================================================================
function show(id, on) { $(id).hidden = !on; }
function showTitle() {
  S.mode = 'title'; show('title', true); show('hud', false); show('pause', false); show('card', false); show('touch', false);
  const best = S.best.race ? `环岛赛最佳 ${fmtTime(S.best.race)} · ` : '';
  $('titleBest').textContent = `${best}已送信 ${S.delivered} 封 · 邮票 ${S.stamps} 枚`;
  CAM.mode = 'cine';
}
function resetBoatHome() {
  // 灯塔岛邮局码头外，船首朝北（宽横风）
  resetBoatAt(S.home.x, S.home.z, Math.PI + 0.05, 2.5);
}
function startPlay(race = false) {
  audio.init();
  if (!race && !S.mission) resetBoatHome();
  show('title', false); show('pause', false); show('card', false); show('hud', true); show('touch', IS_TOUCH);
  if (CAM.mode === 'cine') CAM.mode = 'chase';
  S.mode = 'play';
  S.sheetAuto = true; S.helm.mode = 'manual';
  yacht.setControls({ mode: 'manual', rudder: 0, sheet: 'auto', motor: 0 });
  if (race) startRace();
  else if (!S.mission) { if (!S.tutorialDone) startTutorial(); else startDelivery(); }
  canvas.focus();
}
function pauseGame(on) {
  if (on && S.mode !== 'play') return;
  if (!on && S.mode !== 'paused') return;
  S.mode = on ? 'paused' : 'play'; show('pause', on); $('hud').classList.toggle('off', on || S.hudHidden); $('touch').hidden = on || !IS_TOUCH;
  if (on) $('logStats').innerHTML = `<dt>已送信</dt><dd>${S.delivered} 封</dd><dt>邮票</dt><dd>${S.stamps} 枚</dd><dt>漂流瓶</dt><dd>${S.bottles} 个</dd><dt>本次航程</dt><dd>${(S.dist / 1852).toFixed(2)} 海里</dd><dt>航行时间</dt><dd>${fmtTime(S.playTime)}</dd><dt>环岛赛最佳</dt><dd>${S.best.race ? fmtTime(S.best.race) : '—'}</dd>`;
}
function showCard({ kicker, title, body, actions }) {
  S.mode = 'card'; $('hud').classList.add('off'); $('touch').hidden = true; $('cardKicker').textContent = kicker; $('cardTitle').textContent = title; $('cardBody').innerHTML = body;
  const box = $('cardActions'); box.innerHTML = '';
  actions.forEach((a, i) => { const bt = document.createElement('button'); bt.className = 'btn' + (a.primary ? '' : ' ghost'); bt.textContent = a.label; bt.onclick = () => { show('card', false); S.mode = 'play'; $('hud').classList.toggle('off', S.hudHidden); $('touch').hidden = !IS_TOUCH; a.fn(); canvas.focus(); }; box.appendChild(bt); if (i === 0) setTimeout(() => bt.focus(), 50); });
  show('card', true);
}
function togglePanel(on = !S.panel) { S.panel = on; show('panel', on); $('btnPanel').setAttribute('aria-pressed', String(on)); }
function setHud(hidden) { S.hudHidden = hidden; $('hud').classList.toggle('off', hidden); $('touch').style.opacity = hidden ? 0 : 1; }
function cycleCam() { CAM.mode = CAM.mode === 'chase' ? 'orbit' : CAM.mode === 'orbit' ? 'cine' : 'chase'; if (CAM.mode === 'orbit') CAM.orbitYaw = S.boat.yaw + Math.PI + CAM.yawOff; toast({ chase: '视角：追尾', orbit: '视角：环绕（拖动旋转）', cine: '视角：电影镜头' }[CAM.mode], 1.6); }
function toggleAssist(on = !P.assist) { P.assist = on; store.set('params2', P); $('pAssist').checked = on; S.helm.mode = 'manual'; toast(on ? '稳舵辅助：开（松开舵键时保持航向）' : '稳舵辅助：关（松开舵键舵回中）', 1.8); }

// ---------- 参数 → 场景 ----------
function applyParams() {
  const o = ocean.params, u = ocean.material.uniforms;
  o.choppiness = P.chop; o.foamAmount = P.foam; o.foamLifetime = P.foamLife; o.gustiness = P.gust;
  o.envIntensity = P.refl; o.biolumination = P.biolum;
  u.uDeepColor.value.set(P.deep); u.uSand.value.set(P.sand); u.uSSSColor.value.set(P.sss);
  u.uSSS.value.x = OCEAN_LOOK.sss.x * P.sssI;
  ocean.setDebugView(P.debug === 10 ? 0 : P.debug);
  ocean.material.wireframe = P.debug === 10;
  applyReflection();
  store.set('params2', P);
}
function applyReflection() {
  const on = P.planar && quality === 'high';
  ocean.setReflection(on ? planar.rt.texture : null, planar.textureMatrix, P.planarStr);
}
function setupPost() {
  post?.dispose();
  post = new CinematicComposer(renderer, scene, camera, { samples: quality === 'high' ? 4 : 0, reducedMotion: REDUCED_MOTION });
  // 与旧版《信风》的后期一致：ACES、曝光 0.5、泛光阈值 2.4；轻微的饱和、暗角、颗粒
  Object.assign(post.params, { toneMapping: 'ACES', exposure: P.expo, bloomStrength: P.bloom, bloomRadius: 0.55, bloomThreshold: 2.4,
    contrast: 1.04, saturation: 1.12, vignette: 0.36, vignetteSoftness: 0.5, grain: 0.012, chromaticAberration: 0.0008, sharpen: 0.1 });
  post.setSize(innerWidth, innerHeight, renderer.getPixelRatio());
}
function applyQuality() {
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, PIXEL_RATIO[quality]));
  if (ocean && ocean.quality !== quality) { ocean.setQuality(quality); applyParams(); }
  if (sky) sky.keyLight.castShadow = quality === 'high';
  setupPost();
  if (ocean) applyReflection();
  $('pQuality').value = quality; $('bQual').textContent = '画质：' + QUALITY_NAMES[quality];
  store.set('quality', quality); resize();
}
function cycleQuality() { quality = QUALITIES[(QUALITIES.indexOf(quality) + 1) % QUALITIES.length]; applyQuality(); }
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  if (post) post.setSize(w, h, renderer.getPixelRatio());
  if (planar) { const pr = renderer.getPixelRatio(); planar.setSize(Math.floor(w * pr / 2), Math.floor(h * pr / 2)); }
}
addEventListener('resize', resize);

function bindPanel() {
  const f2 = v => (+v).toFixed(2);
  const fmt = { sea: v => SEA_NAMES[Math.min(4, Math.floor(v * 4.99))], windFrom: v => Math.round(v) + '°', windKn: v => (+v).toFixed(1), chop: f2, foam: f2, foamLife: v => (+v).toFixed(2) + '×', gust: f2,
    sssI: f2, biolum: f2, refl: f2, planarStr: f2, daySpeed: v => (+v).toFixed(2) + '×', cloud: f2, fog: f2, expo: f2, bloom: f2 };
  const map = { pSea: 'sea', pWindDir: 'windFrom', pWindSpd: 'windKn', pChop: 'chop', pFoam: 'foam', pFoamLife: 'foamLife', pGust: 'gust', pSSSI: 'sssI', pBio: 'biolum',
    pRefl: 'refl', pPlanarStr: 'planarStr', pDay: 'daySpeed', pCloud: 'cloud', pFog: 'fog', pExpo: 'expo', pBloom: 'bloom' };
  const out = (id) => 'o' + id.slice(1);
  const weatherKeys = ['sea', 'windFrom', 'windKn'];
  const sync = () => {
    for (const [id, key] of Object.entries(map)) { $(id).value = P[key]; $(out(id)).textContent = fmt[key](P[key]); }
    $('pDeep').value = P.deep; $('pSand').value = P.sand; $('pSSS').value = P.sss; $('pPlanar').checked = P.planar; $('pDebug').value = String(P.debug);
    $('pAssist').checked = P.assist; $('pQuality').value = quality;
    $('pTime').value = S.hours; $('oTime').textContent = fmtClock(S.hours);
  };
  for (const [id, key] of Object.entries(map)) {
    // 拖动时风慢慢变（海面按物理规律响应）；松开时海况直接跳到新风况下的状态
    $(id).addEventListener('input', e => { P[key] = +e.target.value; $(out(id)).textContent = fmt[key](P[key]); if (weatherKeys.includes(key)) applyWeather(false); else applyParams(); post.params.exposure = P.expo; post.params.bloomStrength = P.bloom; });
    if (weatherKeys.includes(key)) $(id).addEventListener('change', () => { applyWeather(true); store.set('params2', P); });
  }
  for (const [id, key] of [['pDeep', 'deep'], ['pSand', 'sand'], ['pSSS', 'sss']]) $(id).addEventListener('input', e => { P[key] = e.target.value; applyParams(); });
  $('pPlanar').addEventListener('change', e => { P.planar = e.target.checked; applyParams(); });
  $('pAssist').addEventListener('change', e => toggleAssist(e.target.checked));
  $('pDebug').addEventListener('change', e => { P.debug = +e.target.value; applyParams(); });
  $('pTime').addEventListener('input', e => { S.hours = +e.target.value; $('oTime').textContent = fmtClock(S.hours); });
  $('pQuality').addEventListener('change', e => { quality = e.target.value; applyQuality(); });
  $('pReset').onclick = () => { P = { ...DEFAULTS, assist: P.assist }; applyParams(); applyWeather(true); post.params.exposure = P.expo; post.params.bloomStrength = P.bloom; sync(); toast('已恢复默认参数', 1.5); };
  $('pCopy').onclick = () => {
    const json = JSON.stringify(P, null, 1), ta = $('copyArea');
    const fallback = () => { ta.hidden = false; ta.value = json; ta.focus(); ta.select(); toast('已选中参数文本，按 Ctrl/⌘+C 复制', 2.2); };
    try { navigator.clipboard.writeText(json).then(() => toast('参数已复制', 1.5), fallback); } catch (e) { fallback(); }
  };
  $('panelClose').onclick = () => togglePanel(false);
  sync(); bindPanel.sync = sync;
}
function bindUI() {
  $('bStart').onclick = () => startPlay(false);
  $('bRace').onclick = () => startPlay(true);
  $('bQual').onclick = () => cycleQuality();
  $('bResume').onclick = () => pauseGame(false);
  $('bRace2').onclick = () => { pauseGame(false); startRace(); };
  $('bTitle').onclick = () => { show('pause', false); showTitle(); };
  $('btnPanel').onclick = () => togglePanel();
  $('btnCam').onclick = cycleCam;
  $('btnPhoto').onclick = () => setHud(!S.hudHidden);
  $('btnMute').onclick = () => { audio.setMuted(!audio.muted); $('btnMute').setAttribute('aria-pressed', String(audio.muted)); };
  $('btnPause').onclick = () => pauseGame(S.mode === 'play');
  $('btnTow').onclick = () => { if (S.mode === 'play') towToDeepWater(); };
  addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    input.keys.add(e.code);
    if (e.repeat) return;
    if (e.code === 'KeyT') togglePanel();
    else if (e.code === 'KeyC') cycleCam();
    else if (e.code === 'KeyH') setHud(!S.hudHidden);
    else if (e.code === 'KeyM') { audio.setMuted(!audio.muted); $('btnMute').setAttribute('aria-pressed', String(audio.muted)); }
    else if (e.code === 'KeyP' || e.code === 'Escape') { if (S.panel && e.code === 'Escape') togglePanel(false); else pauseGame(S.mode === 'play'); }
    else if (e.code === 'KeyQ') { cycleQuality(); toast('画质：' + QUALITY_NAMES[quality], 1.4); }
    else if (e.code === 'KeyE') { S.sheetAuto = true; toast('自动调帆', 1.2); }
    else if (e.code === 'KeyF') toggleAssist();
    else if (e.code === 'KeyR' && !$('btnTow').hidden && S.mode === 'play') towToDeepWater();
    else if ((e.code === 'Enter' || e.code === 'Space') && S.mode === 'title') startPlay(false);
  });
  addEventListener('keyup', e => input.keys.delete(e.code));
  addEventListener('blur', () => input.keys.clear());
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.mode === 'play') pauseGame(true); });
  // 鼠标 / 单指拖动环视，滚轮缩放
  let drag = null;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (CAM.mode === 'cine') { CAM.mode = 'orbit'; CAM.orbitYaw = S.boat.yaw + Math.PI; }
    if (CAM.mode === 'orbit') CAM.orbitYaw -= dx * 0.006; else CAM.yawOff -= dx * 0.006;
    CAM.pitch = clamp(CAM.pitch + dy * 0.004, 0.02, 1.25); CAM.lastDrag = S.elapsed;
  });
  const end = e => { if (drag && drag.id === e.pointerId) drag = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', e => { e.preventDefault(); CAM.dist = clamp(CAM.dist * Math.pow(1.0015, e.deltaY), 5, 110); }, { passive: false });
  // 触屏：左下舵盘（舵角）、右侧滑条（帆脚索）、马达 / 倒车按钮
  const stick = $('stick'), knob = stick.querySelector('i');
  const stickMove = e => { const r = stick.getBoundingClientRect(); const x = clamp((e.clientX - r.left - r.width / 2) / (r.width / 2), -1, 1); input.stickX = x; knob.style.left = (41 + x * 40) + 'px'; };
  stick.addEventListener('pointerdown', e => { stick.setPointerCapture(e.pointerId); stickMove(e); });
  stick.addEventListener('pointermove', e => { if (stick.hasPointerCapture(e.pointerId)) stickMove(e); });
  const stickEnd = () => { input.stickX = 0; knob.style.left = '41px'; };
  stick.addEventListener('pointerup', stickEnd); stick.addEventListener('pointercancel', stickEnd);
  const trimS = $('trimS'), tk = trimS.querySelector('i');
  const trimMove = e => { const r = trimS.getBoundingClientRect(); const v = clamp((e.clientY - r.top - 20) / (r.height - 40), 0, 1); S.sheet = v; S.sheetAuto = false; tk.style.top = (v * (r.height - 40)) + 'px'; };
  trimS.addEventListener('pointerdown', e => { trimS.setPointerCapture(e.pointerId); trimMove(e); });
  trimS.addEventListener('pointermove', e => { if (trimS.hasPointerCapture(e.pointerId)) trimMove(e); });
  for (const [id, key] of [['tMotor', 'motorTouch'], ['tAstern', 'asternTouch']]) {
    const bt = $(id);
    bt.addEventListener('pointerdown', e => { input[key] = true; bt.classList.add('on'); bt.setPointerCapture(e.pointerId); });
    const up = () => { input[key] = false; bt.classList.remove('on'); };
    bt.addEventListener('pointerup', up); bt.addEventListener('pointercancel', up);
  }
}

// =====================================================================================
// 13. 主循环
// =====================================================================================
let fps = 60, fpsAcc = 0, fpsN = 0;
function hoursRate(h) { // 每秒走多少“游戏小时”：默认一天约 12 分钟；黄昏放慢、深夜加快
  const base = 24 / 720; const slow = (h > 16.3 && h < 19.6) ? 0.5 : (h > 21 || h < 4.5) ? 1.5 : 1.0; return base * slow;
}
const _windEnv = { x: 0, z: 0 };
const _planarHide = [];
let frozen = false;                 // 测试用：冻结主循环，只按需渲染（软件渲染下截图才不会超时）
function frame() {
  requestAnimationFrame(frame);
  const dt = clock.getDelta();
  if (!frozen) tick(dt, true);
}
function tick(rawDt, render) {
  const dt = Math.min(rawDt, 1 / 20);
  fpsAcc += rawDt; fpsN++; if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  const live = S.mode === 'play' || S.mode === 'title';
  const sdt = live ? dt : 0;
  S.elapsed += sdt;
  if (live) {
    S.hours = (S.hours + sdt * hoursRate(S.hours) * P.daySpeed) % 24;
    updateWind(sdt);
    const x0 = S.boat.x, z0 = S.boat.z;
    if (S.mode === 'play') {
      S.playTime += dt;
      const k = input.keys;
      const steer = clamp((k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + input.stickX, -1, 1);
      setHelm(steer);
      setSheet((k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0), dt);
      S.motor = (k.has('ShiftLeft') || k.has('ShiftRight') || input.motorTouch) ? 1 : (k.has('KeyX') || input.asternTouch) ? -1 : 0;
      yacht.setControls({ motor: S.motor });
    } else {
      // 标题画面：舵机保持向北（宽横风），走远了就在镜头切换时悄悄送回起点
      yacht.setControls({ mode: 'heading', target: Math.PI + 0.05, sheet: 'auto', motor: 0 });
      if (Math.hypot(S.boat.x - S.home.x, S.boat.z - S.home.z) > 650 && CAM.cineT < 0.05) resetBoatHome();
    }
    _windEnv.x = S.windNow.x; _windEnv.z = S.windNow.y;
    yacht.step(sdt, { ocean: sea, wind: _windEnv, ground: groundAt });
    syncBoat();
    if (S.mode === 'play') updateMission(dt, x0, z0);
    updateGrounding(sdt);
    updateIronsHint(sdt);
  }
  updateBoatFx(sdt);
  updateBuoysAndBottles(sdt);
  updateCamera(live ? dt : 0.0001);
  sky.fogDensity = 0.00016 * P.fog + S.storm * 0.0012;
  // 风暴时云盖满天（面板的云量是晴天的值），否则风暴天空会露出明亮的缝，海面又把它们反射出来
  sky.update(render ? sdt : 0, { camera, timeOfDay: S.hours, cloudCover: lerp(P.cloud, 1, S.storm), storm: S.storm, wind: S.windNow, shadowTarget: boat.group.position });
  scene.environment = sky.environment; scene.environmentIntensity = sky.environmentIntensity;
  ocean.update(sdt, camera, sky);
  spume.update(sdt, ocean, camera);   // 大风时从正在破碎的浪峰撕下飞沫
  // 夜里飞沫带一点夜光藻的蓝光
  _sprayCol.setRGB(0.94, 0.97, 1.0).lerp(_bio.copy(OCEAN_LOOK.biolumColor).multiplyScalar(2.5 * P.biolum), sky.night * 0.7);
  spray.material.uniforms.uColor.value.copy(_sprayCol);
  spray.update(sdt, { keyLightDirection: sky.keyLightDirection, keyLightColor: sky.keyLightColor, ambientColor: sky.ambientColor, wind: S.windNow, waterHeight: waterAt });
  updateWorldFx(sdt);
  updateMarkers(sdt);
  if (bindPanel.sync && S.panel && Math.random() < 0.05) { $('pTime').value = S.hours; $('oTime').textContent = fmtClock(S.hours); }
  if (!render) return;
  renderer.info.reset();
  if (P.planar && quality === 'high') {
    _planarHide.length = 0;
    _planarHide.push(ocean.mesh, sky.object, spray.object, world.rain, world.ring, world.pillar, world.gateLine, world.lighthouse.beamPivot, world.bottleGlow, ...world.glows);
    planar.render(renderer, scene, camera, _planarHide);
  }
  renderer.shadowMap.needsUpdate = true;
  post.params.exposure = P.expo; post.params.bloomStrength = P.bloom;
  post.params.flash = sky.lightning * (REDUCED_MOTION ? 0.12 : 0.3);
  post.render(dt);
  updateHUD(dt);
  const ro = ocean.readout;
  audio.update(dt, { speed: S.boat.speed, aws: S.boat.aws, luff: yacht.sail.luff, sea: clamp(ro.Hs / 3, 0, 1), storm: S.storm, night: sky.night, day: 1 - sky.night,
    motor: yacht.telemetry.motor || 0, grind: yacht.ground.contact ? yacht.ground.slide : 0, bowWash: bowWave.intensity,
    nearLand: field.sample(S.boat.x, S.boat.z) > -25 || Math.min(...ISLANDS.map(i => Math.hypot(i.x - S.boat.x, i.z - S.boat.z) - i.r)) < 250 });
}

// =====================================================================================
// 14. 启动
// =====================================================================================
async function start(hot = {}) {
  try {
    if (hot.params) P = { ...DEFAULTS, ...hot.params };
    const loadMsg = (t) => { $('loading').querySelector('div').innerHTML = `<b>信风</b>${t}`; };
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, PIXEL_RATIO[quality]));
    renderer.setSize(innerWidth, innerHeight, false);
    await nextFrame();
    loadMsg('正在测量群岛水深…'); await nextFrame();
    field = new IslandField(ISLANDS); field.bake();
    loadMsg('正在起风生浪…'); await nextFrame();
    applyWeather(false);
    ocean = new Ocean(renderer, { quality, sea: { wind: { x: S.windMean.x, z: S.windMean.y }, fetch: 150e3, depth: 36, timeScale: 20, windResponse: 600 } });
    ocean.setBathymetry(field.texture, field.rect);
    scene.add(ocean.mesh);
    sky = new SkyEnvironment(renderer, { cubeSize: quality === 'high' ? 256 : 128, quality: quality === 'low' ? 'low' : 'high', shadows: true });
    scene.add(sky.object); scene.add(sky.lights);
    loadMsg('正在搭建码头和灯塔…'); await nextFrame();
    world = buildWorld(scene, field, sky, quality);
    loadMsg('正在放样船体…'); await nextFrame();
    // 物理船体与画面船体用同一组型线参数：浮力、阻力、稳性都按画面上这条船算
    yacht = new SailingYacht();
    yacht.autopilot.rudderRate = 30 * DEG;          // 手操舵：舵机速率 30°/s
    boat = new Sailboat({ hull: yacht.hull, mastHeight: yacht.options.mastHeight, sky, shadows: true });
    scene.add(boat.group);
    wake = new WakeMap(renderer, { resolution: IS_TOUCH ? 256 : 512, worldSize: 256 });
    hullWake = wake.createHullEmitter({ beam: boat.dims.beam, length: boat.dims.length });
    spray = new Spray({ max: IS_TOUCH ? 2500 : 5000 }); scene.add(spray.object);
    spume = new SpumeEmitter(spray, { maxRate: IS_TOUCH ? 300 : 1000 });
    bowWave = new BowWave(yacht, { ocean, spray, rate: IS_TOUCH ? 0.5 : 1 });
    planar = new PlanarReflection(2, 2);
    applyQuality(); applyParams(); applyWeather(true); bindPanel(); bindUI(); buildMapImage(); spawnBottles();
    setGates([]);
    // 起点：灯塔岛邮局码头外
    const hd = dockById('harbor'); const [sx0, sz0] = ensureWater(hd.pos.x + 28, hd.pos.z + 12, 6);
    S.home = { x: sx0, z: sz0 };
    resetBoatHome();
    S.hours = 17.2;
    sky.update(0, { camera, timeOfDay: S.hours, cloudCover: lerp(P.cloud, 1, S.storm), storm: S.storm, wind: S.windNow, shadowTarget: boat.group.position }); sky.forceUpdate();
    loadMsg('正在编译着色器…'); await nextFrame();
    // 预热：海面推进几步让 GPU 回读就位（之前船按平静水面算），再编译所有着色器
    updateCamera(1 / 30);
    for (let i = 0; i < 4; i++) { ocean.update(1 / 30, camera, sky); await nextFrame(); }
    renderer.compile(scene, camera);
    $('loading').classList.add('done');
    showTitle();
    requestAnimationFrame(frame);
  } catch (err) {
    console.error(err);
    $('loading').innerHTML = `<div style="max-width:34ch;text-align:center;line-height:1.6"><b>信风</b>无法启动 3D 画面：${String(err.message || err)}。请换用支持 WebGL2（含浮点渲染目标）的浏览器。</div>`;
  }
}
window.claude?.hot?.snapshot?.(() => ({ params: P }));
// 测试钩子（仅控制台用）
window.__game = {
  debug() {
    const b = S.boat, T = yacht.telemetry, ro = ocean.readout;
    return { mode: S.mode, time: +S.hours.toFixed(2), seaState: P.sea, storm: +S.storm.toFixed(2), speedKn: +b.speedKn.toFixed(2), surgeKn: +(b.surge * MS2KN).toFixed(2), heading: +b.heading.toFixed(1),
      wind: { fromDeg: P.windFrom, kn: +(S.windU * MS2KN).toFixed(1) }, heel: +b.heel.toFixed(1), twa: +b.twa.toFixed(1), awa: +b.awa.toFixed(1), leeway: +T.leeway.toFixed(1),
      rudder: +T.rudderAngle.toFixed(1), helm: S.helm.mode, sheet: S.sheetAuto ? 'auto' : +S.sheet.toFixed(2), motor: +(T.motor || 0).toFixed(2), thrust: Math.round(T.thrust || 0),
      reef: +T.reef.toFixed(2), irons: b.irons, pointOfSail: pointOfSail(b.twa, b.irons)[0], grounded: yacht.ground.contact, groundForce: Math.round(yacht.ground.force),
      mission: S.mission ? { type: S.mission.type, idx: S.mission.idx, started: S.mission.started, t: +(S.mission.t || 0).toFixed(1), par: S.mission.par, letter: S.mission.letter?.cargo } : null,
      boat: { x: +b.x.toFixed(1), y: +b.y.toFixed(2), z: +b.z.toFixed(1) }, waterAtBoat: +waterAt(b.x, b.z).toFixed(3), oceanReady: ocean.sim.ready,
      Hs: +ro.Hs.toFixed(2), simHs: +ro.simulatedHs.toFixed(2), Tp: +ro.Tp.toFixed(1), whitecap: +(ro.whitecapMeasured * 100).toFixed(2),
      calls: renderer.info.render.calls, tris: renderer.info.render.triangles, stamps: S.stamps, delivered: S.delivered, fps: +fps.toFixed(1), quality };
  },
  setTime(h) { S.hours = ((h % 24) + 24) % 24; },
  depth(x, z) { return +(-field.sample(x, z)).toFixed(2); },
  // 五封信各自的距离、航向真风角和金章时限（按当前风况）
  pars() {
    return LETTERS.map(L => { const a = dockById(L.from).pos, b = dockById(L.to).pos, wf = Math.atan2(-S.windMean.x, -S.windMean.y);
      return { from: L.from, to: L.to, dist: Math.round(Math.hypot(b.x - a.x, b.z - a.z)), twa: Math.round(Math.abs(wrapAngle(Math.atan2(b.x - a.x, b.z - a.z) - wf)) / DEG), par: Math.round(legTime(a.x, a.z, b.x, b.z) + 30) }; });
  },
  setSea(n) { P.sea = clamp(n, 0, 1); applyWeather(true); bindPanel.sync && bindPanel.sync(); },
  setWind(kn, fromDeg = P.windFrom) { P.windKn = kn; P.windFrom = fromDeg; applyWeather(true); bindPanel.sync && bindPanel.sync(); },
  // 方位按罗经（0 = 北，90 = 东）
  teleport(x, z, bearingDeg, speedKn = 3) { resetBoatAt(x, z, bearingDeg !== undefined ? yawOfBearing(bearingDeg) : S.boat.yaw, speedKn * KN2MS); },
  setHeading(bearingDeg) { const st = yacht.state; resetBoatAt(st.position.x, st.position.z, yawOfBearing(bearingDeg), S.boat.speed); },
  setControls(c) { yacht.setControls(c); },
  setCam(mode, opts = {}) { CAM.mode = mode; Object.assign(CAM, opts); CAM.snap = true; },
  start(race) { startPlay(!!race); },
  missionTarget() { const t = missionTarget(); return t && { x: t.x, z: t.z }; },
  docks() { return world.docks.map(d => ({ id: d.id, x: +d.pos.x.toFixed(1), z: +d.pos.z.toFixed(1) })); },
  buoys() { return world.buoys.map(b => ({ x: +b.obj.position.x.toFixed(1), y: +b.obj.position.y.toFixed(3), z: +b.obj.position.z.toFixed(1), water: +waterAt(b.obj.position.x, b.obj.position.z).toFixed(3), tilt: +(Math.hypot(b.obj.rotation.x, b.obj.rotation.z) / DEG).toFixed(1) })); },
  bottles() { return S.bottleList.filter(b => !b.got).map(b => ({ x: +b.x.toFixed(1), z: +b.z.toFixed(1), water: +waterAt(b.x, b.z).toFixed(3) })); },
  completeGate() { const m = S.mission; if (!m || !m.gates) return; const g = m.gates[Math.min(m.idx, m.gates.length - 1)]; const x0 = g.mid.x - g.dir.x * 4, z0 = g.mid.z - g.dir.z * 4; resetBoatAt(g.mid.x + g.dir.x * 4, g.mid.z + g.dir.z * 4, Math.atan2(g.dir.x, g.dir.z), 2); updateMission(0.016, x0, z0); },
  arriveDock() { const t = missionTarget(); if (!t || !t.dock) return; resetBoatAt(t.x, t.z, S.boat.yaw, 0.3); },
  setParam(k, v) { P[k] = v; applyParams(); if (['sea', 'windFrom', 'windKn'].includes(k)) applyWeather(true); bindPanel.sync && bindPanel.sync(); },
  setQuality(q) { if (OCEAN_QUALITY[q]) { quality = q; applyQuality(); } },
  pause(on) { pauseGame(on); },
  simulate(sec, step = 1 / 30) { for (let t = 0; t < sec; t += step) tick(step, false); },
  // 不渲染推进 n 帧；每 4 帧同步读一个像素并让出事件循环（软件渲染下 GPU 远慢于 JS，否则命令积压、回读落不了地）
  async step(n = 30, dt = 1 / 30) {
    const gl = renderer.getContext(), px = new Uint8Array(4);
    for (let i = 0; i < n; i++) {
      tick(dt, false);
      if (i % 4 === 3) { renderer.setRenderTarget(null); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); await new Promise(r => setTimeout(r, 0)); }
    }
  },
  // 冻结主循环（on = true）后用 render() 渲染当前状态的一帧并等 GPU 画完
  freeze(on = true) { frozen = !!on; clock.getDelta(); },
  render(dt = 0) {
    hudT = 0;                       // HUD 平时 20 Hz 刷新；按需渲染时强制刷新
    tick(dt, true);
    const gl = renderer.getContext(), px = new Uint8Array(4);
    renderer.setRenderTarget(null); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return this.debug();
  },
  state: S, params: () => P,
  get yacht() { return yacht; }, get ocean() { return ocean; }, get sky() { return sky; }, get boat() { return boat; }, get post() { return post; },
};
window.claude?.hot?.ready ? window.claude.hot.ready(start) : start(window.claude?.hot?.data ?? {});
