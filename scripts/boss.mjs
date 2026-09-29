// Boss fights end to end + the combat playtest checklist: node scripts/boss.mjs [url]
// Lockstep autopilot plays every boss like a person (reaction time, input pace,
// occasional fumbles): RUNNING -> WARNING -> INTRO -> FIGHT -> DEFEATED -> VICTORY -> NEXT_LEVEL.
import { INSTALL_BOT, launch, open } from './lib.mjs';
const URL = process.argv[2] ?? 'http://localhost:5173/';
const browser = await launch();
const { page, errors } = await open(browser, URL);
await page.evaluate(INSTALL_BOT);
// A fresh run from any state (restart only works from game over).
await page.evaluate(() => {
  window.__fresh = (g) => {
    g.autoLoop = false; g.renderEnabled = false;
    if (g.state === 'ready') g.input.trigger('confirm');
    else {
      if (g.state === 'playing') g.die({ kind: 'laser' });
      for (let i = 0; i < 400 && g.state !== 'gameover'; i++) g.stepFrame(1 / 60);
      g.restart(true);
    }
    for (let i = 0; i < 60; i++) g.stepFrame(1 / 60);
  };
});
const fails = [];
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); if (!ok) fails.push(n); };

/** Play all four bosses with a given player skill. Health is topped up between fights only. */
const campaign = (skill) => page.evaluate((skill) => {
  const g = window.__game, ev = window.__events;
  window.__botSkill = skill;
  g.autoLoop = false; g.renderEnabled = false; g.tutorialOverride = false; g.seed = 5;
  window.__fresh(g);
  const log = [];
  const offs = [];
  for (const k of ['bossWarning', 'bossStart', 'bossImpact', 'bossActive', 'bossPhase', 'bossDeleted', 'bossEnd']) offs.push(ev.on(k, (e) => log.push(k + (e?.phase !== undefined ? e.phase : ''))));
  const kinds = {}; offs.push(ev.on('bossHit', (e) => (kinds[e.kind] = (kinds[e.kind] || 0) + 1)));
  const bot = window.__bot(g);
  const DT = 1 / 60;
  const out = [];
  for (let b = 0; b < 4; b++) {
    const at = [1050, 2550, 3450, 4450][b];
    g.distance = g.prevDistance = at - 30 + g.boss.encounterDist;
    g.health = 100;
    g.player.grace(1);
    const states = [];
    let frames = 0, maxHp = 0, maxCombo = 0, minHealth = 100;
    const tune = [];
    const per = {};
    while (g.state === 'playing' && frames < 60 * 300) {
      frames++;
      const B = g.boss;
      if (B.state !== states[states.length - 1]) states.push(B.state);
      const key = B.state + (B.seq ? ':seq' : B.attack ? ':atk' : '') + (g.timeScale < 0.9 ? ':slow' : '');
      per[key] = (per[key] || 0) + 1;
      if (B.state === 'running' && states.includes('nextLevel')) break;
      if (B.state === 'fight') {
        maxHp = B.maxHp;
        maxCombo = Math.max(maxCombo, B.combo);
        minHealth = Math.min(minHealth, g.health);
        if (!tune[B.phase]) tune[B.phase] = { lead: +B.lead.toFixed(2), tele: +B.tele.toFixed(2), gap: +B.gap.toFixed(2), perStep: +Math.max(0.36, B.def.combat.perStep - B.phase * 0.06).toFixed(2) };
      }
      bot(DT);
      g.stepFrame(DT);
    }
    out.push({ boss: g.boss.defeated > b ? 'down' : 'ALIVE', n: b + 1, states: states.join('>'), secs: Math.round(frames / 60), maxHp, maxCombo, minHealth: Math.round(minHealth), stats: { ...g.boss.stats }, tune, per: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, +(v / 60).toFixed(1)])), speed: +g.speed.toFixed(1), stage: g.stage.id, state: g.state });
    if (g.state !== 'playing') break;
  }
  offs.forEach((f) => f());
  return { out, log: log.join(' '), kinds, defeated: g.boss.defeated };
}, skill);

