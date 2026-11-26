# 地平线跟踪：逐帧找天—海分界（每列取亮→暗的最大竖直梯度），稳健直线拟合，输出倾角与截距的时间序列
import sys, glob, json
import numpy as np
from PIL import Image
from scipy import ndimage

def fit_horizon(path, x0, x1, y0, y1):
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    # 蓝通道里天亮海暗最明显；先竖直平滑一点去噪
    g = ndimage.gaussian_filter(a[y0:y1, x0:x1, 2], (1.5, 1.0))
    dy = g[:-2] - g[2:]                       # 上亮下暗为正
    rows = np.argmax(dy, axis=0) + 1 + y0
    strength = dy.max(axis=0)
    xs = np.arange(x0, x1)
    ok = strength > np.percentile(strength, 40)
    xs, rows = xs[ok], rows[ok].astype(float)
    best = None
    rng = np.random.default_rng(0)
    for _ in range(300):                       # RANSAC
        i, j = rng.choice(len(xs), 2, replace=False)
        if xs[i] == xs[j]: continue
        k = (rows[j] - rows[i]) / (xs[j] - xs[i]); b = rows[i] - k * xs[i]
        inl = np.abs(rows - (k * xs + b)) < 2.0
        if best is None or inl.sum() > best[0]: best = (inl.sum(), inl)
    inl = best[1]
    k, b = np.polyfit(xs[inl], rows[inl], 1)
    return float(np.degrees(np.arctan(k))), float(k * (x0 + x1) / 2 + b), float(inl.mean())

if __name__ == '__main__':
    pattern, x0, x1, y0, y1, fps = sys.argv[1], *map(int, sys.argv[2:6]), float(sys.argv[6])
    out = []
    for i, f in enumerate(sorted(glob.glob(pattern))):
        ang, mid, q = fit_horizon(f, x0, x1, y0, y1)
        out.append({'t': i / fps, 'angle': ang, 'row': mid, 'inliers': q})
    print(json.dumps(out))
