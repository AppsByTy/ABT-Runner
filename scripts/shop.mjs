// Shop checks (buying, level locks, outfits, trails, upgrades, boosts, menus, saves):
//   node scripts/shop.mjs [url]
// Lockstep, render off. Each check prints PASS/FAIL; exit code 1 on any failure.
import { launch, open } from './lib.mjs';

const URL = process.argv[2] ?? 'http://localhost:5173/';
const browser = await launch();
const { page, errors } = await open(browser, URL, { width: 390, height: 844 });
const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) fails.push(name);
};
const P = 'coderunner.profile.v1';

const reload = async (profile) => {
  await page.evaluate(([k, p]) => {
    localStorage.clear();
    localStorage.setItem('coderunner.flight.v1', '{"closed":true}');
    if (p) localStorage.setItem(k, typeof p === 'string' ? p : JSON.stringify(p));
  }, [P, profile]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game && window.__events, null, { timeout: 240000 });
  await page.evaluate(async () => {
    const g = window.__game;
    g.autoLoop = false;
    g.renderEnabled = false;
    g.tutorialOverride = false;
    window.__OUTFIT = window.__outfit;
    window.__TRAIL = window.__trail;
    window.__h = {
      start() {
        if (g.state === 'playing') g.pause();
        if (g.state === 'paused' || g.state === 'gameover') g.toReady();
        g.shopUI.close();
        g.profileUI.close();
        g.input.trigger('confirm');
        g.spawner.update = () => {};
        g.obstacles.clear();
        g.pickups.clear();
      },
      step(n) {
        for (let i = 0; i < n && g.state === 'playing'; i++) g.stepFrame(1 / 60);
      },
      // A wall in our lane; step until it hits us (or we pass it).
      hitMe() {
        const o = g.obstacles.spawn('corruptBlock', g.player.lane, g.distance + 25, { depth: 8 });
        const h0 = g.hits;
        for (let i = 0; i < 600 && g.state === 'playing' && g.hits === h0; i++) g.stepFrame(1 / 120);
        return o;
      },
      die() {
        if (g.state === 'playing') g.die({ kind: 'firewall' });
        for (let i = 0; i < 200 && g.state === 'dying'; i++) g.stepFrame(1 / 60);
      },
    };
  });
};
const ev = (fn, arg) => page.evaluate(fn, arg);

// 1. Fresh shop
await reload(null);
let r = await ev(() => {
  const g = window.__game, s = g.shop;
  const o = s.items('outfit');
  return { outfit: s.outfit().id, trail: s.trail().id, classic: o[0], buy: s.buy('outfit', 'cyan'), n: [s.items('outfit').length, s.items('trail').length, s.items('upgrade').length, s.items('boost').length], on: window.__OUTFIT.hoodieOn.value };
});
check('fresh: classic outfit + pink trail, owned and equipped', r.outfit === 'classic' && r.trail === 'pink' && r.classic.owned && r.classic.equipped && r.on === 0);
check('fresh: catalog 8 outfits / 7 trails / 5 upgrades / 4 boosts', r.n.join() === '8,7,5,4', r.n.join());
check('fresh: no coins, no purchase', !r.buy.ok && r.buy.reason === 'coins', JSON.stringify(r.buy));

// 2. Buying an outfit
r = await ev(() => {
  const g = window.__game, s = g.shop, d = g.profile.data;
  d.bank = 5000;
  const res = s.buy('outfit', 'cyan');
  g.applyCosmetics();
  g.showProfile();
  const again = s.buy('outfit', 'cyan');
  const c = window.__OUTFIT.hoodie.value;
  const want = new c.constructor('#12d2ff');
  return { res, again, bank: d.bank, spent: d.stats.coinsSpent, eq: s.outfit().id, on: window.__OUTFIT.hoodieOn.value, same: c.equals(want), menu: document.getElementById('p-bank').textContent };
});
check('outfit: bought and equipped (5000 -> 4200)', r.res.ok && r.bank === 4200 && r.spent === 800 && r.eq === 'cyan', JSON.stringify(r));
check('outfit: runner recoloured (uniforms only)', r.on === 1 && r.same);
check('outfit: cannot buy twice', !r.again.ok && r.again.reason === 'owned');
check('outfit: menu bank updated', r.menu === '4,200', r.menu);

// 3. Level locks
r = await ev(() => {
  const g = window.__game, s = g.shop, d = g.profile.data;
  d.bank = 99999;
  const locked = s.buy('outfit', 'root');
  const lockedTrail = s.buy('trail', 'rgb');
  d.totalXp = 20000; // level 13
  const ok = s.buy('trail', 'rgb');
  g.applyCosmetics();
  return { locked, lockedTrail, ok, rainbow: window.__TRAIL.uRainbow.value, lvl: g.profile.level.level };
});
check('locks: level-gated items refuse below their level', !r.locked.ok && r.locked.reason === 'locked' && !r.lockedTrail.ok && r.lockedTrail.reason === 'locked');
check('locks: unlocked at the level; RGB trail cycles colours', r.ok.ok && r.rainbow === 1 && r.lvl >= 12, JSON.stringify(r));

