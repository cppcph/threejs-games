# 信风 Windpost · 水体与船只渲染说明

`index.html` 里 `<script type="module">` 的前半部分是可复用的渲染模块，后半部分是游戏逻辑。
依赖只有 three.js r170（jsDelivr importmap）及其自带的 `Sky.js`、后期通道、`RoundedBoxGeometry`、`mergeGeometries`。
贴图和声音全部由代码生成，没有外部资源文件。脚本按编号分段，在 `index.html` 里搜下表“源码段落”一列的标题（如 `// 5. OceanMaterial`）即可定位。

| 模块 | 作用 | 源码段落 |
|---|---|---|
| `OceanWaves` | Gerstner 波谱，GPU 与 CPU 用同一套参数 | `1. OceanWaves` |
| `IslandField` | 岛屿高度函数 + 烘焙水深纹理 | `2. IslandField` |
| 程序纹理 | 细节法线、泡沫/噪声/闪点/焦散、云噪声 | `3. 程序纹理` |
| `buildOceanGeometry` | 以相机为中心的 LOD 网格 + 地平线裙边 | `4. 海面网格` |
| `createOceanMaterial` | 海面着色器 | `5. OceanMaterial` |
| `WakeMap` | 世界对齐的尾迹图（乒乓渲染目标） | `6. WakeMap` |
| `SkyEnv` / `patchFog` | 天空、云、星月、天空立方体、PMREM、统一雾 | `7. SkyEnv` |
| `PlanarReflection` | 斜近裁剪面的镜像相机 | `8. PlanarReflection` |
| `HullGenerator` / `Buoyancy` / `createBoat` / `Spray` | 船体放样、浮力、帆、浪花 | `9`–`11` |

## 1. 波浪：OceanWaves
- 14 个 Gerstner 波。波长从 `lmax`（海况 0→1 对应 24→105 m）按几何级数降到 0.85 m；方向围绕风向，短波更分散。
- 振幅 = 坡度 / k，长波坡度略大（类 JONSWAP 峰值）；色散 ω = √(g·k)。
- 水平挤压 `Q` 按“陡度预算”平均分配：Σ Q·k·A = `steepness` ≤ 1。波峰变尖，但不会打结。
- 每个波在距网格中心 `0.5·fade ~ fade`（`fade = λ × fadeScale`）之间淡出，网格变稀后不再采样它。
- **CPU 与 GPU 一致**：`heightAt(x,z)` 用 3 次不动点迭代反解 `p0 + D(p0) = (x,z)`，再取 `D(p0).y`。
  浅水消波读的是同一张半精度水深纹理（同样的纹素中心双线性插值），淡出用同一个网格中心。
- 相位 `φ − ωt` 在 JS 里用双精度取模后再传 GPU，长时间运行也不会因 float32 精度抖动。

## 2. 海面网格
- 张量积网格：中间约 28 m 是 0.5 m 等距细格（低画质 1 m），往外每格放大 7%（低画质 14%），铺到 14 km。高画质约 11 万顶点。
- 网格中心吸附到细格间距的整数倍，近处顶点固定在世界坐标上，不会“游泳”。
- **海天线无接缝**：外圈顶点在顶点着色器里抬到相机高度附近（`uSkirtR`），正好盖住地平线；
  雾的颜色取“视线方向在地平线上的天空色”（从天空立方体采样），外圈强制全雾，海和天在远处是同一个颜色。

## 3. 海面着色（OceanMaterial，片元内顺序）
1. **逐像素解析法线**：用插值后的 `p0` 重新累加全部波的法线和雅可比，粗网格也有清楚的浪形。
   每个波按像素覆盖面积 `foot = max(|dFdx(p0)|, |dFdy(p0)|)` 淡出，淡掉的坡度方差记入 `lostVar` 并加进 GGX 粗糙度
   （类似 Toksvig / LEAN）。远处海面不闪，太阳倒影自然展开成一条光柱。
2. **细节法线**：3 层不同尺度、旋转和速度的可平铺法线（7.3 m / 17.9 m / 47 m），由整数波矢的正弦和生成，天然无缝；
   mip 平均后法线变短的部分同样计入粗糙度。
