import { HipHopEngine, type MusicMode } from './HipHopEngine';
import { MIX, MIX_TITLE, tracksFor, type MusicTrack } from './MusicFiles';
import { bell, glitch, kick, makeImpulse, midi, noiseBuffer, satCurve, stab, sweep, vox, type Buses } from './synth';

/**
 * All game audio goes through here.
 *
 * Music: an original procedural hip-hop soundtrack (HipHopEngine) with
 * menu / run / debug / boss / game-over arrangements, or your own files
 * dropped into assets/music (see MusicFiles.ts). Beat timing is exposed
 * (`beat`, `onBeat`) so lighting, UI and particles can pulse in sync.
 *
 * SFX: layered synthesis; any id can be replaced by a real file with
 * `loadFile(id, url)` without touching gameplay code.
 */

export type SoundId =
  | 'coin'
  | 'code'
  | 'chip'
  | 'xp'
  | 'bugFix'
  | 'patch'
  | 'power'
  | 'debug'
  | 'admin'
  | 'shieldBreak'
  | 'hit'
  | 'graze'
  | 'nearMiss'
  | 'jump'
  | 'slide'
  | 'land'
  | 'lane'
  | 'comboTier'
  | 'stage'
  | 'bossAlarm'
  | 'bossPatch'
  | 'bossDeleted'
  | 'bossRiser'
  | 'bossImpact'
  | 'bossRoar'
  | 'bossHit'
  | 'bossExplode'
  | 'bossTelegraph'
  | 'bossVictory'
  | 'deleted'
  | 'crash'
  | 'reboot'
  | 'boot'
  | 'error'
  | 'levelUp'
  | 'achievement'
  | 'ui';

const STORE_KEY = 'coderunner.audio.v2';
/** Where the DJ mix was left (part + seconds), so the next session carries on. */
const MIX_KEY = 'coderunner.mix.v1';

export interface AudioSettings {
  /** Master mute (HUD speaker button). */
  muted: boolean;
  music: number;
  sfx: number;
  musicMuted: boolean;
  sfxMuted: boolean;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private sfxFx!: Buses;
  private musicBus!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private musicMix!: GainNode;
  private engine: HipHopEngine | null = null;
  private timer: number | null = null;
  private analyser!: AnalyserNode;
  private readonly files = new Map<SoundId, AudioBuffer>();
  private settings: AudioSettings = { muted: false, music: 0.7, sfx: 0.85, musicMuted: false, sfxMuted: false };
  private lastPlayed = new Map<SoundId, number>();

  private musicOn = false;
  private intensity = 1;
  private boss = false;
  private debug = false;
  private menu = true;
  private gameOver = false;
  private paused = false;
  private mode: MusicMode = 'menu';

  // File-track playback (crossfaded <audio> elements).
  private fileEls: [HTMLAudioElement, GainNode][] = [];
  private fileSlot = 0;
  private fileTrack: MusicTrack | null = null;
  private fileIdx = new Map<MusicMode, number>();
  private bassBins: Uint8Array<ArrayBuffer> | null = null;
  private bassPrev = 0;
  private bassAvg = 0;
  private lastFileBeat = 0;

  /** 0..1 envelope that spikes on each kick / snare and decays. */
  beat = 0;
  private lastKick = -10;
  private lastSnare = -10;
  /** Fired on each kick / snare as it actually sounds. */
  onBeat: ((kind: 'kick' | 'snare') => void) | null = null;

