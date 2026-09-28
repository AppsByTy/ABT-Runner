import type { Buses } from './synth';
import { VoiceBank } from './VoiceBank';

/**
 * Procedural hip-hop / trap soundtrack. Original compositions generated in
 * real time: 808s with glides, punchy kicks, flammed claps, swung hats with
 * rolls, pads, FM bell hooks, supersaw stabs, formant vocal chops and
 * glitch fills. Arrangement reacts to the game mode and intensity and
 * changes land on bar / phrase boundaries so transitions stay musical.
 */

export type MusicMode = 'menu' | 'run' | 'debug' | 'boss' | 'gameover';

interface Chord {
  /** Semitones above the song key. */
  deg: number;
  minor: boolean;
}

interface Song {
  name: string;
  bpm: number;
  /** 808 key (MIDI, ~C1..E2). */
  key: number;
  prog: Chord[];
  /** 32-step (2-bar) kick pattern: 1 = kick + 808. */
  kick: number[];
  /** Lead hook: [step (0..31), minor-pentatonic index, length in steps]. */
  hook: [number, number, number][];
  /** Vocal chops: [step, semitone offset, vowel, length (steps), pitch flip]. */
  vox: [number, number, 'a' | 'e' | 'o' | 'u' | 'i', number, number][];
  lead: 'bell' | 'stab';
  bellRatio: number;
  padBright: number;
  drive: number;
}

const K = (hits: number[]): number[] => {
  const a = new Array(32).fill(0);
  for (const h of hits) a[h] = 1;
  return a;
};

export const SONGS: Song[] = [
  {
    name: 'STACK OVERFLOW',
    bpm: 140,
    key: 36, // C
    prog: [{ deg: 0, minor: true }, { deg: 8, minor: false }, { deg: 3, minor: false }, { deg: 10, minor: false }],
    kick: K([0, 7, 10, 16, 22, 26, 29]),
    hook: [[0, 7, 3], [4, 6, 2], [6, 5, 2], [8, 4, 4], [14, 3, 2], [16, 7, 3], [20, 8, 2], [22, 7, 2], [24, 5, 6]],
    vox: [[12, 12, 'a', 3, 0], [28, 15, 'o', 2, -2], [30, 12, 'e', 2, 5]],
    lead: 'bell',
    bellRatio: 3.5,
    padBright: 1,
    drive: 3,
  },
  {
    name: 'NULL POINTER',
    bpm: 146,
    key: 29, // F
    prog: [{ deg: 0, minor: true }, { deg: 8, minor: false }, { deg: 5, minor: true }, { deg: 7, minor: false }],
    kick: K([0, 3, 10, 16, 19, 24, 27]),
    hook: [[0, 5, 2], [2, 5, 2], [4, 7, 2], [6, 5, 2], [8, 4, 3], [12, 3, 2], [16, 5, 2], [18, 5, 2], [20, 8, 2], [22, 7, 2], [24, 5, 4]],
    vox: [[8, 12, 'i', 2, 0], [10, 12, 'i', 2, 0], [24, 10, 'a', 4, -3]],
    lead: 'stab',
    bellRatio: 2,
    padBright: 0.8,
    drive: 4,
  },
  {
    name: 'PUSH TO PROD',
    bpm: 136,
    key: 33, // A
    prog: [{ deg: 0, minor: true }, { deg: 8, minor: false }, { deg: 3, minor: false }, { deg: 10, minor: false }],
    kick: K([0, 6, 11, 16, 20, 23, 28]),
    hook: [[0, 4, 2], [3, 5, 2], [6, 7, 3], [10, 8, 2], [12, 7, 4], [16, 4, 2], [19, 5, 2], [22, 3, 3], [26, 2, 2], [28, 3, 4]],
    vox: [[14, 12, 'e', 2, 3], [30, 7, 'u', 2, 5]],
    lead: 'bell',
    bellRatio: 5,
    padBright: 1.2,
    drive: 2.5,
  },
];

