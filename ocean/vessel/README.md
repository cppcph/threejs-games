# ocean/vessel · 帆船动力学（六自由度，物理驱动）

一条 8.6 m 单桅帆船的刚体模型：船与浪、帆与风的相互作用都从力的平衡里来 —— 没有写死的极曲线，没有写死的横倾。
物理核心是纯 JS（Node 可跑，不依赖 three.js）；`three-adapter.js` 负责把状态写到画面上的 `extras/Sailboat`。

```
ocean/vessel/
  SailingYacht.js    组装：质量 / 惯性、附加质量、积分器、控制、遥测、事件、辅机、触底接触
  HullShape.js       HullGenerator 型线公式的纯 JS 复刻 + Sailboat 的布置（桅、帆、长龙骨、艉挂舵、舱室）
  HullMesh.js        物理网格：闭合船体（壳 + 艉板 + 甲板 / 舱室）、龙骨板、舵板
  Hydrostatics.js    三角面水压积分（静水力 + Froude–Krylov）、面元摩擦、辐射阻尼、砰击；平衡浮态与 GZ 曲线
  Resistance.js      ITTC-1957 摩擦线、DSYHS 2008 剩余阻力、船型参数
  Foils.js           龙骨 / 舵 / 船体的有限翼展升力模型
  Sails.js           ORC 帆系数、Charnock 风廓线、VPP 式自动调帆
  Autopilot.js       舵机（航向 / 真风角，换舷）
  three-adapter.js   applyToThree、emitSpray、driveWake（唯一 import three 的文件）
  vmath.js interp.js index.js
```

测试：`node --test tests/ocean/vessel.test.mjs`（14 项，约 40 s）。
真实海面上的浏览器检查：`THREE_VENDOR=<three 包目录> node tools/play.cjs tests/ocean/vessel-check.html <输出目录> tests/ocean/vessel-check.cjs --root=.`

## 用法

```js
import { SailingYacht } from './ocean/vessel/index.js';
import { applyToThree, emitSpray, driveWake } from './ocean/vessel/three-adapter.js';
import { Sailboat } from './ocean/extras/Sailboat.js';

const yacht = new SailingYacht();                                   // 选项见 YACHT_DEFAULTS
const boat = new Sailboat({ hull: yacht.hull, sky });               // 画面与物理用同一组型线参数
yacht.reset({ x: 0, z: 0, yaw, speed: 3 });                          // yaw：three.js rotation.y 约定
yacht.setControls({ mode: 'twa', target: 50 * Math.PI / 180, tack: 'port', sheet: 'auto' });

// 每帧
yacht.step(dt, { ocean, wind: { x, z }, ground });   // wind = 10 m 高真风 U10（m/s，指向下风）；ground(x, z) = 地面高度（可省略）；内部 ≥ 120 Hz 子步
applyToThree(yacht, boat, { dt, time, sky });     // 位置、四元数 → boat.group；帆的外观 → boat.applyPhysics
emitSpray(yacht, spray);                          // 砰击 / 飞溅事件 → Spray 粒子
driveWake(yacht, hullWake, dt);                   // 船行波 → WakeMap.createHullEmitter(...)
```

| 成员 | 说明 |
|---|---|
| `setControls({ mode, target, tack, rudder, sheet, flat, reef, heelLimit, motor })` | `mode`：`'twa'`（target = 真风角大小，弧度；tack = `'port'`/`'starboard'`）、`'heading'`（target = yaw）、`'manual'`（rudder，弧度；+ = 后缘偏向左舷 → 向左转）。`sheet`：`'auto'` 或 0 收紧 … 1 放松；`flat` / `reef`：`'auto'` 或 0.5–1 / 0.45–1；`heelLimit`：自动调帆横倾上限（默认 20°）；`motor`：辅机油门 −1（全速倒车）… 1（全速正车），默认 0 |
| `tack()` / `gybe()` / `changeTack()` | 迎风换舷 / 顺风换舷 / 按当前真风角自动选择 |
| `reset({ x, z, yaw, speed, heel, pitch, y })` | 重新放船 |
| `state` | `position`（船体原点 = 水线中心，世界坐标）、`quaternion`、`velocity`（重心）、`angularVelocity`（世界）、`cg` |
| `telemetry` | 见下表 |
| `events` | 本步的砰击 / 飞溅：`{ position, velocity（射流）, normal, speed（入水速度）, area, areaRate, intensity 0–1 }` |
| `ground` | 本步的触底：`{ contact, points（接触点数）, force（法向力合力 N，子步平均）, impact（新接触的入射速度 m/s）, slide（接触处滑动速度）, position, normal }` |
| `wake` | `{ bow, stern, direction, speed, Fn, kelvinAngle, angle（表观半角）, amplitude（m）, strength 0–1 }` |
| `sail` | `{ side, boomAngle, jibSheet, luff, fill, aws, awa, awLocal, rudder }`（给 `Sailboat.applyPhysics`；rudder 让画面上的舵跟着转） |
| `motor` / `contactPoints` / `groundParams` | 辅机参数（见 `MOTOR_DEFAULTS`）、触底接触点（船体坐标，按部件分组）、接触参数（见 `GROUND_DEFAULTS`） |
| `stability(heels)` | 静稳性曲线 `[{ heel, GZ, RM, trim, y }]` |
| `particulars` | 主尺度、质量分布、惯性、附加质量、阻尼、固有周期 |

