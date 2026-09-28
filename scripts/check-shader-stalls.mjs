// Regression check: nothing may compile (or throw away) a GPU shader during a
// run. Steps the game frame by frame through power-ups, stage changes and the
// boss, and fails if the shader program set changes or a frame stalls.
// usage: node scripts/check-shader-stalls.mjs [url]   (dev server running; slow on a software GPU)
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/?seed=7';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__game?.player.character.hasModel, null, { timeout: 300000 });
const res = await page.evaluate(async () => {
  const g = window.__game;
  const R = g.renderer;
  const gl = R.getContext();
  await new Promise((r) => setTimeout(r, 3000)); // menu: shaders + first draws are warmed here
  const progs = () => new Set(R.info.programs);
  const events = [];
  const stalls = [];
  const times = [];
  g.autoLoop = false;
  g.tutorialOverride = false;
  g.input.trigger('confirm');
  g.player.grace(1e9);
  const step = (n, label) => {
    for (let i = 0; i < n; i++) {
      const before = progs();
      const t = performance.now();
      g.stepFrame(1 / 60);
      gl.finish();
      const ms = performance.now() - t;
      times.push(ms);
      const after = progs();
      const added = [...after].filter((p) => !before.has(p)).length;
      const removed = [...before].filter((p) => !after.has(p)).length;
      if (added || removed) events.push({ during: label, added, removed });
      if (times.length > 30) {
        const sorted = [...times].sort((a, b) => a - b);
        if (ms > sorted[sorted.length >> 1] * 6) stalls.push({ during: label, ms: Math.round(ms) });
      }
    }
  };
  step(180, 'running');
  for (const p of ['boost', 'magnet', 'debug', 'admin', 'firewall', 'ram']) {
    g.powers.activate(p);
    step(45, `power ${p}`);
  }
  for (const at of [450, 1050]) {
    g.distance = at - 10;
    step(60, `stage@${at}`);
  }
  g.distance = 1345;
  step(240, 'boss');
  times.sort((a, b) => a - b);
  return { programChanges: events, stalls, programs: R.info.programs.length, medianMs: Math.round(times[times.length >> 1]), maxMs: Math.round(times[times.length - 1]) };
});
const ok = res.programChanges.length === 0 && res.stalls.length === 0 && errors.length === 0;
console.log(JSON.stringify({ ok, ...res, errors }, null, 1));
await browser.close();
process.exit(ok ? 0 : 1);
