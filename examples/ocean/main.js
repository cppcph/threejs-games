// 风生浪 · 可复用海面模块（ocean/）的电影级演示
//
// 风 → WindSeaModel（按生长律起浪、积累、转涌）→ OceanSimulation（GPU FFT）→ 海面着色与白浪场；
// 同一股风还驱动帆船（ocean/vessel：六自由度刚体，帆、龙骨、舵的力与船体水压积分）、阵风波纹、飞沫和雨丝。
import * as THREE from 'three';
import { Ocean, beaufort, seaStateScale } from '../../ocean/index.js';
import { SkyEnvironment } from '../../ocean/SkyEnvironment.js';
import { CinematicComposer } from '../../ocean/CinematicComposer.js';
import { WakeMap } from '../../ocean/WakeMap.js';
import { Spray, SpumeEmitter } from '../../ocean/Spray.js';
import { Sailboat } from '../../ocean/extras/Sailboat.js';
import { SailingYacht } from '../../ocean/vessel/index.js';
import { applyToThree, emitSpray, driveWake } from '../../ocean/vessel/three-adapter.js';
import { BowWave } from '../../ocean/extras/BowWave.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (rate, dt) => 1 - Math.exp(-rate * dt);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const DEG = Math.PI / 180;
const isTouch = matchMedia('(pointer: coarse)').matches;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function fail(msg) {
  const el = $('loading');
  el.classList.remove('done');
  el.innerHTML = `<div class="error">${msg}</div>`;
}

// ------------------------------------------------------------------ 渲染器与模块
const canvas = $('view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  fail('这个浏览器没有开启 WebGL，海面无法显示。请换用最新版 Chrome、Edge、Safari 或 Firefox。');
  throw e;
}
const DPR = Math.min(devicePixelRatio || 1, isTouch ? 1.25 : 1.5);
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 200000);

let quality = isTouch ? 'medium' : 'high';
const sky = new SkyEnvironment(renderer, { cubeSize: isTouch ? 128 : 256 });
scene.add(sky.object);
scene.add(sky.lights);

let ocean;
try {
  // windResponse 600 s：U10 按气象惯例取 10 分钟平均风，阵风只改变细小波纹
  ocean = new Ocean(renderer, { quality, sea: { wind: { x: 0, z: 8 }, fetch: 400e3, depth: 3000, timeScale: 20, windResponse: 600 } });
} catch (e) {
  fail('这台设备不支持渲染到浮点纹理（WebGL2 的 EXT_color_buffer_float），FFT 海面无法运行。');
  throw e;
}
scene.add(ocean.mesh);

// 物理船体与画面船体用同一组型线参数：浮力、阻力、稳性都按画面上这条船算
const yacht = new SailingYacht();
const boat = new Sailboat({ hull: yacht.hull, mastHeight: yacht.options.mastHeight, sky, shadows: false });
scene.add(boat.group);
const wake = new WakeMap(renderer, { resolution: isTouch ? 256 : 512, worldSize: 256 });
const hullWake = wake.createHullEmitter({ beam: boat.dims.beam, length: boat.dims.length });
const spray = new Spray({ max: isTouch ? 2500 : 6000 });
scene.add(spray.object);
const spume = new SpumeEmitter(spray, { maxRate: isTouch ? 400 : 1400 });
const bowWave = new BowWave(yacht, { ocean, spray, rate: isTouch ? 0.5 : 1 });   // 船首浪破碎泡沫 + 水片
const rain = createRain(isTouch ? 2500 : 6000);
scene.add(rain.object);

const post = new CinematicComposer(renderer, scene, camera, { samples: isTouch ? 0 : 4, reducedMotion: reduceMotion });
post.setSize(innerWidth, innerHeight, DPR);

