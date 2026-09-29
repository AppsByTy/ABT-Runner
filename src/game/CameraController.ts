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
  /**
   * Cinematic shot (boss intros / victories): where to put the camera, what to
   * look at, and how much of it to use (0 = normal camera, 1 = the shot).
   */
  readonly shot = { w: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 55 };
  private readonly lookV = new THREE.Vector3();
  /** Shop open: frame the runner in the free screen area above the shop sheet. */
  shopView = false;
  /** Free area for the runner while shopping, as fractions of the screen height (top, bottom). */
  shopBand: [number, number] = [0.08, 0.42];
  private shopBlend = 0;
  /** Smoothed base FOV (speed/aspect), before transient kicks. */
  private fovBase: number = C.fov;
  private fovKick = 0;
  /** Vertical spring for landing dips. */
  private dipY = 0;
  private dipV = 0;
  private roll = 0;
  private prevPlayerX = 0;
  /** 0..1 power-mode intensity (DEBUG / ADMIN / BOOST): lower, wider, livelier. */
  intensity = 0;
  private intensityS = 0;
  /** Current music beat envelope (0..1), for subtle beat-synced bob. */
  beat = 0;
  /** Cinematic beat: 'boss' looks up at the virus, 'power' swings around the runner. */
  private cine: 'boss' | 'power' | null = null;
  private cineT = 0;
  private cineDur = 1;
  private cineW = 0;

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
    // Keep it tasteful: shake is capped and scaled down.
    this.trauma = Math.min(0.85, this.trauma + amount * 0.75);
  }

  /** Short cinematic camera move for major events. */
  cinematic(kind: 'boss' | 'power', duration: number): void {
    this.cine = kind;
    this.cineT = 0;
    this.cineDur = duration;
  }

  update(dt: number, player: PlayerController, speedFactor: number, menu = false): void {
    this.time += dt;
    const k = damp(C.smoothing, dt);
    const tx = player.x * C.followX;
    const ty = player.y * C.followY;
    this.deathBlend += ((player.dead ? 1 : 0) - this.deathBlend) * damp(4, dt);
    this.menuBlend += ((menu ? 1 : 0) - this.menuBlend) * damp(menu ? 3 : 4.5, dt);
    const mb = this.menuBlend * this.menuBlend * (3 - 2 * this.menuBlend); // smoothstep
    this.intensityS += (this.intensity - this.intensityS) * damp(3, dt);
    const it = this.intensityS * (1 - mb);
    // Cinematic envelope: ease in, hold, ease out.
    if (this.cine) {
      this.cineT += dt;
      const u = this.cineT / this.cineDur;
      if (u >= 1) this.cine = null;
      this.cineW = u < 0.25 ? u / 0.25 : u > 0.7 ? Math.max(0, (1 - u) / 0.3) : 1;
      this.cineW = this.cineW * this.cineW * (3 - 2 * this.cineW);
    } else this.cineW = 0;
    const boss = this.cine === 'boss' ? this.cineW : 0;
    const pw = this.cine === 'power' ? this.cineW : 0;
    // Handheld drift: tiny, slow, always on while running.
    const hx = (Math.sin(this.time * 0.9) * 0.6 + Math.sin(this.time * 2.3) * 0.4) * 0.04 * (1 - mb);
    const hy = (Math.sin(this.time * 1.3 + 1) * 0.6 + Math.sin(this.time * 3.1) * 0.4) * 0.03 * (1 - mb);
    // Chase framing (power modes sit lower and tighter; boss intro pulls back and up).
    const cx = tx + C.offset.x + hx + Math.sin(this.cineT * 3.2) * 1.4 * pw;
    const cy = C.offset.y + ty + this.deathBlend * 1.8 - it * 0.25 + hy + boss * 0.9 - pw * 0.5 - this.beat * 0.03 * (0.3 + it);
    const cz = C.offset.z + this.deathBlend * 1.5 - it * 0.3 + boss * 1.6 - pw * 1.1;
    // Menu framing: low, close, slightly off-axis so Ty reads in 3/4 view.
    const portrait = this.aspect < 1;
    const mx = player.x + (portrait ? 0.45 : 0.2);
    const my = portrait ? 1.2 : 1.25;
    this.shopBlend += ((this.shopView ? 1 : 0) - this.shopBlend) * damp(4, dt);
    const sb = this.shopBlend * this.shopBlend * (3 - 2 * this.shopBlend) * mb;
    // Portrait shop: fit Ty (about 1.95 m tall) into the band between the
    // header and the sheet. Distance sets his size; tilting the view down by
    // the band's offset from the screen centre moves him up into it.
    // Landscape: he already stands left of the right-hand sheet.
    let shopZ = 0.5;
    let shopLook = 0.1;
    if (portrait) {
      const T = Math.tan(THREE.MathUtils.degToRad(this.baseFov() * 0.75) / 2);
      const yTop = 1 - 2 * this.shopBand[0];
      const yBot = 1 - 2 * this.shopBand[1];
      const dist = 1.95 / (Math.max(0.2, (yTop - yBot) * 0.84) * T);
      const axis = Math.atan((1.0 - my) / dist) - Math.atan(((yTop + yBot) / 2) * T);
      shopZ = dist - 4.6;
      shopLook = 0.8 - (my + dist * Math.tan(axis));
    }
    const mz = (portrait ? 4.6 : 3.6) + shopZ * sb;
    this.pos.x += (cx + (mx - cx) * mb - this.pos.x) * k;
    this.pos.y += (cy + (my - cy) * mb - this.pos.y) * k;
    this.pos.z = cz + (mz - cz) * mb;
    // Landscape: Ty sits left of centre, leaving room for the start text on the right.
    const lx = tx + (player.x + (portrait ? 0 : 1.15) - tx) * mb;
    const ly = C.lookHeight + ty + ((portrait ? 0.8 : 1.2) - C.lookHeight - ty) * mb - shopLook * sb;
    this.look.x += (lx - this.look.x) * k;
    this.look.y += (ly + boss * 3.4 + pw * 0.4 - this.look.y) * k;
    this.look.z = -C.lookAhead * (1 - mb) * (1 + boss * 1.2);
    // Menu: slow cinematic orbit sway around Ty.
    this.pos.x += Math.sin(this.time * 0.35) * 0.35 * mb * k;

    const targetFov = (this.baseFov() + C.fovSpeedBoost * speedFactor + it * 7 - boss * 6 + pw * 6) * (1 - mb * 0.25);
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
    const dutch = it * Math.sin(this.time * 1.4) * 0.025;
    const targetRoll = player.dead ? 0 : Math.max(-0.06, Math.min(0.06, -vx * 0.004 * (1 + it * 0.6))) * (1 - mb) + dutch;
    this.roll += (targetRoll - this.roll) * damp(10, dt);

    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    this.apply(dt);
  }

  private apply(_dt: number): void {
    const s = this.trauma * this.trauma;
    const t = this.time * 38;
    const ox = s * 0.22 * (Math.sin(t * 1.3) * 0.7 + Math.sin(t * 2.9) * 0.3);
    const oy = s * 0.18 * (Math.sin(t * 1.7 + 1.1) * 0.7 + Math.sin(t * 3.3) * 0.3);
    this.camera.position.set(this.pos.x + ox, this.pos.y + oy + this.dipY, this.pos.z);
    this.lookV.set(this.look.x + ox * 0.5, this.look.y + oy * 0.5 + this.dipY * 0.6, this.look.z);
    const w = this.shot.w;
    if (w > 0.001) {
      const e = w * w * (3 - 2 * w);
      this.camera.position.lerp(this.shot.pos, e);
      this.camera.position.x += ox * e;
      this.camera.position.y += oy * e;
      this.lookV.lerp(this.shot.look, e);
      this.camera.fov += (this.shot.fov - this.camera.fov) * e;
      this.camera.updateProjectionMatrix();
    }
    this.camera.lookAt(this.lookV);
    this.camera.rotation.z += s * 0.035 * Math.sin(t * 0.9) + this.roll * (1 - w);
  }
}
