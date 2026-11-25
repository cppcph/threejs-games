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
import { FoamField, FOAM_TIMESCALES } from './FoamField.js';

/**
 * 画质预设。级联长度满足 L_c / L_{c+1} ≤ N/12，保证每级的波段不超过它自己的奈奎斯特频率。
 */
export const OCEAN_QUALITY = {
  ultra:  { size: 256, cascades: [2048, 160, 24], grid: 'ultra',  readback: [256, 128], foam: { size: 1024, extent: 512 } },
  high:   { size: 256, cascades: [2048, 160, 24], grid: 'high',   readback: [256, 128], foam: { size: 1024, extent: 512 } },
  medium: { size: 128, cascades: [1024, 128, 20], grid: 'medium', readback: [128, 64],  foam: { size: 512, extent: 384 } },
  low:    { size: 64,  cascades: [512, 100, 20],  grid: 'low',    readback: [64, 64],   foam: { size: 256, extent: 256 } },
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
      breakingThreshold: 0.725, // 破碎判据：总雅可比 J 低于它（局部水平压缩超过约 28%）的浪峰破碎。物理常数，
                                // 8–20 m/s 的稳态模拟里一次标定；覆盖率由海况自然得出（见 README 白浪验证）
      autoWhitecaps: false,  // true：改为把阈值慢速校准到 whitecapScale × Monahan & O'Muircheartaigh (1980) 覆盖率
      whitecapScale: 1.0,    // 校准目标的倍数（实测离散约 ±3 倍）
      foamLifetime: 1.0,     // 残留泡沫寿命倍数（表面活性物质多的海域泡沫更持久）
      gustiness: 0.7,        // 阵风斑块（猫爪风）强度
      fogDensity: null,      // null = 跟随 SkyEnvironment.fogDensity（船、岛、海远处融成一色）
      mie: 0.02,
      envIntensity: 1,
      biolumination: 1,      // 夜光藻强度（乘以 SkyEnvironment.night）
    };
    this.time = 0;
    this.foamThreshold = 0.6;
    this._needFoamInit = true;
    this._foamAge = 0;
    this._foamTimer = 0;
    this._crestTimer = 0;
    this._foamSamples = 0;
    this._waveDir = new THREE.Vector2(1, 0);
    this._drift = new THREE.Vector2();
    this._gustTravel = new THREE.Vector2();
    this._windDir = new THREE.Vector2(1, 0);
    this.surfaceDrift = new THREE.Vector2();   // 表面漂流速度（m/s）
    this._build(quality, seed);
  }

  _build(quality, seed) {
    const q = OCEAN_QUALITY[quality] ?? OCEAN_QUALITY.high;
    this.quality = quality;
    this.sim = new OceanSimulation(this.renderer, { size: q.size, cascades: q.cascades, readback: q.readback, choppiness: this.params.choppiness, seed });
    this.foam?.dispose();
    this.foam = new FoamField(this.renderer, this.sim, q.foam);
    const geometry = buildOceanGeometry(q.grid);
    const material = createOceanMaterial(this.sim);
    material.uniforms.uFoamField.value = this.foam.texture;
    material.uniforms.uFoamInvE.value = 1 / this.foam.extent;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
      const old = this.mesh.material;
      // 保留用户改过的外观参数
      for (const k of ['uDeepColor', 'uSSSColor', 'uSSS', 'uBubbles', 'uFoamColor', 'uFoamAlbedo', 'uFoamParams', 'uEnvMap', 'uEnvMaxMip',
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

  /** 风况突变（切换预设）后调用：泡沫清空（自动校准时阈值也从物理常数重新开始） */
  resetWhitecaps() { this._needFoamInit = true; this.foam.reset(); }

  /**
   * 海况突变后调用（model.calm()、develop()、切镜头之后）：清空白浪场，丢掉旧的 CPU 回读。
   * 回读到位前（约 2–3 帧）sampleHeight 返回 0、sampleVelocity 返回漂流速度，船按平静水面算。
   */
  resetSea() { this.resetWhitecaps(); this.sim.invalidateReadback(); }

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

    // 破碎阈值默认是物理常数（params.breakingThreshold）；autoWhitecaps 时改为按对数误差慢速积分，
    // 把覆盖率校准到 Monahan & O'Muircheartaigh (1980)。破碎发生在哪、持续多久由白浪场的过程决定
    const target = whitecapCoverage(ro.U10) * this.params.whitecapScale;
    const auto = this.params.autoWhitecaps;
    if (!auto) this.foamThreshold = this.params.breakingThreshold;
    if (this._needFoamInit) {
      if (auto) this.foamThreshold = this.params.breakingThreshold;
      this._needFoamInit = false; this._foamAge = 0; this._slopeSample = null;
    }
    this._foamAge += dt;
    this._foamTimer += dt;
    if (this._foamTimer > 0.2) { this._foamTimer = 0; this.foam.measure(); sim.measureSlopes(); }
    if (this.foam.stats.samples !== this._foamSamples) {
      // 覆盖率随波群起伏很大：先做时间常数 3 s 的指数平均
      const st = this.foam.stats, dtS = Math.max(this._foamAge - (this._foamSampleAge ?? 0), 0.05);
      this._foamSampleAge = this._foamAge;
      this._foamSamples = st.samples;
      const a = 1 - Math.exp(-dtS / 3);
      this.coverageSmoothed = this.coverageSmoothed === undefined || this._foamAge < 0.5 ? st.coverage : this.coverageSmoothed + (st.coverage - this.coverageSmoothed) * a;
      if (auto && this._foamAge > 2 * FOAM_TIMESCALES.tauB) {
        // 慢速积分：闭环时间常数约 6 s，比残留泡沫的滞后（τB ≈ 4 s）长，不会振荡
        const err = Math.log(target + 2e-4) - Math.log(this.coverageSmoothed + 2e-4);
        this.foamThreshold = THREE.MathUtils.clamp(this.foamThreshold + THREE.MathUtils.clamp(err * 0.008 * dtS, -0.01, 0.01), -0.5, 0.98);
      }
    }
    sim.choppiness = this.params.choppiness;
    sim.update(dt, sp);

    // 纹理（双缓冲每帧交换）
    const c = sim.cascades;
    u.uDisp0.value = c[0].displacement; u.uDisp1.value = c[1].displacement; u.uDisp2.value = c[2].displacement;
    u.uSlope0.value = c[0].slope; u.uSlope1.value = c[1].slope; u.uSlope2.value = c[2].slope;

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
    this.surfaceDrift.copy(w).multiplyScalar(0.03 * U);          // 表面漂流（Stokes 漂流 + 风生流）≈ 3% U10
    this._drift.addScaledVector(this.surfaceDrift, dt);
    this._gustTravel.addScaledVector(w, 0.85 * Math.max(U, 1) * dt); // 阵风斑块随风移动
    u.uWindDir.value.copy(w);

    // 白浪场：在相机周围的世界坐标里判定破碎、演化泡沫
    const ws = sp.windSea;
    if (ws && ws.omegaP > 0) this._waveDir.set(Math.cos(ws.theta), Math.sin(ws.theta));
    const wp = Math.max(ws?.omegaP ?? 1, 0.2), lp = 2 * Math.PI * 9.81 / (wp * wp);
    // 破碎多发生在比谱峰短的浪上（4–20 m 一级）：分段尺度与群速度按 min(λp, 16 m) 取
    const lb = Math.min(lp, 16), cb = Math.sqrt(9.81 * lb / (2 * Math.PI));
    const life = this.params.foamLifetime;
    const strong = THREE.MathUtils.smoothstep(U, 7, 18);
    this.foam.update(dt, {
      cameraX: cam.x, cameraZ: cam.z, drift: this._drift, threshold: this.foamThreshold, gain: 12,
      sigmaH: Math.max(0.05, ro.Hs / 4), waveDir: this._waveDir, windDir: w,
      groupSpeed: 0.5 * cb, segScale: THREE.MathUtils.clamp(0.5 * lb, 2, 8),
      // 老化泡沫丝：大风时破碎多、泡沫厚，残留泡沫消退后留下更多、更持久的薄泡沫
      tau: { A: FOAM_TIMESCALES.tauA, B: FOAM_TIMESCALES.tauB * life, C: (6 + 24 * strong) * life, toC: 0.2 * strong },
      // 朗缪尔环流（取最小一级、离表面最近的涡卷）：表面辐合 ≈ 0.6% U10、辐合线上顺风射流 ≈ 0.8% U10，
      // 线距几米（实测线距从 2 m 到数百 m 多个尺度并存）；十几秒就能把泡沫丝聚成沿风向的细条
      langmuir: { converge: 0.006 * U, jet: 0.008 * U, spacing: THREE.MathUtils.clamp(2.5 + 0.25 * U, 3, 10) },
    });
    this._crestTimer += dt;
    if (this._crestTimer > 0.1) { this._crestTimer = 0; this.foam.readCrests(); }
    u.uFoamField.value = this.foam.texture;
    this.foam.uvOffsetFor(ox, oz, u.uFoamUV.value);
    const fsx = this.foam.stats;
    u.uFoamMean.value.set(fsx.active, fsx.residual, fsx.lace, fsx.coverage);
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
    // 老化泡沫丝图案：风坐标系里沿风向拉长，随漂流移动
    const sfx = fs * 8, sfz = fs * 0.4;
    u.uStreakOff.value.set(frac((a - (this._drift.x * w.x + this._drift.y * w.y)) / sfx), frac((b - (-this._drift.x * w.y + this._drift.y * w.x)) / sfz));
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

  /**
   * 预热：不渲染，连续推进 seconds 秒（波浪、白浪场、阈值校准一起走），切镜头后用，免得泡沫从零长起。
   * 每 4 步让出一次事件循环，异步回读（坡度统计、覆盖率）才能落地。真显卡上每步约 1–2 ms。
   */
  async warmup(seconds, camera, light = null, dt = 1 / 20) {
    const n = Math.ceil(seconds / dt);
    for (let i = 0; i < n; i++) {
      this.update(dt, camera, light);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** 世界坐标 (x, z) 处的水面高度（CPU，来自 GPU 回读，延迟 1–2 帧；不含最细一级） */
  sampleHeight(x, z) { return this.sim.heightAt(x, z); }

  /** 世界坐标 (x, z) 处水面质点的速度（m/s，轨道速度 + 风生漂流），给船体水动力用 */
  sampleVelocity(x, z, out = { x: 0, y: 0, z: 0 }) {
    const r = this.sim.referenceAt(x, z, this._vref || (this._vref = { x: 0, z: 0 }));
    this.sim.velocityAt(r.x, r.z, out);
    out.x += this.surfaceDrift.x; out.z += this.surfaceDrift.y;
    return out;
  }

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
      whitecapMeasured: this.coverageSmoothed ?? 0,      // 照片法覆盖率（活跃 + 残留，3 s 平均）
      whitecapActive: this.foam.stats.active,            // 其中正在破碎的部分
      foamLace: this.foam.stats.lace,                    // 老化泡沫丝（不计入覆盖率）
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

  /** 调试视图：0 正常，1 法线，2 泡沫，3 粗糙度，4 菲涅尔，5 尾迹，6 水深，7 阵风，8 白浪场（红 A、绿 B、蓝 C） */
  setDebugView(i) { this.material.uniforms.uDebug.value = i | 0; }

  /**
   * 正在破碎的浪峰（来自白浪场的降采样回读，约 10 Hz）。回调 fn(x, z, active, cellSize)，
   * x/z 为格子中心的参考坐标（未位移），active 为格内活跃白浪的面积比例（> minActive 才回调）。
   */
  forEachBreaking(fn, minActive = 0.01) {
    const c = this.foam.crests;
    if (!c) return 0;
    let n = 0;
    for (let j = 0; j < c.size; j++) for (let i = 0; i < c.size; i++) {
      const A = c.data[(j * c.size + i) * 4];
      if (A > minActive) { fn(c.minX + (i + 0.5) * c.cell, c.minZ + (j + 0.5) * c.cell, A, c.cell); n++; }
    }
    return n;
  }

  /** 主浪（风浪谱峰）的传播方向与相速度 */
  get dominantWave() {
    const ws = this.model.spectrumParams().windSea;
    const wp = Math.max(ws?.omegaP ?? 1, 0.2);
    return { dir: this._waveDir, c: 9.81 / wp, omega: wp };
  }

  dispose() {
    this.foam.dispose();
    this.sim.dispose();
    this.mesh.geometry.dispose();
    this.material.uniforms.uFoamTex.value.dispose();
    this.material.uniforms.uRippleTex.value.dispose();
    this.material._blank.dispose();
    this.material.dispose();
  }
}
