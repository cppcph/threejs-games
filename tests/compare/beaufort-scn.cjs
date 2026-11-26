// 逐级渲染蒲福风级对照图：FORCES=0,1,…  输出 bf-<级>.png 与 summary.json
const fs = require('fs'), path = require('path');
module.exports = async (page, h) => {
  await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
  const forces = (process.env.FORCES || '3,4,6,7,8,9').split(',').map(Number);
  const steps = +(process.env.STEPS || 450);
  const out = [];
  const sky = JSON.parse(process.env.SKY || '{}');    // 每级的天空覆盖：{ "6": { "clouds": 0.15 } }
  for (const force of forces) {
    const r = await page.evaluate(async (o) => window.__cmp.render(o), { force, steps, ...(sky[force] || {}) });
    console.log('[bf]', JSON.stringify(r));
    out.push(r);
    await h.shot(`bf-${String(force).padStart(2, '0')}`);
  }
  fs.writeFileSync(path.join(process.env.OUT_DIR || '.', 'summary.json'), JSON.stringify(out, null, 1));
};
