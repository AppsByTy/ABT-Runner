import { CONFIG } from '../core/Config';
import { stageAt } from '../core/Theme';
import { Random } from '../utils/Random';
import { clamp, lerp } from '../utils/math';
import { KIND_CLASS, type ObstacleClass, type ObstacleKind, type ObstacleManager } from './Obstacles';
import { POWER_TYPES, type PickupKind, type PickupManager, type PowerType } from './Pickups';

const LANES = [0, 1, 2] as const;
const ALL = 0b111;
const bit = (l: number): number => 1 << l;
const has = (mask: number, l: number): boolean => (mask & bit(l)) !== 0;

interface RowPick {
  lane: number;
  kind: ObstacleKind;
  depth: number;
  variant: number;
  toLane: number;
}

interface RowRecord {
  dist: number;
  reachAfter: number;
}

export interface Hint {
  dist: number;
  text: string;
  shown: boolean;
}

export interface SpawnContext {
  /** Current system health 0..100 (patches become likelier when low). */
  health(): number;
}

/**
 * Generates hazards, collectibles and power-ups ahead of the player.
 *
 * Fairness model: `reach` is the set of lanes the player can possibly occupy
 * after the last row. Walls (corrupted code blocks) that extend into the gap
 * before the next row are lanes the player cannot cross. Each new row must
 * leave at least one passable lane reachable from `reach` without crossing a
 * wall, and no lane ever needs a jump and a slide at the same time, so every
 * generated sequence is survivable without taking a hit.
 */
export class Spawner {
  readonly rng = new Random();
  readonly hints: Hint[] = [];
  private nextRowDist = 0;
  private lastRowDist = 0;
  private reach = ALL;
  private readonly busyUntil = [0, 0, 0];
  private rowCount = 0;
  private nextPowerAt = 0;
  private history: RowRecord[] = [];
  private ahead: number = CONFIG.spawn.aheadDistance;
  private boss = false;
  private readonly obstacles: ObstacleManager;
  private readonly pickups: PickupManager;
  private readonly ctx: SpawnContext;

  constructor(obstacles: ObstacleManager, pickups: PickupManager, ctx: SpawnContext) {
    this.obstacles = obstacles;
    this.pickups = pickups;
    this.ctx = ctx;
  }

  reset(seed: number | undefined, tutorial: boolean): void {
    if (seed !== undefined) this.rng.reseed(seed);
    this.reach = ALL;
    this.busyUntil.fill(0);
    this.rowCount = 0;
    this.history = [];
    this.hints.length = 0;
    this.boss = false;
    this.ahead = CONFIG.spawn.aheadDistance;
    this.nextPowerAt = this.rng.range(220, 320);
    // Welcome trail down the middle stream.
    for (let d = 14; d < 44; d += CONFIG.coin.spacing) this.pickups.spawn('coin', 1, d);
    if (tutorial) {
      this.intro();
    } else {
      this.nextRowDist = CONFIG.spawn.startRunway;
      this.lastRowDist = 8;
      // Show the core mechanic within the first seconds of every run.
      this.pickups.spawn('goodBug', 0, 50);
    }
  }

  /** Scripted first seconds: one of each thing, with hints. */
  private intro(): void {
    const O = this.obstacles;
    const P = this.pickups;
    O.spawn('firewall', 1, 62);
    this.arc(1, 62, 15, 0);
    this.hints.push({ dist: 62, text: 'SWIPE UP ↑ TO JUMP THE FIREWALL', shown: false });

    P.spawn('goodBug', 1, 96);
    P.spawn('goodBug', 1, 100);
    this.hints.push({ dist: 98, text: 'GRAB GREEN BUGS TO FIX THEM', shown: false });

    O.spawn('errorWindow', 1, 132, { variant: 0 });
    for (let d = 118; d < 136; d += CONFIG.coin.spacing) P.spawn('coin', 1, d, 0.55);
    this.hints.push({ dist: 132, text: 'SWIPE DOWN ↓ TO SLIDE UNDER ERRORS', shown: false });

    O.spawn('corruptBlock', 1, 168, { depth: 11, variant: 0 });
    for (let d = 160; d < 182; d += CONFIG.coin.spacing) {
      P.spawn('coin', 0, d);
      P.spawn('coin', 2, d);
    }
    this.hints.push({ dist: 168, text: 'SWIPE ← → TO DODGE CORRUPTED CODE', shown: false });

    O.spawn('glitchBug', 1, 214);
    P.spawn('goodBug', 2, 214);
    this.hints.push({ dist: 212, text: 'RED BUGS DAMAGE SYSTEM HEALTH!', shown: false });

    this.busyUntil[1] = 168 + 11 + 1.5;
    this.lastRowDist = 214;
    this.nextRowDist = 250;
    this.reach = ALL;
  }

