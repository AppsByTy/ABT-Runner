import { events } from '../core/EventBus';
import { POWER_INFO, POWER_TYPES, type PickupKind, type PowerType } from '../world/Pickups';

const ALL_MAGNET: ReadonlySet<PickupKind> = new Set(['coin', 'code', 'chip', 'xp', 'goodBug', 'patch', 'bossPatch']);
const BUG_ONLY: ReadonlySet<PickupKind> = new Set(['goodBug']);
const NONE: ReadonlySet<PickupKind> = new Set();

/**
 * Developer power-ups. Several can run at once; picking up an active one
 * refreshes its timer. FIREWALL lasts until it absorbs a hit (or times out).
 */
export class PowerUps {
  private readonly timers = new Map<PowerType, number>();
  /** Full length of each running power-up (for the HUD bars). */
  private readonly full = new Map<PowerType, number>();
  /** Shop upgrades: duration multiplier per power-up. */
  private mults: Partial<Record<PowerType, number>> = {};

  setDurationMults(m: Partial<Record<PowerType, number>>): void {
    this.mults = { ...m };
  }

  /** Seconds a pickup of this power-up lasts (upgrades included). */
  duration(type: PowerType): number {
    return POWER_INFO[type].duration * (this.mults[type] ?? 1);
  }

  /** @param seconds override (start-of-run boosts) */
  activate(type: PowerType, seconds?: number): void {
    const fresh = !this.timers.has(type);
    // A refresh never shortens what is left (e.g. a start-of-run shield).
    const d = Math.max(seconds ?? this.duration(type), this.timers.get(type) ?? 0);
    this.timers.set(type, d);
    this.full.set(type, Math.max(d, fresh ? 0 : (this.full.get(type) ?? 0)));
    events.emit('powerStart', { type, fresh });
  }

  has(type: PowerType): boolean {
    return this.timers.has(type);
  }

  /** 0..1 time remaining. */
  frac(type: PowerType): number {
    const t = this.timers.get(type);
    return t === undefined ? 0 : t / (this.full.get(type) ?? POWER_INFO[type].duration);
  }

  /** Firewall absorbs a hit. Returns true if it did. */
  absorbHit(): boolean {
    if (!this.timers.has('firewall')) return false;
    this.timers.delete('firewall');
    events.emit('powerEnd', { type: 'firewall', reason: 'absorbed' });
    return true;
  }

  get invincible(): boolean {
    return this.has('debug') || this.has('boost') || this.has('admin');
  }

  get scoreMult(): number {
    return (this.has('ram') ? 2 : 1) * (this.has('admin') ? 3 : 1);
  }

  get speedMult(): number {
    return this.has('boost') ? 1.45 : 1;
  }

  get magnetRadius(): number {
    if (this.has('magnet') || this.has('admin')) return 30;
    if (this.has('debug')) return 18;
    return 0;
  }

  get magnetKinds(): ReadonlySet<PickupKind> {
    if (this.has('magnet') || this.has('admin')) return ALL_MAGNET;
    if (this.has('debug')) return BUG_ONLY;
    return NONE;
  }

  /** Visual mode for the character / screen, most dramatic first. */
  get mode(): PowerType | null {
    for (const t of ['admin', 'debug', 'boost', 'ram', 'magnet', 'firewall'] as const) if (this.has(t)) return t;
    return null;
  }

  active(): { type: PowerType; frac: number }[] {
    return POWER_TYPES.filter((t) => this.has(t)).map((type) => ({ type, frac: this.frac(type) }));
  }

  update(dt: number): void {
    for (const [type, t] of this.timers) {
      const left = t - dt;
      if (left <= 0) {
        this.timers.delete(type);
        this.full.delete(type);
        events.emit('powerEnd', { type, reason: 'expired' });
      } else this.timers.set(type, left);
    }
  }

  reset(): void {
    this.timers.clear();
    this.full.clear();
  }
}
