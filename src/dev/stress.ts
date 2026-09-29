import type { GameManager } from '../core/GameManager';
import { audio } from '../audio/AudioManager';

/**
 * On-device crash test (only in builds made with VITE_STRESS=1).
 *
 * Round 1 (A-D) ran the game hands-free with an invincible runner and no
 * input: nothing crashed on the phone, while real play crashes. So round 2
 * (E-I) plays like a person: an autopilot that swipes through the same touch
 * input path a finger uses, gets hit, dies and presses REBOOT, with the
 * audio unlocked by a real tap - and each variant removes one ingredient.
 *
 * Round 2 result on the iPhone: every variant with sound was killed within
 * 26-60 s; the same autopilot with no sound passed twice. Round 3 (J-L)
 * splits "sound" into its parts: the music's beat driving the HUD styling,
 * the music engine itself, and the sound effects.
 *
 * Round 3 result: sound with the beat NOT driving the HUD passed (13k audio
 * nodes), sound effects only passed, music only (708 HUD beat restyles) was
 * killed after 37 s. Round 4 re-runs E and L on the fixed build.
 *
 * Progress is saved every second; if iOS kills the page, the next launch
 * records how far that variant got.
 */

export type Variant = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L';

interface Spec {
  name: string;
  avatar: boolean;
  audio: boolean;
  /** none = invincible runner, no input (round 1); touch = synthetic swipes; buttons = direct actions */
  input: 'none' | 'touch' | 'buttons';
  hits: boolean;
  /** Sound kept on, but one part of it switched off. */
  off?: 'beatCss' | 'music' | 'sfx';
}

const SPECS: Record<Variant, Spec> = {
  A: { name: 'Full game, no input', avatar: true, audio: true, input: 'none', hits: false },
  B: { name: 'No 3D character, no input', avatar: false, audio: true, input: 'none', hits: false },
  C: { name: 'No sound, no input', avatar: true, audio: false, input: 'none', hits: false },
  D: { name: 'Old build (Sep 26)', avatar: false, audio: true, input: 'none', hits: false },
  E: { name: 'Autopilot: full game', avatar: true, audio: true, input: 'touch', hits: true },
  F: { name: 'Autopilot: invincible', avatar: true, audio: true, input: 'touch', hits: false },
  G: { name: 'Autopilot: no sound', avatar: true, audio: false, input: 'touch', hits: true },
  H: { name: 'Autopilot: no 3D character', avatar: false, audio: true, input: 'touch', hits: true },
  I: { name: 'Autopilot: button input', avatar: true, audio: true, input: 'buttons', hits: true },
  J: { name: 'Sound on, beat not driving HUD', avatar: true, audio: true, input: 'touch', hits: true, off: 'beatCss' },
  K: { name: 'Sound effects only (no music)', avatar: true, audio: true, input: 'touch', hits: true, off: 'music' },
  L: { name: 'Music only (no sound effects)', avatar: true, audio: true, input: 'touch', hits: true, off: 'sfx' },
};
const DURATION = 150; // seconds of play per test
const KEY = 'coderunner.stress.v4';

interface Rec {
  v: Variant;
  t: number;
  run: number;
  d: number;
  best: number;
  hits: number;
  swipes: number;
  fps: number;
  /** Web Audio nodes created / offline renders / HUD beat style writes so far. */
  nodes?: number;
  oac?: number;
  css?: number;
  passed: boolean;
}
interface Store {
  pending: Variant | null;
  running: Rec | null;
  results: Rec[];
}

function load(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '') as Store;
    if (s && Array.isArray(s.results)) return s;
  } catch {
    /* fresh */
  }
  return { pending: null, running: null, results: [] };
}

function save(s: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: results can't survive a crash */
  }
}

/** What to switch off before the game is created. */
export function variantSpec(v: Variant | null): Spec | null {
  return v ? SPECS[v] : null;
}