// ------------------------------------------------------------------ 雨（线段，随风倾斜）
function createRain(n) {
  const pos = new Float32Array(n * 6), seed = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { seed[i * 3] = Math.random(); seed[i * 3 + 1] = Math.random(); seed[i * 3 + 2] = Math.random(); }
  const g = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', attr);
  const m = new THREE.LineBasicMaterial({ color: 0xb8c6d4, transparent: true, opacity: 0, depthWrite: false });
  const obj = new THREE.LineSegments(g, m);
  obj.frustumCulled = false; obj.renderOrder = 3;
  const R = 38, H = 26;
  return {
    object: obj, amount: 0,
    update(dt, cam, wind, t, light) {
      m.opacity = 0.28 * this.amount;
      obj.visible = this.amount > 0.01;
      if (!obj.visible) return;
      m.color.setRGB(0.35, 0.4, 0.46).multiplyScalar(0.6 + 2.2 * Math.max(light.r, light.g, light.b));
      const fall = 9, wx = wind.x * 0.8, wz = wind.y * 0.8, len = 0.055;
      for (let i = 0; i < n; i++) {
        const s0 = seed[i * 3], s1 = seed[i * 3 + 1], s2 = seed[i * 3 + 2];
        const ph = (t * (0.9 + 0.2 * s2) * fall / H + s2) % 1;
        // 雨滴在相机周围的盒子里循环下落，水平方向随风平移
        let x = (s0 * 2 - 1) * R + wx * ph * H / fall, z = (s1 * 2 - 1) * R + wz * ph * H / fall;
        x = ((x + R) % (2 * R) + 2 * R) % (2 * R) - R; z = ((z + R) % (2 * R) + 2 * R) % (2 * R) - R;
        const y = H * (1 - ph) - 4;
        const k = i * 6;
        pos[k] = cam.x + x; pos[k + 1] = cam.y + y; pos[k + 2] = cam.z + z;
        pos[k + 3] = cam.x + x - wx * len; pos[k + 4] = cam.y + y + fall * len * 1.6; pos[k + 5] = cam.z + z - wz * len;
      }
      attr.needsUpdate = true;
    },
  };
}

// ------------------------------------------------------------------ 状态与镜头预设
const windNow = new THREE.Vector2();   // 10 m 高处的瞬时风（平均风 + 阵风），x 东、y 南
// 风向用气象习惯的“来向”方位（0° 北、90° 东）；世界坐标 −Z 为北、+X 为东
function windVector(U, fromDeg) { const b = fromDeg * DEG; return new THREE.Vector2(-Math.sin(b) * U, Math.cos(b) * U); }

const SHOTS = [
  { id: 'golden', label: '黄昏', wind: 8.5, from: 250, fetch: 400e3, depth: 3000, develop: 1, swell: { Hs: 1.6, Tp: 13, from: 225 }, tod: 17.62, clouds: 0.42, storm: 0, grade: 'golden', cam: 'low', letterbox: true, rain: false, sun: 'back', tack: 1 },
  // 风暴：9 级风里 8.6 m 的船按实际做法深缩帆、放宽到 130° 真风角（横风 105° 满帆会被浪打横、横倾到 60° 以上）
  { id: 'storm', label: '风暴', wind: 22, from: 300, fetch: 900e3, depth: 4000, develop: 1, swell: { Hs: 2.5, Tp: 14, from: 320 }, tod: 15.4, clouds: 1, storm: 1, grade: 'storm', cam: 'chase', letterbox: true, rain: true, tack: -1, twa: 130, reef: 0.45, flat: 0.5 },
  { id: 'tropical', label: '晴空', wind: 6, from: 110, fetch: 200e3, depth: 2000, develop: 1, swell: { Hs: 0.8, Tp: 11, from: 150 }, tod: 11.4, clouds: 0.3, storm: 0, grade: 'tropical', cam: 'aerial', letterbox: false, rain: false, tack: 1 },
  { id: 'moonlight', label: '月夜', wind: 6.5, from: 200, fetch: 300e3, depth: 3000, develop: 1, swell: { Hs: 1.2, Tp: 12, from: 230 }, tod: 18.55, clouds: 0.22, storm: 0, grade: 'moonlight', exposure: 0.42, cam: 'low', letterbox: true, rain: false, lantern: true, sun: 'back', tack: 1 },
  { id: 'dawn', label: '黎明', wind: 2.5, from: 30, fetch: 50e3, depth: 3000, develop: 1, swell: { Hs: 1.3, Tp: 15, from: 260 }, tod: 6.12, clouds: 0.55, storm: 0, grade: 'dawn', cam: 'low', letterbox: true, rain: false, fog: 4, sun: 'back', tack: -1 },
  { id: 'growth', label: '起浪', wind: 15, from: 270, fetch: 600e3, depth: 4000, calm: true, swell: null, tod: 13.2, clouds: 0.45, storm: 0, grade: 'tropical', cam: 'aerial', letterbox: false, rain: false, timeScale: 900, tack: 1, panel: true },
];
const CAMS = [
  { id: 'chase', label: '跟拍', fov: 42 },
  { id: 'low', label: '贴海面', fov: 36 },
  { id: 'tele', label: '长焦', fov: 12 },
  { id: 'aerial', label: '航拍', fov: 50 },
  { id: 'orbit', label: '自由', fov: 45 },
];

