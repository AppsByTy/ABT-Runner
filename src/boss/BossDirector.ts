import * as THREE from 'three';
import { audio } from '../audio/AudioManager';
import { LANE_X } from '../core/Config';
import { events } from '../core/EventBus';
import type { BossHitKind } from '../core/EventBus';
import type { InputAction } from '../input/InputManager';
import type { CameraController } from '../game/CameraController';
import type { PlayerController } from '../game/PlayerController';
import type { PostFX } from '../fx/PostFX';
import type { MaterialLib } from '../render/MaterialLib';
import type { HUD } from '../ui/HUD';
import { Random } from '../utils/Random';
import { KIND_CLASS, isBadBug, type ObstacleManager } from '../world/Obstacles';
import type { PickupManager } from '../world/Pickups';
import type { Spawner } from '../world/Spawner';
import type { BossModel, BossMode } from './BossModel';
import { BOSSES, BOSS_AT, BOSS_REPEAT, type AttackDef, type BossDef, type Row } from './bosses';
import { comboMult, GLYPH_OF, Sequence, SEQ_GRACE, SEQ_LABEL, SEQ_MULT, type SeqKind } from './Combat';
import { LaneWarnings, type WarnKind } from './LaneWarnings';

/**
 * Boss encounters, layered on the normal run (the game itself stays in its
 * "playing" state, so pause, death, restart and game over work unchanged).
 *
 *   RUNNING -> WARNING -> BOSS_INTRO -> BOSS_FIGHT -> BOSS_DEFEATED
 *           -> VICTORY_CINEMATIC -> NEXT_LEVEL -> RUNNING
 *
 * The fight itself: the boss telegraphs and throws attacks (dodge them with
 * the normal lane / jump / slide moves), then opens up. While it is open a
 * touch sequence appears (taps and swipes); entering it strikes the boss.
 *   hit by the attack       -> OPENING    (normal strike)
 *   dodged it cleanly       -> WEAK POINT (critical hit)
 *   dodged a HEAVY attack   -> PERFECT DODGE, slow motion, COUNTER!
 *   combo builds the SPECIAL meter -> long sequence -> cinematic special
 *   miss / too slow         -> combo reset, the boss strikes straight back
 *
 * Bosses trigger on "progress distance" - metres run outside encounters -
 * so the corruption stages (areas) are gated by bosses: the next area opens
 * as the boss goes down.
 */
export type EncounterState = 'running' | 'warning' | 'intro' | 'fight' | 'defeated' | 'victory' | 'nextLevel';

export const ENCOUNTER_FLOW: Record<EncounterState, readonly EncounterState[]> = {
  running: ['warning'],
  warning: ['intro'],
  intro: ['fight'],
  fight: ['defeated'],
  defeated: ['victory'],
  victory: ['nextLevel'],
  nextLevel: ['running'],
};

export interface BossHost {
  readonly obstacles: ObstacleManager;
  readonly pickups: PickupManager;
  readonly spawner: Spawner;
  readonly player: PlayerController;
  readonly hud: HUD;
  readonly cam: CameraController;
  readonly post: PostFX;
  distance(): number;
  speed(): number;
  /** Hits taken this run (perfect-dodge check). */
  hits(): number;
  /** Boss down: pay out and return the reward line for the victory card. */
  reward(def: BossDef, index: number, cycle: number): string;
}

interface LiveRow extends Row {
  /** Direction cue shown as this group of hazards appears. */
  cue?: { text: string; tone: WarnKind };
  teleAt: number;
  spawnAt: number;
  arriveAt: number;
  dist: number;
  shown: boolean;
  spawned: boolean;
}

interface LiveAttack {
  id: string;
  def: AttackDef;
  rows: LiveRow[];
  t: number;
  firstSpawn: number;
  /** Every hazard is past the runner: judge the dodge. */
  clearAt: number;
  end: number;
  hitsAtStart: number;
  judged: boolean;
}

const WARN_FOR = { low: 'jump', high: 'slide', wall: 'move' } as const;
const PATCH_DMG = 12;
/** Base strike damage as a share of the boss's health. */
const STRIKE = 0.036;
type CineKind = 'counter' | 'special' | 'rage' | 'low' | '';

export class BossDirector {
  state: EncounterState = 'running';
  /** Seconds (real time) in the current state. */
  stateT = 0;
  /** Simulation speed the game should run at (slow motion in cinematics). */
  timeScale = 1;
  /** Movement input ignored (cinematics). */
  inputLocked = false;
  /** Runner can't be hurt (cinematics and the moment after a win). */
  shielded = false;
  /** Lighting mood the game blends toward: boss colour, strength, darkness. */
  readonly mood = { color: new THREE.Color(), amount: 0, dark: 0 };
  hp = 0;
  maxHp = 1;
  phase = 0;
  /** Bosses beaten this run. */
  defeated = 0;
  /** Metres run inside encounters (excluded from progress distance). */
  encounterDist = 0;
  /** Touch attack sequence in progress (the boss is open). */
  seq: Sequence | null = null;
  combo = 0;
  /** Special meter, 0..1 (full = SPECIAL ATTACK READY). */
  meter = 0;
  /** Left/right swapped (mirror attacks). */
  reversed = false;
  /** Per-fight numbers (tests and tuning). */
  readonly stats = { attacks: 0, dodges: 0, ok: 0, fail: 0, slow: 0, perfect: 0, crit: 0, counter: 0, special: 0, hitsTaken: 0 };

