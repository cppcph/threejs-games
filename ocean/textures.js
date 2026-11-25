// 程序生成的可平铺纹理（启动时生成一次，无外部文件）
import * as THREE from 'three';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * 泡沫纹理（RGBA8，可平铺）
 *   R：气泡团（Worley 细胞边缘 + 细胞内小气泡），G：稀疏的大块泡沫斑，B：细碎纹理，A：低频起伏
 */
export function makeFoamTexture(size = 256, seed = 7) {
  const rand = rng(seed);
  const data = new Uint8Array(size * size * 4);
  const cells = (count) => Array.from({ length: count }, () => [rand(), rand(), 0.4 + rand() * 0.6]);
  const layers = [cells(90), cells(26), cells(400)];
  const worley = (pts, u, v) => {
    let f1 = 9, f2 = 9, w = 0;
    for (const [px, py, s] of pts) {
      let dx = Math.abs(u - px), dy = Math.abs(v - py);
      if (dx > 0.5) dx = 1 - dx; if (dy > 0.5) dy = 1 - dy;   // 环绕：可平铺
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) { f2 = f1; f1 = d; w = s; } else if (d < f2) f2 = d;
    }
    return [f1, f2, w];
  };
  const lowFreq = (u, v) => 0.5 + 0.25 * Math.sin(2 * Math.PI * (u * 2 + v)) * Math.cos(2 * Math.PI * (v * 3 - u)) + 0.25 * Math.sin(2 * Math.PI * (u * 5 + v * 4) + 1.3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const [a1, a2, aw] = worley(layers[0], u, v);
    const [b1, b2] = worley(layers[1], u, v);
    const [c1, c2] = worley(layers[2], u, v);
    const edge = 1 - Math.min(1, (a2 - a1) * 14);                // 细胞边界 → 泡沫丝
    const bubble = Math.max(0, 1 - a1 * 26 * aw) * 0.6;          // 细胞中心小气泡
    const r = Math.min(1, edge * 0.85 + bubble + 0.15 * (1 - Math.min(1, (c2 - c1) * 30)));
    const g = Math.min(1, Math.max(0, 1 - b1 * 5.5) * 1.3 + (1 - Math.min(1, (b2 - b1) * 6)) * 0.4);
    const b = 1 - Math.min(1, (c2 - c1) * 22);
    const o = (y * size + x) * 4;
    data[o] = r * 255; data[o + 1] = g * 255; data[o + 2] = b * 255; data[o + 3] = lowFreq(u, v) * 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

/**
 * 毛细波坡度纹理（RG = 两个方向的坡度，编码到 0–1；可平铺）
 * 由整数波矢的正弦和生成，天然无缝；方向集中在 +x（使用时按风向旋转）。
 */
export function makeRippleTexture(size = 256, seed = 11) {
  const rand = rng(seed);
  const waves = [];
  for (let i = 0; i < 48; i++) {
    const kmag = 3 + Math.floor(rand() * 26);
    const ang = (rand() - 0.5) * 2.2;                 // 主要朝 +x，带一定散布
    const kx = Math.round(Math.cos(ang) * kmag), ky = Math.round(Math.sin(ang) * kmag);
    if (kx === 0 && ky === 0) continue;
    const amp = 0.5 / Math.pow(Math.hypot(kx, ky), 1.2);
    waves.push([kx, ky, amp, rand() * Math.PI * 2]);
  }
  const sx = new Float32Array(size * size), sy = new Float32Array(size * size);
  let maxS = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let gx = 0, gy = 0;
    for (const [kx, ky, a, ph] of waves) {
      const c = Math.cos(2 * Math.PI * (kx * x + ky * y) / size + ph) * a;
      gx += c * kx; gy += c * ky;
    }
    const i = y * size + x;
    sx[i] = gx; sy[i] = gy;
    maxS = Math.max(maxS, Math.abs(gx), Math.abs(gy));
  }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = (sx[i] / maxS * 0.5 + 0.5) * 255;
    data[i * 4 + 1] = (sy[i] / maxS * 0.5 + 0.5) * 255;
    data[i * 4 + 2] = 128; data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
