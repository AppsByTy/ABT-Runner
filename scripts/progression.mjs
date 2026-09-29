// Progression checks (profile, levels, coin bank, missions, multiplier, saves):
//   node scripts/progression.mjs [url]
// Lockstep, render off. Each check prints PASS/FAIL; exit code 1 on any failure.
import { launch, open } from './lib.mjs';

const URL = process.argv[2] ?? 'http://localhost:5173/';
const browser = await launch();
let { page, errors } = await open(browser, URL);
const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) fails.push(name);
};

// Reload the page with a given localStorage state (null = leave as is).
const reload = async (storage) => {
  await page.evaluate((s) => {
    if (s) {
      localStorage.clear();
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }, storage);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game && window.__events, null, { timeout: 240000 });
  await page.evaluate(() => {
    const g = window.__game;
    g.autoLoop = false;
    g.renderEnabled = false;
    g.tutorialOverride = false;
    const ev = window.__events;
    window.__log = [];
    ev.on('missionComplete', (e) => window.__log.push(`mission:${e.text}:${e.xp}`));
    ev.on('missionSetComplete', (e) => window.__log.push(`set:x${e.mult}`));
    // Helpers: start a run, run the empty track to a distance, end the run.
    window.__h = {
      start() {
        if (g.state === 'playing') g.pause();
        if (g.state === 'paused' || g.state === 'gameover') g.toReady();
        g.input.trigger('confirm');
        g.spawner.update = () => {};
        g.obstacles.clear();
        g.pickups.clear();
      },
      runTo(d) {
        for (let i = 0; i < 60 * 600 && g.state === 'playing' && g.distance < d; i++) g.stepFrame(1 / 60);
      },
      die() {
        g.die({ kind: 'firewall' });
        for (let i = 0; i < 200 && g.state === 'dying'; i++) g.stepFrame(1 / 60);
      },
    };
  });
};

const P = 'coderunner.profile.v1';
const get = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__game.profile.data)));

// 1. Fresh profile
await reload({ 'coderunner.flight.v1': '{"closed":true}' });
let p = await get();
check('fresh profile: level 1, empty bank, x1, set 0', p.totalXp === 0 && p.bank === 0 && p.mult === 1 && p.set === 0 && p.best === 0);
check('fresh profile: intro missions', p.missions.map((m) => `${m.kind}:${m.target}`).join(',') === 'bugs:3,dist:250,jump:3', p.missions.map((m) => `${m.kind}:${m.target}`).join(','));
check('fresh profile: saved to storage', await page.evaluate((k) => !!localStorage.getItem(k), P));

// 2. Migration from the Phase 1-3 keys
await reload({ 'coderunner.best.v1': { v: 12345 }, 'coderunner.lifetime.v1': { runs: 5, xp: 400, coins: 321, bugsFixed: 20 }, 'coderunner.flight.v1': '{"closed":true}' });
p = await get();
const lv = await page.evaluate(() => window.__game.profile.level);
check('migration: best, XP, bank, runs', p.best === 12345 && p.totalXp === 400 && p.bank === 321 && p.stats.runs === 5 && p.stats.bugsFixed === 20, JSON.stringify({ best: p.best, xp: p.totalXp, bank: p.bank, runs: p.stats.runs }));
check('migration: 400 XP = level 3 (+25)', lv.level === 3 && lv.into === 25 && lv.need === 300 && lv.rank === 'JUNIOR DEV', JSON.stringify(lv));
check('migration: menu shows it', await page.evaluate(() => document.getElementById('p-lvl').textContent === '3' && document.getElementById('p-bank').textContent === '321'));