  private readonly host: BossHost;
  private readonly models: BossModel[];
  private readonly warnings: LaneWarnings;
  private readonly rng = new Random(7);
  private index = 0;
  private cycle = 0;
  private nextAt = BOSS_AT[0];
  private lastDist = 0;
  private attack: LiveAttack | null = null;
  private cooldown = 0;
  private shift = 0;
  private roarT = 0;
  private lastAttack = '';
  private readonly called = new Set<string>();
  private hurt = 0;
  private bossX = 0;
  private targetX = 0;
  private time = 0;
  private rewardText = '';
  private debrisT = 0;
  private blueT = 0;
  /** Real-time hit-stop at a phase change. */
  private hitStop = 0;
  private readonly shot = { w: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 55 };
  private readonly coreW = new THREE.Vector3();
  private readonly nextExplode = { t: 0 };
  private slowT = 0;
  private slowScale = 1;
  private cineT = 0;
  private cineLen = 1;
  private cineKind: CineKind = '';
  private afterCine: (() => void) | null = null;
  private cineHit: { dmg: number; perfect: boolean; done: boolean } | null = null;
  private seqHideT = 0;
  private nextPart: { kind: SeqKind; part: number; phase: number } | null = null;
  private lowDone = false;
  private taught = false;

  constructor(scene: THREE.Scene, lib: MaterialLib, host: BossHost) {
    this.host = host;
    this.models = BOSSES.map((d) => {
      const m = d.make(lib);
      scene.add(m.root);
      return m;
    });
    this.warnings = new LaneWarnings(scene);
  }

  get def(): BossDef {
    return BOSSES[this.index];
  }

  private get model(): BossModel {
    return this.models[this.index];
  }

  /** Any encounter in progress. */
  get active(): boolean {
    return this.state !== 'running';
  }

  /** Stage (area) changes wait until the boss is beaten. */
  get blocksStages(): boolean {
    return this.state !== 'running' && this.state !== 'nextLevel';
  }

  /** Legacy hooks (FX beams from the boss when hazards materialise). */
  get fighting(): boolean {
    return this.state === 'intro' || this.state === 'fight';
  }

  get mouth(): THREE.Vector3 {
    return this.model.core.getWorldPosition(this.coreW);
  }

  /** Metres run outside boss encounters. */
  progress(distance: number): number {
    return distance - this.encounterDist;
  }

  /** Display name incl. the upgrade mark for repeat encounters. */
  get name(): string {
    return this.cycle ? `${this.def.name} MK ${['', 'II', 'III', 'IV', 'V'][Math.min(4, this.cycle)] || this.cycle + 1}` : this.def.name;
  }

  reset(): void {
    this.state = 'running';
    this.stateT = 0;
    this.timeScale = 1;
    this.inputLocked = this.shielded = false;
    this.mood.amount = this.mood.dark = 0;
    this.index = this.cycle = this.defeated = 0;
    this.nextAt = BOSS_AT[0];
    this.encounterDist = 0;
    this.lastDist = 0;
    this.attack = null;
    this.called.clear();
    this.warnings.clear();
    this.clearCombat();
    this.taught = false;
    this.shot.w = 0;
    this.host.cam.shot.w = 0;
    for (const m of this.models) m.reset();
    this.host.hud.bossWarning(null);
    this.host.hud.bossCine(false);
    this.host.hud.bossBar(null);
    this.host.hud.bossVictory(null);
  }

  /** Start the next boss right now (tests / debugging). */
  trigger(index?: number): void {
    if (index !== undefined) this.index = index;
    if (this.state === 'running') this.enter('warning');
  }

