// node tools/play.cjs tests/ocean/fft-check.html out/fft tests/ocean/fft-check.cjs --root=.
module.exports = async (page) => {
  await page.waitForFunction(() => window.__fftResult, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.__fftResult);
  console.log('[fft]', JSON.stringify(r));
  if (!r.ok) throw new Error('GPU FFT 与 CPU DFT 不一致');
};
