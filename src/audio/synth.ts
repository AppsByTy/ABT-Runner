/**
 * Procedural instrument voices for the soundtrack and SFX. Everything is
 * built from oscillators, filtered noise, wave-shaping and a generated
 * convolution reverb, so there are no samples and nothing to license.
 */

export const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

export interface Buses {
  /** Dry destination for this voice (drum bus, music bus, sfx bus). */
  out: AudioNode;
  /** Reverb send input. */
  verb: AudioNode;
  /** Tempo delay send input. */
  delay: AudioNode;
}

let noiseCache: AudioBuffer | null = null;
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (noiseCache && noiseCache.sampleRate === ctx.sampleRate) return noiseCache;
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noiseCache = b;
  return b;
}

/** Stereo impulse response: exponentially decaying filtered noise. */
export function makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (Math.random() * 2 - 1 - lp) * (0.35 - t * 0.25); // darker tail
      d[i] = lp * Math.pow(1 - t, decay) * (i < 40 ? i / 40 : 1);
    }
  }
  return b;
}

/** Soft-clip curve for saturation (tanh). */
export function satCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return c;
}

function env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

// ------------------------------------------------------------------ drums

export function kick(ctx: AudioContext, out: AudioNode, t: number, vel = 1, punch = 1): void {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(190 * punch, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
  const g = ctx.createGain();
  env(g, t, 0.95 * vel, 0.002, 0.34);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.4);
  // Beater click.
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 2500;
  const ng = ctx.createGain();
  env(ng, t, 0.35 * vel, 0.001, 0.018);
  n.connect(f).connect(ng).connect(out);
  n.start(t, Math.random());
  n.stop(t + 0.03);
}

export function clap(ctx: AudioContext, b: Buses, t: number, vel = 1, wet = 0.35): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1400;
  bp.Q.value = 0.9;
  const g = ctx.createGain();
  // Three quick flams then a tail: the classic clap shape.
  g.gain.setValueAtTime(0.0001, t);
  for (let i = 0; i < 3; i++) {
    const s = t + i * 0.011;
    g.gain.setValueAtTime(0.75 * vel, s);
    g.gain.exponentialRampToValueAtTime(0.08 * vel, s + 0.009);
  }
  g.gain.setValueAtTime(0.6 * vel, t + 0.033);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  src.connect(bp).connect(g);
  g.connect(b.out);
  const s = ctx.createGain();
  s.gain.value = wet;
  g.connect(s).connect(b.verb);
  src.start(t, Math.random());
  src.stop(t + 0.25);
  // Snare body.
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(230, t);
  o.frequency.exponentialRampToValueAtTime(170, t + 0.08);
  const og = ctx.createGain();
  env(og, t, 0.28 * vel, 0.001, 0.09);
  o.connect(og).connect(b.out);
  o.start(t);
  o.stop(t + 0.12);
}

export function hat(ctx: AudioContext, out: AudioNode, t: number, vel = 1, open = false, tone = 1): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7200 * tone;
  const pk = ctx.createBiquadFilter();
  pk.type = 'peaking';
  pk.frequency.value = 10500;
  pk.gain.value = 6;
  const g = ctx.createGain();
  env(g, t, (open ? 0.22 : 0.26) * vel, 0.001, open ? 0.26 : 0.035 + vel * 0.02);
  src.connect(hp).connect(pk).connect(g).connect(out);
  src.start(t, Math.random());
  src.stop(t + (open ? 0.32 : 0.08));
}

export function rim(ctx: AudioContext, b: Buses, t: number, vel = 1): void {
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.value = 1750;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 6;
  const g = ctx.createGain();
  env(g, t, 0.18 * vel, 0.001, 0.035);
  o.connect(bp).connect(g);
  g.connect(b.out);
  g.connect(b.delay);
  o.start(t);
  o.stop(t + 0.06);
}

/**
 * 808 bass: sine + subtle 2nd harmonic, pitch-drop attack, optional glide
 * to the next note, saturated for presence on phone speakers.
 */
export function bass808(ctx: AudioContext, out: AudioNode, t: number, note: number, len: number, vel = 1, glideTo?: number, drive = 3): void {
  const f = midi(note);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f * 1.9, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.035);
  if (glideTo !== undefined) {
    o.frequency.setValueAtTime(f, t + len * 0.55);
    o.frequency.exponentialRampToValueAtTime(midi(glideTo), t + len * 0.9);
  }
  const h = ctx.createOscillator();
  h.type = 'triangle';
  h.frequency.setValueAtTime(f * 2, t);
  if (glideTo !== undefined) {
    h.frequency.setValueAtTime(f * 2, t + len * 0.55);
    h.frequency.exponentialRampToValueAtTime(midi(glideTo) * 2, t + len * 0.9);
  }
  const hg = ctx.createGain();
  hg.gain.value = 0.12;
  const sh = ctx.createWaveShaper();
  sh.curve = satCurve(drive);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.62 * vel, t + 0.006);
  g.gain.setTargetAtTime(0.42 * vel, t + 0.05, 0.25);
  g.gain.setTargetAtTime(0.0001, t + len, 0.05);
  o.connect(sh);
  h.connect(hg).connect(sh);
  sh.connect(lp).connect(g).connect(out);
  o.start(t);
  h.start(t);
  o.stop(t + len + 0.3);
  h.stop(t + len + 0.3);
}

// ---------------------------------------------------------------- melodic