// 3. A run: distance mission, distance XP, coins banked, results screen
await reload({ 'coderunner.flight.v1': '{"closed":true}' });
let r = await page.evaluate(() => {
  const g = window.__game, h = window.__h;
  h.start();
  g.coinCount = 0;
  h.runTo(260);
  const midXp = g.xp;
  const midLog = [...window.__log];
  const toastShown = document.getElementById('h-mtoast').classList.contains('go');
  g.coinCount = 37;
  h.die();
  const rows = [...document.querySelectorAll('#o-mlist .ms')].map((e) => e.className);
  return { state: g.state, midXp, midLog, toastShown, rows, bank: document.getElementById('o-bank').textContent, xpnum: document.getElementById('o-xpnum').textContent, p: JSON.parse(JSON.stringify(g.profile.data)) };
});
check('run: 250 m mission completes mid-run (+50 XP)', r.midLog.includes('mission:Run 250 m in one run:50'), r.midLog.join(' '));
check('run: MISSION COMPLETE card shown', r.toastShown);
check('run: distance XP (26) + mission XP (50)', r.midXp === 76, `xp ${r.midXp}`);
check('run: results screen', r.state === 'gameover');
check('run: finished mission ticked on results', r.rows[1]?.includes('done') && r.rows[1]?.includes('fresh') && !r.rows[0].includes('done'), r.rows.join(' | '));
check('run: coins banked', r.p.bank === 37 && r.bank === '37', `bank ${r.p.bank}`);
check('run: XP saved', r.p.totalXp === 76 && r.xpnum === '+76 XP', `${r.p.totalXp} ${r.xpnum}`);
check('run: stats', r.p.stats.runs === 1 && r.p.stats.distance >= 260 && r.p.stats.bestDistance >= 260);
check('run: best score saved', r.p.best > 0);

// 4. Per-run missions keep the best attempt; "in one run" progress does not add up
r = await page.evaluate(() => {
  const g = window.__game, h = window.__h;
  const m = g.profile.data.missions;
  m[2].progress = 0; // jump
  h.start();
  for (let i = 0; i < 2; i++) window.__events.emit('obstacleCleared', { kind: 'firewall', how: 'jump', x: 0, y: 0, z: 0 });
  window.__events.emit('nearMiss', { kind: 'firewall', style: 'vertical', how: 'jump', x: 0, y: 0, z: 0 });
  h.runTo(30);
  const after3 = m[2].done;
  h.die();
  return { after3, log: window.__log.slice(-2) };
});
check('jump mission counts clean jumps and near-miss jumps', r.after3, r.log.join(' '));

// 5. Set complete -> multiplier, reward, next set
r = await page.evaluate(() => {
  const g = window.__game, h = window.__h;
  const d = g.profile.data;
  d.totalXp = 0; // keep a level-up out of this check
  const bank0 = d.bank;
  d.missions[0].progress = 2; // bugs 2/3
  window.__log.length = 0;
  h.start();
  g.bugsFixed = 3;
  h.runTo(20);
  const log = [...window.__log];
  const toastSet = document.getElementById('h-mtoast').classList.contains('set');
  h.die();
  const setLine = document.getElementById('o-set');
  return { log, toastSet, mult: d.mult, set: d.set, next: d.missions.map((m) => `${m.kind}:${m.target}`).join(','), banked: d.bank - bank0, has: setLine.classList.contains('has'), text: setLine.textContent, omult: document.getElementById('o-mult').textContent };
});
check('set: third mission completes the set', r.log.includes('set:x2'), r.log.join(' '));
check('set: toast says so', r.toastSet);
check('set: multiplier x2, set 1', r.mult === 2 && r.set === 1);
check('set: next set generated', r.next === 'coins:60,combo:2,slide:5', r.next);
check('set: reward banked (100)', r.banked === 100, `banked ${r.banked}`);
check('set: results screen shows payout', r.has && /×1 → ×2/.test(r.text) && r.omult === 'SCORE ×2', r.text);

// 6. Multiplier applies from the next run
r = await page.evaluate(() => {
  const g = window.__game, h = window.__h;
  h.start();
  const s0 = g.score;
  g.addScore(100);
  const lbl = document.getElementById('h-slbl').textContent;
  const got = g.score - s0;
  h.die();
  return { runMult: g.runMult, got, lbl };
});
check('mult: run uses x2', r.runMult === 2 && r.got === 200, JSON.stringify(r));
check('mult: HUD shows it', r.lbl.replace(/\s+/g, ' ').trim() === 'SCORE ×2', r.lbl);

