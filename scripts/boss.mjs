// Boss encounters end to end: node scripts/boss.mjs [url]
// Lockstep autopilot plays every boss: RUNNING -> WARNING -> INTRO -> FIGHT -> DEFEATED -> VICTORY -> NEXT_LEVEL.
import { INSTALL_BOT, launch, open } from './lib.mjs';
const URL = process.argv[2] ?? 'http://localhost:5173/';
const browser = await launch();
const { page, errors } = await open(browser, URL);
await page.evaluate(INSTALL_BOT);
const fails = [];
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); if (!ok) fails.push(n); };
const r = await page.evaluate(() => {
  const g = window.__game, ev = window.__events;
  g.autoLoop = false; g.renderEnabled = false; g.tutorialOverride = false; g.seed = 5;
  const log = [];
  for (const k of ['bossWarning', 'bossStart', 'bossImpact', 'bossActive', 'bossPhase', 'bossDeleted', 'bossEnd']) ev.on(k, (e) => log.push(k + (e?.phase !== undefined ? e.phase : '')));
  const hits = []; ev.on('bossHit', (e) => hits.push(e.kind));
  const stages = []; ev.on('stage', (e) => stages.push(e.id));
  g.input.trigger('confirm');
  const bot = window.__bot(g);
  const DT = 1 / 60;
  const out = [];
  for (let b = 0; b < 4; b++) {
    // Jump to just before this boss's trigger point.
    const at = [1050, 2550, 3450, 4450][b];
    const d = at - 30 + g.boss.encounterDist;
    g.distance = g.prevDistance = d;
    g.player.grace(1);
    const states = [];
    let frames = 0, hitsBefore = g.hits, maxHp = 0, lockedMoves = 0;
    while (g.state === 'playing' && frames < 60 * 240) {
      frames++;
      if (g.boss.state !== states[states.length - 1]) states.push(g.boss.state);
      if (g.boss.state === 'running' && states.includes('nextLevel')) break;
      if (g.boss.state === 'fight') maxHp = g.boss.maxHp;
      if (g.health < 45) g.health = 100; // keep the run alive; hits are counted
      bot(DT);
      g.stepFrame(DT);
    }
    out.push({ boss: b, states: states.join('>'), secs: Math.round(frames / 60), hitsTaken: g.hits - hitsBefore, maxHp, stage: g.stage.id, state: g.state });
    if (g.state !== 'playing') break;
  }
  return { out, log: log.join(' '), hits: [hits.filter((k) => k === 'patch').length, hits.filter((k) => k === 'dodge').length], stages, defeated: g.boss.defeated, obstacleKinds: [...new Set(g.obstacles ? [] : [])] };
});
for (const o of r.out) console.log(JSON.stringify(o));
const full = 'running>warning>intro>fight>defeated>victory>nextLevel>running';
r.out.forEach((o, i) => check(`boss ${i + 1}: full encounter flow`, o.states === full && o.state === 'playing', o.states));
check('all four bosses defeated', r.defeated === 4, `${r.defeated}`);
check('damage from patches and perfect dodges', r.hits[0] > 10 && r.hits[1] > 0, JSON.stringify(r.hits));
check('phases change mid-fight', /bossPhase1/.test(r.log) && /bossPhase3/.test(r.log));
check('each win opens the next area', JSON.stringify(r.out.map((o) => o.stage)) === '[3,5,6,7]', JSON.stringify(r.out.map((o) => o.stage)));
check('fights are winnable without many hits', r.out.every((o) => o.hitsTaken <= 6), r.out.map((o) => o.hitsTaken).join(','));
// Death mid-fight -> game over -> restart works and the boss is gone.
const d = await page.evaluate(() => {
  const g = window.__game;
  g.boss.trigger(0);
  for (let i = 0; i < 60 * 12; i++) g.stepFrame(1 / 60);
  const mid = g.boss.state;
  g.die({ kind: 'laser' });
  for (let i = 0; i < 200 && g.state !== 'gameover'; i++) g.stepFrame(1 / 60);
  const over = g.state;
  g.restart(true);
  for (let i = 0; i < 30; i++) g.stepFrame(1 / 60);
  return { mid, over, after: g.state, boss: g.boss.state, bar: document.getElementById('h-bossbar').classList.contains('show') };
});
check('death during a fight -> game over -> restart', d.mid === 'fight' && d.over === 'gameover' && d.after === 'playing' && d.boss === 'running' && !d.bar, JSON.stringify(d));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(fails.length ? `${fails.length} FAILED` : 'all boss checks passed');
process.exit(fails.length ? 1 : 0);
