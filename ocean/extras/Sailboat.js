// =====================================================================================
// Sailboat —— 参数化船体放样 + 一条 8.6 m 单桅帆船（从《信风》抽出并加细节）
//
// 坐标约定（局部）：原点在水线中心（船长中点、y = 0 水线），船首朝 +Z，左舷（port）+X，右舷（starboard）−X，Y 向上。
//   group：交给使用者放位置 / 朝向（浮力、航向都设在它上面）
//   group.children[0] = model：内部再做一次横倾（update 的 heel），不需要就传 0
//
// HullGenerator / buildHull(params)：
//   沿船长取站位 s ∈ [0,1]（0 船尾方艉板 → 1 船首），每个横截面是超椭圆下半 |x/b|^e + |y/h|^e = 1：
//   e（bilge）小 → V 形底，大 → 圆舭。半宽 b(s)：船尾 transom·B，最宽处在 maxBeamAt，向船首按 entry 次方收尖。
//   龙骨线 keel(s) 两端上翘，舷弧 sheer(s) 船首抬高，flare 让舷侧外飘。
//   返回 { params, hull, transom, deck }，hull 带 aSheer 属性（该站位的舷弧高度，给漆色分区用）。
//
// class Sailboat(options)：
//   options: { hull: {…HullGenerator 参数}, mastHeight = 10.6, sailColor = '#efe6d2', topsideColor = '#0a3343',
//              name = '信风', sky = null（SkyEnvironment：给材质打天空雾补丁）, shadows = true }
//   floatPoints：8 个局部水线采样点（Vector3，y = 0），给浮力用
//   bowPoint / sternPoint：局部船首、船尾水线点（尾迹、浪花发射位置）
//   dims：{ length, beam, draft（含龙骨）, hullDraft, freeboard, mastHeight }
//   update(dt, { apparentWind /*Vector2 世界坐标，空气去向，m/s*/, sheet /*0 收紧 … 1 放松；省略 = 自动调帆*/,
//                heel /*弧度，正值桅顶倒向 +X*/, time, sky })
//     → 返回 sailState：{ side（帆在哪一侧：+1 = +X）, boomAngle, luff 0–1, fill 0–1, awaDeg（视风来向与船首夹角）,
//                          aws, heelTarget（按风压建议的横倾，弧度，可喂给浮力）}
//   lantern = true / false：艉灯 + 航行灯 + 舷窗
// =====================================================================================
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------- 程序纹理（DataTexture，不用 DOM） ----------------
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function hash(ix, iy, s) { let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(s, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return lerp(lerp(hash(ix, iy, s), hash(ix + 1, iy, s), ux), lerp(hash(ix, iy + 1, s), hash(ix + 1, iy + 1, s), ux), uy);
}
function makeTex(w, h, fn, { srgb = true, aniso = 8 } = {}) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x / w, y / h, x, y), i = (y * w + x) * 4;
    data[i] = clamp(c[0], 0, 255); data[i + 1] = clamp(c[1], 0, 255); data[i + 2] = clamp(c[2], 0, 255); data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}
// 柚木甲板：沿船长的窄板（纹理 v 方向），黑色捻缝，木纹顺板、板头错缝
function teakTextures() {
  const P = 16, W = 512, H = 512;
  const plankCol = Array.from({ length: P }, (_, i) => { const r = hash(i, 3, 5); return [150 + r * 22, 102 + r * 16, 60 + r * 10]; });
  const buttAt = Array.from({ length: P }, (_, i) => hash(i, 9, 7));
  const fn = (u, v) => {
    const pu = u * P, i = Math.floor(pu), fu = pu - i;
    const butt = Math.abs(((v + buttAt[i]) % 1) - 0.5) > 0.497;
    const seam = fu < 0.055 || butt;
    const c = plankCol[i];
    const g = Math.sin((fu * 7 + vnoise(fu * 3, v * 9 + i * 7, 11) * 3) * 6.28) * 0.5 + 0.5;
    const fine = vnoise(u * 300, v * 18, 13);
    const k = 0.86 + g * 0.1 + fine * 0.08;
    if (seam) return [40, 28, 20];
    return [c[0] * k, c[1] * k, c[2] * k];
  };
  const map = makeTex(W, H, fn);
  const bump = makeTex(W, H, (u, v) => { const pu = u * P, fu = pu - Math.floor(pu); const s = fu < 0.055 ? 40 : 200 + vnoise(u * 200, v * 14, 3) * 40; return [s, s, s]; }, { srgb: false });
  return { map, bump };
}
// 清漆木（桃花心木 / 云杉）：木纹沿 v
function varnishTexture(base, seed) {
  return makeTex(128, 512, (u, v) => {
    const warp = vnoise(u * 4, v * 3, seed) * 2.5;
    const ring = Math.sin((u * 9 + warp) * 6.28) * 0.5 + 0.5;
    const streak = vnoise(u * 60, v * 4, seed + 3);
    const k = 0.8 + ring * 0.14 + streak * 0.12;
    return [base[0] * k, base[1] * k, base[2] * k];
  }, { aniso: 8 });
}
// 船壳板缝（凹凸）：沿船长的细线，18 道
function hullSeamBump() {
  return makeTex(64, 512, (u, v) => { const f = (v * 18) % 1; const s = f < 0.04 ? 90 : 200 + vnoise(u * 30, v * 60, 21) * 25; return [s, s, s]; }, { srgb: false, aniso: 4 });
}