  static difficulty(distance: number): number {
    return clamp(distance / CONFIG.spawn.difficultyDistance, 0, 1);
  }

  get bossMode(): boolean {
    return this.boss;
  }

  /**
   * Boss encounter: normal generation stops (the boss director spawns the
   * attacks) and everything queued beyond the arena is cleared away.
   */
  setBoss(on: boolean, distance: number): void {
    if (on === this.boss) return;
    this.boss = on;
    if (!on) return;
    this.ahead = 62;
    const cut = distance + 45;
    // The boss swallows everything queued further ahead.
    this.obstacles.forEach((o) => {
      if (o.dist > cut) this.obstacles.destroy(o);
    });
    for (const p of this.pickups.active) if (p.dist > cut && !p.collected) this.pickups.collect(p);
    const kept = this.history.filter((r) => r.dist <= cut);
    const last = kept[kept.length - 1];
    this.history = kept;
    this.lastRowDist = last ? last.dist : distance;
    this.reach = last ? last.reachAfter : ALL;
    this.busyUntil.fill(0);
    this.obstacles.forEach((o) => {
      if (!o.destroyed && o.cls === 'wall') this.busyUntil[o.lane] = Math.max(this.busyUntil[o.lane], o.dist + o.depth + 1.5);
    });
    this.nextRowDist = Math.max(cut, this.lastRowDist + 12);
  }

  /** Boss beaten: pick normal generation up again just ahead of the runner. */
  resume(distance: number): void {
    this.boss = false;
    this.ahead = 40;
    this.reach = ALL;
    this.busyUntil.fill(0);
    this.history = [];
    this.lastRowDist = distance + 30;
    this.nextRowDist = distance + 42;
    // A power-up soon after the win.
    this.nextPowerAt = distance + 90;
  }

  update(distance: number, speed: number, speedFactor: number, dt: number): void {
    if (this.boss) return;
    // After a boss, ease the horizon back out instead of popping 100 m of content in.
    const target = CONFIG.spawn.aheadDistance;
    if (this.ahead < target) this.ahead = Math.min(target, this.ahead + dt * 45);
    else this.ahead = target;

    while (this.nextRowDist - distance < this.ahead) {
      const d = this.nextRowDist;
      const diff = Spawner.difficulty(d);
      const near = d - distance < 130;
      this.spawnRow(d, diff, speed, speedFactor, near);
      const interval = lerp(CONFIG.spawn.rowIntervalEasy, CONFIG.spawn.rowIntervalHard, diff);
      this.nextRowDist += speed * interval * this.rng.range(0.9, 1.15);
    }
  }

  // ------------------------------------------------------------------ rows

  private lanesInGap(): { walls: number; move: number; oneStep: number } {
    let walls = 0;
    for (const l of LANES) if (this.busyUntil[l] > this.lastRowDist + 1) walls |= bit(l);
    const move = this.connected(this.reach, walls);
    let oneStep = this.reach;
    for (const l of LANES) if (has(this.reach, l)) oneStep |= (bit(l - 1) | bit(l + 1)) & ALL;
    oneStep &= ~walls;
    return { walls, move, oneStep };
  }

