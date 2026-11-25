// 海面总装：风浪模型 → GPU 模拟 → 网格 + 材质，一个对象搞定
//
//   const ocean = new Ocean(renderer, { quality: 'high', sea: { wind: { x: 9, z: -4 }, fetch: 400e3 } });
//   scene.add(ocean.mesh);
//   // 每帧：
//   ocean.update(dt, camera, { sunDirection, sunColor, ambientColor, envMap, envMaxMip });
//   const y = ocean.sampleHeight(x, z);          // 浮力、相机、漂浮物
//   ocean.model.setWind(ux, uz);                 // 改风：浪按物理规律慢慢起来
import * as THREE from 'three';
import { WindSeaModel, whitecapCoverage } from './WindSeaModel.js';
import { OceanSimulation } from './OceanSimulation.js';
import { buildOceanGeometry } from './OceanGeometry.js';
import { createOceanMaterial } from './OceanMaterial.js';

/**
 * 画质预设。级联长度满足 L_c / L_{c+1} ≤ N/12，保证每级的波段不超过它自己的奈奎斯特频率。
 */
export const OCEAN_QUALITY = {
  ultra:  { size: 256, cascades: [2048, 160, 24], grid: 'ultra',  readback: [256, 128] },
  high:   { size: 256, cascades: [2048, 160, 24], grid: 'high',   readback: [256, 128] },
  medium: { size: 128, cascades: [1024, 128, 20], grid: 'medium', readback: [128, 64] },
  low:    { size: 64,  cascades: [512, 100, 20],  grid: 'low',    readback: [64, 64] },
};

const frac = (x) => x - Math.floor(x);
const wrapP = (x, p) => ((x % p) + p) % p;

export class Ocean {
  constructor(renderer, { quality = 'high', model = null, sea = {}, choppiness = 1.0, seed } = {}) {
    this.renderer = renderer;
    this.model = model ?? new WindSeaModel(sea);
    this.params = {
      choppiness,            // 水平位移系数（1 = 线性理论值）
      foamAmount: 1,         // 泡沫显示强度
      autoWhitecaps: true,   // 按 Monahan 覆盖率自动校准起白浪阈值
      whitecapScale: 1.0,    // 目标覆盖率倍数（1 = Monahan 经验值）
      gustiness: 0.7,        // 阵风斑块（猫爪风）强度
      fogDensity: null,      // null = 跟随 SkyEnvironment.fogDensity（船、岛、海远处融成一色）
      mie: 0.02,
      envIntensity: 1,
      biolumination: 1,      // 夜光藻强度（乘以 SkyEnvironment.night）
      smallScaleWhitecaps: 0, // 最细一级（< 4 m）是否也起白浪
    };
    this.time = 0;
    this.foamThreshold = 0.2;
    this._needFoamInit = true;
    this._foamTimer = 0;
    this._foamSamples = 0;
    this._drift = new THREE.Vector2();
    this._gustTravel = new THREE.Vector2();
    this._windDir = new THREE.Vector2(1, 0);
    this._build(quality, seed);
  }

  _build(quality, seed) {
    const q = OCEAN_QUALITY[quality] ?? OCEAN_QUALITY.high;
    this.quality = quality;
    this.sim = new OceanSimulation(this.renderer, { size: q.size, cascades: q.cascades, readback: q.readback, choppiness: this.params.choppiness, seed });
    const geometry = buildOceanGeometry(q.grid);
    const material = createOceanMaterial(this.sim);
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
      const old = this.mesh.material;
      // 保留用户改过的外观参数
      for (const k of ['uDeepColor', 'uSSSColor', 'uSSS', 'uBubbles', 'uFoamColor', 'uFoamParams', 'uEnvMap', 'uEnvMaxMip',
        'uReflection', 'uReflectionMatrix', 'uReflectionStrength', 'uUseBathy', 'uBathy', 'uBathyRect', 'uSand', 'uAbsorb',
        'uUseWake', 'uWake', 'uWakeRect', 'uBiolum', 'uBiolumColor', 'uDebug']) material.uniforms[k].value = old.uniforms[k].value;
      old.dispose();
      this.mesh.material = material;
    } else {
      this.mesh = new THREE.Mesh(geometry, material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 10;      // 不透明物体之后画，被船、岛挡住的海面由 early-z 省掉
      this.mesh.name = 'Ocean';
    }
    this.material = material;
  }