// 7. Level up: coins banked, results pill
r = await page.evaluate(async () => {
  const g = window.__game, h = window.__h;
  const d = g.profile.data;
  d.totalXp = 140;
  const bank0 = d.bank;
  h.start();
  g.coinCount = 0;
  h.runTo(120); // 12 distance XP -> 152
  h.die();
  await new Promise((res) => setTimeout(res, 1600));
  const up = document.getElementById('o-levelup');
  return { level: g.profile.level.level, banked: d.bank - bank0, show: up.classList.contains('show'), text: up.textContent, lvl: document.getElementById('o-lvl').textContent };
});
check('level: 150 XP -> level 2', r.level === 2);
check('level: +50 coins banked', r.banked === 50, `banked ${r.banked}`);
check('level: LEVEL UP shown on results', r.show && r.lvl === '2' && /LEVEL 2 · \+50 COINS/.test(r.text), r.text);

// 8. Quitting from pause still saves the run
r = await page.evaluate(() => {
  const g = window.__game, h = window.__h;
  const d = g.profile.data;
  const bank0 = d.bank, runs0 = d.stats.runs;
  h.start();
  g.coinCount = 11;
  h.runTo(50);
  g.pause();
  const pauseRows = document.querySelectorAll('#p-pmlist .ms').length;
  g.toReady();
  return { banked: d.bank - bank0, runs: d.stats.runs - runs0, state: g.state, pauseRows };
});
check('quit: pause screen lists missions', r.pauseRows === 3);
check('quit: coins banked and run counted', r.banked === 11 && r.runs === 1 && r.state === 'ready', JSON.stringify(r));

// 9. Running totals add up across runs
r = await page.evaluate(() => {
  const g = window.__game, h = window.__h;
  const d = g.profile.data;
  d.set = 2;
  d.missions = [
    { kind: 'tDist', target: 2000, progress: 0, done: false },
    { kind: 'near', target: 3, progress: 0, done: false },
    { kind: 'power', target: 2, progress: 0, done: false },
  ];
  h.start();
  h.runTo(300);
  h.die();
  const a = d.missions[0].progress;
  h.start();
  h.runTo(200);
  h.die();
  return { a, b: d.missions[0].progress };
});
check('totals: tDist adds up (300 + 200)', r.a >= 300 && r.a < 310 && r.b >= 500 && r.b < 515, JSON.stringify(r));

// 10. Saved across reloads
const before = await get();
await reload(null);
p = await get();
check('persist: profile survives a reload', JSON.stringify(p) === JSON.stringify(before));

// 11. A set finished right before the page closed is paid out on the next launch
await page.evaluate((k) => {
  const d = JSON.parse(localStorage.getItem(k));
  d.missions.forEach((m) => (m.done = true));
  d.bank = 1000;
  localStorage.setItem(k, JSON.stringify(d));
}, P);
await reload(null);
p = await get();
check('payout on load: x+1, set+1, reward, fresh set', p.mult === before.mult + 1 && p.set === before.set + 1 && p.bank === 1000 + 100 + 50 * before.set && p.missions.every((m) => !m.done), JSON.stringify({ mult: p.mult, set: p.set, bank: p.bank }));

// 12. Corrupt storage never breaks the game
await reload({ [P]: '{"best":"lots","mult":999,"missions":[{"kind":"nope"}],"stats":null}', 'coderunner.flight.v1': '{"closed":true}' });
p = await get();
check('corrupt save: sanitised', p.best === 0 && p.mult === 30 && p.missions.length === 3 && p.stats.runs === 0, JSON.stringify({ best: p.best, mult: p.mult, n: p.missions.length }));

// 13. Generated sets: deterministic, 3 distinct, at most one running total, no repeated stat
r = await page.evaluate(async () => {
  const { generateSet } = await import('/src/game/Missions.ts');
  const bad = [];
  const kinds = new Set();
  for (let s = 0; s < 60; s++) {
    const a = generateSet(s), b = generateSet(s);
    if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${s}: not deterministic`);
    const k = a.map((m) => m.kind);
    k.forEach((x) => kinds.add(x));
    if (new Set(k).size !== 3) bad.push(`${s}: duplicate`);
    if (k.filter((x) => x.startsWith('t')).length > 1) bad.push(`${s}: two totals ${k}`);
    if (a.some((m) => !(m.target > 0))) bad.push(`${s}: bad target`);
  }
  return { bad, kinds: kinds.size };
});
check('generated sets are valid', r.bad.length === 0 && r.kinds >= 15, `${r.bad.slice(0, 3).join('; ')} kinds ${r.kinds}`);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall progression checks passed');
process.exit(fails.length ? 1 : 0);