  private spawnRow(d: number, diff: number, speed: number, speedFactor: number, near: boolean): void {
    this.rowCount++;
    const rng = this.rng;
    const { walls, move, oneStep } = this.lanesInGap();

    let occupied = 0;
    for (const l of LANES) if (this.busyUntil[l] > d - 1) occupied |= bit(l);

    const breather = this.rowCount > 2 && rng.chance(lerp(0.12, 0.05, diff));

    let chosen: RowPick[] = [];
    let newReach = 0;

    if (!breather) {
      for (let attempt = 0; attempt < 16; attempt++) {
        chosen = this.rollRow(d, diff, occupied, walls);
        let blocked = occupied;
        for (const c of chosen) if (KIND_CLASS[c.kind] === 'wall') blocked |= bit(c.lane);
        const passable = ALL & ~blocked;
        newReach = passable & move;
        if (diff < 0.55 && !(newReach & oneStep)) newReach = 0;
        if (newReach) break;
        chosen = [];
      }
    }
    if (!chosen.length) {
      newReach = move & ~occupied;
      if (!newReach) newReach = move;
    }

    for (const c of chosen) {
      this.obstacles.spawn(c.kind, c.lane, d, {
        depth: c.kind === 'corruptBlock' ? c.depth : undefined,
        variant: c.variant,
        toLane: c.toLane,
        materialize: near,
      });
      if (KIND_CLASS[c.kind] === 'wall') this.busyUntil[c.lane] = d + c.depth + 1.5;
    }

    this.placeCollectibles(d, chosen, newReach, walls, move, speed, speedFactor);
    this.reach = newReach;
    this.lastRowDist = d;
    this.history.push({ dist: d, reachAfter: newReach });
    if (this.history.length > 40) this.history.shift();
  }

  private rollRow(d: number, diff: number, occupied: number, walls: number): RowPick[] {
    const rng = this.rng;
    const stage = stageAt(d);
    const free = LANES.filter((l) => !has(occupied, l));
    const n = Math.min(
      free.length,
      rng.weighted<number>([
        [1, lerp(0.72, 0.28, diff)],
        [2, lerp(0.28, 0.56, diff)],
        [3, lerp(0.0, 0.16, diff)],
      ]),
    );
    const lanes = rng.shuffle([...free]).slice(0, n);
    const gapPrev = d - this.lastRowDist;
    const picks: RowPick[] = lanes.map((lane) => {
      const cls = rng.weighted<ObstacleClass>([
        ['low', 0.38],
        ['high', lerp(0.22, 0.3, diff)],
        ['wall', lerp(0.26, 0.38, diff)],
      ]);
      const bug = rng.chance(stage.bugShare);
      let kind: ObstacleKind;
      if (cls === 'wall') kind = 'corruptBlock';
      else if (cls === 'high') kind = bug && stage.id >= 2 ? 'virusDrone' : 'errorWindow';
      else if (bug) {
        // Charging bugs need room so they never catch up with the previous row.
        const canCharge = gapPrev >= 17;
        kind = stage.id >= 3 && rng.chance(0.35) ? 'malwareBug' : canCharge ? 'glitchBug' : 'firewall';
      } else kind = 'firewall';
      const depth = kind === 'corruptBlock' ? Math.round(rng.range(6, lerp(10, 18, diff))) : 0;
      return { lane, kind, depth, variant: rng.int(0, 3), toLane: -1 };
    });

    // Malware bugs telegraph a hop into an empty, un-walled lane of this row.
    for (const p of picks) {
      if (p.kind !== 'malwareBug') continue;
      const targets = [p.lane - 1, p.lane + 1].filter(
        (l) => l >= 0 && l <= 2 && !has(walls, l) && !has(occupied, l) && !picks.some((q) => q.lane === l),
      );
      if (targets.length) p.toLane = rng.pick(targets);
      else p.kind = 'firewall';
    }
    return picks;
  }

  /** Lanes reachable from `from` by sideways moves that never cross a wall. */
  private connected(from: number, walls: number): number {
    let out = 0;
    for (const l of LANES) {
      if (!has(from, l) || has(walls, l)) continue;
      out |= bit(l);
      for (let k = l - 1; k >= 0 && !has(walls, k); k--) out |= bit(k);
      for (let k = l + 1; k <= 2 && !has(walls, k); k++) out |= bit(k);
    }
    return out || from;
  }

  // ---------------------------------------------------------- collectibles