/** The virus fight: dark phrygian, faster, distorted. */
export const BOSS_SONG: Song = {
  name: 'KERNEL PANIC',
  bpm: 150,
  key: 25, // C#
  prog: [{ deg: 0, minor: true }, { deg: 1, minor: false }, { deg: 0, minor: true }, { deg: 8, minor: false }],
  kick: K([0, 3, 6, 10, 16, 19, 22, 26, 28]),
  hook: [[0, 5, 1], [2, 6, 1], [4, 5, 1], [6, 6, 1], [8, 8, 4], [16, 5, 1], [18, 6, 1], [20, 5, 1], [22, 4, 6]],
  vox: [[12, 7, 'o', 3, -5], [28, 12, 'a', 3, -7]],
  lead: 'stab',
  bellRatio: 1.5,
  padBright: 0.6,
  drive: 7,
};

const PENTA = [0, 3, 5, 7, 10];
const penta = (i: number): number => PENTA[((i % 5) + 5) % 5] + Math.floor(i / 5) * 12;

export interface BeatEvent {
  time: number;
  kind: 'kick' | 'snare';
  bar: number;
}

export class HipHopEngine {
  private readonly ctx: AudioContext;
  private readonly drums: Buses;
  private readonly bassOut: AudioNode;
  private readonly inst: Buses;
  readonly beats: BeatEvent[] = [];
  /** Sidechain: instrument bus gain ducked on every kick. */
  duck: GainNode | null = null;
  /** Tempo-synced delay line (dotted 8th) updated on tempo changes. */
  delayNode: DelayNode | null = null;

  mode: MusicMode = 'menu';
  /** 0..3 within a run (combo / power level). */
  intensity = 1;
  private songIdx = 0;
  private song: Song = SONGS[0];
  private queuedSong: number | null = null;
  private step = 0;
  private bar = 0;
  private phraseBar = 0;
  private nextTime = 0;
  private bpm = 90;
  private running = false;
  /** Bars since the last automatic track change. */
  private barsOnSong = 0;

  /** Pre-rendered instrument voices (keeps live audio-node churn tiny). */
  readonly v: VoiceBank;

  constructor(ctx: AudioContext, drums: Buses, bassOut: AudioNode, inst: Buses) {
    this.ctx = ctx;
    this.v = new VoiceBank(ctx);
    this.drums = drums;
    this.bassOut = bassOut;
    this.inst = inst;
  }

  get songName(): string {
    return this.mode === 'boss' ? BOSS_SONG.name : this.song.name;
  }

  /** Render every voice the soundtrack will need, ahead of time, in the background. */
  warm(): void {
    const save = { mode: this.mode, intensity: this.intensity, song: this.song, bar: this.bar, phraseBar: this.phraseBar, bpm: this.bpm };
    const beats = this.beats.length;
    this.v.dry = true;
    const passes: [MusicMode, number, Song][] = [];
    for (const song of SONGS) {
      passes.push(['menu', 1, song], ['run', 1, song], ['run', 3, song], ['debug', 3, song]);
    }
    passes.push(['boss', 3, BOSS_SONG]);
    for (const [mode, I, song] of passes) {
      this.mode = mode;
      this.intensity = I;
      this.song = song;
      this.bpm = mode === 'menu' ? 88 : song.bpm;
      const sx = 60 / this.bpm / 4;
      for (let bar = 0; bar < 8; bar++) {
        this.bar = bar;
        this.phraseBar = bar;
        for (let st = 0; st < 16; st++) this.playStep((bar % 2) * 16 + st, 0, sx);
      }
    }
    this.v.dry = false;
    this.beats.length = beats;
    Object.assign(this, save);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextTime = this.ctx.currentTime + 0.12;
    this.step = 0;
  }

  stop(): void {
    this.running = false;
  }

  /** Queue a different track for the next phrase (stage changes). */
  cue(index: number): void {
    const i = ((index % SONGS.length) + SONGS.length) % SONGS.length;
    if (i !== this.songIdx) this.queuedSong = i;
  }

  private tempoFor(): number {
    const s = this.mode === 'boss' ? BOSS_SONG : this.song;
    if (this.mode === 'menu') return 88;
    if (this.mode === 'gameover') return 80;
    return s.bpm;
  }

