// Visual check of key moments: node scripts/shot.mjs <outdir>
import { chromium } from 'playwright';
const OUT = process.argv[2] ?? 'shots';
const W = +(process.env.W ?? 1280), H = +(process.env.H ?? 720);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/swiftshader|GPU stall|WebGL/.test(m.text()) && errors.push(m.text()));
await page.goto(`http://localhost:5173/?seed=3&quality=${process.env.Q ?? 'high'}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__game, null, { timeout: 240000 });
await page.waitForFunction(() => window.__game.player.character.hasModel, null, { timeout: 120000 }).catch(() => console.log('NO MODEL'));
const step = (fn, frames) => page.evaluate(([src, frames]) => {
  const g = window.__game; g.autoLoop = false; g.renderEnabled = false;
  new Function('g', src)(g);
  for (let i = 0; i < frames; i++) g.stepFrame(1 / 60);
  g.renderEnabled = true; g.stepFrame(1 / 60);
}, [fn, frames]);
const snap = async (name, fn = '', frames = 0, wait = 0) => {
  await step(fn, frames);
  if (wait) { await page.waitForTimeout(wait); await step('', 0); }
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 240000 });
};
const only = (process.env.ONLY ?? '').split(',').filter(Boolean);
const want = (n) => !only.length || only.includes(n);

await page.evaluate(() => { const g = window.__game; g.autoLoop = false; g.stepFrame(1 / 60); });
await snap('01-menu', '', 90, 400);
await snap('02-run', "g.input.trigger('confirm')", 60, 300);
if (want('bug')) await snap('03-bugfix', "g.pickups.spawn('goodBug', g.player.lane, g.distance + 4)", 14, 250);
await snap('04-hazards', '', 150);
if (want('debug')) await snap('05-debug', "g.powers.activate('debug')", 50, 300);
if (want('admin')) await snap('06-admin', "g.powers.reset(); g.powers.activate('admin')", 50, 300);
if (want('shield')) await snap('07-firewall', "g.powers.reset(); g.powers.activate('firewall')", 30, 200);
if (want('stage')) await snap('08-stage4', "g.powers.reset(); g.distance = 1760; g.prevDistance = 1760;", 120, 200);
if (want('boss')) await snap('09-boss', "g.boss.begin()", 220, 200);
if (want('boss')) await snap('10-boss-active', "g.player.grace(99);", 120, 100);
if (want('core')) await snap('11-core', "g.player.grace(99); g.distance = 4460; g.prevDistance = 4460;", 400, 300);
if (want('over')) await snap('12-gameover', "g.player.grace(0); g.powers.reset(); g.player.invuln = 0; g.health = 5; g.obstacles.spawn('corruptBlock', g.player.lane, g.distance + 3, { depth: 8 });", 200, 700);
if (want('over')) {
  await page.evaluate(() => { window.__game.autoLoop = true; });
  await page.click('#b-restart');
  await page.waitForTimeout(550);
  await page.screenshot({ path: `${OUT}/13-reboot.png` });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}/14-restored.png` });
}
console.log(JSON.stringify({ errors, state: await page.evaluate(() => window.__game.state) }));
await browser.close();