  /** 起白浪阈值的初始估计（随后由 Monahan 覆盖率反馈校准） */
  static whitecapThresholdGuess(U) { return THREE.MathUtils.clamp(0.3 + 0.032 * (U - 4), 0.1, 0.92); }

  /** 标准正态上尾分位数：P(Z > z) = p（Abramowitz & Stegun 26.2.23） */
  static upperTailZ(p) {
    const t = Math.sqrt(-2 * Math.log(Math.min(0.5, p)));
    return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  }

  /** 风况突变（切换预设）后调用：白浪阈值从估计值重新校准 */
  resetWhitecaps() { this._needFoamInit = true; }

  /** 切换画质（重建模拟与网格，风浪状态保留） */
  setQuality(quality) {
    if (quality === this.quality) return;
    this.sim.dispose();
    this._build(quality);
  }

  /**
   * 每帧调用。light 可直接传 SkyEnvironment（读取 keyLightDirection/keyLightColor/ambientColor/envMap）
   * 或 { sunDirection, sunColor, ambientColor, envMap, envMaxMip }。
   */
  update(dt, camera, light = null) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;
    const m = this.model, sim = this.sim, u = this.material.uniforms;
    m.update(dt);
    const sp = m.spectrumParams();
    const ro = m.readout;

    // 白浪：覆盖率目标取 Monahan (1980)。阈值初值由实测坡度统计按正态分布反推，
    // 之后按对数误差慢速积分校准（太快会过冲，满海都是泡沫）
    const target = whitecapCoverage(ro.U10) * this.params.whitecapScale;
    // 白浪只由波长 > 约 4 m 的两级产生：最细一级里的极短波挤压得厉害，但那是看不见的微破碎，
    // 计入会让整片海泛白（params.smallScaleWhitecaps 可手动打开，0–1）
    const w2 = this.params.smallScaleWhitecaps;
    sim.foamWeight2 = w2;
    if (this.params.autoWhitecaps) {
      if (this._needFoamInit) { this.foamThreshold = Ocean.whitecapThresholdGuess(ro.U10); this._needFoamInit = false; this._foamFromStats = true; }
      this._foamTimer += dt;
      if (this._foamTimer > 0.2) { this._foamTimer = 0; sim.measureFoam(); }
      if (sim.measured.foamSamples !== this._foamSamples) {
        this._foamSamples = sim.measured.foamSamples;
        const mc = sim.measured.mssCascades;
        if (this._foamFromStats && mc) {
          // J 的亏损近似正态，标准差 ≈ 主浪所在各级坡度的均方根：取上尾概率 = 目标覆盖率处的阈值
          const sigma = Math.sqrt(mc[0] + mc[1] + w2 * mc[2]);
          this.foamThreshold = THREE.MathUtils.clamp(1 - Ocean.upperTailZ(Math.max(target, 1e-5)) * sigma, -0.8, 0.98);
          this._foamFromStats = false;
        } else {
          const err = Math.log(target + 2e-4) - Math.log(sim.measured.foamActive + 2e-4);
          this.foamThreshold = THREE.MathUtils.clamp(this.foamThreshold + THREE.MathUtils.clamp(err * 0.012, -0.012, 0.012), -0.8, 0.98);
        }
      }
    }
    sim.setFoam(this.foamThreshold, 10, 0.9, 0.16);
    sim.choppiness = this.params.choppiness;
    sim.update(dt, sp);

    // 纹理（双缓冲每帧交换）
    const c = sim.cascades;
    u.uDisp0.value = c[0].displacement; u.uDisp1.value = c[1].displacement; u.uDisp2.value = c[2].displacement;
    u.uSlope0.value = c[0].slope; u.uSlope1.value = c[1].slope; u.uSlope2.value = c[2].slope;
    u.uFoam0.value = c[0].foam; u.uFoam1.value = c[1].foam; u.uFoam2.value = c[2].foam;
    u.uFoamW2.value = sim.foamWeight2;