// ---- A good player: the full campaign.
const good = await campaign({ react: 0.32, step: 0.24, miss: 0.05 });
for (const o of good.out) console.log(JSON.stringify(o));
console.log('hit kinds', JSON.stringify(good.kinds));
const full = 'running>warning>intro>fight>defeated>victory>nextLevel>running';
good.out.forEach((o, i) => check(`boss ${i + 1}: full encounter flow`, o.states === full && o.state === 'playing', o.states));
check('all four bosses defeated', good.defeated === 4, `${good.defeated}`);
check('each win opens the next area', JSON.stringify(good.out.map((o) => o.stage)) === '[3,5,6,7]', JSON.stringify(good.out.map((o) => o.stage)));
const S = (k) => good.out.map((o) => o.stats[k]);
const sum = (k) => S(k).reduce((a, b) => a + b, 0);
check('2. dodges work (clean dodges -> weak points / counters)', S('dodges').every((n) => n > 0) && sum('crit') > 0 && sum('counter') > 0, `dodges ${S('dodges')} crit ${S('crit')} counter ${S('counter')}`);
check('3. touch sequences register', S('ok').every((n) => n >= 4), `ok ${S('ok')}`);
check('6. combos build (x3+ in every fight)', good.out.every((o) => o.maxCombo >= 3), good.out.map((o) => o.maxCombo).join(','));
check('7. phase transitions (3 phases, 4 for the final boss)', /bossPhase1/.test(good.log) && /bossPhase2/.test(good.log) && /bossPhase3/.test(good.log), good.log.match(/bossPhase\d/g)?.join(' '));
check('8. special attacks fire', sum('special') >= 2 && good.kinds.special >= 2, `specials ${S('special')}`);
check('PERFECT attacks happen', sum('perfect') > 0, `perfect ${S('perfect')}`);
const harder = good.out.every((o) => {
  const t = o.tune.filter(Boolean), a = t[0], z = t[t.length - 1];
  return t.length >= 3 && z.lead < a.lead && z.tele < a.tele && z.gap < a.gap && z.perStep < a.perStep;
});
check('9. later phases are harder (less reaction time, shorter gaps and windows)', harder, good.out.map((o) => o.tune.map((t) => `${t.lead}/${t.tele}/${t.gap}/${t.perStep}`).join(' > ')).join(' | '));

// ---- 10. An average player (slower, fumbles) can still win every fight.
const avg = await campaign({ react: 0.45, step: 0.33, miss: 0.2 });
for (const o of avg.out) console.log('avg', JSON.stringify({ n: o.n, boss: o.boss, secs: o.secs, minHealth: o.minHealth, stats: o.stats, per: o.per, speed: o.speed }));
check('10. every boss is beatable by an average player', avg.defeated === 4 && avg.out.every((o) => o.state === 'playing'), avg.out.map((o) => `${o.boss} ${o.secs}s hp${o.minHealth}`).join(', '));
check('fumbles happen and are punished', avg.out.some((o) => o.stats.fail > 0), avg.out.map((o) => o.stats.fail).join(','));