  /** Called from a short interval timer: schedules everything in the look-ahead window. */
  pump(): void {
    if (!this.running) return;
    const ctx = this.ctx;
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.05; // resumed after a stall
    while (this.nextTime < ctx.currentTime + 0.14) {
      if (this.step % 16 === 0) this.onBar();
      const sixteenth = 60 / this.bpm / 4;
      // Swing: delay off-16ths slightly.
      const swing = this.step % 2 === 1 ? sixteenth * 0.07 : 0;
      this.playStep(this.step % 32, this.nextTime + swing, sixteenth);
      this.step++;
      this.nextTime += sixteenth;
    }
    // Drop stale beat events.
    while (this.beats.length > 64) this.beats.shift();
  }

  private onBar(): void {
    this.bar++;
    this.phraseBar = (this.phraseBar + 1) % 8;
    this.bpm = this.tempoFor();
    if (this.delayNode) this.delayNode.delayTime.setTargetAtTime((60 / this.bpm) * 0.75, this.ctx.currentTime, 0.05);
    if (this.phraseBar === 0) {
      this.barsOnSong += 8;
      if (this.mode === 'run' || this.mode === 'debug') {
        if (this.queuedSong === null && this.barsOnSong >= 32) this.queuedSong = (this.songIdx + 1) % SONGS.length;
      }
      if (this.queuedSong !== null) {
        this.songIdx = this.queuedSong;
        this.song = SONGS[this.songIdx];
        this.queuedSong = null;
        this.barsOnSong = 0;
        this.step = 0;
        this.bpm = this.tempoFor();
      }
    }
  }

