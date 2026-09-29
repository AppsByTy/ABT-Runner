import type { Profile, ShopSave } from '../core/Profile';
import { POWER_INFO, type PowerType } from '../world/Pickups';

/**
 * The shop: what can be bought with the coin bank (fictional currency only,
 * no real money anywhere) and the rules for buying, equipping and using it.
 *
 *  - OUTFITS recolour the runner's hoodie and accents (kicks, hair streak).
 *  - TRAILS change the sneaker light trails.
 *  - UPGRADES make a power-up last longer (5 levels, +15% each).
 *  - BOOSTS are one-run consumables, switched on from the menu before a run.
 *
 * Some cosmetics unlock at a player level, which ties the shop to progression.
 */
export type ShopTab = 'outfit' | 'trail' | 'upgrade' | 'boost';
export type BoostId = 'headstart' | 'firewall' | 'double' | 'backup';

interface Item {
  id: string;
  name: string;
  desc: string;
  price: number;
  /** Player level needed to buy it. */
  level: number;
}

export interface OutfitDef extends Item {
  /** null = the texture's own colour. */
  hoodie: string | null;
  accent: string | null;
}

export interface TrailDef extends Item {
  color: string;
  rainbow?: boolean;
}

export interface UpgradeDef {
  id: PowerType;
  desc: string;
}

export interface BoostDef extends Item {
  id: BoostId;
}

export const OUTFITS: readonly OutfitDef[] = [
  { id: 'classic', name: 'APPSBYTY CLASSIC', desc: 'Lime hoodie, pink kicks', price: 0, level: 1, hoodie: null, accent: null },
  { id: 'cyan', name: 'CYAN DEPLOY', desc: 'Cyan hoodie, gold kicks', price: 800, level: 1, hoodie: '#12d2ff', accent: '#ffcf2e' },
  { id: 'hotfix', name: 'HOTFIX PINK', desc: 'Pink hoodie, cyan kicks', price: 1200, level: 1, hoodie: '#ff3ccc', accent: '#27f0ff' },
  { id: 'overflow', name: 'STACK OVERFLOW', desc: 'Orange hoodie, white kicks', price: 1800, level: 3, hoodie: '#ff7417', accent: '#f2f6ff' },
  { id: 'violet', name: 'ULTRAVIOLET', desc: 'Violet hoodie, lime kicks', price: 2500, level: 5, hoodie: '#8657ff', accent: '#b4ff1e' },
  { id: 'clean', name: 'CLEAN BUILD', desc: 'White hoodie, blue kicks', price: 3500, level: 6, hoodie: '#e9eef5', accent: '#3d7bff' },
  { id: 'dark', name: 'DARK MODE', desc: 'Graphite hoodie, cyan kicks', price: 5000, level: 8, hoodie: '#3a414f', accent: '#00e5ff' },
  { id: 'root', name: 'ROOT ACCESS', desc: 'Gold hoodie, black kicks', price: 8000, level: 12, hoodie: '#ffc21a', accent: '#1d1d26' },
];

export const TRAILS: readonly TrailDef[] = [
  { id: 'pink', name: 'PINK NEON', desc: 'The original', price: 0, level: 1, color: '#ff2bd6' },
  { id: 'cyan', name: 'CYAN STREAM', desc: 'Cool data-stream blue', price: 400, level: 1, color: '#00e5ff' },
  { id: 'lime', name: 'LIME CIRCUIT', desc: 'AppsByTy green', price: 600, level: 1, color: '#b4ff1e' },
  { id: 'gold', name: 'SOLAR GOLD', desc: 'Leave a gold streak', price: 1000, level: 3, color: '#ffd23a' },
  { id: 'red', name: 'RED ALERT', desc: 'Warning-light red', price: 1200, level: 4, color: '#ff2a4a' },
  { id: 'violet', name: 'ULTRAVIOLET', desc: 'Deep violet glow', price: 1500, level: 5, color: '#9a6bff' },
  { id: 'rgb', name: 'RGB MODE', desc: 'Every colour at once', price: 4000, level: 8, color: '#ffffff', rainbow: true },
];

export const UPGRADES: readonly UpgradeDef[] = [
  { id: 'debug', desc: 'Invincible and auto-fixing for longer' },
  { id: 'boost', desc: 'Overclocked for longer' },
  { id: 'magnet', desc: 'Pulls bugs and coins for longer' },
  { id: 'ram', desc: 'Score ×2 for longer' },
  { id: 'firewall', desc: 'Shield stays up longer' },
];

/** Price of each upgrade level (index 0 buys level 1). */
export const UPGRADE_PRICES: readonly number[] = [300, 700, 1500, 3000, 6000];
export const MAX_UPGRADE = UPGRADE_PRICES.length;
/** Extra duration per upgrade level. */
export const UPGRADE_STEP = 0.15;

