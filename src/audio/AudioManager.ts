/**
 * All game audio goes through here. Every sound is synthesised with the Web
 * Audio API, but any id can be overridden with a real file later via
 * `loadFile(id, url)`, so sound design can be swapped in without touching
 * gameplay code.
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
  | 'deleted'
  | 'crash'
  | 'reboot'
  | 'ui';

const STORE_KEY = 'coderunner.audio.v1';

interface Settings {
  muted: boolean;
  music: number;
  sfx: number;
}

const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private delay!: DelayNode;
  private noiseBuf!: AudioBuffer;
  private readonly files = new Map<SoundId, AudioBuffer>();
  private settings: Settings = { muted: false, music: 0.5, sfx: 0.8 };
  private lastPlayed = new Map<SoundId, number>();

  // Music sequencer state
  private musicOn = false;
  private step = 0;
  private nextNoteTime = 0;
  private timer: number | null = null;
  private intensity = 0;
  private tempo = 112;
  private boss = false;
  private duck = 1;

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
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  get muted(): boolean {
    return this.settings.muted;
  }

  setMuted(m: boolean): void {
    this.settings.muted = m;
    this.save();
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.settings.sfx;
    this.sfxBus.connect(this.master);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 18000;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.settings.music;
    this.musicBus.connect(this.musicFilter).connect(this.master);
    // Shared tempo-ish delay for arps.
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = 0.2;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.delay.connect(fb).connect(this.delay);
    this.delay.connect(wet).connect(this.musicBus);
    // White noise buffer.
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
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

  // --------------------------------------------------------------- primitives

  private tone(
    freq: number,
    dur: number,
    opts: { type?: OscillatorType; gain?: number; slideTo?: number; at?: number; attack?: number; bus?: AudioNode; filter?: number; detune?: number } = {},
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
    const atk = opts.attack ?? 0.005;
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
    node.connect(g).connect(opts.bus ?? this.sfxBus);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, opts: { gain?: number; type?: BiquadFilterType; freq?: number; freqTo?: number; q?: number; at?: number; bus?: AudioNode } = {}): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (opts.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.setValueAtTime(opts.freq ?? 1000, t0);
    if (opts.freqTo) f.frequency.exponentialRampToValueAtTime(opts.freqTo, t0 + dur);
    f.Q.value = opts.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(opts.gain ?? 0.2, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(opts.bus ?? this.sfxBus);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  // ------------------------------------------------------------------ sfx

  /** @param pitch semitone offset (e.g. rising coin streaks) */
  play(id: SoundId, pitch = 0): void {
    const ctx = this.ensure();
    if (!ctx || this.settings.muted || ctx.state !== 'running') return;
    // Rate-limit identical sounds so coin trails don't clip.
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
    switch (id) {
      case 'coin':
        this.tone(1320 * k, 0.08, { type: 'square', gain: 0.07 });
        this.tone(1980 * k, 0.16, { type: 'square', gain: 0.06, at: 0.05 });
        break;
      case 'code':
        [0, 4, 7].forEach((s, i) => this.tone(midi(84 + s) * k, 0.07, { type: 'triangle', gain: 0.09, at: i * 0.035 }));
        break;
      case 'chip':
        [0, 7, 12, 19].forEach((s, i) => this.tone(midi(84 + s), 0.12, { type: 'sine', gain: 0.1, at: i * 0.04 }));
        break;
      case 'xp':
        this.tone(midi(72), 0.25, { type: 'triangle', gain: 0.12, slideTo: midi(96) });
        break;
      case 'bugFix': {
        // "Scanning" blips then a bright resolved chime.
        this.tone(midi(76), 0.05, { type: 'square', gain: 0.06 });
        this.tone(midi(79), 0.05, { type: 'square', gain: 0.06, at: 0.06 });
        [0, 4, 7, 12].forEach((s, i) => this.tone(midi(84 + s) * k, 0.22, { type: 'triangle', gain: 0.12, at: 0.13 + i * 0.05 }));
        this.tone(midi(108) * k, 0.35, { type: 'sine', gain: 0.05, at: 0.32 });
        break;
      }
      case 'patch':
        [60, 64, 67, 72].forEach((n) => this.tone(midi(n), 0.6, { type: 'sawtooth', gain: 0.04, attack: 0.08, filter: 2400 }));
        this.tone(midi(84), 0.4, { type: 'sine', gain: 0.08, at: 0.1 });
        break;
      case 'power':
        this.noise(0.5, { freq: 400, freqTo: 6000, q: 3, gain: 0.12 });
        [60, 64, 67, 71, 74].forEach((n, i) => this.tone(midi(n + 12), 0.3, { type: 'square', gain: 0.06, at: i * 0.05, filter: 5000 }));
        break;
      case 'debug':
        for (let i = 0; i < 10; i++) this.tone(midi(72 + ((i * 5) % 17)), 0.05, { type: 'square', gain: 0.07, at: i * 0.035 });
        this.tone(midi(48), 0.8, { type: 'sawtooth', gain: 0.08, slideTo: midi(60), filter: 1800 });
        break;
      case 'admin':
        [[60, 0], [64, 0.1], [67, 0.2], [72, 0.3], [76, 0.3], [79, 0.3]].forEach(([n, at]) =>
          this.tone(midi(n), 0.9 - at, { type: 'sawtooth', gain: 0.06, at, attack: 0.02, filter: 3500 }),
        );
        this.noise(1.0, { freq: 8000, type: 'highpass', gain: 0.05 });
        break;
      case 'shieldBreak':
        this.noise(0.4, { freq: 3000, freqTo: 800, q: 4, gain: 0.25 });
        this.tone(900, 0.3, { type: 'triangle', gain: 0.12, slideTo: 200 });
        break;
      case 'hit':
        // Harsh "error" buzz + crunch.
        this.tone(110, 0.35, { type: 'sawtooth', gain: 0.22, slideTo: 55 });
        this.tone(116, 0.35, { type: 'square', gain: 0.1, slideTo: 60 });
        this.noise(0.25, { freq: 1500, q: 0.6, gain: 0.3 });
        break;
      case 'graze':
        this.tone(220, 0.15, { type: 'sawtooth', gain: 0.12, slideTo: 140 });
        this.noise(0.1, { freq: 2500, gain: 0.12 });
        break;
      case 'nearMiss':
        this.noise(0.3, { freq: 600, freqTo: 5000, q: 2, gain: 0.2 });
        this.tone(midi(88), 0.12, { type: 'sine', gain: 0.06, at: 0.08 });
        break;
      case 'jump':
        this.tone(320, 0.14, { type: 'square', gain: 0.06, slideTo: 720, filter: 3000 });
        break;
      case 'slide':
        this.noise(0.35, { freq: 1800, freqTo: 500, q: 1, gain: 0.12 });
        break;
      case 'land':
        this.tone(140, 0.1, { type: 'sine', gain: 0.18, slideTo: 60 });
        break;
      case 'lane':
        this.noise(0.08, { freq: 3500, q: 2, gain: 0.07 });
        break;
      case 'comboTier':
        [0, 5, 7, 12].forEach((s, i) => this.tone(midi(76 + s + pitch), 0.18, { type: 'square', gain: 0.07, at: i * 0.06, filter: 6000 }));
        break;
      case 'stage':
        this.noise(0.8, { freq: 200, freqTo: 4000, q: 5, gain: 0.15 });
        for (let i = 0; i < 6; i++) this.tone(midi(60 + ((i * 7) % 12)), 0.06, { type: 'square', gain: 0.05, at: 0.1 + i * 0.05 });
        break;
      case 'bossAlarm':
        for (let i = 0; i < 4; i++) {
          this.tone(660, 0.22, { type: 'sawtooth', gain: 0.08, at: i * 0.5, filter: 2500 });
          this.tone(440, 0.22, { type: 'sawtooth', gain: 0.08, at: i * 0.5 + 0.25, filter: 2500 });
        }
        break;
      case 'bossPatch':
        this.tone(midi(72 + pitch), 0.2, { type: 'square', gain: 0.08, slideTo: midi(84 + pitch), filter: 5000 });
        this.noise(0.2, { freq: 5000, type: 'highpass', gain: 0.06 });
        break;
      case 'bossDeleted':
        this.noise(1.6, { freq: 3000, freqTo: 80, q: 0.7, gain: 0.35 });
        this.tone(80, 1.2, { type: 'sine', gain: 0.35, slideTo: 30 });
        [60, 64, 67, 72, 76].forEach((n, i) => this.tone(midi(n + 12), 1.0, { type: 'triangle', gain: 0.08, at: 0.5 + i * 0.08 }));
        break;
      case 'deleted':
        this.noise(0.18, { freq: 4000, freqTo: 800, q: 3, gain: 0.12 });
        this.tone(midi(96), 0.08, { type: 'square', gain: 0.04 });
        break;
      case 'crash':
        this.tone(440, 1.4, { type: 'sawtooth', gain: 0.18, slideTo: 30, filter: 2000 });
        this.tone(445, 1.4, { type: 'square', gain: 0.08, slideTo: 32 });
        this.noise(0.6, { freq: 800, q: 0.5, gain: 0.35 });
        break;
      case 'reboot':
        [0, 0.12, 0.24].forEach((at) => this.tone(1000, 0.08, { type: 'square', gain: 0.07, at }));
        this.tone(midi(72), 0.5, { type: 'triangle', gain: 0.1, at: 0.5, slideTo: midi(84) });
        break;
      case 'ui':
        this.tone(1800, 0.04, { type: 'square', gain: 0.05 });
        break;
    }
  }

  // ---------------------------------------------------------------- music

  startMusic(): void {
    this.musicOn = true;
    if (this.ctx && this.timer === null) this.startScheduler();
  }

  stopMusic(): void {
    this.musicOn = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 0 = menu, 1 = running, 2 = high combo, 3 = frantic. */
  setIntensity(level: number): void {
    this.intensity = level;
  }

  setStage(stage: number): void {
    this.tempo = 112 + Math.min(7, stage) * 4;
  }

  setBoss(on: boolean): void {
    this.boss = on;
  }

  /** Muffle the music (pause, game over). */
  setMuffled(on: boolean): void {
    if (!this.ctx) return;
    this.musicFilter.frequency.setTargetAtTime(on ? 700 : 18000, this.ctx.currentTime, 0.15);
    this.duck = on ? 0.6 : 1;
    this.musicBus.gain.setTargetAtTime(this.settings.music * this.duck, this.ctx.currentTime, 0.15);
  }

  private startScheduler(): void {
    const ctx = this.ctx!;
    this.nextNoteTime = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.settings.muted) {
      if (ctx) this.nextNoteTime = ctx.currentTime + 0.05;
      return;
    }
    const sixteenth = 60 / this.tempo / 4;
    while (this.nextNoteTime < ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextNoteTime - ctx.currentTime);
      this.step = (this.step + 1) % 128;
      this.nextNoteTime += sixteenth;
    }
  }

  private playStep(step: number, at: number): void {
    const bus = this.musicBus;
    const bar = Math.floor(step / 16) % 8;
    const s = step % 16;
    // A minor: Am F C G  (boss: Am Bb Am E)
    const roots = this.boss ? [45, 46, 45, 40] : [45, 41, 48, 43];
    const minorish = this.boss ? [true, false, true, false] : [true, false, false, false];
    const chordIdx = Math.floor(bar / 2) % 4;
    const root = roots[chordIdx];
    const third = minorish[chordIdx] ? 3 : 4;
    const chord = [0, third, 7, 12];
    const I = this.intensity;

    // Pad on chord changes.
    if (s === 0 && bar % 2 === 0) {
      for (const n of [0, third, 7]) {
        this.tone(midi(root + 24 + n), (60 / this.tempo) * 8, { type: 'sawtooth', gain: 0.018, attack: 0.4, filter: 1400, bus, at, detune: 8 });
      }
    }
    if (I >= 1) {
      // Four-on-the-floor kick.
      if (s % 4 === 0) this.tone(150, 0.25, { type: 'sine', gain: 0.35, slideTo: 42, at, bus });
      // Offbeat bass.
      if (s % 4 === 2 || (I >= 2 && s % 4 === 3)) {
        this.tone(midi(root + (s % 8 === 6 ? 12 : 0)), 0.14, { type: 'sawtooth', gain: 0.09, filter: 900 + I * 250, at, bus });
      }
    }
    if (I >= 2 || this.boss) {
      if (s % 2 === 1) this.noise(0.04, { freq: 9000, type: 'highpass', gain: 0.045, at, bus });
      if (s === 4 || s === 12) this.noise(0.14, { freq: 1800, q: 0.8, gain: 0.12, at, bus });
    }
    // Arp: always present, busier with intensity.
    const arpEvery = I >= 2 ? 1 : 2;
    if (s % arpEvery === 0) {
      const n = chord[(s / arpEvery) % chord.length];
      this.tone(midi(root + 36 + n), 0.12, { type: I >= 3 ? 'square' : 'triangle', gain: I === 0 ? 0.03 : 0.04, filter: 4000, at, bus: this.delay });
      this.tone(midi(root + 36 + n), 0.12, { type: I >= 3 ? 'square' : 'triangle', gain: I === 0 ? 0.03 : 0.04, filter: 4000, at, bus });
    }
    // Boss siren lead.
    if (this.boss && s === 0 && bar % 2 === 1) {
      this.tone(midi(root + 31), 0.5, { type: 'sawtooth', gain: 0.035, slideTo: midi(root + 30), filter: 2200, at, bus });
    }
  }
}

export const audio = new AudioManager();
