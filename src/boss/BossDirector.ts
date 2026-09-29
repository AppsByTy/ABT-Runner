import * as THREE from 'three';
import { audio } from '../audio/AudioManager';
import { LANE_X } from '../core/Config';
import { events } from '../core/EventBus';
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
import { LaneWarnings, type WarnKind } from './LaneWarnings';

/**
 * Boss encounters, layered on the normal run (the game itself stays in its
 * "playing" state, so pause, death, restart and game over work unchanged).
 *
 *   RUNNING -> WARNING -> BOSS_INTRO -> BOSS_FIGHT -> BOSS_DEFEATED
 *           -> VICTORY_CINEMATIC -> NEXT_LEVEL -> RUNNING
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
  end: number;
  hitsAtStart: number;
  judged: boolean;
}

const WARN_FOR = { low: 'jump', high: 'slide', wall: 'move' } as const;
const DODGE_DMG = 5;
const PATCH_DMG = 12;

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
        audio.setBoss(true);
        audio.play('bossRiser');
        events.emit('bossStart', { name: this.name, index: this.index });
        break;
      }
      case 'fight':
        h.hud.bossCine(false);
        h.hud.bossBar({ name: this.name, color: d.color, phases: d.phases.map((p) => p.at) });
        h.hud.bossHp(1, 0);
        h.hud.banner('FIGHT!', 'COLLECT GOLD PATCHES TO DAMAGE IT', 'gold', 1.6);
        this.cooldown = 0.6;
        this.attack = null;
        events.emit('bossActive');
        break;
      case 'defeated': {
        this.attack = null;
        this.warnings.clear();
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
        // Hit-stop at a phase change.
        scaleTarget = this.hitStop > 0 ? 0.08 : 1;
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
    const d = this.def;
    this.shift = Math.max(0, this.shift - dt);
    const a = this.attack;
    if (a) {
      a.t += dt;
      for (const r of a.rows) {
        if (!r.shown && a.t >= r.teleAt) this.telegraph(r);
        if (!r.spawned && a.t >= r.spawnAt) this.spawnRow(r);
      }
      // Perfect dodge: got through the whole attack without a hit.
      const lastArrive = a.rows.reduce((m, r) => Math.max(m, r.arriveAt), 0);
      if (!a.judged && a.t > lastArrive + 0.35) {
        a.judged = true;
        if (this.host.hits() === a.hitsAtStart) {
          this.host.hud.popup(`PERFECT DODGE · -${DODGE_DMG} HP`, 'cyan', true);
          this.damage(DODGE_DMG, 'dodge');
        }
        this.patchWindow(a);
      }
      if (a.t >= a.end) {
        this.attack = null;
        this.cooldown = Math.max(0.7, d.gap - this.phase * 0.35 - Math.min(0.5, this.cycle * 0.15));
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

  private startAttack(): void {
    const d = this.def;
    const pool = d.phases[this.phase].attacks;
    let id = this.rng.pick(pool);
    if (id === this.lastAttack && pool.length > 1) id = this.rng.pick(pool.filter((x) => x !== id));
    this.lastAttack = id;
    const def = d.attacks[id];
    const rows = def.rows({ rng: this.rng, phase: this.phase, lane: this.host.player.lane, color: d.color });
    const lead = this.lead;
    const tele = this.tele;
    const first = 0.35 + tele + lead;
    const live: LiveRow[] = rows.map((r) => ({ ...r, arriveAt: first + r.at, spawnAt: first + r.at - lead, teleAt: first + r.at - lead - tele, dist: 0, shown: false, spawned: false }));
    const lastArrive = live.reduce((m, r) => Math.max(m, r.arriveAt), 0);
    this.attack = { id, def, rows: live, t: 0, firstSpawn: first - lead, end: lastArrive + 0.9, hitsAtStart: this.host.hits(), judged: false };
    if (!this.called.has(id)) {
      this.called.add(id);
      this.host.hud.hint(def.call);
    }
    if (def.fx === 'teleport') {
      this.targetX = this.bossX = LANE_X[this.rng.int(0, 2)] * 0.9;
      this.host.post.glitch(1);
      audio.play('error');
    } else if (def.fx === 'bluescreen') {
      this.blueT = lastArrive + 0.5;
      this.host.post.flashScreen('#2a6bff', 0.5);
    } else if (def.fx === 'glitch') this.host.post.glitch(1.4);
    audio.play('bossTelegraph');
  }

  private telegraph(r: LiveRow): void {
    const h = this.host;
    r.shown = true;
    r.dist = h.distance() + h.speed() * (r.spawnAt - r.teleAt + this.lead);
    const warn: WarnKind = WARN_FOR[KIND_CLASS[r.kind]];
    for (const l of r.lanes) this.warnings.show(l, r.dist, warn);
  }

  private spawnRow(r: LiveRow): void {
    const h = this.host;
    r.spawned = true;
    if (!r.shown) this.telegraph(r);
    for (const l of r.lanes) h.obstacles.spawn(r.kind, l, r.dist, { materialize: true, depth: r.depth, variant: this.rng.int(0, 3), color: this.def.color });
  }

  /** Gold patches (the way to hurt the boss) in lanes the last hazards left open. */
  private patchWindow(a: LiveAttack): void {
    const h = this.host;
    const last = a.rows[a.rows.length - 1];
    const open = [0, 1, 2].filter((l) => !last.lanes.includes(l) || KIND_CLASS[last.kind] !== 'wall');
    const n = this.phase === 0 ? 2 : this.rng.chance(0.55) ? 2 : 1;
    const base = h.distance() + h.speed() * 1.35;
    let lane = open.includes(h.player.lane) ? h.player.lane : this.rng.pick(open);
    for (let i = 0; i < n; i++) {
      const at = base + i * h.speed() * 0.55;
      h.pickups.spawn('bossPatch', lane, at, 1.0);
      for (let c = 1; c <= 3; c++) h.pickups.spawn('coin', lane, at - c * 2.3);
      const next = [lane - 1, lane + 1].filter((l) => l >= 0 && l <= 2);
      lane = this.rng.chance(0.5) ? lane : this.rng.pick(next);
    }
  }

  /** A security patch reached the boss. */
  patch(): void {
    this.damage(PATCH_DMG, 'patch');
  }

  damage(n: number, kind: 'patch' | 'dodge'): void {
    if (this.state !== 'fight' || this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - n);
    this.hurt = 1;
    const at = this.mouth;
    events.emit('bossHit', { dmg: n, hp: this.hp, max: this.maxHp, kind, x: at.x, y: at.y, z: at.z });
    audio.play('bossHit', kind === 'patch' ? 0 : 5);
    const frac = this.hp / this.maxHp;
    const phases = this.def.phases;
    if (this.phase + 1 < phases.length && frac <= phases[this.phase + 1].at && this.hp > 0) {
      this.phase++;
      this.shift = 2.2;
      this.roarT = 1;
      this.hitStop = 0.4;
      const p = phases[this.phase];
      const last = this.phase === phases.length - 1;
      this.host.hud.banner(last ? `${p.label}!` : `PHASE ${this.phase + 1}`, last ? 'FINAL PHASE · IT GETS FASTER' : p.label, last ? 'red' : 'orange', 2.0);
      this.host.cam.shake(0.8);
      this.host.post.glitch(1.4);
      this.host.post.flashScreen(this.def.color, 0.5);
      audio.play('bossRoar');
      events.emit('bossPhase', { phase: this.phase, label: p.label, x: at.x, y: at.y, z: at.z });
    }
    this.host.hud.bossHp(frac, this.phase);
    if (this.hp <= 0) this.enter('defeated');
  }

  // ------------------------------------------------------------ cinematics

  private readonly bossC = new THREE.Vector3();

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
