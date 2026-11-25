# ocean · 风与浪物理一致的 Three.js 海面模块

这个模块把风作为唯一的源头：风速、风向、风区、持续时间 → 按海洋学经验规律起浪、积累、转为涌浪 → 用 GPU FFT 合成海面 → 电影级着色。海面上看到的浪高、周期、方向、白浪多少、闪光带宽窄，都由同一套规律算出，并且有测试验证。

依赖：three.js r170（`three` 与 `three/addons/` 两个导入名），WebGL2，以及渲染到浮点纹理的能力（`EXT_color_buffer_float`，桌面和近几年的手机基本都有）。没有图片、模型、音频文件。

```
ocean/
  WindSeaModel.js      风浪物理模型（纯 JS，Node 也能跑）
  OceanSimulation.js   GPU 波谱 + 三级 FFT + 泡沫累积 + CPU 回读
  OceanGeometry.js     以相机为中心的 LOD 网格
  OceanMaterial.js     海面着色器
  Ocean.js             总装（推荐从这里用）
  Buoyancy.js          漂浮体（升沉 / 纵摇 / 横摇）
  textures.js          程序纹理（泡沫、毛细波）
  index.js             上面几个的统一出口
  SkyEnvironment.js    天空、云、日月星、闪电、反射立方体（可选）
  CinematicComposer.js 电影感后期（可选）
  WakeMap.js           尾迹图（可选）
  Spray.js             浪花 / 飞沫粒子（可选）
  extras/Sailboat.js   参数化船体与单桅帆船（可选）
```

演示：`examples/ocean/`（用静态服务器打开 `examples/ocean/index.html`）。

## 快速上手

```js
import * as THREE from 'three';
import { Ocean, Buoyancy } from './ocean/index.js';
import { SkyEnvironment } from './ocean/SkyEnvironment.js';

const sky = new SkyEnvironment(renderer, { cubeSize: 256 });
scene.add(sky.object);

const ocean = new Ocean(renderer, {
  quality: 'high',
  sea: { wind: { x: 9, z: -4 }, fetch: 400e3, depth: 3000, timeScale: 60 },
});
scene.add(ocean.mesh);
ocean.model.develop(1);            // 直接跳到当前风况的极限海况；不调用则从平静开始起浪

function frame(dt) {
  sky.update(dt, { camera, timeOfDay: 17.6, cloudCover: 0.4, wind: new THREE.Vector2(9, -4) });
  ocean.update(dt, camera, sky);   // 也可以传 { sunDirection, sunColor, ambientColor, envMap }
  renderer.render(scene, camera);  // 或接 CinematicComposer
}

// 改风：浪不会突变，而是按物理规律慢慢起来 / 变成涌浪
ocean.model.setWind(15, 0);

// 浮力（与画面上的浪一致，来自 GPU 回读，延迟 1–2 帧）
const y = ocean.sampleHeight(x, z);
const buoy = new Buoyancy(boatGroup, { points: localWaterlinePoints });
buoy.update(dt, ocean, { heel: 0 });
```

坐标约定：米、秒、Y 向上、海平面 y = 0。风是水平向量（x, z），指向空气流动的去向。

## 一、风浪物理（WindSeaModel）

### 1. 生长：风速 × 风区 × 风时

| 规律 | 公式 | 来源 |
|---|---|---|
| 无量纲风区 | X̃ = g·X / U² | — |
| 能量 | g²E / U⁴ = 1.6×10⁻⁷ · X̃ | JONSWAP，Hasselmann 等 1973 |
| 谱峰频率 | ω_p·U / g = 22 · X̃^−0.33 | JONSWAP |
| 风时与风区 | g·t / U = 68.8 · X̃^(2/3) | SPM 1984 |
| 充分发展上限 | ω_p·U / g = 0.855，对应 X̃ ≈ 1.88×10⁴，Hs = 0.219·U²/g | Pierson–Moskowitz 1964 |
| 有效波高 | Hs = 4√E | — |

浪的“年龄”用**等效风时**表示：每一步先由当前能量反求在当前风速下的等效风时，加上经过的时间，再取风时、风区、充分发展三者中最先达到的限制。风速连续变化时 Hs 连续，不会跳变；步长不同结果一致（测试里 1 s 步长与 100 s 步长完全相同）。

