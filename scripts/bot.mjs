// Lockstep autopilot across many seeds: node scripts/bot.mjs [url]
// Render is off, so results don't depend on GPU speed.
import { INSTALL_BOT, launch, open } from './lib.mjs';

const URL = process.argv[2] ?? 'http://localhost:5173/';
const SEEDS = +(process.env.SEEDS ?? 24);
const MAXD = +(process.env.MAXD ?? 6000);
const browser = await launch();
const { page, errors } = await open(browser, URL);
await page.evaluate(INSTALL_BOT);

const result = await page.evaluate(
  async ([SEEDS, MAXD]) => {
    const g = window.__game;
    const ev = window.__events;
    g.autoLoop = false;
    g.renderEnabled = false;
    g.tutorialOverride = false;
    const DT = 1 / 60;
    const tally = { nearMiss: 0, jump: 0, slide: 0, dodge: 0, bugFixed: 0, powerUps: 0, bossStart: 0, bossDeleted: 0, bossEscaped: 0, maxMult: 1, stages: 0 };
    ev.on('nearMiss', () => tally.nearMiss++);
    ev.on('obstacleCleared', (e) => tally[e.how]++);
    ev.on('bugFixed', () => tally.bugFixed++);
    ev.on('powerStart', () => tally.powerUps++);
    ev.on('bossStart', () => tally.bossStart++);
    ev.on('bossDeleted', () => tally.bossDeleted++);
    ev.on('bossEscaped', () => tally.bossEscaped++);
    ev.on('stage', () => tally.stages++);
    ev.on('combo', (e) => (tally.maxMult = Math.max(tally.maxMult, e.multiplier)));

    const runs = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      g.seed = seed;
      if (g.state === 'ready') {
        g.input.trigger('confirm');
        g.pause();
      }
      if (g.state === 'playing') g.pause();
      g.toReady();
      g.input.trigger('confirm');
      const bot = window.__bot(g);
      const hitsAt = [];
      const off = ev.on('hit', (e) => hitsAt.push({ d: Math.floor(g.distance), kind: e.kind, graze: e.graze, absorbed: e.absorbed }));
      let frames = 0;
      while (g.state === 'playing' && g.distance < MAXD && frames < 60 * 900) {
        frames++;
        bot(DT);
        g.stepFrame(DT);
      }
      off();
      runs.push({
        seed,
        state: g.state,
        distance: Math.floor(g.distance),
        score: Math.floor(g.score),
        bugs: g.bugsFixed,
        health: Math.round(g.health),
        stage: g.stage.id,
        hits: hitsAt.length,
        firstHits: hitsAt.slice(0, 4),
      });
      for (let i = 0; i < 100 && g.state === 'dying'; i++) g.stepFrame(DT);
      if (g.state === 'playing') g.pause();
    }
    g.seed = undefined;
    return { runs, tally };
  },
  [SEEDS, MAXD],
);

for (const r of result.runs) console.log(JSON.stringify(r));
const d = result.runs.map((r) => r.distance).sort((a, b) => a - b);
const hits = result.runs.map((r) => r.hits);
console.log('\ntally', JSON.stringify(result.tally));
console.log(
  'summary: median distance',
  d[Math.floor(d.length / 2)],
  '| min',
  d[0],
  '| survived to cap',
  result.runs.filter((r) => r.state === 'playing' || r.state === 'paused').length,
  '/',
  d.length,
  '| hits/run avg',
  (hits.reduce((a, b) => a + b, 0) / hits.length).toFixed(1),
);
console.log('errors', JSON.stringify(errors));
await browser.close();