  private playStep(s: number, t: number, sx: number): void {
    const song = this.mode === 'boss' ? BOSS_SONG : this.song;
    const mode = this.mode;
    const I = mode === 'debug' ? 3 : mode === 'boss' ? 3 : this.intensity;
    const chordIdx = Math.floor(this.bar / 2) % song.prog.length;
    const ch = song.prog[chordIdx];
    const nextCh = song.prog[(chordIdx + 1) % song.prog.length];
    const root = song.key + ch.deg;
    const bassNote = root > song.key + 7 ? root - 12 : root;
    const barStep = s % 16;
    const lastBar = this.phraseBar === 7;
    const hum = (): number => 0.85 + Math.random() * 0.15;

    // ---------------------------------------------------------- menu / game over
    if (mode === 'menu' || mode === 'gameover') {
      if (barStep === 0 && this.bar % 2 === 0) {
        const tri = ch.minor ? 3 : 4;
        this.v.pad(this.inst, t, [root + 36, root + 36 + tri, root + 43, root + 46], sx * 32, mode === 'gameover' ? 0.8 : 1, 0.7);
      }
      if (mode === 'gameover') return;
      // Lo-fi half-time groove.
      if (barStep === 0 || (barStep === 10 && this.bar % 2 === 1)) {
        this.v.kick(this.drums, t, 0.55);
        if (barStep === 0) this.v.bass808(this.bassOut, t, bassNote, sx * 12, 0.7, undefined, 1.5);
      }
      if (barStep === 8) this.v.rim(this.drums, t, 0.7);
      if (barStep % 4 === 2) this.v.hat(this.drums, t, 0.35 * hum(), false, 0.8);
      const h = song.hook.find(([st]) => st === s);
      if (h && this.bar % 4 < 2) this.v.bell(this.inst, t, song.key + 48 + penta(h[1]), sx * h[2] * 2, 0.55, song.bellRatio, 0.7);
      return;
    }

    // ------------------------------------------------------------- run / debug / boss
    // Kick + 808.
    if (song.kick[s]) {
      const vel = barStep === 0 ? 1 : 0.9;
      this.v.kick(this.drums, t, vel, mode === 'boss' ? 1.1 : 1);
      this.beats.push({ time: t, kind: 'kick', bar: this.bar });
      if (this.duck && !this.v.dry) {
        this.duck.gain.setValueAtTime(0.45, t);
        this.duck.gain.setTargetAtTime(1, t + 0.02, 0.09);
      }
      // 808 length: until the next kick.
      let n = 1;
      while (n < 16 && !song.kick[(s + n) % 32]) n++;
      const glide = I >= 2 && s >= 26 && this.bar % 2 === 1 ? song.key + nextCh.deg - (song.key + nextCh.deg > song.key + 7 ? 12 : 0) : undefined;
      const oct = I >= 3 && s % 16 === 10 ? 12 : 0;
      this.v.bass808(this.bassOut, t, bassNote + oct, sx * n * 0.95, 1, glide, song.drive);
    }
    // Snare/clap on beat 3 of each bar (half-time trap), rolls in fills.
    if (barStep === 8) {
      this.v.clap(this.drums, t, 1);
      this.beats.push({ time: t, kind: 'snare', bar: this.bar });
    }
    if (lastBar && barStep >= 12 && I >= 1) {
      // Snare roll into the next phrase.
      const n = barStep >= 14 ? 2 : 1;
      for (let i = 0; i < n; i++) this.v.clap(this.drums, t + (i * sx) / n, 0.35 + (barStep - 12) * 0.12, 0.2);
    }
    // Hats: 8ths at low intensity, 16ths above, with triplet / 32nd rolls.
    const hatEvery = I >= 2 ? 1 : 2;
    if (barStep % hatEvery === 0) {
      const rollHere = (I >= 2 && (barStep === 6 || barStep === 14) && this.bar % 2 === 1) || (lastBar && barStep >= 12);
      if (rollHere) {
        const n = barStep === 14 || mode === 'boss' ? 4 : 3;
        for (let i = 0; i < n; i++) this.v.hat(this.drums, t + (i * sx) / n, 0.45 + i * 0.12, false, 1 + i * 0.03);
      } else {
        this.v.hat(this.drums, t, (barStep % 4 === 0 ? 0.75 : 0.5) * hum(), false);
      }
    }
    if (I >= 2 && barStep === 12 && this.bar % 2 === 0) this.v.hat(this.drums, t, 0.5, true);
    if (I >= 1 && barStep === 3 && this.bar % 4 === 3) this.v.rim(this.drums, t, 0.6);

    // Pad on chord changes.
    if (barStep === 0 && this.bar % 2 === 0) {
      const tri = ch.minor ? 3 : 4;
      this.v.pad(this.inst, t, [root + 36, root + 36 + tri, root + 43, root + 46], sx * 32, mode === 'boss' ? 0.9 : 0.75, song.padBright * (I >= 3 ? 1.5 : 1));
    }
    // Phrase start: open "crash" hat + reverse swell.
    if (this.phraseBar === 0 && barStep === 0) this.v.hat(this.drums, t, 0.6, true, 0.7);
    if (lastBar && barStep === 8) this.v.sweep(this.inst, t, sx * 8, true, 0.7 + I * 0.1);

    // Lead hook (from intensity 2, or every other phrase at 1).
    const leadOn = I >= 2 || (I >= 1 && Math.floor(this.bar / 8) % 2 === 1);
    if (leadOn) {
      const h = song.hook.find(([st]) => st === s);
      if (h) {
        const note = song.key + 48 + penta(h[1]);
        if (song.lead === 'bell') this.v.bell(this.inst, t, note, sx * h[2] * 1.6, 1, song.bellRatio);
        else this.v.stab(this.inst, t, [note, note + 7], sx * h[2] * 1.2, 1, mode === 'boss' ? 2200 : 3600);
      }
    }
    // Vocal chops at high energy.
    if (I >= 3) {
      const v = song.vox.find(([st]) => st === s);
      if (v && this.bar % 2 === 1) this.v.vox(this.inst, t, song.key + 36 + v[1], sx * v[3], v[2], 0.9, v[4]);
    }
    // Debug mode: glitch stutters and a brighter counter-melody.
    if (mode === 'debug' && barStep === 14 && this.bar % 2 === 1) this.v.glitch(this.inst, t, sx * 2, 1);
    if (mode === 'debug' && barStep % 4 === 2) this.v.bell(this.inst, t, song.key + 60 + penta((s * 3) % 7), sx * 1.5, 0.35, 7, 0.6);
    // Boss: siren.
    if (mode === 'boss' && barStep === 0 && this.bar % 2 === 1) {
      this.v.stab(this.inst, t, [root + 55], sx * 8, 0.8, 1800);
    }
  }
}
