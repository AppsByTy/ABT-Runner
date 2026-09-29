/**
 * The player's saved progress, in one versioned localStorage record:
 * best score, XP (-> level and rank), the coin bank, the mission set and the
 * permanent score multiplier it earns, and lifetime stats.
 *
 * The first load migrates the Phase 1-3 keys (best score, lifetime stats) so
 * nobody loses their high score or coins.
 */
import type { MissionSave } from '../game/Missions';

const KEY = 'coderunner.profile.v1';
const OLD_BEST = 'coderunner.best.v1';
const OLD_LIFE = 'coderunner.lifetime.v1';

/** The mission score multiplier never goes past this. */
export const MAX_MULT = 30;

export interface LifetimeStats {
  runs: number;
  bugsFixed: number;
  /** Coins collected on the track (the bank also gets rewards). */
  coins: number;
  distance: number;
  bestDistance: number;
  bossesDeleted: number;
  missionsDone: number;
  /** Seconds played. */
  time: number;
  coinsSpent: number;
  backupsUsed: number;
}

/** Shop state. Ids come from the catalog in game/Shop.ts (unknown ids are dropped there). */
export interface ShopSave {
  /** Outfits and trails bought (the free defaults are always owned). */
  owned: string[];
  outfit: string;
  trail: string;
  /** Power-up upgrade level (0-5) by power type. */
  upgrades: Record<string, number>;
  /** Boosts in stock by id. */
  boosts: Record<string, number>;
  /** Boosts switched on for the next run. */
  armed: string[];
}

export interface ProfileData {
  v: 1;
  best: number;
  totalXp: number;
  bank: number;
  /** Permanent score multiplier from completed mission sets. */
  mult: number;
  /** Mission sets completed so far (also the difficulty tier of the current set). */
  set: number;
  missions: MissionSave[];
  stats: LifetimeStats;
  shop: ShopSave;
}

export interface LevelInfo {
  level: number;
  rank: string;
  /** XP into the current level. */
  into: number;
  /** XP the current level needs in total. */
  need: number;
  /** 0..1 progress through the current level. */
  frac: number;
}

const RANKS: [number, string][] = [
  [40, 'LEGEND'],
  [30, 'CTO'],
  [20, 'ARCHITECT'],
  [15, 'LEAD ENGINEER'],
  [10, 'SENIOR DEV'],
  [6, 'DEVELOPER'],
  [3, 'JUNIOR DEV'],
  [1, 'INTERN'],
];

/** XP needed to go from `level` to `level + 1`. */
export const xpToNext = (level: number): number => 150 + 75 * (level - 1);

export const rankFor = (level: number): string => RANKS.find(([l]) => level >= l)![1];

/** Coins banked for reaching `level`. */
export const levelReward = (level: number): number => 50 + 25 * (level - 2);

export function levelInfo(totalXp: number): LevelInfo {
  let level = 1;
  let rest = Math.max(0, Math.floor(totalXp));
  while (rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  const need = xpToNext(level);
  return { level, rank: rankFor(level), into: rest, need, frac: rest / need };
}

const freshStats = (): LifetimeStats => ({ runs: 0, bugsFixed: 0, coins: 0, distance: 0, bestDistance: 0, bossesDeleted: 0, missionsDone: 0, time: 0, coinsSpent: 0, backupsUsed: 0 });

export const freshShop = (): ShopSave => ({ owned: [], outfit: 'classic', trail: 'pink', upgrades: {}, boosts: {}, armed: [] });

const fresh = (): ProfileData => ({ v: 1, best: 0, totalXp: 0, bank: 0, mult: 1, set: 0, missions: [], stats: freshStats(), shop: freshShop() });

const num = (v: unknown, min = 0): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : min);

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export class Profile {
  data: ProfileData;
  /** True when this load came from the old best/lifetime keys. */
  readonly migrated: boolean;

  constructor() {
    const saved = readJson(KEY);
    if (saved) {
      this.data = Profile.sanitize(saved);
      this.migrated = false;
    } else {
      this.data = Profile.migrate();
      this.migrated = true;
      this.save();
    }
  }

  get level(): LevelInfo {
    return levelInfo(this.data.totalXp);
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage full / private mode: progress lives for this session only */
    }
  }

  /** Wipe all progress (tests / a future settings button). */
  reset(): void {
    this.data = fresh();
    this.save();
  }

  /** Build a profile from the Phase 1-3 keys, if there are any. */
  private static migrate(): ProfileData {
    const p = fresh();
    const best = readJson(OLD_BEST);
    const life = readJson(OLD_LIFE);
    p.best = Math.floor(num(best?.v));
    if (life) {
      p.totalXp = Math.floor(num(life.xp));
      p.bank = Math.floor(num(life.coins));
      p.stats.runs = Math.floor(num(life.runs));
      p.stats.coins = p.bank;
      p.stats.bugsFixed = Math.floor(num(life.bugsFixed));
    }
    return p;
  }

  /** Never trust storage: every field is checked, anything odd falls back. */
  private static sanitize(s: Record<string, unknown>): ProfileData {
    const p = fresh();
    p.best = Math.floor(num(s.best));
    p.totalXp = Math.floor(num(s.totalXp));
    p.bank = Math.floor(num(s.bank));
    p.mult = Math.min(MAX_MULT, Math.floor(num(s.mult, 1)));
    p.set = Math.floor(num(s.set));
    p.missions = Array.isArray(s.missions) ? (s.missions as MissionSave[]) : [];
    const st = (s.stats && typeof s.stats === 'object' ? s.stats : {}) as Record<string, unknown>;
    for (const k of Object.keys(p.stats) as (keyof LifetimeStats)[]) p.stats[k] = num(st[k]);
    const sh = (s.shop && typeof s.shop === 'object' ? s.shop : {}) as Record<string, unknown>;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : []);
    const counts = (v: unknown, max: number): Record<string, number> => {
      const out: Record<string, number> = {};
      if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) out[k] = Math.min(max, Math.floor(num(n)));
      return out;
    };
    p.shop.owned = strings(sh.owned);
    if (typeof sh.outfit === 'string') p.shop.outfit = sh.outfit;
    if (typeof sh.trail === 'string') p.shop.trail = sh.trail;
    p.shop.upgrades = counts(sh.upgrades, 5);
    p.shop.boosts = counts(sh.boosts, 99);
    p.shop.armed = strings(sh.armed);
    return p;
  }
}
