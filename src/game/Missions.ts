import { events } from '../core/EventBus';
import { MAX_MULT, type Profile } from '../core/Profile';

/**
 * Three missions at a time. Finish all three and the set pays out: the
 * permanent score multiplier goes up by one (from the next run), coins go to
 * the bank and a harder set replaces it. Each finished mission also gives XP
 * on the spot.
 *
 * "In one run" missions keep the best single-run attempt as their progress;
 * the others add up across runs. The first sets are fixed so they teach the
 * game; after that sets are generated (seeded by set number, so a set never
 * changes under the player).
 */
export type MissionKind =
  | 'dist'
  | 'bugs'
  | 'coins'
  | 'combo'
  | 'near'
  | 'power'
  | 'jump'
  | 'slide'
  | 'stage'
  | 'clean'
  | 'score'
  | 'boss'
  | 'tBugs'
  | 'tCoins'
  | 'tDist'
  | 'tRuns'
  | 'tPass'
  | 'tPower';

export interface MissionSave {
  kind: MissionKind;
  target: number;
  /** Per-run missions: best single run. Total missions: sum of finished runs. */
  progress: number;
  done: boolean;
}

/** What the current run has achieved so far. */
export interface RunCounters {
  distance: number;
  bugs: number;
  coins: number;
  /** Best DEBUG COMBO multiplier. */
  mult: number;
  near: number;
  power: number;
  jump: number;
  slide: number;
  /** Hazards got past any way (dodge, jump, slide, near miss). */
  pass: number;
  stage: number;
  /** Longest stretch without taking damage (m). */
  clean: number;
  score: number;
  boss: number;
  /** 1 once the run has ended (for "play N runs"). */
  runs: number;
}

export interface MissionView {
  kind: MissionKind;
  text: string;
  /** Progress shown to the player, capped at the target. */
  value: number;
  target: number;
  /** e.g. "180/250 m" */
  label: string;
  done: boolean;
  /** Completed during the run that just ended. */
  fresh: boolean;
  total: boolean;
}

export interface MissionResult {
  missions: MissionView[];
  setComplete: boolean;
  /** Coins banked for completing the set. */
  reward: number;
  multBefore: number;
  multAfter: number;
}

interface Template {
  key: keyof RunCounters;
  total: boolean;
  /** Target by set number (the last entry repeats). */
  targets: readonly number[];
  /** First set this mission can appear in. */
  from: number;
  text: (n: number) => string;
  unit?: string;
}

