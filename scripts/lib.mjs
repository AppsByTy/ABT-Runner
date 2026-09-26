// Shared helpers for automated tests.
import { chromium } from 'playwright';

export async function launch() {
  return chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
}

export async function open(browser, url, viewport = { width: 1280, height: 720 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !/swiftshader|GPU stall|WebGL|GroupMarkerNotSet/i.test(m.text())) errors.push(`[${m.type()}] ${m.text()}`);
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game && window.__events, null, { timeout: 240000 });
  return { page, errors };
}

/**
 * Installs window.__bot(g): a lockstep autopilot that plays with real inputs
 * (InputManager.trigger), ~1.25 s look-ahead and 60 decisions per second.
 */
export const INSTALL_BOT = () => {
  window.__bot = (g) => {
    const P = g.player;
    const threats = (lane, from, to) => {
      let best = null;
      g.obstacles.forEach((o) => {
        if (o.destroyed) return;
        const lanes = o.toLane >= 0 ? [o.lane, o.toLane] : [o.lane];
        if (!lanes.includes(lane)) return;
        const ahead = o.dist - g.distance;
        if (ahead + o.depth < from || ahead > to) return;
        const closing = g.speed + (o.charge > 0 ? 5 : 0);
        if (!best || ahead < best.ahead) best = { cls: o.cls, ahead, t: ahead / closing };
      });
      return best;
    };
    let cd = 0;
    return (dt) => {
      cd -= dt;
      if (g.state !== 'playing' || cd > 0) return;
      const s = g.speed;
      const look = s * 1.25;
      const cur = threats(P.lane, -0.5, look);
      const tOf = (t) => (t ? t.t : Infinity);
      const score = (l) => {
        const t = threats(l, -1.5, look);
        return !t ? 100 : t.cls === 'wall' ? -50 + tOf(t) : 10 + tOf(t);
      };
      const cross = (l, w) => !threats(l, -2.5, s * w);
      const committed = cur && cur.cls !== 'wall' && tOf(cur) < 0.45;
      let target = P.lane;
      if (!committed) {
        let best = score(P.lane);
        for (const l of [0, 1, 2]) {
          if (l === P.lane) continue;
          const dir = l > P.lane ? 1 : -1;
          let ok = true;
          for (let k = P.lane + dir; k !== l + dir; k += dir) if (!cross(k, 0.3 * Math.abs(k - P.lane))) ok = false;
          const sc = score(l) - Math.abs(l - P.lane) * 2;
          if (ok && sc > best + 1) {
            best = sc;
            target = l;
          }
        }
        if (target !== P.lane) target = P.lane + (target > P.lane ? 1 : -1);
      }
      if (target !== P.lane) {
        g.input.trigger(target < P.lane ? 'left' : 'right');
        cd = 0.09;
      } else if (cur && cur.cls === 'low' && tOf(cur) < 0.2 && P.grounded) {
        g.input.trigger('jump');
        cd = 0.1;
      } else if (cur && cur.cls === 'high' && tOf(cur) < 0.3 && !P.sliding) {
        g.input.trigger('slide');
        cd = 0.1;
      }
    };
  };
};