    // 网格跟随相机（吸附）；相机越高网格越大
    const g = this.mesh.geometry.userData;
    const cam = camera.position;
    const scale = Math.pow(2, THREE.MathUtils.clamp(Math.round(Math.log2(Math.max(1, Math.abs(cam.y) / 30))), 0, 5));
    const snap = g.inner * scale;
    const ox = Math.round(cam.x / snap) * snap, oz = Math.round(cam.z / snap) * snap;
    u.uOrigin.value.set(ox, oz);
    u.uCamLocal.value.set(cam.x - ox, cam.z - oz);
    u.uGridScale.value = scale;
    u.uGridInner.value = g.inner;
    u.uGridGrowth.value = g.growth - 1;
    const ht = 0.5 / sim.size;
    u.uOriginUV0.value.set(frac(ox / c[0].L) + ht, frac(oz / c[0].L) + ht);
    u.uOriginUV1.value.set(frac(ox / c[1].L) + ht, frac(oz / c[1].L) + ht);
    u.uOriginUV2.value.set(frac(ox / c[2].L) + ht, frac(oz / c[2].L) + ht);
    u.uNoiseOrigin.value.set(wrapP(ox, 8192), wrapP(oz, 8192));
    u.uDispFade.value.set(900 * scale, 2600 * scale, 90 * scale, 260 * scale);

    // 风：平均风决定纹理方向与漂流；瞬时风（阵风）决定毛细波强度
    const U = ro.U10, Ui = Math.hypot(sp.gust.x, sp.gust.z);
    if (U > 0.2) this._windDir.set(m.meanWind.x / U, m.meanWind.z / U);
    const w = this._windDir;
    this._drift.addScaledVector(w, 0.03 * U * dt);                // 风生表面漂流 ≈ 3% 风速
    this._gustTravel.addScaledVector(w, 0.85 * Math.max(U, 1) * dt); // 阵风斑块随风移动
    u.uWindDir.value.copy(w);
    const fs = u.uFoamParams.value.w, fs2 = fs * 0.29;
    // 第二层泡沫纹理旋转 37°（cos 0.8、sin 0.6），两层格点不对齐，看不出平铺
    const px2 = ox - 1.25 * this._drift.x, pz2 = oz - 1.25 * this._drift.y;
    u.uFoamOff.value.set(frac((ox - this._drift.x) / fs), frac((oz - this._drift.y) / fs),
      frac((0.8 * px2 - 0.6 * pz2) / fs2) + 0.37, frac((0.6 * px2 + 0.8 * pz2) / fs2) + 0.37);
    const a = ox * w.x + oz * w.y, b = -ox * w.y + oz * w.x;      // 原点在风坐标系中的位置
    u.uRippleOff.value.set(frac(a / 1.7 - this.time * 0.42), frac(b / 1.7), frac(a / 0.53 + 0.37 - this.time * 0.71), frac(b / 0.53 + 0.61));
    u.uGustOffset.value.set(wrapP(this._gustTravel.x, 8192), wrapP(this._gustTravel.y, 8192));
    // 未解析的微尺度坡度方差 = Cox–Munk 总均方坡度 − 模拟已解析部分（每个方向一半），
    // 太阳闪光带的宽度因此与 Cox & Munk (1954) 的航拍观测一致；近处其中约六成画成毛细波法线
    const mssCM = 0.003 + 0.00512 * Ui;
    const mssSim = sim.measured.mss;
    const residual = mssSim > 0 ? THREE.MathUtils.clamp((mssCM - mssSim) / 2, 0.0004, 0.05) : 0.0006 + 0.00032 * Ui;
    u.uMicroVar.value = residual;
    u.uRipple.value = Math.min(0.28, Math.sqrt(9.4 * 0.6 * residual));
    // 泡沫条纹：蒲福 7 级（13.9 m/s）起出现，9 级以上明显
    u.uStreaks.value = THREE.MathUtils.smoothstep(U, 13, 22);
    u.uStreakOff.value.set(frac((a - (this._drift.x * w.x + this._drift.y * w.y)) / 110), frac(b / 2.4));
    const calmFade = THREE.MathUtils.smoothstep(U, 0.5, 3) * (1 - 0.6 * THREE.MathUtils.smoothstep(U, 8, 16));
    u.uGustiness.value = this.params.gustiness * calmFade;
    u.uWaveScale.value = Math.max(0.15, 0.5 * ro.Hs);
    u.uTime.value = this.time;
    u.uFoamParams.value.x = this.params.foamAmount;
    u.uFogDensity.value = this.params.fogDensity ?? light?.fogDensity ?? 0.00009;
    u.uMie.value = this.params.mie;
    u.uEnvIntensity.value = this.params.envIntensity * (1 + (light?.lightning ?? 0) * 2.5);   // 闪电照亮海面反射
    u.uBiolum.value = this.params.biolumination * (light?.night ?? 0);

