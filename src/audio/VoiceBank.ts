import { bass808, bell, clap, glitch, hat, kick, pad, rim, stab, sweep, vox, type Buses } from './synth';

/**
 * Pre-rendered instrument voices.
 *
 * Synthesising every note live creates dozens of Web Audio nodes per beat.
 * Mobile Safari garbage-collects audio nodes slowly, so a long, busy session
 * (high combo, DEBUG MODE) piles up thousands of dead nodes until iOS kills
 * the tab. Instead, each distinct sound (a kick, an 808 note, a chord...) is
 * rendered ONCE in an OfflineAudioContext and then played back from an
 * AudioBuffer: ~4 short-lived nodes per hit instead of 10-40.
 *
 * Buffers carry 3 channels: dry, reverb send, delay send, so the shared live
 * reverb/delay still work.
 */

type Render = (ctx: AudioContext, b: Buses) => void;

interface Job {
  key: string;
  dur: number;
  render: Render;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

export class VoiceBank {
  private readonly ctx: AudioContext;
  private readonly cache = new Map<string, { buf: AudioBuffer; verb: number; delay: number }>();
  private readonly queued = new Set<string>();
  private readonly queue: Job[] = [];
  private busy = 0;
  /** Live voices currently sounding (hard cap protects slow devices). */
  private live = 0;
  private static readonly MAX_LIVE = 48;
  /** When true, calls only request renders (prewarming) and play nothing. */
  dry = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get pending(): number {
    return this.queue.length + this.busy;
  }

  // ---------------------------------------------------------------- voices

  kick(b: Buses, t: number, vel = 1, punch = 1): void {
    this.hit(`k${punch}`, 0.42, (c, x) => kick(c, x.out, 0, 1, punch), b, t, vel);
  }

  clap(b: Buses, t: number, vel = 1, wet = 0.35): void {
    this.hit(`c${wet}`, 0.3, (c, x) => clap(c, x, 0, 1, wet), b, t, vel);
  }

  hat(b: Buses, t: number, vel = 1, open = false, tone = 1): void {
    // Hats are velocity-shaped in the synth (decay); quantise into 3 layers.
    const v = vel > 0.7 ? 0.85 : vel > 0.5 ? 0.6 : 0.4;
    tone = tone < 0.9 ? 0.8 : 1;
    this.hit(`h${open ? 1 : 0}${tone}${v}`, open ? 0.34 : 0.1, (c, x) => hat(c, x.out, 0, v, open, tone), b, t, vel / v);
  }

  rim(b: Buses, t: number, vel = 1): void {
    this.hit('r', 0.08, (c, x) => rim(c, x, 0, 1), b, t, vel);
  }

  /**
   * 808: one long render per drive setting, pitched with playbackRate
   * (classic sampler) - glides are playbackRate ramps.
   */
  bass808(out: AudioNode, t: number, note: number, len: number, vel = 1, glideTo?: number, drive = 3): void {
    const base = 36;
    const rate = Math.pow(2, (note - base) / 12);
    const glide = glideTo !== undefined ? { at: len * 0.55, to: Math.pow(2, (glideTo - base) / 12), end: len * 0.9 } : undefined;
    this.hit(`b${drive}`, 2.2, (c, x) => bass808(c, x.out, 0, base, 1.8, 1, undefined, drive), { out, verb: out, delay: out }, t, vel, len, rate, glide);
  }

  /** Pads are long (seconds) and rare (one per 2 bars): synthesised live, not cached. */
  pad(b: Buses, t: number, notes: number[], len: number, vel = 1, bright = 1): void {
    if (!this.dry) pad(this.ctx, b, t, notes, len, vel, bright);
  }

  /** Pitched instruments: a few rendered base notes, transposed by playbackRate (max +-6 semitones). */
  private pitched(prefix: string, note: number, bases: number[], dur: number, render: (base: number) => Render, b: Buses, t: number, vel: number, len: number): void {
    let base = bases[0];
    for (const x of bases) if (Math.abs(x - note) < Math.abs(base - note)) base = x;
    this.hit(`${prefix}@${base}`, dur, render(base), b, t, vel, len, Math.pow(2, (note - base) / 12));
  }

  bell(b: Buses, t: number, note: number, len: number, vel = 1, ratio = 3.5, send = 0.4): void {
    this.pitched(`be${ratio}s${send}`, note, [54, 66, 78, 90], 1.0, (base) => (c, x) => bell(c, x, 0, base, 0.85, 1, ratio, send), b, t, vel, len + 0.12);
  }

  stab(b: Buses, t: number, notes: number[], len: number, vel = 1, cutoff = 3200): void {
    const intervals = notes.map((n) => n - notes[0]).join('.');
    this.pitched(`s${intervals}c${cutoff}`, notes[0], [42, 54, 66, 78], 0.9, (base) => (c, x) => stab(c, x, 0, notes.map((n) => n - notes[0] + base), 0.8, 1, cutoff), b, t, vel, len + 0.05);
  }