/** The variant to run on this launch (read before the game is created). */
export function startupVariant(): Variant | null {
  const s = load();
  // A test that was still running when the page died = killed by the system.
  if (s.running) {
    s.results.push({ ...s.running, passed: false });
    s.running = null;
  }
  const v = s.pending;
  s.pending = null;
  save(s);
  return v;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Look-ahead autopilot (same logic as scripts/lib.mjs): returns the action to take now, if any. */
function autopilot(g: any): () => 'left' | 'right' | 'jump' | 'slide' | null {
  const P = g.player;
  const threats = (lane: number, from: number, to: number): { cls: string; t: number } | null => {
    let best: { cls: string; ahead: number; t: number } | null = null;
    g.obstacles.forEach((o: any) => {
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
  return () => {
    const s = g.speed;
    const look = s * 1.25;
    const cur = threats(P.lane, -0.5, look);
    const tOf = (t: { t: number } | null): number => (t ? t.t : Infinity);
    const score = (l: number): number => {
      const t = threats(l, -1.5, look);
      return !t ? 100 : t.cls === 'wall' ? -50 + tOf(t) : 10 + tOf(t);
    };
    const committed = cur && cur.cls !== 'wall' && tOf(cur) < 0.45;
    let target = P.lane;
    if (!committed) {
      let best = score(P.lane);
      for (const l of [0, 1, 2]) {
        if (l === P.lane) continue;
        const sc = score(l) - Math.abs(l - P.lane) * 2;
        if (sc > best + 1 && !threats(P.lane + (l > P.lane ? 1 : -1), -2.5, s * 0.3)) {
          best = sc;
          target = l;
        }
      }
    }
    if (target !== P.lane) return target < P.lane ? 'left' : 'right';
    if (cur && cur.cls === 'low' && tOf(cur) < 0.2 && P.grounded) return 'jump';
    if (cur && cur.cls === 'high' && tOf(cur) < 0.3 && !P.sliding) return 'slide';
    return null;
  };
}

/** A swipe through the same pointer/touch event path a finger produces. */
function swipe(dir: 'left' | 'right' | 'jump' | 'slide'): void {
  const el = document.getElementById('app')!;
  const x = window.innerWidth / 2;
  const y = window.innerHeight * 0.62;
  const [dx, dy] = { left: [-90, 0], right: [90, 0], jump: [0, -90], slide: [0, 90] }[dir];
  const base = { pointerId: 17, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y }));
  window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + dx * 0.5, clientY: y + dy * 0.5 }));
  window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + dx, clientY: y + dy }));
  window.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x + dx, clientY: y + dy }));
  window.dispatchEvent(new Event('touchend'));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Counters for the audio / styling work the test does (stress builds only). */
const tally = { nodes: 0, oac: 0, css: 0 };
function instrumentAudio(): void {
  const proto = BaseAudioContext.prototype as unknown as Record<string, unknown>;
  for (const m of Object.getOwnPropertyNames(BaseAudioContext.prototype)) {
    if (!/^create/.test(m)) continue; // (reading accessors like currentTime on the prototype would throw)
    const fn = proto[m];
    if (typeof fn !== 'function') continue;
    proto[m] = function (this: BaseAudioContext, ...a: unknown[]) {
      if (!(this instanceof OfflineAudioContext)) tally.nodes++;
      return (fn as (...x: unknown[]) => unknown).apply(this, a);
    };
  }
  const OAC = window.OfflineAudioContext;
  if (OAC) {
    const Counted = function (...a: ConstructorParameters<typeof OfflineAudioContext>) {
      tally.oac++;
      return new OAC(...a);
    } as unknown as typeof OfflineAudioContext;
    Counted.prototype = OAC.prototype;
    Object.assign(window, { OfflineAudioContext: Counted });
  }
}

