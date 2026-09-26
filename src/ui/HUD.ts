import type { GameState } from '../core/GameState';
import { POWER_INFO, type PowerType } from '../world/Pickups';

export interface HudStats {
  score: number;
  coins: number;
  distance: number;
  bugsFixed: number;
  xp: number;
  health: number;
  multiplier: number;
  powerMult: number;
  combo: number;
  comboTimer: number;
  tierProgress: number;
  stageId: number;
  stageName: string;
  powers: { type: PowerType; frac: number }[];
}

export interface GameOverData {
  score: number;
  distance: number;
  coins: number;
  bugsFixed: number;
  bestCombo: number;
  bestMultiplier: number;
  xp: number;
  health: number;
  best: number;
  isNewBest: boolean;
  cause: string;
  stageName: string;
}

const fmt = (n: number): string => Math.floor(n).toLocaleString('en-US');

/** DOM overlay styled as a developer dashboard. */
export class HUD {
  readonly root: HTMLDivElement;
  private readonly $: (id: string) => HTMLElement;
  private readonly last: Record<string, string | number> = {};
  private readonly popupPool: HTMLElement[] = [];
  private popupNext = 0;
  private popupTimes: number[] = [];
  private readonly cardPool: HTMLElement[] = [];
  private cardNext = 0;
  private bannerTimer = 0;
  private hintTimer = 0;

  onRestart: () => void = () => {};
  onResume: () => void = () => {};
  onPause: () => void = () => {};
  onMenu: () => void = () => {};
  onMute: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="dash" id="h-dash">
        <div class="dash-l">
          <div class="lbl">SCORE</div>
          <div class="score" id="h-score">0</div>
          <div class="chips">
            <span class="chip bugs"><i class="dot g"></i>BUGS FIXED: <b id="h-bugs">0</b></span>
            <span class="chip xp">XP <b id="h-xp">0</b></span>
          </div>
          <div class="dist"><b id="h-dist">0</b> m</div>
        </div>
        <div class="dash-c">
          <div class="combo" id="h-combo">
            <div class="lbl">DEBUG COMBO</div>
            <div class="combo-row">
              <span class="mult" id="h-mult">x1</span>
              <span class="pmult" id="h-pmult"></span>
            </div>
            <div class="combo-count" id="h-ccount">0 chain</div>
            <div class="bar tier"><i id="h-tier"></i></div>
            <div class="bar timer"><i id="h-ctimer"></i></div>
          </div>
          <div class="health" id="h-health">
            <div class="health-top"><span class="lbl">SYSTEM HEALTH</span><b id="h-hp">100%</b></div>
            <div class="segs" id="h-segs">${'<i></i>'.repeat(10)}</div>
          </div>
          <div class="stage" id="h-stage">STAGE 1 · CLEAN COMPUTER</div>
        </div>
        <div class="dash-r">
          <div class="btns">
            <button class="icon-btn" id="h-mute" data-ui aria-label="Toggle sound"></button>
            <button class="icon-btn" id="h-pause" data-ui aria-label="Pause">
              <svg viewBox="0 0 24 24" width="20" height="20"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
            </button>
          </div>
          <div class="lbl right">COINS</div>
          <div class="coins"><span class="coin-ico">A</span><b id="h-coins">0</b></div>
          <div class="powers" id="h-powers"></div>
        </div>
      </div>

      <div class="boss" id="h-boss">
        <div class="boss-top"><span class="boss-name">⚠ THE VIRUS</span><span id="h-bosstime">0s</span></div>
        <div class="boss-lbl" id="h-bosslbl">PATCHING SYSTEM… 0%</div>
        <div class="bar boss-bar"><i id="h-bossbar"></i></div>
      </div>

      <div class="cards" id="h-cards"></div>
      <div class="popups" id="h-popups"></div>
      <div class="banner" id="h-banner"><div class="b-title" id="h-btitle"></div><div class="b-sub" id="h-bsub"></div></div>
      <div class="hint" id="h-hint"></div>
      <div class="crash-flash" id="h-crash">SYSTEM CRASHED</div>
      <div class="fps" id="h-fps"></div>

