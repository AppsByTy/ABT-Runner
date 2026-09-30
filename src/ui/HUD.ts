import { audio } from '../audio/AudioManager';
import type { GameState } from '../core/GameState';
import type { LevelInfo } from '../core/Profile';
import type { MissionResult, MissionView } from '../game/Missions';
import type { BoostDef, BoostId } from '../game/Shop';
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
  /** Mission score multiplier the run was played with. */
  runMult: number;
  best: number;
  isNewBest: boolean;
  cause: string;
  stageName: string;
}

/** What the finished run did to the saved profile. */
export interface ProgressReport extends MissionResult {
  xpGained: number;
  before: LevelInfo;
  after: LevelInfo;
  /** Coins banked for levels gained. */
  levelCoins: number;
  /** Coins added to the bank by this run (collected + level + set rewards). */
  banked: number;
  bank: number;
  isNewBest: boolean;
}

export interface ProfileView {
  level: LevelInfo;
  bank: number;
  mult: number;
  missions: MissionView[];
  /** First runs: keep the how-to-play legend on the menu. */
  newPlayer: boolean;
  /** Boosts in stock, for the quick on/off chips. */
  boosts: { def: BoostDef; count: number; armed: boolean }[];
}

const CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';

/** Mission rows (menu, pause, results). Drawn only when the screen opens. */
const missionRows = (list: MissionView[]): string =>
  list
    .map(
      (m, i) =>
        `<div class="ms${m.done ? ' done' : ''}${m.fresh ? ' fresh' : ''}" style="--i:${i}"><i class="ms-box">${m.done ? CHECK : ''}</i>` +
        `<div class="ms-body"><span class="ms-text">${m.text}</span><i class="ms-bar"><b style="transform:scaleX(${(m.value / m.target).toFixed(3)})"></b></i></div>` +
        `<em class="ms-val">${m.label}</em></div>`,
    )
    .join('');

const fmt = (n: number): string => Math.floor(n).toLocaleString('en-US');