遥测（`telemetry`）：`speed / speedKn`（对水）、`sog / cog`、`yaw`、`heading`（罗经方位，0 = 北 = −Z）、`leeway`（顺时针为正 = 向右舷横漂）、`heel`（+ = 右舷下沉）、`pitch`（+ = 船首抬起）、`tws / twa`、`aws / awa`（帆受力中心处、横倾后的有效视风；+ = 右舷来风）、`awsMasthead / awaMasthead`、`vmg`、`sailCL / sailCD / flat / reef / sheet / boomAngle`、`driveForce / sideForce`、`heelingMoment / rightingMoment`、`resistance { friction, residuary, induced, appendage, radiation, waves, windage, total }`（船体各力换到世界坐标后取逆着对水航向的水平分量；`waves` 是浪里水压积分的水平分量，即波浪附加阻力，平静水面为 0；`radiation` 是竖直力，恒为 0，只为兼容保留）、`sideForceKeel / Rudder / Hull`、`rudderAngle`、`helm`（+ = 上风舵）、`Fn`、`hullSpeedKn`、`displacement`（瞬时水压竖直力 / g）、`mass`、`wettedArea / wettedAreaHull`、`waterplaneArea`、`motor`（油门，滤波后）/ `thrust`（N）、`grounded / groundForce / groundContacts`。力、力矩、阻力分解做了 τ = 0.5 s 的平滑。

### 接入 examples/ocean/main.js（替换 Buoyancy + 极曲线）

```js
import { SailingYacht } from '../../ocean/vessel/index.js';
import { applyToThree, emitSpray, driveWake } from '../../ocean/vessel/three-adapter.js';

const yacht = new SailingYacht();
const boat = new Sailboat({ hull: yacht.hull, sky, shadows: false });     // 原：new Sailboat({ sky, shadows: false })
// 删掉 const buoy = new Buoyancy(...)、POLAR / polar() / targetSpeed()

// applyShot() 里原来设置 S.boat.yaw / speed 的两行换成：
const side = (p.tack ?? 1) > 0 ? 'starboard' : 'port';                  // 演示的 tack = +1 即右舷受风
const yaw0 = Math.atan2(-w.x, -w.y) + (side === 'starboard' ? 1 : -1) * S.boat.twa;
yacht.reset({ x: 0, z: 0, yaw: yaw0, speed: 3 });
yacht.setControls({ mode: 'twa', target: S.boat.twa, tack: side });

function updateBoat(dt) {
  if (dt > 0) yacht.step(dt, { ocean, wind: { x: windNow.x, z: windNow.y } });   // 瞬时（带阵风）的 U10
  applyToThree(yacht, boat, { dt, time: S.time, sky });
  const st = yacht.state, t = yacht.telemetry;
  S.boat.x = st.position.x; S.boat.z = st.position.z; S.boat.yaw = t.yaw; S.boat.speed = t.speed;   // 机位代码继续用 S.boat
  driveWake(yacht, hullWake, dt);
  wake.update(dt, st.position.x, st.position.z);
  ocean.setWake(wake.texture, wake.rect);
  emitSpray(yacht, spray);                                                 // 代替原来按船首浸深估计的浪花
}
```

`Ocean.sim.ready` 为 false（回读还没到）时 `step` 自动按平静水面算；`ocean.sampleVelocity` 缺失时不用水质点速度。

## 船与帆的物理

### 1. 坐标、状态、积分

船体坐标与 Sailboat 相同：原点在设计水线中心，船首 +Z，左舷 +X，Y 向上；四元数把船体坐标转到世界坐标。
状态 = 重心位置、四元数、重心速度、角速度（世界）。每个子步 h ≤ 1/120 s，半隐式欧拉（先速度后位置），四元数归一化。

**附加质量放在艏向坐标系里**（只随航向转，不随横倾纵倾转；耐波性理论的平衡坐标系）：升沉附加质量沿世界竖直，纵荡 / 横荡沿水平面。

