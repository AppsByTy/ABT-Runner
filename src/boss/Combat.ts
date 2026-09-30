import type { InputAction } from '../input/InputManager';

/**
 * Touch attack sequences. A sequence is a short string of gestures:
 *   T tap · L swipe left · R swipe right · U swipe up · D swipe down
 * It runs in real time (slow motion doesn't stretch it), must be entered in
 * order before its window closes, and is PERFECT when finished quickly with
 * no hesitation.
 */
export type Glyph = 'T' | 'L' | 'R' | 'U' | 'D';

export const GLYPH_OF: Partial<Record<InputAction, Glyph>> = { confirm: 'T', left: 'L', right: 'R', jump: 'U', slide: 'D' };
export const ACTION_OF: Record<Glyph, InputAction> = { T: 'confirm', L: 'left', R: 'right', U: 'jump', D: 'slide' };

/** Why the window opened - sets the reward and the presentation. */
export type SeqKind = 'opening' | 'weak' | 'counter' | 'special';

export const SEQ_LABEL: Record<SeqKind, string> = {
  opening: 'OPENING · STRIKE',
  weak: 'WEAK POINT EXPOSED',
  counter: 'COUNTER!',
  special: 'SPECIAL ATTACK',
};

/** Damage multiplier by kind (before combo and PERFECT). */
export const SEQ_MULT: Record<SeqKind, number> = { opening: 1, weak: 1.7, counter: 2.3, special: 3.2 };

/** Inputs ignored for this long after a window opens (a dodge swipe still in flight). */
export const SEQ_GRACE = 0.3;
/** Same gesture arriving again within this window is a double-fire, not a mistake. */
const DOUBLE_FIRE = 0.09;

export type SeqResult = 'ok' | 'done' | 'fail' | 'ignored';

export class Sequence {
  readonly steps: Glyph[];
  readonly kind: SeqKind;
  /** Seconds to complete (after the grace). */
  readonly window: number;
  /** Finished within this many seconds = PERFECT. */
  readonly perfectT: number;
  /** Which weak point (1-based) of how many in this opening. */
  readonly part: number;
  readonly parts: number;
  i = 0;
  /** Real seconds since opening (includes grace). */
  t = 0;
  state: 'live' | 'done' | 'fail' = 'live';
  failReason: 'wrong' | 'slow' | 'hit' | '' = '';
  /** Paused while the boss attacks mid-combo: inputs go back to dodging. */
  hold = false;
  /** After this many correct inputs the boss interrupts (-1 = never). */
  interruptAt = -1;
  private lastOk = -1;

  constructor(steps: string, kind: SeqKind, perStep: number, part = 1, parts = 1) {
    this.steps = [...steps] as Glyph[];
    this.kind = kind;
    this.part = part;
    this.parts = parts;
    this.window = 0.55 + this.steps.length * perStep;
    this.perfectT = this.window * 0.55;
  }

  /** Seconds of the window used so far (0 during the grace). */
  get used(): number {
    return Math.max(0, this.t - SEQ_GRACE);
  }

  get perfect(): boolean {
    return this.state === 'done' && this.used <= this.perfectT;
  }

  /** 0..1 of the window remaining. */
  get left(): number {
    return Math.max(0, 1 - this.used / this.window);
  }

  input(g: Glyph): SeqResult {
    if (this.state !== 'live' || this.hold) return 'ignored';
    if (this.t < SEQ_GRACE) return 'ignored';
    if (g === this.steps[this.i]) {
      this.i++;
      this.lastOk = this.t;
      if (this.i >= this.steps.length) {
        this.state = 'done';
        return 'done';
      }
      return 'ok';
    }
    if (this.i > 0 && g === this.steps[this.i - 1] && this.t - this.lastOk < DOUBLE_FIRE) return 'ignored';
    this.state = 'fail';
    this.failReason = 'wrong';
    return 'fail';
  }

  /** Advance real time; true when it just ran out. */
  tick(dt: number): boolean {
    if (this.state !== 'live' || this.hold) return false;
    this.t += dt;
    if (this.used >= this.window) {
      this.state = 'fail';
      this.failReason = 'slow';
      return true;
    }
    return false;
  }
}

/** Combo damage multiplier: x1 .. x5 and beyond. */
export const comboMult = (combo: number): number => 1 + Math.min(5, Math.max(0, combo - 1)) * 0.14;

/** The move the runner performs for each input. */
export const TRICK_OF: Record<Glyph, 'punch' | 'kick' | 'spinL' | 'spinR' | 'flip' | 'sweep'> = { T: 'punch', L: 'spinL', R: 'spinR', U: 'flip', D: 'sweep' };
