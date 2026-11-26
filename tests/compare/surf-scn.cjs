// 岸边碎浪对照渲染：一帧 + 读数
module.exports = async (page, h) => {
  await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
  // 场景参数可用 SURF 环境变量（JSON）覆盖，例如 {"U":5,"slope":0.04,"swell":{"Hs":0.5,"Tp":8,"theta":1.5708}}
  const opt = JSON.parse(process.env.SURF || '{}');
  const r = await page.evaluate(async (o) => window.__cmp.render(o), { steps: +(process.env.STEPS || 300), ...opt });
  console.log('[surf]', JSON.stringify(r));
  await h.shot('surf');
};