```
M_h·v̇_h = F_h − ψ̇ ŷ × (M_h v_h)          M_h = m + A（横荡、升沉、纵荡），世界加速度 = H (v̇_h + ψ̇ ŷ × v_h)
(I_w + A_w)·ω̇ = τ − ω × (I_w ω)           I_w = R I Rᵀ，A_w = H diag(A纵摇, A偏航, A横摇) Hᵀ
```

转弯时向心项用纵荡质量 m + A11（Fossen 2011 / MMG 操纵方程），否则船会严重侧滑。附加质量固定在船体轴上的话，纵倾时竖直的波浪力会被各向异性的质量“转”成水平加速度，浪里平均下来是虚假的推力；这正是改用艏向坐标系的原因（不规则浪迎风 45°：2.2 kn → 4.7 kn，航向误差均方根 21° → 4°）。Munk 力矩不单列（龙骨、船体升力作用在 1/4 弦点已包含）。附加质量随浸没程度（水压竖直力 / mg）缩放，船跳出水面时自由落体。

### 2. 船体几何与质量

型线就是画面上的 `HullGenerator`（超椭圆剖面放样）。默认参数的 y = 0 设计水线下排水 9.6 t，对 8.6 m 巡航帆船太重，所以物理默认 `YACHT_HULL` 只把船体吃水 `draft` 从 0.92 改为 0.40（其余相同）；画面用同一组参数。长龙骨与艉挂舵照 Sailboat 的轮廓建模（龙骨下缘 −1.36 m）。

**排水量 = 设计水线下的网格体积 × ρ**，各部件取真实质量，剩下的归入内部舾装；压载的纵向位置使 LCG = LCB（设计师正是这样决定龙骨位置的），所以平静水面上船正浮在设计水线。

| 部件 | 质量 kg | 重心 y（m，水线上为正） |
|---|---|---|
| 压载（铅，铸在龙骨下部，36% 排水量） | 1500 | −1.21 |
| 船壳（实心玻璃钢 + 骨架，14 kg/m²，按面元分布） | 478 | +0.14 |
| 甲板与舱室（15 kg/m²，含五金、护栏、绞盘） | 358 | +1.00 |
| 桅杆 33、横杆 9、静索 22、帆与卷帆器 30 | 94 | +4.9（平均） |
| 柴油机与轴系 125、水箱油箱 95、蓄电池 45、锚链 45 | 310 | ≈ 0 |
| 船员 2 人（驾驶舱） | 160 | +1.30 |
| 内部舾装、设备、给养（舱内均匀长方体） | 1267 | +0.30 |
| **合计 = 排水量** | **4167** | **VCG −0.07** |

惯性张量由各部件（含分布质量与自身惯量）对重心合成：纵摇 17 138、偏航 11 521、横摇 7 195 kg·m²（横摇回转半径 1.31 m）。

### 3. 静水力与 Froude–Krylov（Kerner 2015/2016）

物理网格：28 站 × 每舷 8 段围长的船体壳 + 艉板 + 甲板 / 舱室（共用舷弧顶点，严格闭合）+ 龙骨板 + 舵板，约 720 顶点、1300 三角形。每个子步：

1. 每个顶点取其上 / 下方的水面高度 η(x, z)，浸深 d = η − y；三个顶点都在水上的三角形跳过，都在水下的整块计算，**只裁剪跨水线的三角形**（Sutherland–Hodgman，沿边线性插值 d = 0 的点，保持绕序）。必然在水上的顶点（高出上一子步最高水面 + 0.25 m + 相邻最长边）不采样水面。
2. 线性压强的精确积分：`F = −(p₁+p₂+p₃)/3 · S`，`M = −(1/12)[(Σp)(Σρᵢ) + Σpᵢρᵢ] × S`（ρᵢ 为顶点到重心）。闭合网格在静水中 ΣF 严格等于 ρg∇（测试：完全浸没体积与网格体积一致到 10⁻¹²），浮心、复原力矩全由几何决定。
3. 压强 `p = ρg [η·e^{k(y−η)} − y]`：线性 Airy 动压按 e^{ky} 衰减（Smith 效应），Wheeler 拉伸到瞬时水面；k 取主波波数（`env.waveNumber`，或由 `ocean.model.readout` 的谱峰周期算），k → 0 即 Kerner 的 ρg(η − y)。

比船长的浪把船抬起、倾侧，比船短的浪在船长上平均掉 —— 积分本身的结果。静稳性曲线由同一积分加固定横倾下的升沉 / 纵倾牛顿迭代得到。

### 4. 附加质量与辐射阻尼

切片理论（每个横剖面二维高频附加质量，沿船长积分）：

