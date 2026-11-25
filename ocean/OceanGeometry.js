// 以相机为中心的海面网格
//
// 中间一块等距细格（近处浪形清楚），向外每格按比例放大，铺到 far，再加一圈远到 skirt
// 的裙边盖住地平线。网格整体平移时吸附到细格间距的整数倍，近处顶点在世界坐标中
// 不动，浪不会“游泳”。相机升高时整体放大 2 的幂倍，保持屏幕上的网格密度。
import * as THREE from 'three';

export const OCEAN_GRID_PRESETS = {
  ultra:  { inner: 0.3, half: 56, growth: 1.06 },
  high:   { inner: 0.45, half: 48, growth: 1.075 },
  medium: { inner: 0.8, half: 48, growth: 1.1 },
  low:    { inner: 1.6, half: 48, growth: 1.15 },
};

export function buildOceanGeometry(quality = 'high', { far = 20000, skirt = 120000 } = {}) {
  const p = typeof quality === 'string' ? OCEAN_GRID_PRESETS[quality] ?? OCEAN_GRID_PRESETS.high : quality;
  const half = [];
  for (let i = 0; i * p.inner <= p.half + 1e-6; i++) half.push(i * p.inner);
  let x = half[half.length - 1], step = p.inner;
  while (x < far) { step *= p.growth; x += step; half.push(x); }
  half.push(skirt);
  const coords = [...half.slice(1).map((v) => -v).reverse(), ...half];
  const n = coords.length;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const o = (j * n + i) * 3;
    pos[o] = coords[i]; pos[o + 1] = 0; pos[o + 2] = coords[j];
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    // 对角线方向交替，避免整片三角形同向带来的方向性纹路
    if ((i + j) & 1) { idx.set([a, c, b, b, c, d], k); } else { idx.set([a, c, d, a, d, b], k); }
    k += 6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), skirt * 1.5);
  g.userData = { snap: p.inner, inner: p.inner, growth: p.growth, half: p.half, vertices: n * n };
  return g;
}
