// 岸边碎浪对照渲染：一帧 + 读数
module.exports = async (page, h) => {
  await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
  const r = await page.evaluate(async (steps) => window.__cmp.render({ steps }), +(process.env.STEPS || 300));
  console.log('[surf]', JSON.stringify(r));
  await h.shot('surf');
};