/** Warm detuned-saw chord pad with slow filter swell. */
export function pad(ctx: AudioContext, b: Buses, t: number, notes: number[], len: number, vel = 1, bright = 1): void {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.7;
  lp.frequency.setValueAtTime(500 * bright, t);
  lp.frequency.linearRampToValueAtTime(1600 * bright, t + len * 0.5);
  lp.frequency.linearRampToValueAtTime(700 * bright, t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.05 * vel, t + Math.min(0.6, len * 0.3));
  g.gain.setValueAtTime(0.05 * vel, t + len * 0.8);
  g.gain.linearRampToValueAtTime(0.0001, t + len + 0.4);
  for (const n of notes) {
    for (const det of [-9, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(n);
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + len + 0.5);
    }
  }
  lp.connect(g);
  g.connect(b.out);
  const s = ctx.createGain();
  s.gain.value = 0.9;
  g.connect(s).connect(b.verb);
}

/** FM bell / pluck lead (the "digital" melodic hook). */
export function bell(ctx: AudioContext, b: Buses, t: number, note: number, len: number, vel = 1, ratio = 3.5, send = 0.4): void {
  const f = midi(note);
  const car = ctx.createOscillator();
  car.type = 'sine';
  car.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = Math.min(f * ratio, 15000);
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(f * 2.2, t);
  mg.gain.exponentialRampToValueAtTime(f * 0.1, t + len);
  mod.connect(mg).connect(car.frequency);
  const g = ctx.createGain();
  env(g, t, 0.13 * vel, 0.004, len);
  car.connect(g);
  g.connect(b.out);
  const s = ctx.createGain();
  s.gain.value = send;
  g.connect(s);
  s.connect(b.delay);
  s.connect(b.verb);
  car.start(t);
  mod.start(t);
  car.stop(t + len + 0.1);
  mod.stop(t + len + 0.1);
}

/** Supersaw-ish lead stab for high-energy sections. */
export function stab(ctx: AudioContext, b: Buses, t: number, notes: number[], len: number, vel = 1, cutoff = 3200): void {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(cutoff, t);
  lp.frequency.exponentialRampToValueAtTime(cutoff * 0.25, t + len);
  const g = ctx.createGain();
  env(g, t, 0.045 * vel, 0.005, len);
  for (const n of notes) {
    for (const det of [-14, 0, 13]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(n);
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + len + 0.05);
    }
  }
  lp.connect(g);
  g.connect(b.out);
  g.connect(b.delay);
}

const VOWELS: Record<string, [number, number, number]> = {
  a: [800, 1150, 2900],
  e: [400, 2000, 2600],
  o: [450, 800, 2830],
  u: [325, 700, 2530],
  i: [300, 2300, 3000],
};

/**
 * Formant "vocal chop": a pitched buzz shaped by vowel formants, with a
 * pitch flip - reads as a chopped vocal sample without using one.
 */
export function vox(ctx: AudioContext, b: Buses, t: number, note: number, len: number, vowel: keyof typeof VOWELS, vel = 1, flip = 0): void {
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(midi(note), t);
  if (flip) o.frequency.exponentialRampToValueAtTime(midi(note + flip), t + len * 0.8);
  const vib = ctx.createOscillator();
  vib.frequency.value = 5.5;
  const vg = ctx.createGain();
  vg.gain.value = midi(note) * 0.012;
  vib.connect(vg).connect(o.frequency);
  const g = ctx.createGain();
  env(g, t, 0.5 * vel, 0.012, len);
  const sum = ctx.createGain();
  VOWELS[vowel].forEach((fr, i) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = fr;
    bp.Q.value = 9 + i * 3;
    const fg = ctx.createGain();
    fg.gain.value = [1, 0.55, 0.25][i];
    o.connect(bp).connect(fg).connect(sum);
  });
  sum.connect(g);
  g.connect(b.out);
  const s = ctx.createGain();
  s.gain.value = 0.5;
  g.connect(s);
  s.connect(b.verb);
  s.connect(b.delay);
  o.start(t);
  vib.start(t);
  o.stop(t + len + 0.05);
  vib.stop(t + len + 0.05);
}

// ------------------------------------------------------------------- fx

/** Noise riser / downlifter sweep. */
export function sweep(ctx: AudioContext, b: Buses, t: number, len: number, up = true, vel = 1): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(up ? 300 : 7000, t);
  bp.frequency.exponentialRampToValueAtTime(up ? 9000 : 200, t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.18 * vel, t + (up ? len * 0.95 : 0.05));
  g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.05);
  src.connect(bp).connect(g);
  g.connect(b.out);
  g.connect(b.verb);
  src.start(t, Math.random());
  src.stop(t + len + 0.1);
}

/** Digital glitch stutter: a burst of tiny random pitched blips. */
export function glitch(ctx: AudioContext, b: Buses, t: number, len: number, vel = 1): void {
  const n = Math.floor(len / 0.028);
  for (let i = 0; i < n; i++) {
    const at = t + i * 0.028;
    const o = ctx.createOscillator();
    o.type = Math.random() < 0.5 ? 'square' : 'sawtooth';
    o.frequency.value = 200 + Math.random() * 2400;
    const g = ctx.createGain();
    env(g, at, 0.05 * vel, 0.001, 0.02);
    o.connect(g).connect(b.out);
    o.start(at);
    o.stop(at + 0.03);
  }
}