  /** Coin arc over a jump, matching the player's real trajectory at this speed. */
  private arc(lane: number, d: number, speed: number, speedFactor: number, apexChip = false): void {
    const g = CONFIG.player.gravity * (1 + CONFIG.player.gravitySpeedScale * speedFactor);
    const air = 2 * Math.sqrt((2 * CONFIG.player.jumpHeight) / g);
    const half = (speed * air) / 2;
    const center = d + 0.25;
    const steps = Math.max(5, Math.round((half * 2) / CONFIG.coin.spacing));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = 0.9 + 4 * CONFIG.player.jumpHeight * 0.92 * t * (1 - t);
      const kind: PickupKind = apexChip && i === Math.round(steps / 2) ? 'chip' : 'coin';
      this.pickups.spawn(kind, lane, center - half + t * half * 2, y);
    }
  }

  private placeCollectibles(
    d: number,
    row: RowPick[],
    reach: number,
    walls: number,
    move: number,
    speed: number,
    speedFactor: number,
  ): void {
    const rng = this.rng;
    const P = this.pickups;
    const stage = stageAt(d);
    const gap = d - this.lastRowDist;
    const start = this.lastRowDist + Math.min(6, gap * 0.25);
    const gapLanes = LANES.filter((l) => has(move, l) && !has(walls, l));
    const used = new Set<number>();

    // Coin trails (with code fragments mixed in).
    if (rng.chance(0.72)) {
      const candidates = LANES.filter((l) => has(reach, l) && !has(walls, l));
      const withAction = candidates.filter((l) => row.some((r) => r.lane === l && KIND_CLASS[r.kind] !== 'wall' && r.toLane < 0 && r.kind !== 'glitchBug'));
      const pool = withAction.length && rng.chance(0.55) ? withAction : candidates;
      if (pool.length) {
        const lane = rng.pick(pool);
        used.add(lane);
        const pick = row.find((r) => r.lane === lane);
        const cls = pick ? KIND_CLASS[pick.kind] : undefined;
        const sp = CONFIG.coin.spacing;
        let i = 0;
        const trail = (to: number, y = 0.9): void => {
          for (let x = start; x < to; x += sp) P.spawn(++i % 7 === 0 ? 'code' : 'coin', lane, x, y);
        };
        if (cls === 'low') {
          const g = CONFIG.player.gravity * (1 + CONFIG.player.gravitySpeedScale * speedFactor);
          const half = (speed * 2 * Math.sqrt((2 * CONFIG.player.jumpHeight) / g)) / 2;
          trail(d + 0.25 - half - 0.5);
          this.arc(lane, d, speed, speedFactor, rng.chance(0.3));
        } else if (cls === 'high') {
          trail(d + 4, 0.55);
        } else {
          trail(d + (pick ? 0 : rng.range(0, 6)) - 1);
        }
      }
    }

    const pickLane = (): number | null => {
      const free = gapLanes.filter((l) => !used.has(l));
      const pool = free.length ? free : gapLanes;
      if (!pool.length) return null;
      const l = rng.pick(pool);
      used.add(l);
      return l;
    };
    const mid = this.lastRowDist + gap * rng.range(0.4, 0.6);

    // Friendly bugs to fix: the signature mechanic.
    if (rng.chance(stage.goodBugChance)) {
      const l = pickLane();
      if (l !== null) {
        P.spawn('goodBug', l, mid + 4);
        if (rng.chance(0.3)) P.spawn('goodBug', l, mid + 7);
      }
    }
    if (rng.chance(0.07)) {
      const l = pickLane();
      if (l !== null) P.spawn('xp', l, mid, 1.0);
    }
    const hp = this.ctx.health();
    if (rng.chance(0.025 + (hp < 60 ? 0.07 : 0) + (hp < 35 ? 0.1 : 0))) {
      const l = pickLane();
      if (l !== null) P.spawn('patch', l, mid - 2, 1.0);
    }
    if (d >= this.nextPowerAt && gap > 10) {
      const l = pickLane();
      if (l !== null) {
        P.spawn('power', l, mid, 1.3, this.rollPower(d));
        this.nextPowerAt = d + rng.range(300, 520);
      }
    }
  }

  private rollPower(d: number): PowerType {
    const weights: [PowerType, number][] = POWER_TYPES.map((t) => [
      t,
      t === 'admin' ? (d > 900 ? 4 : 0) : t === 'debug' ? 18 : t === 'firewall' ? 22 : t === 'boost' ? 18 : t === 'magnet' ? 22 : 16,
    ]);
    return this.rng.weighted(weights);
  }
}