`timeScale` 把海况时间加速：真实中 10 m/s 的风要吹约 14 小时才充分发展，演示里用 ×20 到 ×900 压缩。

### 2. 风变、转涌、衰减

- **风变弱或风区变短**：当前能量超出新风况能维持的上限时，多出部分转为涌浪（保留原周期和方向），总能量守恒。
- **风向突变 > 45°**：原风浪整体转为涌浪，新风向上从零起浪；< 45° 时风浪方向按与周期成正比的时间常数（8 s 浪约半小时）向风向偏转。
- **无风**：风浪全部转为涌浪。
- **涌浪衰减**：能量按 e 指数衰减，时间常数与周期平方成正比（8 s 约 5 小时，周期越长越持久），方向分布随时间变窄。
- **平均风**：大浪只响应 10 分钟平均风（气象上 U10 的定义），阵风只改变短波和毛细波。

### 3. 浅水

- 生长律乘以 Young & Verhagen (1996) 有限水深公式的“浅水/深水”比值：深水时比值为 1，结果不变；浅水时能量和谱峰周期都被水深限制（15 m/s、水深 6 m：Hs 1.5 m、Tp 5.4 s，而深水是 5 m、11 s）。
- 波谱乘 TMA 深度函数（Bouws 等 1985），色散用 ω² = g·k·tanh(k·h)。
- 破碎上限 Hs ≤ 0.6·h。

### 4. 读数（`ocean.readout`）

`U10`、`beaufort`（蒲福风级与中文名）、`Hs / HsWind / HsSwell`、`Tp`、`wavelength`、`phaseSpeed`、`groupSpeed`、`waveAge`（c_p/U，充分发展 ≈ 1.17）、`stage`（calm / duration / fetch / developed）、`timeToLimit`、`seaState`（浪级 0–9，与道格拉斯海况阈值一致）、`whitecap`（Monahan 覆盖率），以及模拟实测值 `simulatedHs`、`whitecapMeasured`、`mssSimulated` 与 `mssCoxMunk`。

### 5. 验证

`node --test tests/ocean/windsea.test.mjs`：16 项，包括充分发展与 PM 一致、风区受限（10 m/s、50 km → 1.14 m / 4.8 s）、风时生长（1 h 0.31 m、6 h 1.2 m、约 14 h 充分发展）、能量守恒、转涌、浅水、谱形归一化。

`tests/ocean/spectrum-check.html`：把模型给出的理论 Hs 送进 GPU，从回读的高度场统计实测 Hs：

| 情形 | 理论 | 模拟 |
|---|---|---|
| 10 m/s 充分发展 | 2.24 m | 2.21 m |
| 20 m/s 充分发展 | 8.77 m | 8.78 m |
| 12 m/s，风区 40 km | 1.23 m | 1.24 m |
| 2 m / 12 s 涌浪 + 5 m/s 风浪 | 2.08 m | 2.15 m |
| 水深 6 m，15 m/s | 1.54 m | 1.52 m |

`tests/ocean/fft-check.html`：GPU 逆 FFT 与 CPU 逐点 DFT 对照（位移、雅可比、坡度、CPU 回读），相对误差 < 3×10⁻⁴（float32 精度）。

## 二、波谱与 FFT（OceanSimulation）