  vox(b: Buses, t: number, note: number, len: number, vowel: 'a' | 'e' | 'o' | 'u' | 'i', vel = 1, flip = 0): void {
    // The flip is a pitch bend relative to the note: keep it in the render.
    const L = Math.round(len * 10) / 10;
    this.pitched(`v${vowel}f${flip}l${L}`, note, [42, 54, 66, 78], L + 0.1, (base) => (c, x) => vox(c, x, 0, base, L, vowel, 1, flip), b, t, vel, L + 0.05);
  }

  /** Once per phrase: live. */
  sweep(b: Buses, t: number, len: number, up = true, vel = 1): void {
    if (!this.dry) sweep(this.ctx, b, t, len, up, vel);
  }

  glitch(b: Buses, t: number, len: number, vel = 1): void {
    const L = r2(len);
    const variant = Math.floor(Math.random() * 3);
    this.hit(`g${variant}l${L}`, L + 0.05, (c, x) => glitch(c, x, 0, L, 1), b, t, vel);
  }

  // ------------------------------------------------------------ machinery

  private hit(
    key: string,
    dur: number,
    render: Render,
    b: Buses,
    t: number,
    gain: number,
    cutAt?: number,
    rate = 1,
    glide?: { at: number; to: number; end: number },
  ): void {
    const entry = this.cache.get(key);
    if (!entry) {
      this.request(key, dur, render);
      return;
    }
    if (this.dry || this.live >= VoiceBank.MAX_LIVE) return;
    const { buf, verb, delay } = entry;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    if (glide) {
      src.playbackRate.setValueAtTime(rate, t + glide.at);
      src.playbackRate.exponentialRampToValueAtTime(glide.to, t + glide.end);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    if (cutAt !== undefined) {
      g.gain.setValueAtTime(gain, t + cutAt);
      g.gain.linearRampToValueAtTime(0, t + cutAt + 0.06);
    }
    src.connect(g);
    let split: ChannelSplitterNode | null = null;
    if (buf.numberOfChannels === 1) {
      g.connect(b.out);
    } else {
      split = ctx.createChannelSplitter(buf.numberOfChannels);
      g.connect(split);
      split.connect(b.out, 0);
      if (verb > 0) split.connect(b.verb, verb);
      if (delay > 0) split.connect(b.delay, delay);
    }
    this.live++;
    let ended = false;
    src.onended = () => {
      if (ended) return;
      ended = true;
      this.live = Math.max(0, this.live - 1);
      src.disconnect();
      g.disconnect();
      split?.disconnect();
    };
    const natural = buf.duration / Math.max(0.25, rate);
    const end = cutAt !== undefined ? Math.min(natural, cutAt + 0.08) : natural;
    src.start(t);
    src.stop(t + end);
  }

  private request(key: string, dur: number, render: Render): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push({ key, dur, render });
    this.pump();
  }

  private pump(): void {
    while (this.busy < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.busy++;
      this.renderJob(job)
        .then((entry) => {
          if (entry) this.cache.set(job.key, entry);
        })
        .catch(() => {
          /* leave uncached; it will simply stay silent */
        })
        .finally(() => {
          this.busy--;
          this.pump();
        });
    }
  }

  private async renderJob(job: Job): Promise<{ buf: AudioBuffer; verb: number; delay: number } | null> {
    // 32 kHz is plenty for these voices and saves a third of the memory.
    const sr = 32000;
    const len = Math.max(1, Math.ceil(job.dur * sr));
    const OAC = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!OAC) return null;
    const oc = new OAC(3, len, sr);
    const merger = oc.createChannelMerger(3);
    const dry = oc.createGain();
    const verb = oc.createGain();
    const delay = oc.createGain();
    dry.connect(merger, 0, 0);
    verb.connect(merger, 0, 1);
    delay.connect(merger, 0, 2);
    oc.destination.channelCountMode = 'explicit';
    oc.destination.channelInterpretation = 'discrete';
    merger.connect(oc.destination);
    job.render(oc as unknown as AudioContext, { out: dry, verb, delay });
    const full = await oc.startRendering();
    // Keep only the channels that actually carry sound: [dry, verb?, delay?].
    const peak = (ch: number): number => {
      const d = full.getChannelData(ch);
      let m = 0;
      for (let i = 0; i < d.length; i += 16) m = Math.max(m, Math.abs(d[i]));
      return m;
    };
    const keep = [0];
    const hasVerb = peak(1) > 1e-4;
    const hasDelay = peak(2) > 1e-4;
    if (hasVerb) keep.push(1);
    if (hasDelay) keep.push(2);
    const buf = this.ctx.createBuffer(keep.length, full.length, sr);
    keep.forEach((ch, i) => buf.copyToChannel(full.getChannelData(ch), i));
    return { buf, verb: hasVerb ? keep.indexOf(1) : 0, delay: hasDelay ? keep.indexOf(2) : 0 };
  }
}
