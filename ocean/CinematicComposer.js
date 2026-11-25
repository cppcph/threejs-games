// =====================================================================================
// CinematicComposer —— 电影感后期链
//   HDR（HalfFloat，MSAA）渲染目标 → RenderPass → UnrealBloomPass（在线性 HDR 上，只让很亮的东西发光）
//   → OutputPass（renderer 的色调映射 AgX / ACES / Neutral + 曝光，转 sRGB）
//   → 调色（显示空间）：白平衡、lift / gamma / gain、对比度 S 曲线、饱和度、锐化、径向色差、暗角、
//     随亮度变化的胶片颗粒、闪电闪光、宽银幕黑边、淡出，最后加 1/255 抖动防止天空出现色带
//
// 用法：
//   const post = new CinematicComposer(renderer, scene, camera, { samples: 4 });
//   post.applyPreset('golden');
//   post.setSize(innerWidth, innerHeight, Math.min(devicePixelRatio, 2));
//   每帧：post.render(dt);           // 代替 renderer.render(scene, camera)
//   post.params.letterbox = 2.39; post.params.letterboxAmount = 1;   // 2.39:1 宽银幕
//
// 曝光与海面着色器的标定一致：ACES / AgX，exposure ≈ 0.5（AgX 略暗，预设里给 0.6 左右）。
// =====================================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const TONE_MAPPINGS = {
  ACES: THREE.ACESFilmicToneMapping,
  AgX: THREE.AgXToneMapping,
  Neutral: THREE.NeutralToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  None: THREE.NoToneMapping,
};

export const CINEMATIC_DEFAULTS = {
  toneMapping: 'ACES',          // 'ACES' | 'AgX' | 'Neutral' | 'Reinhard' | 'None'
  exposure: 0.5,
  bloomStrength: 0.55, bloomRadius: 0.55, bloomThreshold: 2.4,
  contrast: 1.06,               // 1 = 不变；>1 加 S 曲线
  saturation: 1.08,
  temperature: 0,               // −1 冷 … +1 暖
  tint: 0,                      // −1 偏绿 … +1 偏品红
  lift: [0, 0, 0],              // 暗部加色（0–0.05）
  gamma: [1, 1, 1],             // 中间调
  gain: [1, 1, 1],              // 亮部
  vignette: 0.3, vignetteSoftness: 0.5,
  grain: 0.03,                  // 颗粒强度（0–0.1）
  chromaticAberration: 0.0015,  // 画面边缘 R/B 错开的比例
  sharpen: 0.15,
  letterbox: 2.39,              // 目标画幅比
  letterboxAmount: 0,           // 0 无黑边 → 1 完全 2.39:1（可做动画）
  letterboxColor: [0, 0, 0],
  flash: 0,                     // 闪电等全屏闪光 0–1
  flashColor: [0.75, 0.8, 1.0],
  fade: 0,                      // 0 正常 → 1 全黑
};

// 预设只改调色、泛光和曝光；色调映射一并切换
export const CINEMATIC_PRESETS = {
  golden: {   // 黄金时刻：暖、柔和高光、轻微品红暗部
    toneMapping: 'AgX', exposure: 0.62, bloomStrength: 0.62, bloomRadius: 0.62, bloomThreshold: 1.9,
    contrast: 1.12, saturation: 1.16, temperature: 0.12, tint: 0.03,
    lift: [0.012, 0.005, 0.0], gamma: [1.0, 0.99, 0.97], gain: [1.03, 1.0, 0.95],
    vignette: 0.34, vignetteSoftness: 0.55, grain: 0.03, chromaticAberration: 0.0016, sharpen: 0.16,
  },
  storm: {    // 风暴：冷、去饱和、硬对比、颗粒重
    toneMapping: 'ACES', exposure: 0.62, bloomStrength: 0.32, bloomRadius: 0.5, bloomThreshold: 2.8,
    contrast: 1.2, saturation: 0.7, temperature: -0.16, tint: -0.02,
    lift: [0.0, 0.006, 0.012], gamma: [1.0, 1.0, 1.02], gain: [0.96, 0.99, 1.03],
    vignette: 0.48, vignetteSoftness: 0.45, grain: 0.05, chromaticAberration: 0.002, sharpen: 0.22,
  },
  tropical: { // 晴空碧海：干净、饱和、轻颗粒
    toneMapping: 'ACES', exposure: 0.5, bloomStrength: 0.5, bloomRadius: 0.55, bloomThreshold: 2.4,
    contrast: 1.07, saturation: 1.16, temperature: 0.03, tint: 0.0,
    lift: [0.0, 0.004, 0.006], gamma: [1, 1, 1], gain: [1.0, 1.0, 1.0],
    vignette: 0.22, vignetteSoftness: 0.6, grain: 0.018, chromaticAberration: 0.001, sharpen: 0.14,
  },
  moonlight: { // 月夜：冷蓝、暗部抬一点蓝、低饱和、亮的东西发光
    toneMapping: 'AgX', exposure: 0.95, bloomStrength: 0.75, bloomRadius: 0.7, bloomThreshold: 1.1,
    contrast: 1.1, saturation: 0.82, temperature: -0.3, tint: 0.04,
    lift: [0.0, 0.006, 0.016], gamma: [1.02, 1.0, 0.97], gain: [0.95, 0.99, 1.06],
    vignette: 0.46, vignetteSoftness: 0.5, grain: 0.045, chromaticAberration: 0.0016, sharpen: 0.12,
  },
  dawn: {      // 黎明薄雾：低对比、粉紫暗部、柔光
    toneMapping: 'AgX', exposure: 0.66, bloomStrength: 0.66, bloomRadius: 0.7, bloomThreshold: 1.7,
    contrast: 0.97, saturation: 0.96, temperature: 0.05, tint: 0.08,
    lift: [0.02, 0.012, 0.02], gamma: [0.99, 1.0, 1.0], gain: [1.02, 0.99, 1.0],
    vignette: 0.26, vignetteSoftness: 0.65, grain: 0.028, chromaticAberration: 0.0012, sharpen: 0.1,
  },
};