      <div class="menu" id="p-ready">
        <div class="brand">
          <div class="brand-top">AppsByTy<span>:</span></div>
          <h1 class="brand-title" data-text="CODE RUNNER">CODE RUNNER</h1>
          <div class="tagline">RUN. CODE. FIX. REPEAT.</div>
        </div>
        <div class="menu-bottom">
          <div class="legend">
            <span><i class="dot g"></i>Fix green bugs</span>
            <span><i class="dot r"></i>Avoid red errors</span>
            <span><i class="dot y"></i>Grab power-ups</span>
          </div>
          <div class="tap">TAP TO START</div>
          <div class="controls">Swipe / arrows: <b>←→</b> lane · <b>↑</b> jump · <b>↓</b> slide</div>
          <div class="best">HIGH SCORE <b id="p-best">0</b></div>
        </div>
      </div>

      <div class="panel paused" id="p-paused">
        <div class="term-title">&gt; process paused_</div>
        <button class="btn primary" data-ui id="b-resume">RESUME</button>
        <button class="btn" data-ui id="b-quit">MAIN MENU</button>
      </div>

      <div class="panel failure" id="p-over">
        <div class="bsod-face">:(</div>
        <h2 class="bsod-title">SYSTEM FAILURE</h2>
        <div class="bsod-code">ERROR CODE: <b>0xAPPSBYTY</b></div>
        <div class="bsod-cause" id="o-cause"></div>
        <div class="new-best" id="o-newbest">★ NEW HIGH SCORE ★</div>
        <div class="rows">
          <div class="row big"><span>SCORE</span><i></i><b id="o-score">0</b></div>
          <div class="row"><span>BUGS FIXED</span><i></i><b id="o-bugs">0</b></div>
          <div class="row"><span>DISTANCE</span><i></i><b id="o-dist">0 m</b></div>
          <div class="row"><span>DEBUG COMBO</span><i></i><b id="o-combo">x1</b></div>
          <div class="row"><span>COINS</span><i></i><b id="o-coins">0</b></div>
          <div class="row"><span>XP EARNED</span><i></i><b id="o-xp">0</b></div>
          <div class="row"><span>SYSTEM HEALTH</span><i></i><b id="o-health" class="bad">0%</b></div>
          <div class="row"><span>HIGH SCORE</span><i></i><b id="o-best">0</b></div>
        </div>
        <button class="btn primary reboot" data-ui id="b-restart"><span>⟳ REBOOT SYSTEM</span><small>PLAY AGAIN</small></button>
        <button class="btn" data-ui id="b-menu">MAIN MENU</button>
      </div>

      <div class="boot-screen" id="p-reboot">
        <div class="boot" id="boot-lines"></div>
        <div class="boot-bar"><i id="boot-bar"></i></div>
      </div>
    `;
    parent.appendChild(this.root);

    const cache = new Map<string, HTMLElement>();
    this.$ = (id: string): HTMLElement => {
      let el = cache.get(id);
      if (!el) {
        el = this.root.querySelector<HTMLElement>(`#${id}`)!;
        cache.set(id, el);
      }
      return el;
    };

    this.$('h-pause').addEventListener('click', () => this.onPause());
    this.$('h-mute').addEventListener('click', () => this.onMute());
    this.$('b-resume').addEventListener('click', () => this.onResume());
    this.$('b-quit').addEventListener('click', () => this.onMenu());
    this.$('b-restart').addEventListener('click', () => this.onRestart());
    this.$('b-menu').addEventListener('click', () => this.onMenu());

    const popups = this.$('h-popups');
    for (let i = 0; i < 7; i++) {
      const el = document.createElement('div');
      el.className = 'popup';
      popups.appendChild(el);
      this.popupPool.push(el);
    }
    const cards = this.$('h-cards');
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div');
      el.className = 'fix-card';
      el.innerHTML = '<div class="fc-l1">BUG FOUND</div><div class="fc-l2">PATCHING…</div><div class="fc-bar"><i></i></div><div class="fc-l3">BUG FIXED ✓</div><div class="fc-xp"></div>';
      cards.appendChild(el);
      this.cardPool.push(el);
    }
  }

  setMuted(m: boolean): void {
    this.$('h-mute').innerHTML = m
      ? '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" fill="none"/></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
  }

  setState(state: GameState, best: number): void {
    const inRun = state === 'playing' || state === 'dying' || state === 'paused';
    this.root.classList.toggle('in-run', inRun);
    this.root.classList.toggle('menu-open', state === 'ready');
    this.$('p-ready').classList.toggle('show', state === 'ready');
    this.$('p-paused').classList.toggle('show', state === 'paused');
    this.$('p-over').classList.toggle('show', state === 'gameover');
    this.$('h-pause').style.visibility = state === 'playing' ? 'visible' : 'hidden';
    this.$('p-best').textContent = fmt(best);
    if (state !== 'dying') this.$('h-crash').classList.remove('show');
    if (state === 'gameover' || state === 'ready') this.boss(false);
    if (state !== 'playing') this.$('h-hint').classList.remove('show');
  }

  private set(id: string, value: string | number, fn: (el: HTMLElement, v: string | number) => void = (el, v) => (el.textContent = String(v))): void {
    if (this.last[id] === value) return;
    this.last[id] = value;
    fn(this.$(id), value);
  }

  update(s: HudStats, dt: number): void {
    this.set('h-score', fmt(s.score));
    this.set('h-dist', fmt(s.distance));
    this.set('h-bugs', s.bugsFixed, (el, v) => {
      el.textContent = String(v);
      this.bump(el.parentElement!);
    });
    this.set('h-xp', fmt(s.xp));
    this.set('h-coins', s.coins, (el, v) => {
      el.textContent = fmt(Number(v));
      this.bump(el.parentElement!);
    });

    // DEBUG COMBO
    this.set('h-mult', s.multiplier, (el, v) => {
      el.textContent = `x${v}`;
      el.dataset.tier = String(v);
      this.root.dataset.tier = String(v);
      this.bump(el);
    });
    this.set('h-pmult', s.powerMult, (el, v) => (el.textContent = Number(v) > 1 ? `×${v}` : ''));
    this.set('h-ccount', s.combo, (el, v) => (el.textContent = Number(v) > 0 ? `${v} chain` : 'no chain'));
    this.set('h-tier', Math.round(s.tierProgress * 100), (el, v) => ((el as HTMLElement).style.transform = `scaleX(${Number(v) / 100})`));
    this.$('h-ctimer').style.transform = `scaleX(${s.comboTimer.toFixed(3)})`;
    this.$('h-combo').classList.toggle('live', s.combo > 0);

    // SYSTEM HEALTH
    const hp = Math.max(0, Math.round(s.health));
    this.set('h-hp', hp, (el, v) => {
      const n = Number(v);
      el.textContent = `${n}%`;
      const segs = this.$('h-segs').children;
      for (let i = 0; i < segs.length; i++) segs[i].classList.toggle('on', n > i * 10);
      const box = this.$('h-health');
      box.dataset.level = n > 60 ? 'ok' : n > 30 ? 'warn' : 'crit';
    });
    this.set('h-stage', `${s.stageId}|${s.stageName}`, (el) => (el.textContent = `STAGE ${s.stageId} · ${s.stageName}`));

    // Power-ups tray.
    const key = s.powers.map((p) => p.type).join(',');
    this.set('h-powers', key, (el) => {
      el.innerHTML = s.powers
        .map((p) => `<div class="pw" style="--c:${POWER_INFO[p.type].color}" data-p="${p.type}"><span>${POWER_INFO[p.type].name}</span><i></i></div>`)
        .join('');
    });
    for (const p of s.powers) {
      const bar = this.$('h-powers').querySelector<HTMLElement>(`[data-p="${p.type}"] i`);
      if (bar) bar.style.transform = `scaleX(${p.frac.toFixed(3)})`;
    }

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.$('h-banner').classList.remove('show');
    }
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.$('h-hint').classList.remove('show');
    }
  }

  /** Floating feedback text. Pooled DOM nodes, CSS animated. */
  popup(text: string, tone: 'lime' | 'cyan' | 'pink' | 'gold' | 'red' | 'green' = 'lime', big = false): void {
    const el = this.popupPool[this.popupNext];
    this.popupNext = (this.popupNext + 1) % this.popupPool.length;
    const now = performance.now();
    this.popupTimes = this.popupTimes.filter((t) => now - t < 500);
    const stack = this.popupTimes.length;
    this.popupTimes.push(now);
    el.textContent = text;
    el.className = `popup ${tone}${big ? ' big' : ''}`;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 40}px`);
    el.style.setProperty('--dy', `${-stack * 30}px`);
    void el.offsetWidth;
    el.classList.add('go');
  }

  /** BUG FOUND → PATCHING… → BUG FIXED ✓ → +XP */
  bugFixCard(streak: number, xp: number, auto = false): void {
    const el = this.cardPool[this.cardNext];
    this.cardNext = (this.cardNext + 1) % this.cardPool.length;
    el.querySelector('.fc-xp')!.textContent = `+${xp} XP  ·  BUG FIXED +${streak}`;
    el.querySelector('.fc-l1')!.textContent = auto ? 'AUTO-DEBUG' : 'BUG FOUND';
    el.className = 'fix-card';
    void el.offsetWidth;
    el.classList.add('go');
  }

  banner(title: string, sub = '', tone: 'green' | 'red' | 'gold' | 'cyan' | 'pink' | 'orange' | 'purple' = 'cyan', seconds = 1.8): void {
    const el = this.$('h-banner');
    this.$('h-btitle').textContent = title;
    this.$('h-btitle').dataset.text = title;
    this.$('h-bsub').textContent = sub;
    el.className = `banner ${tone}`;
    void el.offsetWidth;
    el.classList.add('show');
    this.bannerTimer = seconds;
  }

  hint(text: string): void {
    const el = this.$('h-hint');
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    this.hintTimer = 2.4;
  }

  boss(show: boolean, progress = 0, needed = 1, timeLeft = 0): void {
    const el = this.$('h-boss');
    el.classList.toggle('show', show);
    this.root.classList.toggle('boss-on', show);
    if (!show) return;
    const pct = Math.round((progress / needed) * 100);
    this.set('h-bosslbl', pct, (e, v) => (e.textContent = Number(v) >= 100 ? 'VIRUS DELETED ✓' : `PATCHING SYSTEM… ${v}%  (${progress}/${needed} patches)`));
    this.$('h-bossbar').style.transform = `scaleX(${(progress / needed).toFixed(3)})`;
    this.set('h-bosstime', Math.ceil(Math.max(0, timeLeft)), (e, v) => (e.textContent = `${v}s`));
  }

  damageFlash(): void {
    const el = this.$('h-health');
    el.classList.remove('hit');
    void el.offsetWidth;
    el.classList.add('hit');
  }

  crash(): void {
    this.$('h-crash').classList.add('show');
  }

  showGameOver(d: GameOverData): void {
    this.$('o-score').textContent = fmt(d.score);
    this.$('o-bugs').textContent = fmt(d.bugsFixed);
    this.$('o-dist').textContent = `${fmt(d.distance)} m`;
    this.$('o-combo').textContent = `x${d.bestMultiplier}  (${d.bestCombo} chain)`;
    this.$('o-coins').textContent = fmt(d.coins);
    this.$('o-xp').textContent = fmt(d.xp);
    this.$('o-health').textContent = `${Math.max(0, Math.round(d.health))}%`;
    this.$('o-best').textContent = fmt(d.best);
    this.$('o-cause').textContent = `${d.cause} · ${d.stageName}`;
    this.$('o-newbest').classList.toggle('show', d.isNewBest);
  }

  /** Boot sequence overlay. Resolves when the screen is ready to fade out. */
  reboot(): Promise<void> {
    const el = this.$('p-reboot');
    const lines = [
      'APPSBYTY BIOS v4.2  ·  (c) AppsByTy',
      'Memory check ............. 16384 MB OK',
      'Scanning for viruses ..... CLEAN',
      'Restoring system health .. 100%',
      'Loading CodeRunner.exe ...',
    ];
    this.$('boot-lines').innerHTML = lines.map((l, i) => `<div style="animation-delay:${i * 0.14}s">${l}</div>`).join('');
    el.classList.remove('show', 'out');
    void el.offsetWidth;
    el.classList.add('show');
    return new Promise((resolve) => {
      window.setTimeout(() => {
        resolve();
        el.classList.add('out');
        window.setTimeout(() => el.classList.remove('show', 'out'), 450);
      }, 1250);
    });
  }

  setFps(text: string | null): void {
    const el = this.$('h-fps');
    el.textContent = text ?? '';
    el.style.display = text ? 'block' : 'none';
  }

  setAccent(css: string): void {
    this.root.style.setProperty('--accent', css);
  }

  resetCounters(): void {
    for (const k of Object.keys(this.last)) delete this.last[k];
    for (const el of this.popupPool) el.className = 'popup';
    for (const el of this.cardPool) el.className = 'fix-card';
    this.$('h-banner').classList.remove('show');
    this.$('h-hint').classList.remove('show');
    this.bannerTimer = this.hintTimer = 0;
    this.boss(false);
  }

  private bump(el: HTMLElement): void {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
}