  private enter(next: EncounterState): void {
    if (!ENCOUNTER_FLOW[this.state].includes(next)) {
      console.warn(`[boss] illegal transition ${this.state} -> ${next}`);
      return;
    }
    this.state = next;
    this.stateT = 0;
    const h = this.host;
    const d = this.def;
    switch (next) {
      case 'warning':
        this.mood.color.set(d.color);
        h.spawner.setBoss(true, h.distance());
        h.hud.bossWarning(this.name);
        audio.play('bossAlarm');
        events.emit('bossWarning', { name: this.name });
        break;
      case 'intro': {
        h.hud.bossWarning(null);
        h.hud.bossCine(true);
        const m = this.model;
        m.reset();
        m.root.visible = true;
        this.bossX = this.targetX = 0;
        this.maxHp = Math.round(d.hp * (1 + this.cycle * 0.25));
        this.hp = this.maxHp;
        this.phase = 0;
        this.roarT = 0;
        this.hitStop = 0;
        this.shift = 0;
        this.lastAttack = '';
        this.called.clear();
        this.clearCombat();
        this.combo = 0;
        this.meter = 0;
        this.lowDone = false;
        for (const k of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[k] = 0;
        audio.setBoss(true);
        audio.play('bossRiser');
        events.emit('bossStart', { name: this.name, index: this.index });
        break;
      }
      case 'fight':
        h.hud.bossCine(false);
        h.hud.bossBar({ name: this.name, color: d.color, phases: d.phases.map((p) => p.at) });
        h.hud.bossHp(1, 0);
        h.hud.banner('FIGHT!', 'DODGE ITS ATTACKS · THEN STRIKE BACK', 'gold', 1.6);
        this.meta();
        this.cooldown = 0.6;
        this.attack = null;
        events.emit('bossActive');
        break;
      case 'defeated': {
        this.attack = null;
        this.warnings.clear();
        this.clearCombat();
        // Every hazard on the track shatters with it.
        h.obstacles.forEach((o) => {
          if (o.destroyed) return;
          h.obstacles.destroy(o);
          o.noScore = true;
          events.emit('obstacleDeleted', { kind: o.kind, badBug: isBadBug(o.kind), x: o.x, y: 0.8, z: -(o.dist - h.distance()) });
        });
        const at = this.mouth;
        this.rewardText = h.reward(d, this.index, this.cycle);
        audio.play('bossDeleted');
        events.emit('bossDeleted', { name: this.name, index: this.index, x: at.x, y: at.y, z: at.z });
        this.nextExplode.t = 0.25;
        break;
      }
      case 'victory':
        break;
      case 'nextLevel':
        this.model.root.visible = false;
        h.hud.bossVictory(null);
        h.hud.bossBar(null);
        h.spawner.resume(h.distance());
        audio.setBoss(false);
        this.defeated++;
        // Next boss: the following one, or the cycle starts again tougher.
        this.index++;
        if (this.index >= BOSSES.length) {
          this.index = 0;
          this.cycle++;
        }
        {
          const k = this.defeated;
          this.nextAt = k < BOSS_AT.length ? BOSS_AT[k] : BOSS_AT[BOSS_AT.length - 1] + (k - BOSS_AT.length + 1) * BOSS_REPEAT;
        }
        events.emit('bossEnd');
        break;
      case 'running':
        break;
    }
  }

  /** Simulation step (scaled time). */
  step(dt: number): void {
    const dist = this.host.distance();
    if (this.state !== 'running' && this.state !== 'nextLevel') this.encounterDist += dist - this.lastDist;
    this.lastDist = dist;
    if (this.state === 'running' && this.progress(dist) >= this.nextAt) this.enter('warning');
    if (this.state === 'fight') this.fight(dt);
  }

  /** Real-time step: cinematics, the boss itself, camera shots, lighting. */
  animate(dt: number, playing: boolean): void {
    this.time += dt;
    this.stateT += dt;
    this.hurt = Math.max(0, this.hurt - dt * 3.5);
    this.roarT = Math.max(0, this.roarT - dt / 1.6);
    this.blueT = Math.max(0, this.blueT - dt);
    this.hitStop = Math.max(0, this.hitStop - dt);
    const h = this.host;
    const d = this.def;
    const T = this.stateT;
    let mode: BossMode = 'hidden';
    let shotW = 0;
    let scaleTarget = 1;

    switch (this.state) {
      case 'running':
        break;
      case 'warning':
        this.mood.amount = Math.min(0.45, T * 0.3);
        if (Math.floor(T * 2.5) !== Math.floor((T - dt) * 2.5)) h.post.flashScreen(d.color, 0.12);
        if (T > 2.6 && playing) this.enter('intro');
        break;
      case 'intro': {
        mode = 'intro';
        const L = d.intro;
        scaleTarget = T < L - 0.9 ? 0.25 : 1;
        this.inputLocked = true;
        this.shielded = true;
        shotW = T < 0.35 ? T / 0.35 : T > L - 0.9 ? Math.max(0, (L - T) / 0.9) : 1;
        this.introShot(T, L);
        if (T >= d.impactAt && T - dt < d.impactAt) {
          const c = this.mouth;
          events.emit('bossImpact', { x: this.bossX, y: 0.2, z: -d.z, color: d.color });
          h.cam.shake(0.9);
          h.post.glitch(1.2);
          h.post.flashScreen(d.color, 0.45);
          audio.play('bossImpact');
          void c;
        }
        const titleAt = Math.min(L - 3.2, d.impactAt + 0.9);
        if (T >= titleAt && T - dt < titleAt) {
          h.hud.bossTitle(this.name, d.title, this.cycle ? `THREAT LEVEL ${this.index + 1 + this.cycle * BOSSES.length}` : `BOSS ${this.index + 1} / ${BOSSES.length}`, d.color);
          audio.play('bossRoar');
          h.cam.shake(0.5);
        }
        if (T >= L - 1.0 && T - dt < L - 1.0) h.hud.bossCine(false);
        this.mood.amount = 0.45 + Math.min(0.2, T * 0.05);
        if (T >= L && playing) {
          this.inputLocked = false;
          this.shielded = false;
          this.enter('fight');
        }
        break;
      }
      case 'fight': {
        mode = 'fight';
        this.mood.amount = 0.5 + this.phase * 0.12;
        this.slowT = Math.max(0, this.slowT - dt);
        const a = this.attack;
        // Hit-stop at a phase change, slow motion for PERFECTs, counters,
        // specials and heavy wind-ups.
        scaleTarget = this.hitStop > 0 ? 0.08 : this.slowT > 0 ? this.slowScale : 1;
        if (a?.def.heavy && a.t < 0.55 && scaleTarget === 1) scaleTarget = 0.45;
        if (this.seq && (this.seq.kind === 'counter' || this.seq.kind === 'special') && scaleTarget === 1) scaleTarget = 0.4;
        if (playing) this.combat(dt);
        if (this.cineT > 0) {
          const u = 1 - this.cineT / this.cineLen;
          shotW = Math.min(1, u * 6, this.cineT / 0.2);
          this.cineShot(u);
          scaleTarget = Math.min(scaleTarget, this.cineKind === 'special' ? 0.22 : this.cineKind === 'counter' ? 0.2 : 0.3);
        }
        this.inputLocked = this.shielded = this.cineT > 0;
        // Falling debris as the world gets more dangerous.
        if (this.phase >= 1) {
          this.debrisT -= dt;
          if (this.debrisT <= 0) {
            this.debrisT = 0.9 - this.phase * 0.18;
            events.emit('bossDebris', { x: (Math.random() - 0.5) * 9, z: -12 - Math.random() * 26, color: d.color });
          }
        }
        break;
      }
      case 'defeated':
        mode = 'defeat';
        this.inputLocked = true;
        this.shielded = true;
        scaleTarget = T < 0.3 ? 0.05 : 0.3;
        shotW = Math.min(1, T / 0.3);
        this.victoryShot(T);
        this.explosions(dt, T);
        if (T > 1.2) this.enter('victory');
        break;
      case 'victory': {
        mode = 'defeat';
        const V = T + 1.2;
        scaleTarget = V < 4.2 ? 0.35 : 1;
        shotW = V > 4.4 ? Math.max(0, 1 - (V - 4.4) / 0.8) : 1;
        this.victoryShot(V);
        this.explosions(dt, V);
        this.mood.amount = Math.max(0, 0.6 - V * 0.12);
        if (V >= 1.9 && V - dt < 1.9) h.hud.bossVictory({ title: 'THREAT ELIMINATED', sub: 'SYSTEM RESTORED', name: this.name, rewards: this.rewardText, color: d.color });
        if (V >= 3.4) this.model.root.visible = false;
        if (V >= 5.2 && playing) this.enter('nextLevel');
        break;
      }
      case 'nextLevel':
        this.inputLocked = false;
        this.shielded = T < 1.2;
        this.mood.amount = 0;
        if (T >= 2.0) this.enter('running');
        break;
    }

    // Slow motion eases in and out (hit-stops snap in).
    const k = scaleTarget < this.timeScale && scaleTarget < 0.1 ? 1 : Math.min(1, dt * 5);
    this.timeScale += (scaleTarget - this.timeScale) * k;
    if (this.state === 'running' || this.state === 'nextLevel' || this.state === 'warning') this.timeScale = Math.min(1, this.timeScale + dt * 2);
    this.mood.dark += ((this.blueT > 0 ? 0.75 : 0) - this.mood.dark) * Math.min(1, dt * 6);

    // Camera shot blend.
    this.shot.w += (shotW - this.shot.w) * Math.min(1, dt * 10);
    const cs = h.cam.shot;
    cs.w = this.shot.w;
    cs.pos.copy(this.shot.pos);
    cs.look.copy(this.shot.look);
    cs.fov = this.shot.fov;

    this.warnings.update(h.distance(), dt);
    this.placeBoss(dt, mode);
  }

  // ------------------------------------------------------------------ fight

  private fight(dt: number): void {
    this.shift = Math.max(0, this.shift - dt);
    // The boss holds while it is open to a strike or a cinematic plays.
    if (this.seq || this.cineT > 0 || this.nextPart || this.seqHideT > 0) return;
    const a = this.attack;
    if (a) {
      a.t += dt;
      for (const r of a.rows) {
        if (!r.shown && a.t >= r.teleAt) this.telegraph(r, a);
        if (!r.spawned && a.t >= r.spawnAt) this.spawnRow(r);
      }
      if (!a.judged && a.t > a.clearAt) {
        a.judged = true;
        this.attack = null;
        this.judge(a);
      }
      return;
    }
    if (this.shift > 0) return;
    this.cooldown -= dt;
    if (this.cooldown <= 0) this.startAttack();
  }

  private get lead(): number {
    return Math.max(1.05, this.def.lead - this.phase * 0.15 - this.cycle * 0.1);
  }

  private get tele(): number {
    return Math.max(0.4, 0.75 - this.phase * 0.1);
  }

  /** Rest before the next attack: shorter each phase and in the last quarter. */
  private get gap(): number {
    const low = this.hp / this.maxHp <= 0.25 ? 0.75 : 1;
    return Math.max(0.6, (this.def.gap - this.phase * 0.35 - Math.min(0.5, this.cycle * 0.15)) * low);
  }

  private startAttack(): void {
    const d = this.def;
    const h = this.host;
    const pool = d.phases[this.phase].attacks;
    let id = this.rng.pick(pool);
    if (id === this.lastAttack && pool.length > 1) id = this.rng.pick(pool.filter((x) => x !== id));
    this.lastAttack = id;
    const def = d.attacks[id];
    const rows = def.rows({ rng: this.rng, phase: this.phase, lane: h.player.lane, color: d.color });
    const lead = this.lead;
    const tele = this.tele;
    const first = 0.35 + tele + lead;
    const live: LiveRow[] = rows.map((r) => ({ ...r, arriveAt: first + r.at, spawnAt: first + r.at - lead, teleAt: first + r.at - lead - tele, dist: 0, shown: false, spawned: false }));
    this.planCues(live, !!def.area);
    const speed = Math.max(8, h.speed());
    const clearAt = live.reduce((m, r) => (r.fake ? m : Math.max(m, r.arriveAt + (r.depth ?? 1.5) / speed)), 0) + 0.3;
    const lastArrive = live.reduce((m, r) => Math.max(m, r.arriveAt), 0);
    this.attack = { id, def, rows: live, t: 0, firstSpawn: first - lead, clearAt, end: lastArrive + 0.9, hitsAtStart: h.hits(), judged: false };
    if (!this.called.has(id)) {
      this.called.add(id);
      h.hud.hint(def.call);
    }
    if (def.heavy) {
      // Heavy: red flash, shake, a warning call-out and a slow-motion wind-up.
      h.hud.combatFeedback('⚠ HEAVY ATTACK', def.call.split(' · ')[1] ?? def.call, 'red');
      h.post.flashScreen(d.color, 0.3);
      h.cam.shake(0.45);
      audio.play('bossRoar');
      this.roarT = 1;
    }
    if (def.reverse) this.setReversed(true);
    if (def.fx === 'teleport') {
      this.targetX = this.bossX = LANE_X[this.rng.int(0, 2)] * 0.9;
      h.post.glitch(1);
      audio.play('error');
    } else if (def.fx === 'bluescreen') {
      this.blueT = lastArrive + 0.5;
      h.post.flashScreen('#2a6bff', 0.5);
    } else if (def.fx === 'glitch') h.post.glitch(1.4);
    audio.play('bossTelegraph');
  }

  /** Work out a safe route through the attack and the cue for each step. */
  private planCues(rows: LiveRow[], area: boolean): void {
    let lane = this.host.player.lane;
    const real = rows.filter((r) => !r.fake);
    const ats = [...new Set(real.map((r) => r.at))].sort((x, y) => x - y);
    for (const at of ats) {
      const g = real.filter((r) => r.at === at);
      const of = (c: string): Set<number> => new Set(g.filter((r) => KIND_CLASS[r.kind] === c).flatMap((r) => r.lanes));
      const walls = of('wall');
      const lows = of('low');
      const highs = of('high');
      const clear = (l: number): boolean => !lows.has(l) && !highs.has(l);
      const free = [0, 1, 2].filter((l) => !walls.has(l));
      if (!free.length) continue;
      const near = free.filter((l) => Math.abs(l - lane) <= 1 && clear(l));
      const pickFrom = near.length ? near : free;
      const target = pickFrom.reduce((b, l) => (Math.abs(l - lane) < Math.abs(b - lane) ? l : b));
      const n = Math.abs(target - lane);
      const arrow = target < lane ? '◀'.repeat(n) : '▶'.repeat(n);
      const act = lows.has(target) ? 'JUMP' : highs.has(target) ? 'SLIDE' : '';
      let text: string;
      if (n && act) text = target < lane ? `${arrow} MOVE + ${act}` : `MOVE + ${act} ${arrow}`;
      else if (n) text = target < lane ? `${arrow} DODGE LEFT` : `DODGE RIGHT ${arrow}`;
      else text = act === 'JUMP' ? '▲ JUMP' : act === 'SLIDE' ? '▼ SLIDE' : area ? '● HOLD THE SAFE ZONE' : '● STAY';
      g[0].cue = { text, tone: act === 'JUMP' ? 'jump' : act === 'SLIDE' ? 'slide' : area ? 'safe' : 'move' };
      lane = target;
    }
  }

  private telegraph(r: LiveRow, a: LiveAttack): void {
    const h = this.host;
    r.shown = true;
    r.dist = h.distance() + h.speed() * (r.spawnAt - r.teleAt + this.lead);
    // Decoys get no floor warning: that is how you tell them apart.
    if (r.fake) return;
    const cls = KIND_CLASS[r.kind];
    const warn: WarnKind = WARN_FOR[cls];
    for (const l of r.lanes) this.warnings.show(l, r.dist, warn);
    if (a.def.area && cls === 'wall') for (let l = 0; l < 3; l++) if (!r.lanes.includes(l)) this.warnings.show(l, r.dist, 'safe');
  }

  private spawnRow(r: LiveRow): void {
    const h = this.host;
    r.spawned = true;
    if (!r.shown) {
      r.shown = true;
      r.dist = h.distance() + h.speed() * this.lead;
    }
    if (r.cue) h.hud.combatCue(this.reversed ? `${r.cue.text} ⇄` : r.cue.text, r.cue.tone);
    for (const l of r.lanes) h.obstacles.spawn(r.kind, l, r.dist, { materialize: true, depth: r.depth, variant: this.rng.int(0, 3), color: this.def.color, fake: r.fake });
  }

  private setReversed(on: boolean): void {
    if (this.reversed === on) return;
    this.reversed = on;
    this.host.hud.combatReverse(on);
    if (on) {
      this.host.post.glitch(1.2);
      audio.play('error');
    }
  }

  /** The attack is over: how did the runner do? That decides the opening. */
  private judge(a: LiveAttack): void {
    const h = this.host;
    this.setReversed(false);
    this.stats.attacks++;
    const clean = h.hits() === a.hitsAtStart;
    const special = this.meter >= 1;
    if (clean) this.stats.dodges++;
    else {
      this.stats.hitsTaken++;
      if (this.combo) {
        this.combo = 0;
        this.meta();
      }
    }
    if (clean && a.def.heavy) {
      // PERFECT DODGE -> time slows -> COUNTER!
      h.hud.combatFeedback('PERFECT DODGE', 'COUNTER!', 'cyan');
      audio.play('nearMiss');
      h.post.flashScreen('#00e5ff', 0.3);
      this.startCine('counter', 0.75, () => this.openSeq(special ? 'special' : 'counter'));
    } else this.openSeq(special ? 'special' : clean ? 'weak' : 'opening');
  }

  private openSeq(kind: SeqKind, part = 1): void {
    if (this.state !== 'fight' || this.hp <= 0) return;
    const c = this.def.combat;
    const parts = kind === 'special' ? 1 : c.weak?.[this.phase] ?? 1;
    const pool = c.seqs[Math.min(this.phase, c.seqs.length - 1)];
    const steps = kind === 'special' ? c.special : this.rng.pick(pool);
    const perStep = Math.max(0.36, c.perStep - this.phase * 0.06 - this.cycle * 0.03) * (kind === 'special' ? 1.1 : 1);
    this.seq = new Sequence(steps, kind, perStep, part, parts);
    const title = parts > 1 ? `${kind === 'opening' ? 'OPENING' : 'WEAK POINT'} ${part}/${parts}` : SEQ_LABEL[kind];
    this.host.hud.combatSeq({ title, steps: this.seq.steps, kind });
    this.host.hud.combatCue(null);
    if (part === 1) {
      audio.play('bossTelegraph');
      this.host.cam.kickFov(-3);
    }
    if (!this.taught) {
      this.taught = true;
      this.host.hud.hint('TAP / SWIPE THE SEQUENCE TO ATTACK');
    }
  }

  /** Taps and swipes go to the sequence while one is open. */
  combatInput(a: InputAction): boolean {
    if (this.state !== 'fight' || !this.seq || a === 'pause') return false;
    const g = GLYPH_OF[a];
    if (!g) return true;
    const s = this.seq;
    const r = s.input(g);
    if (r === 'ignored') return true;
    if (r === 'fail') {
      this.host.hud.combatStep(s.i, 'fail');
      this.resolveSeq(false);
      return true;
    }
    this.host.hud.combatStep(s.i, r);
    audio.play('seqTick', s.i * 2);
    if (r === 'done') this.resolveSeq(true);
    return true;
  }

  private resolveSeq(ok: boolean): void {
    const s = this.seq!;
    const h = this.host;
    this.seq = null;
    this.seqHideT = 0.45;
    events.emit('bossSeq', { ok, kind: s.kind, perfect: ok && s.perfect, combo: ok ? this.combo + 1 : 0 });
    if (!ok) {
      this.stats.fail++;
      if (s.failReason === 'slow') this.stats.slow++;
      this.combo = 0;
      if (s.kind === 'special') this.meter = 0.5;
      h.hud.combatFeedback('MISS', s.failReason === 'slow' ? 'TOO SLOW · IT STRIKES BACK' : 'WRONG MOVE · IT STRIKES BACK', 'red');
      audio.play('seqMiss');
      h.post.flashScreen('#ff2a4a', 0.25);
      h.cam.shake(0.35);
      this.roarT = 1;
      // The boss punishes the miss: next attack straight away.
      this.cooldown = 0.3;
      this.meta();
      return;
    }
    this.stats.ok++;
    const perfect = s.perfect;
    if (perfect) this.stats.perfect++;
    this.combo++;
    const kind: BossHitKind = s.kind === 'opening' ? 'strike' : s.kind === 'weak' ? 'crit' : s.kind;
    if (kind === 'crit') this.stats.crit++;
    if (kind === 'counter') this.stats.counter++;
    const dmg = Math.max(1, Math.round(this.maxHp * STRIKE * SEQ_MULT[s.kind] * comboMult(this.combo) * (perfect ? 1.35 : 1)));
    const before = this.meter;
    this.meter = s.kind === 'special' ? 0 : Math.min(1, this.meter + 0.2 + (perfect ? 0.1 : 0) + (s.kind === 'counter' ? 0.15 : 0));
    const ready = before < 1 && this.meter >= 1;
    if (s.kind === 'special') {
      this.stats.special++;
      this.cineHit = { dmg, perfect, done: false };
      h.hud.combatFeedback('SPECIAL ATTACK', 'SYSTEM OVERRIDE', 'lime');
      audio.play('perfect');
      this.startCine('special', 1.8);
    } else this.strike(dmg, kind, perfect);
    this.meta();
    if (ready) {
      h.hud.hint('SPECIAL ATTACK READY · NEXT OPENING UNLEASHES IT');
      audio.play('comboTier');
    }
    if (this.state !== 'fight') return;
    if (s.part < s.parts && s.kind !== 'special') this.nextPart = { kind: s.kind, part: s.part + 1, phase: this.phase };
    else this.cooldown = this.gap;
  }

  /** The runner's attack lands. */
  private strike(dmg: number, kind: BossHitKind, perfect: boolean): void {
    const h = this.host;
    const title = perfect ? 'PERFECT!' : kind === 'crit' ? 'CRITICAL HIT!' : kind === 'counter' ? 'COUNTER!' : kind === 'special' ? 'SYSTEM OVERRIDE!' : 'HIT!';
    const extra = perfect && kind === 'crit' ? 'CRITICAL · ' : perfect && kind === 'counter' ? 'COUNTER · ' : '';
    const sub = `${extra}-${dmg} HP${this.combo >= 2 ? ` · COMBO x${this.combo}` : ''}`;
    h.hud.combatFeedback(title, sub, perfect ? 'gold' : kind === 'crit' ? 'gold' : kind === 'counter' ? 'pink' : kind === 'special' ? 'lime' : 'white');
    h.hud.popup(`-${dmg}`, perfect || kind === 'crit' ? 'gold' : 'lime', true);
    audio.play('strike', Math.min(6, this.combo));
    if (perfect) audio.play('perfect');
    const power = ({ strike: 1, crit: 1.5, counter: 1.8, special: 2.6 } as Record<string, number>)[kind] * (perfect ? 1.3 : 1) * (1 + 0.1 * Math.min(5, this.combo));
    h.cam.shake(Math.min(1, 0.3 + power * 0.2));
    h.cam.kickFov(-(3 + power * 2));
    if (perfect) {
      this.slowT = 0.3;
      this.slowScale = 0.15;
      h.post.flashScreen('#ffffff', 0.4);
    } else h.post.flashScreen(this.def.accent, 0.15 + power * 0.05);
    this.damage(dmg, kind, perfect);
  }

  private startCine(kind: CineKind, len: number, then?: () => void): void {
    this.cineKind = kind;
    this.cineT = this.cineLen = len;
    this.afterCine = then ?? null;
  }

  private clearCombat(): void {
    this.seq = null;
    this.nextPart = null;
    this.cineT = 0;
    this.cineKind = '';
    this.afterCine = null;
    this.cineHit = null;
    this.slowT = this.seqHideT = 0;
    this.reversed = false;
    const hud = this.host.hud;
    hud.combatSeq(null);
    hud.combatCue(null);
    hud.combatReverse(false);
  }

  private meta(): void {
    this.host.hud.combatMeta(this.combo, this.meter, this.meter >= 1);
  }

  /** Legacy: a security patch pickup reached the boss. */
  patch(): void {
    this.damage(PATCH_DMG, 'patch');
  }

  damage(n: number, kind: BossHitKind, perfect = false): void {
    if (this.state !== 'fight' || this.hp <= 0) return;
    const phases = this.def.phases;
    // One hit can't skip a phase: it stops at the next threshold.
    if (this.phase + 1 < phases.length) n = Math.min(n, this.hp - Math.floor(phases[this.phase + 1].at * this.maxHp));
    this.hp = Math.max(0, this.hp - n);
    this.hurt = 1;
    const at = this.mouth;
    events.emit('bossHit', { dmg: n, hp: this.hp, max: this.maxHp, kind, combo: this.combo, perfect, x: at.x, y: at.y, z: at.z });
    audio.play('bossHit', kind === 'patch' ? 0 : 5);
    const frac = this.hp / this.maxHp;
    if (this.phase + 1 < phases.length && frac <= phases[this.phase + 1].at && this.hp > 0) {
      this.phase++;
      this.shift = 2.2;
      this.roarT = 1;
      this.hitStop = 0.4;
      this.nextPart = null;
      const p = phases[this.phase];
      const last = this.phase === phases.length - 1;
      this.host.hud.banner(last ? `${p.label}!` : `PHASE ${this.phase + 1}`, last ? 'ENRAGED · FASTER · DEADLIER' : `${p.label} · NEW ATTACKS`, last ? 'red' : 'orange', 2.0);
      this.host.cam.shake(0.8);
      this.host.post.glitch(1.4);
      this.host.post.flashScreen(this.def.color, 0.5);
      audio.play('bossRoar');
      events.emit('bossPhase', { phase: this.phase, label: p.label, x: at.x, y: at.y, z: at.z });
      if (last && this.cineT <= 0) this.startCine('rage', 1.4);
    } else if (!this.lowDone && frac <= 0.25 && this.hp > 0) {
      this.lowDone = true;
      this.host.hud.banner('CRITICAL DAMAGE', 'FINISH IT!', 'red', 1.5);
      if (this.cineT <= 0) this.startCine('low', 1.0);
    }
    this.host.hud.bossHp(frac, this.phase);
    if (this.hp <= 0) this.enter('defeated');
  }

  // ------------------------------------------------------------ cinematics

  private readonly bossC = new THREE.Vector3();

  /** Real-time combat: sequence timers, cinematics, follow-up weak points. */
  private combat(dt: number): void {
    const h = this.host;
    if (this.seq) {
      const s = this.seq;
      // The exposed core pulses while the boss is open.
      this.hurt = Math.max(this.hurt, 0.3 + 0.25 * Math.sin(this.time * 14));
      if (s.tick(dt)) {
        h.hud.combatStep(s.i, 'fail');
        this.resolveSeq(false);
      } else h.hud.combatTime(s.t < SEQ_GRACE ? 1 : s.left);
    }
    if (this.seqHideT > 0) {
      this.seqHideT -= dt;
      if (this.seqHideT <= 0 && !this.seq) {
        h.hud.combatSeq(null);
        const n = this.nextPart;
        if (n && this.cineT <= 0) {
          this.nextPart = null;
          if (n.phase === this.phase) this.openSeq(n.kind, n.part);
          else this.cooldown = this.gap;
        }
      }
    }
    if (this.cineT > 0) {
      const u0 = 1 - this.cineT / this.cineLen;
      this.cineT -= dt;
      const u = 1 - Math.max(0, this.cineT) / this.cineLen;
      if (this.cineKind === 'special') {
        // Five strikes land in slow motion, then the big one.
        for (let k = 0; k < 5; k++) {
          const at = 0.15 + k * 0.07;
          if (u >= at && u0 < at) {
            const c = this.mouth;
            events.emit('bossExplode', { x: c.x + (Math.random() - 0.5) * 3, y: c.y + (Math.random() - 0.5) * 3, z: c.z + 1, size: 0.7, color: k % 2 ? this.def.accent : '#b4ff1e' });
            audio.play('strike', k);
            h.cam.shake(0.35);
          }
        }
        const hit = this.cineHit;
        if (hit && !hit.done && u >= 0.55) {
          hit.done = true;
          this.strike(hit.dmg, 'special', hit.perfect);
          if (this.state !== 'fight') return;
        }
      }
      if (this.cineT <= 0) {
        const f = this.afterCine;
        this.cineT = 0;
        this.cineKind = '';
        this.afterCine = null;
        this.cineHit = null;
        if (f) f();
        else if (!this.seq && !this.nextPart && this.cooldown <= 0) this.cooldown = this.gap;
      }
    }
  }

  /** Short cinematic shots: over the shoulder for counters/specials, on the boss for rage. */
  private cineShot(u: number): void {
    const d = this.def;
    const m = this.model;
    const p = this.host.player;
    const portrait = this.host.cam.camera.aspect < 1;
    const bc = this.bossC.copy(this.mouth);
    if (this.cineKind === 'counter' || this.cineKind === 'special') {
      this.shot.pos.set(p.x + 1.7 - u * 0.7, 1.25 + u * 0.5, 3.4 - u * 1.4);
      this.shot.look.copy(bc);
      this.shot.fov = (portrait ? 68 : 55) - u * 12;
    } else {
      const h = m.height * d.scale;
      const back = (portrait ? 1.35 : 1) * Math.max(10, h * 1.2);
      this.shot.pos.set(this.bossX + 4 - u * 2.5, m.hover * d.scale * 0.6 + 1.8 + u, -d.z + back - u * 4);
      this.shot.look.copy(bc);
      this.shot.fov = portrait ? 62 : 50;
    }
  }

  private introShot(T: number, L: number): void {
    const d = this.def;
    const m = this.model;
    const p = this.host.player;
    const portrait = this.host.cam.camera.aspect < 1;
    const h = m.height * d.scale;
    const bc = this.bossC.set(this.bossX, (m.hover + h * 0.45) * 1, -d.z);
    const cut = L * 0.36;
    if (T < cut) {
      // Low, over the runner's shoulder, looking up at what is arriving.
      const u = T / cut;
      this.shot.pos.set(p.x + 1.7 - u * 0.4, 1.05 + u * 0.3, 2.8 - u * 0.6);
      this.shot.look.copy(bc).y += d.impactAt > T ? 2 : 0;
      this.shot.fov = portrait ? 70 : 58;
    } else {
      // Hero shot of the boss, slowly pushing in.
      if (T - cut < 0.05) this.host.post.glitch(0.6);
      const u = Math.min(1, (T - cut) / (L - cut));
      const back = (portrait ? 1.35 : 1) * Math.max(11, h * 1.4);
      this.shot.pos.set(this.bossX - 5 + u * 2, m.hover * d.scale * 0.6 + 2.2 + u * 0.8, -d.z + back - u * 3.5);
      this.shot.look.copy(bc);
      this.shot.fov = portrait ? 64 : 52;
    }
  }

  private victoryShot(V: number): void {
    const d = this.def;
    const m = this.model;
    const portrait = this.host.cam.camera.aspect < 1;
    const h = m.height * d.scale;
    const bc = this.bossC.set(this.bossX, m.hover + h * 0.4, -d.z);
    const a = -0.7 + Math.min(1, V / 4.4) * 1.1;
    const R = (portrait ? 1.4 : 1) * Math.max(13, h * 1.7);
    this.shot.pos.set(bc.x + Math.sin(a) * R, bc.y * 0.55 + 2.5, bc.z + Math.cos(a) * R);
    this.shot.look.copy(bc);
    this.shot.fov = portrait ? 66 : 55;
  }

  /** Detonations across the boss, building to the core blast. */
  private explosions(dt: number, V: number): void {
    const d = this.def;
    this.nextExplode.t -= dt;
    const m = this.model;
    const h = m.height * d.scale;
    if (V < 2.6 && this.nextExplode.t <= 0) {
      this.nextExplode.t = 0.16 + Math.random() * 0.14;
      events.emit('bossExplode', { x: this.bossX + (Math.random() - 0.5) * h * 0.8, y: m.hover + Math.random() * h * 0.8, z: -d.z + (Math.random() - 0.5) * 3, size: 0.6, color: Math.random() < 0.5 ? d.color : d.accent });
      audio.play('bossHit', 3 + Math.floor(Math.random() * 6));
      this.host.cam.shake(0.25);
    }
    const c = this.mouth;
    if (V >= 1.5 && V - dt < 1.5) {
      events.emit('bossExplode', { x: c.x, y: c.y, z: c.z, size: 1.2, color: d.color });
      audio.play('bossExplode');
      this.host.cam.shake(1);
      this.host.post.flashScreen('#ffffff', 0.5);
      this.host.post.glitch(1.5);
    }
    if (V >= 2.7 && V - dt < 2.7) {
      events.emit('bossExplode', { x: c.x, y: c.y, z: c.z, size: 2, color: '#ffffff' });
      audio.play('bossExplode');
      this.host.cam.shake(1.2);
      this.host.post.flashScreen('#ffffff', 0.8);
    }
  }

  private placeBoss(dt: number, mode: BossMode): void {
    const m = this.model;
    if (!m.root.visible) return;
    const d = this.def;
    const p = this.host.player;
    if (this.state === 'fight' && this.attack?.def.fx !== 'teleport') this.targetX = LANE_X[p.lane] * 0.35;
    this.bossX += (this.targetX - this.bossX) * Math.min(1, dt * 1.5);
    m.root.position.set(this.bossX, m.hover * d.scale, -d.z);
    m.root.scale.setScalar(d.scale);
    const a = this.attack;
    const release = a ? Math.max(0, (a.t - a.firstSpawn) / Math.max(0.3, a.end - a.firstSpawn)) : 0;
    const attackT = a ? (a.t < a.firstSpawn ? a.t / a.firstSpawn : 1 + release) : 0;
    const phases = d.phases.length;
    m.pose({
      dt,
      time: this.time,
      mode,
      introT: this.state === 'intro' ? this.stateT : 99,
      defeatT: this.state === 'defeated' ? this.stateT : this.state === 'victory' ? this.stateT + 1.2 : 0,
      phase: this.phase,
      phases,
      rage: phases > 1 ? this.phase / (phases - 1) : 0,
      hurt: this.hurt,
      attack: a && this.state === 'fight' ? a.def.anim : null,
      attackT,
      playerX: p.x,
      roar: this.roarT > 0 ? 1 - this.roarT : 0,
    });
  }
}