| 运动 | 二维剖面 | 三维修正 | 值 |
|---|---|---|---|
| 升沉 A33 / 纵摇 A55 | ρπB²/8（半圆等效 Lewis 剖面） | 0.75（L/B ≈ 3.7） | 7 719 kg / 23 459 kg·m² |
| 横荡 A22 / 偏航 A66 | ρπT²/2（平板 + 水面镜像，T 含龙骨） | 0.7（龙骨长深比 ≈ 1.6，Brennen 1982） | 9 034 kg / 17 470 kg·m² |
| 横摇 A44（绕水线） | ρπT⁴/16（Newman 1977） | — | 2 762 kg·m² |
| 舵 | 弦向平板 ρ(π/4)c²b·0.85 | — | 计入横荡、偏航 |
| 纵荡 A11 | 5% 质量 | — | 208 kg |

辐射阻尼：浸水面元上只按**竖直相对速度**施加竖直力 `dF_y = −ρ c_rad e^{k_r y}(v_rel,y n_y) n_y dA`（相对速度扣除水质点速度，随长浪起伏时不受阻尼）。唯一的标定量 c_rad = 1.28 m/s 由升沉阻尼比 ζ = 0.15 定出（宽浅船体 Lewis 剖面在共振附近的典型值），k_r = ω_heave²/g；纵摇、横摇阻尼由同一面元分布自然得到。低速横摇、偏航的二次阻尼来自翼型的分离流横流阻力。

| 固有周期 | 估计 | 仿真（自由衰减） |
|---|---|---|
| 升沉 2π√((m + A33)/ρgA_w) | 1.85 s | 1.88 s，ζ ≈ 0.15 |
| 横摇 2π√((I + A44)/(Δ g GM)) | 3.41 s | 3.42 s，ζ ≈ 0.11（10° 起摇） |
| 纵摇 2π√((I + A55)/(Δ g GM_L)) | 1.71 s | — |

### 5. 阻力

- **摩擦（ITTC-1957）**：`C_F = 0.075/(log₁₀Re − 2)²`，Re = V·0.7L_WL/ν（ν = 1.19×10⁻⁶），形状因子 1 + k = 1.05（ORC VPP）。在每块浸水船体壳面元上按切向相对流速施加 `dF = −½ρ C_F(1+k)|v_t| v_t dA`，横倾、纵倾、浪里的湿面积变化与不对称都自动进入（湿面积 15.4 m²，DSYHS 公式 15.3 m²）。
- **剩余阻力（DSYHS，Keuning & Katgert 2008）**：
  `Rr/(ρg∇c) = a₀ + (∇c^{1/3}/L_WL)(a₁·LCB_fpp/L_WL + a₂·Cp + a₃·∇c^{2/3}/A_w + a₄·B_WL/L_WL + a₅·LCB_fpp/LCF_fpp + a₆·B_WL/Tc + a₇·Cm)`，
  Fn = 0.15 … 0.75（系数表见 `Resistance.js`，转引自 Fossati 2009 表 2.5）。船型参数由型线精确积分：L/∇^{1/3} = 5.69、B/T = 5.73、Cp = 0.585、Cm = 0.745，都在回归范围内。作用在瞬时水线面形心、方向与相对水流相反，按瞬时排水量缩放。横倾 > 30° 乘 ORC 舷边入水系数 1 + 0.0004(φ − 30°)²；Fn > 0.75（大浪冲浪）按 ∝ Fn² 外推。
  | Fn | 0.25 | 0.30 | 0.35 | 0.40 | 0.45 | 0.50 |
  |---|---|---|---|---|---|---|
  | Rr/(ρg∇) | 0.0012 | 0.0032 | 0.0067 | 0.0162 | 0.0358 | 0.0583 |
  Fn ≈ 0.4 以上陡增：船速饱和在船体速度附近（L_WL = 8.58 m，Fn 0.4 = 7.13 kn）。
- **受风**：船体 ORC 公式 A = fbav·((1−d)B + dL)，d = ½(1 − cos2β)，C_D = 0.816；桅杆与静索 1.8 m²，C_D = 1。
- **波浪附加阻力**：没有单独的公式，来自浪里的水压积分（第 3 节）：船首、船尾、两舷的瞬时湿面积随相对波面变化，水平合力的均值不为零（遥测 `resistance.waves`）。真风 14 kn、真风角 52°、自动舵：Hs 0.37 m / Tp 2.5 s 的短浪（λ ≈ 1.1 L）里沿航向 ≈ 240 N、向下风 ≈ 200 N，船速 6.49 → 5.36 kn；顶风滑行（5 kn 起、帆抖）12 s 后平静水面还有 2.8 kn，Hs 1.15 m / 5.4 s 顶浪里只剩 0.5–1.1 kn（平均附加阻力约 450 N）。按 Gerritsma & Beukelman (1972) 的无量纲化 σ_aw = R_aw / (ρg·2σ²·B²/L)（σ² 为波面方差，B 取水线宽 ≈ 2.6 m）：短浪 ≈ 1.8，长顶浪低速 ≈ 0.3；船舶在 λ ≈ L 的规则顶浪里 σ_aw 峰值通常有几到十，所以量级合理。浪里迎风换舷要带着速度。**不传 `waveNumber`、海面又没有 `model.readout` 时 k = 0**（动压不随深度衰减），同样的浪里阻力约大一倍（上例 5.36 → 4.09 kn）；自己写的海面请传谱峰波数。