- **风浪谱形**：Donelan, Hamilton & Hui (1985)：谱峰以上 ω⁻⁴ 平衡区（Toba），3·ω_p 以上转 ω⁻⁵ 饱和区；γ、σ 随逆波龄 U/c_p 变化（年轻风浪峰尖、成熟风浪峰宽）。总能量按生长律归一化，所以谱形只决定能量怎么分配，不改变 Hs。比 JONSWAP 全段 ω⁻⁵ 有更多中短波，海面更“碎”，均方坡度更接近 Cox–Munk 观测。
- **涌浪谱形**：窄 JONSWAP（γ = 5–7）。
- **方向分布**：cos^2s(Δθ/2)，s 随相对频率和波龄变化（Hasselmann 等 1980）；涌浪 s = 15–75。
- **三级级联**：平铺尺寸 2048 / 160 / 24 m（高画质），按波数分段：每级只负责 [6·2π/L_{c+1}, …) 的波段，合起来覆盖 0.19 m – 2 km 的波长且不重复。约束 L_c / L_{c+1} ≤ N/12 保证每级波段不超过自己的奈奎斯特频率。
- **时间演化**（Tessendorf 2001）：h(k,t) = h0(k)·e^(−iωt) + conj(h0(−k))·e^(iωt)。频率按 2π/2048 s 量化，相位精度不随运行时间下降。
- **水平位移**：D = i·k̂·h，浪峰处水平收缩形成尖峰；`choppiness` = 1 为线性理论值。
- **逆 FFT**：Stockham 自排序基 2，三级在纹理里上下叠放一次做完；两张 MRT 纹理各装两组复数场（利用实数场的共轭对称），一帧共 2·log2N 次全屏 pass。奈奎斯特行列置零（它们的镜像是自身，打包两个实数场时会串扰）。
- **输出**（每级，RGBA16F，带 mipmap，可平铺）：位移 (Dx, Dy, Dz, J)、坡度一二阶矩 (sx, sz, sx², sz²)、泡沫 (活跃, 残留, J)。
- **泡沫**：雅可比 J 低于阈值处生成活跃白浪，随后衰减为残留泡沫（时间常数约 1 s / 6 s）。阈值由 `Ocean` 按 Monahan & O'Muircheartaigh (1980) 覆盖率 W = 3.84×10⁻⁶·U^3.41 反馈校准（对数误差积分控制），所以风越大白浪越多且比例符合观测。
- **CPU 回读**：级联 0（256²）、级联 1（128²）的位移异步读回，`heightAt(x, z)` 用 4 次不动点迭代反解水平位移后取高度，与画面一致（不含最细一级）。同时统计实测 Hs。

## 三、海面着色（OceanMaterial）

| 环节 | 做法 |
|---|---|
| 法线 | 三级坡度相加（雅可比修正后的拉格朗日坡度） |
| 粗糙度 | LEAN：每级坡度 mip 的二阶矩减一阶矩平方 = 亚像素坡度方差；再加未解析部分 = Cox–Munk 总均方坡度 − 模拟已解析部分。远处不闪，太阳倒影按观测宽度展开成闪光带 |
| 近处细节 | 未解析坡度方差在近处约六成画成毛细波法线（沿风向、随风滚动），远处全部计入粗糙度 |
| 阵风 | 随风平移的噪声场只调制最细一级和毛细波：海面上出现一块块随风移动的暗斑（猫爪风），大浪不受影响 |
| 反射 | 精确 Fresnel（n = 1.333）+ Karis 环境 BRDF：粗糙表面在掠射角反射率下降，远处海面不会成一面白镜子；天空立方体按粗糙度取 mip；可叠平面反射 |
| 太阳 / 月亮 | GGX + Smith 相关可见度，α 下限为太阳视半径，HDR 限幅 |
| 水体 | Atlas（GDC 2019）散射：浪尖背光透射 k1（逆光时浪尖透出青绿）、视线散射 k2、受光面 k3、天光；泡沫附近气泡增亮 |
| 泡沫 | 活跃白浪（主浪浪峰被短波挤压打散）+ 残留泡沫 + 8 级以上沿风向的条纹 + 尾迹 + 岸线泡沫，乘随风漂移（3% 风速）的气泡纹理 |
| 远处 | 雾色取天空立方体在视线方位的地平线颜色 + 朝太阳的米氏散射，海天无缝 |
| 夜晚 | 尾迹和碎浪发蓝光（夜光藻，强度随 `SkyEnvironment.night`） |

光照单位：`SkyEnvironment.keyLightColor` 约定为“白色漫反射面在该光下的亮度”（E/π，正午 ≈ 1），`Ocean` 自动乘 π 换成辐照度。自己传 `{ sunDirection, sunColor }` 时，`sunColor` 应为辐照度（正午约 3–6）。