export function attachStress(game: GameManager, variant: Variant | null, offered: Variant[] = ['E', 'L']): void {
  const box = document.createElement('div');
  box.setAttribute('data-ui', '');
  box.style.cssText =
    'position:fixed;left:10px;right:10px;bottom:calc(env(safe-area-inset-bottom,0px) + 10px);z-index:100;padding:12px;border-radius:14px;' +
    'background:rgba(2,8,20,.9);border:1px solid rgba(0,229,255,.5);color:#e8f6ff;font:12px/1.5 ui-monospace,Menlo,monospace;pointer-events:auto';
  document.body.appendChild(box);
  const btnCss = 'display:block;width:100%;margin-top:6px;padding:10px;border-radius:10px;border:1px solid #00e5ff;background:#06243a;color:#fff;font:600 14px system-ui';

  const line = (x: Rec): string =>
    `${x.v} ${SPECS[x.v].name}: ${x.passed ? `PASSED ${DURATION} s` : `KILLED after ${Math.round(x.t)} s`} · run ${x.run} at ${Math.round(x.d)} m · ${x.hits} hits · ${x.swipes} swipes · ${x.fps} fps` +
    (x.nodes !== undefined ? ` · ${x.nodes} nodes · ${x.oac} renders · ${x.css} beat styles` : '');
  const table = (): string => {
    const r = load().results;
    return r.length ? r.map(line).join('\n') : 'No results yet.';
  };

  const menu = (): void => {
    box.innerHTML = `<b style="color:#00e5ff">CRASH TEST 4 (fix check)</b> - an autopilot plays like a person (swipes, gets hit, restarts) for about 2½ minutes. Keep the screen on.<pre style="white-space:pre-wrap;margin:8px 0">${table()}</pre>`;
    for (const v of offered) {
      const b = document.createElement('button');
      b.textContent = `Test ${v}: ${SPECS[v].name}`;
      b.style.cssText = btnCss;
      b.addEventListener('click', () => {
        const s = load();
        s.pending = v;
        save(s);
        // Each test starts from a freshly loaded page so the variants are comparable.
        location.reload();
      });
      box.appendChild(b);
    }
    const clear = document.createElement('button');
    clear.textContent = 'Clear results';
    clear.style.cssText = 'margin-top:8px;background:none;border:0;color:#7f9bb3;font:12px system-ui;text-decoration:underline';
    clear.addEventListener('click', () => {
      save({ pending: null, running: null, results: [] });
      box.querySelector('pre')!.textContent = table();
    });
    box.appendChild(clear);
  };
  if (!variant) return menu();

  const spec = SPECS[variant];
  if (spec.audio) instrumentAudio();
  const hud = game.hud as unknown as { setBeat(v: number): void };
  const setBeat = hud.setBeat.bind(hud);
  let lastBeat = -1;
  hud.setBeat = spec.off === 'beatCss' ? () => {} : (v: number) => {
    const q = Math.round(v * 20) / 20; // same quantisation as the HUD: counts real style writes
    if (q !== lastBeat) tally.css++;
    lastBeat = q;
    setBeat(v);
  };
  if (spec.off === 'music') audio.stopMusic();
  if (spec.off === 'sfx') (audio as unknown as { play(): void }).play = () => {};
  const status = (msg: string): void => {
    box.innerHTML = `<b style="color:#00e5ff">TEST ${variant}: ${spec.name}</b><br>${msg}`;
  };

  let fps = 0;
  let frames = 0;
  let fpsT = performance.now();
  const count = (): void => {
    frames++;
    const now = performance.now();
    if (now - fpsT >= 1000) {
      fps = Math.round((frames * 1000) / (now - fpsT));
      frames = 0;
      fpsT = now;
    }
    requestAnimationFrame(count);
  };
  requestAnimationFrame(count);

  const begin = (): void => {
    try {
      void (navigator as Navigator & { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request('screen').catch(() => {});
    } catch {
      /* no wake lock in this frame */
    }
    game.tutorialOverride = false;
    game.start();
    const t0 = performance.now();
    let run = 1;
    let best = 0;
    let swipes = 0;
    let hitsBefore = 0;
    let lastState = game.state;
    let overAt = 0;
    const pilot = autopilot(game);
    let cooldown = 0;
    let extra = 0;
    let last = performance.now();
    const act = (a: 'left' | 'right' | 'jump' | 'slide'): void => {
      swipes++;
      if (spec.input === 'touch') swipe(a);
      else game.input.trigger(a);
    };
    const drive = (): void => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (game.state === 'playing' && spec.input !== 'none') {
        cooldown -= dt;
        extra += dt;
        const a = cooldown <= 0 ? pilot() : null;
        if (a) {
          // Like a person, sometimes react too late (so it gets hit and dies now and then).
          if (spec.hits && Math.random() < 0.18) cooldown = 0.35;
          else {
            act(a);
            cooldown = 0.12;
          }
        } else if (extra > 0.9) {
          // People swipe more than strictly needed.
          extra = 0;
          act(Math.random() < 0.6 ? 'jump' : 'slide');
        }
      }
      if (game.state !== lastState) {
        if (game.state === 'gameover') overAt = now;
        lastState = game.state;
      }
      // Press REBOOT like a player would, after the game-over screen settles.
      if (game.state === 'gameover' && now - overAt > 1800) {
        run++;
        hitsBefore += game.hits;
        game.restart();
        overAt = now + 1e9;
      }
      requestAnimationFrame(drive);
    };
    requestAnimationFrame(drive);

    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (game.state === 'paused') game.resume();
      if (!spec.hits) game.player.grace(5);
      best = Math.max(best, game.distance);
      const t = (performance.now() - t0) / 1000;
      const rec: Rec = { v: variant, t, run, d: game.distance, best, hits: hitsBefore + game.hits, swipes, fps, nodes: tally.nodes, oac: tally.oac, css: tally.css, passed: false };
      const s = load();
      if (t >= DURATION) {
        s.running = null;
        s.results.push({ ...rec, passed: true });
        save(s);
        window.clearInterval(timer);
        game.pause();
        menu();
        return;
      }
      s.running = rec;
      save(s);
      status(`${Math.round(t)} / ${DURATION} s · run ${run} · ${Math.round(game.distance)} m · ${rec.hits} hits · ${fps} fps`);
    }, 1000);
  };

  // Start from a real tap (it unlocks the audio exactly like starting a normal game).
  const wait = window.setInterval(() => {
    const ready = !spec.avatar || (game.player.character as { hasModel?: boolean }).hasModel;
    if (!ready) return status('Loading 3D character…');
    window.clearInterval(wait);
    status('');
    const b = document.createElement('button');
    b.textContent = `TAP TO START TEST ${variant}`;
    b.style.cssText = btnCss;
    b.addEventListener('click', () => begin(), { once: true });
    box.appendChild(b);
  }, 300);
}