### 6. 龙骨、舵、船体升力

升力线斜率用 Helmbold (1942) `C_Lα = 2πA/(2 + √(A² + 4))`：A ≳ 3 时与 Prandtl 升力线 2πA/(A + 2) 相差 < 10%（舵），A → 0 时趋于 Jones 细长翼 πA/2（长龙骨、船体）。有效展弦比：龙骨贴船底，船体作端板 A_e = 0.9·2b²/S；艉挂舵穿出水面，低 Fn 时自由面作端板 A_e = 0.8·2b²/S；船体本身是展长 = 吃水、面积 = 侧投影的升力体 A_e = 2T²/S。

| | 面积 m² | A_e | C_Lα /rad | 失速 |
|---|---|---|---|---|
| 长龙骨 | 4.35 | 0.45 | 0.70 | 24° |
| 艉挂舵 | 0.44 | 3.8 | 3.79 | 14.4° |
| 船体 | 2.59 | 0.12 | 0.19 | 35° |

失速角 14° + 16°·e^{−A_e}，之后在 10° 内过渡到平板法向力模型 C_N = C_D90 sin α（全 360° 有定义：零速横漂、倒车时变成横流阻力）。阻力 `C_D = 2C_F(Re_c)(1 + 2t/c + 60(t/c)⁴) + C_L²/(π e A_e)`（Hoerner 形状因子，e = 0.9）。舵处入流减去龙骨下洗 ε = C_L,keel/(πA_e,keel)。来流取在 1/4 弦点，含 v + ω × r 与水质点轨道速度（按 e^{ky} 衰减），所以横摇时龙骨产生阻尼力、偏航时舵产生阻尼力矩、浪里攻角随轨道速度变化。漂角与侧力是力平衡的结果；上风舵 / 下风舵来自受力中心（主帆随横杆转动）与横向阻力中心的偏差。

### 7. 风与帆

- **风廓线**：近中性表面层 `U(z) = (u*/κ) ln(z/z₀)`，Charnock (1955) `z₀ = α u*²/g + 0.11ν/u*`（α = 0.0144，Smith 1988 光滑流项），由 U10 迭代求 u*（等价于 u*² = C_D U10²；10 m/s 时 C_D = 1.37×10⁻³，U(5 m) = 0.94 U10）。
- **视风**：在每面帆的受力中心处 = 该高度的真风 − (v + ω × r)；换到船体坐标后去掉沿桅分量，即横倾的有效视风角 tan β_eff = tan β cos φ 与动压 cos² 修正。横摇、纵摇让视风周期性变化。
- **帆系数**：ORC VPP 的主帆、前帆 C_L(β)、C_D(β) 表（默认 “low” 组 = IMS/Hazen 系数，Larsson & Eliasson 所列；“high” 为高性能帆），单调三次插值：
  `C_L = ΣC_Li A_i/A`，`C_E = ΣC_Li² A_i k_pi/(A C_L²) + A/(π h_eff²)`，`C_D = C_Dp(flat·f(flat)·f_j + 1 − f_j) + C_E C_L² flat² f(flat)`，`C_L ← flat·C_L`；
  有效高度 `h_eff = (b + HBI)·c_span·k_heff(β)`（ORC：b = 10.35 m，HBI = 0.80 m，c_span = 1.037，k_heff 在 β ≈ 18° 时 1.22、≥ 75° 时 0.80）。
  帆面按 Sailboat 的画面几何积分：主帆 19.9 m²（P 9.0、E 3.93、roach 0.13，受力中心离水 5.35 m），前帆 10.3 m²（I 8.3、J 3.24、LPG 2.44，4.07 m）。每面帆用自己受力中心处的视风、在自己的受力中心受力（升力 ⊥ 视风指向下风且偏前，阻力沿视风）。reef 按比例缩小帆面（面积 r²、高度 r），flat 降低升力与诱导阻力，压平时按 ORC twist 函数降低受力中心。
- **帆脚索**：系数表对应最佳调帆；自动模式取最佳横杆角（与画面相同的公式）。手动 sheet 偏离最佳角：放太松 → 升力线性消失、剩抖帆阻力；收太紧 → 升力下降、阻力 + 0.9 sin²Δ。

### 8. 自动调帆（VPP 式）