3. **菲涅尔与反射**：Schlick（F0 = 0.02）。被淡掉的小浪仍然存在，所以按坡度方差把平均法线朝视线倾一点再算菲涅尔
   （`Nf`），远处海面不会变成一面白镜子，海天线有明暗对比。天空立方体按粗糙度选 mip；高画质再混合平面反射（船、岛的倒影，UV 按法线扰动）。
4. **高光**：GGX，HDR 上限 90，交给 bloom 形成碎金闪光。日落后主光源换成月亮，高光强度另乘 5 倍。
5. **水体**：深/浅散射色 × 天光（立方体最高级 mip 当作天空平均亮度）；水深小于 22 m 时用分通道吸收 `uAbsorb`
   （红光衰减最快）透出沙底，沙底叠两层滚动焦散，取二者最小值形成网状亮纹。
6. **浪尖透光（SSS）**：视线背着太阳、浪尖够高（薄）时才加青绿透光，700 m 外淡出，避免整片海发绿。
7. **泡沫**：雅可比 J 低于 `uFoamJ` 的挤压区（只统计波长 > 2.5 m 的波，白浪成片而不是碎点）+ 岸线泡沫带
   （按水深移动的正弦带）+ 尾迹；用 Worley 细胞纹 + 气泡 + FBM 打散。
8. **夜光藻**：尾迹和浪尖的泡沫在夜里发蓝光，再乘一层泡沫纹和随机闪点。
9. **大气透视**：`1 − exp(−density·dist)`，颜色取地平线天空色。

渲染面板（T）里的“调试视图”可以看法线、泡沫遮罩、尾迹图、水深、菲涅尔和线框。

## 4. 尾迹：WakeMap
- 512² 半精度渲染目标覆盖船周围 256 m（0.5 m/纹素）。中心跟随船并吸附到纹素，用 UV 偏移把上一帧内容搬过去，尾迹固定在世界里。
- 每帧：衰减（R 半衰期 5 s、G 0.4 s）+ 按时间计算的扩散 → 用实例化软圆片“盖章”（ONE/ONE 混合）。
  - R：船尾湍流泡沫。沿上一帧到这一帧的船尾线段盖一个拉长的章，按覆盖率缩放，帧率不同累积量一致。
  - G：船行波脊。船首两侧每秒发射约 22 个粒子，以 `0.354·v`（tan 19.47°）横向散开，
    它们此刻的位置连成开尔文 V 形波臂；G 衰减快，只留下“当前”的波臂。
- 海面着色器：R → 泡沫和夜光，G 的梯度 → 法线扰动。
- 复用：每帧调用 `wake.stamp(x, z, 半长, 半宽, 角度, R, G)`，再 `wake.update(renderer, dt, cx, cz)`，
  把 `wake.texture` 和 `wake.center` 传给你的水面着色器。

## 5. 天空与环境：SkyEnv
- `Sky.js`（Preetham）按时刻给太阳方向；太阳低时调高浑浊度、瑞利系数，晚霞更暖。补丁加入夜空渐变、月晕、风暴变灰和 `uSunDisk` 开关。
- 天空立方体（高画质 256²，带 mip）只画天空层（`SKY_LAYER`：天空 + 云），**不画日面**，太阳倒影交给解析高光，避免出现两个太阳。
  太阳移动或每 0.4 s 更新；PMREM 每 2.5 s（或太阳明显移动）更新一次，作为 `scene.environment`。
- 云：天穹上把视线投影到云层平面，采样可平铺 FBM，朝太阳方向再采一次做自阴影，颜色直接用太阳色。
- 太阳光色：Kasten–Young 大气质量 × 分通道消光，太阳越低越红。
- `patchFog(material, shared)`：给任何 `MeshStandardMaterial` 换上和海面相同的雾。

## 6. 船：HullGenerator / Buoyancy
- 放样：沿船长 57 个站位，每个截面是超椭圆下半 `|x/b|^e + |y/h|^e = 1`。参数：`length` `beam` `draft` `freeboard`
  `sheerRise`（船首抬高）`transom`（艉板宽比例）`maxBeamAt` `entry`（船首收窄指数）`bilge`（e：小 → V 形底，大 → 圆舭）`flare`（舷侧外飘）。
  输出船体、艉板、甲板三个 `BufferGeometry`；船体带 `aSheer` 属性，漆色在片元里按局部高度分区（防污红、水线带、舷侧、金线）。
