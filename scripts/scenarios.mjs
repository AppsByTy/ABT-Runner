// Scenario tests for hazard classification, damage and power-ups: node scripts/scenarios.mjs [url]
import { launch, open } from './lib.mjs';

const URL = process.argv[2] ?? 'http://localhost:5173/';
const browser = await launch();
const { page, errors } = await open(browser, URL);

const results = await page.evaluate(() => {
  const g = window.__game;
  const ev = window.__events;
  g.autoLoop = false;
  g.renderEnabled = false;
  g.tutorialOverride = false;
  const log = [];
  ev.on('nearMiss', (e) => log.push(`nearMiss:${e.style}`));
  ev.on('obstacleCleared', (e) => log.push(`cleared:${e.how}`));
  ev.on('hit', (e) => log.push(e.absorbed ? 'absorbed' : `hit:${e.graze ? 'graze' : 'full'}(-${e.damage})`));
  ev.on('obstacleDeleted', (e) => log.push(`deleted${e.badBug ? ':bug' : ''}`));
  ev.on('bugFixed', () => log.push('bugFixed'));
  ev.on('death', () => log.push('death'));

  const fresh = () => {
    if (g.state === 'ready') { g.input.trigger('confirm'); g.pause(); }
    if (g.state === 'playing') g.pause();
    for (let i = 0; i < 120 && g.state === 'dying'; i++) g.stepFrame(1 / 60);
    g.toReady();
    g.input.trigger('confirm');
    g.spawner.update = () => {};
    g.obstacles.clear();
    g.pickups.clear();
    for (let i = 0; i < 30; i++) g.stepFrame(1 / 60);
    log.length = 0;
  };
  const until = (pred, max = 700) => { for (let i = 0; i < max && g.state === 'playing' && !pred(); i++) g.stepFrame(1 / 120); };

  // Obstacle in the middle lane; action fired when it's `t` seconds away.
  const run = (kind, action, t, setup) => {
    fresh();
    setup?.();
    const o = g.obstacles.spawn(kind, 1, g.distance + 40, kind === 'corruptBlock' ? { depth: 8 } : {});
    let fired = !action;
    until(() => {
      if (!fired && (o.dist - g.distance - 0.3) / g.speed <= t) { g.input.trigger(action); fired = true; }
      return o.passed || o.destroyed && o.dist < g.distance - 2;
    });
    for (let i = 0; i < 30; i++) g.stepFrame(1 / 120);
    return `${log.join(',') || '(none)'} | health ${Math.round(g.health)}`;
  };

  const out = {
    'block, dodge 0.60s early': run('corruptBlock', 'left', 0.6),
    'block, dodge 0.15s late': run('corruptBlock', 'left', 0.15),
    'firewall, jump 0.40s early': run('firewall', 'jump', 0.4),
    'firewall, jump 0.13s late': run('firewall', 'jump', 0.13),
    'firewall, jump too late -> damage': run('firewall', 'jump', 0.03),
    'error window, slide 0.40s early': run('errorWindow', 'slide', 0.4),
    'error window, slide 0.08s late': run('errorWindow', 'slide', 0.08),
    'virus drone, no slide -> damage': run('virusDrone', null, 0),
    'block head-on -> damage': run('corruptBlock', null, 0),
    'firewall power-up absorbs a hit': run('corruptBlock', null, 0, () => g.powers.activate('firewall')),
    'debug mode auto-fixes a bad bug': run('glitchBug', null, 0, () => g.powers.activate('debug')),
    'admin access deletes hazards': run('corruptBlock', null, 0, () => g.powers.activate('admin')),
  };

  // Friendly bug: fix it, health +5 (from 80).
  fresh();
  g.health = 80;
  g.pickups.spawn('goodBug', 1, g.distance + 6);
  until(() => g.bugsFixed > 0, 400);
  out['friendly bug fixed, +5 health'] = `${log.join(',')} | bugs ${g.bugsFixed} | health ${Math.round(g.health)}`;

  // Five full hits in a row = system crash.
  fresh();
  let crashedAfter = 0;
  for (let i = 0; i < 6 && g.state === 'playing'; i++) {
    g.player.grace(0);
    g.player.invuln = 0;
    const o = g.obstacles.spawn('corruptBlock', g.player.lane, g.distance + 4, { depth: 3 });
    until(() => o.destroyed || g.state !== 'playing', 200);
    crashedAfter = i + 1;
  }
  out['repeated hits crash the system'] = `crashed=${g.state === 'dying' || g.state === 'gameover'} after ${crashedAfter} hits | health ${Math.round(g.health)}`;

  // Boss: patches damage it until it is deleted.
  fresh();
  g.boss.trigger(0);
  for (let i = 0; i < 60 * 10 && g.boss.state !== 'fight'; i++) g.stepFrame(1 / 60);
  for (let k = 0; k < 20 && g.boss.state === 'fight'; k++) {
    g.player.grace(99);
    g.pickups.spawn('bossPatch', g.player.lane, g.distance + 3, 1.0);
    for (let i = 0; i < 30; i++) g.stepFrame(1 / 60);
  }
  out['boss defeated by patches'] = `state ${g.boss.state} | hp ${g.boss.hp}/${g.boss.maxHp}`;
  return out;
});
console.log(JSON.stringify(results, null, 1));
console.log('errors', JSON.stringify(errors));
await browser.close();