每 0.25 s：用滤波后的直立视风（τ = 2 s），枚举 flat ∈ [0.5, 1] × reef ∈ [0.45, 1]，在横倾上限 φ_max 处计算驱动力与横倾力矩（cos φ 投影的视风、受力中心高度 + 横向阻力中心深度 0.66 m），在 `HM ≤ RM(φ_max)`（RM 取本船静稳性曲线）的组合中选驱动力最大者；flat 以 1.5 s、reef 以 6 s 的时间常数跟随。实测横倾反馈：6 s 均方根横倾超过上限时，慢慢降低给优化器的上限（浪和阵风里动态横倾大于静态预测，就像水手多缩一点帆）。

### 9. 舵机

串级：航向误差 → 期望偏航角速度 r* = clamp(0.6·s·e, ±6°/s·s)（换舷 7°/s，s = V/2.5 m/s ∈ [0.3, 1]）→ 舵角 = (V_ref/V)²·4.5·(r* − r) + 积分；舵角 ±30°、15°/s。换舷强制转向方向（迎风穿过风眼、顺风穿过正顺风），帆随视风侧自动换边，横杆在画面里弹簧阻尼地甩过去。

### 10. 砰击、飞溅、尾迹（给画面用）

- 跨水线、竖直方向正在压入水中的面元附加 `p_s = ½ρ C_s v_n²`（C_s = 1，竖直力）。上一子步完全在水上、这一子步入水且 v_n > 0.8 m/s 的面元记为事件，按 船首 / 中 / 尾 × 左 / 右 六区以 v_n²A 加权汇总：位置、法线、入水速度；射流速度 = 该点速度 + 2·v_n·（沿船壳向外向上的切向），即 Wagner (1932) 理论中溅射根部射流约为入水速度的 2 倍；强度 = v_n² × 新浸湿面积速率 / 8。
- 尾迹：Kelvin 角 asin(1/3) = 19.47°；Fn ≳ 0.6 时船长限制了最长的波（k ≥ 2π/L），表观半角 `sin α = c_g(2π/L)/U = 1/(2√(2π)·Fn)`，随 Fn⁻¹ 变窄（Rabaud & Moisy 2013，Fn 1 时 11.5°）。波幅由兴波阻力的能量通量估计 `A = √(4R_w/(ρ g L))`。

### 11. 辅机（`controls.motor`）

舷内柴油机 + 两叶定距桨（`MOTOR_DEFAULTS`）。定转速下桨的推力系数 K_T 随进速系数 J 近似线性下降：

```
T = T₀ · (m² − m·V_a / V_p)，V_a = (1 − w)·桨处对水轴向速度          （m：油门 0…1，T₀ = 1200 N 系柱推力，V_p = 4.6 m/s，w = 0.15）
倒车：T = −0.4·T₀ · (m² − m·V_a / (0.8·V_p))（m < 0；两叶定距桨倒车效率低）
```

推力沿船体纵轴作用在桨轴上（站位 0.14、船底下 0.25 m），所以加油门时船首略抬；油门按 0.5 s 时间常数跟随。
正车时桨后的滑流冲到艉挂舵上（动量理论：远场增速 √(V_a² + 2T/(ρA)) − V_a，舵处取 0.8 倍、舵面 30% 在滑流里，按动压加权），
漂着几乎不动时也有舵效 —— 靠港、脱浅都靠它。`dragArea` > 0 时停机的桨按 ½ρC_DA·V² 产生阻力（默认 0 = 折叠桨，
与没有辅机时逐位相同）。

### 12. 触底（`step(dt, { ground })`）

`ground(x, z)` 返回地面高度（m，水下为负；也可以传带 `heightAt` 的对象）。接触点 76 个，都在画面船体的轮廓上：
长龙骨下缘与前后缘 17 个、舵下半部 8 个、船体 51 个（中线龙骨线、两舷舭部与舷弧、船首柱）。

- 每个点在地面以下时：沿地形法线（中心差分）的弹簧 `k·d_s·tanh(d·n_y / d_s)`（压入深度饱和，d_s = 0.5 m）+ 阻尼，只推不拉；
  切向正则化库仑摩擦 `−μF_n·v_t / √(v_t² + v_ε²)`（μ = 0.45，v_ε = 0.1 m/s）。力换到船体坐标，与水动力、帆力一起积分。
- 刚度按部件总量（龙骨 3 MN/m、舵 0.2 MN/m、船体 4 MN/m）平均分到各点：整条龙骨贴底时刚度正好是给定值，单点触底时更软；
  阻尼按单点阻尼比 0.7（等效质量取半船质量）。
