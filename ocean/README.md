# ocean · 风与浪物理一致的 Three.js 海面模块

这个模块把风作为唯一的源头：风速、风向、风区、持续时间 → 按海洋学经验规律起浪、积累、转为涌浪 → 用 GPU FFT 合成海面 → 电影级着色。海面上看到的浪高、周期、方向、白浪多少、闪光带宽窄，都由同一套规律算出，并且有测试验证。

依赖：three.js r170（`three` 与 `three/addons/` 两个导入名），WebGL2，以及渲染到浮点纹理的能力（`EXT_color_buffer_float`，桌面和近几年的手机基本都有）。没有图片、模型、音频文件。

```
ocean/
  WindSeaModel.js      风浪物理模型（纯 JS，Node 也能跑）
  OceanSimulation.js   GPU 波谱 + 三级 FFT + CPU 回读（位移、水质点速度）
  FoamField.js         白浪场：世界坐标里的破碎判定与泡沫生命周期（活跃 → 残留 → 泡沫丝）
  OceanGeometry.js     以相机为中心的 LOD 网格
  OceanMaterial.js     海面着色器
  Ocean.js             总装（推荐从这里用）
  Buoyancy.js          漂浮体（升沉 / 纵摇 / 横摇）
  textures.js          程序纹理（泡沫、毛细波）
  index.js             上面几个的统一出口
  SkyEnvironment.js    天空、云、日月星、闪电、反射立方体（可选）
  CinematicComposer.js 电影感后期（可选）
  WakeMap.js           尾迹图（可选）
  Spray.js             飞沫粒子（运动模糊条）+ 浪尖飞沫发射器（可选）
  droplets.js          水滴动力学与近海面风廓线（纯 JS）
  extras/Sailboat.js   参数化船体与单桅帆船的画面（可选）
  vessel/              帆船动力学：六自由度刚体，船体水压积分、阻力、龙骨 / 舵 / 帆的力（可选，见 vessel/README.md）
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

`tests/ocean/fft-check.html`：GPU 逆 FFT 与 CPU 逐点 DFT 对照（位移、雅可比、坡度、水平位移导数、CPU 回读），相对误差 < 3×10⁻⁴（float32 精度）；另查波谱纹理的厄米对称（风沿坐标轴的三种情形，误差为 0）。

## 二、波谱与 FFT（OceanSimulation）

- **风浪谱形**：Donelan, Hamilton & Hui (1985)：谱峰以上 ω⁻⁴ 平衡区（Toba），3·ω_p 以上转 ω⁻⁵ 饱和区；γ、σ 随逆波龄 U/c_p 变化（年轻风浪峰尖、成熟风浪峰宽）。总能量按生长律归一化，所以谱形只决定能量怎么分配，不改变 Hs。比 JONSWAP 全段 ω⁻⁵ 有更多中短波，海面更“碎”，均方坡度更接近 Cox–Munk 观测。
- **涌浪谱形**：窄 JONSWAP（γ = 5–7）。
- **方向分布**：cos^2s(Δθ/2)，s 随相对频率和波龄变化（Hasselmann 等 1980）；涌浪 s = 15–75。
- **三级级联**：平铺尺寸 2048 / 160 / 24 m（高画质），按波数分段：每级只负责 [6·2π/L_{c+1}, …) 的波段，合起来覆盖 0.19 m – 2 km 的波长且不重复。约束 L_c / L_{c+1} ≤ N/12 保证每级波段不超过自己的奈奎斯特频率。
- **时间演化**（Tessendorf 2001）：h(k,t) = h0(k)·e^(−iωt) + conj(h0(−k))·e^(iωt)。频率按 2π/2048 s 量化，相位精度不随运行时间下降。
- **水平位移**：D = i·k̂·h，浪峰处水平收缩形成尖峰；`choppiness` = 1 为线性理论值。
- **逆 FFT**：Stockham 自排序基 2，三级在纹理里上下叠放一次做完；两张 MRT 纹理各装两组复数场（利用实数场的共轭对称），一帧共 2·log2N 次全屏 pass。奈奎斯特行列置零（它们的镜像是自身，打包两个实数场时会串扰）。
- **输出**（每级，RGBA16F，带 mipmap，可平铺）：位移 (Dx, Dy, Dz, J)、坡度一二阶矩 (sx, sz, sx², sz²)、水平位移的导数 (λDxx, λDzz, λDxz, J)（给白浪场）。
- **CPU 回读**：级联 0（256²）、级联 1（128²）的位移异步读回，`heightAt(x, z)` 用 4 次不动点迭代反解水平位移后取高度，与画面一致（不含最细一级）。三个缓冲轮换，两次回读之差除以时间差就是水质点速度（`velocityAt`），给船体水动力用。同时统计实测 Hs。

## 三、白浪、泡沫与飞沫（FoamField / Spray）

旧版把泡沫存在级联纹理里，跟着 160 m 的平铺一起重复，也不随水漂流。现在白浪在相机周围 512 m 见方的世界坐标图里演化（1024²，0.5 m 一格），每格是一块随表面漂流的水。

### 1. 破碎在哪里发生

| 条件 | 做法 | 依据 |
|---|---|---|
| 陡度超过临界 | 波长 > 约 4 m 的两级合成的总雅可比 J = (1+Dxx)(1+Dzz) − Dxz² 低于阈值，即浪峰处的水平压缩（线性化的局部陡度）超过临界值 | 破碎起始的几何 / 运动学判据；能量通量判据 B ≈ 0.85（Barthelemy 等 2018；Saket 等 2017；Derakhti 等 2020） |
| 在浪峰上、偏前坡 | 两级合成高度 > 约 −0.6σ 才起，最强在浪峰之上；沿传播方向下降的一侧（前坡）权重 1，后坡 0.35 | 白浪在浪峰前坡翻滚；长浪峰上的短波更陡、更易破碎（调制） |
| 沿浪峰分段 | 噪声按主浪群速度移动，破碎集中在波群能量最大处，一段几米长 | 破碎由波群聚焦触发；实测破碎峰线长度分布（Kleiss & Melville 2010；Romero 2019） |
| 只看 > 4 m 的波 | 最细一级（< 4 m）的极短波挤压得厉害，但那是不带气泡的微破碎，看不见 | — |

唯一的常数是临界值 J_c = 0.725（`params.breakingThreshold`）：局部水平压缩超过约 28% 的浪峰破碎。它在 8、12、20 m/s 充分发展海况下各标定一次，三处要求的值几乎相同（0.72、0.71、0.745），所以取成与风速无关的物理常数。覆盖率由海况自然得出，风越大、浪越陡，白浪越多，与观测的对比见下文验证。需要严格对齐经验曲线时，可设 `params.autoWhitecaps = true`：覆盖率（3 s 平均）对 Monahan & O'Muircheartaigh (1980) 的 W = 3.84×10⁻⁶·U^3.41 做慢速对数积分校准，闭环时间常数约 6 s。破碎在哪里发生、持续多久、留下什么，都由过程决定，不靠这个常数。

### 2. 泡沫的一生

三个通道都是面积比例（0–1），每帧按 dt 精确积分指数衰减：

```
活跃白浪 A ──τA≈0.5 s──▶ 残留泡沫 B ──τB≈3.9 s──▶ 消失
                                  └─ 一部分（大风时）──▶ 老化泡沫丝 C ──τC 6–30 s──▶ 消失
