// Regression check: a GPU reset mid-run (what iOS does when it drops the
// WebGL context) must NOT reload the page. The run pauses, graphics are
// rebuilt in place and the picture comes back.
// usage: node scripts/check-gpu-reset.mjs [url]   (dev server running)
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/?seed=7';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' });
const page = await ctx.newPage();
const errors = [];
let navigations = 0;
page.on('pageerror', (e) => errors.push(e.message));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
await page.goto(url, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__game?.player.character.hasModel, null, { timeout: 300000 });
const nav0 = navigations;
await page.evaluate(() => {
  const g = window.__game;
  window.__marker = 'same-page';
  g.tutorialOverride = false;
  g.input.trigger('confirm');
  g.player.grace(1e9);
});
await page.waitForTimeout(4000);
const d0 = await page.evaluate(() => window.__game.distance);
await page.evaluate(() => {
  const ext = window.__game.renderer.getContext().getExtension('WEBGL_lose_context');
  ext.loseContext();
  setTimeout(() => ext.restoreContext(), 1000);
});
await page.waitForTimeout(8000);
const after = await page.evaluate(async () => {
  const g = window.__game;
  const res = { samePage: window.__marker === 'same-page', state: g.state, d: g.distance, lost: g.renderer.getContext().isContextLost() };
  g.resume();
  await new Promise((r) => setTimeout(r, 1500));
  const gl = g.renderer.getContext();
  const px = new Uint8Array(4);
  let lit = 0;
  for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
    g.stepFrame(1 / 60);
    gl.readPixels((gl.drawingBufferWidth * i) / 4, (gl.drawingBufferHeight * j) / 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (px[0] + px[1] + px[2] > 12) lit++;
  }
  return { ...res, litSamples: lit, stateAfterResume: g.state };
});
const ok = after.samePage && navigations === nav0 && after.state === 'paused' && after.d >= d0 && !after.lost && after.litSamples >= 6 && after.stateAfterResume === 'playing' && errors.length === 0;
console.log(JSON.stringify({ ok, ...after, reloaded: navigations !== nav0, errors }, null, 1));
await browser.close();
process.exit(ok ? 0 : 1);