const fmt = (n: number): string => Math.floor(n).toLocaleString('en-US');
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const T: Record<MissionKind, Template> = {
  dist: { key: 'distance', total: false, from: 0, targets: [250, 400, 600, 800, 1000, 1200, 1500, 1800, 2100, 2500, 3000, 3500, 4000], text: (n) => `Run ${fmt(n)} m in one run`, unit: ' m' },
  bugs: { key: 'bugs', total: false, from: 0, targets: [3, 5, 6, 8, 10, 12, 14, 16, 18, 20, 25, 30], text: (n) => `Fix ${n} bugs in one run` },
  coins: { key: 'coins', total: false, from: 0, targets: [40, 60, 90, 120, 150, 180, 220, 260, 300, 350, 400, 500], text: (n) => `Collect ${n} coins in one run` },
  combo: { key: 'mult', total: false, from: 1, targets: [2, 2, 2, 3, 3, 3, 5, 5, 5, 10], text: (n) => `Reach DEBUG COMBO x${n}` },
  near: { key: 'near', total: false, from: 1, targets: [1, 2, 3, 3, 4, 5, 6, 7, 8, 10], text: (n) => `Get ${n} ${plural(n, 'near miss', 'near misses')} in one run` },
  power: { key: 'power', total: false, from: 1, targets: [1, 1, 2, 2, 2, 3, 3, 4, 4, 5], text: (n) => `Grab ${n} ${plural(n, 'power-up', 'power-ups')} in one run` },
  jump: { key: 'jump', total: false, from: 0, targets: [3, 5, 6, 8, 10, 12, 15, 18, 20, 25], text: (n) => `Jump over ${n} hazards in one run` },
  slide: { key: 'slide', total: false, from: 1, targets: [3, 5, 6, 8, 10, 12, 15, 18, 20, 25], text: (n) => `Slide under ${n} hazards in one run` },
  stage: { key: 'stage', total: false, from: 2, targets: [2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7], text: (n) => `Reach STAGE ${n}` },
  clean: { key: 'clean', total: false, from: 3, targets: [150, 200, 300, 400, 500, 600, 750, 900, 1100, 1300, 1500], text: (n) => `Run ${fmt(n)} m without a hit`, unit: ' m' },
  score: { key: 'score', total: false, from: 3, targets: [2000, 3000, 5000, 8000, 12000, 16000, 20000, 30000, 40000, 50000, 75000, 100000], text: (n) => `Score ${fmt(n)} in one run` },
  boss: { key: 'boss', total: false, from: 5, targets: [1], text: () => 'Delete THE VIRUS' },
  tBugs: { key: 'bugs', total: true, from: 2, targets: [10, 15, 20, 30, 40, 50, 60, 75, 100, 125, 150], text: (n) => `Fix ${n} bugs` },
  tCoins: { key: 'coins', total: true, from: 2, targets: [150, 250, 400, 500, 700, 900, 1200, 1500, 2000, 2500, 3000], text: (n) => `Collect ${fmt(n)} coins` },
  tDist: { key: 'distance', total: true, from: 2, targets: [1000, 1500, 2000, 3000, 4000, 5000, 6500, 8000, 10000, 12500, 15000], text: (n) => `Run ${fmt(n)} m in total`, unit: ' m' },
  tRuns: { key: 'runs', total: true, from: 3, targets: [3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 8], text: (n) => `Play ${n} runs` },
  tPass: { key: 'pass', total: true, from: 3, targets: [15, 25, 40, 50, 60, 80, 100, 125, 150, 200], text: (n) => `Get past ${n} hazards` },
  tPower: { key: 'power', total: true, from: 4, targets: [3, 4, 5, 6, 8, 10, 12, 15], text: (n) => `Grab ${n} power-ups` },
};

/** Fixed opening sets: they walk a new player through the game's verbs. */
const INTRO: MissionKind[][] = [
  ['bugs', 'dist', 'jump'],
  ['coins', 'combo', 'slide'],
  ['near', 'power', 'tDist'],
];

export const missionXp = (set: number): number => 50 + 10 * Math.min(set, 20);
export const setReward = (set: number): number => 100 + 50 * Math.min(set, 20);

const targetFor = (kind: MissionKind, set: number): number => {
  const t = T[kind].targets;
  return t[Math.min(set, t.length - 1)];
};

/** Small seeded RNG (mulberry32). */
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The three missions of set `set`. Same set number, same missions. */
export function generateSet(set: number): MissionSave[] {
  let kinds: MissionKind[];
  if (set < INTRO.length) {
    kinds = INTRO[set];
  } else {
    const r = rng(set * 7919 + 17);
    const pool = (Object.keys(T) as MissionKind[]).filter((k) => T[k].from <= set);
    kinds = [];
    // At most one running-total mission, and never two on the same stat.
    while (kinds.length < 3) {
      const k = pool[Math.floor(r() * pool.length)];
      if (kinds.includes(k)) continue;
      if (T[k].total && kinds.some((x) => T[x].total)) continue;
      if (kinds.some((x) => T[x].key === T[k].key)) continue;
      kinds.push(k);
    }
  }
  return kinds.map((kind) => ({ kind, target: targetFor(kind, set), progress: 0, done: false }));
}

const isValid = (list: unknown): list is MissionSave[] =>
  Array.isArray(list) &&
  list.length === 3 &&
  list.every((m) => m && typeof m === 'object' && (m as MissionSave).kind in T && Number.isFinite((m as MissionSave).target) && Number.isFinite((m as MissionSave).progress));

const zero = (): RunCounters => ({ distance: 0, bugs: 0, coins: 0, mult: 1, near: 0, power: 0, jump: 0, slide: 0, pass: 0, stage: 1, clean: 0, score: 0, boss: 0, runs: 0 });

export class Missions {
  /** The current run's achievements (read by tests and the pause screen). */
  readonly c: RunCounters = zero();
  private readonly fresh = new Set<number>();
  private cleanFrom = 0;
  private active = false;

  private readonly profile: Profile;

