// 船载相机对照实拍：船首舷侧看船首浪、船尾看尾迹、船首前视看地平线
//   海况与实拍片段匹配：风 7.5 m/s、风区 5 km（Tp ≈ 2 s 的短浪）；晴空、正午（实拍是夏天亚得里亚海的晴天）
module.exports = async (page, h) => {
  await page.waitForFunction(() => window.__demo, null, { timeout: 120000 });
  await page.evaluate(() => document.body.classList.add('clean'));
  await page.evaluate(() => window.__demo.applyShot('tropical'));
  // 直接改模型参数后重放镜头里的船：用 __demo 暴露的对象
  await page.evaluate(() => {
    const D = window.__demo, THREE_ = null;
    const S = D.S, m = D.ocean.model;
    const U = 7.5, from = 110 * Math.PI / 180;
    const w = { x: -Math.sin(from) * U, z: Math.cos(from) * U };
    m.setWind(w.x, w.z); m.snapWind(); m.setFetch(5e3); m.calm(); m.develop(1); m.setBackgroundSwell(null);
    D.ocean.resetSea();
    S.windU = U; S.windFrom = 110; S.swell = { Hs: 0, Tp: 12, from: 0 };
    S.clouds = 0.05; S.tod = 13;
    D.windNow.set(w.x, w.z);
    const twa = 50 * Math.PI / 180, yaw = Math.atan2(-w.x, -w.z) + twa;
    D.yacht.reset({ x: 0, z: 0, yaw, speed: 3 });
    D.yacht.setControls({ mode: 'twa', target: twa, tack: 'starboard', sheet: 'auto', flat: 'auto', reef: 'auto' });
  });
  const views = {
    // 船首舷侧（下风舷 = 左舷，+X），离水约 1 m，朝前略向下：对照 Elan 431 的 “1809” 镜头
    bowside: { pos: [1.55, 0.95, 1.0], look: [0.9, -1.6, 6.0], fov: 75 },
    // 船尾正后方，朝后看尾迹：对照船尾尾迹镜头
    stern: { pos: [0.0, 1.6, -4.4], look: [0.0, -2.2, -22.0], fov: 75 },
    // 船首前视：对照船首相机（地平线、前帆）
    bow: { pos: [0.0, 1.7, 3.2], look: [0.0, 0.8, 40.0], fov: 85 },
  };
  const sync = () => page.evaluate(() => { const gl = window.__demo.ocean.renderer.getContext(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); });
  for (const [name, v] of Object.entries(views)) {
    await page.evaluate((v) => {
      window.__demo.cameraOverride = (cam, group) => {
        const p = group.localToWorld(new (cam.position.constructor)(...v.pos));
        const t = group.localToWorld(new (cam.position.constructor)(...v.look));
        cam.position.copy(p); cam.up.set(0, 1, 0).applyQuaternion(group.quaternion); cam.lookAt(t);
        if (cam.fov !== v.fov) { cam.fov = v.fov; cam.updateProjectionMatrix(); }
      };
    }, v);
    for (let i = 0; i < +(process.env.STEPS || 240); i += 24) { await page.evaluate(() => window.__demo.step(24, 1 / 20)); await sync(); }
    await page.evaluate(() => window.__demo.step(3, 1 / 30)); await sync();
    await page.evaluate(() => new Promise((r) => { let k = 0; const f = () => (++k >= 3 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
    console.log('[cam]', name, JSON.stringify(await page.evaluate(() => window.__demo.debug())));
    await h.shot(name);
  }
};
