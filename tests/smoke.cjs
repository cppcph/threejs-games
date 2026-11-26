// 冒烟测试：加载 → 点开始 → 操作几秒 → 截图，并打印游戏的 debug 状态。
// 四款游戏通用：node tools/play.cjs games/<名字>/index.html out/<名字> tests/smoke.cjs
// 游戏若提供 __game.freeze / render / step（信风：FFT 海面在软件渲染下一帧要好几秒），
// 就冻结主循环、按住按键推进若干帧、按需渲染一帧再截图，否则截图会等不到画面而超时。
const START = ['#start', '#bStart'];

module.exports = async (page, h) => {
  // 等加载完成（debug() 能返回状态且不再是 loading），至少等 4 秒
  const t0 = Date.now();
  let s = null;
  for (let i = 0; i < 120; i++) {
    await h.wait(500);
    s = await h.state().catch(() => null);
    if (s && !/loading/i.test(String(s.mode))) break;
  }
  const hooks = await page.evaluate(() => !!(window.__game && window.__game.freeze && window.__game.render && window.__game.step));
  if (hooks) { await page.evaluate(() => { window.__game.freeze(true); window.__game.render(1 / 30); }); }
  else await h.wait(Math.max(0, 4000 - (Date.now() - t0)));
  await h.shot('title');
  const sel = await (async () => {
    for (const s of START) if (await page.locator(s).isVisible().catch(() => false)) return s;
    return null;
  })();
  if (!sel) throw new Error('找不到开始按钮');
  await page.click(sel);
  // 有的游戏先播关卡标题（mode = intro），等它进入游玩状态再操作（软件渲染下最多等 30 秒）
  let before = null;
  for (let i = 0; i < 60; i++) {
    if (hooks) await page.evaluate(() => window.__game.step(4, 1 / 30)); else await h.wait(500);
    before = await h.state();
    if (before && !/title|menu|intro/i.test(String(before.mode))) break;
  }
  const hold = async (key, ms) => {
    if (!hooks) return h.hold(key, ms);
    await page.keyboard.down(key); await page.evaluate((n) => window.__game.step(n, 1 / 30), Math.round(ms / 1000 * 30)); await page.keyboard.up(key);
  };
  await page.keyboard.down('KeyW');
  await hold('KeyA', 1200);
  await hold('KeyD', 1200);
  await page.keyboard.up('KeyW');
  if (hooks) await page.evaluate(() => window.__game.step(24, 1 / 30)); else await h.wait(800);
  if (hooks) await page.evaluate(() => window.__game.render(1 / 30));
  await h.shot('play');
  const after = await h.state();
  console.log('[smoke] start =', sel);
  console.log('[smoke] before =', JSON.stringify(before));
  console.log('[smoke] after  =', JSON.stringify(after));
  if (!after) throw new Error('window.__game.debug() 没有返回状态');
  if (/title|menu/i.test(String(after.mode))) throw new Error(`点了开始仍停在 ${after.mode}`);
};