// ---- Targeted checks on boss 1.
const t = await page.evaluate(() => {
  const g = window.__game, ev = window.__events, B = g.boss;
  window.__fresh(g);
  const DT = 1 / 60;
  const step = (n) => { for (let i = 0; i < n; i++) g.stepFrame(DT); };
  const until = (f, max = 60 * 30) => { for (let i = 0; i < max && !f(); i++) g.stepFrame(DT); return f(); };
  B.trigger(0);
  until(() => B.state === 'fight');
  const res = {};
  // 1. Stand still: attacks must connect.
  const h0 = g.hits;
  g.health = 100;
  until(() => B.seq, 60 * 20);
  res.hitsStandingStill = g.hits - h0;
  res.openKind = B.seq?.kind;
  // 5. Enter the sequence correctly: the boss takes damage and the combo rises.
  const ACT = { T: 'confirm', L: 'left', R: 'right', U: 'jump', D: 'slide' };
  const seqEvents = []; const off = ev.on('bossSeq', (e) => seqEvents.push(e));
  step(25); // past the grace
  const hp0 = B.hp, lane0 = g.player.lane;
  for (const s of [...B.seq.steps]) { g.input.trigger(ACT[s]); step(6); }
  res.okEvent = seqEvents[0]?.ok;
  res.dmg = hp0 - B.hp;
  res.combo = B.combo;
  res.laneUnmoved = g.player.lane === lane0; // swipes went to the attack, not the runner
  // 4. Next opening: a wrong input -> MISS, combo reset, no damage, boss attacks at once.
  g.health = 100;
  until(() => B.seq && B.seq.t > 0.35, 60 * 25);
  const hp1 = B.hp;
  const wrong = { T: 'left', L: 'right', R: 'left', U: 'slide', D: 'jump' };
  g.input.trigger(wrong[B.seq.steps[0]]);
  res.failEvent = seqEvents[seqEvents.length - 1]?.ok === false;
  res.comboAfterFail = B.combo;
  res.hpAfterFail = hp1 - B.hp;
  let f = 0; while (!B.attack && f < 600) { g.stepFrame(DT); f++; }
  res.punishDelay = +(f / 60).toFixed(2);
  // Timeout also fails.
  g.health = 100;
  until(() => B.seq, 60 * 25);
  const n0 = seqEvents.length;
  until(() => seqEvents.length > n0, 60 * 8);
  res.timeoutFails = seqEvents[seqEvents.length - 1]?.ok === false;
  off();
  // Reversed controls (mirror attacks) swap lanes.
  until(() => !B.seq && !B.attack, 60 * 3);
  B.reversed = true;
  const l1 = g.player.lane;
  g.input.trigger(l1 === 0 ? 'left' : 'right');
  step(20);
  res.reversedMoves = l1 === 0 ? g.player.lane === 1 : g.player.lane === l1 - 1;
  B.reversed = false;
  // Decoys never hurt.
  const hd = g.hits;
  g.obstacles.spawn('corruptBlock', g.player.lane, g.distance + 12, { depth: 4, fake: true });
  step(60);
  res.decoyHarmless = g.hits === hd;
  return res;
});
console.log(JSON.stringify(t));
check('1. boss attacks hit a runner who does not dodge', t.hitsStandingStill > 0 && t.openKind === 'opening', `${t.hitsStandingStill} hits, then ${t.openKind}`);
check('5. a completed sequence damages the boss', t.okEvent === true && t.dmg > 0 && t.combo === 1 && t.laneUnmoved, `-${t.dmg} hp, combo ${t.combo}, lane kept ${t.laneUnmoved}`);
check('4. a failed sequence: MISS, combo reset, no damage, boss strikes back', t.failEvent && t.comboAfterFail === 0 && t.hpAfterFail === 0 && t.punishDelay < 1, `punish after ${t.punishDelay}s`);
check('too slow also fails', t.timeoutFails);
check('mirror attack reverses controls', t.reversedMoves);
check('decoys are harmless', t.decoyHarmless);

// ---- Death mid-fight -> game over -> restart works and the boss is gone.
const d = await page.evaluate(() => {
  const g = window.__game;
  window.__fresh(g);
  g.boss.trigger(0);
  for (let i = 0; i < 60 * 12; i++) g.stepFrame(1 / 60);
  const mid = g.boss.state;
  g.die({ kind: 'laser' });
  for (let i = 0; i < 200 && g.state !== 'gameover'; i++) g.stepFrame(1 / 60);
  const over = g.state;
  g.restart(true);
  for (let i = 0; i < 30; i++) g.stepFrame(1 / 60);
  return { mid, over, after: g.state, boss: g.boss.state, bar: document.getElementById('h-bossbar').classList.contains('show'), seq: document.getElementById('h-bseq').classList.contains('show') };
});
check('death during a fight -> game over -> restart', d.mid === 'fight' && d.over === 'gameover' && d.after === 'playing' && d.boss === 'running' && !d.bar && !d.seq, JSON.stringify(d));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(fails.length ? `${fails.length} FAILED` : 'all boss checks passed');
process.exit(fails.length ? 1 : 0);