const S = {
  shot: null, cam: 'chase', paused: false, time: 0,
  windU: 8.5, windFrom: 250, fetch: 400e3, depth: 3000, timeScale: 20,
  swell: { Hs: 1.6, Tp: 13, from: 225 },
  tod: 17.6, clouds: 0.4, storm: 0, sunAz: 0, fogBoost: 1, letterbox: true, rain: false,
  orbit: { yaw: 0.8, pitch: 0.18, dist: 28 },
  boat: { x: 0, z: 0, yaw: 0, speed: 3, tack: 1, twa: 105 * DEG, lastImm: 0 },
};
const baseFog = sky.fogDensity;

function sunBaseHorizontal(tod) {
  // 主光源在方位旋转前的水平方向：白天是太阳，夜里是月亮（与 SkyEnvironment 一致）
  const sun = SkyEnvironment.sunDirectionAt(tod, new THREE.Vector3(), sky.latitude, 0);
  const d = sun.y > -0.05 ? sun : SkyEnvironment.sunDirectionAt(tod - 11.4, new THREE.Vector3(), sky.latitude + 0.16, 0);
  return Math.atan2(d.z, d.x);
}

function applyShot(id, { instant = true } = {}) {
  const p = SHOTS.find((s) => s.id === id);
  if (!p) return;
  S.shot = id;
  Object.assign(S, { windU: p.wind, windFrom: p.from, fetch: p.fetch, depth: p.depth, tod: p.tod, clouds: p.clouds, storm: p.storm, fogBoost: p.fog ?? 1, letterbox: p.letterbox, rain: p.rain });
  S.timeScale = p.timeScale ?? 20;
  S.swell = p.swell ? { ...p.swell } : { Hs: 0, Tp: 12, from: 0 };
  const m = ocean.model;
  const w = windVector(S.windU, S.windFrom);
  m.setWind(w.x, w.y); m.snapWind();
  windNow.copy(w);
  m.setFetch(S.fetch); m.setDepth(S.depth); m.setTimeScale(S.timeScale);
  m.calm();
  if (!p.calm) m.develop(p.develop ?? 1);
  setSwell();
  ocean.resetSea();
  // 船：自动舵保持真风角航行（右舷来风 = starboard tack）
  S.boat.tack = p.tack ?? 1;
  S.boat.twa = (p.twa ?? 105) * DEG;
  const f = new THREE.Vector2(-w.x, -w.y).normalize();
  S.boat.yaw = Math.atan2(f.x, f.y) + S.boat.tack * S.boat.twa;
  S.boat.speed = 0.3 * S.windU;
  yacht.reset({ x: S.boat.x, z: S.boat.z, yaw: S.boat.yaw, speed: S.boat.speed });
  yacht.setControls({ mode: 'twa', target: S.boat.twa, tack: S.boat.tack > 0 ? 'starboard' : 'port', sheet: 'auto', flat: p.flat ?? 'auto', reef: p.reef ?? 'auto' });
  boat.lantern = !!p.lantern;
  // 机位与太阳：逆光镜头把主光源转到“相机 → 船”的方向上
  setCam(p.cam, instant);
  if (p.sun === 'back') {
    const view = camDesired(p.cam, new THREE.Vector3(), new THREE.Vector3(), true);
    const d = new THREE.Vector2(view.target.x - view.pos.x, view.target.z - view.pos.z);
    S.sunAz = Math.atan2(d.y, d.x) - sunBaseHorizontal(S.tod);
  } else {
    S.sunAz = (p.id === 'storm' ? 1.2 : 0.5);
  }
  post.applyPreset(p.grade);
  if (p.exposure) post.params.exposure = p.exposure;
  $('grade').value = p.grade;
  wake.reset?.(); hullWake.reset?.();
  spray.clear();
  if (p.panel && $('panel').hidden) togglePanel(true);
  syncInputs();
  for (const b of document.querySelectorAll('#shots button')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
  toast(`镜头：${p.label}`);
}

function setSwell() {
  const s = S.swell;
  if (!(s.Hs > 0.05)) { ocean.model.setBackgroundSwell(null); return; }
  ocean.model.setBackgroundSwell({ Hs: s.Hs, Tp: s.Tp, theta: towardTheta(s.from) });
}
// 传播方向（Math.atan2(z, x) 形式）：来向 β 的去向向量 = (−sin β, cos β)
function towardTheta(fromDeg) { const v = windVector(1, fromDeg); return Math.atan2(v.y, v.x); }

// ------------------------------------------------------------------ 帆船航行
// 不再用极曲线：航速、横倾、纵摇、升沉、漂角、舵角都来自 SailingYacht 的力平衡（帆的升力与阻力、
// 龙骨与舵的升力、船体摩擦与兴波阻力、水压积分出的浮力与复原力矩），船首砸浪的飞溅来自砰击事件。
const _fwd = new THREE.Vector3(), _port = new THREE.Vector3();
const _wind = { x: 0, z: 0 };
function updateBoat(dt) {
  const B = S.boat;
  if (dt > 0) {
    _wind.x = windNow.x; _wind.z = windNow.y;          // 10 m 高处的瞬时风（含阵风）
    yacht.step(dt, { ocean, wind: _wind });
  }
  applyToThree(yacht, boat, { dt, time: S.time, sky });
  const T = yacht.telemetry, P = yacht.state.position;
  B.x = P.x; B.z = P.z; B.yaw = T.yaw; B.speed = T.speed;
  if (!(dt > 0)) return;
  // 尾迹：船行波的半角与强度来自兴波阻力（高傅汝德数时尾迹变窄，Rabaud & Moisy 2013）
  driveWake(yacht, hullWake, dt);
  wake.update(dt, B.x, B.z);
  ocean.setWake(wake.texture, wake.rect);
  // 砰击飞溅：入水点、射流速度（Wagner 理论约 2 倍入水速度）、强度都由船体水压积分给出
  emitSpray(yacht, spray, { rate: isTouch ? 0.5 : 1 });
  // 船首浪：傅汝德数 0.25 以上两舷起白、甩水片（泡沫进白浪场，按同样的寿命衰减）
  bowWave.update(dt);
}

// ------------------------------------------------------------------ 机位
const camPos = new THREE.Vector3(0, 4, -20), camTarget = new THREE.Vector3(), camWant = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
let camFov = 42, camBlend = 1, lowY = null;
function waterAt(x, z) { return ocean.sim.ready ? ocean.sampleHeight(x, z) : 0; }
function camDesired(mode, pos, target, raw = false) {
  const B = S.boat, bp = boat.group.position;
  const f = _fwd.set(Math.sin(B.yaw), 0, Math.cos(B.yaw)).clone(), port = _port.set(Math.cos(B.yaw), 0, -Math.sin(B.yaw)).clone();
  const up = new THREE.Vector3(0, 1, 0);
  const base = new THREE.Vector3(bp.x, raw ? 0 : bp.y, bp.z);
  switch (mode) {
    case 'chase':
      pos.copy(base).addScaledVector(f, -22).addScaledVector(port, 9).addScaledVector(up, 5.5);
      target.copy(base).addScaledVector(f, 8).addScaledVector(up, 2.2);
      break;
    case 'low': {
      pos.copy(base).addScaledVector(f, 26).addScaledVector(port, 17);
      pos.y = (raw ? 0 : waterAt(pos.x, pos.z)) + 1.3;
      target.copy(base).addScaledVector(f, -6).addScaledVector(up, 3.2);
      break;
    }
    case 'tele':
      pos.copy(base).addScaledVector(port, 230).addScaledVector(f, -60);
      pos.y = (raw ? 0 : waterAt(pos.x, pos.z)) + 5;
      target.copy(base).addScaledVector(up, 3.2);
      break;
    case 'aerial': {
      const a = S.time * 0.045 + 0.6;
      pos.set(base.x + Math.cos(a) * 58, 34, base.z + Math.sin(a) * 58);
      target.copy(base).addScaledVector(up, 1);
      break;
    }
    default: {
      const o = S.orbit;
      pos.set(base.x + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist, base.y + 2 + Math.sin(o.pitch) * o.dist, base.z + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist);
      target.copy(base).addScaledVector(up, 2.5);
    }
  }
  return { pos, target };
}
function setCam(id, instant = false) {
  S.cam = id;
  camBlend = instant ? 1 : 0;
  lowY = null;
  for (const b of document.querySelectorAll('#cams button')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
  if (instant) {
    camDesired(id, camPos, camTarget);
    camFov = CAMS.find((c) => c.id === id).fov;
  }
}
function updateCamera(dt) {
  camDesired(S.cam, camWant.pos, camWant.target);
  if (S.cam === 'low' || S.cam === 'tele') {
    // 贴海面机位随浪起伏，但比水面慢一点，像漂在水上的摄影机
    lowY = lowY === null ? camWant.pos.y : lowY + (camWant.pos.y - lowY) * smooth(3.2, dt);
    camWant.pos.y = lowY;
  }
  const k = camBlend < 1 ? smooth(2.2, dt) : smooth(S.cam === 'orbit' ? 12 : 4, dt);
  camBlend = Math.min(1, camBlend + dt / 2.5);
  camPos.lerp(camWant.pos, k);
  camTarget.lerp(camWant.target, k);
  camPos.y = Math.max(camPos.y, waterAt(camPos.x, camPos.z) + 0.6);
  camFov = lerp(camFov, CAMS.find((c) => c.id === S.cam).fov, smooth(2, dt));
  camera.position.copy(camPos);
  camera.lookAt(camTarget);
  if (!reduceMotion && S.cam !== 'orbit' && S.cam !== 'aerial') {
    // 手持感：很轻的低频晃动
    const t = S.time;
    camera.rotateZ((Math.sin(t * 0.7) * 0.6 + Math.sin(t * 1.9 + 1.3) * 0.25) * 0.004);
    camera.rotateX((Math.sin(t * 0.53 + 0.4) * 0.7 + Math.sin(t * 1.37) * 0.2) * 0.003);
  }
  if (Math.abs(camera.fov - camFov) > 1e-3) { camera.fov = camFov; camera.updateProjectionMatrix(); }
  // 测试钩子：对照实拍时把相机固定在船上某处（例如船首舷侧、船尾）
  if (window.__demo?.cameraOverride) window.__demo.cameraOverride(camera, boat.group, yacht);
}

// ------------------------------------------------------------------ 界面
const fetchFromSlider = (v) => 2e3 * Math.pow(1e6 / 2e3, v);           // 2 km – 1000 km
const sliderFromFetch = (m) => Math.log(m / 2e3) / Math.log(1e6 / 2e3);
const depthFromSlider = (v) => 2 * Math.pow(4000 / 2, v);               // 2 m – 4000 m
const sliderFromDepth = (m) => Math.log(m / 2) / Math.log(4000 / 2);
const tsFromSlider = (v) => Math.round(Math.pow(1000, v));              // ×1 – ×1000
const sliderFromTs = (s) => Math.log(Math.max(1, s)) / Math.log(1000);
const fmtDir = (d) => `${['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(d / 45) % 8]} ${Math.round(d)}°`;
const fmtTime = (s) => s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`;
const fmtHour = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

function syncInputs() {
  $('wind').value = S.windU; $('windDir').value = S.windFrom;
  $('fetch').value = sliderFromFetch(S.fetch); $('depth').value = sliderFromDepth(S.depth); $('timeScale').value = sliderFromTs(S.timeScale);
  $('swellH').value = S.swell.Hs; $('swellT').value = S.swell.Tp; $('swellDir').value = S.swell.from;
  $('tod').value = S.tod; $('clouds').value = S.clouds; $('storm').value = S.storm;
  $('exposure').value = post.params.exposure; $('chop').value = ocean.params.choppiness;
  $('letterbox').checked = S.letterbox; $('rain').checked = S.rain;
  $('quality').value = quality;
  updateOutputs();
}
function updateOutputs() {
  const bf = beaufort(S.windU);
  $('windOut').textContent = `${S.windU.toFixed(1)} m/s ${bf.force}级`;
  $('windDirOut').textContent = fmtDir(S.windFrom);
  $('fetchOut').textContent = S.fetch >= 1e5 ? `${Math.round(S.fetch / 1e3)} km` : `${(S.fetch / 1e3).toFixed(1)} km`;
  $('depthOut').textContent = S.depth >= 100 ? `${Math.round(S.depth)} m` : `${S.depth.toFixed(1)} m`;
  $('timeScaleOut').textContent = `×${S.timeScale}`;
  $('swellHOut').textContent = S.swell.Hs > 0.05 ? `${S.swell.Hs.toFixed(1)} m` : '无';
  $('swellTOut').textContent = `${S.swell.Tp.toFixed(1)} s`;
  $('swellDirOut').textContent = fmtDir(S.swell.from);
  $('todOut').textContent = fmtHour(S.tod);
  $('cloudsOut').textContent = `${Math.round(S.clouds * 100)}%`;
  $('stormOut').textContent = `${Math.round(S.storm * 100)}%`;
  $('exposureOut').textContent = post.params.exposure.toFixed(2);
  $('chopOut').textContent = ocean.params.choppiness.toFixed(2);
}
function onWindInput() {
  S.windU = +$('wind').value; S.windFrom = +$('windDir').value;
  updateOutputs();
}
$('wind').addEventListener('input', onWindInput);
$('windDir').addEventListener('input', onWindInput);
$('fetch').addEventListener('input', () => { S.fetch = fetchFromSlider(+$('fetch').value); ocean.model.setFetch(S.fetch); updateOutputs(); });
$('depth').addEventListener('input', () => { S.depth = depthFromSlider(+$('depth').value); ocean.model.setDepth(S.depth); updateOutputs(); });
$('timeScale').addEventListener('input', () => { S.timeScale = tsFromSlider(+$('timeScale').value); ocean.model.setTimeScale(S.timeScale); updateOutputs(); });
$('calmBtn').addEventListener('click', () => { ocean.model.calm(); ocean.resetSea(); toast('海面已归零，浪从现在开始按风时生长'); });
$('developBtn').addEventListener('click', () => { ocean.model.develop(1); ocean.resetSea(); toast('已跳到当前风速、风区允许的极限海况'); });
for (const id of ['swellH', 'swellT', 'swellDir']) $(id).addEventListener('input', () => {
  S.swell = { Hs: +$('swellH').value, Tp: +$('swellT').value, from: +$('swellDir').value };
  setSwell(); updateOutputs();
});
$('tod').addEventListener('input', () => { S.tod = +$('tod').value; updateOutputs(); });
$('clouds').addEventListener('input', () => { S.clouds = +$('clouds').value; updateOutputs(); });
$('storm').addEventListener('input', () => { S.storm = +$('storm').value; updateOutputs(); });
$('exposure').addEventListener('input', () => { post.params.exposure = +$('exposure').value; updateOutputs(); });
$('chop').addEventListener('input', () => { ocean.params.choppiness = +$('chop').value; updateOutputs(); });
$('grade').addEventListener('change', () => { const e = post.params.exposure; post.applyPreset($('grade').value); post.params.exposure = e; });
$('quality').addEventListener('change', () => { quality = $('quality').value; ocean.setQuality(quality); toast('画质已切换'); });
$('debug').addEventListener('change', () => ocean.setDebugView(+$('debug').value));
$('letterbox').addEventListener('change', () => { S.letterbox = $('letterbox').checked; });
$('rain').addEventListener('change', () => { S.rain = $('rain').checked; });

for (const t of document.querySelectorAll('.tabs button')) t.addEventListener('click', () => {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b === t));
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== t.dataset.tab;
});
for (const s of SHOTS) {
  const b = document.createElement('button'); b.textContent = s.label; b.dataset.id = s.id; b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => applyShot(s.id, { instant: false }));
  $('shots').appendChild(b);
}
for (const c of CAMS) {
  const b = document.createElement('button'); b.textContent = c.label; b.dataset.id = c.id; b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => { if (c.id === 'orbit') initOrbit(); setCam(c.id); });
  $('cams').appendChild(b);
}
function togglePanel(force) {
  const p = $('panel'), show = force ?? p.hidden;
  p.hidden = !show; $('panelBtn').setAttribute('aria-pressed', String(show));
}
$('panelBtn').addEventListener('click', () => togglePanel());
$('hideBtn').addEventListener('click', () => { document.body.classList.add('clean'); toast('按 H 或点击画面恢复界面'); });
let toastTimer = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200); }

// 拖动 → 自由机位；滚轮推拉
function initOrbit() {
  const bp = boat.group.position, d = camera.position.clone().sub(bp);
  S.orbit.dist = clamp(d.length(), 8, 300);
  S.orbit.yaw = Math.atan2(d.z, d.x);
  S.orbit.pitch = clamp(Math.asin(clamp((d.y - 2) / S.orbit.dist, -1, 1)), 0.02, 1.4);
}
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (document.body.classList.contains('clean')) { document.body.classList.remove('clean'); return; }
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || drag.id !== e.pointerId) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (S.cam !== 'orbit' && Math.hypot(dx, dy) > 6) { initOrbit(); setCam('orbit', true); camPos.copy(camera.position); }
  if (S.cam === 'orbit') {
    S.orbit.yaw += dx * 0.005; S.orbit.pitch = clamp(S.orbit.pitch + dy * 0.004, 0.02, 1.45);
    drag.x = e.clientX; drag.y = e.clientY;
  }
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (S.cam !== 'orbit') { initOrbit(); setCam('orbit', true); camPos.copy(camera.position); }
  S.orbit.dist = clamp(S.orbit.dist * Math.exp(e.deltaY * 0.001), 6, 600);
}, { passive: false });
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const n = +e.key;
  if (n >= 1 && n <= SHOTS.length) applyShot(SHOTS[n - 1].id, { instant: false });
  else if (e.code === 'KeyC') { const i = CAMS.findIndex((c) => c.id === S.cam); const next = CAMS[(i + 1) % (CAMS.length - 1)]; setCam(next.id); }
  else if (e.code === 'KeyH') document.body.classList.toggle('clean');
  else if (e.code === 'KeyP') togglePanel();
  else if (e.code === 'Space') { e.preventDefault(); S.paused = !S.paused; toast(S.paused ? '已暂停' : '继续'); }
});
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  post.setSize(innerWidth, innerHeight, DPR);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) clock.getDelta(); });
if (isTouch || innerWidth < 760) togglePanel(false);

// ------------------------------------------------------------------ 读数
function drawSpark() {
  const c = $('spark'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const h = ocean.model.history;
  if (h.length < 2) return;
  const maxHs = Math.max(0.5, ...h.map((p) => p.Hs)) * 1.15;
  const t0 = h[0].t, t1 = h[h.length - 1].t || 1;
  const X = (t) => 8 + (W - 16) * ((t - t0) / Math.max(1, t1 - t0)), Y = (v) => H - 22 - (H - 40) * (v / maxHs);
  g.strokeStyle = 'rgba(236,235,230,.12)'; g.lineWidth = 1;
  for (let i = 0; i <= 2; i++) { const y = Y(maxHs * i / 2.3); g.beginPath(); g.moveTo(8, y); g.lineTo(W - 8, y); g.stroke(); }
  const line = (key, color, width) => { g.strokeStyle = color; g.lineWidth = width; g.beginPath(); h.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, X(p.t), Y(p[key]))); g.stroke(); };
  line('HsWind', 'rgba(111,198,192,.85)', 2);
  line('Hs', '#e8b46a', 3);
  g.fillStyle = '#a4adb4'; g.font = '22px "JetBrains Mono", monospace';
  g.fillText(`Hs ${h[h.length - 1].Hs.toFixed(2)} m`, 10, 26);
  g.textAlign = 'right'; g.fillText(`海况时间 ${fmtTime(t1 - t0)}`, W - 10, H - 4); g.textAlign = 'left';
  g.fillStyle = '#e8b46a'; g.fillText('总', 10, H - 4); g.fillStyle = 'rgba(111,198,192,1)'; g.fillText('风浪', 44, H - 4);
}
function updateReadouts() {
  const r = ocean.readout;
  const bf = r.beaufort, ss = r.seaState;
  const sim = r.simulatedHs > 0 ? r.simulatedHs.toFixed(2) : '…';
  const rows = [
    ['平均风', `${r.U10.toFixed(1)} m/s · ${bf.force} 级 ${bf.name}`],
    ['有效波高', `${r.Hs.toFixed(2)} / <span class="ok">${sim}</span> m`],
    ['风浪 / 涌浪', `${r.HsWind.toFixed(2)} / ${r.HsSwell.toFixed(2)} m`],
    ['谱峰周期', r.Tp ? `${r.Tp.toFixed(1)} s · 波长 ${Math.round(r.wavelength)} m` : '—'],
    ['波速 · 波龄', r.Tp ? `${r.phaseSpeed.toFixed(1)} m/s · ${r.waveAge.toFixed(2)}` : '—'],
    ['发展阶段', r.stageName + (r.stage === 'duration' && r.timeToLimit > 0 ? ` · 还需 ${fmtTime(r.timeToLimit)}` : '')],
    ['白浪覆盖', `${(r.whitecap * 100).toFixed(2)}% / <span class="ok">${(r.whitecapMeasured * 100).toFixed(2)}%</span>`],
    ['其中正在破碎', `<span class="ok">${(r.whitecapActive * 100).toFixed(2)}%</span>`],
    ['均方坡度', `${r.mssCoxMunk.toFixed(3)} / <span class="ok">${r.mssSimulated.toFixed(3)}</span>`],
    ['浪级', `${ss.degree} 级 ${ss.name}`],
  ];
  // 帆船：全部来自力平衡（见 ocean/vessel）
  const T = yacht.telemetry;
  if (T.speedKn !== undefined) rows.push(
    ['航速', `${T.speedKn.toFixed(1)} kn · Fn ${T.Fn.toFixed(2)}`],
    ['横倾 · 漂角', `${Math.abs(T.heel).toFixed(0)}° · ${Math.abs(T.leeway).toFixed(1)}°`],
    ['视风', `${T.awsKn.toFixed(0)} kn · ${Math.abs(T.awa).toFixed(0)}°`],
    ['舵角 · 缩帆', `${Math.abs(T.rudderAngle).toFixed(1)}° · ${Math.round((1 - T.reef) * 100)}%`],
  );
  $('read').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  // 能量占优的那部分的周期：微风叠长涌时显示涌浪周期
  const Tdom = r.HsSwell > r.HsWind ? r.TpSwell : r.Tp;
  $('status').innerHTML = `<b>${bf.force} 级${bf.name}</b> · ${ss.name} · Hs ${r.Hs.toFixed(1)} m · 周期 ${Tdom ? Tdom.toFixed(1) : '—'} s <span class="dim">· ${r.HsSwell > r.HsWind ? '涌浪为主' : r.stageName}</span>`;
  drawSpark();
}
$('read').title = '理论值来自风浪生长律；绿色为 GPU 模拟海面的实测值。白浪覆盖：Monahan (1980) / 白浪场实测（活跃 + 残留泡沫，3 s 平均）；均方坡度：Cox–Munk (1954) 总量 / 模拟已解析部分（波长 > 约 0.2 m）';

// ------------------------------------------------------------------ 主循环
const clock = new THREE.Clock();
let frames = 0, readoutTimer = 0, gustT = Math.random() * 100;
function frame() {
  const dtReal = Math.min(clock.getDelta(), 1 / 20);
  const dt = S.paused ? 0 : dtReal;
  S.time += dt;
  // 阵风：瞬时风在设定值附近起伏（±15% 风速、±6° 风向），平均风由模型自己滤波
  gustT += dt;
  const gu = 1 + 0.13 * Math.sin(gustT * 0.31) * Math.sin(gustT * 0.083 + 1.7) + 0.05 * Math.sin(gustT * 1.3);
  const gd = (Math.sin(gustT * 0.17 + 0.6) * 4 + Math.sin(gustT * 0.61) * 2) * (S.windU > 0.5 ? 1 : 0);
  windNow.copy(windVector(S.windU * gu, S.windFrom + gd));
  ocean.model.setWind(windNow.x, windNow.y);

  updateBoat(dt);
  updateCamera(dtReal);
  sky.fogDensity = baseFog * S.fogBoost * (1 + S.storm * 1.5);
  sky.update(dtReal, { camera, timeOfDay: S.tod, cloudCover: S.clouds, storm: S.storm, wind: windNow, sunAzimuth: S.sunAz });
  scene.environment = sky.environment;
  scene.environmentIntensity = sky.environmentIntensity;
  ocean.update(dt, camera, sky);
  spume.update(dt, ocean, camera);   // 大风时从正在破碎的浪峰撕下的飞沫
  spray.update(dt, { keyLightDirection: sky.keyLightDirection, keyLightColor: sky.keyLightColor, ambientColor: sky.ambientColor, wind: windNow, waterHeight: (x, z) => waterAt(x, z) });
  rain.amount = lerp(rain.amount, S.rain ? 1 : 0, smooth(1.5, dtReal));
  rain.update(dt, camera.position, windNow, S.time, sky.ambientColor);
  post.params.letterboxAmount = lerp(post.params.letterboxAmount, S.letterbox ? 1 : 0, smooth(2.5, dtReal));
  post.render(dtReal);

  readoutTimer += dtReal;
  if (readoutTimer > 0.25) { readoutTimer = 0; updateReadouts(); }
  if (++frames === 3) $('loading').classList.add('done');
}

// 启动
const startShot = new URLSearchParams(location.search).get('shot') || location.hash.slice(1) || 'golden';
applyShot(SHOTS.some((s) => s.id === startShot) ? startShot : 'golden');
syncInputs();
renderer.setAnimationLoop(frame);

// 测试钩子（控制台）
window.__demo = {
  ocean, sky, boat, yacht, post, S, applyShot, setCam, windNow,
  /** 手动推进 n 帧（不渲染），用于自动化测试 */
  async step(n = 30, dt = 1 / 30) {
    for (let i = 0; i < n; i++) {
      S.time += dt; updateBoat(dt); updateCamera(dt);
      sky.update(dt, { camera, timeOfDay: S.tod, cloudCover: S.clouds, storm: S.storm, wind: windNow, sunAzimuth: S.sunAz });
      ocean.update(dt, camera, sky);
      if (i % 8 === 7) { const s0 = ocean.foam.stats.samples; for (let k = 0; k < 60 && ocean.foam.stats.samples === s0; k++) await new Promise((r) => setTimeout(r, 5)); }
    }
  },
  debug() {
    const r = ocean.readout;
    return { shot: S.shot, cam: S.cam, Hs: r.Hs, simHs: r.simulatedHs, Tp: r.Tp, stage: r.stage, whitecap: r.whitecap, whitecapSim: r.whitecapMeasured,
      whitecapActive: r.whitecapActive,
      boat: (({ speedKn, heel, pitch, leeway, twa, awa, awsKn, vmgKn, rudderAngle, Fn, reef, flat }) => ({ x: S.boat.x, z: S.boat.z, y: boat.group.position.y, speedKn, heel, pitch, leeway, twa, awa, awsKn, vmgKn, rudderAngle, Fn, reef, flat }))(yacht.telemetry),
      spray: spray.count, spume: spume.emitted, calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  },
};