- 稳定性：显式积分的阻尼与摩擦相当于粘性系数 c，c·h/m 超过 2 就发散。按上一子步的接触点数把每点的 c 限制在
  0.5·m/(n·h) 以内；弹簧力合力不超过 3 倍船重（瞬移进地形时按比例缩小，船被慢慢推出来而不是弹飞）。
- 粗检：每步开始时所有接触点离地都超过 1 m（加本步可能的位移）就整步跳过 —— 深水里没有任何额外开销，结果与不给 `ground` 逐位相同。

冲上沙坡时龙骨先吃进沙里，船首抬起、船停住，风压下会倒向一舷躺在龙骨上（真实的长龙骨船搁浅就是这样）；撞上陡岸时弹回很小。

### 13. 验证

| 项目 | 结果 | 标准 / 参考 |
|---|---|---|
| 型线与 HullGenerator 一致 | 最大偏差 0（加载钩子导入 Sailboat.js 逐点比较；浏览器里同样为 0） | 逐点相同 |
| 网格闭合 | ∮n dA < 10⁻¹²；水下船体体积与型线积分差 < 3%；湿面积与 DSYHS 公式差 0.6% | — |
| 平静水面浮态 | 从 +0.15 m、横倾 6°、纵倾 2° 释放，40 s 后水线原点 \|y\| < 1 mm，横倾 / 纵倾 < 0.1° | 吃水误差 < 2 cm |
| 排水量 = 质量 | 4167.0 / 4167.0 kg | 误差 < 0.5% |
| 静稳性 | GM 0.83 m；GZ(30°) 0.39、GZ(50°) 0.52、最大 0.62 m @ 75°；稳性消失角 139° | 最大值 50–70°（见局限 6），AVS > 110° |
| 迎风（平静水面，6 / 10 / 16 kn 真风） | 最佳 VMG 角 40° / 40° / 35°，VMG 2.09 / 3.31 / 4.30 kn；漂角 5.2 / 5.4 / 6.9°；横倾 4 / 11 / 19°（16 kn 自动压平 flat 0.85） | Evasion 28：47.2 / 44.9 / 45.8°，VMG 2.39 / 3.21 / 3.84 kn |
| 过于贴风 | 10 kn：25° 时 3.4 kn（VMG 比最佳低 15%），30° 时 3.9 kn | 船速与 VMG 明显下降 |
| 船速饱和 | 16 kn 真风最高 7.19 kn，Fn 0.403 | 船体速度 7.13 kn（Fn 0.4） |
| 升沉 / 横摇固有周期 | 1.88 s / 3.42 s，振荡衰减 | 1.5–3 s / 3–5 s |
| 迎浪升沉 RAO | λ/L = 17 → 1.02；1 → 0.35；0.29 → 0.05 | → 1 / → 小 |
| 迎风换舷（10 kn） | 23.5 s 完成，最低 2.3 kn，70 s 后回到原速的 98%，冲过头 1.4° | 完成并重新加速 |
| 不规则浪（17.5 kn 风，Hs 1.9 m 风浪 + 1.2 m 涌） | 真风角 45°：4.7 kn（航向误差均方根 3.9°）；60°：5.9 kn（4.5°）；120°：7.0 kn（1.3°） | — |
| 真实 Ocean（浏览器，Hs 2.2 m，真风角 60°） | 平均 5.9 kn，航向误差均方根 4.6°，水线相对船下平均水面 +6 ± 12 cm，30 s 内 249 次砰击事件 | — |
| 辅机（平静水面） | 全速正车 5.78 kn（推力 541 N = 阻力 540 N，Fn 0.32）；全速倒车 −3.8 kn；漂流（0.3 m/s）满舵 0.4°/s，开正车 6 s 后 13.6°/s（滑流舵效） | 8.6 m 巡航帆船配 10 kW 机：5–6 kn |
| 触底 | 6.3 kn 冲上 1:4 沙坡：5 s 内停住（< 0.3 m/s），压入 8 cm，没冲上干岸；3.65 m/s 撞 3:1 陡岸：弹回 0.65 m/s、压入 28 cm；龙骨埋进地下 3.4 m 被推出时最大速度 < 4 m/s；深水（−36 m）与不给地形逐位相同 | 停住、不发散 |
| 性能 | 每个 1/120 s 步 0.13–0.17 ms（规则波含水速采样、遥测）；平静水面子步约 0.09 ms | ≪ 1 ms |

**极曲线对比**（平静水面，船速 kn）。参考：ORC 俱乐部证书 Beneteau Evasion 28（GRE 1505，非球帆：LOA 8.50 m、B 2.73 m、T 1.25 m、Δ 4204 kg、帆面积 36.8 m²；数据取自开源 ORC 证书库 jieter/orc-data）。本船帆面积小 18%（30.2 m²，轻风慢 10–20%），水线长（8.58 m 无悬伸，强风快 5–15%）：