// 4. Equip / trails
r = await ev(() => {
  const g = window.__game, s = g.shop;
  const eqClassic = s.equip('outfit', 'classic');
  const eqRoot = s.equip('outfit', 'root');
  g.applyCosmetics();
  const on = window.__OUTFIT.hoodieOn.value;
  s.buy('trail', 'gold');
  g.applyCosmetics();
  const t = window.__TRAIL;
  const want = new t.uColor.value.constructor('#ffd23a').multiplyScalar(1.4);
  return { eqClassic, eqRoot, on, trail: s.trail().id, color: t.uColor.value.equals(want), rainbow: t.uRainbow.value };
});
check('equip: owned only; classic turns recolour off', r.eqClassic && !r.eqRoot && r.on === 0);
check('trail: bought + equipped, colour applied', r.trail === 'gold' && r.color && r.rainbow === 0, JSON.stringify(r));

// 5. Upgrades
r = await ev(() => {
  const g = window.__game, s = g.shop, h = window.__h;
  const before = s.items('upgrade').find((x) => x.id === 'debug').price;
  s.buy('upgrade', 'debug');
  const after = s.items('upgrade').find((x) => x.id === 'debug').price;
  h.start();
  g.powers.activate('debug');
  const secs = g.powers.duration('debug');
  for (let i = 0; i < 4; i++) s.buy('upgrade', 'debug');
  const max = s.buy('upgrade', 'debug');
  h.die();
  return { before, after, secs, lvl: s.upgradeLevel('debug'), max, mult: s.durationMults().debug };
});
check('upgrade: level 1 costs 300, level 2 costs 700', r.before === 300 && r.after === 700);
check('upgrade: DEBUG MODE lasts 8 s x 1.15 = 9.2 s', Math.abs(r.secs - 9.2) < 1e-6, `${r.secs}`);
check('upgrade: max level 5 (+75%)', r.lvl === 5 && !r.max.ok && r.max.reason === 'max' && Math.abs(r.mult - 1.75) < 1e-9, JSON.stringify(r));

// 6. Boosts: head start, firewall, double score
r = await ev(() => {
  const g = window.__game, s = g.shop, h = window.__h, d = g.profile.data;
  d.bank = 5000;
  s.buy('boost', 'headstart');
  s.buy('boost', 'firewall');
  s.buy('boost', 'double');
  const armed = [...d.shop.armed];
  h.start();
  const boost = g.powers.has('boost'), fw = g.powers.has('firewall'), sb = g.scoreBoost;
  const s0 = g.score;
  g.addScore(100);
  const got = g.score - s0;
  const left = { hs: s.boostCount('headstart'), fw: s.boostCount('firewall'), db: s.boostCount('double'), armed: [...d.shop.armed] };
  g.player.grace(99);
  h.step(60 * 10);
  const boostAfter = g.powers.has('boost');
  g.powers.reset();
  g.player.grace(0);
  g.distance = 995; g.prevDistance = 995;
  h.step(60);
  const sbAfter = g.scoreBoost;
  h.die();
  return { armed, boost, fw, sb, got, left, boostAfter, sbAfter };
});
check('boosts: bought boosts are switched on', r.armed.join() === 'headstart,firewall,double', r.armed.join());
check('boosts: run starts with CODE BOOST + FIREWALL + x2 score', r.boost && r.fw && r.sb === 2 && r.got === 200, JSON.stringify(r));
check('boosts: used up and switched off', r.left.hs === 0 && r.left.fw === 0 && r.left.db === 0 && r.left.armed.length === 0, JSON.stringify(r.left));
check('boosts: head start ends (8 s), double score ends at 1,000 m', !r.boostAfter && r.sbAfter === 1);

// 7. SYSTEM BACKUP
r = await ev(() => {
  const g = window.__game, s = g.shop, h = window.__h, d = g.profile.data;
  s.buy('boost', 'backup');
  h.start();
  h.step(30);
  g.health = 10;
  h.hitMe();
  const saved = { state: g.state, health: Math.round(g.health), left: s.boostCount('backup'), used: d.stats.backupsUsed, armed: s.isArmed('backup') };
  g.player.grace(0);
  g.player.invuln = 0;
  h.step(200);
  g.health = 10;
  h.hitMe();
  for (let i = 0; i < 10; i++) g.stepFrame(1 / 60);
  return { saved, second: g.state };
});
check('backup: restores to 50% instead of crashing', r.saved.state === 'playing' && r.saved.health === 50, JSON.stringify(r.saved));
check('backup: used up (one per run)', r.saved.left === 0 && r.saved.used === 1 && !r.saved.armed);
check('backup: next lethal hit crashes', r.second === 'dying' || r.second === 'gameover', r.second);
await ev(() => window.__h.die());

// 8. Switched-off boosts are kept
r = await ev(() => {
  const g = window.__game, s = g.shop, h = window.__h;
  s.buy('boost', 'headstart');
  const off = s.toggleArm('headstart');
  h.start();
  const boost = g.powers.has('boost');
  h.die();
  const on = s.toggleArm('headstart');
  return { off, boost, count: s.boostCount('headstart'), on };
});
check('boosts: switched off = not used', r.off === false && !r.boost && r.count === 1 && r.on === true, JSON.stringify(r));