/** DOM overlay styled as a developer dashboard. */
const GLYPH_ICON: Record<string, string> = { T: '●', L: '←', R: '→', U: '↑', D: '↓' };
const GLYPH_WORD: Record<string, string> = { T: 'TAP', L: 'LEFT', R: 'RIGHT', U: 'UP', D: 'DOWN' };

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
  onShop: () => void = () => {};
  onProfile: () => void = () => {};
  onToggleBoost: (id: BoostId) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="dash" id="h-dash">
        <div class="dash-l">
          <div class="lbl" id="h-slbl">SCORE</div>
          <div class="score" id="h-score">0</div>
          <div class="chips">
            <span class="chip bugs"><i class="dot g"></i>BUGS FIXED: <b id="h-bugs">0</b></span>
            <span class="chip xp">XP <b id="h-xp">0</b></span>
          </div>
          <div class="dist"><b id="h-dist">0</b> m</div>
        </div>
        <div class="dash-c">
          <div class="combo-wrap" id="h-cwrap">
            <i class="combo-glow" id="h-cglow"></i>
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

      <div class="bossbar" id="h-bossbar">
        <div class="bb-top"><span class="bb-name" id="h-bbname"></span><span class="bb-phase" id="h-bbphase">PHASE 1</span></div>
        <div class="bb-bar"><i class="bb-trail" id="h-bbtrail"></i><i class="bb-fill" id="h-bbfill"></i><span class="bb-marks" id="h-bbmarks"></span></div>
        <div class="bb-sub"><span class="bb-combo" id="h-bbcombo"></span><span class="bb-special" id="h-bbspecial"><em id="h-bbsplbl">SPECIAL</em><span class="bb-sp"><i id="h-bbsp"></i></span></span></div>
      </div>
      <div class="bseq" id="h-bseq"><div class="bs-title" id="h-bstitle"></div><div class="bs-steps" id="h-bssteps">${'<span class="bs-step"><b></b><small></small></span>'.repeat(8)}</div><div class="bs-time"><i id="h-bstime"></i></div></div>
      <div class="bcue" id="h-bcue"></div>
      <div class="bfb" id="h-bfb"><b id="h-bfbt"></b><span id="h-bfbs"></span></div>
      <div class="brev" id="h-brev">⇄ CONTROLS REVERSED</div>
      <div class="cine" id="h-cine"><i class="cine-top"></i><i class="cine-bot"></i></div>
      <div class="bwarn" id="h-bwarn"><div class="bw-stripe"></div><div class="bw-title">⚠ WARNING ⚠</div><div class="bw-sub" id="h-bwsub"></div><div class="bw-stripe"></div></div>
      <div class="btitle" id="h-btitle2"><div class="bt-tag" id="h-bttag"></div><div class="bt-name" id="h-btname"></div><div class="bt-sub" id="h-btsub"></div></div>
      <div class="bwin" id="h-bwin"><div class="bwn-title" id="h-bwntitle"></div><div class="bwn-sub" id="h-bwnsub"></div><div class="bwn-name" id="h-bwnname"></div><div class="bwn-rew" id="h-bwnrew"></div></div>

      <div class="cards" id="h-cards"></div>
      <div class="popups" id="h-popups"></div>
      <div class="banner" id="h-banner"><div class="b-title" id="h-btitle"></div><div class="b-sub" id="h-bsub"></div></div>
      <div class="hint" id="h-hint"></div>
      <div class="m-toast" id="h-mtoast"><div class="mt-top">${CHECK}MISSION COMPLETE</div><div class="mt-text" id="h-mttext"></div><div class="mt-sub" id="h-mtsub"></div></div>
      <div class="crash-flash" id="h-crash">SYSTEM CRASHED</div>
      <div class="fps" id="h-fps"></div>

      <div class="menu" id="p-ready">
        <div class="prof" id="p-prof" data-ui role="button" aria-label="Profile">
          <div class="lvl-badge"><small>LV</small><b id="p-lvl">1</b></div>
          <div class="prof-mid">
            <div class="prof-rank" id="p-rank">INTERN</div>
            <div class="xpbar"><i id="p-xpfill"></i></div>
            <div class="prof-xp" id="p-xp">0 / 150 XP</div>
          </div>
          <div class="prof-bank"><span class="coin-ico">A</span><b id="p-bank">0</b></div>
        </div>
        <div class="brand">
          <div class="brand-top">AppsByTy<span>:</span></div>
          <h1 class="brand-title" id="p-title" data-text="CODE RUNNER">CODE RUNNER</h1>
          <div class="tagline">RUN. CODE. FIX. REPEAT.</div>
        </div>
        <button class="icon-btn menu-gear" data-ui id="b-settings" aria-label="Sound settings"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
        <div class="menu-bottom">
          <div class="missions" id="p-missions">
            <div class="ms-head"><span>MISSIONS</span><b id="p-mult">SCORE ×1</b></div>
            <div class="ms-list" id="p-mlist"></div>
            <div class="ms-foot" id="p-mfoot"></div>
          </div>
          <div class="legend" id="p-legend">
            <span><i class="dot g"></i>Fix green bugs</span>
            <span><i class="dot r"></i>Avoid red errors</span>
            <span><i class="dot y"></i>Grab power-ups</span>
          </div>
          <div class="bchips" id="p-boosts"></div>
          <div class="menu-nav">
            <button class="nav-btn" id="b-shop" data-ui aria-label="Shop"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16l-1.5 12.5a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/></svg><span>SHOP</span></button>
            <div class="tap" id="p-tap">TAP TO START</div>
            <button class="nav-btn" id="b-profile" data-ui aria-label="Profile"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span>PROFILE</span></button>
          </div>
          <div class="controls">Swipe / arrows: <b>←→</b> lane · <b>↑</b> jump · <b>↓</b> slide</div>
          <div class="best">HIGH SCORE <b id="p-best">0</b></div>
        </div>
      </div>

      <div class="panel paused" id="p-paused">
        <div class="term-title">&gt; process paused_</div>
        <div class="missions compact"><div class="ms-head"><span>MISSIONS</span></div><div class="ms-list" id="p-pmlist"></div></div>
        <button class="btn primary" data-ui id="b-resume">RESUME</button>
        <button class="btn" data-ui id="b-psettings">SOUND</button>
        <button class="btn" data-ui id="b-quit">MAIN MENU</button>
      </div>

      <div class="panel settings" id="p-settings" data-ui>
        <div class="set-title">SOUND</div>
        <label class="set-row"><span>MUSIC</span><input type="range" min="0" max="100" id="s-music" data-ui /><b id="s-music-v">70</b></label>
        <label class="set-row"><span>SFX</span><input type="range" min="0" max="100" id="s-sfx" data-ui /><b id="s-sfx-v">85</b></label>
        <div class="set-toggles">
          <button class="tgl" data-ui id="s-mmute">MUTE MUSIC</button>
          <button class="tgl" data-ui id="s-smute">MUTE SFX</button>
        </div>
        <div class="now-playing"><i class="eq" id="s-eq"><b></b><b></b><b></b><b></b></i><span>NOW PLAYING</span><em id="s-track">—</em></div>
        <div class="set-note" id="s-note">Original procedural hip-hop. Drop your own tracks into assets/music.</div>
        <button class="btn primary" data-ui id="s-back">DONE</button>
      </div>

      <div class="panel failure" id="p-over">
        <div class="o-a">
          <div class="bsod-head">
            <div class="bsod-face">:(</div>
            <div>
              <h2 class="bsod-title">SYSTEM FAILURE</h2>
              <div class="bsod-code">ERROR CODE: <b>0xAPPSBYTY</b></div>
            </div>
          </div>
          <div class="bsod-cause" id="o-cause"></div>
          <div class="new-best" id="o-newbest"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2l3 7 7 .6-5.3 4.7L18.3 22 12 18l-6.3 4 1.6-7.7L2 9.6 9 9z"/></svg>NEW HIGH SCORE<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2l3 7 7 .6-5.3 4.7L18.3 22 12 18l-6.3 4 1.6-7.7L2 9.6 9 9z"/></svg></div>
          <div class="o-score"><span>SCORE</span><b id="o-score">0</b><em id="o-smult"></em></div>
          <div class="o-grid">
            <div><span>DISTANCE</span><b id="o-dist">0 m</b></div>
            <div><span>BUGS FIXED</span><b id="o-bugs">0</b></div>
            <div><span>BEST COMBO</span><b id="o-combo">x1</b></div>
            <div><span>COINS</span><b id="o-coins">0</b></div>
            <div><span>XP EARNED</span><b id="o-xp">0</b></div>
            <div><span>HIGH SCORE</span><b id="o-best">0</b></div>
          </div>
        </div>
        <div class="o-b">
          <div class="o-prog">
            <div class="o-lvl">
              <div class="lvl-badge"><small>LV</small><b id="o-lvl">1</b></div>
              <div class="o-lvl-mid">
                <div class="o-rank"><span id="o-rank">INTERN</span><em id="o-xpnum">+0 XP</em></div>
                <div class="xpbar"><i id="o-xpfill"></i></div>
              </div>
            </div>
            <div class="o-levelup" id="o-levelup"></div>
            <div class="o-bank"><span>COIN BANK</span><b><span class="coin-ico">A</span><span id="o-bank">0</span></b><em id="o-bankadd">+0</em></div>
          </div>
          <div class="missions over"><div class="ms-head"><span>MISSIONS</span><b id="o-mult"></b></div><div class="ms-list" id="o-mlist"></div></div>
          <div class="o-set" id="o-set"></div>
          <div class="o-btns">
          <button class="btn primary reboot" data-ui id="b-restart"><span><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>REBOOT SYSTEM</span><small>PLAY AGAIN</small></button>
          <button class="btn" data-ui id="b-menu">MAIN MENU</button>
          </div>
        </div>
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
    this.$('b-shop').addEventListener('click', () => this.onShop());
    this.$('b-profile').addEventListener('click', () => this.onProfile());
    this.$('p-prof').addEventListener('click', () => this.onProfile());
    this.$('p-boosts').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-b]');
      if (b) this.onToggleBoost(b.dataset.b as BoostId);
    });
    // Menu buttons: a tap on them must not also start a run.
    for (const id of ['b-shop', 'b-profile', 'p-prof', 'p-boosts']) {
      this.$(id).addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    this.initSettings();

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
      el.innerHTML = '<div class="fc-l1">BUG FOUND</div><div class="fc-l2">PATCHING…</div><div class="fc-bar"><i></i></div><div class="fc-l3">BUG FIXED <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg></div><div class="fc-xp"></div>';
      cards.appendChild(el);
      this.cardPool.push(el);
    }
  }

  // ------------------------------------------------------------ sound settings

  private initSettings(): void {
    const panel = this.$('p-settings');
    const music = this.$('s-music') as HTMLInputElement;
    const sfx = this.$('s-sfx') as HTMLInputElement;
    const sync = (): void => {
      const st = audio.state;
      music.value = String(Math.round(st.music * 100));
      sfx.value = String(Math.round(st.sfx * 100));
      this.$('s-music-v').textContent = music.value;
      this.$('s-sfx-v').textContent = sfx.value;
      music.style.setProperty('--v', `${music.value}%`);
      sfx.style.setProperty('--v', `${sfx.value}%`);
      this.$('s-mmute').classList.toggle('on', st.musicMuted);
      this.$('s-smute').classList.toggle('on', st.sfxMuted);
      this.$('s-track').textContent = audio.nowPlaying || '—';
      this.$('s-note').textContent = audio.usingMix
        ? `Soundtrack: ${audio.mixTitle} (${audio.mixParts} parts, about an hour). It picks up where you left off.`
        : audio.mixError
          ? `Your mix couldn't play here (${audio.mixError}), so the built-in soundtrack is on.`
          : 'Original procedural hip-hop. Drop your own tracks into assets/music.';
    };
    const open = (): void => {
      sync();
      panel.classList.add('show');
      this.root.classList.add('settings-open');
      audio.play('ui');
    };
    const close = (): void => {
      if (!panel.classList.contains('show')) return;
      panel.classList.remove('show');
      this.root.classList.remove('settings-open');
      audio.play('ui');
    };
    this.$('b-settings').addEventListener('click', open);
    this.$('b-psettings').addEventListener('click', open);
    this.$('s-back').addEventListener('click', close);
    music.addEventListener('input', () => {
      audio.setMusicVolume(Number(music.value) / 100);
      sync();
    });
    sfx.addEventListener('input', () => {
      audio.setSfxVolume(Number(sfx.value) / 100);
      sync();
    });
    sfx.addEventListener('change', () => audio.play('coin'));
    this.$('s-mmute').addEventListener('click', () => {
      audio.setMusicMuted(!audio.state.musicMuted);
      sync();
    });
    this.$('s-smute').addEventListener('click', () => {
      audio.setSfxMuted(!audio.state.sfxMuted);
      sync();
      audio.play('ui');
    });
    // Stop taps inside the panel from reaching the game.
    for (const ev of ['pointerdown', 'touchstart'] as const) panel.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    this.closeSettings = close;
  }

  private closeSettings: () => void = () => {};

  private beatShown = -1;
  private inRun = false;
  private static readonly EQ: [number, number][] = [
    [4, 10],
    [8, 6],
    [3, 11],
    [6, 7],
  ];

  /**
   * Beat envelope (0..1) from the soundtrack. It only drives opacity and
   * transform on a few elements, written directly - never a CSS variable on
   * the HUD root, a box-shadow, a filter or a size. Rewriting those every
   * frame restyled the whole HUD and re-rendered the blurred glass panels
   * continuously, and iOS Safari killed the page for memory within a minute
   * of play (on-device crash tests: music with the beat on the HUD died,
   * the same music with the beat off it passed).
   */
  setBeat(v: number): void {
    const q = Math.round(v * 20) / 20;
    if (q === this.beatShown) return;
    this.beatShown = q;
    if (this.inRun) {
      this.$('h-cglow').style.opacity = q.toFixed(2);
      this.$('h-mult').style.transform = `scale(${(1 + q * 0.05).toFixed(3)})`;
      return;
    }
    this.$('p-tap').style.transform = `scale(${(1 + q * 0.06).toFixed(3)})`;
    this.$('p-title').style.transform = `scale(${(1 + q * 0.015).toFixed(4)})`;
    if (this.$('p-settings').classList.contains('show')) {
      const bars = this.$('s-eq').children;
      for (let i = 0; i < bars.length; i++) {
        const [base, amp] = HUD.EQ[i];
        (bars[i] as HTMLElement).style.transform = `scaleY(${((base + amp * q) / 14).toFixed(3)})`;
      }
    }
  }

  setMuted(m: boolean): void {
    this.$('h-mute').innerHTML = m
      ? '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" fill="none"/></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
  }

  setState(state: GameState, best: number): void {
    if (state === 'playing') this.closeSettings();
    const inRun = state === 'playing' || state === 'dying' || state === 'paused';
    this.inRun = inRun;
    this.beatShown = -1;
    this.root.classList.toggle('in-run', inRun);
    this.root.classList.toggle('menu-open', state === 'ready');
    this.$('p-ready').classList.toggle('show', state === 'ready');
    this.$('p-paused').classList.toggle('show', state === 'paused');
    this.$('p-over').classList.toggle('show', state === 'gameover');
    this.$('h-pause').style.visibility = state === 'playing' ? 'visible' : 'hidden';
    this.$('p-best').textContent = fmt(best);
    if (state !== 'dying') this.$('h-crash').classList.remove('show');
    if (state === 'gameover' || state === 'ready') {
      this.bossBar(null);
      this.combatSeq(null);
      this.combatCue(null);
      this.combatReverse(false);
      this.bossWarning(null);
      this.bossCine(false);
      this.bossVictory(null);
    }
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
    this.$('h-cwrap').classList.toggle('live', s.combo > 0);

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
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.nextToast();
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

  // ------------------------------------------------------------ boss encounters
  // Everything here is set once per event; animations are CSS opacity/transform.

  bossWarning(name: string | null): void {
    const el = this.$('h-bwarn');
    if (name) this.$('h-bwsub').textContent = `${name} APPROACHING`;
    el.classList.toggle('show', !!name);
  }

  bossCine(on: boolean): void {
    this.$('h-cine').classList.toggle('show', on);
    this.root.classList.toggle('cine-on', on);
  }

  bossTitle(name: string, sub: string, tag: string, color: string): void {
    const el = this.$('h-btitle2');
    this.$('h-btname').textContent = name;
    this.$('h-btsub').textContent = sub;
    this.$('h-bttag').textContent = tag;
    el.style.setProperty('--bc', color);
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
  }

  bossBar(cfg: { name: string; color: string; phases: number[] } | null): void {
    const el = this.$('h-bossbar');
    el.classList.toggle('show', !!cfg);
    this.root.classList.toggle('boss-on', !!cfg);
    if (!cfg) return;
    el.style.setProperty('--bc', cfg.color);
    this.$('h-bbname').textContent = cfg.name;
    this.$('h-bbmarks').innerHTML = cfg.phases.slice(1).map((a) => `<i style="left:${(a * 100).toFixed(1)}%"></i>`).join('');
    this.bossHp(1, 0);
  }

  bossHp(frac: number, phase: number): void {
    const f = `scaleX(${Math.max(0, frac).toFixed(3)})`;
    this.$('h-bbfill').style.transform = f;
    this.$('h-bbtrail').style.transform = f;
    this.$('h-bbphase').textContent = `PHASE ${phase + 1}`;
  }

  // ------------------------------------------------------------ boss combat

  /** Combo counter + special meter under the boss bar. */
  combatMeta(combo: number, meter: number, ready: boolean): void {
    const c = this.$('h-bbcombo');
    c.textContent = combo >= 2 ? `COMBO x${combo}` : '';
    c.classList.toggle('hot', combo >= 5);
    if (combo >= 2) {
      c.classList.remove('bump');
      void c.offsetWidth;
      c.classList.add('bump');
    }
    this.$('h-bbsp').style.transform = `scaleX(${Math.min(1, meter).toFixed(3)})`;
    this.$('h-bbspecial').classList.toggle('ready', ready);
    this.$('h-bbsplbl').textContent = ready ? 'SPECIAL READY' : 'SPECIAL';
  }

  /** Show an attack sequence (T tap, L/R/U/D swipes), or hide it. */
  combatSeq(cfg: { title: string; steps: string[]; kind: string } | null): void {
    const el = this.$('h-bseq');
    delete el.dataset.title;
    if (cfg) {
      this.$('h-bstitle').textContent = cfg.title;
      const chips = this.$('h-bssteps').children;
      for (let i = 0; i < chips.length; i++) {
        const ch = chips[i] as HTMLElement;
        const g = cfg.steps[i];
        ch.style.display = g ? '' : 'none';
        if (!g) continue;
        ch.className = `bs-step g-${g}`;
        ch.firstElementChild!.textContent = GLYPH_ICON[g] ?? '?';
        ch.lastElementChild!.textContent = GLYPH_WORD[g] ?? '';
      }
      el.className = `bseq k-${cfg.kind}`;
      this.$('h-bstime').style.transform = 'scaleX(1)';
      void el.offsetWidth;
      el.classList.add('show');
    } else el.classList.remove('show');
  }

  /** Mark sequence progress: step i entered (ok), the wrong one (fail), or all done. */
  combatStep(i: number, state: 'ok' | 'fail' | 'done'): void {
    const chips = this.$('h-bssteps').children;
    if (state === 'fail') {
      (chips[i] as HTMLElement | undefined)?.classList.add('bad');
      this.$('h-bseq').classList.add('failed');
      return;
    }
    (chips[i - 1] as HTMLElement | undefined)?.classList.add('on');
    if (state === 'done') this.$('h-bseq').classList.add('done');
  }

  /** Boss attacks mid-combo: the sequence greys out behind a DODGE call (null = resume). */
  combatHold(text: string | null): void {
    const el = this.$('h-bseq');
    const t = this.$('h-bstitle');
    if (text) {
      el.dataset.title = t.textContent ?? '';
      t.textContent = text;
    } else if (el.dataset.title !== undefined) {
      t.textContent = el.dataset.title;
      delete el.dataset.title;
    }
    el.classList.toggle('held', !!text);
  }

  /** Time left in the window, 0..1 (transform only). */
  combatTime(frac: number): void {
    this.$('h-bstime').style.transform = `scaleX(${Math.max(0, frac).toFixed(3)})`;
  }

  /** Big centre call-out: PERFECT! / CRITICAL HIT! / MISS / COUNTER! ... */
  combatFeedback(title: string, sub: string, tone: 'gold' | 'red' | 'cyan' | 'pink' | 'lime' | 'white'): void {
    const el = this.$('h-bfb');
    this.$('h-bfbt').textContent = title;
    this.$('h-bfbs').textContent = sub;
    el.className = `bfb ${tone}`;
    void el.offsetWidth;
    el.classList.add('go');
  }

  /** Direction cue for the next hazard (arrow + action), or hide it. */
  combatCue(text: string | null, tone: 'move' | 'jump' | 'slide' | 'safe' = 'move'): void {
    const el = this.$('h-bcue');
    if (!text) {
      el.classList.remove('go');
      return;
    }
    el.textContent = text;
    el.className = `bcue ${tone}`;
    void el.offsetWidth;
    el.classList.add('go');
  }

  combatReverse(on: boolean): void {
    this.$('h-brev').classList.toggle('show', on);
  }

  bossVictory(cfg: { title: string; sub: string; name: string; rewards: string; color: string } | null): void {
    const el = this.$('h-bwin');
    if (cfg) {
      this.$('h-bwntitle').textContent = cfg.title;
      this.$('h-bwnsub').textContent = cfg.sub;
      this.$('h-bwnname').textContent = `${cfg.name} DELETED`;
      this.$('h-bwnrew').textContent = cfg.rewards;
      el.style.setProperty('--bc', cfg.color);
    }
    el.classList.toggle('show', !!cfg);
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

  /** Level-up / set-complete timers of the results screen. */
  private overTimers: number[] = [];

  showGameOver(d: GameOverData, r: ProgressReport): void {
    this.$('o-score').textContent = fmt(d.score);
    this.$('o-smult').textContent = d.runMult > 1 ? `×${d.runMult} MISSION BONUS` : '';
    this.$('o-bugs').textContent = fmt(d.bugsFixed);
    this.$('o-dist').textContent = `${fmt(d.distance)} m`;
    this.$('o-combo').textContent = `x${d.bestMultiplier} · ${d.bestCombo}`;
    this.$('o-coins').textContent = fmt(d.coins);
    this.$('o-xp').textContent = fmt(d.xp);
    this.$('o-best').textContent = fmt(d.best);
    this.$('o-cause').textContent = `${d.cause} · ${d.stageName}`;
    this.$('o-newbest').classList.toggle('show', d.isNewBest);

    // Progression: XP bar (fills, and wraps on a level up), bank, missions, set payout.
    for (const t of this.overTimers) window.clearTimeout(t);
    this.overTimers = [];
    const later = (ms: number, fn: () => void): void => void this.overTimers.push(window.setTimeout(fn, ms));
    const fill = this.$('o-xpfill');
    const up = this.$('o-levelup');
    const setLevel = (l: LevelInfo): void => {
      this.$('o-lvl').textContent = String(l.level);
      this.$('o-rank').textContent = l.rank;
    };
    const fillTo = (frac: number, animate: boolean): void => {
      fill.style.transition = animate ? 'transform 0.8s cubic-bezier(0.3, 0.7, 0.3, 1)' : 'none';
      fill.style.transform = `scaleX(${frac.toFixed(3)})`;
    };
    setLevel(r.before);
    fillTo(r.before.frac, false);
    up.classList.remove('show');
    this.$('o-xpnum').textContent = `+${fmt(r.xpGained)} XP`;
    const leveled = r.after.level > r.before.level;
    later(450, () => fillTo(leveled ? 1 : r.after.frac, true));
    if (leveled) {
      later(1300, () => {
        fillTo(0, false);
        void fill.offsetWidth;
        fillTo(r.after.frac, true);
        setLevel(r.after);
        const n = r.after.level - r.before.level;
        up.textContent = `LEVEL ${r.after.level}${n > 1 ? ` (+${n})` : ''} · +${fmt(r.levelCoins)} COINS`;
        up.classList.add('show');
        audio.play('levelUp');
      });
    }
    this.$('o-bank').textContent = fmt(r.bank);
    this.$('o-bankadd').textContent = r.banked > 0 ? `+${fmt(r.banked)}` : '';
    this.$('o-mlist').innerHTML = missionRows(r.missions);
    this.$('o-mult').textContent = `SCORE ×${r.multAfter}`;
    const set = this.$('o-set');
    set.classList.remove('show');
    set.classList.toggle('has', r.setComplete);
    if (r.setComplete) {
      set.innerHTML = `<b>MISSION SET COMPLETE</b><span>SCORE ×${r.multBefore} → ×${r.multAfter} · +${fmt(r.reward)} COINS</span>`;
      later(leveled ? 2100 : 900, () => {
        set.classList.add('show');
        audio.play('achievement');
      });
    }
  }

  /** Mission multiplier next to the in-run score (set once per run). */
  setRunMult(mult: number): void {
    this.$('h-slbl').innerHTML = mult > 1 ? `SCORE <b class="rmult">×${mult}</b>` : 'SCORE';
  }

  /** Menu: level, XP, coin bank, missions. */
  setProfile(v: ProfileView): void {
    const l = v.level;
    this.$('p-lvl').textContent = String(l.level);
    this.$('p-rank').textContent = l.rank;
    this.$('p-xpfill').style.transform = `scaleX(${l.frac.toFixed(3)})`;
    this.$('p-xp').textContent = `${fmt(l.into)} / ${fmt(l.need)} XP`;
    this.$('p-bank').textContent = fmt(v.bank);
    this.$('p-mult').textContent = `SCORE ×${v.mult}`;
    this.$('p-mlist').innerHTML = missionRows(v.missions);
    this.$('p-mfoot').textContent = v.mult < 30 ? `Finish all three: score ×${v.mult + 1} for good` : 'Max multiplier reached';
    this.$('p-legend').style.display = v.newPlayer ? '' : 'none';
    const chips = this.$('p-boosts');
    chips.innerHTML = v.boosts
      .map((b) => `<button class="bchip${b.armed ? ' on' : ''}" data-b="${b.def.id}" data-ui aria-pressed="${b.armed}"><i></i>${b.def.name}<b>×${b.count}</b></button>`)
      .join('');
    chips.style.display = v.boosts.length ? '' : 'none';
  }

  /** A settings panel is open over the menu (taps must not start a run). */
  get modalOpen(): boolean {
    return this.$('p-settings').classList.contains('show');
  }

  showPauseMissions(list: MissionView[]): void {
    this.$('p-pmlist').innerHTML = missionRows(list);
  }

  private toastQueue: [string, number, number][] = [];
  private toastTimer = 0;

  /** MISSION COMPLETE card (queued so several at once play one after another). */
  missionToast(text: string, xp: number, setMult: number): void {
    this.toastQueue.push([text, xp, setMult]);
    if (this.toastTimer <= 0) this.nextToast();
  }

  private nextToast(): void {
    const t = this.toastQueue.shift();
    const el = this.$('h-mtoast');
    if (!t) return;
    const [text, xp, setMult] = t;
    this.$('h-mttext').textContent = text;
    this.$('h-mtsub').textContent = setMult ? `+${xp} XP · ALL 3 DONE · SCORE ×${setMult} NEXT RUN` : `+${xp} XP`;
    el.classList.toggle('set', setMult > 0);
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
    this.toastTimer = 2.8;
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
    this.bannerTimer = this.hintTimer = this.toastTimer = 0;
    this.toastQueue.length = 0;
    this.$('h-mtoast').classList.remove('go');
    this.bossBar(null);
  }

  private bump(el: HTMLElement): void {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
}
