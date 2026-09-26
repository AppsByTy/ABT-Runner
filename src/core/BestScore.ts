/**
 * Minimal persistence until the full SaveManager (Phase 4). Keys are
 * namespaced so migrating them later is trivial.
 */
const BEST_KEY = 'coderunner.best.v1';
const LIFE_KEY = 'coderunner.lifetime.v1';

export interface LifetimeStats {
  runs: number;
  xp: number;
  coins: number;
  bugsFixed: number;
}

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) – ignore */
  }
};

export const BestScore = {
  get(): number {
    return Number(read<{ v: number }>(BEST_KEY, { v: 0 }).v) || 0;
  },
  set(v: number): void {
    write(BEST_KEY, { v: Math.floor(v) });
  },
};

export const Lifetime = {
  get(): LifetimeStats {
    return read<LifetimeStats>(LIFE_KEY, { runs: 0, xp: 0, coins: 0, bugsFixed: 0 });
  },
  add(d: Partial<LifetimeStats>): void {
    const cur = Lifetime.get();
    write(LIFE_KEY, {
      runs: cur.runs + (d.runs ?? 0),
      xp: cur.xp + (d.xp ?? 0),
      coins: cur.coins + (d.coins ?? 0),
      bugsFixed: cur.bugsFixed + (d.bugsFixed ?? 0),
    });
  },
};