调试视图：`ocean.setDebugView(i)`，1 法线、2 泡沫、3 粗糙度、4 菲涅尔、5 尾迹、6 水深、7 阵风、8 雅可比、9 NaN/Inf 定位。

## 四、API

### Ocean

```js
new Ocean(renderer, { quality = 'high', model?, sea = {...WindSeaModel 选项}, choppiness = 1, seed? })
```

| 成员 | 说明 |
|---|---|
| `mesh` | 加到场景里的海面（frustumCulled = false，renderOrder = 10） |
| `model` | WindSeaModel 实例 |
| `sim` | OceanSimulation 实例 |
| `params` | `choppiness`、`foamAmount`、`autoWhitecaps`、`whitecapScale`、`gustiness`、`fogDensity`（null = 跟随天空）、`mie`、`envIntensity`、`biolumination` |
| `update(dt, camera, light)` | 每帧调用；light 可直接传 SkyEnvironment |
| `sampleHeight(x, z)` / `sampleNormal(x, z)` | CPU 采样水面 |
| `readout` | 见上文 |
| `setWake(texture, rect)` | 尾迹（R 泡沫、G 波脊；rect = minX, minZ, sizeX, sizeZ） |
| `setBathymetry(texture, rect)` | 水深（R = 地面高度，水下为负），开启浅滩颜色、岸线泡沫、浅水消波 |
| `setReflection(texture, matrix, strength)` | 平面反射（alpha 标记有物体处） |
| `setQuality(q)` | `ultra` / `high` / `medium` / `low` |
| `resetWhitecaps()` | 风况突变后从估计值重新校准白浪 |
| `setDebugView(i)` | 见上文 |

### WindSeaModel

```js
new WindSeaModel({ wind = {x, z}, fetch = 300e3, depth = 2000, timeScale = 60, windResponse = 600, swellDecayHours = 5, maxSwells = 3 })
```

`setWind(x, z)`、`snapWind()`、`setFetch(m)`、`setDepth(m)`、`setTimeScale(k)`、`setBackgroundSwell({ Hs, Tp, theta, spread })`、`calm()`、`develop(fraction)`、`update(dt)`、`spectrumParams()`、`readout`、`history`（Hs 随海况时间的记录）。另导出 `beaufort`、`seaStateScale`、`whitecapCoverage`、`waveSpeeds`、`wavenumber`、`depthLimitation` 等函数。

### Buoyancy

```js
new Buoyancy(object3D, { points, heavePeriod = 2.2, pitchPeriod = 2.8, rollPeriod = 3.6, damping = 0.35, draft = 0 })
buoy.update(dt, ocean, { heel })   // object 的 x、z、rotation.y 由外部控制；写入 y、rotation.x、rotation.z（order = 'YXZ'）
```

在采样点下取水面高度，最小二乘拟合平面 h = a + b·x + c·z，得到目标升沉、纵倾、横倾，再用二阶阻尼振子跟随。比船短的浪被自然平均掉，比船长的浪把船抬起、倾侧。

### 配套模块（可选）

| 模块 | 用法要点 |
|---|---|
| `SkyEnvironment(renderer, { cubeSize = 256 })` | `scene.add(sky.object)`（可选 `sky.lights`）；`update(dt, { camera, timeOfDay, cloudCover, storm, wind, sunAzimuth })`；输出 `keyLightDirection / keyLightColor`（白天太阳、夜里月亮）、`ambientColor`、`envMap`（不含太阳盘）、`environment`（PMREM）、`lightning`、`night`、`fogDensity`。`applyFog(material)` 给普通材质打上与海面相同的远景雾。`SkyEnvironment.sunDirectionAt(时刻, out, 纬度, 方位)` 可用来按构图摆太阳 |
| `CinematicComposer(renderer, scene, camera, { samples = 4 })` | 代替 `renderer.render`：`render(dt)`；`applyPreset('golden' / 'storm' / 'tropical' / 'moonlight' / 'dawn')`；`params` 里有曝光、泛光、白平衡、lift / gamma / gain、暗角、颗粒、色差、`letterbox`（画幅比）与 `letterboxAmount`（0–1） |
| `WakeMap(renderer, { resolution = 512, worldSize = 256 })` | `const hull = wake.createHullEmitter({ beam, length })`；每帧先 `hull.update(dt, { x, z, forwardX, forwardZ, speed })` 再 `wake.update(dt, cx, cz)`，然后 `ocean.setWake(wake.texture, wake.rect)`；`reset()` 清空 |
| `Spray({ max = 4000 })` | `scene.add(spray.object)`；`emit(pos, vel, size, life, opacity)`；`update(dt, { keyLightDirection, keyLightColor, ambientColor, wind, waterHeight })`。逆光时前向散射发亮 |
| `extras/Sailboat({ hull, mastHeight, sky })` | 原点在水线中心，船首 +Z、左舷 +X；`floatPoints`（给 Buoyancy）、`bowPoint`、`dims`；`update(dt, { apparentWind, heel, time })` 返回 `heelTarget`（桅顶倒向 +X 为正，喂给 Buoyancy 时取负）。`buildHull(params)` 可单独生成参数化船体 |