export const BOOSTS: readonly BoostDef[] = [
  { id: 'headstart', name: 'HEAD START', desc: 'Start with 8 s of CODE BOOST', price: 200, level: 1 },
  { id: 'firewall', name: 'FIREWALL START', desc: 'Start shielded from one hit', price: 150, level: 1 },
  { id: 'double', name: 'DOUBLE SCORE', desc: 'Score ×2 for the first 1,000 m', price: 250, level: 1 },
  { id: 'backup', name: 'SYSTEM BACKUP', desc: 'Restores you once at 0% health', price: 400, level: 1 },
];
export const MAX_BOOSTS = 99;

/** Everything the shop screen needs to draw one tile. */
export interface ItemState {
  kind: ShopTab;
  id: string;
  name: string;
  desc: string;
  /** Price of the next purchase (0 = nothing to buy). */
  price: number;
  owned: boolean;
  equipped: boolean;
  /** Level needed and not reached yet (0 = unlocked). */
  lockLevel: number;
  affordable: boolean;
  /** Upgrades: current level. Boosts: how many in stock. */
  count: number;
  max: number;
  /** Boosts: switched on for the next run. */
  armed: boolean;
  /** Swatch colours / icon colour. */
  colors: string[];
  rainbow: boolean;
}

export type BuyResult = { ok: true } | { ok: false; reason: 'locked' | 'coins' | 'owned' | 'max' | 'unknown' };

export class Shop {
  private readonly profile: Profile;

  constructor(profile: Profile) {
    this.profile = profile;
    this.validate();
  }

  private get s(): ShopSave {
    return this.profile.data.shop;
  }

  get bank(): number {
    return this.profile.data.bank;
  }

  outfit(id = this.s.outfit): OutfitDef {
    return OUTFITS.find((o) => o.id === id) ?? OUTFITS[0];
  }

  trail(id = this.s.trail): TrailDef {
    return TRAILS.find((t) => t.id === id) ?? TRAILS[0];
  }

  upgradeLevel(type: PowerType): number {
    return this.s.upgrades[type] ?? 0;
  }

  /** Duration multiplier for every power-up, from its upgrade level. */
  durationMults(): Partial<Record<PowerType, number>> {
    const out: Partial<Record<PowerType, number>> = {};
    for (const u of UPGRADES) out[u.id] = 1 + UPGRADE_STEP * this.upgradeLevel(u.id);
    return out;
  }

  boostCount(id: BoostId): number {
    return this.s.boosts[id] ?? 0;
  }

  isArmed(id: BoostId): boolean {
    return this.s.armed.includes(id) && this.boostCount(id) > 0;
  }

  /** Boosts in stock (for the menu's quick toggles). */
  stock(): { def: BoostDef; count: number; armed: boolean }[] {
    return BOOSTS.filter((b) => this.boostCount(b.id) > 0).map((def) => ({ def, count: this.boostCount(def.id), armed: this.isArmed(def.id) }));
  }

  items(tab: ShopTab): ItemState[] {
    const level = this.profile.level.level;
    const bank = this.bank;
    const base = (kind: ShopTab, it: Item) => ({ kind, id: it.id, name: it.name, desc: it.desc, lockLevel: level >= it.level ? 0 : it.level });
    switch (tab) {
      case 'outfit':
        return OUTFITS.map((o) => {
          const owned = this.owns(o.id, 'outfit');
          return { ...base('outfit', o), price: owned ? 0 : o.price, owned, equipped: this.s.outfit === o.id, affordable: bank >= o.price, count: 0, max: 0, armed: false, colors: [o.hoodie ?? '#b4ff1e', o.accent ?? '#ff2bd6'], rainbow: false };
        });
      case 'trail':
        return TRAILS.map((t) => {
          const owned = this.owns(t.id, 'trail');
          return { ...base('trail', t), price: owned ? 0 : t.price, owned, equipped: this.s.trail === t.id, affordable: bank >= t.price, count: 0, max: 0, armed: false, colors: [t.color], rainbow: !!t.rainbow };
        });
      case 'upgrade':
        return UPGRADES.map((u) => {
          const lv = this.upgradeLevel(u.id);
          const price = lv < MAX_UPGRADE ? UPGRADE_PRICES[lv] : 0;
          const info = POWER_INFO[u.id];
          const secs = info.duration * (1 + UPGRADE_STEP * lv);
          return { kind: 'upgrade' as const, id: u.id, name: info.name, desc: `${u.desc} · ${secs.toFixed(1).replace(/\.0$/, '')} s`, lockLevel: 0, price, owned: lv > 0, equipped: false, affordable: bank >= price, count: lv, max: MAX_UPGRADE, armed: false, colors: [info.color], rainbow: false };
        });
      case 'boost':
        return BOOSTS.map((b) => {
          const n = this.boostCount(b.id);
          return { ...base('boost', b), price: n < MAX_BOOSTS ? b.price : 0, owned: n > 0, equipped: false, affordable: bank >= b.price, count: n, max: MAX_BOOSTS, armed: this.isArmed(b.id), colors: [BOOST_COLOR[b.id]], rainbow: false };
        });
    }
  }