// ---------------- 船体放样 ----------------
export const HullGenerator = {
  defaults: { length: 8.6, beam: 2.75, draft: 0.92, freeboard: 0.8, sheerRise: 0.45, transom: 0.66, maxBeamAt: 0.42, entry: 1.7, bilge: 2.5, flare: 0.1, stations: 64, girth: 22 },
  halfBreadth(p, s) {
    const sm = p.maxBeamAt;
    if (s <= sm) { const t = (sm - s) / sm; return p.beam / 2 * (p.transom + (1 - p.transom) * (1 - t * t)); }
    const t = (s - sm) / (1 - sm); return p.beam / 2 * Math.max(0, 1 - Math.pow(t, p.entry));
  },
  keel(p, s) { const t = (s - 0.47) / 0.56; return -p.draft * Math.max(0.14, 1 - Math.pow(Math.abs(t), 2.2)); },
  sheer(p, s) { const t = s > 0.45 ? (s - 0.45) / 0.55 : (0.45 - s) / 0.45 * 0.4; return p.freeboard + p.sheerRise * t * t; },
  section(p, s, th) {
    const b = this.halfBreadth(p, s), k = this.keel(p, s), sh = this.sheer(p, s), e = p.bilge;
    const y = sh - (sh - k) * Math.pow(Math.cos(th), 2 / e);
    const x = b * Math.pow(Math.sin(th), 2 / e) * (1 + p.flare * clamp(y / p.freeboard, 0, 1));
    return [x, y];
  },
  zAt(p, s) { return s * p.length - p.length / 2; },        // s = 0 船尾（−Z）→ s = 1 船首（+Z）
  // 站位 s、高度 y 处的船体半宽（y 在龙骨与舷弧之间才有意义）
  halfWidthAt(p, s, y) {
    const sh = this.sheer(p, s), k = this.keel(p, s);
    if (y <= k || y >= sh) return y >= sh ? this.section(p, s, Math.PI / 2)[0] : 0;
    const c = Math.pow((sh - y) / (sh - k), p.bilge / 2), th = Math.acos(clamp(c, 0, 1));
    return this.halfBreadth(p, s) * Math.pow(Math.sin(th), 2 / p.bilge) * (1 + p.flare * clamp(y / p.freeboard, 0, 1));
  },
  // 某个高度 yc 处的水平截面封盖（平面反射的镜像相机从水下往上看时，挡住船舱内部）
  cap(p, yc, S = 40) {
    const pos = [], idx = [];
    for (let i = 0; i <= S; i++) {
      const s = i / S, z = this.zAt(p, s), x = this.halfWidthAt(p, s, yc) * 0.995;
      pos.push(-x, yc, z, x, yc, z);
    }
    for (let i = 0; i < S; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  },
  build(opts = {}) {
    const p = { ...this.defaults, ...opts }, S = p.stations, G = p.girth, cols = 2 * G + 1;
    const pos = [], uv = [], sheerA = [], idx = [];
    for (let i = 0; i <= S; i++) {
      const s = i / S, z = this.zAt(p, s), sh = this.sheer(p, s);
      for (let j = -G; j <= G; j++) {
        const [x, y] = this.section(p, s, Math.abs(j) / G * Math.PI / 2);
        pos.push(Math.sign(j) * x, y, z); uv.push(s * p.length / 2, (j + G) / (2 * G)); sheerA.push(sh);
      }
    }
    for (let i = 0; i < S; i++) for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);                            // 船首朝 +Z 时的外法线绕序
    }
    const hull = new THREE.BufferGeometry();
    hull.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    hull.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    hull.setAttribute('aSheer', new THREE.Float32BufferAttribute(sheerA, 1));
    hull.setIndex(idx); hull.computeVertexNormals();
    // 方艉板：从顶边中点做扇形
    const tp = [], tuv = [], zt = this.zAt(p, 0), shT = this.sheer(p, 0);
    tp.push(0, shT, zt); tuv.push(0.5, 1);
    for (let j = -G; j <= G; j++) { const [x, y] = this.section(p, 0, Math.abs(j) / G * Math.PI / 2); tp.push(Math.sign(j) * x, y, zt); tuv.push(0.5 + Math.sign(j) * x / p.beam, y / shT); }
    const ti = []; for (let j = 1; j < cols; j++) ti.push(0, j + 1, j);          // 法线朝 −Z（船尾外侧）
    const transom = new THREE.BufferGeometry();
    transom.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
    transom.setAttribute('uv', new THREE.Float32BufferAttribute(tuv, 2));
    transom.setAttribute('aSheer', new THREE.Float32BufferAttribute(new Array(tp.length / 3).fill(shT), 1));
    transom.setIndex(ti); transom.computeVertexNormals();
    // 甲板：舷弧高度处左右舷之间，带拱度
    const dp = [], du = [], di = [], W = 10;
    for (let i = 0; i <= S; i++) {
      const s = i / S, z = this.zAt(p, s), sh = this.sheer(p, s), [bx] = this.section(p, s, Math.PI / 2);
      for (let j = 0; j <= W; j++) { const t = j / W * 2 - 1; dp.push(t * bx * 0.985, sh + 0.05 * (1 - t * t) * (bx / (p.beam / 2)), z); du.push(t * bx / 1.4, z / 1.4); }
    }
    for (let i = 0; i < S; i++) for (let j = 0; j < W; j++) { const a = i * (W + 1) + j, b = a + 1, c = a + W + 1, d = c + 1; di.push(a, c, b, b, c, d); }
    const deck = new THREE.BufferGeometry();
    deck.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
    deck.setAttribute('uv', new THREE.Float32BufferAttribute(du, 2));
    deck.setIndex(di); deck.computeVertexNormals();
    return { params: p, hull, transom, deck };
  },
};
export function buildHull(params = {}) { return HullGenerator.build(params); }