## 五、画质与性能

| 预设 | FFT | 级联（m） | 网格 | 回读 |
|---|---|---|---|---|
| ultra | 256² | 2048 / 160 / 24 | 0.3 m 细格 | 256² + 128² |
| high | 256² | 2048 / 160 / 24 | 0.45 m 细格，约 23 万顶点 | 256² + 128² |
| medium | 128² | 1024 / 128 / 20 | 0.8 m 细格 | 128² + 64² |
| low | 64² | 512 / 100 / 20 | 1.6 m 细格 | 64² |

每帧 GPU 计算：1 次波谱 + 1 次演化 + 2·log2N 次 FFT + 3 次组装（三级共用纹理，256² 时约 20 个全屏 pass）。片元着色器是主要开销（约 12 次纹理采样 + 环境立方体）。手机默认用 medium。

## 六、踩过的坑

1. **坡度平方溢出半精度**：风暴里最细一级坡度很大，平方超过 65504 变成 Inf；远处取高级 mip 时 Inf − Inf = NaN，地平线出现黑线。组装时把坡度限幅到 ±8。
2. **MSAA 下插值外推**：多重采样时片元在像素中心执行，地平线处细长三角形的中心可能在三角形外，插值出离谱的距离和雾因子。顶点输出加 `centroid`。
3. **three r170 异步回读没解绑 PIXEL_PACK_BUFFER**：之后任何同步 `readPixels` 都会失败，发起读取后要手动 `gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)`。
4. **奈奎斯特频点**：打包两个实数场同时做 IFFT 依赖共轭对称，k = −N/2 的镜像是自身，不置零会串扰。
5. **GLSL ES 3.00 保留字**：`active`、`half`、`sample`、`input`、`output`、`filter` 都不能当变量名。
6. **JONSWAP 全段 ω⁻⁵ 短波不足**：均方坡度只有观测的三分之一，海面显得太平滑；换成 ω⁻⁴ 平衡区的 Donelan 谱。
7. **浮力必须与画面同源**：CPU 采样用 GPU 回读的位移（同一套级联与权重），并反解水平位移，否则船会浮在空中或陷进浪里。
8. **太阳不要画进反射立方体**：否则水面上有两个太阳倒影；太阳倒影交给解析高光。

## 参考

- Hasselmann et al. (1973) JONSWAP；Pierson & Moskowitz (1964)；Shore Protection Manual (1984)
- Donelan, Hamilton & Hui (1985) Directional spectra of wind-generated waves
- Hasselmann, Dunckel & Ewing (1980) Directional wave spectra observed during JONSWAP 1973
- Bouws et al. (1985) TMA spectrum；Young & Verhagen (1996) Lake George 有限水深生长律
- Monahan & O'Muircheartaigh (1980) 白浪覆盖率；Cox & Munk (1954) 海面坡度统计
- Tessendorf (2001) Simulating Ocean Water
- Olano & Baker (2010) LEAN Mapping；Karis (2014) Environment BRDF 近似
- GDC 2019：Wakes, Explosions and Lighting: Interactive Water Simulation in Atlas（海水散射光照模型）