| 真风角 | 52° | 60° | 75° | 90° | 120° | 150° | 180° |
|---|---|---|---|---|---|---|---|
| 6 kn：本模型 / ORC | 3.33 / 3.80 | 3.48 / 4.10 | — / 4.30 | 3.55 / 4.27 | 3.01 / 3.74 | 2.58 / 2.85 | 2.40 |
| 10 kn | 5.25 / 4.99 | 5.45 / 5.34 | 5.63 / 5.63 | 5.57 / 5.67 | 4.83 / 5.25 | 4.19 / 4.39 | 3.91 |
| 16 kn | 6.71 / 5.88 | 6.95 / 6.11 | — / 6.31 | 7.19 / 6.46 | 6.71 / 6.34 | 6.18 / 5.94 | 5.87 |

## 已知局限

1. 波浪力只有 Froude–Krylov（未扰动入射波压强），没有绕射 / 辐射波场：平均二阶漂移力不是按理论算的 —— 无风时船在涌浪里会以 0.1–0.6 kn 缓慢漂移（有风航行时这部分只占驱动力的几个百分点）；迎浪附加阻力只部分体现。曾试加绕射力 A·a_w，但水质点加速度只能由逐帧水速差分得到，相位滞后在短陡浪里变成负阻尼，已去掉。
2. 附加质量取高频极限常数，辐射阻尼为一个标定常数的线性模型（不随频率变化）；没有航速引起的下沉 / 纵倾，没有滑行。
3. 帆是准定常的：没有帆的惯性与扭转动力学；两面帆总在同一舷（没有蝴蝶帆、球帆）。
4. 舵机不会像人那样在浪里“放宽角度保速度”或反压前帆：在 λ ≈ 2L、H/λ > 1/20 的短陡浪里以 ≤ 50° 真风角贴风时，可能被浪打到迎风停住；43 kn 暴风（演示的 storm 镜头）里会横甩（broach）、被打倒 50–70°。
5. 最佳迎风角 35–40°，比 ORC 参考船（45–47°）贴风：本船水线长、龙骨 + 船体的升阻比好；ORC VPP 对诱导阻力的横倾 / 非定常放大系数是经验修正，没有采用。
6. GZ 最大值在 75°（平台从 50° 开始），比常见现代巡航船（55–65°）晚：画面船体舷侧外飘、船首舷弧高、舱室宽，压载又很低（VCG −0.07 m）—— 这是这条船型的结果，接近老式长龙骨重型巡航船。
7. 风速不随高度转向（无 Ekman 偏转）；阵风只来自输入的 U10。
8. 真实 Ocean 的高度 / 水速来自 GPU 回读：延迟 1–2 帧、不含最细一级（< 约 2.5 m 的浪），对 8.6 m 的船没有影响；回读停滞多帧时（例如页面不让出事件循环）船会被“颠”。

## 参考

- J. Kerner, *Water interaction model for boats in video games*, Gamasutra 2015（第 1 部分：水压积分）/ 2016（第 2 部分：粘性阻力、压力阻力、砰击）
- ITTC (1957) 模型–实船相关线；S. F. Hoerner, *Fluid-Dynamic Drag* (1965)
- J. Gerritsma & W. Beukelman (1972) *Analysis of the resistance increase in waves of a fast cargo ship*, International Shipbuilding Progress 19（附加阻力的无量纲化与量级）
- J. A. Keuning & M. Katgert (2008) *A bare hull resistance prediction method derived from the results of the DSYHS extended to higher speeds*；Keuning & Sonnenberg (1998)；F. Fossati, *Aero-Hydrodynamics and the Performance of Sailing Yachts* (2009)
- ORC VPP Documentation（帆系数、k_heff、f(flat)、twist、舷边入水修正、受风）；G. Hazen (1980)；L. Larsson & R. Eliasson, *Principles of Yacht Design*
- H. Helmbold (1942)；R. T. Jones (1946)；Prandtl 升力线
- H. Charnock (1955) *Wind stress on a water surface*；S. D. Smith (1988)；W. G. Large & S. Pond (1981)
- F. M. Lewis (1929)；J. N. Newman, *Marine Hydrodynamics* (1977)；C. E. Brennen (1982) *A review of added mass and fluid inertial forces*
- T. I. Fossen, *Handbook of Marine Craft Hydrodynamics and Motion Control* (2011)；Yasukawa & Yoshimura (2015) MMG 标准方法
- H. Wagner (1932) 入水砰击理论
- W. Thomson (Lord Kelvin, 1887)；M. Rabaud & F. Moisy (2013) *Ship wakes: Kelvin or Mach angle?* PRL 110, 214503
- ORC 证书数据：github.com/jieter/orc-data（Beneteau Evasion 28，GRE 1505）