// ---------------- 帆布着色器：缝线、帆骨袋、边缘加强、角补丁、逆光透射 ----------------
const SAIL_VERT = /* glsl */`varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vUv = uv; gl_Position = projectionMatrix * viewMatrix * w; }`;
const SAIL_FRAG = /* glsl */`
  uniform vec3 uKeyDir; uniform vec3 uKeyColor; uniform vec3 uAmb; uniform vec3 uSeaAmb; uniform vec3 uColor;
  uniform vec3 uLamp; uniform float uLampI; uniform float uBattens; uniform float uPanels;
  #ifdef USE_SKYFOG
  uniform samplerCube uSkyFogCube; uniform float uSkyFogDensity;
  #endif
  varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  float band(float x, float w){ return 1.0 - smoothstep(0.0, w, abs(x)); }
  void main(){
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(cameraPosition - vW);
    if (dot(N, V) < 0.0) N = -N;
    float u = vUv.x, v = vUv.y;
    // 布的结构：横向拼幅缝、帆骨袋（只有主帆）、后缘 / 前缘 / 下缘加强带、三个角的补丁
    float fv = fract(v * uPanels);
    float seam = band(min(fv, 1.0 - fv), 0.03 * uPanels / 7.0);                 // 拼幅缝（约 3 cm 宽的双层布）
    float panel = fract(sin(floor(v * uPanels) * 91.7 + uPanels) * 4375.85);   // 每幅布的织纹方向不同，亮度略有差别
    float batten = 0.0;
    for (int i = 1; i <= 4; i++) { float bv = float(i) * 0.2; batten = max(batten, band(v - bv, 0.012) * smoothstep(0.62 - bv * 0.25, 0.7 - bv * 0.25, u)); }
    batten *= uBattens;
    float tab = smoothstep(0.955, 0.975, u) + (1.0 - smoothstep(0.02, 0.035, u)) + (1.0 - smoothstep(0.015, 0.03, v));
    float patchC = 1.0 - smoothstep(0.09, 0.13, length(vec2(u, v) - vec2(1.0, 0.0)) );   // 后角
    float patchT = 1.0 - smoothstep(0.08, 0.12, length(vec2(u, v)));                       // 前角
    float patchH = 1.0 - smoothstep(0.06, 0.1, length(vec2(u * 0.6, v - 1.0)));             // 顶角
    float layers = 1.0 + seam * 0.8 + batten * 1.6 + min(tab, 1.0) * 1.0 + (patchC + patchT + patchH) * 1.3;
    vec3 base = uColor * (1.0 - 0.13 * seam - 0.08 * batten) * (1.0 - 0.06 * min(tab, 1.0)) * (0.965 + 0.07 * panel);
    float NdL = dot(N, uKeyDir);
    float front = max(NdL, 0.0), back = max(-NdL, 0.0);
    vec3 amb = mix(uSeaAmb, uAmb, N.y * 0.5 + 0.5);
    // 逆光透射：太阳在帆的另一侧时布被照透发暖，缝线、帆骨和补丁的影子透出来
    float tr = exp(-0.85 * (layers - 1.0));
    vec3 trans = uKeyColor * back * 0.72 * vec3(1.0, 0.86, 0.66) * tr;
    float spec = pow(max(dot(reflect(-uKeyDir, N), V), 0.0), 16.0) * 0.05;
    vec3 col = base * (uKeyColor * front * 0.92 + amb * 0.9 + trans) + uKeyColor * spec;
    float ld = length(uLamp - vW); col += base * vec3(1.0, 0.62, 0.3) * uLampI / (1.0 + ld * ld * 0.5);
    #ifdef USE_SKYFOG
    vec3 fd = vW - cameraPosition; float fdist = length(fd); fd /= max(fdist, 1e-3);
    vec3 hd = normalize(vec3(fd.x, max(fd.y, 0.0) + 0.012, fd.z));
    col = mix(col, textureLod(uSkyFogCube, hd, 2.5).rgb, 1.0 - exp(-uSkyFogDensity * fdist));
    #endif
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function makeGrid(nu, nv) {
  const g = new THREE.BufferGeometry(), n = (nu + 1) * (nv + 1);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const uvs = [], ix = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) uvs.push(i / nu, j / nv);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; ix.push(a, b, c, b, d, c); }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(ix); g.userData = { nu, nv };
  return g;
}
// 沿折线的细圆管（索具、护栏）：合并成一个几何体
function rodsGeometry(segments, radius, radial = 6) {
  const geos = [], up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), d = new THREE.Vector3();
  for (const [a, b, r] of segments) {
    d.subVectors(b, a); const len = d.length(); if (len < 1e-4) continue;
    const g = new THREE.CylinderGeometry(r || radius, r || radius, len, radial, 1, true);
    q.setFromUnitVectors(up, d.normalize());
    g.applyQuaternion(q); g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    geos.push(g);
  }
  const m = mergeGeometries(geos); geos.forEach((g) => g.dispose()); return m;
}
function tube(points, radius, closed = false, tubular = 48, radial = 8) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.5), tubular, radius, radial, closed);
}
function withSheer(g, value = 99) { g.setAttribute('aSheer', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(value), 1)); return g; }

export class Sailboat {
  constructor({ hull = {}, mastHeight = 10.6, sailColor = '#efe6d2', topsideColor = '#0a3343', name = '信风', sky = null, shadows = true } = {}) {
    const H = HullGenerator.build(hull), p = H.params;
    this.params = p; this.mastHeight = mastHeight;
    this.group = new THREE.Group(); this.group.name = 'Sailboat';
    this.model = new THREE.Group(); this.group.add(this.model);
    const M = this.model;
    this._disposables = [];
    const keep = (x) => { this._disposables.push(x); return x; };
    const fog = (m) => { if (sky && sky.applyFog) sky.applyFog(m); return m; };

    // —— 材质 ——
    const seams = keep(hullSeamBump());
    this._paint = {
      uTopside: { value: new THREE.Color(topsideColor) }, uBottom: { value: new THREE.Color(0.25, 0.035, 0.025) },
      uBoot: { value: new THREE.Color(0.86, 0.84, 0.78) }, uCove: { value: new THREE.Color(0.66, 0.45, 0.15) },
    };
    const hullMat = keep(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.18, bumpMap: seams, bumpScale: 0.6, envMapIntensity: 0.8 }));
    hullMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this._paint);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSheer; varying float vLy; varying float vSheer;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLy = position.y; vSheer = aSheer;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLy; varying float vSheer; uniform vec3 uTopside; uniform vec3 uBottom; uniform vec3 uBoot; uniform vec3 uCove;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float above = smoothstep(-0.075, -0.065, vLy);
          vec3 paint = mix(uBottom, uTopside, above);                                                  // 水线下防污漆
          paint = mix(paint, uBoot, smoothstep(-0.07, -0.06, vLy) * (1.0 - smoothstep(0.07, 0.08, vLy))); // 水线带
          paint = mix(paint, uCove, smoothstep(vSheer - 0.11, vSheer - 0.1, vLy) * (1.0 - smoothstep(vSheer - 0.05, vSheer - 0.04, vLy))); // 金色舷线
          diffuseColor.rgb *= paint;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(0.85, roughnessFactor, smoothstep(-0.075, -0.065, vLy));`)
        .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
          #ifdef USE_CLEARCOAT
            material.clearcoat *= smoothstep(-0.075, -0.065, vLy);
          #endif`);
    };
    hullMat.customProgramCacheKey = () => 'sailboat-hull';
    fog(hullMat);
    const teak = teakTextures(); keep(teak.map); keep(teak.bump);
    const teakMat = fog(keep(new THREE.MeshStandardMaterial({ map: teak.map, bumpMap: teak.bump, bumpScale: 1.2, roughness: 0.74, envMapIntensity: 0.6 })));
    const mahog = keep(varnishTexture([118, 58, 28], 31)), spruce = keep(varnishTexture([200, 140, 70], 47));
    const varnishMat = fog(keep(new THREE.MeshPhysicalMaterial({ map: mahog, roughness: 0.38, clearcoat: 0.9, clearcoatRoughness: 0.12, envMapIntensity: 0.8 })));
    const sparMat = fog(keep(new THREE.MeshPhysicalMaterial({ map: spruce, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.15, envMapIntensity: 0.8 })));
    const gelcoatMat = fog(keep(new THREE.MeshPhysicalMaterial({ color: 0xece5d6, roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 0.8 })));
    const steelMat = fog(keep(new THREE.MeshStandardMaterial({ color: 0xd2d4d6, roughness: 0.22, metalness: 0.95, envMapIntensity: 1.0 })));
    const wireMat = fog(keep(new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.35, metalness: 0.9 })));
    const bronzeMat = fog(keep(new THREE.MeshStandardMaterial({ color: 0xb07a3c, roughness: 0.35, metalness: 0.95 })));
    const darkMat = fog(keep(new THREE.MeshStandardMaterial({ color: 0x2a2219, roughness: 0.85 })));
    const capMat = keep(new THREE.MeshBasicMaterial({ color: 0x1c0907, side: THREE.DoubleSide }));

    const add = (geo, mat, { cast = true, receive = true, parent = M } = {}) => {
      const m = new THREE.Mesh(geo, mat); m.castShadow = cast && shadows; m.receiveShadow = receive && shadows; parent.add(m); keep(geo); return m;
    };

    // —— 船体、艉板、甲板、封盖 ——
    add(H.hull, hullMat); add(H.transom, hullMat); add(H.deck, teakMat, { cast: false });
    for (const yc of [0.06, 0.32, 0.6]) add(HullGenerator.cap(p, yc), capMat, { cast: false, receive: false });
    const sAt = (s) => HullGenerator.sheer(p, s), zAt = (s) => HullGenerator.zAt(p, s), bAt = (s) => HullGenerator.section(p, s, Math.PI / 2)[0];
    // 甲板面高度（带拱度）：站位 s、横向 x 处
    const deckTop = (s, x = 0) => { const bx = bAt(s) * 0.985, t = clamp(x / Math.max(bx, 1e-3), -1, 1); return sAt(s) + 0.05 * (1 - t * t) * (bx / (p.beam / 2)); };
    const sOfZ = (z) => (z + p.length / 2) / p.length;
    const deckY = sAt(0.5), zMast = zAt(0.6), zBow = zAt(1), zStern = zAt(0);
    this.deckY = deckY; this.zMast = zMast;

    // —— 长龙骨 + 艉挂舵（漆色分区沿用船体材质：全在水线下 → 防污红）——
    const keelShape = new THREE.Shape();
    const ks = [], kn = 18;
    for (let i = 0; i <= kn; i++) { const s = lerp(0.2, 0.72, i / kn); ks.push([zAt(s), HullGenerator.keel(p, s) + 0.06]); }
    keelShape.moveTo(ks[0][0], ks[0][1]);
    for (const [z, y] of ks) keelShape.lineTo(z, y);
    const kb = -1.36;
    keelShape.quadraticCurveTo(zAt(0.74), kb + 0.25, zAt(0.66), kb);
    keelShape.lineTo(zAt(0.3), kb);
    keelShape.quadraticCurveTo(zAt(0.2), kb + 0.05, ks[0][0], ks[0][1]);
    const keelGeo = new THREE.ExtrudeGeometry(keelShape, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 10 });
    keelGeo.rotateY(-Math.PI / 2); keelGeo.translate(0.07, 0, 0);
    add(withSheer(keelGeo), hullMat);
    const rud = new THREE.Shape();
    rud.moveTo(zStern - 0.02, sAt(0) - 0.15);
    rud.lineTo(zStern - 0.02, -0.95);
    rud.quadraticCurveTo(zStern - 0.1, -1.08, zStern - 0.42, -0.98);
    rud.quadraticCurveTo(zStern - 0.6, -0.5, zStern - 0.36, 0.05);
    rud.lineTo(zStern - 0.18, sAt(0) - 0.15);
    const rudGeo = new THREE.ExtrudeGeometry(rud, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2, curveSegments: 8 });
    rudGeo.rotateY(-Math.PI / 2); rudGeo.translate(0.03, 0, 0);
    add(withSheer(rudGeo), hullMat);

    // —— 护舷木条（沿舷弧，左右 + 艉部）——
    const railPts = (sx) => { const pts = []; for (let i = 0; i <= 24; i++) { const s = 0.005 + i / 24 * 0.985; pts.push(new THREE.Vector3(sx * bAt(s) * 0.995, sAt(s) + 0.035, zAt(s))); } return pts; };
    const railGeos = [tube(railPts(1), 0.04, false, 96, 6), tube(railPts(-1), 0.04, false, 96, 6)];
    railGeos.push(tube([new THREE.Vector3(bAt(0.005) * 0.99, sAt(0) + 0.035, zStern + 0.03), new THREE.Vector3(0, sAt(0) + 0.05, zStern + 0.02), new THREE.Vector3(-bAt(0.005) * 0.99, sAt(0) + 0.035, zStern + 0.03)], 0.04, false, 24, 6));

    // —— 舱室：圆角盒子、柚木顶、扶手、舱口、舷窗 ——
    const cabinZ = zMast - 0.55, cabinH = 0.62, cabinY = deckY + 0.24;
    const cabin = new RoundedBoxGeometry(1.55, cabinH, 2.5, 5, 0.14); cabin.translate(0, cabinY, cabinZ);
    const roof = new RoundedBoxGeometry(1.42, 0.07, 2.36, 3, 0.03); roof.translate(0, cabinY + cabinH / 2 + 0.02, cabinZ);
    const hatch = new RoundedBoxGeometry(0.62, 0.12, 0.7, 3, 0.04); hatch.translate(0, cabinY + cabinH / 2 + 0.1, cabinZ - 0.75);
    const handGeos = [];
    for (const sx of [-1, 1]) {
      const pts = [new THREE.Vector3(sx * 0.52, cabinY + cabinH / 2 + 0.06, cabinZ + 0.95), new THREE.Vector3(sx * 0.52, cabinY + cabinH / 2 + 0.11, cabinZ + 0.6),
        new THREE.Vector3(sx * 0.52, cabinY + cabinH / 2 + 0.11, cabinZ - 0.6), new THREE.Vector3(sx * 0.52, cabinY + cabinH / 2 + 0.06, cabinZ - 0.95)];
      handGeos.push(tube(pts, 0.022, false, 24, 6));
    }
    this._portMat = keep(new THREE.MeshStandardMaterial({ color: 0x1d2a36, emissive: 0xffb35c, emissiveIntensity: 0, roughness: 0.08, metalness: 0.2 }));
    const portRings = [], portGlass = [];
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
      const z = cabinZ + 0.75 - i * 0.7, x = sx * 0.776;
      const ring = new THREE.TorusGeometry(0.1, 0.016, 8, 24); ring.rotateY(Math.PI / 2); ring.translate(x + sx * 0.004, cabinY + 0.05, z); portRings.push(ring);
      const gl = new THREE.CircleGeometry(0.092, 20); gl.rotateY(sx * Math.PI / 2); gl.translate(x + sx * 0.002, cabinY + 0.05, z); portGlass.push(gl);
    }

    // —— 驾驶舱：舱底、座箱、座板、围板、舵柄、绞盘、主缭绳滑轨（都贴着带拱度的甲板面）——
    const cockZ = zStern + 1.55, cockS = sOfZ(cockZ), cockY = deckTop(cockS, 0);
    const sole = new THREE.BoxGeometry(1.25, 0.03, 2.1); sole.translate(0, cockY + 0.005, cockZ);
    const benches = [], coamings = [], benchBoxes = [];
    for (const sx of [-1, 1]) {
      const bb = new RoundedBoxGeometry(0.4, 0.3, 2.0, 2, 0.03); bb.translate(sx * 0.5, cockY + 0.1, cockZ); benchBoxes.push(bb);
      const bench = new RoundedBoxGeometry(0.42, 0.045, 2.02, 2, 0.015); bench.translate(sx * 0.5, cockY + 0.27, cockZ); benches.push(bench);
      const co = new RoundedBoxGeometry(0.05, 0.32, 2.3, 2, 0.02); co.translate(sx * 0.74, cockY + 0.2, cockZ + 0.1); coamings.push(co);
    }
    const tillerGeo = tube([new THREE.Vector3(0, sAt(0) + 0.3, zStern - 0.17), new THREE.Vector3(0, sAt(0) + 0.44, zStern + 0.4), new THREE.Vector3(0, cockY + 0.55, zStern + 1.25)], 0.032, false, 20, 8);
    const winchGeos = [];
    for (const sx of [-1, 1]) { const w = new THREE.CylinderGeometry(0.065, 0.085, 0.13, 20); w.translate(sx * 0.74, cockY + 0.42, cockZ + 0.55); winchGeos.push(w); }
    const travZ = cockZ - 0.9, traveler = new THREE.CylinderGeometry(0.018, 0.018, 1.2, 8); traveler.rotateZ(Math.PI / 2); traveler.translate(0, deckTop(sOfZ(travZ), 0) + 0.04, travZ);

    // —— 桅、撑臂、桅顶 ——
    const mastH = mastHeight; this._mastH = mastH;
    const mast = new THREE.CylinderGeometry(0.065, 0.1, mastH, 16); mast.translate(0, deckY + mastH / 2, zMast);
    const spreader = new RoundedBoxGeometry(1.5, 0.045, 0.07, 2, 0.015); spreader.translate(0, deckY + 6.4, zMast);
    const masthead = new THREE.BoxGeometry(0.14, 0.12, 0.22); masthead.translate(0, deckY + mastH + 0.02, zMast - 0.02);
    const partner = new THREE.CylinderGeometry(0.16, 0.18, 0.08, 16); partner.translate(0, deckTop(0.6, 0) + 0.03, zMast);

    // —— 静索（前支索、后支索、上 / 下侧支索）——
    const top = new THREE.Vector3(0, deckY + mastH - 0.12, zMast);
    const stem = new THREE.Vector3(0, sAt(0.995) + 0.05, zBow - 0.12);
    const sternPt = new THREE.Vector3(0, sAt(0) + 0.15, zStern + 0.06);
    const bMid = bAt(0.55) * 0.97, chainZ = zMast - 0.35;
    const sp6 = deckY + 6.4;
    const stay = [[top, stem], [top, sternPt]];
    for (const sx of [-1, 1]) {
      const sTip = new THREE.Vector3(sx * 0.75, sp6, zMast), chain = new THREE.Vector3(sx * bMid, sAt(0.55) + 0.04, chainZ);
      stay.push([top, sTip], [sTip, chain], [new THREE.Vector3(sx * 0.06, sp6 - 0.05, zMast), new THREE.Vector3(sx * bMid, sAt(0.52) + 0.04, chainZ - 0.45)]);
    }
    const stayGeo = rodsGeometry(stay, 0.0065, 5);

    // —— 护栏：立柱 + 两道钢索，船首 / 船尾护栏管 ——
    const rails = [], stanchions = [];
    const st0 = [];
    for (let i = 0; i <= 9; i++) { const s = 0.13 + i * 0.078; if (s > 0.86) break; st0.push(s); }
    for (const sx of [-1, 1]) {
      let p1 = null, p2 = null;
      for (const s of st0) {
        const bx = bAt(s) * 0.93, y = sAt(s), z = zAt(s);
        const a = new THREE.Vector3(sx * bx, y, z), b1 = new THREE.Vector3(sx * bx, y + 0.34, z), b2 = new THREE.Vector3(sx * bx, y + 0.62, z);
        stanchions.push([a, b2, 0.013]);
        if (p1) rails.push([p1, b1, 0.0045], [p2, b2, 0.0045]);
        p1 = b1; p2 = b2;
      }
    }
    const pulpitPts = []; for (let i = 0; i <= 12; i++) { const t = i / 12, sx = t * 2 - 1, s = lerp(0.88, 0.985, 1 - Math.abs(sx)); pulpitPts.push(new THREE.Vector3(sx * bAt(s) * 0.9, sAt(s) + 0.62, zAt(s))); }
    const pushPts = []; for (let i = 0; i <= 10; i++) { const t = i / 10, sx = t * 2 - 1, s = lerp(0.12, 0.02, 1 - Math.abs(sx)); pushPts.push(new THREE.Vector3(sx * bAt(Math.max(s, 0.01)) * 0.92, sAt(s) + 0.62, zAt(s) + 0.05)); }
    const pulpLegs = [];
    for (const sx of [-1, 1]) {
      pulpLegs.push([new THREE.Vector3(sx * bAt(0.9) * 0.9, sAt(0.9), zAt(0.9)), new THREE.Vector3(sx * bAt(0.9) * 0.9, sAt(0.9) + 0.62, zAt(0.9)), 0.013]);
      pulpLegs.push([new THREE.Vector3(sx * bAt(0.06) * 0.9, sAt(0.06), zAt(0.06) + 0.05), new THREE.Vector3(sx * bAt(0.06) * 0.9, sAt(0.06) + 0.62, zAt(0.06) + 0.05), 0.013]);
    }
    // —— 合并静态部件（按材质，减少绘制调用）——
    // RoundedBoxGeometry 是非索引几何体；混合时把带索引的也转成非索引再合并
    const merge = (list) => {
      const mixed = list.some((x) => !x.index) && list.some((x) => x.index);
      const src = mixed ? list.map((x) => (x.index ? x.toNonIndexed() : x)) : list;
      const g = mergeGeometries(src);
      list.forEach((x) => x.dispose()); if (mixed) src.forEach((x) => x.dispose());
      return g;
    };
    add(merge([rodsGeometry([...stanchions, ...pulpLegs], 0.013, 8), rodsGeometry(rails, 0.0045, 5), tube(pulpitPts, 0.014, false, 40, 8), tube(pushPts, 0.014, false, 36, 8), ...winchGeos, traveler, ...portRings]), steelMat, { receive: false });
    add(merge([...railGeos, ...handGeos, ...coamings, tillerGeo]), varnishMat);
    add(merge([cabin, hatch, ...benchBoxes]), gelcoatMat);
    add(merge([roof, ...benches]), teakMat);
    add(merge([mast, spreader, partner]), sparMat);
    add(merge([sole, masthead]), darkMat, { cast: false });
    add(stayGeo, wireMat, { receive: false });
    add(merge(portGlass), this._portMat, { cast: false });
    add(merge([new THREE.CylinderGeometry(0.05, 0.06, 0.12, 12).translate(0, sAt(0.995) + 0.02, zBow - 0.1),          // 船首铜件
      new THREE.CylinderGeometry(0.035, 0.035, 0.62, 10).translate(0, sAt(0) + 0.02, zStern - 0.17)]), bronzeMat);    // 舵头

    // —— 横杆（随帆转动）——
    this.boomPivot = new THREE.Group(); this.boomPivot.position.set(0, deckY + 1.25, zMast - 0.08); M.add(this.boomPivot);
    const boomLen = 3.9; this._boomLen = boomLen;
    const boomGeo = new THREE.CylinderGeometry(0.055, 0.065, boomLen, 12); boomGeo.rotateX(Math.PI / 2); boomGeo.translate(0, 0, -boomLen / 2);
    add(boomGeo, sparMat, { parent: this.boomPivot });
    add(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 10).rotateX(Math.PI / 2).translate(0, 0, 0.02), steelMat, { parent: this.boomPivot });

    // —— 帆 ——
    this.sailMaterial = keep(new THREE.ShaderMaterial({
      uniforms: {
        uKeyDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() }, uKeyColor: { value: new THREE.Color(1, 0.95, 0.88) },
        uAmb: { value: new THREE.Color(0.35, 0.45, 0.6) }, uSeaAmb: { value: new THREE.Color(0.03, 0.06, 0.08) }, uColor: { value: new THREE.Color(sailColor) },
        uLamp: { value: new THREE.Vector3() }, uLampI: { value: 0 }, uBattens: { value: 1 }, uPanels: { value: 7 },
        ...(sky && sky.fogUniforms ? sky.fogUniforms : {}),
      },
      defines: sky && sky.fogUniforms ? { USE_SKYFOG: '' } : {},
      vertexShader: SAIL_VERT, fragmentShader: SAIL_FRAG, side: THREE.DoubleSide,
    }));
    // 前帆：共用同一组光照 uniform 对象（不用 clone：渲染目标纹理不能被 cloneUniforms 复制）
    this.jibMaterial = keep(new THREE.ShaderMaterial({
      uniforms: { ...this.sailMaterial.uniforms, uBattens: { value: 0 }, uPanels: { value: 6 } },
      defines: { ...this.sailMaterial.defines }, vertexShader: SAIL_VERT, fragmentShader: SAIL_FRAG, side: THREE.DoubleSide,
    }));
    this._mainGeo = makeGrid(16, 22); this._jibGeo = makeGrid(12, 16);
    const mainSail = add(this._mainGeo, this.sailMaterial, { receive: false, parent: this.boomPivot }); mainSail.frustumCulled = false;
    const jib = add(this._jibGeo, this.jibMaterial, { receive: false }); jib.frustumCulled = false;

    // —— 动索（帆脚索）、风向标、艉旗 ——
    this._sheetGeo = keep(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]));
    const sheets = new THREE.LineSegments(this._sheetGeo, keep(new THREE.LineBasicMaterial({ color: 0xcab89a }))); sheets.frustumCulled = false; M.add(sheets);
    this._penGeo = keep(new THREE.BufferGeometry()); this._penGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3).setUsage(THREE.DynamicDrawUsage));
    const pen = new THREE.Mesh(this._penGeo, fog(keep(new THREE.MeshBasicMaterial({ color: 0xc8402e, side: THREE.DoubleSide })))); pen.frustumCulled = false; M.add(pen);
    const staffBase = new THREE.Vector3(-0.55, deckTop(0.03, -0.55), zAt(0.03) + 0.05);
    add(new THREE.CylinderGeometry(0.013, 0.016, 1.3, 6).translate(staffBase.x, staffBase.y + 0.65, staffBase.z), varnishMat);
    this._flagBase = staffBase.clone().add(new THREE.Vector3(0, 1.28, 0));
    this._flagGeo = makeGrid(10, 6); keep(this._flagGeo);
    const flagTex = keep(makeTex(128, 64, (u, v) => { const t = clamp((v + u * 0.5 - 0.75) * 90 + 0.5, 0, 1); return [150 + 70 * t, 36 + 170 * t, 30 + 138 * t]; }, { aniso: 4 }));
    const flag = new THREE.Mesh(this._flagGeo, fog(keep(new THREE.MeshStandardMaterial({ map: flagTex, side: THREE.DoubleSide, roughness: 0.8 })))); flag.frustumCulled = false; flag.castShadow = shadows; M.add(flag);

    // —— 灯：艉灯（暖光点光源）、左红右绿舷灯、艉白灯、桅顶白灯 ——
    this._lampPos = new THREE.Vector3(0.35, sAt(0.02) + 0.78, zStern + 0.32);
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.62, 6).translate(this._lampPos.x, this._lampPos.y - 0.36, this._lampPos.z), steelMat);
    this._lampMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.7, 0.35) }));
    const lamp = new THREE.Mesh(keep(new THREE.SphereGeometry(0.075, 14, 10)), this._lampMat); lamp.position.copy(this._lampPos); M.add(lamp);
    const cage = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.06, 0.08, 0.16, 8, 1, true)), keep(new THREE.MeshStandardMaterial({ color: 0x302820, metalness: 0.6, roughness: 0.5, wireframe: true }))); cage.position.copy(this._lampPos); M.add(cage);
    this.lampLight = new THREE.PointLight(0xffa64d, 0, 18, 1.6); this.lampLight.position.copy(this._lampPos).add(new THREE.Vector3(0, 0.2, 0)); M.add(this.lampLight);
    const navBox = new THREE.BoxGeometry(0.06, 0.05, 0.09); keep(navBox);
    this._navMats = { port: keep(new THREE.MeshBasicMaterial({ color: 0x400808 })), stbd: keep(new THREE.MeshBasicMaterial({ color: 0x083008 })), white: keep(new THREE.MeshBasicMaterial({ color: 0x303030 })) };
    const navP = new THREE.Mesh(navBox, this._navMats.port); navP.position.set(bAt(0.9) * 0.9, sAt(0.9) + 0.5, zAt(0.9)); M.add(navP);
    const navS = new THREE.Mesh(navBox, this._navMats.stbd); navS.position.set(-bAt(0.9) * 0.9, sAt(0.9) + 0.5, zAt(0.9)); M.add(navS);
    const navW = new THREE.Mesh(navBox, this._navMats.white); navW.position.set(0, deckY + mastH + 0.12, zMast); M.add(navW);
    const navT = new THREE.Mesh(navBox, this._navMats.white); navT.position.set(-0.35, sAt(0.02) + 0.64, zStern + 0.15); M.add(navT);

    // —— 艉板船名（有 canvas 才画；没有就跳过）——
    try {
      const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(512, 128) : (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 512, height: 128 }) : null);
      if (cv && name) {
        const g = cv.getContext('2d');
        g.clearRect(0, 0, 512, 128); g.fillStyle = '#d9aa55'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = '700 74px "Ma Shan Zheng","KaiTi","STKaiti","Songti SC",serif'; g.fillText(name, 256, 56);
        g.font = '600 19px "IBM Plex Mono",monospace'; g.fillText('W I N D P O S T', 256, 112);
        const tex = keep(new THREE.CanvasTexture(cv)); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
        const plate = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.3, 0.32)), fog(keep(new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.35, metalness: 0.5 }))));
        plate.position.set(0, sAt(0) - 0.3, zStern - 0.012); plate.rotation.y = Math.PI; M.add(plate);
      }
    } catch (e) { /* 没有 canvas 就不画船名 */ }

    // —— 对外的数据 ——
    this._rig = { top, stem, sternPt, deckY, zMast, zBow, zStern, mastH };
    this.bowPoint = new THREE.Vector3(0, 0, zBow - 0.3);
    this.sternPoint = new THREE.Vector3(0, 0, zStern + 0.2);
    this.floatPoints = [new THREE.Vector3(0, 0, zAt(0.93)), new THREE.Vector3(0, 0, zAt(0.06))];
    for (const s of [0.22, 0.5, 0.76]) { const b = HullGenerator.halfWidthAt(p, s, 0) * 0.9, z = zAt(s); this.floatPoints.push(new THREE.Vector3(b, 0, z), new THREE.Vector3(-b, 0, z)); }
    this.dims = { length: p.length, beam: p.beam, draft: -kb, hullDraft: p.draft, freeboard: p.freeboard, mastHeight: mastH };
    this.sailState = { side: 1, boomAngle: 0.3, luff: 0, fill: 1, awaDeg: 90, aws: 0, heelTarget: 0 };
    this._boom = { ang: 0.3, vel: 0 };
    this._time = 0;
    this.lantern = false;
    this.update(0, { apparentWind: new THREE.Vector2(-4, 0) });
  }

  get lantern() { return this._lantern; }
  set lantern(on) {
    this._lantern = !!on;
    const k = on ? 1 : 0;
    this.lampLight.intensity = 3.0 * k;
    this._lampMat.color.setRGB(1, 0.65, 0.3).multiplyScalar(on ? 4.0 : 0.35);
    this._portMat.emissiveIntensity = 2.2 * k;
    this._navMats.port.color.setRGB(on ? 8 : 0.25, on ? 0.25 : 0.03, on ? 0.2 : 0.03);
    this._navMats.stbd.color.setRGB(on ? 0.2 : 0.03, on ? 7 : 0.2, on ? 0.5 : 0.03);
    this._navMats.white.color.setScalar(on ? 7 : 0.2);
    this.sailMaterial.uniforms.uLampI.value = 0.9 * k;
  }

  update(dt = 0, { apparentWind, sheet, heel = 0, time, sky } = {}) {
    this._time = time !== undefined ? time : this._time + (dt || 0);
    const t = this._time, st = this.sailState;
    // —— 光照 ——
    if (sky) {
      const u = this.sailMaterial.uniforms;
      u.uKeyDir.value.copy(sky.keyLightDirection); u.uKeyColor.value.copy(sky.keyLightColor); u.uAmb.value.copy(sky.ambientColor);
      u.uSeaAmb.value.copy(sky.ambientColor).multiplyScalar(0.22).add(new THREE.Color(0.005, 0.02, 0.03));
    }
    // —— 视风换到船的局部坐标：wl.x 朝 +X（左舷），wl.y 朝 +Z（船首）——
    this.group.updateMatrixWorld();
    const e = this.group.matrixWorld.elements;
    const fx = e[8], fz = e[10], px = e[0], pz = e[2];
    const fl = Math.hypot(fx, fz) || 1, pl = Math.hypot(px, pz) || 1;
    const aw = apparentWind || this._lastAW || new THREE.Vector2(0, -3);
    this._lastAW = aw;
    const wlx = (aw.x * px + aw.y * pz) / pl, wlz = (aw.x * fx + aw.y * fz) / fl;
    const aws = Math.hypot(wlx, wlz);
    const awaFrom = Math.atan2(-wlx, -wlz);                     // 视风来向与船首夹角：0 迎风，±π 正顺风
    const awa = Math.abs(awaFrom);
    // 帆在下风一侧；接近正顺风时加一点滞回，避免左右来回翻
    let side = st.side;
    if (Math.abs(wlx) > 0.12 * aws || awa < 2.6) side = wlx >= 0 ? 1 : -1;
    // 目标横杆角：手动收放或自动调帆（攻角 ≈ 0.3 rad）
    const mag = sheet !== undefined ? lerp(0.06, 1.45, clamp(sheet, 0, 1)) : clamp((awa - 0.35) * 0.62, 0.06, 1.45);
    const attack = awa - mag;
    const luff = 1 - smoothstep(0.02, 0.2, attack);
    const fill = smoothstep(0.4, 3.5, aws) * (1 - 0.55 * luff);
    // 横杆：弹簧阻尼，换舷时自己甩过去
    const B = this._boom, target = side * mag;
    if (dt > 0) {
      const h = Math.min(dt, 1 / 30);
      for (let k = 0; k < Math.ceil(dt / h); k++) { B.vel += ((target - B.ang) * 10 - B.vel * 3.4) * h; B.ang += B.vel * h; }
    } else { B.ang = target; B.vel = 0; }
    st.side = side; st.boomAngle = B.ang; st.luff = luff; st.fill = fill; st.aws = aws; st.awaDeg = awa * 180 / Math.PI;
    st.heelTarget = side * clamp(0.0045 * aws * aws * Math.sin(Math.min(awa, Math.PI / 2)) * (1 - luff), 0, 0.42);
    this.model.rotation.z = -heel;
    this._updateSails(t, side, fill, luff, sheet !== undefined ? clamp(sheet, 0, 1) : clamp((awa - 0.35) / 2.6, 0, 1), wlx, wlz, aws);
    return st;
  }

  /**
   * 由船体物理（ocean/vessel 的 SailingYacht.sail）直接驱动帆的外观，代替 update 里的经验调帆与横倾。
   *   s = { side（+1：帆在 +X 左舷）, boomAngle（弧度，带符号，+ 为横杆甩向 +X）, jibSheet 0–1, luff 0–1, fill 0–1,
   *         awLocal: { x, z }（船体坐标里桅顶处视风的去向，m/s）, aws }
   *   船的位置、姿态（含横倾、纵摇）由调用者写在 group 上（见 ocean/vessel/three-adapter.js 的 applyToThree）。
   */
  applyPhysics(dt = 0, s = {}, { time, sky } = {}) {
    this._time = time !== undefined ? time : this._time + (dt || 0);
    if (sky) {
      const u = this.sailMaterial.uniforms;
      u.uKeyDir.value.copy(sky.keyLightDirection); u.uKeyColor.value.copy(sky.keyLightColor); u.uAmb.value.copy(sky.ambientColor);
      u.uSeaAmb.value.copy(sky.ambientColor).multiplyScalar(0.22).add(new THREE.Color(0.005, 0.02, 0.03));
    }
    const side = s.side >= 0 ? 1 : -1, B = this._boom, target = s.boomAngle ?? side * 0.3;
    if (dt > 0) {                                     // 横杆弹簧阻尼地跟随物理给出的角度（顺风换舷时自己甩过去）
      const h = Math.min(dt, 1 / 30);
      for (let k = 0; k < Math.ceil(dt / h); k++) { B.vel += ((target - B.ang) * 10 - B.vel * 3.4) * h; B.ang += B.vel * h; }
    } else { B.ang = target; B.vel = 0; }
    const wl = s.awLocal || { x: 0, z: -1 }, aws = s.aws ?? Math.hypot(wl.x, wl.z), st = this.sailState;
    st.side = side; st.boomAngle = B.ang; st.luff = s.luff ?? 0; st.fill = s.fill ?? 1; st.aws = aws;
    // 缩帆：帆的线尺寸按 reef 缩小（面积 reef²），与 Sails 的受力模型一致；平滑过渡，像慢慢收帆
    const rf = clamp(s.reef ?? 1, 0.3, 1);
    this._reef = this._reef === undefined || !(dt > 0) ? rf : this._reef + (rf - this._reef) * (1 - Math.exp(-dt / 1.5));
    st.awaDeg = Math.abs(Math.atan2(-wl.x, -wl.z)) * 180 / Math.PI; st.heelTarget = 0;
    this.model.rotation.z = 0;
    this._updateSails(this._time, side, st.fill, st.luff, clamp(s.jibSheet ?? 0.3, 0, 1), wl.x, wl.z, aws);
    return st;
  }

  _updateSails(t, side, fill, luff, jibSheet, wlx, wlz, aws) {
    const R = this._rig;
    // 主帆：在 boomPivot 局部坐标里生成（弦向 −Z、下风 +X·side），横杆绕 y 转动
    this.boomPivot.rotation.y = -this._boom.ang;
    const pa = this._mainGeo.attributes.position.array, { nu, nv } = this._mainGeo.userData;
    const rf = this._reef ?? 1;                       // 缩帆：线尺寸比例
    const boomLen = this._boomLen, luffLen = (R.mastH - 1.6) * rf;
    const depth = 0.12 * fill * (1 - 0.5 * luff);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv, y = 0.1 + v * luffLen;
      const chord = ((boomLen - 0.15) * Math.pow(1 - v, 0.95) + 0.18 + 0.35 * Math.sin(Math.PI * v) * (1 - v)) * rf;
      const tw = v * 0.22 * fill, ct = Math.cos(tw), stw = Math.sin(tw);
      for (let i = 0; i <= nu; i++) {
        const u = i / nu, k = (j * (nu + 1) + i) * 3;
        const cam = 4 * u * (1 - u) * (1 - 0.3 * u) * (1 - 0.35 * v);
        let xc = depth * chord * cam * 1.25;
        xc += luff * 0.07 * chord * Math.sin(t * 17 - u * 9 + v * 4) * Math.sin(Math.PI * u) * (0.25 + u);
        const along = u * chord;
        pa[k] = side * (along * stw + xc * ct); pa[k + 1] = y; pa[k + 2] = -along * ct + xc * stw;
      }
    }
    this._mainGeo.attributes.position.needsUpdate = true; this._mainGeo.computeVertexNormals();
    // 前帆：前角在船首，顶角在桅上，后角随帆脚索甩向下风
    const T = new THREE.Vector3(0, R.stem.y + 0.05, R.stem.z - 0.08), Hd = new THREE.Vector3(0, R.deckY + 8.3, R.zMast + 0.06);
    const ang = 0.12 + jibSheet * 0.75;
    const C = new THREE.Vector3(side * Math.sin(ang) * 2.7, R.deckY + 0.95, R.zBow - 0.3 - Math.cos(ang) * 2.7);
    if (rf < 1) { Hd.sub(T).multiplyScalar(rf).add(T); C.sub(T).multiplyScalar(rf).add(T); }   // 卷帆：顶角、后角向前角收
    const nrm = new THREE.Vector3().subVectors(Hd, T).cross(new THREE.Vector3().subVectors(C, T)).normalize();
    if (nrm.x * side < 0) nrm.negate();
    const ja = this._jibGeo.attributes.position.array, ju = this._jibGeo.userData.nu, jv = this._jibGeo.userData.nv;
    const jd = 0.11 * fill * (1 - 0.5 * luff);
    for (let j = 0; j <= jv; j++) {
      const v = j / jv;
      for (let i = 0; i <= ju; i++) {
        const u = i / ju, k = (j * (ju + 1) + i) * 3;
        const lx = T.x + (Hd.x - T.x) * v, ly = T.y + (Hd.y - T.y) * v, lz = T.z + (Hd.z - T.z) * v;
        const ex = C.x + (Hd.x - C.x) * v, ey = C.y + (Hd.y - C.y) * v, ez = C.z + (Hd.z - C.z) * v;
        const ch = Math.hypot(ex - lx, ey - ly, ez - lz);
        const bulge = jd * ch * 4 * u * (1 - u) + luff * 0.06 * ch * Math.sin(t * 19 - u * 8 + v * 3) * Math.sin(Math.PI * u);
        ja[k] = lx + (ex - lx) * u + nrm.x * bulge; ja[k + 1] = ly + (ey - ly) * u + nrm.y * bulge; ja[k + 2] = lz + (ez - lz) * u + nrm.z * bulge;
      }
    }
    this._jibGeo.attributes.position.needsUpdate = true; this._jibGeo.computeVertexNormals();
    // 帆脚索：主帆后角 → 驾驶舱滑轨；前帆后角 → 绞盘
    const a = -this._boom.ang, bp = this.boomPivot.position, dl = boomLen - 0.12;
    const clx = bp.x - dl * Math.sin(a), clz = bp.z - dl * Math.cos(a);      // 横杆末端（R_y(a)·(0,0,−dl)）
    const sp = this._sheetGeo.attributes.position.array;
    sp.set([clx, bp.y + 0.05, clz, 0, R.deckY + 0.08, R.zStern + 0.65, C.x, C.y, C.z, side * 0.74, R.deckY + 0.42, R.zStern + 2.1]);
    this._sheetGeo.attributes.position.needsUpdate = true;
    // 桅顶风向标：指向视风去向
    const wl = Math.hypot(wlx, wlz) || 1, dx = wlx / wl, dz = wlz / wl, fl = Math.sin(t * 14) * 0.08;
    const pp = this._penGeo.attributes.position.array, top = R.top;
    pp.set([0, top.y + 0.42, top.z, 0, top.y + 0.2, top.z, dx * 0.9 - dz * fl, top.y + 0.31 + fl, top.z + dz * 0.9 + dx * fl]);
    this._penGeo.attributes.position.needsUpdate = true;
    // 艉旗：顺风飘，风小时下垂
    const fa = this._flagGeo.attributes.position.array, fnU = this._flagGeo.userData.nu, fnV = this._flagGeo.userData.nv, base = this._flagBase;
    const droop = 1 - smoothstep(0.5, 4, aws), W = 0.6, Hh = 0.38;
    const dirX = dx * (1 - droop), dirY = -droop, dirZ = dz * (1 - droop), dn = Math.hypot(dirX, dirY, dirZ) || 1;
    const perpX = -dz, perpZ = dx;
    for (let j = 0; j <= fnV; j++) for (let i = 0; i <= fnU; i++) {
      const u = i / fnU, v = j / fnV, k = (j * (fnU + 1) + i) * 3;
      const wave = Math.sin(t * (6 + aws * 0.9) - u * 7 + v * 0.8) * 0.06 * u * (0.4 + Math.min(aws, 10) * 0.06);
      fa[k] = base.x + dirX / dn * u * W + perpX * wave;
      fa[k + 1] = base.y - (1 - v) * Hh + dirY / dn * u * W * 0.5;
      fa[k + 2] = base.z + dirZ / dn * u * W + perpZ * wave;
    }
    this._flagGeo.attributes.position.needsUpdate = true; this._flagGeo.computeVertexNormals();
    // 艉灯照亮帆
    this.sailMaterial.uniforms.uLamp.value.copy(this._lampPos).applyMatrix4(this.model.matrixWorld);
  }

  dispose() { for (const d of this._disposables) if (d && d.dispose) d.dispose(); this._disposables.length = 0; }
}