- 浮力：8 个水线采样点，每点 `F = k·(水面高 − 点高)`，求升沉力、纵摇力矩 `−z·F`、横摇力矩 `x·F`，弹簧阻尼积分。
  风压倾侧以“目标倾角 × 横摇刚度”的力矩加入，所以静水里正好停在目标倾角。浮标用同一个类（4 个点，刚度更大）。
- 帆：CPU 每帧生成网格（主帆 15×19、前帆 11×15），鼓风深度、顶部扭转、失速抖动都是解析式；着色器做背光透射。

## 7. 搬到别的项目
```js
const waves = new OceanWaves({ seaState: 0.3, steepness: 0.72, windDir: 2.8, fadeScale: 12 });
const ocean = new THREE.Mesh(buildOceanGeometry('high'), createOceanMaterial({ detail, foam }));
ocean.frustumCulled = false;
// 每帧
waves.setTime(t);
const snap = ocean.geometry.userData.snap * 2;
waves.center.set(Math.round(cam.x / snap) * snap, Math.round(cam.z / snap) * snap);
waves.bindUniforms(ocean.material.uniforms);
const y = waves.heightAt(x, z);   // 浮力、相机、漂浮物都用它
```
必须提供的 uniform：`uSkyCube`（任意 HDR 立方体贴图）、`uBathy` + `uBathyRect`（没有岛就给一张 −40 m 的 1×1 纹理）、
`uWake` + `uWakeRect`（不用尾迹就给全黑纹理）、`uSunDir` / `uSunColor`。材质末尾已包含 tonemapping 与 colorspace，
可直接渲染，也可以接 EffectComposer（推荐，配合 bloom）。

## 8. 性能
| 项 | 高画质 | 低画质（触屏默认） |
|---|---|---|
| 海面网格 | 0.5 m 细格，增长 7%，约 11 万顶点 | 1 m 细格，增长 14%，约 3 万顶点 |
| 波淡出 | 6λ~12λ | 3λ~6λ |
| 平面反射 | 半分辨率 | 关 |
| 阴影 / MSAA / 像素比 | 2048² / 4× / ≤1.5 | 关 / 无 / 1 |
| 天空立方体 | 256² | 128² |
- 片元着色器是主要开销（14 个波 × sin/cos + 3 次细节采样 + 立方体 + 尾迹 5 次采样）。手机上可把波数降到 10、去掉第三层细节。
- 岛和船先画，海面 `renderOrder = 1` 最后画，被遮挡的海面像素由 early-z 剔除。
- 典型绘制调用 110–130 次（含平面反射那一遍）。

## 9. 踩过的坑（做水体时值得先看）
1. **半精度溢出 → 大片黑块**：Preetham 的日面亮度远超半精度上限 65504，写进 HalfFloat 目标变成 Inf，经 bloom 模糊扩散成 NaN。天空输出限幅到 40，海面输出限幅并过滤 NaN。
2. **three.js 的 AdditiveBlending 会乘源 alpha**（SRC_ALPHA, ONE）。往累积贴图里“盖章”要用 CustomBlending ONE/ONE。
3. **浮力必须采样和着色器完全相同的波**：淡出、浅水消波、相位都要一致，否则船会浮在空中或陷进水里。
4. **按帧盖章要和帧率无关**：速率型的章乘 `dt`，线段型的章按覆盖率缩放；扩散量也按时间计算。
5. **远处海面发白**：抗锯齿把小浪淡掉后法线变平，菲涅尔趋近 1。要用坡度方差倾斜法线（或用 LEAN/Toksvig）来补偿。
6. **细节法线要可平铺、每层旋转不同角度**，否则一眼能看出重复。
7. **太阳不要在反射立方体里再画一次**，否则水面会出现两个太阳倒影。

## 10. 可以继续做的
- 用 FFT（Tessendorf）替换 Gerstner；物理端保留一组低频 Gerstner，或读回位移贴图。
- 岸线泡沫和浅水改成基于深度缓冲（适合任意地形网格），代价是一次深度预渲染。
- 船舱内的水体遮罩（模板缓冲），大浪时避免海面画进船舱。
- 水下视角：水下雾、焦散投射到船底、从水下看水面的全反射。
