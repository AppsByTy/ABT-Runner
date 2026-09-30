import type { GameState } from './GameState';
import type { ObstacleKind } from '../world/Obstacles';
import type { PickupKind, PowerType } from '../world/Pickups';

interface At {
  x: number;
  y: number;
  z: number;
}

/** How a boss got hurt: touch attacks (strike/crit/counter/special) or legacy patch/dodge. */
export type BossHitKind = 'patch' | 'dodge' | 'strike' | 'crit' | 'counter' | 'special';

/**
 * Every gameplay event other systems may care about. FX, audio and the HUD
 * subscribe here instead of being wired directly into gameplay code.
 */
export interface GameEvents {
  stateChange: { from: GameState; to: GameState };
  runStart: undefined;
  laneChange: { dir: -1 | 1; lane: number };
  jump: undefined;
  land: undefined;
  slideStart: undefined;
  slideEnd: undefined;
  footstep: { side: 0 | 1 };

  pickup: At & { kind: PickupKind; power?: PowerType };
  /** A friendly bug was fixed (by touch, magnet or debug mode). */
  bugFixed: At & { streak: number; total: number };

  /** Took damage (or the firewall absorbed it). */
  hit: At & { kind: ObstacleKind; damage: number; health: number; absorbed: boolean; graze: boolean };
  heal: { amount: number; health: number };
  /** An obstacle was wiped out by a power-up (debug / admin / boost). */
  obstacleDeleted: At & { kind: ObstacleKind; badBug: boolean };
  /** Obstacle materialised close to the player (boss drops, late spawns). */
  materialize: { x: number; z: number; kind: ObstacleKind };

  obstacleCleared: At & { kind: ObstacleKind; how: 'jump' | 'slide' | 'dodge' };
  /** `how` is set for vertical near misses: jumped over / slid under. */
  nearMiss: At & { kind: ObstacleKind; style: 'lateral' | 'vertical'; how?: 'jump' | 'slide' };
  combo: { combo: number; multiplier: number; points: number; label: string; levelUp: boolean };
  comboEnd: { combo: number; reason: 'timeout' | 'hit' | 'death' };

  powerStart: { type: PowerType; fresh: boolean };
  powerEnd: { type: PowerType; reason: 'expired' | 'absorbed' };

  stage: { id: number; name: string };

  /** Boss encounters (see boss/BossDirector). */
  bossWarning: { name: string };
  bossStart: { name: string; index: number };
  bossImpact: At & { color: string };
  bossActive: undefined;
  bossHit: At & { dmg: number; hp: number; max: number; kind: BossHitKind; combo?: number; perfect?: boolean };
  /** One input of a sequence landed (a light blow on the boss). */
  bossJab: At & { n: number };
  /** A touch attack sequence resolved (ok) or failed. */
  bossSeq: { ok: boolean; kind: string; perfect: boolean; combo: number };
  bossPhase: At & { phase: number; label: string };
  bossDeleted: At & { name: string; index: number };
  bossExplode: At & { size: number; color: string };
  bossDebris: { x: number; z: number; color: string };
  bossEnd: undefined;

  death: { kind: ObstacleKind; score: number; distance: number };
  newBest: { score: number };

  /** A mission was finished (mid-run, or as the run ended). */
  missionComplete: { index: number; text: string; xp: number };
  /** All three missions are done; `mult` is the score multiplier from the next run. */
  missionSetComplete: { mult: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus<E extends object> {
  private handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(key: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof E>(key: K, ...payload: E[K] extends undefined ? [] : [E[K]]): void {
    const set = this.handlers.get(key);
    if (!set) return;
    for (const fn of set) (fn as Handler<unknown>)(payload[0]);
  }
}

export const events = new EventBus<GameEvents>();