    if (light) {
      const dir = light.keyLightDirection ?? light.sunDirection;
      const col = light.keyLightColor ?? light.sunColor;
      if (dir) u.uSunDir.value.copy(dir);
      // SkyEnvironment 的主光颜色 = 白色漫反射面在该光下的亮度（E/π），镜面高光需要辐照度 E，故乘 π
      if (col) u.uSunColor.value.copy(col).multiplyScalar(light.keyLightColor ? Math.PI : 1);
      if (light.ambientColor) u.uAmbient.value.copy(light.ambientColor);
      if (light.envMap) {
        u.uEnvMap.value = light.envMap;
        const size = light.envMap.image?.width ?? light.envMap.source?.data?.width ?? 256;
        u.uEnvMaxMip.value = light.envMaxMip ?? Math.log2(size || 256);
      }
    }
  }

  /** 世界坐标 (x, z) 处的水面高度（CPU，来自 GPU 回读，延迟 1–2 帧；不含最细一级） */
  sampleHeight(x, z) { return this.sim.heightAt(x, z); }

  /** 水面法线（有限差分） */
  sampleNormal(x, z, out = new THREE.Vector3(), e = 0.6) {
    const hx = this.sampleHeight(x + e, z) - this.sampleHeight(x - e, z);
    const hz = this.sampleHeight(x, z + e) - this.sampleHeight(x, z - e);
    return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  }

  /** 风浪读数 + 模拟实测值 */
  get readout() {
    const U = this.model.readout.U10;
    return {
      ...this.model.readout,
      simulatedHs: this.sim.measured.Hs,
      whitecapMeasured: this.sim.measured.foamActive,
      foamThreshold: this.foamThreshold,
      mssSimulated: this.sim.measured.mss ?? 0,          // 已解析波段（波长 > 约 0.2 m）
      mssCoxMunk: 0.003 + 0.00512 * U,                    // Cox & Munk (1954) 清洁海面总均方坡度
    };
  }

  /** 尾迹：texture R = 泡沫、G = 波脊；rect = (minX, minZ, sizeX, sizeZ) */
  setWake(texture, rect) {
    const u = this.material.uniforms;
    u.uUseWake.value = texture ? 1 : 0;
    if (texture) { u.uWake.value = texture; u.uWakeRect.value.copy(rect); }
  }

  /** 水深：texture R = 地面高度（m，海平面为 0，水下为负）；rect 同上 */
  setBathymetry(texture, rect) {
    const u = this.material.uniforms;
    u.uUseBathy.value = texture ? 1 : 0;
    if (texture) { u.uBathy.value = texture; u.uBathyRect.value.copy(rect); }
  }

  /** 平面反射：texture 为镜像相机渲染结果（alpha 标记有物体处），matrix 为世界 → 纹理坐标 */
  setReflection(texture, matrix, strength = 1) {
    const u = this.material.uniforms;
    u.uReflectionStrength.value = texture ? strength : 0;
    if (texture) { u.uReflection.value = texture; u.uReflectionMatrix.value = matrix; }
  }

  /** 调试视图：0 正常，1 法线，2 泡沫，3 粗糙度，4 菲涅尔，5 尾迹，6 水深，7 阵风，8 雅可比 */
  setDebugView(i) { this.material.uniforms.uDebug.value = i | 0; }

  dispose() {
    this.sim.dispose();
    this.mesh.geometry.dispose();
    this.material.uniforms.uFoamTex.value.dispose();
    this.material.uniforms.uRippleTex.value.dispose();
    this.material._blank.dispose();
    this.material.dispose();
  }
}
