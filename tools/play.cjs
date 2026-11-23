#!/usr/bin/env node
// 无头浏览器试玩 / 截图脚本（Playwright + Chromium）。
//
//   node tools/play.cjs <页面.html> <输出目录> [场景.cjs] [--w=1280] [--h=720] [--dpr=1] [--mobile] [--log]
//
// - 页面可以是完整网页，也可以是 Artifact 片段（自动套骨架）。
// - 若存在 node_modules/three（npm install 后就有）或设置了 THREE_VENDOR=<three 包目录>，
//   对 cdn.jsdelivr.net/npm/three@0.170.0 的请求会改由本地文件应答，断网也能测。
// - 场景文件导出 async (page, h) => {}，h 提供：
//   h.wait(ms) h.shot(name) h.hold(code, ms) h.press(key) h.state() h.fps(ms) h.errors
//   h.state() 读取游戏暴露的 window.__game.debug()。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium, devices } = require('playwright');

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.slice(2).split('=');
  return [k, v === undefined ? true : v];
}));
const [pageFile, outDir, scenarioFile] = args.filter(a => !a.startsWith('--'));
if (!pageFile || !outDir) { console.error('usage: node tools/play.cjs <page.html> <outDir> [scenario.cjs]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const vendorCandidates = [process.env.THREE_VENDOR, path.resolve(__dirname, '../node_modules/three')].filter(Boolean);
const VENDOR = vendorCandidates.find(p => fs.existsSync(path.join(p, 'build/three.module.js')));

const raw = fs.readFileSync(pageFile, 'utf8');
const html = /^\s*<!doctype/i.test(raw) ? raw : `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
</head><body>
${raw}
</body></html>`;

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({
    // 无 GPU 的机器上用 SwiftShader 软件渲染 WebGL（很慢，约 5–10 fps，只用于验证）
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext(flags.mobile
    ? { ...devices['iPhone 13'] }
    : { viewport: { width: +(flags.w || 1280), height: +(flags.h || 720) }, deviceScaleFactor: +(flags.dpr || 1) });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => {
    const t = m.type();
    if ((t === 'error' || t === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) {
      const s = `[console.${t}] ${m.text()}`; errors.push(s); console.log(s);
    } else if (flags.log) console.log(`[console.${t}] ${m.text()}`);
  });
  page.on('pageerror', e => { const s = `[pageerror] ${e.message}\n${e.stack || ''}`; errors.push(s); console.log(s); });
  if (VENDOR) {
    await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/**', route => {
      const rel = new URL(route.request().url()).pathname.replace('/npm/three@0.170.0/', '');
      const fp = path.join(VENDOR, rel);
      if (!fp.startsWith(VENDOR) || !fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' });
      route.fulfill({ status: 200, body: fs.readFileSync(fp), headers: { 'content-type': 'application/javascript; charset=utf-8', 'access-control-allow-origin': '*' } });
    });
  }

  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  let n = 0;
  const h = {
    page, errors,
    wait: ms => page.waitForTimeout(ms),
    shot: async (name, opts = {}) => {
      const ext = opts.type === 'jpeg' ? 'jpg' : 'png';
      const f = path.join(outDir, `${String(++n).padStart(2, '0')}-${name}.${ext}`);
      await page.screenshot({ path: f, ...opts }); console.log('[shot]', f); return f;
    },
    hold: async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); },
    press: key => page.keyboard.press(key),
    state: () => page.evaluate(() => (window.__game && window.__game.debug) ? window.__game.debug() : null),
    fps: (ms = 2000) => page.evaluate(ms => new Promise(res => {
      let f = 0; const s = performance.now();
      const tick = () => { f++; if (performance.now() - s < ms) requestAnimationFrame(tick); else res(+(f * 1000 / (performance.now() - s)).toFixed(1)); };
      requestAnimationFrame(tick);
    }), ms),
  };
  try {
    if (scenarioFile) await require(path.resolve(scenarioFile))(page, h);
    else { await h.wait(2500); await h.shot('load'); }
  } catch (e) { console.log('[scenario error]', e.stack || e); errors.push(String(e)); }
  console.log(`[play] ${((Date.now() - t0) / 1000).toFixed(1)}s, ${errors.length} 条错误/警告`);
  await browser.close();
  server.close();
  process.exitCode = errors.length ? 1 : 0;
})();
