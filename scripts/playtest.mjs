// Automated playtest: node scripts/playtest.mjs [url]
// 1) independent fairness solver over many seeds, 2) real keyboard/touch controls, 3) pause/resume.
import { launch, open } from './lib.mjs';

const URL = process.argv[2] ?? 'http://localhost:5173/';
const browser = await launch();
const results = {};

// ------------------------------------------------------------- fairness
{
  const { page, errors } = await open(browser, URL);
  results.fairness = await page.evaluate(() => {
    const g = window.__game;
    g.autoLoop = false;
    g.renderEnabled = false;
    const report = [];
    for (let seed = 1; seed <= 40; seed++) {
      g.obstacles.clear();
      g.pickups.clear();
      g.spawner.reset(seed, false);
      const maxD = 9000;
      for (let d = 0; d < maxD; d += 4) {
        const speed = 15 + (40 - 15) * (1 - Math.exp(-d / 3300));
        g.spawner.update(d, speed, (speed - 15) / 25, 0.1);
      }
      const obs = [];
      g.obstacles.forEach((o) => {
        if (o.destroyed) return;
        const lane = o.toLane >= 0 ? o.toLane : o.lane;
        obs.push({ c: o.cls, k: o.kind, l: lane, a: o.dist, b: o.dist + o.depth });
      });
      // 1) Walls: a lane path must always exist.
      const hard = (l, d) => obs.some((o) => o.c === 'wall' && o.l === l && d > o.a - 0.4 && d < o.b + 0.4);
      let reach = [true, true, true];
      let fail = null;
      for (let d = 0; d < maxD - 200 && !fail; d += 0.5) {
        const speed = 15 + (40 - 15) * (1 - Math.exp(-d / 3300));
        const changeDist = speed * 0.16;
        const next = [0, 1, 2].map((l) => reach[l] && !hard(l, d + 0.5));
        let changed = true;
        while (changed) {
          changed = false;
          for (let l = 0; l < 3; l++) {
            if (!next[l]) continue;
            for (const n of [l - 1, l + 1]) {
              if (n < 0 || n > 2 || next[n]) continue;
              let ok = true;
              for (let t = 0; t <= changeDist; t += 0.5) if (hard(n, d + 0.5 + t)) ok = false;
              if (ok) {
                next[n] = true;
                changed = true;
              }
            }
          }
        }
        if (!next.some(Boolean)) fail = d;
        reach = next;
      }
      // 2) Never a jump and a slide needed at the same spot in one lane.
      let conflict = null;
      for (const a of obs) {
        if (a.c !== 'low') continue;
        for (const b of obs) {
          if (b.c === 'high' && b.l === a.l && Math.abs(b.a - a.a) < 2.5) conflict = conflict ?? a.a;
        }
      }
      const counts = obs.reduce((m, o) => ((m[o.k] = (m[o.k] || 0) + 1), m), {});
      report.push({ seed, fail, conflict, obstacles: obs.length, ...counts });
    }
    g.obstacles.clear();
    g.pickups.clear();
    return { seeds: report.length, failures: report.filter((r) => r.fail !== null || r.conflict !== null), sample: report[0] };
  });
  results.fairnessErrors = errors;
  await page.close();
}

// ----------------------------------------------------- controls (desktop)
{
  const { page, errors } = await open(browser, URL + '?quality=low');
  await page.evaluate(() => (window.__game.tutorialOverride = false));
  results.ready = await page.evaluate(() => window.__game.state);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  results.afterStart = await page.evaluate(() => window.__game.state);
  const probe = () => page.evaluate(() => ({ lane: window.__game.player.lane, grounded: window.__game.player.grounded, sliding: window.__game.player.sliding }));
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  const left = await probe();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(60);
  const jump = await probe();
  await page.waitForFunction(() => window.__game.player.grounded, null, { timeout: 5000 });
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(60);
  const slide = await probe();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const paused = await page.evaluate(() => window.__game.state);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const resumed = await page.evaluate(() => window.__game.state);
  results.keyboard = { leftLane: left.lane, jumped: !jump.grounded, slid: slide.sliding, paused, resumed };
  results.keyboardErrors = errors;
  await page.close();
}

// ----------------------------------------------------- controls (touch)
{
  const { page, errors } = await open(browser, URL + '?quality=low', { width: 390, height: 844 });
  await page.evaluate(() => (window.__game.tutorialOverride = false));
  await page.mouse.click(195, 600);
  await page.waitForTimeout(250);
  const started = await page.evaluate(() => window.__game.state);
  const swipe = async (dx, dy) => {
    await page.mouse.move(195, 600);
    await page.mouse.down();
    await page.mouse.move(195 + dx, 600 + dy, { steps: 4 });
    await page.mouse.up();
  };
  await swipe(-80, 2);
  await page.waitForTimeout(120);
  const lane = await page.evaluate(() => window.__game.player.lane);
  await swipe(2, -80);
  await page.waitForTimeout(40);
  const jumped = await page.evaluate(() => !window.__game.player.grounded);
  results.touch = { started, laneAfterSwipeLeft: lane, jumpedBySwipeUp: jumped };
  results.touchErrors = errors;
  await page.close();
}

console.log(JSON.stringify(results, null, 1));
await browser.close();