  constructor(profile: Profile) {
    this.profile = profile;
    const p = profile.data;
    if (!isValid(p.missions)) {
      p.missions = generateSet(p.set);
      profile.save();
    } else if (p.missions.every((m) => m.done)) {
      // The page closed after the last mission of a set but before the run
      // ended: pay the set out now.
      p.bank += setReward(p.set);
      p.mult = Math.min(MAX_MULT, p.mult + 1);
      p.set++;
      p.missions = generateSet(p.set);
      profile.save();
    }
    events.on('nearMiss', (e) => {
      if (!this.active) return;
      this.c.near++;
      this.c.pass++;
      if (e.how) this.c[e.how]++;
    });
    events.on('obstacleCleared', (e) => {
      if (!this.active) return;
      this.c.pass++;
      if (e.how !== 'dodge') this.c[e.how]++;
    });
    events.on('pickup', (e) => {
      if (this.active && e.kind === 'power') this.c.power++;
    });
    events.on('bossDeleted', () => {
      if (this.active) this.c.boss++;
    });
    events.on('hit', (e) => {
      if (this.active && !e.absorbed) this.cleanFrom = this.c.distance;
    });
  }

  get list(): MissionSave[] {
    return this.profile.data.missions;
  }

  beginRun(): void {
    Object.assign(this.c, zero());
    this.fresh.clear();
    this.cleanFrom = 0;
    this.active = true;
  }

  /** Run stats GameManager owns; called every frame of a run. */
  track(s: { distance: number; bugs: number; coins: number; mult: number; stage: number; score: number }): void {
    if (!this.active) return;
    const c = this.c;
    c.distance = s.distance;
    c.bugs = s.bugs;
    c.coins = s.coins;
    c.mult = Math.max(c.mult, s.mult);
    c.stage = Math.max(c.stage, s.stage);
    c.score = s.score;
    c.clean = Math.max(c.clean, s.distance - this.cleanFrom);
    this.check();
  }

  /** Current value of a mission including the run in progress. */
  private value(m: MissionSave): number {
    const t = T[m.kind];
    const run = this.active ? this.c[t.key] : 0;
    return t.total ? m.progress + run : Math.max(m.progress, run);
  }

  private check(): void {
    const list = this.list;
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.done || this.value(m) < m.target) continue;
      m.done = true;
      m.progress = m.target;
      this.fresh.add(i);
      this.profile.data.stats.missionsDone++;
      changed = true;
      events.emit('missionComplete', { index: i, text: T[m.kind].text(m.target), xp: missionXp(this.profile.data.set) });
      if (list.every((x) => x.done)) events.emit('missionSetComplete', { mult: Math.min(MAX_MULT, this.profile.data.mult + 1) });
    }
    // Save straight away so a finished mission survives even if the page dies mid-run.
    if (changed) this.profile.save();
  }

  /** The run is over: fold it into the saved progress and pay out a finished set. */
  commit(): MissionResult {
    const p = this.profile.data;
    const multBefore = p.mult;
    if (this.active) {
      this.c.runs = 1;
      this.check();
      for (const m of this.list) {
        if (m.done) continue;
        const t = T[m.kind];
        const run = Math.floor(this.c[t.key]);
        m.progress = t.total ? m.progress + run : Math.max(m.progress, run);
      }
      this.active = false;
    }
    const missions = this.views();
    const setComplete = this.list.every((m) => m.done);
    let reward = 0;
    if (setComplete) {
      reward = setReward(p.set);
      p.mult = Math.min(MAX_MULT, p.mult + 1);
      p.set++;
      p.missions = generateSet(p.set);
    }
    this.fresh.clear();
    return { missions, setComplete, reward, multBefore, multAfter: p.mult };
  }

  views(): MissionView[] {
    return this.list.map((m, i) => {
      const t = T[m.kind];
      const value = Math.min(m.target, this.value(m));
      const shown = m.kind === 'combo' ? `x${value}/x${m.target}` : `${fmt(value)}/${fmt(m.target)}${t.unit ?? ''}`;
      return { kind: m.kind, text: t.text(m.target), value, target: m.target, label: m.done ? 'DONE' : shown, done: m.done, fresh: this.fresh.has(i), total: t.total };
    });
  }
}
