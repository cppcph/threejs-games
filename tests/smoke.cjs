// 冒烟测试：加载 → 点开始 → 操作几秒 → 截图，并打印游戏的 debug 状态。
// 四款游戏通用：node tools/play.cjs games/<名字>/index.html out/<名字> tests/smoke.cjs
const START = ['#start', '#bStart'];

module.exports = async (page, h) => {
  await h.wait(4000);
  await h.shot('title');
  const sel = START.find(Boolean) && await (async () => {
    for (const s of START) if (await page.locator(s).isVisible().catch(() => false)) return s;
    return null;
  })();
  if (!sel) throw new Error('找不到开始按钮');
  await page.click(sel);
  // 有的游戏先播关卡标题（mode = intro），等它进入游玩状态再操作（软件渲染下最多等 30 秒）
  let before = null;
  for (let i = 0; i < 60; i++) {
    await h.wait(500);
    before = await h.state();
    if (before && !/title|menu|intro/i.test(String(before.mode))) break;
  }
  await page.keyboard.down('KeyW');
  await h.hold('KeyA', 1200);
  await h.hold('KeyD', 1200);
  await page.keyboard.up('KeyW');
  await h.wait(800);
  await h.shot('play');
  const after = await h.state();
  console.log('[smoke] start =', sel);
  console.log('[smoke] before =', JSON.stringify(before));
  console.log('[smoke] after  =', JSON.stringify(after));
  if (!after) throw new Error('window.__game.debug() 没有返回状态');
  if (/title|menu/i.test(String(after.mode))) throw new Error(`点了开始仍停在 ${after.mode}`);
};
