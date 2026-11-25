// 帆船放到真实海面上的浏览器检查（需要 WebGL；无 GPU 时用 SwiftShader，慢但能跑）：
//   THREE_VENDOR=<three 包目录> node tools/play.cjs tests/ocean/vessel-check.html <输出目录> tests/ocean/vessel-check.cjs --root=.
module.exports = async (page, h) => {
  await page.waitForFunction(() => window.__vessel && window.__vessel.ready, null, { timeout: 120000 });
  const a = await page.evaluate(() => window.__vessel.run(10));
  await page.evaluate(() => window.__vessel.render('chase'));
  await h.shot('vessel-chase-10s');
  const b = await page.evaluate(() => window.__vessel.run(20));
  await page.evaluate(() => window.__vessel.render('chase'));
  await h.shot('vessel-chase-30s');
  const c = await page.evaluate(() => window.__vessel.render('side'));
  await h.shot('vessel-side-30s');
  console.log('[vessel 10s]', JSON.stringify(a, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
  console.log('[vessel 30s]', JSON.stringify(c, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
  const fail = [];
  if (!c.oceanReady) fail.push('海面回读没有就绪');
  if (!c.finite) fail.push('状态出现 NaN');
  if (!(c.hullFormulaError < 1e-12)) fail.push(`HullShape 与 HullGenerator 不一致：${c.hullFormulaError}`);
  if (!c.visualHullMatches) fail.push('画面船体参数与物理船体不同');
  if (!(Math.abs(c.draftMean) < 0.35)) fail.push(`船没有浮在水面上：水线相对平均水面 ${c.draftMean}`);
  if (!(c.draftRms < 0.6)) fail.push(`升沉相对水面起伏过大：${c.draftRms}`);
  if (!(c.meanSpeedKn > 3.5 && c.meanSpeedKn < 8)) fail.push(`平均船速异常：${c.meanSpeedKn} kn`);
  if (!(c.twaErrRms < 10)) fail.push(`保持真风角不稳：均方根误差 ${c.twaErrRms}°`);
  if (!(c.maxHeel < 45)) fail.push(`横倾过大：${c.maxHeel}`);
  if (!(Math.sign(c.boom) === c.sailSide && Math.abs(c.visualBoom - c.boom) < 0.3)) fail.push('帆的外观没有跟随物理');
  if (fail.length) throw new Error(fail.join('；'));
};