const GradeShader = {
  name: 'CinematicGrade',
  uniforms: {
    tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) }, uAspect: { value: 16 / 9 }, uTime: { value: 0 },
    uContrast: { value: 1 }, uSaturation: { value: 1 }, uSharpen: { value: 0 }, uWB: { value: new THREE.Vector3(1, 1, 1) },
    uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
    uVignette: { value: 0 }, uVignetteSoft: { value: 0.5 }, uGrain: { value: 0 }, uCA: { value: 0 },
    uLetterbox: { value: 2.39 }, uLetterboxAmt: { value: 0 }, uBarColor: { value: new THREE.Vector3() },
    uFlash: { value: 0 }, uFlashColor: { value: new THREE.Vector3(0.75, 0.8, 1) }, uFade: { value: 0 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uAspect; uniform float uTime;
    uniform float uContrast; uniform float uSaturation; uniform float uSharpen; uniform vec3 uWB;
    uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain;
    uniform float uVignette; uniform float uVignetteSoft; uniform float uGrain; uniform float uCA;
    uniform float uLetterbox; uniform float uLetterboxAmt; uniform vec3 uBarColor;
    uniform float uFlash; uniform vec3 uFlashColor; uniform float uFade;
    varying vec2 vUv;
    float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec2 uv = vUv;
      vec2 dc = uv - 0.5;
      // 径向色差：离中心越远，R 往外、B 往里
      vec3 c;
      if (uCA > 0.0) {
        vec2 off = dc * uCA * 2.0;
        c = vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
      } else c = texture2D(tDiffuse, uv).rgb;
      // 锐化（反锐化掩模，四邻域）
      if (uSharpen > 0.0) {
        vec3 n = texture2D(tDiffuse, uv + vec2(uTexel.x, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(uTexel.x, 0.0)).rgb
               + texture2D(tDiffuse, uv + vec2(0.0, uTexel.y)).rgb + texture2D(tDiffuse, uv - vec2(0.0, uTexel.y)).rgb;
        c += (c - n * 0.25) * uSharpen;
      }
      c = clamp(c, 0.0, 1.0);
      // 白平衡在线性光里做
      vec3 lin = pow(c, vec3(2.2)) * uWB;
      c = pow(clamp(lin, 0.0, 1.0), vec3(1.0 / 2.2));
      // lift / gamma / gain
      c = uGain * (c + uLift * (1.0 - c));
      c = pow(clamp(c, 0.0, 1.0), 1.0 / max(uGamma, vec3(0.01)));
      // 对比度：向 S 曲线混合（<1 时反向，变平）
      vec3 sc = c * c * (3.0 - 2.0 * c);
      c = clamp(mix(c, sc, (uContrast - 1.0) * 2.0), 0.0, 1.0);
      // 饱和度
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = clamp(mix(vec3(l), c, uSaturation), 0.0, 1.0);
      // 闪光
      c += uFlashColor * uFlash * (0.6 + 0.4 * (1.0 - l));
      // 暗角（椭圆，跟随画幅）
      float r = length(dc * 2.0) * 0.7071;
      c *= 1.0 - uVignette * smoothstep(0.2, 1.0 + uVignetteSoft * 0.45, r);
      // 胶片颗粒：三角分布，中间调最明显
      float g = hash12(gl_FragCoord.xy + fract(uTime * 13.37) * 919.0) + hash12(gl_FragCoord.xy * 1.37 + fract(uTime * 7.13) * 577.0) - 1.0;
      float lw = 1.0 - pow(abs(l * 2.0 - 1.0), 2.0) * 0.75;
      c += g * uGrain * lw;
      // 8 位输出抖动
      c += (hash12(gl_FragCoord.xy + 0.37) - 0.5) / 255.0;
      // 宽银幕黑边
      if (uLetterboxAmt > 0.0) {
        float m = 1.0;
        if (uAspect < uLetterbox) {
          float bar = 0.5 * (1.0 - uAspect / uLetterbox) * uLetterboxAmt, e = uTexel.y;
          m = smoothstep(bar - e, bar + e, uv.y) * smoothstep(bar - e, bar + e, 1.0 - uv.y);
        } else {
          float bar = 0.5 * (1.0 - uLetterbox / uAspect) * uLetterboxAmt, e = uTexel.x;
          m = smoothstep(bar - e, bar + e, uv.x) * smoothstep(bar - e, bar + e, 1.0 - uv.x);
        }
        c = mix(uBarColor, c, m);
      }
      c *= 1.0 - uFade;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

const _size = new THREE.Vector2();

export class CinematicComposer {
  constructor(renderer, scene, camera, { samples = 4, reducedMotion } = {}) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.params = JSON.parse(JSON.stringify(CINEMATIC_DEFAULTS));
    this.reducedMotion = reducedMotion !== undefined ? !!reducedMotion
      : (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this._time = 0;
    renderer.getSize(_size);
    const dpr = renderer.getPixelRatio();
    this._w = _size.x || 1; this._h = _size.y || 1; this._dpr = dpr;
    const rt = new THREE.WebGLRenderTarget(Math.max(1, this._w * dpr), Math.max(1, this._h * dpr), { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(this._w, this._h), 0.55, 0.55, 2.4);
    this.outputPass = new OutputPass();
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
    this.composer.addPass(this.gradePass);
    this.setSize(this._w, this._h, dpr);
  }

  get scene() { return this._scene; }
  set scene(s) { this._scene = s; if (this.renderPass) this.renderPass.scene = s; }
  get camera() { return this._camera; }
  set camera(c) { this._camera = c; if (this.renderPass) this.renderPass.camera = c; }

  applyPreset(name) {
    const p = CINEMATIC_PRESETS[name];
    if (!p) { console.warn(`CinematicComposer: unknown preset "${name}"`); return this; }
    Object.assign(this.params, JSON.parse(JSON.stringify(p)));
    return this;
  }

  setSize(w, h, dpr = this._dpr) {
    this._w = w; this._h = h; this._dpr = dpr;
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    const u = this.gradePass.uniforms;
    u.uTexel.value.set(1 / Math.max(1, w * dpr), 1 / Math.max(1, h * dpr));
    u.uAspect.value = w / Math.max(1, h);
    return this;
  }

  _sync() {
    const P = this.params, r = this.renderer;
    r.toneMapping = TONE_MAPPINGS[P.toneMapping] ?? THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = P.exposure;
    const b = this.bloomPass;
    b.strength = P.bloomStrength; b.radius = P.bloomRadius; b.threshold = P.bloomThreshold;
    b.enabled = P.bloomStrength > 0.001;
    const u = this.gradePass.uniforms;
    u.uContrast.value = P.contrast; u.uSaturation.value = P.saturation; u.uSharpen.value = P.sharpen;
    // 白平衡：色温改 R/B，色调改 G，再按亮度归一，不改变整体明暗
    const wr = 1 + 0.3 * P.temperature, wb = 1 - 0.3 * P.temperature, wg = 1 - 0.2 * P.tint;
    const lum = 0.2126 * wr + 0.7152 * wg + 0.0722 * wb;
    u.uWB.value.set(wr / lum, wg / lum, wb / lum);
    u.uLift.value.fromArray(P.lift); u.uGamma.value.fromArray(P.gamma); u.uGain.value.fromArray(P.gain);
    u.uVignette.value = P.vignette; u.uVignetteSoft.value = P.vignetteSoftness;
    u.uGrain.value = P.grain; u.uCA.value = P.chromaticAberration;
    u.uLetterbox.value = P.letterbox; u.uLetterboxAmt.value = P.letterboxAmount;
    u.uBarColor.value.fromArray(P.letterboxColor);
    u.uFlash.value = P.flash; u.uFlashColor.value.fromArray(P.flashColor); u.uFade.value = P.fade;
    u.uTime.value = this._time;
  }

  render(dt = 0) {
    if (!this.reducedMotion) this._time = (this._time + dt) % 1000;
    this._sync();
    this.composer.render(dt);
  }

  // 画幅里没被黑边挡住的区域（像素，CSS 尺寸），方便把 UI 放在画面内
  get visibleRect() {
    const P = this.params, a = this._w / this._h, k = P.letterboxAmount;
    if (k <= 0) return { x: 0, y: 0, width: this._w, height: this._h };
    if (a < P.letterbox) { const bar = 0.5 * (1 - a / P.letterbox) * k * this._h; return { x: 0, y: bar, width: this._w, height: this._h - 2 * bar }; }
    const bar = 0.5 * (1 - P.letterbox / a) * k * this._w; return { x: bar, y: 0, width: this._w - 2 * bar, height: this._h };
  }

  dispose() {
    this.bloomPass.dispose();
    this.outputPass.dispose();
    this.gradePass.dispose();
    this.composer.dispose();
  }
}
