import * as THREE from 'three';
import { GLSL_HASH, THEME } from '../core/Theme';
import type { MaterialLib } from '../render/MaterialLib';
import { rimify } from '../utils/rim';

/**
 * Base for the boss characters. A model only animates itself from the pose
 * the BossDirector hands it each frame (intro, fight, attack wind-ups, hurt,
 * rage, defeat); the director owns where the boss is and what it does.
 *
 * Every mesh and material is created at startup and kept (hidden) in the
 * scene, so its shader is compiled and drawn once in the menu - nothing is
 * created on the GPU when a boss appears.
 */
export type BossMode = 'hidden' | 'intro' | 'fight' | 'defeat';

export interface BossPose {
  /** Real (unscaled) frame time. */
  dt: number;
  time: number;
  mode: BossMode;
  /** Seconds since the intro / defeat started. */
  introT: number;
  defeatT: number;
  /** 0-based fight phase and how many there are. */
  phase: number;
  phases: number;
  /** 0..1 intensity that rises with the phase (enraged look). */
  rage: number;
  /** 0..1 damage flash. */
  hurt: number;
  /** Attack being wound up / fired, and its progress 0..1 (wind-up) then 1..2 (release). */
  attack: string | null;
  attackT: number;
  /** Runner x (the boss watches you). */
  playerX: number;
  /** Phase change roar, 0..1. */
  roar: number;
}