```

- **A（stage A）**：正在破碎的浪峰。水块被浪峰扫过后 A 以 τA 衰减，所以白浪在浪峰后面拖一段 c·τA 长的尾巴（10 m/s 的浪约 5 m）。
- **B（stage B）**：破碎停止后留在水面的泡沫斑。τA、τB 取 Monahan & Lu (1990) 的 0.53 s、3.85 s。B 与 A 的面积比是过程算出来的，没有写死。
- **C**：B 消退后残下的薄泡沫与表面膜。只在大风时有量（比例随风速 7–18 m/s 从 0 升到 0.2，寿命 6–30 s）。C 被朗缪尔环流平流：表面辐合约 0.6% U10、辐合线上的顺风射流约 0.8% U10、线距 3–10 m，线弯曲、断续、Y 形汇合。半拉格朗日平流加面密度守恒（辐合处变浓）。十几秒就聚成沿风向的细条，就是蒲福 7–9 级描述里“沿风向成条的泡沫”。
- **漂流**：整张图随表面漂流（Stokes 漂流 + 风生流，约 3% U10）平移。海面位移按未位移的参考位置存储，泡沫自动随轨道运动前后摆动，在浪峰处被挤密。
- **照片法覆盖率** f = min(1, A + B)：与 Monahan 的定义一致，含活跃与残留，不含很薄的 C。

### 3. 泡沫的光学

| 类别 | 反照率 | 不透明度 | 图案 |
|---|---|---|---|
| A 新鲜白浪 | 0.55（Whitlock 等 1982；Koepke 1984） | 1 | 团块 + 细碎气泡 |
| B 残留泡沫筏 | 0.4；斑块里约一半是空洞，整块平均约 0.2，与 Koepke (1984) 的有效反照率 0.22 相符 | 0.85 | Worley 网状花边 |
| C 泡沫丝 | 0.25 | 0.5 | 沿风向拉长 8 倍的细丝 |

- **覆盖率严格守恒**：泡沫纹理三个通道都按秩均衡成 [0,1] 上的均匀分布，着色器取“图案值 > 1 − f”画出面积比例为 f 的泡沫，画面覆盖率就等于模拟值。两层不同尺度的图案用加权和的分布函数映射回均匀分布。图案细于像素时直接按比例 f 混合，期望值处处相同。
- **光谱**：泡沫反射率随波长略降（Frouin 等 1996），颜色 (0.9, 0.96, 1.0)。
- **气泡云**：A、B 下方的气泡云散射增亮水体（青绿色）。
- **抑制毛细波**：残留泡沫与表面膜处毛细波被抑制（油膜效应，Alpers & Hühnerfuss 1989），那里更光滑、闪光更少。
- **远处**：白浪场的 mipmap 就是面积平均，远处自然变成按比例混合。白浪场范围外用全场平均比例 × 主浪浪峰调制（1 + 0.9·η/σ，均值约 1）。

### 4. 飞沫（Spray、SpumeEmitter、droplets）

- **何时出现**：U10 > 9 m/s 开始从正在破碎的浪峰撕下水滴，产量随 (U10 − 9)^2.5 增加。量级参考 Andreas (1998) 与 Veron (2015) 综述中飞沫生成函数随风速的陡增。
- **从哪里出**：白浪场按 10 Hz 降采样回读（128²，4 m 一格），在活跃白浪格里随机取 3 点，选最高的（浪尖）。
- **初速**：沿主浪方向 0.6–0.9 倍相速度（破碎浪峰处水质点速度接近相速度；Mostert、Popinet & Deike 2022 的数值模拟里飞沫初速可达相速度数倍），向上 0.5–3 m/s。
- **运动**：dv/dt = (u_air(z) − v)/τ + g。τ 为 Stokes 弛豫时间加 Schiller–Naumann 有限雷诺数修正，隐式积分。空气速度按中性对数风廓线，z0 取 Charnock，Cd 取 Wu (1982)。50 μm 的水滴 0.2 s 内就随风飘成雾，400 μm 的水滴 τ ≈ 0.25 s，被甩出后很快落回。
- **画法**：每个粒子代表一团同尺寸的水滴，画成沿速度方向的运动模糊条（快门 1/60 s）。条越长单位面积越淡（能量守恒），条内是几条细丝加淡雾。逆光时 Henyey–Greenstein 前向散射发亮。
- **验证**：终端速度与 Gunn & Kinzer (1949) 实测（直径 0.1 / 0.2 / 0.5 / 1 mm → 0.27 / 0.72 / 2.06 / 4.03 m/s）相差 < 10%，见 `tests/ocean/spray.test.mjs`。

### 5. 验证（白浪）

`tests/ocean/look.html` 里按真实步长推进（每步 1/15 s），充分发展海况，36 s 后读白浪场全图平均。破碎阈值固定为 J_c = 0.725，不按风速做任何调整：

| U10 | Hs | Monahan (1980) | 模拟 | 模拟 / 观测 | 其中活跃 A | 残留 / 活跃 | 泡沫丝 C |
|---|---|---|---|---|---|---|---|
| 6 m/s | 0.81 m | 0.17% | 0.10%（仍在增长） | 0.59 | 0.007% | 14 | 0 |
| 8 m/s | 1.43 m | 0.46% | 0.53% | 1.14 | 0.05% | 10.6 | 0 |
| 12 m/s | 3.22 m | 1.84% | 2.91% | 1.58 | 0.42% | 6.2 | 0.9% |
| 16 m/s | 5.72 m | 4.90% | 4.81% | 0.98 | 0.78% | 5.4 | 4.0% |
| 20 m/s | 7.91 m | 10.5% | 7.64% | 0.73 | 1.11% | 6.1 | 7.9% |

- **覆盖率**：8–20 m/s 与经验公式相差不到 1.6 倍。观测本身的离散比这大得多：同一风速下不同海域、不同风区和水温的实测覆盖率可差一个数量级（Anguelova & Webster 2006；Brumer 等 2017）。
- **残留与活跃之比**：5–11 倍，与 Monahan & Lu 的 τB/τA ≈ 7 一致。这个比例由过程算出，不是设定的。
- **6 m/s**：白浪很稀，36 s 时还没到稳态。
- **假重尾**：修掉波谱厄米对称的 bug（见“踩过的坑”第 13 条）之前，风沿坐标轴时雅可比有假的重尾，覆盖率与阈值的关系完全不同。

### 6. 已知局限

- 破碎判据基于线性叠加的海面，没有非线性波群聚焦，所以临界值 J_c 需要按观测标定一次（之后与风速无关）。能量通量判据（B ≈ 0.85）需要相速度和水质点速度场，线性 FFT 海面不能直接给出。
- 朗缪尔环流是参数化的速度场，不是从 Craik–Leibovich 方程解出来的。
- 白浪场只覆盖相机周围 512 m；更远处是统计意义上的平均。

## 四、海面着色（OceanMaterial）

| 环节 | 做法 |
|---|---|
| 法线 | 三级坡度相加（雅可比修正后的拉格朗日坡度） |
| 粗糙度 | LEAN：每级坡度 mip 的二阶矩减一阶矩平方 = 亚像素坡度方差；再加未解析部分 = Cox–Munk 总均方坡度 − 模拟已解析部分。远处不闪，太阳倒影按观测宽度展开成闪光带 |
| 近处细节 | 未解析坡度方差在近处约六成画成毛细波法线（沿风向、随风滚动），远处全部计入粗糙度 |
| 阵风 | 随风平移的噪声场只调制最细一级和毛细波：海面上出现一块块随风移动的暗斑（猫爪风），大浪不受影响 |
| 反射 | 精确 Fresnel（n = 1.333）+ Karis 环境 BRDF：粗糙表面在掠射角反射率下降，远处海面不会成一面白镜子；天空立方体按粗糙度取 mip；可叠平面反射 |
| 太阳 / 月亮 | GGX + Smith 相关可见度，α 下限为太阳视半径，HDR 限幅 |
| 水体 | Atlas（GDC 2019）散射：浪尖背光透射 k1（逆光时浪尖透出青绿）、视线散射 k2、受光面 k3、天光；白浪下方气泡云增亮 |
| 泡沫 | 白浪场的 A / B / C 三类面积比例，各按实测反照率和不透明度画（见上节）；尾迹、岸线泡沫按残留泡沫画，越浓越接近新鲜白浪的亮度 |
| 远处 | 雾色取天空立方体在视线方位的地平线颜色 + 朝太阳的米氏散射，海天无缝 |
| 夜晚 | 尾迹和碎浪发蓝光（夜光藻，强度随 `SkyEnvironment.night`） |

光照单位：`SkyEnvironment.keyLightColor` 约定为“白色漫反射面在该光下的亮度”（E/π，正午 ≈ 1），`Ocean` 自动乘 π 换成辐照度。自己传 `{ sunDirection, sunColor }` 时，`sunColor` 应为辐照度（正午约 3–6）。

调试视图：`ocean.setDebugView(i)`，1 法线、2 泡沫遮罩、3 粗糙度、4 菲涅尔、5 尾迹、6 水深、7 阵风、8 白浪场（红 A、绿 B、蓝 C）、9 NaN/Inf 定位。

## 五、API

### Ocean

```js
new Ocean(renderer, { quality = 'high', model?, sea = {...WindSeaModel 选项}, choppiness = 1, seed? })
```

| 成员 | 说明 |
|---|---|
| `mesh` | 加到场景里的海面（frustumCulled = false，renderOrder = 10） |
| `model` | WindSeaModel 实例 |
| `sim` | OceanSimulation 实例 |
| `foam` | FoamField 实例（`stats`：全图平均的 active / residual / lace / coverage） |
| `params` | `choppiness`、`foamAmount`、`breakingThreshold`（破碎临界 J，默认 0.725）、`autoWhitecaps`（按 Monahan 校准，默认关）、`whitecapScale`、`foamLifetime`（残留泡沫寿命倍数）、`gustiness`、`fogDensity`（null = 跟随天空）、`mie`、`envIntensity`、`biolumination` |
| `update(dt, camera, light)` | 每帧调用；light 可直接传 SkyEnvironment |
| `warmup(seconds, camera, light)` | 异步；不渲染连续推进，切镜头后让泡沫与阈值先到稳态 |
| `sampleHeight(x, z)` / `sampleNormal(x, z)` | CPU 采样水面 |
| `sampleVelocity(x, z, out)` | 水质点速度（轨道速度 + 表面漂流），给船体水动力 |
| `surfaceDrift` | 表面漂流速度（Vector2，约 3% U10） |
| `forEachBreaking(fn, minActive)` | 遍历正在破碎的格子 `fn(x0, z0, active, cell)`（参考坐标，约 10 Hz 更新） |
| `dominantWave` | 主浪的 `dir`（Vector2）、相速度 `c`、角频率 `omega` |
| `readout` | 见上文 |
| `setWake(texture, rect)` | 尾迹（R 泡沫、G 波脊；rect = minX, minZ, sizeX, sizeZ） |
| `setBathymetry(texture, rect)` | 水深（R = 地面高度，水下为负），开启浅滩颜色、岸线泡沫、浅水消波 |
| `setReflection(texture, matrix, strength)` | 平面反射（alpha 标记有物体处） |
| `setQuality(q)` | `ultra` / `high` / `medium` / `low` |
| `resetWhitecaps()` | 风况突变后清空白浪场（自动校准时阈值从常数重新开始） |
| `resetSea()` | 海况突变（`model.calm()`、`develop()`、切镜头）后调用：清空白浪场并丢掉旧的 CPU 回读，免得新旧两个海面的位移差被当成水质点速度 |
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
| `Spray({ max = 4000, exposure = 1/60 })` | `scene.add(spray.object)`；`emit(pos, vel, size, life, opacity, radius)`（radius = 水滴半径 m，0 = 水团）；`update(dt, { keyLightDirection, keyLightColor, ambientColor, wind, waterHeight })`。运动模糊条，逆光时前向散射发亮 |
| `SpumeEmitter(spray, { rate, maxRate, radius })` | 每帧 `update(dt, ocean, camera)`：从正在破碎的浪峰撕下飞沫 |
| `droplets.js` | `airSeaRoughness(U10)`、`windAtHeight(U10, z)`、`relaxationTime(r, vrel)`、`stepDroplet(v, r, air, dt)` |
| `extras/Sailboat({ hull, mastHeight, sky })` | 原点在水线中心，船首 +Z、左舷 +X；`floatPoints`（给 Buoyancy）、`bowPoint`、`dims`；`update(dt, { apparentWind, heel, time })` 返回 `heelTarget`（桅顶倒向 +X 为正，喂给 Buoyancy 时取负）。`buildHull(params)` 可单独生成参数化船体 |

## 六、画质与性能

| 预设 | FFT | 级联（m） | 网格 | 回读 | 白浪场 |
|---|---|---|---|---|---|
| ultra | 256² | 2048 / 160 / 24 | 0.3 m 细格 | 256² + 128² | 1024²，512 m |
| high | 256² | 2048 / 160 / 24 | 0.45 m 细格，约 23 万顶点 | 256² + 128² | 1024²，512 m |
| medium | 128² | 1024 / 128 / 20 | 0.8 m 细格 | 128² + 64² | 512²，384 m |
| low | 64² | 512 / 100 / 20 | 1.6 m 细格 | 64² | 256²，256 m |

每帧 GPU 计算：1 次波谱 + 1 次演化 + 2·log2N 次 FFT + 3 次组装（三级共用纹理，256² 时约 20 个全屏 pass）+ 1 次白浪场更新（1024²，含 mipmap 生成）。片元着色器是主要开销（约 16 次纹理采样 + 环境立方体）。手机默认用 medium（白浪场 512²、384 m）。

## 七、踩过的坑

1. **坡度平方溢出半精度**：风暴里最细一级坡度很大，平方超过 65504 变成 Inf；远处取高级 mip 时 Inf − Inf = NaN，地平线出现黑线。组装时把坡度限幅到 ±8。
2. **MSAA 下插值外推**：多重采样时片元在像素中心执行，地平线处细长三角形的中心可能在三角形外，插值出离谱的距离和雾因子。顶点输出加 `centroid`。
3. **three r170 异步回读没解绑 PIXEL_PACK_BUFFER**：之后任何同步 `readPixels` 都会失败，发起读取后要手动 `gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)`。
4. **奈奎斯特频点**：打包两个实数场同时做 IFFT 依赖共轭对称，k = −N/2 的镜像是自身，不置零会串扰。
5. **GLSL ES 3.00 保留字**：`active`、`half`、`sample`、`input`、`output`、`filter` 都不能当变量名。
6. **JONSWAP 全段 ω⁻⁵ 短波不足**：均方坡度只有观测的三分之一，海面显得太平滑；换成 ω⁻⁴ 平衡区的 Donelan 谱。
7. **浮力必须与画面同源**：CPU 采样用 GPU 回读的位移（同一套级联与权重），并反解水平位移，否则船会浮在空中或陷进浪里。
8. **太阳不要画进反射立方体**：否则水面上有两个太阳倒影；太阳倒影交给解析高光。
9. **泡沫平流要 32 位浮点**：朗缪尔环流每帧只把泡沫移动千分之几个纹素，半精度的舍入会把这么小的变化吃掉，泡沫丝聚不起来。
10. **泡沫图案必须是均匀分布**：用“图案值 > 1 − f”画面积比例 f 时，图案分布不均匀，画面覆盖率就与模拟值对不上。纹理按秩均衡；两层叠加后再用加权和的分布函数映射回均匀。
11. **风暴天空的地平线不能比天顶亮**：泡沫被整个天空照亮（以天顶为主），掠射角的海面反射的却是地平线。地平线亮带比天顶亮时，白浪和海面一样亮，看不见。全阴天空应是天顶最亮、地平线约 1/3（CIE）。
12. **软件渲染下的命令积压**：无显卡时 GPU 远慢于 JS，测试脚本连续推进几百步会积压几十秒的命令，截图超时。每几步同步读一个像素。
13. **方向分布不要用 atan**：k 落在坐标轴上时 −k 的分量是 −0.0，有的 GPU 上 `atan(−0.0, x<0)` 结果不对，镜像波数的能量算错，厄米对称被破坏，打包在同一个复数场里的两个实数场互相串扰。风正好沿坐标轴时，高度会以约 15% 的幅度漏进 ∂Dx/∂z，雅可比出现假的重尾，白浪判据全错。改用 cos²(Δθ/2) = (1 + k̂·θ̂)/2。`fft-check` 里专门测了风沿坐标轴时波谱纹理的厄米对称。
14. **海况突变后要丢掉旧回读**：水质点速度 = 两次回读的位移差 / 时间差。切镜头时一份回读还是旧海面（例如 11 m 的风暴浪），差分出几十 m/s 的“水流”，船被打转、倒着走。`Ocean.resetSea()` 让在途的回读作废、从头积累。

## 参考

- Hasselmann et al. (1973) JONSWAP；Pierson & Moskowitz (1964)；Shore Protection Manual (1984)
- Donelan, Hamilton & Hui (1985) Directional spectra of wind-generated waves
- Hasselmann, Dunckel & Ewing (1980) Directional wave spectra observed during JONSWAP 1973
- Bouws et al. (1985) TMA spectrum；Young & Verhagen (1996) Lake George 有限水深生长律
- Monahan & O'Muircheartaigh (1980) 白浪覆盖率；Cox & Munk (1954) 海面坡度统计
- Tessendorf (2001) Simulating Ocean Water
- Olano & Baker (2010) LEAN Mapping；Karis (2014) Environment BRDF 近似
- GDC 2019：Wakes, Explosions and Lighting: Interactive Water Simulation in Atlas（海水散射光照模型）
- 破碎判据：Barthelemy et al. (2018) JFM 841, On a unified breaking onset threshold for gravity waves in deep and intermediate depth water（B ≈ 0.85）；Saket et al. (2017) JFM 811；Derakhti, Banner & Kirby (2018/2020) JFM / JGR
- 白浪覆盖率与生命周期：Monahan & Lu (1990) 活跃 / 残留两阶段；Callaghan, de Leeuw, Cohen & O'Dowd (2008) GRL；Brumer et al. (2017) JPO 47, Whitecap coverage dependence on wind and wave statistics；Schwendeman & Thomson (2015) JGR
- 破碎峰线分布：Kleiss & Melville (2010) JPO；Romero (2019) GRL, Distribution of surface wave breaking fronts；Banner, Babanin & Young (2000) JPO 30
- 泡沫光学：Whitlock, Bartlett & Gurganus (1982) GRL；Koepke (1984) Applied Optics 23, Effective reflectance of oceanic whitecaps；Frouin, Schwindling & Deschamps (1996) JGR 101
- 表面膜抑制短波：Alpers & Hühnerfuss (1989) JGR 94
- 飞沫：Veron (2015) Annual Review of Fluid Mechanics 47, Ocean spray；Andreas (1998) JPO；Mostert, Popinet & Deike (2022) JFM 942, High-resolution direct simulation of deep water breaking waves: transition to turbulence, bubbles and droplets production；Gunn & Kinzer (1949) J. Meteor. 终端速度
- 近海面风：Charnock (1955)；Wu (1982) JGR 87 拖曳系数
- 覆盖率的离散：Anguelova & Webster (2006) JGR 111, Whitecap coverage from satellite measurements
- 朗缪尔环流：Leibovich (1983) Annual Review of Fluid Mechanics 15；Thorpe (2004) Annual Review of Fluid Mechanics 36
