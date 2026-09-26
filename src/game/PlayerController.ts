import * as THREE from 'three';
import { CONFIG, LANE_X } from '../core/Config';
import { events } from '../core/EventBus';
import { clamp, damp, type AABB } from '../utils/math';
import { Character } from './Character';
import type { MaterialLib } from '../render/MaterialLib';

const P = CONFIG.player;

/**
 * 3-lane runner controller. The player stays at z = 0; the world scrolls.
 * Owns lane/jump/slide physics; visuals are delegated to the Character rig.
 */
export class PlayerController {
  readonly root = new THREE.Group();
  readonly character: Character;
  /** Shadow lives outside root so it stays on the ground while jumping. */
  readonly shadowRoot = new THREE.Group();

  lane = 1;
  prevLane = 1;
  x = 0;
  prevX = 0;
  y = 0;
  vy = 0;
  grounded = true;
  sliding = false;
  dead = false;
  /** Seconds since the player last left each lane (for dodge detection). */
  readonly laneLeftAt = [-99, -99, -99];
  /** Clock time of the last jump / slide start (for near-miss timing). */
  lastJumpAt = -99;
  lastSlideAt = -99;

  private slideTimer = 0;
  private jumpBufferTimer = 0;
  private fastFalling = false;
  private slideQueuedOnLand = false;
  /** Invulnerability frames after a hit. */
  private invuln = 0;
  private graceOnly = false;
  private stumbleFx = 0;
  /** Multiplier on lane change time (RAM BOOST makes it snappier). */
  laneFactor = 1;
  private currentGravity: number = P.gravity;
  private clock = 0;
  private readonly shadow: THREE.Mesh;