/** Shared energy shader: fresnel glow, crawling code veins, pulse and damage flash. */
export function energyMaterial(color: THREE.ColorRepresentation, u: BossUniforms, opts: { veins?: number; power?: number } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uHot: u.hot,
      uRage: u.rage,
      uHurt: u.hurt,
      uTime: THEME.uTime,
      uVeins: { value: opts.veins ?? 1 },
      uPower: { value: opts.power ?? 1.6 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uHot; uniform float uRage; uniform float uHurt; uniform float uTime;
      uniform float uVeins; uniform float uPower;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      ${GLSL_HASH}
      void main() {
        float fres = pow(1.0 - abs(dot(vN, vV)), uPower);
        float v = vnoise(vP.xy * 3.0 + vec2(0.0, uTime * 1.5)) * vnoise(vP.yz * 3.2 - uTime * 0.9);
        float veins = smoothstep(0.18, 0.3, v) * uVeins;
        float pulse = 0.75 + 0.25 * sin(uTime * (4.0 + uRage * 8.0));
        vec3 c = uColor * (0.55 + fres * 1.6 + veins * 1.2) * pulse * (1.0 + uHot * 1.5 + uRage * 0.6);
        c = mix(c, vec3(2.2), uHurt * 0.8);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

/** Per-boss uniforms every material of that boss follows. */
export interface BossUniforms {
  /** Overload glow (attacks, defeat). */
  hot: { value: number };
  rage: { value: number };
  hurt: { value: number };
}

export interface Debris {
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
}

export abstract class BossModel {
  readonly root = new THREE.Group();
  /** Weak point: patch beams and hit sparks aim here. */
  readonly core = new THREE.Object3D();
  /** Roughly how tall the boss stands (camera framing). */
  abstract readonly height: number;
  /** Local y the root hovers at in the fight. */
  abstract readonly hover: number;
  readonly u: BossUniforms = { hot: { value: 0 }, rage: { value: 0 }, hurt: { value: 0 } };
  protected readonly lib: MaterialLib;
  private readonly debris: Debris[] = [];
  private readonly armor: THREE.MeshPhysicalMaterial[] = [];
  private readonly armorEmissive: THREE.Color[] = [];
  private broken = false;

  constructor(lib: MaterialLib) {
    this.lib = lib;
    this.root.visible = false;
  }

  /** Dark armour plate: clear-coated metal with a coloured rim light and damage flash. */
  protected armorMaterial(color: THREE.ColorRepresentation, rim: THREE.ColorRepresentation, opts: { rough?: number; emissive?: THREE.ColorRepresentation; rimStrength?: number } = {}): THREE.MeshPhysicalMaterial {
    const m = rimify(
      new THREE.MeshPhysicalMaterial({
        color,
        metalness: 0.88,
        roughness: opts.rough ?? 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.18,
        normalMap: this.lib.brushedNormal,
        normalScale: new THREE.Vector2(0.6, 0.6),
        roughnessMap: this.lib.scratchRough,
        emissive: opts.emissive ?? 0x000000,
        envMapIntensity: 1.2,
      }),
      rim,
      opts.rimStrength ?? 0.9,
      2.4,
      false,
    );
    this.armor.push(m);
    this.armorEmissive.push(new THREE.Color(opts.emissive ?? 0x000000));
    return m;
  }

  protected glow(color: THREE.ColorRepresentation, k = 2): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) });
  }

  /** Big parts that fly apart when the boss is destroyed. */
  protected breakable(...objs: THREE.Object3D[]): void {
    for (const obj of objs) this.debris.push({ obj, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3() });
  }

  protected finish(): void {
    this.root.add(this.core);
    this.root.traverse((o) => {
      o.frustumCulled = false;
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const mat = m.material as THREE.Material;
        m.castShadow = !(mat as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(mat as THREE.ShaderMaterial).isShaderMaterial;
      }
    });
    for (const d of this.debris) {
      d.pos.copy(d.obj.position);
      d.quat.copy(d.obj.quaternion);
      d.scale.copy(d.obj.scale);
    }
  }

  /** Put every part back (a new run, or a repeat of this boss). */
  reset(): void {
    for (const d of this.debris) {
      d.obj.position.copy(d.pos);
      d.obj.quaternion.copy(d.quat);
      d.obj.scale.copy(d.scale);
      d.obj.visible = true;
    }
    this.broken = false;
    this.u.hot.value = this.u.rage.value = this.u.hurt.value = 0;
    this.root.scale.setScalar(1);
    this.root.rotation.set(0, 0, 0);
    this.root.visible = false;
  }

  /** Apply the shared uniforms + armour flash, then the model's own animation. */
  pose(p: BossPose): void {
    this.u.rage.value += (p.rage - this.u.rage.value) * Math.min(1, p.dt * 3);
    this.u.hurt.value = p.hurt;
    const hot = p.mode === 'defeat' ? Math.min(2.5, p.defeatT * 1.2) : p.attack ? Math.min(1, p.attackT) * 0.8 : 0;
    this.u.hot.value += (hot - this.u.hot.value) * Math.min(1, p.dt * 8);
    for (let i = 0; i < this.armor.length; i++) {
      this.armor[i].emissive.copy(this.armorEmissive[i]).multiplyScalar(1 + this.u.rage.value * 1.5).addScalar(p.hurt * 0.9);
    }
    this.animate(p);
    if (p.mode === 'defeat') this.breakUp(p);
  }

  protected abstract animate(p: BossPose): void;

  /** Defeat: shake, then the big parts tear off and tumble away while the core overloads. */
  private breakUp(p: BossPose): void {
    const t = p.defeatT;
    if (t < 1.5) {
      const s = 0.12 + t * 0.12;
      this.root.rotation.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
      return;
    }
    if (!this.broken) {
      this.broken = true;
      for (const d of this.debris) {
        const dir = d.obj.position.clone().normalize();
        if (dir.lengthSq() < 0.01) dir.set(Math.random() - 0.5, 1, Math.random() - 0.5).normalize();
        d.vel.copy(dir).multiplyScalar(5 + Math.random() * 7).add(new THREE.Vector3((Math.random() - 0.5) * 4, 4 + Math.random() * 6, 2 + Math.random() * 4));
        d.spin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
      }
    }
    const dt = p.dt;
    for (const d of this.debris) {
      d.vel.y -= 16 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotation.x += d.spin.x * dt;
      d.obj.rotation.y += d.spin.y * dt;
      d.obj.rotation.z += d.spin.z * dt;
      // Glitch out of existence.
      if (t > 2.6) d.obj.visible = Math.random() > (t - 2.6) * 1.6;
    }
  }
}

/** Chain of segments (tails, cables, tendrils) that sway as one. */
export function chain(segments: THREE.Object3D[], parent: THREE.Object3D, step: THREE.Vector3): THREE.Object3D[] {
  let p = parent;
  for (const s of segments) {
    s.position.copy(step);
    p.add(s);
    p = s;
  }
  segments[0].position.set(0, 0, 0);
  return segments;
}