// 9. Menu, shop screen and profile through the DOM
r = await ev(() => {
  const g = window.__game;
  if (g.state !== 'ready') g.toReady();
  g.shopUI.close();
  const chips = [...document.querySelectorAll('#p-boosts .bchip')].map((c) => `${c.dataset.b}:${c.classList.contains('on')}`);
  document.querySelector('#p-boosts .bchip[data-b="headstart"]').click();
  const toggled = g.shop.isArmed('headstart');
  document.getElementById('b-shop').click();
  const open = g.shopUI.isOpen;
  g.input.trigger('confirm'); // a tap on the game while shopping must not start a run
  const stateInShop = g.state;
  const tabs = {};
  for (const t of ['outfit', 'trail', 'upgrade', 'boost']) {
    document.querySelector(`.stab[data-tab="${t}"]`).click();
    tabs[t] = document.querySelectorAll('#sh-grid .it').length;
  }
  document.querySelector('.stab[data-tab="outfit"]').click();
  g.profile.data.bank = 10000;
  // Try on (tile tap), then two-tap buy.
  document.querySelector('.it[data-id="violet"]').click();
  const tryOn = window.__OUTFIT.hoodie.value.equals(new window.__OUTFIT.hoodie.value.constructor('#8657ff'));
  document.querySelector('.it[data-id="hotfix"] .it-btn').click();
  const confirmShown = document.querySelector('.it[data-id="hotfix"] .it-btn').classList.contains('confirm');
  const bankMid = g.profile.data.bank;
  document.querySelector('.it[data-id="hotfix"] .it-btn').click();
  const bought = g.shop.outfit().id === 'hotfix' && g.profile.data.bank === bankMid - 1200;
  document.querySelector('.it[data-id="violet"]').click(); // try on something else...
  g.input.trigger('pause'); // ...Esc closes the shop and puts the real outfit back
  const closed = !g.shopUI.isOpen;
  const restored = window.__OUTFIT.hoodie.value.equals(new window.__OUTFIT.hoodie.value.constructor('#ff3ccc'));
  document.getElementById('b-profile').click();
  const prof = g.profileUI.isOpen && /COINS SPENT/.test(document.getElementById('p-profile').textContent);
  g.input.trigger('confirm');
  const stateInProfile = g.state;
  document.getElementById('pf-done').click();
  return { chips, toggled, open, stateInShop, tabs, tryOn, confirmShown, bought, closed, restored, prof, stateInProfile, profClosed: !g.profileUI.isOpen };
});
check('menu: boost chips show stock + on/off, tap toggles', r.chips.includes('headstart:true') && r.toggled === false, r.chips.join(' '));
check('shop: opens from the menu, blocks tap-to-start', r.open && r.stateInShop === 'ready');
check('shop: tabs list 8 / 7 / 5 / 4 items', `${r.tabs.outfit},${r.tabs.trail},${r.tabs.upgrade},${r.tabs.boost}` === '8,7,5,4', JSON.stringify(r.tabs));
check('shop: tapping an outfit tries it on', r.tryOn);
check('shop: two-tap buy (CONFIRM, then buy)', r.confirmShown && r.bought, JSON.stringify(r));
check('shop: Esc closes, real outfit back on', r.closed && r.restored);
check('profile: opens with lifetime stats, blocks start, closes', r.prof && r.stateInProfile === 'ready' && r.profClosed);

// 10. Saved + applied on the next launch
const before = await ev(() => JSON.parse(JSON.stringify(window.__game.profile.data.shop)));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__game, null, { timeout: 240000 });
r = await ev(async () => {
  const OUTFIT = window.__outfit;
  const g = window.__game;
  return { shop: JSON.parse(JSON.stringify(g.profile.data.shop)), on: OUTFIT.hoodieOn.value, pink: OUTFIT.hoodie.value.equals(new OUTFIT.hoodie.value.constructor('#ff3ccc')) };
});
check('persist: shop state survives a reload', JSON.stringify(r.shop) === JSON.stringify(before), `${JSON.stringify(before)} vs ${JSON.stringify(r.shop)}`);
check('persist: equipped outfit applied at launch', r.on === 1 && r.pink);

// 11. Tampered save is cleaned up
await reload({ v: 1, bank: 50, shop: { owned: ['nope', 'cyan'], outfit: 'root', trail: 'zzz', upgrades: { debug: 42, fly: 3 }, boosts: { backup: 2, cheat: 9 }, armed: ['cheat', 'backup', 'double'] } });
r = await ev(() => JSON.parse(JSON.stringify(window.__game.profile.data.shop)));
check('tampered save: unknown ids dropped, levels capped, unowned outfit unequipped',
  r.owned.join() === 'cyan' && r.outfit === 'classic' && r.trail === 'pink' && r.upgrades.debug === 5 && !('fly' in r.upgrades) && r.boosts.backup === 2 && !('cheat' in r.boosts) && r.armed.join() === 'backup', JSON.stringify(r));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall shop checks passed');
process.exit(fails.length ? 1 : 0);
