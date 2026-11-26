# 实拍对照

把海面、白浪、帆船动力学放到实拍素材能对上的条件里渲染或计算，与实拍逐项比较。实拍素材都来自 Wikimedia Commons（公有领域或知识共享许可），不放进仓库，用 `tools/fetch_footage.py` 下载。

| 文件 | 内容 |
|---|---|
| `beaufort.html` + `beaufort-scn.cjs` | 蒲福风级对照：按各级中值风速充分发展，相机 14 m 高（船桥）迎风看海，输出图像与读数（Hs、白浪覆盖率等） |
| `surf.html` + `surf-scn.cjs` | 岸边碎浪：1:40 平直沙滩、涌浪（Hs 0.9 m、Tp 9 s）+ 7 m/s 向岸风，相机站在沙滩上 |
| `boatcam-scn.cjs` | 船载相机：在 `examples/ocean/` 里把帆船放进与实拍片段相近的海况（风 7.5 m/s、风区 5 km），从船首舷侧、船尾、船首拍三张 |
| `yacht-roll.mjs` | 帆船在不规则海面（JONSWAP + 方向分布）上的横摇、纵摇统计，纯 Node |
| `tools/fetch_footage.py` | 下载实拍素材（被限流时自动退避） |
| `tools/horizon.py` | 从船载视频逐帧跟踪地平线，得到横摇角时间序列 |

## 运行

```bash
python3 tests/compare/tools/fetch_footage.py footage
```

```bash
FORCES=2,3,4,5,6,7,8,9,10,11,12 STEPS=450 SHOT_TIMEOUT=600000 OUT_DIR=out/bf node tools/play.cjs tests/compare/beaufort.html out/bf tests/compare/beaufort-scn.cjs --w=800 --h=560
```

```bash
STEPS=360 SHOT_TIMEOUT=600000 node tools/play.cjs tests/compare/surf.html out/surf tests/compare/surf-scn.cjs --w=640 --h=360
```

```bash
STEPS=240 SHOT_TIMEOUT=600000 node tools/play.cjs examples/ocean/index.html out/boat tests/compare/boatcam-scn.cjs --w=854 --h=480
```

```bash
node tests/compare/yacht-roll.mjs 7 0.27 2.15 45 300
```

`beaufort-scn.cjs` 的 `SKY` 环境变量可以按级覆盖天空（JSON，例如 `{"6":{"clouds":0.15}}`），让云量接近照片。无显卡时用软件渲染，每一级要几分钟。

## 方法

- **蒲福风级**：照片是 NOAA / 美国国家气象局的蒲福风级系列（胶片扫描，公有领域），没有风速、浪高记录，只能对照 WMO 对各级的描述和典型浪高，以及白浪覆盖率的现场观测公式（Monahan & O'Muircheartaigh 1980）。模拟按各级中值风速、充分发展海况，读数里的覆盖率是照片法定义（活跃 + 残留白浪，逐纹素 min(1, A + B) 的全图平均）。自动曝光把海面的对数平均亮度压到中灰；照片按天空曝光，海面更暗，所以整体亮度、海水颜色不在比较范围内。
- **白浪面积**：试过照片自动提取（Callaghan & White 2009 的 AWE 阈值、Bakhoday-Paskyabi 等 2016 的迭代类间方差），但老胶片扫描偏色、噪点多、天光反射亮，每种阈值都把反光算成白浪，数字不可信，所以只做目视对照，覆盖率的数字用现场观测公式。
- **横摇**：Elan 431 视频（jurijfranko，CC BY 3.0）里有 9 s 船首相机画面。`tools/horizon.py` 逐帧找天—海分界（每列取蓝通道最大竖直梯度），RANSAC 拟合直线得到横摇角；地平线上下起伏的周期就是遭遇周期（约 1.3 s）。由遭遇频率 ωe = ω + k·V·cos(浪向角) 反推谱峰周期约 2.1 s，按风浪模型对应 7 m/s 风、约 5 km 风区。模型帆船放进统计上相同的不规则海面，取同样长度（8.8 s）的窗口比较。
- **船首浪、尾迹、岸边碎浪**：同一视频的船首舷侧、船尾画面，以及 CC0 视频“Ocean surface waves”的岸边碎浪，与相近条件下的渲染并排目视对照。