  constructor(lib: MaterialLib) {
    this.character = new Character(lib);
    this.root.add(this.character.root);

    // Blob shadow (cheap, readable depth cue for jumps).
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,0.7)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.2, 1.5),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.shadowRoot.add(this.shadow);
  }

  reset(): void {
    this.lane = this.prevLane = 1;
    this.x = this.prevX = LANE_X[1];
    this.y = 0;
    this.vy = 0;
    this.grounded = true;
    this.sliding = false;
    this.dead = false;
    this.slideTimer = 0;
    this.jumpBufferTimer = 0;
    this.fastFalling = false;
    this.slideQueuedOnLand = false;
    this.invuln = 0;
    this.stumbleFx = 0;
    this.laneFactor = 1;
    this.clock = 0;
    this.laneLeftAt.fill(-99);
    this.lastJumpAt = this.lastSlideAt = -99;
    this.character.reset();
    this.syncTransform();
  }

  // ---------------------------------------------------------------- actions

  moveLane(dir: -1 | 1): void {
    if (this.dead) return;
    const target = clamp(this.lane + dir, 0, LANE_X.length - 1);
    if (target === this.lane) return;
    this.laneLeftAt[this.lane] = this.clock;
    this.prevLane = this.lane;
    this.lane = target;
    events.emit('laneChange', { dir, lane: target });
  }

  jump(): void {
    if (this.dead) return;
    if (this.grounded) this.doJump();
    else this.jumpBufferTimer = P.jumpBuffer;
  }

  slide(): void {
    if (this.dead) return;
    if (!this.grounded) {
      // Air slide = slam down, then slide on landing.
      this.fastFalling = true;
      this.vy = Math.min(this.vy, P.fastFallVelocity);
      this.slideQueuedOnLand = true;
      this.jumpBufferTimer = 0;
      return;
    }
    this.startSlide();
  }

  /**
   * Took a hit: stagger and become briefly invulnerable. With `bounce`,
   * return to the lane we came from (we clipped something while moving into
   * its lane); otherwise keep going.
   */
  stumble(bounce: boolean): void {
    this.invuln = P.hitInvuln;
    this.graceOnly = false;
    this.stumbleFx = 1;
    if (bounce) {
      const back = this.prevLane;
      this.prevLane = this.lane;
      this.lane = back;
      this.x = this.prevX;
    }
  }

  /** True while travelling between lanes. */
  get changingLane(): boolean {
    return Math.abs(LANE_X[this.lane] - this.x) > 0.08;
  }

  /** Short invulnerability window (e.g. when an invincible power-up ends). */
  grace(seconds: number): void {
    this.invuln = Math.max(this.invuln, seconds);
    this.graceOnly = true;
  }

  get invulnerable(): boolean {
    return this.invuln > 0;
  }

  get time(): number {
    return this.clock;
  }

  kill(): void {
    this.dead = true;
    this.sliding = false;
  }

  // ---------------------------------------------------------------- update

  private doJump(): void {
    if (this.sliding) this.endSlide();
    // v = sqrt(2 g h): constant apex regardless of the current gravity scale.
    this.vy = Math.sqrt(2 * this.currentGravity * P.jumpHeight);
    this.grounded = false;
    this.fastFalling = false;
    this.lastJumpAt = this.clock;
    events.emit('jump');
  }

  private startSlide(): void {
    if (!this.sliding) {
      this.lastSlideAt = this.clock;
      events.emit('slideStart');
    }
    this.sliding = true;
    this.slideTimer = P.slideDuration;
  }

  private endSlide(): void {
    if (!this.sliding) return;
    this.sliding = false;
    this.slideTimer = 0;
    events.emit('slideEnd');
  }

  /** Fixed-step simulation. speedFactor is 0..1 (start..max speed). */
  step(dt: number, speedFactor: number): void {
    this.currentGravity = P.gravity * (1 + P.gravitySpeedScale * speedFactor);
    this.prevX = this.x;
    this.clock += dt;

    if (this.dead) return;

    if (this.invuln > 0) this.invuln -= dt;

    // Lane movement: exponential approach, then snap.
    const tx = LANE_X[this.lane];
    this.x += (tx - this.x) * damp(1 / (P.laneChangeTime * this.laneFactor), dt);
    if (Math.abs(tx - this.x) < 0.005) this.x = tx;

    // Vertical
    if (!this.grounded) {
      this.vy -= this.currentGravity * (this.fastFalling ? 1.6 : 1) * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.vy = 0;
        this.grounded = true;
        this.fastFalling = false;
        this.character.land();
        events.emit('land');
        if (this.jumpBufferTimer > 0) {
          this.jumpBufferTimer = 0;
          this.doJump();
        } else if (this.slideQueuedOnLand) {
          this.startSlide();
        }
        this.slideQueuedOnLand = false;
      }
    }
    if (this.jumpBufferTimer > 0) this.jumpBufferTimer -= dt;

    if (this.sliding) {
      this.slideTimer -= dt;
      if (this.slideTimer <= 0) this.endSlide();
    }
  }

  getCollider(out: AABB, useX = this.x): AABB {
    const h = this.sliding ? P.slideHeight : P.height;
    out.minX = useX - P.width / 2;
    out.maxX = useX + P.width / 2;
    out.minY = this.y;
    out.maxY = this.y + h;
    out.minZ = -P.depth / 2;
    out.maxZ = P.depth / 2;
    return out;
  }

  /** Render-rate animation. */
  animate(dt: number, speed: number, running: boolean, idle: boolean): void {
    this.stumbleFx = Math.max(0, this.stumbleFx - dt * 2.6);
    this.character.update({
      dt,
      speed,
      running,
      grounded: this.grounded,
      vy: this.vy,
      sliding: this.sliding,
      laneOffset: LANE_X[this.lane] - this.x,
      stumble: this.stumbleFx,
      dead: this.dead,
      idle,
    });
    // Flicker while invulnerable after a hit.
    this.character.root.visible = !(this.invuln > 0 && !this.graceOnly && Math.floor(this.invuln * 16) % 2 === 0);
    this.syncTransform();
  }

  private syncTransform(): void {
    this.root.position.set(this.x, this.y, 0);
    this.shadowRoot.position.set(this.x, 0, 0);
    const k = clamp(1 - this.y / 4, 0.35, 1);
    this.shadow.scale.setScalar(k);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = k;
  }
}