  buy(kind: ShopTab, id: string): BuyResult {
    const it = this.items(kind).find((x) => x.id === id);
    if (!it) return { ok: false, reason: 'unknown' };
    if (it.lockLevel) return { ok: false, reason: 'locked' };
    if ((kind === 'outfit' || kind === 'trail') && it.owned) return { ok: false, reason: 'owned' };
    if (it.price <= 0) return { ok: false, reason: 'max' };
    if (this.bank < it.price) return { ok: false, reason: 'coins' };
    const p = this.profile.data;
    p.bank -= it.price;
    p.stats.coinsSpent += it.price;
    const s = this.s;
    if (kind === 'outfit' || kind === 'trail') {
      s.owned.push(id);
      if (kind === 'outfit') s.outfit = id;
      else s.trail = id;
    } else if (kind === 'upgrade') {
      s.upgrades[id] = this.upgradeLevel(id as PowerType) + 1;
    } else {
      s.boosts[id] = this.boostCount(id as BoostId) + 1;
      // A boost you just bought is switched on for the next run.
      if (!s.armed.includes(id)) s.armed.push(id);
    }
    this.profile.save();
    return { ok: true };
  }

  equip(kind: 'outfit' | 'trail', id: string): boolean {
    if (!this.owns(id, kind)) return false;
    if (kind === 'outfit') this.s.outfit = id;
    else this.s.trail = id;
    this.profile.save();
    return true;
  }

  /** Switch a boost on/off for the next run. Returns the new state. */
  toggleArm(id: BoostId): boolean {
    const s = this.s;
    const on = s.armed.includes(id);
    if (on) s.armed = s.armed.filter((x) => x !== id);
    else if (this.boostCount(id) > 0) s.armed.push(id);
    this.profile.save();
    return this.isArmed(id);
  }

  /**
   * A run starts: use the armed start-of-run boosts (one of each). SYSTEM
   * BACKUP stays armed and is only used up if it actually saves you.
   */
  startRun(): BoostId[] {
    const used: BoostId[] = [];
    for (const id of ['headstart', 'firewall', 'double'] as const) {
      if (!this.isArmed(id)) continue;
      this.take(id);
      used.push(id);
    }
    if (used.length) this.profile.save();
    return used;
  }

  /** Health hit 0: use a SYSTEM BACKUP if one is armed. */
  useBackup(): boolean {
    if (!this.isArmed('backup')) return false;
    this.take('backup');
    this.profile.data.stats.backupsUsed++;
    this.profile.save();
    return true;
  }

  private take(id: BoostId): void {
    const s = this.s;
    const left = Math.max(0, this.boostCount(id) - 1);
    if (left) s.boosts[id] = left;
    else {
      delete s.boosts[id];
      s.armed = s.armed.filter((x) => x !== id);
    }
  }

  private owns(id: string, kind: 'outfit' | 'trail'): boolean {
    const list: readonly Item[] = kind === 'outfit' ? OUTFITS : TRAILS;
    return list[0].id === id || (this.s.owned.includes(id) && list.some((x) => x.id === id));
  }

  /** Drop anything the catalog doesn't know (old or tampered saves). */
  private validate(): void {
    const s = this.s;
    const known = new Set([...OUTFITS, ...TRAILS].map((x) => x.id));
    s.owned = s.owned.filter((id) => known.has(id));
    if (!this.owns(s.outfit, 'outfit')) s.outfit = OUTFITS[0].id;
    if (!this.owns(s.trail, 'trail')) s.trail = TRAILS[0].id;
    const ups: Record<string, number> = {};
    for (const u of UPGRADES) if (s.upgrades[u.id]) ups[u.id] = Math.min(MAX_UPGRADE, s.upgrades[u.id]);
    s.upgrades = ups;
    const bs: Record<string, number> = {};
    for (const b of BOOSTS) if (s.boosts[b.id]) bs[b.id] = Math.min(MAX_BOOSTS, s.boosts[b.id]);
    s.boosts = bs;
    s.armed = s.armed.filter((id) => (bs[id] ?? 0) > 0);
  }
}

export const BOOST_COLOR: Record<BoostId, string> = {
  headstart: POWER_INFO.boost.color,
  firewall: POWER_INFO.firewall.color,
  double: POWER_INFO.ram.color,
  backup: '#39ff6a',
};
