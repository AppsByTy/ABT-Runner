import { CONFIG } from '../core/Config';
import { events } from '../core/EventBus';

const C = CONFIG.combo;

/**
 * DEBUG COMBO: chains bug fixes, clean passes, dodges and near misses. The
 * count sets the multiplier tier (x1 x2 x3 x5 x10). The chain drops if
 * nothing scores inside the window, or instantly when taking a hit.
 */
export class ComboSystem {
  combo = 0;
  best = 0;
  bestMultiplier = 1;
  timer = 0;
  /** Consecutive bug fixes inside the current chain ("BUG FIXED +3"). */
  bugStreak = 0;

  get multiplier(): number {
    let m = 1;
    for (const [at, mult] of C.tiers) if (this.combo >= at) m = mult;
    return m;
  }

  /** Progress 0..1 toward the next multiplier tier. */
  get tierProgress(): number {
    const tiers = C.tiers;
    for (let i = 0; i < tiers.length - 1; i++) {
      const [a] = tiers[i];
      const [b] = tiers[i + 1];
      if (this.combo < b) return (this.combo - a) / (b - a);
    }
    return 1;
  }

  /** 0..1 remaining time before the chain drops. */
  get timerFrac(): number {
    return this.combo > 0 ? Math.max(0, this.timer / C.window) : 0;
  }

  add(points: number, label: string): void {
    const before = this.multiplier;
    this.combo += points;
    this.best = Math.max(this.best, this.combo);
    this.timer = C.window;
    const after = this.multiplier;
    this.bestMultiplier = Math.max(this.bestMultiplier, after);
    events.emit('combo', { combo: this.combo, multiplier: after, points, label, levelUp: after > before });
  }

  fixBug(): number {
    this.bugStreak++;
    this.add(C.points.bugFix, 'BUG FIXED');
    return this.bugStreak;
  }

  keepAlive(seconds: number): void {
    if (this.combo > 0) this.timer = Math.min(C.window, this.timer + seconds);
  }

  break(reason: 'timeout' | 'hit' | 'death'): void {
    if (this.combo > 0) events.emit('comboEnd', { combo: this.combo, reason });
    this.combo = 0;
    this.timer = 0;
    this.bugStreak = 0;
  }

  update(dt: number): void {
    if (this.combo <= 0) return;
    this.timer -= dt;
    if (this.timer <= 0) this.break('timeout');
  }

  reset(): void {
    this.combo = this.best = this.timer = this.bugStreak = 0;
    this.bestMultiplier = 1;
  }
}
