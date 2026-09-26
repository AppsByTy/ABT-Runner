import * as THREE from 'three';
import { CONFIG } from '../core/Config';
import { damp } from '../utils/math';
import type { PlayerController } from './PlayerController';

const C = CONFIG.camera;

/** Third-person chase camera with smoothing, speed FOV and trauma-based shake. */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private trauma = 0;
  private time = 0;
  private aspect = 1;
  /** 0..1 blend toward the pulled-back death framing. */
  private deathBlend = 0;
  /** 1 = close-up menu framing on the character, 0 = chase camera. */
  private menuBlend = 1;
  /** Smoothed base FOV (speed/aspect), before transient kicks. */
  private fovBase: number = C.fov;
  private fovKick = 0;
  /** Vertical spring for landing dips. */
  private dipY = 0;
  private dipV = 0;
  private roll = 0;
  private prevPlayerX = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(C.fov, aspect, 0.1, 400);
    this.setAspect(aspect);
    this.snap(0, 0);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Portrait screens need a wider vertical FOV so all three lanes stay visible. */
  private baseFov(): number {
    return this.aspect < 1 ? C.fov + (1 - this.aspect) * 30 : C.fov;
  }

  snap(x: number, y: number): void {
    this.pos.set(x * C.followX + C.offset.x, C.offset.y + y * C.followY, C.offset.z);
    this.look.set(x * C.followX, C.lookHeight + y * C.followY, -C.lookAhead);
    this.trauma = 0;
    this.deathBlend = 0;
    this.fovKick = this.dipY = this.dipV = this.roll = 0;
    this.prevPlayerX = x;
    this.apply(0);
  }

  /** Momentary FOV widening in degrees (jumps, near misses, combo level-ups). */
  kickFov(deg: number): void {
    this.fovKick = Math.min(10, this.fovKick + deg);
  }

  /** Downward camera bob (landing, slide start). */
  dip(amount: number): void {
    this.dipV -= amount * 9;
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt: number, player: PlayerController, speedFactor: number, menu = false): void {
    this.time += dt;
    const k = damp(C.smoothing, dt);
    const tx = player.x * C.followX;
    const ty = player.y * C.followY;
    this.deathBlend += ((player.dead ? 1 : 0) - this.deathBlend) * damp(4, dt);
    this.menuBlend += ((menu ? 1 : 0) - this.menuBlend) * damp(menu ? 3 : 4.5, dt);
    const mb = this.menuBlend * this.menuBlend * (3 - 2 * this.menuBlend); // smoothstep
    // Chase framing
    const cx = tx + C.offset.x;
    const cy = C.offset.y + ty + this.deathBlend * 1.8;
    const cz = C.offset.z + this.deathBlend * 1.5;
    // Menu framing: low, close, slightly off-axis so Ty reads in 3/4 view.
    const portrait = this.aspect < 1;
    const mx = player.x + (portrait ? 0.45 : 0.2);
    const my = portrait ? 1.2 : 1.25;
    const mz = portrait ? 4.6 : 3.6;
    this.pos.x += (cx + (mx - cx) * mb - this.pos.x) * k;
    this.pos.y += (cy + (my - cy) * mb - this.pos.y) * k;
    this.pos.z = cz + (mz - cz) * mb;
    // Landscape: Ty sits left of centre, leaving room for the start text on the right.
    const lx = tx + (player.x + (portrait ? 0 : 1.15) - tx) * mb;
    const ly = C.lookHeight + ty + ((portrait ? 0.8 : 1.2) - C.lookHeight - ty) * mb;
    this.look.x += (lx - this.look.x) * k;
    this.look.y += (ly - this.look.y) * k;
    this.look.z = -C.lookAhead * (1 - mb);

    const targetFov = (this.baseFov() + C.fovSpeedBoost * speedFactor) * (1 - mb * 0.25);
    this.fovBase += (targetFov - this.fovBase) * damp(3, dt);
    this.fovKick += (0 - this.fovKick) * damp(5, dt);
    this.camera.fov = this.fovBase + this.fovKick;
    this.camera.updateProjectionMatrix();

    // Critically-damped spring back to rest after a dip.
    const w = 14;
    this.dipV += (-w * w * this.dipY - 2 * w * this.dipV) * dt;
    this.dipY += this.dipV * dt;

    // Roll into lane changes, proportional to lateral velocity.
    const vx = dt > 0 ? (player.x - this.prevPlayerX) / dt : 0;
    this.prevPlayerX = player.x;
    const targetRoll = player.dead ? 0 : Math.max(-0.06, Math.min(0.06, -vx * 0.004)) * (1 - mb);
    this.roll += (targetRoll - this.roll) * damp(10, dt);

    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    this.apply(dt);
  }

  private apply(_dt: number): void {
    const s = this.trauma * this.trauma;
    const t = this.time * 38;
    const ox = s * 0.35 * Math.sin(t * 1.3);
    const oy = s * 0.28 * Math.sin(t * 1.7 + 1.1);
    this.camera.position.set(this.pos.x + ox, this.pos.y + oy + this.dipY, this.pos.z);
    this.camera.lookAt(this.look.x + ox * 0.5, this.look.y + oy * 0.5 + this.dipY * 0.6, this.look.z);
    this.camera.rotation.z += s * 0.05 * Math.sin(t * 0.9) + this.roll;
  }
}