  constructor() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) this.settings = { ...this.settings, ...JSON.parse(raw) };
    } catch {
      /* storage unavailable */
    }
    const unlock = (): void => {
      this.ensure();
      void this.ctx?.resume();
      // iOS only lets a media element start inside a tap (touchend / click), and
      // not from pointerdown - so every tap re-tries a mix that should be playing.
      this.kickMedia();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('touchend', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) {
        void this.ctx.suspend();
        for (const [el] of this.fileEls) el.pause();
      } else {
        void this.ctx.resume();
        if (this.fileTrack) void this.fileEls[this.fileSlot][0].play().catch(() => {});
      }
    });
  }

  // -------------------------------------------------------------- settings

  get muted(): boolean {
    return this.settings.muted;
  }

  get state(): Readonly<AudioSettings> {
    return this.settings;
  }

  /** Name of what is playing (for the settings screen). */
  get nowPlaying(): string {
    if (this.fileTrack?.mode === 'mix') return `${MIX_TITLE} · ${MIX.indexOf(this.fileTrack) + 1}/${MIX.length}`;
    if (this.fileTrack) return this.fileTrack.name;
    return this.engine?.songName ?? '';
  }

  setMuted(m: boolean): void {
    this.settings.muted = m;
    this.applyGains();
  }

  setMusicVolume(v: number): void {
    this.settings.music = Math.max(0, Math.min(1, v));
    this.applyGains();
  }

  setSfxVolume(v: number): void {
    this.settings.sfx = Math.max(0, Math.min(1, v));
    this.applyGains();
  }

  setMusicMuted(m: boolean): void {
    this.settings.musicMuted = m;
    this.applyGains();
  }

  setSfxMuted(m: boolean): void {
    this.settings.sfxMuted = m;
    this.applyGains();
  }

  private applyGains(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const S = this.settings;
    this.master.gain.setTargetAtTime(S.muted ? 0 : 0.9, t, 0.05);
    this.musicBus.gain.setTargetAtTime(S.musicMuted ? 0 : S.music * S.music * 0.9, t, 0.08);
    this.sfxBus.gain.setTargetAtTime(S.sfxMuted ? 0 : S.sfx * S.sfx, t, 0.05);
  }

  // ----------------------------------------------------------------- graph

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    this.master.connect(limiter).connect(ctx.destination);

    // SFX bus with a short room reverb and a slap delay.
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    const sfxVerb = ctx.createConvolver();
    sfxVerb.buffer = makeImpulse(ctx, 1.2, 3);
    const sfxVerbOut = ctx.createGain();
    sfxVerbOut.gain.value = 0.35;
    sfxVerb.connect(sfxVerbOut).connect(this.sfxBus);
    const sfxDelay = ctx.createDelay(1);
    sfxDelay.delayTime.value = 0.16;
    const sfxFb = ctx.createGain();
    sfxFb.gain.value = 0.28;
    const sfxDelOut = ctx.createGain();
    sfxDelOut.gain.value = 0.3;
    sfxDelay.connect(sfxFb).connect(sfxDelay);
    sfxDelay.connect(sfxDelOut).connect(this.sfxBus);
    this.sfxFx = { out: this.sfxBus, verb: sfxVerb, delay: sfxDelay };

    // Music: mix -> glue compressor -> mode filter -> volume -> master.
    this.musicBus = ctx.createGain();
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 2400;
    this.musicFilter.Q.value = 0.8;
    this.musicMix = ctx.createGain();
    this.musicMix.gain.value = 0.85;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.ratio.value = 3;
    glue.attack.value = 0.01;
    glue.release.value = 0.2;
    this.analyser = ctx.createAnalyser();
    // 43 Hz bins, barely smoothed: kick drums show up as sharp low-end onsets.
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.2;
    this.musicMix.connect(glue).connect(this.musicFilter).connect(this.musicBus).connect(this.master);
    this.musicMix.connect(this.analyser);

    const drumBus = ctx.createGain();
    const drumSat = ctx.createWaveShaper();
    drumSat.curve = satCurve(1.6);
    drumBus.connect(drumSat).connect(this.musicMix);
    const bassBus = ctx.createGain();
    bassBus.gain.value = 0.9;
    bassBus.connect(this.musicMix);
    const duck = ctx.createGain();
    duck.connect(this.musicMix);
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx, 2.6, 2.4);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.5;
    verb.connect(verbOut).connect(duck);
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.32;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 3500;
    const delOut = ctx.createGain();
    delOut.gain.value = 0.38;
    delay.connect(dlp).connect(fb).connect(delay);
    dlp.connect(delOut).connect(duck);
    const drums: Buses = { out: drumBus, verb, delay };
    const inst: Buses = { out: duck, verb, delay };
    this.engine = new HipHopEngine(ctx, drums, bassBus, inst);
    this.engine.duck = duck;
    this.engine.delayNode = delay;
    this.engine.intensity = this.intensity;
    this.engine.warm();

    this.applyGains();
    this.applyMode(true);
    if (this.musicOn) this.startScheduler();
    return ctx;
  }

  /** Swap a synthesised sound for a real audio file. */
  async loadFile(id: SoundId, url: string): Promise<void> {
    const ctx = this.ensure();
    if (!ctx) return;
    const res = await fetch(url);
    this.files.set(id, await ctx.decodeAudioData(await res.arrayBuffer()));
  }

  // ----------------------------------------------------------------- music

  startMusic(): void {
    this.musicOn = true;
    if (this.ctx && this.timer === null) this.startScheduler();
  }

  stopMusic(): void {
    this.musicOn = false;
    this.engine?.stop();
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 0 = menu, 1 = running, 2 = high combo, 3 = frantic. */
  setIntensity(level: number): void {
    const menu = level === 0;
    if (menu !== this.menu) {
      this.menu = menu;
      if (!menu) this.gameOver = false;
      this.applyMode();
    }
    if (level > 0) this.intensity = Math.min(3, level);
    if (this.engine) this.engine.intensity = this.intensity;
  }

  /** Each pair of stages cues a different track at the next phrase. */
  setStage(stage: number): void {
    this.engine?.cue(Math.floor((stage - 1) / 2));
  }

  setBoss(on: boolean): void {
    this.boss = on;
    this.applyMode();
  }

  setDebug(on: boolean): void {
    if (on === this.debug) return;
    this.debug = on;
    this.applyMode();
  }

  setGameOver(on: boolean): void {
    this.gameOver = on;
    this.applyMode();
  }

  /** Pause: muffle the music. */
  setMuffled(on: boolean): void {
    this.paused = on;
    this.applyMode();
  }

  private currentMode(): MusicMode {
    if (this.gameOver) return 'gameover';
    if (this.menu) return 'menu';
    if (this.boss) return 'boss';
    if (this.debug) return 'debug';
    return 'run';
  }

  private applyMode(force = false): void {
    const mode = this.currentMode();
    const changed = mode !== this.mode || force;
    this.mode = mode;
    if (!this.ctx || !this.engine) return;
    const t = this.ctx.currentTime;
    // Mode colour: menu = warm/atmospheric, game over = sinks under water.
    // (A DJ mix stays full-range on the menu - only pause and game over colour it.)
    const menuCut = this.usingMix ? 19000 : 2600;
    const cutoff = this.paused && mode !== 'gameover' ? 900 : mode === 'menu' ? menuCut : mode === 'gameover' ? 420 : 19000;
    this.musicFilter.frequency.setTargetAtTime(cutoff, t, mode === 'gameover' ? 0.6 : 0.25);
    const level = mode === 'gameover' ? 0.45 : mode === 'debug' || mode === 'boss' ? 0.95 : mode === 'menu' && this.usingMix ? 0.75 : 0.85;
    this.musicMix.gain.setTargetAtTime(level, t, mode === 'gameover' ? 0.8 : 0.2);
    if (!changed) return;
    this.engine.mode = mode;
    if ((mode === 'boss' || mode === 'debug') && !force) sweep(this.ctx, { out: this.musicMix, verb: this.musicMix, delay: this.musicMix }, t, 0.6, true, 0.6);
    // A DJ mix is the whole soundtrack: it keeps playing through every mode.
    if (this.usingMix) {
      this.playMix();
      return;
    }
    const files = tracksFor(mode);
    if (files.length) this.playFile(files, mode);
    else this.stopFile();
  }

  // ------------------------------------------------------------- DJ mix

  private mixPart = -1;
  private mixFailed = false;
  private mixSaveT = 0;
  private mixPrimed = false;
  /** Why the mix could not play (settings screen / diagnostics), if it failed. */
  mixError = '';

  get mixTitle(): string {
    return MIX_TITLE;
  }

  get mixParts(): number {
    return MIX.length;
  }

  /** A mix is present and playable. */
  get usingMix(): boolean {
    return MIX.length > 0 && !this.mixFailed;
  }

  private mixEls(): [HTMLAudioElement, GainNode][] {
    const ctx = this.ctx!;
    if (this.fileEls.length === 0) {
      for (let n = 0; n < 2; n++) {
        const el = new Audio();
        el.crossOrigin = 'anonymous';
        el.preload = 'auto';
        (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
        const g = ctx.createGain();
        g.gain.value = 0;
        ctx.createMediaElementSource(el).connect(g).connect(this.musicMix);
        el.addEventListener('ended', () => {
          if (this.usingMix) {
            if (this.fileEls[this.fileSlot][0] === el) this.mixNext();
            return;
          }
          // Auto-switch to the next track for this mode.
          if (this.fileEls[this.fileSlot][0] === el) {
            this.fileTrack = null;
            const l = tracksFor(this.mode);
            if (l.length) this.playFile(l, this.mode);
          }
        });
        el.addEventListener('error', () => {
          if (!this.usingMix || this.fileEls[this.fileSlot][0] !== el) return;
          // Never go silent: fall back to the procedural soundtrack.
          const e = el.error;
          this.mixError = `mix part ${this.mixPart + 1} failed (${e ? `code ${e.code}` : 'unknown'})`;
          console.warn('[audio]', this.mixError);
          this.mixFailed = true;
          this.fileTrack = null;
          this.applyMode(true);
          if (this.musicOn) this.engine?.start();
        });
        this.fileEls.push([el, g]);
      }
    }
    return this.fileEls;
  }

  /** Start (or keep) the mix playing, resuming where the last session left off. */
  private playMix(): void {
    if (this.fileTrack?.mode === 'mix') return;
    const ctx = this.ctx!;
    const els = this.mixEls();
    let part = 0;
    let at = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(MIX_KEY) ?? 'null') as { part: number; t: number } | null;
      if (saved && saved.part >= 0 && saved.part < MIX.length) {
        part = saved.part;
        at = Math.max(0, saved.t - 2);
      }
    } catch {
      /* storage unavailable */
    }
    this.engine?.stop();
    this.startPart(els, part, at, ctx.currentTime, 0.6);
  }

  private startPart(els: [HTMLAudioElement, GainNode][], part: number, at: number, t: number, fade: number): void {
    const [oldEl, oldG] = els[this.fileSlot];
    if (this.fileTrack) {
      oldG.gain.setTargetAtTime(0, t, fade / 3);
      window.setTimeout(() => oldEl.pause(), fade * 1000 + 400);
      this.fileSlot = 1 - this.fileSlot;
    }
    const [el, g] = els[this.fileSlot];
    const track = MIX[part];
    if (!el.src.endsWith(track.url.replace(/^\.\//, ''))) el.src = track.url;
    el.loop = false;
    const seek = (): void => {
      if (at > 0 && Math.abs(el.currentTime - at) > 1) el.currentTime = at;
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener('loadedmetadata', seek, { once: true });
    void el.play().catch(() => {});
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(fade > 0.2 ? 0 : g.gain.value, t);
    g.gain.setTargetAtTime(1, t, fade / 3);
    this.fileTrack = track;
    this.mixPart = part;
  }

  /** Hand over to the next part (a hair before this one ends, so there is no gap). */
  private mixNext(): void {
    if (!this.ctx || !this.usingMix) return;
    const next = (this.mixPart + 1) % MIX.length;
    this.startPart(this.mixEls(), next, 0, this.ctx.currentTime, 0.12);
  }

  /** Called on every tap: (re)start the mix element if the browser held it back. */
  private kickMedia(): void {
    if (!this.ctx || !this.usingMix || !this.fileTrack || document.hidden) return;
    const els = this.mixEls();
    const [el] = els[this.fileSlot];
    if (el.paused) void el.play().catch(() => {});
    if (!this.mixPrimed) {
      // Unlock the second element now (silently, it is at zero gain) so the
      // hand-over to the next part may start it later without a tap.
      this.mixPrimed = true;
      const [other] = els[1 - this.fileSlot];
      other.src = MIX[(this.mixPart + 1) % MIX.length].url;
      void other
        .play()
        .then(() => other.pause())
        .catch(() => {});
    }
  }

  /** Per frame: seamless part hand-over and remembering the position. */
  private tickMix(dt: number): void {
    if (!this.usingMix || this.fileTrack?.mode !== 'mix') return;
    const [el] = this.fileEls[this.fileSlot];
    const d = el.duration;
    if (d && isFinite(d) && !el.paused && d - el.currentTime < 0.1) this.mixNext();
    // Preload the next part a little before it is needed.
    const [other] = this.fileEls[1 - this.fileSlot];
    const nextUrl = MIX[(this.mixPart + 1) % MIX.length].url;
    if (d && d - el.currentTime < 25 && !other.src.endsWith(nextUrl.replace(/^\.\//, ''))) {
      other.src = nextUrl;
      other.load();
    }
    this.mixSaveT += dt;
    if (this.mixSaveT > 5) {
      this.mixSaveT = 0;
      try {
        localStorage.setItem(MIX_KEY, JSON.stringify({ part: this.mixPart, t: Math.floor(el.currentTime) }));
      } catch {
        /* storage full / private mode */
      }
    }
  }

  private startScheduler(): void {
    if (!this.fileTrack) this.engine?.start();
    this.timer = window.setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      if (!this.fileTrack) this.engine?.pump();
    }, 25);
  }

  private playFile(list: MusicTrack[], mode: MusicMode): void {
    const ctx = this.ctx!;
    const i = (this.fileIdx.get(mode) ?? -1) + 1;
    this.fileIdx.set(mode, i);
    const track = list[i % list.length];
    if (this.fileTrack?.url === track.url) return;
    this.mixEls();
    const t = ctx.currentTime;
    const [oldEl, oldG] = this.fileEls[this.fileSlot];
    oldG.gain.setTargetAtTime(0, t, 0.4);
    window.setTimeout(() => oldEl.pause(), 1600);
    this.fileSlot = 1 - this.fileSlot;
    const [el, g] = this.fileEls[this.fileSlot];
    el.src = track.url;
    el.loop = list.length === 1;
    el.currentTime = 0;
    void el.play().catch(() => {});
    g.gain.setValueAtTime(0, t);
    g.gain.setTargetAtTime(1, t, 0.4);
    this.fileTrack = track;
    this.engine?.stop();
  }

  private stopFile(): void {
    if (!this.fileTrack || !this.ctx) return;
    const [el, g] = this.fileEls[this.fileSlot];
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    window.setTimeout(() => el.pause(), 1600);
    this.fileTrack = null;
    if (this.musicOn) this.engine?.start();
  }

  /** Call once per frame: advances the beat envelope used for visual sync. */
  update(dt: number): number {
    const ctx = this.ctx;
    if (ctx && ctx.state === 'running') this.tickMix(dt);
    if (!ctx || ctx.state !== 'running' || this.settings.muted || this.settings.musicMuted) {
      this.beat = Math.max(0, this.beat - dt * 4);
      return this.beat;
    }
    const now = ctx.currentTime;
    if (this.fileTrack) {
      // Onset detection on the low end of the file track.
      const a = this.analyser;
      if (!this.bassBins) this.bassBins = new Uint8Array(new ArrayBuffer(a.frequencyBinCount));
      a.getByteFrequencyData(this.bassBins);
      // Low end (~40-170 Hz): a kick is a jump above the recent average.
      let e = 0;
      for (let i = 1; i < 5; i++) e += this.bassBins[i];
      e /= 4 * 255;
      const flux = e - this.bassPrev;
      this.bassPrev = e;
      if (e > this.bassAvg * 1.12 && flux > 0.03 && e > 0.25 && now - this.lastFileBeat > 0.28) {
        this.lastFileBeat = now;
        this.lastKick = now;
        this.onBeat?.('kick');
      }
      this.bassAvg += (e - this.bassAvg) * Math.min(1, dt * 3);
    } else if (this.engine) {
      const beats = this.engine.beats;
      while (beats.length && beats[0].time <= now) {
        const b = beats.shift()!;
        if (b.kind === 'kick') this.lastKick = b.time;
        else this.lastSnare = b.time;
        this.onBeat?.(b.kind);
      }
    }
    const k = Math.exp(-(now - this.lastKick) * 7);
    const s = Math.exp(-(now - this.lastSnare) * 9) * 0.7;
    this.beat = Math.max(k, s) * (this.mode === 'menu' ? 0.5 : this.mode === 'gameover' ? 0.2 : 1);
    return this.beat;
  }

  // ------------------------------------------------------------------- sfx

  private tone(
    freq: number,
    dur: number,
    opts: { type?: OscillatorType; gain?: number; slideTo?: number; at?: number; attack?: number; filter?: number; detune?: number; send?: number } = {},
  ): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (opts.at ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (opts.detune) o.detune.value = opts.detune;
    if (opts.slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t0 + dur);
    const g = ctx.createGain();
    const peak = opts.gain ?? 0.2;
    const atk = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node: AudioNode = o;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.filter;
      o.connect(f);
      node = f;
    }
    node.connect(g).connect(this.sfxBus);
    if (opts.send) {
      const s = ctx.createGain();
      s.gain.value = opts.send;
      g.connect(s).connect(this.sfxFx.verb);
    }
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, opts: { gain?: number; type?: BiquadFilterType; freq?: number; freqTo?: number; q?: number; at?: number; send?: number; attack?: number } = {}): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (opts.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.setValueAtTime(opts.freq ?? 1000, t0);
    if (opts.freqTo) f.frequency.exponentialRampToValueAtTime(opts.freqTo, t0 + dur);
    f.Q.value = opts.q ?? 1;
    const g = ctx.createGain();
    if (opts.attack) {
      // Swell (risers), then a short release.
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.2, t0 + opts.attack);
    } else g.gain.setValueAtTime(opts.gain ?? 0.2, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    if (opts.send) {
      const s = ctx.createGain();
      s.gain.value = opts.send;
      g.connect(s).connect(this.sfxFx.verb);
    }
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.05);
  }

  /** A sub "thump" layer under impacts. */
  private sub(freq: number, dur: number, gain: number, at = 0): void {
    this.tone(freq, dur, { type: 'sine', gain, slideTo: freq * 0.45, at });
  }

  /** @param pitch semitone offset (e.g. rising coin streaks) */
  play(id: SoundId, pitch = 0): void {
    const ctx = this.ensure();
    if (!ctx || this.settings.muted || this.settings.sfxMuted || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const last = this.lastPlayed.get(id) ?? -1;
    if (now - last < 0.035) return;
    this.lastPlayed.set(id, now);

    const file = this.files.get(id);
    if (file) {
      const src = ctx.createBufferSource();
      src.buffer = file;
      src.playbackRate.value = Math.pow(2, pitch / 12);
      src.connect(this.sfxBus);
      src.start();
      return;
    }
    const k = Math.pow(2, pitch / 12);
    const fx = this.sfxFx;
    const t = now;
    switch (id) {
      case 'coin':
        // Bright two-note glint + shimmer.
        this.tone(1568 * k, 0.07, { type: 'square', gain: 0.045, filter: 7000 });
        this.tone(2093 * k, 0.22, { type: 'triangle', gain: 0.07, at: 0.045, send: 0.3 });
        this.tone(4186 * k, 0.12, { type: 'sine', gain: 0.02, at: 0.05 });
        break;
      case 'code':
        [0, 4, 7].forEach((s, i) => this.tone(midi(84 + s) * k, 0.08, { type: 'triangle', gain: 0.08, at: i * 0.03, send: 0.2 }));
        this.noise(0.05, { freq: 6000, type: 'highpass', gain: 0.05 });
        break;
      case 'chip':
        [0, 7, 12, 19].forEach((s, i) => this.tone(midi(84 + s), 0.12, { type: 'sine', gain: 0.09, at: i * 0.035, send: 0.3 }));
        break;
      case 'xp':
        this.tone(midi(72), 0.28, { type: 'triangle', gain: 0.1, slideTo: midi(96), send: 0.3 });
        bell(ctx, fx, t + 0.12, 96, 0.3, 0.5, 3.5, 0.3);
        break;
      case 'bugFix':
        // BUG FOUND scan blips -> PATCHING shimmer -> BUG FIXED resolve chord.
        this.tone(midi(76), 0.04, { type: 'square', gain: 0.05, filter: 5000 });
        this.tone(midi(79), 0.04, { type: 'square', gain: 0.05, at: 0.06, filter: 5000 });
        this.noise(0.18, { freq: 2000, freqTo: 9000, q: 3, gain: 0.07, at: 0.08 });
        [0, 4, 7, 12].forEach((s, i) => bell(ctx, fx, t + 0.16 + i * 0.045, 84 + s + pitch, 0.4, 0.8, 3.5, 0.4));
        this.sub(110, 0.2, 0.18, 0.16);
        break;
      case 'patch':
        [60, 64, 67, 72].forEach((n) => this.tone(midi(n), 0.6, { type: 'sawtooth', gain: 0.035, attack: 0.06, filter: 2600, send: 0.4 }));
        bell(ctx, fx, t + 0.1, 84, 0.5, 0.8, 2, 0.4);
        break;
      case 'power':
        sweep(ctx, fx, t, 0.45, true, 0.9);
        [60, 64, 67, 71, 74].forEach((n, i) => this.tone(midi(n + 12), 0.3, { type: 'square', gain: 0.05, at: i * 0.045, filter: 5000, send: 0.3 }));
        this.sub(90, 0.4, 0.25, 0.4);
        break;
      case 'debug':
        glitch(ctx, fx, t, 0.3, 1.2);
        for (let i = 0; i < 8; i++) this.tone(midi(72 + ((i * 5) % 17)), 0.05, { type: 'square', gain: 0.06, at: 0.1 + i * 0.03, filter: 6000 });
        this.tone(midi(40), 0.9, { type: 'sawtooth', gain: 0.1, slideTo: midi(52), filter: 1600, at: 0.1 });
        vox(ctx, fx, t + 0.35, 64, 0.35, 'a', 0.7, 5);
        this.sub(70, 0.6, 0.3, 0.35);
        break;
      case 'admin':
        [[60, 0], [64, 0.08], [67, 0.16], [72, 0.24], [76, 0.24], [79, 0.24]].forEach(([n, at]) =>
          this.tone(midi(n), 1.0 - at, { type: 'sawtooth', gain: 0.05, at, attack: 0.02, filter: 3800, send: 0.5 }),
        );
        this.noise(1.1, { freq: 8000, type: 'highpass', gain: 0.05, send: 0.5 });
        this.sub(55, 0.9, 0.35, 0.24);
        break;
      case 'shieldBreak':
        this.noise(0.45, { freq: 3500, freqTo: 700, q: 4, gain: 0.25, send: 0.4 });
        this.tone(1200, 0.35, { type: 'triangle', gain: 0.1, slideTo: 200 });
        this.sub(120, 0.25, 0.3);
        break;
      case 'hit':
      case 'error':
        // Harsh system-error buzz + crunch + sub impact.
        this.tone(110, 0.35, { type: 'sawtooth', gain: 0.18, slideTo: 55, filter: 2400 });
        this.tone(117, 0.35, { type: 'square', gain: 0.08, slideTo: 58, filter: 1800 });
        this.noise(0.22, { freq: 1500, q: 0.6, gain: 0.28 });
        glitch(ctx, fx, t + 0.05, 0.12, 0.8);
        if (id === 'hit') this.sub(90, 0.35, 0.45);
        break;
      case 'graze':
        this.tone(220, 0.15, { type: 'sawtooth', gain: 0.1, slideTo: 140, filter: 2000 });
        this.noise(0.1, { freq: 2500, gain: 0.12 });
        break;
      case 'nearMiss':
        // Whoosh past the ear.
        this.noise(0.32, { freq: 500, freqTo: 6000, q: 1.8, gain: 0.2 });
        this.tone(midi(88), 0.14, { type: 'sine', gain: 0.05, at: 0.08, send: 0.4 });
        break;
      case 'jump':
        this.tone(300, 0.15, { type: 'triangle', gain: 0.07, slideTo: 760 });
        this.noise(0.12, { freq: 1200, freqTo: 5000, q: 1.2, gain: 0.07 });
        break;
      case 'slide':
        this.noise(0.38, { freq: 2200, freqTo: 450, q: 1, gain: 0.12 });
        break;
      case 'land':
        this.sub(150, 0.12, 0.22);
        this.noise(0.06, { freq: 900, q: 0.8, gain: 0.08 });
        break;
      case 'lane':
        this.noise(0.09, { freq: 3000, freqTo: 5500, q: 2, gain: 0.06 });
        break;
      case 'comboTier':
        [0, 5, 7, 12].forEach((s, i) => this.tone(midi(76 + s + pitch), 0.18, { type: 'square', gain: 0.055, at: i * 0.055, filter: 6000, send: 0.3 }));
        vox(ctx, fx, t + 0.2, 69 + Math.min(pitch, 7), 0.22, 'e', 0.6, 3);
        break;
      case 'stage':
        sweep(ctx, fx, t, 0.7, true, 0.8);
        for (let i = 0; i < 6; i++) this.tone(midi(60 + ((i * 7) % 12)), 0.06, { type: 'square', gain: 0.045, at: 0.1 + i * 0.05, filter: 5000 });
        kick(ctx, this.sfxBus, t + 0.7, 0.8);
        break;
      case 'bossAlarm':
        for (let i = 0; i < 4; i++) {
          this.tone(660, 0.22, { type: 'sawtooth', gain: 0.07, at: i * 0.5, filter: 2500, send: 0.4 });
          this.tone(440, 0.22, { type: 'sawtooth', gain: 0.07, at: i * 0.5 + 0.25, filter: 2500, send: 0.4 });
        }
        this.sub(45, 1.8, 0.3);
        break;
      case 'bossPatch':
        this.tone(midi(72 + pitch), 0.2, { type: 'square', gain: 0.07, slideTo: midi(84 + pitch), filter: 5000, send: 0.3 });
        this.noise(0.2, { freq: 5000, type: 'highpass', gain: 0.06 });
        break;
      case 'bossDeleted':
        this.noise(1.6, { freq: 3000, freqTo: 80, q: 0.7, gain: 0.32, send: 0.6 });
        this.sub(80, 1.2, 0.5);
        [60, 64, 67, 72, 76].forEach((n, i) => bell(ctx, fx, t + 0.5 + i * 0.08, n + 12, 1.0, 0.9, 3.5, 0.5));
        break;
      case 'bossRiser':
        // Tension build under the boss entrance.
        this.noise(2.6, { freq: 300, freqTo: 6000, q: 1.2, gain: 0.16, attack: 2.3, send: 0.5 });
        this.tone(55, 2.6, { type: 'sawtooth', gain: 0.1, slideTo: 220, attack: 2.2, filter: 1200, send: 0.3 });
        this.tone(55.6, 2.6, { type: 'sawtooth', gain: 0.08, slideTo: 221, attack: 2.2, filter: 900 });
        break;
      case 'bossImpact':
        // The boss lands / arrives: sub drop, crunch and a long tail.
        this.sub(70, 1.6, 0.7);
        kick(ctx, this.sfxBus, t, 1.4, 1.3);
        this.noise(1.4, { freq: 1600, freqTo: 60, q: 0.6, gain: 0.34, send: 0.8 });
        this.noise(0.25, { freq: 5000, type: 'highpass', gain: 0.12 });
        glitch(ctx, fx, t + 0.15, 0.4, 0.8);
        break;
      case 'bossRoar':
        // Distorted digital growl with a vocal formant.
        [62, 65.5, 93, 124].forEach((f, i) => this.tone(f, 1.5, { type: 'sawtooth', gain: 0.09, slideTo: f * 0.62, attack: 0.08, filter: 900 + i * 300, detune: i * 9, send: 0.4 }));
        vox(ctx, fx, t + 0.05, 38, 1.3, 'a', 1, -7);
        this.noise(1.3, { freq: 700, freqTo: 180, q: 2, gain: 0.16, send: 0.5 });
        break;
      case 'bossHit':
        // Metallic clang when a patch lands on the boss.
        this.tone(midi(55 + pitch), 0.35, { type: 'square', gain: 0.07, slideTo: midi(43 + pitch), filter: 3000, send: 0.3 });
        bell(ctx, fx, t, 79 + pitch, 0.6, 0.8, 2.7, 0.4);
        this.noise(0.16, { freq: 6000, type: 'highpass', gain: 0.09 });
        this.sub(90, 0.3, 0.3);
        break;
      case 'bossExplode':
        this.noise(2.2, { freq: 2600, freqTo: 50, q: 0.5, gain: 0.4, send: 0.8 });
        this.sub(55, 1.8, 0.8);
        kick(ctx, this.sfxBus, t, 1.5, 1.4);
        glitch(ctx, fx, t + 0.2, 0.9, 1);
        break;
      case 'bossTelegraph':
        this.tone(1320, 0.07, { type: 'square', gain: 0.035, filter: 5000 });
        this.tone(990, 0.09, { type: 'square', gain: 0.035, at: 0.09, filter: 5000 });
        break;
      case 'bossVictory':
        [[60, 0], [64, 0.12], [67, 0.24], [72, 0.36], [76, 0.5], [79, 0.62]].forEach(([n, at]) => bell(ctx, fx, t + at, n + 12, 1.4, 0.9, 3.5, 0.6));
        stab(ctx, fx, t + 0.75, [60, 64, 67, 72], 1.6, 0.9, 4200);
        vox(ctx, fx, t + 0.78, 72, 1.1, 'a', 0.8, 5);
        this.sub(65, 1.2, 0.4, 0.75);
        break;
      case 'deleted':
        this.noise(0.18, { freq: 4000, freqTo: 800, q: 3, gain: 0.11 });
        this.tone(midi(96), 0.08, { type: 'square', gain: 0.035 });
        break;
      case 'crash':
        // System crash: power-down whine, crunch, sub drop, glitch tail.
        this.tone(440, 1.4, { type: 'sawtooth', gain: 0.16, slideTo: 30, filter: 2000, send: 0.3 });
        this.tone(445, 1.4, { type: 'square', gain: 0.07, slideTo: 32, filter: 1500 });
        this.noise(0.6, { freq: 800, q: 0.5, gain: 0.32, send: 0.4 });
        this.sub(70, 0.9, 0.55);
        glitch(ctx, fx, t + 0.1, 0.5, 1);
        break;
      case 'reboot':
      case 'boot':
        [0, 0.12, 0.24].forEach((at) => this.tone(1000, 0.07, { type: 'square', gain: 0.06, at, filter: 6000 }));
        sweep(ctx, fx, t + 0.3, 0.4, true, 0.6);
        [0, 7, 12, 16].forEach((s, i) => bell(ctx, fx, t + 0.72 + i * 0.06, 72 + s, 0.8, 0.7, 2, 0.5));
        this.sub(65, 0.5, 0.3, 0.72);
        break;
      case 'levelUp':
        [0, 4, 7, 12, 16, 19].forEach((s, i) => this.tone(midi(72 + s), 0.25, { type: 'square', gain: 0.05, at: i * 0.06, filter: 7000, send: 0.4 }));
        vox(ctx, fx, t + 0.36, 76, 0.4, 'a', 0.8, 7);
        this.sub(80, 0.5, 0.3, 0.36);
        break;
      case 'achievement':
        [[72, 0], [79, 0.1], [84, 0.2], [88, 0.3]].forEach(([n, at]) => bell(ctx, fx, t + at, n, 0.9, 0.9, 3.5, 0.5));
        this.tone(midi(60), 1.2, { type: 'sawtooth', gain: 0.03, attack: 0.1, filter: 2000, send: 0.6 });
        break;
      case 'ui':
        this.tone(1900, 0.035, { type: 'square', gain: 0.04, filter: 8000 });
        this.tone(2800, 0.05, { type: 'sine', gain: 0.025, at: 0.02 });
        break;
    }
  }
}

export const audio = new AudioManager();
