import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CHARACTER_RIM } from '../utils/toon';
import { rimify } from '../utils/rim';
import { canvasTexture } from '../utils/textures';
import { damp, clamp } from '../utils/math';
import type { MaterialLib } from '../render/MaterialLib';
import { OUTFIT, type ModelAvatar } from './ModelAvatar';

/**
 * "Ty" – the AppsByTy developer. Fully procedural, but built like a modern
 * stylised game character: realistic proportions, smooth tapered limbs,
 * PBR fabric (sheen + weave normals), knit sneakers with sculpted soles,
 * strand hair, a real face, and spring-driven secondary motion.
 */

export interface AnimInput {
  dt: number;
  speed: number;
  running: boolean;
  grounded: boolean;
  vy: number;
  sliding: boolean;
  /** Signed distance to the target lane centre (drives lean). */
  laneOffset: number;
  stumble: number;
  dead: boolean;
  idle: boolean;
}

/** Fight moves (boss combat). Purely visual: the hitbox never moves. */
export type Trick = 'punch' | 'kick' | 'spinL' | 'spinR' | 'flip' | 'sweep' | 'finisher';
const TRICK_DUR: Record<Trick, number> = { punch: 0.3, kick: 0.4, spinL: 0.5, spinR: 0.5, flip: 0.62, sweep: 0.5, finisher: 0.85 };
/** Height of the flip/spin pivot (about the hips). */
const PIVOT = 0.95;
const ease = (u: number): number => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

type JointName =
  | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'thighL' | 'thighR' | 'kneeL' | 'kneeR' | 'footL' | 'footR'
  | 'shoulderL' | 'shoulderR' | 'elbowL' | 'elbowR' | 'handL' | 'handR';

const JOINTS: readonly JointName[] = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'thighL', 'thighR', 'kneeL', 'kneeR', 'footL', 'footR',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'handL', 'handR',
];

const C = {
  skin: 0x6a3a22,
  hoodie: 0x96dc14,
  hoodieDeep: 0x7fbf10,
  pants: 0x121216,
  pocket: 0x1b1b22,
  knit: 0xff2fb4,
  sole: 0xd8ff5a,
  lime: 0xb4ff1e,
  magenta: 0xff2bd6,
  black: 0x0b0b0e,
};

const LID_OPEN = -0.3;
const LID_CLOSED = Math.PI / 2;

// ------------------------------------------------------------ geometry kit

/** Tapered capsule hanging down from the joint: radius r0 at the top, r1 at the bottom. */
function limb(r0: number, r1: number, len: number, flatten = 1, seg = 16): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(r0, r1, len, seg, 6, true).translate(0, -len / 2, 0);
  const top = new THREE.SphereGeometry(r0, seg, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const bottom = new THREE.SphereGeometry(r1, seg, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).translate(0, -len, 0);
  const g = mergeGeometries([body.toNonIndexed(), top.toNonIndexed(), bottom.toNonIndexed()])!;
  g.scale(1, 1, flatten);
  return g;
}

/** Soft fabric folds: low-frequency displacement along normals. */
function wrinkle(geo: THREE.BufferGeometry, amp: number, freq = 18, seed = 1): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    const w = Math.sin(v.y * freq + Math.sin(v.x * 9 + seed) * 2) * Math.cos(v.x * freq * 0.6 + v.z * 7 + seed) * amp;
    v.addScaledVector(n, w);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Smooth merged normals for a non-indexed mesh (hides seams between parts). */
function smooth(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.computeVertexNormals();
  return geo;
}

function logoTexture(withText: boolean): THREE.CanvasTexture {
  return canvasTexture(512, withText ? 400 : 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const top = withText ? 30 : 70;
    const bottom = withText ? 250 : 440;
    const span = bottom - top;
    const half = span * 0.62;
    ctx.fillStyle = '#0b0b0f';
    ctx.beginPath();
    ctx.moveTo(cx - 34, top);
    ctx.lineTo(cx + 22, top);
    ctx.lineTo(cx - half + span * 0.42, bottom);
    ctx.lineTo(cx - half, bottom);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + 8, top + span * 0.06);
    ctx.lineTo(cx + 40, top + span * 0.06);
    ctx.lineTo(cx + half, bottom);
    ctx.lineTo(cx + half - span * 0.22, bottom);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(cx - half * 0.3, top + span * 0.6, half * 1.15, span * 0.13);
    if (withText) {
      ctx.font = '800 76px "Chakra Petch", "Segoe UI", system-ui, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AppsByTy', cx, 330);
    }
  });
}

/** Messy strand hair: tapered tubes with neon-tipped vertex colours. */
function hairGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let seed = 9;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const root = new THREE.Color(0x0c0b10);
  const tips = [new THREE.Color(0x14121a), new THREE.Color(C.lime).multiplyScalar(1.1), new THREE.Color(C.magenta)];
  const center = new THREE.Vector3(0, 0.13, 0.01);
  const TUB = 8;
  const RAD = 5;
  for (let i = 0; i < 74; i++) {
    const theta = rnd() * Math.PI * 2;
    const phi = Math.pow(rnd(), 0.8) * 1.3;
    const dir = new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
    if (dir.z < -0.5 && dir.y < 0.55) continue; // keep the face clear
    const base = center.clone().addScaledVector(dir, 0.1);
    const len = 0.1 + rnd() * 0.12;
    // Swept back and up, with a messy kink.
    const sweep = new THREE.Vector3((rnd() - 0.5) * 0.08, 0.05 + rnd() * 0.05, 0.06 + rnd() * 0.05);
    const p1 = base.clone().addScaledVector(dir, len * 0.45).add(sweep.clone().multiplyScalar(0.4));
    const p2 = base.clone().addScaledVector(dir, len * 0.8).add(sweep).add(new THREE.Vector3((rnd() - 0.5) * 0.05, (rnd() - 0.3) * 0.05, (rnd() - 0.5) * 0.04));
    const p3 = p2.clone().addScaledVector(dir, len * 0.3).add(sweep.clone().multiplyScalar(0.5));
    const curve = new THREE.CatmullRomCurve3([base, p1, p2, p3]);
    const r = 0.018 + rnd() * 0.014;
    const tube = new THREE.TubeGeometry(curve, TUB, r, RAD, false);
    const pos = tube.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const tip = rnd() < 0.62 ? tips[0] : tips[1 + Math.floor(rnd() * 2)];
    const tmp = new THREE.Color();
    const c = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let a = 0; a <= TUB; a++) {
      const t = a / TUB;
      curve.getPointAt(t, c);
      const k = 1 - t * 0.92;
      tmp.copy(root).lerp(tip, Math.pow(t, 1.8));
      for (let b = 0; b <= RAD; b++) {
        const idx = a * (RAD + 1) + b;
        v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(k).add(c);
        pos.setXYZ(idx, v.x, v.y, v.z);
        tmp.toArray(colors, idx * 3);
      }
    }
    tube.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    tube.deleteAttribute('uv');
    parts.push(tube.index ? tube.toNonIndexed() : tube);
  }
  // Scalp cap.
  const cap = new THREE.SphereGeometry(0.108, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1, 1.08, 1.07).translate(0, 0.125, 0.012);
  const capN = cap.toNonIndexed();
  capN.deleteAttribute('uv');
  const cc = new Float32Array(capN.getAttribute('position').count * 3);
  for (let i = 0; i < cc.length / 3; i++) root.toArray(cc, i * 3);
  capN.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  parts.push(capN);
  return mergeGeometries(parts)!;
}

/** Sneaker sole: side profile with toe spring, extruded with a bevel. */
function soleGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  // (z forward = -z in rig, drawn here in x) length 0.31, height ~0.055
  s.moveTo(-0.17, 0.03);
  s.quadraticCurveTo(-0.185, 0.0, -0.15, -0.01);
  s.lineTo(0.1, -0.012);
  s.quadraticCurveTo(0.14, -0.01, 0.145, 0.03);
  s.lineTo(0.14, 0.05);
  s.lineTo(-0.15, 0.045);
  s.quadraticCurveTo(-0.175, 0.045, -0.17, 0.03);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 3, curveSegments: 10 });
  g.translate(0, 0, -0.05);
  g.rotateY(Math.PI / 2); // profile x -> rig z
  return g;
}

// ---------------------------------------------------------------- springs

class Spring {
  v = 0;
  x = 0;
  private readonly k: number;
  private readonly d: number;
  constructor(k: number, d: number) {
    this.k = k;
    this.d = d;
  }
  step(target: number, dt: number): number {
    const a = (target - this.x) * this.k - this.v * this.d;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

// -------------------------------------------------------------- character

export class Character {
  readonly root = new THREE.Group();
  private readonly yaw = new THREE.Group();
  private readonly body = new THREE.Group();
  /** Trick pivot (flips and spins turn about the hips) and its counter-offset. */
  private readonly trickG = new THREE.Group();
  private readonly trickIn = new THREE.Group();
  private trickKind: Trick | null = null;
  private trickT = 0;
  private trickDur = 1;
  private trickSide = 1;
  private readonly j = {} as Record<JointName, THREE.Group>;
  private readonly laptop = new THREE.Group();
  private readonly laptopLid = new THREE.Group();
  private readonly hood = new THREE.Group();
  private readonly hair = new THREE.Group();
  private readonly strings: THREE.Group[] = [];
  private readonly chain = new THREE.Group();

  private phase = 0;
  private time = 0;
  private w = { run: 0, air: 0, slide: 0, idle: 1 };
  private deathT = 0;
  private turn = 1;
  private laptopT = 1;
  private lastStepSide = 0;
  private landKick = 0;
  private reactT = 0;
  private reactDir = 0;
  private prevVy = 0;
  private prevLane = 0;
  private readonly T = new Map<JointName, THREE.Vector3>(JOINTS.map((n) => [n, new THREE.Vector3()]));
  private readonly springs = {
    hood: new Spring(90, 9),
    hair: new Spring(140, 10),
    hairSide: new Spring(120, 9),
    strings: new Spring(60, 5),
    stringsSide: new Spring(50, 4),
    chain: new Spring(45, 4),
  };
  private readonly tmpColor = new THREE.Color();

  onFootstep: (side: 0 | 1) => void = () => {};
  /** Sculpted 3D model driven by this rig (replaces the procedural meshes once loaded). */
  private avatar: ModelAvatar | null = null;

  /** Swap the procedural body for the real 3D model; the procedural rig keeps driving it. */
  attachModel(av: ModelAvatar): void {
    this.body.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) o.visible = false;
    });
    this.avatar = av;
    this.body.add(av.root);
  }

  get hasModel(): boolean {
    return this.avatar !== null;
  }

  /** Procedural-body materials an outfit repaints (fallback when the model can't load). */
  private readonly outfitMats: { hoodie: THREE.MeshPhysicalMaterial; rib: THREE.MeshPhysicalMaterial; knit: THREE.MeshPhysicalMaterial };

  /**
   * Shop outfit: hoodie + accent colours, null = the original colours.
   * Only uniforms / material colours change, so no shader is ever rebuilt.
   */
  applyOutfit(hoodie: string | null, accent: string | null): void {
    OUTFIT.hoodieOn.value = hoodie ? 1 : 0;
    OUTFIT.accentOn.value = accent ? 1 : 0;
    if (hoodie) OUTFIT.hoodie.value.set(hoodie);
    if (accent) OUTFIT.accent.value.set(accent);
    const m = this.outfitMats;
    m.hoodie.color.set(hoodie ?? C.hoodie);
    m.rib.color.set(hoodie ?? C.hoodieDeep);
    if (hoodie) m.rib.color.multiplyScalar(0.8);
    m.knit.color.set(accent ?? C.knit);
  }

  constructor(lib: MaterialLib) {
    const phys = (p: THREE.MeshPhysicalMaterialParameters, rim: THREE.ColorRepresentation, rs: number, rp = 3): THREE.MeshPhysicalMaterial =>
      rimify(new THREE.MeshPhysicalMaterial(p), rim, rs, rp);
    const fabricN = lib.fabricNormal.clone();
    fabricN.repeat.set(14, 14);
    fabricN.needsUpdate = true;
    const ribN = lib.ribNormal.clone();
    ribN.repeat.set(10, 1);
    ribN.needsUpdate = true;
    const m = {
      skin: phys({ color: C.skin, roughness: 0.52, sheen: 0.4, sheenColor: new THREE.Color(0xffb08a), sheenRoughness: 0.6, clearcoat: 0.08 }, C.magenta, 0.25),
      hoodie: phys({
        color: C.hoodie, roughness: 0.84, sheen: 0.6, sheenColor: new THREE.Color(0xd8ff8a), sheenRoughness: 0.45,
        normalMap: fabricN, normalScale: new THREE.Vector2(0.5, 0.5), emissive: 0x3a6a00, emissiveIntensity: 0.18,
      }, C.magenta, 0.35),
      rib: phys({ color: C.hoodieDeep, roughness: 0.85, sheen: 0.8, sheenColor: new THREE.Color(0xd8ff80), normalMap: ribN, normalScale: new THREE.Vector2(0.8, 0.8) }, C.magenta, 0.2),
      pants: phys({
        color: C.pants, roughness: 0.78, sheen: 0.7, sheenColor: new THREE.Color(0x5a6070), sheenRoughness: 0.5,
        normalMap: fabricN, normalScale: new THREE.Vector2(0.7, 0.7),
      }, C.lime, 0.55, 2.6),
      pocket: phys({ color: C.pocket, roughness: 0.8, sheen: 0.6, sheenColor: new THREE.Color(0x505866), normalMap: fabricN }, C.magenta, 0.3),
      knit: phys({
        color: C.knit, roughness: 0.62, sheen: 0.8, sheenColor: new THREE.Color(0xffa0e0), normalMap: lib.meshNormal, normalScale: new THREE.Vector2(0.9, 0.9),
        emissive: 0x80104f, emissiveIntensity: 0.22,
      }, C.lime, 0.4),
      sole: phys({ color: C.sole, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2, emissive: C.lime, emissiveIntensity: 0.35 }, C.lime, 0.2),
      black: phys({ color: C.black, roughness: 0.45, metalness: 0.2, clearcoat: 0.3 }, C.magenta, 0.3),
      hair: phys({ color: 0xffffff, vertexColors: true, roughness: 0.32, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.25, sheen: 0.6, sheenColor: new THREE.Color(0x8888aa) }, C.magenta, 0.35, 2.4),
      chrome: lib.chrome,
      sclera: new THREE.MeshPhysicalMaterial({ color: 0xf2eee8, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 }),
      iris: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3cf0).multiplyScalar(1.8) }),
      pupil: new THREE.MeshBasicMaterial({ color: 0x050005 }),
      glint: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.5, 2.5) }),
      lip: phys({ color: 0x4a2418, roughness: 0.4, clearcoat: 0.3 }, C.magenta, 0.1),
      brow: new THREE.MeshStandardMaterial({ color: 0x0a0808, roughness: 0.8 }),
      glowLime: new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(1.6) }),
      glowPink: new THREE.MeshBasicMaterial({ color: new THREE.Color(C.magenta).multiplyScalar(1.8) }),
      air: new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, roughness: 0.05, clearcoat: 1, emissive: C.magenta, emissiveIntensity: 1.2 }),
      logoFront: new THREE.MeshPhysicalMaterial({ map: logoTexture(true), transparent: true, roughness: 0.6, sheen: 0.3, polygonOffset: true, polygonOffsetFactor: -2 }),
      logoBack: new THREE.MeshPhysicalMaterial({ map: logoTexture(false), transparent: true, roughness: 0.6, sheen: 0.3, polygonOffset: true, polygonOffsetFactor: -2 }),
    };

    this.outfitMats = { hoodie: m.hoodie, rib: m.rib, knit: m.knit };

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
      const me = new THREE.Mesh(geo, mat);
      me.position.set(x, y, z);
      me.castShadow = true;
      return me;
    };
    const joint = (name: JointName, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group => {
      const g = new THREE.Group();
      g.name = name;
      g.position.set(x, y, z);
      parent.add(g);
      this.j[name] = g;
      return g;
    };

    this.root.add(this.yaw);
    this.yaw.add(this.trickG);
    this.trickG.position.y = PIVOT;
    this.trickIn.position.y = -PIVOT;
    this.trickG.add(this.trickIn);
    this.trickIn.add(this.body);

    // ------------------------------------------------------------ pelvis & legs
    const hips = joint('hips', this.body, 0, 0.99, 0);
    hips.add(mesh(smooth(new THREE.SphereGeometry(0.17, 20, 12).scale(1.05, 0.62, 0.78)), m.pants, 0, 0.0, 0.01));
    hips.add(mesh(new THREE.TorusGeometry(0.165, 0.022, 8, 28).rotateX(Math.PI / 2).scale(1.05, 1, 0.8), m.rib, 0, 0.1, 0.01)); // waistband
    // Wallet chain: linked chrome loops from the front pocket to the back.
    {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-0.16, 0.06, -0.09),
        new THREE.Vector3(-0.2, -0.1, -0.04),
        new THREE.Vector3(-0.19, -0.16, 0.06),
        new THREE.Vector3(-0.14, 0.04, 0.12),
      ]);
      const links: THREE.BufferGeometry[] = [];
      const pt = new THREE.Vector3();
      const tan = new THREE.Vector3();
      for (let i = 0; i < 22; i++) {
        const t = i / 21;
        curve.getPointAt(t, pt);
        curve.getTangentAt(t, tan);
        const l = new THREE.TorusGeometry(0.011, 0.0035, 5, 10);
        l.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tan));
        l.translate(pt.x, pt.y, pt.z);
        links.push(l);
      }
      this.chain.add(mesh(mergeGeometries(links)!, m.chrome));
      hips.add(this.chain);
    }

    for (const side of [-1, 1] as const) {
      const L = side < 0 ? 'L' : 'R';
      const thigh = joint(`thigh${L}` as JointName, hips, side * 0.1, -0.03, 0);
      thigh.add(mesh(wrinkle(limb(0.098, 0.082, 0.43, 0.95), 0.006, 22, side), m.pants));
      // Cargo pocket with flap + button, and neon piping down the outseam.
      const pocket = mesh(new RoundedBoxGeometry(0.035, 0.14, 0.13, 3, 0.012), m.pocket, side * 0.094, -0.25, 0);
      pocket.add(mesh(new RoundedBoxGeometry(0.04, 0.035, 0.135, 2, 0.01), m.pocket, side * 0.003, 0.07, 0));
      pocket.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.006, 10).rotateZ(Math.PI / 2), m.chrome, side * 0.022, 0.06, 0));
      thigh.add(pocket);
      thigh.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.4, 5), m.glowPink, side * 0.092, -0.2, 0.045));
      const knee = joint(`knee${L}` as JointName, thigh, 0, -0.43, 0);
      knee.add(mesh(wrinkle(limb(0.08, 0.066, 0.4, 0.95), 0.005, 26, side + 3), m.pants));
      knee.add(mesh(new THREE.TorusGeometry(0.063, 0.018, 8, 24).rotateX(Math.PI / 2), m.black, 0, -0.39, 0)); // cuff
      knee.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.34, 5), m.glowPink, side * 0.076, -0.18, 0.03));

      // Sneaker.
      const foot = joint(`foot${L}` as JointName, knee, 0, -0.42, 0);
      const sole = mesh(soleGeometry(), m.sole, 0, -0.075, -0.035);
      foot.add(sole);
      const upper = mesh(
        smooth(mergeGeometries([
          new THREE.SphereGeometry(0.06, 18, 12).scale(0.95, 0.75, 2.1).translate(0, -0.02, -0.07).toNonIndexed(),
          new THREE.CylinderGeometry(0.058, 0.062, 0.1, 18).translate(0, 0.0, 0.02).toNonIndexed(),
        ])!),
        m.knit,
      );
      foot.add(upper);
      foot.add(mesh(new THREE.TorusGeometry(0.056, 0.014, 8, 20).rotateX(Math.PI / 2), m.black, 0, 0.05, 0.02)); // collar
      foot.add(mesh(new RoundedBoxGeometry(0.06, 0.03, 0.09, 2, 0.01).rotateX(-0.5), m.black, 0, 0.02, -0.07)); // tongue
      for (let k = 0; k < 4; k++) foot.add(mesh(new THREE.BoxGeometry(0.058, 0.007, 0.01), m.glowLime, 0, 0.012 - k * 0.012, -0.05 - k * 0.026)); // laces
      foot.add(mesh(new RoundedBoxGeometry(0.04, 0.06, 0.02, 2, 0.008), m.sole, 0, 0.0, 0.085)); // heel tab
      foot.add(mesh(new THREE.CapsuleGeometry(0.012, 0.05, 4, 10).rotateX(Math.PI / 2), m.air, side * 0.052, -0.058, 0.045)); // air unit
      foot.add(mesh(new THREE.TorusGeometry(0.07, 0.004, 5, 24, Math.PI).rotateY(Math.PI / 2).scale(1, 0.4, 1.6), m.glowLime, side * 0.058, -0.035, -0.04)); // side stripe
    }

    // -------------------------------------------------------------- torso
    const spine = joint('spine', hips, 0, 0.08, 0);
    const chest = joint('chest', spine, 0, 0.22, 0);
    {
      // Oversized hoodie body from a lathe profile (radius by height).
      const prof = [
        [0.0, -0.3], [0.2, -0.3], [0.215, -0.27], [0.215, -0.1], [0.225, 0.05], [0.235, 0.18], [0.23, 0.26], [0.19, 0.31], [0.11, 0.335], [0.0, 0.34],
      ].map(([r, y]) => new THREE.Vector2(r, y));
      const body = wrinkle(new THREE.LatheGeometry(prof, 32).scale(1, 1, 0.72), 0.005, 16, 2);
      chest.add(mesh(body, m.hoodie, 0, 0.0, 0));
      chest.add(mesh(new THREE.TorusGeometry(0.214, 0.03, 8, 32).rotateX(Math.PI / 2).scale(1, 0.72, 1), m.rib, 0, -0.29, 0)); // hem
      // Kangaroo pocket.
      const pocket = new THREE.CylinderGeometry(0.228, 0.222, 0.13, 24, 1, true, Math.PI - 0.75, 1.5).scale(1, 1, 0.74);
      chest.add(mesh(pocket, m.hoodie, 0, -0.17, 0));
      // Curved logos (front chest, big A on the back).
      const front = new THREE.CylinderGeometry(0.2365, 0.2335, 0.2, 24, 1, true, Math.PI - 0.55, 1.1).scale(1, 1, 0.725);
      chest.add(mesh(front, m.logoFront, 0, 0.1, 0));
      const back = new THREE.CylinderGeometry(0.236, 0.232, 0.27, 24, 1, true, -0.62, 1.24).scale(1, 1, 0.725);
      chest.add(mesh(back, m.logoBack, 0, 0.06, 0));
      // Hood resting on the shoulders.
      this.hood.position.set(0, 0.3, 0.07);
      chest.add(this.hood);
      this.hood.add(mesh(wrinkle(new THREE.SphereGeometry(0.15, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.62).scale(1.05, 0.72, 0.9).rotateX(-0.9), 0.006, 20, 5), m.hoodie, 0, 0.02, 0.03));
      chest.add(mesh(new THREE.TorusGeometry(0.105, 0.035, 10, 28).rotateX(Math.PI / 2 - 0.25).scale(1, 1, 0.95), m.hoodie, 0, 0.3, 0.0)); // hood opening roll
      // Drawstrings with lime aglets (spring-driven).
      for (const sx of [-1, 1]) {
        const s = new THREE.Group();
        s.position.set(sx * 0.055, 0.29, -0.13);
        s.add(mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.2, 6).translate(0, -0.1, 0), m.black));
        s.add(mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.035, 8), m.glowLime, 0, -0.215, 0));
        chest.add(s);
        this.strings.push(s);
      }
    }

    // -------------------------------------------------------------- arms
    for (const side of [-1, 1] as const) {
      const L = side < 0 ? 'L' : 'R';
      const shoulder = joint(`shoulder${L}` as JointName, chest, side * 0.235, 0.22, 0);
      shoulder.add(mesh(smooth(new THREE.SphereGeometry(0.085, 16, 10).scale(1.1, 0.9, 1)), m.hoodie, side * 0.01, -0.01, 0));
      shoulder.add(mesh(wrinkle(limb(0.078, 0.07, 0.27, 0.95), 0.006, 24, side + 7), m.hoodie, side * 0.012, -0.02, 0));
      const elbow = joint(`elbow${L}` as JointName, shoulder, side * 0.014, -0.29, 0);
      elbow.add(mesh(wrinkle(limb(0.068, 0.058, 0.22, 0.95), 0.006, 24, side + 11), m.hoodie));
      elbow.add(mesh(new THREE.CylinderGeometry(0.052, 0.056, 0.05, 20), m.rib, 0, -0.235, 0)); // cuff
      elbow.add(mesh(new THREE.CylinderGeometry(0.034, 0.036, 0.05, 14), m.skin, 0, -0.275, 0)); // wrist
      if (side > 0) {
        // Smartwatch with holo face.
        elbow.add(mesh(new THREE.CylinderGeometry(0.041, 0.041, 0.025, 18), m.black, 0, -0.27, 0));
        elbow.add(mesh(new RoundedBoxGeometry(0.035, 0.012, 0.045, 2, 0.005), m.glowLime, 0.0, -0.27, -0.037));
      }
      const hand = joint(`hand${L}` as JointName, elbow, 0, -0.3, 0);
      // Loose fist: palm + curled fingers + thumb.
      const fist = mergeGeometries([
        new RoundedBoxGeometry(0.075, 0.08, 0.085, 3, 0.03).translate(0, -0.035, 0),
        new THREE.CapsuleGeometry(0.018, 0.05, 4, 8).rotateZ(Math.PI / 2).translate(0, -0.085, -0.02).toNonIndexed(),
        new THREE.CapsuleGeometry(0.016, 0.035, 4, 8).rotateX(0.6).translate(-side * 0.035, -0.04, -0.03).toNonIndexed(),
      ])!;
      hand.add(mesh(smooth(fist), m.skin));
    }

    // -------------------------------------------------------------- head
    const neck = joint('neck', chest, 0, 0.33, 0);
    neck.add(mesh(new THREE.CylinderGeometry(0.052, 0.06, 0.1, 16), m.skin, 0, 0.03, 0));
    // Headphones resting around the neck.
    {
      const band = mesh(new THREE.TorusGeometry(0.1, 0.012, 8, 28, Math.PI), m.black, 0, 0.0, 0.03);
      band.rotation.set(-Math.PI / 2 + 0.3, 0, 0);
      neck.add(band);
      for (const sx of [-1, 1]) {
        const cup = mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.04, 20).rotateZ(Math.PI / 2), m.black, sx * 0.105, -0.005, -0.02);
        cup.add(mesh(new THREE.TorusGeometry(0.036, 0.005, 6, 20).rotateY(Math.PI / 2), m.glowLime, sx * 0.022, 0, 0));
        cup.add(mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.012, 20).rotateZ(Math.PI / 2), lib.carbon, sx * 0.02, 0, 0));
        neck.add(cup);
      }
    }
    const head = joint('head', neck, 0, 0.08, 0);
    {
      const skull = smooth(mergeGeometries([
        new THREE.SphereGeometry(0.1, 28, 20).scale(0.93, 1.1, 1.02).translate(0, 0.12, 0.005).toNonIndexed(),
        new THREE.SphereGeometry(0.075, 20, 14).scale(0.95, 0.85, 1.0).translate(0, 0.055, -0.025).toNonIndexed(), // jaw
      ])!);
      head.add(mesh(skull, m.skin));
      head.add(mesh(new THREE.ConeGeometry(0.016, 0.042, 10).rotateX(-Math.PI / 2 - 0.35).scale(1.1, 1, 1), m.skin, 0, 0.1, -0.1)); // nose
      head.add(mesh(new THREE.SphereGeometry(0.014, 10, 8).scale(1.3, 0.8, 1), m.skin, 0, 0.087, -0.107)); // nose tip
      for (const sx of [-1, 1]) {
        head.add(mesh(new THREE.SphereGeometry(0.025, 12, 10).scale(0.5, 1, 0.8), m.skin, sx * 0.093, 0.115, 0.005)); // ears
        const eye = new THREE.Group();
        eye.position.set(sx * 0.037, 0.132, -0.082);
        eye.add(mesh(new THREE.SphereGeometry(0.017, 16, 12).scale(1.15, 0.72, 0.6), m.sclera));
        eye.add(mesh(new THREE.CircleGeometry(0.0105, 18), m.iris, 0, 0, -0.0105));
        eye.add(mesh(new THREE.CircleGeometry(0.0048, 14), m.pupil, 0, 0, -0.0107));
        eye.add(mesh(new THREE.CircleGeometry(0.0028, 10), m.glint, sx * 0.004, 0.004, -0.0109));
        eye.children.forEach((c) => (c.rotation.y = Math.PI));
        head.add(eye);
        // Heavy upper lid gives the confident half-lidded look from the art.
        const lid = mesh(new THREE.SphereGeometry(0.0182, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42).scale(1.2, 0.75, 0.65).rotateX(-0.35), m.skin, sx * 0.037, 0.136, -0.082);
        head.add(lid);
        const brow = mesh(new RoundedBoxGeometry(0.04, 0.009, 0.012, 2, 0.003), m.brow, sx * 0.038, 0.157, -0.092);
        brow.rotation.z = sx * -0.14;
        head.add(brow);
      }
      // Lips with a slight smirk.
      const lips = mesh(new THREE.CapsuleGeometry(0.009, 0.034, 4, 10).rotateZ(Math.PI / 2 + 0.08), m.lip, 0.004, 0.064, -0.093);
      head.add(lips);
      this.hair.position.set(0, 0.0, 0);
      head.add(this.hair);
      this.hair.add(mesh(hairGeometry(), m.hair));
    }

    // -------------------------------------------------------- laptop (menu)
    const alu = lib.gunmetal;
    this.laptop.add(mesh(new RoundedBoxGeometry(0.34, 0.018, 0.24, 2, 0.006), alu));
    this.laptopLid.position.set(0, 0.01, -0.12);
    this.laptopLid.add(mesh(new RoundedBoxGeometry(0.34, 0.23, 0.01, 2, 0.004), alu, 0, 0.115, 0));
    const lidLogo = mesh(new THREE.PlaneGeometry(0.07, 0.07), new THREE.MeshBasicMaterial({ map: logoTexture(false), transparent: true, color: new THREE.Color(C.magenta).multiplyScalar(2) }), 0, 0.115, -0.006);
    lidLogo.rotation.y = Math.PI;
    this.laptopLid.add(lidLogo);
    this.laptopLid.add(mesh(new THREE.BoxGeometry(0.33, 0.004, 0.012), m.glowPink, 0, 0.228, 0));
    this.laptop.add(this.laptopLid);
    this.laptop.position.set(0.0, -0.1, -0.1);
    this.laptop.rotation.x = -Math.PI / 2;
    this.j.handL.add(this.laptop);

    this.root.traverse((o) => (o.frustumCulled = false));
  }

  // ----------------------------------------------------------------- control

  reset(): void {
    this.deathT = 0;
    this.turn = 1;
    this.laptopT = 1;
    this.reactT = 0;
    this.trickKind = null;
    this.trickG.rotation.set(0, 0, 0);
    this.trickG.position.set(0, PIVOT, 0);
    this.w = { run: 0, air: 0, slide: 0, idle: 1 };
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.yaw.rotation.y = Math.PI;
    this.laptop.visible = true;
    this.laptop.scale.setScalar(1);
    this.laptopLid.rotation.x = LID_OPEN;
    for (const n of JOINTS) this.j[n].rotation.set(0, 0, 0);
    for (const s of Object.values(this.springs)) s.x = s.v = 0;
  }

  /** Play a fight move (punch / kicks / spins / flips). */
  trick(kind: Trick, dur?: number): void {
    this.trickKind = kind;
    this.trickT = 0;
    this.trickDur = dur ?? TRICK_DUR[kind];
    if (kind === 'punch' || kind === 'kick') this.trickSide = -this.trickSide;
  }

  /** Stop a move at once (the player needs to dodge). */
  cancelTrick(): void {
    this.trickKind = null;
  }

  get tricking(): Trick | null {
    return this.trickKind;
  }

  land(): void {
    this.landKick = 1;
  }

  /** Flinch away from something that just whizzed past (dir: -1 left, 1 right, 0 below/above). */
  react(dir: number): void {
    this.reactT = 1;
    this.reactDir = dir;
  }

  getFootWorld(side: 0 | 1, out: THREE.Vector3): THREE.Vector3 {
    if (this.avatar?.getFootWorld(side, out)) return out;
    return this.j[side === 0 ? 'footL' : 'footR'].localToWorld(out.set(0, -0.07, 0.06));
  }

  /** Power-up transformation: blend the rim light toward a colour. null = normal. */
  setMode(color: THREE.ColorRepresentation | null, dt: number): void {
    const target = color === null ? 0 : 1;
    if (color !== null) CHARACTER_RIM.color.value.lerp(this.tmpColor.set(color), Math.min(1, dt * 10));
    CHARACTER_RIM.mix.value += (target - CHARACTER_RIM.mix.value) * Math.min(1, dt * 8);
  }

  // --------------------------------------------------------------- animation

  update(a: AnimInput): void {
    const dt = a.dt;
    this.time += dt;

    const tRun = a.running && a.grounded && !a.sliding && !a.idle ? 1 : 0;
    const tAir = a.running && !a.grounded && !a.idle ? 1 : 0;
    const tSlide = a.running && a.sliding && !a.idle ? 1 : 0;
    const tIdle = a.idle ? 1 : 0;
    const k = damp(14, dt);
    this.w.run += (tRun - this.w.run) * k;
    this.w.air += (tAir - this.w.air) * damp(18, dt);
    this.w.slide += (tSlide - this.w.slide) * damp(20, dt);
    this.w.idle += (tIdle - this.w.idle) * k;

    this.turn += ((a.idle ? 1 : 0) - this.turn) * damp(a.idle ? 6 : 11, dt);
    this.yaw.rotation.y = this.turn * Math.PI;
    this.laptopT = a.idle ? Math.min(1, this.laptopT + dt * 3) : Math.max(0, this.laptopT - dt * 4);
    this.laptopLid.rotation.x = LID_CLOSED + (LID_OPEN - LID_CLOSED) * clamp((this.laptopT - 0.5) * 2, 0, 1);
    this.laptop.scale.setScalar(clamp(this.laptopT * 2, 0, 1));
    this.laptop.visible = this.laptopT > 0.01;

    if (a.dead) {
      this.animateDeath(dt);
      return;
    }
    this.deathT = 0;

    const speedK = clamp(a.speed / 40, 0, 1);
    const cadence = 1.5 + a.speed * 0.055;
    const prevPhase = this.phase;
    if (a.running || this.w.run > 0.05) this.phase += dt * cadence * Math.PI * 2;
    if (a.running && a.grounded && !a.sliding) this.detectFootsteps(prevPhase, this.phase);

    const T = this.T;
    for (const v of T.values()) v.set(0, 0, 0);
    let bodyY = 0;
    let bodyTiltX = 0;
    const add = (n: JointName, x: number, y: number, z: number, wgt: number): void => {
      const v = T.get(n)!;
      v.x += x * wgt;
      v.y += y * wgt;
      v.z += z * wgt;
    };

    // ---- fight move: weight fades the run out while it plays
    let wt = 0;
    let u = 0;
    if (this.trickKind) {
      this.trickT += dt / this.trickDur;
      if (this.trickT >= 1) this.trickKind = null;
      else {
        u = this.trickT;
        wt = Math.min(1, u / 0.12, (1 - u) / 0.15);
      }
    }
    // ---- run: pelvis yaw, counter-rotating chest, pumping arms, foot roll
    const wr = this.w.run * (1 - wt);
    // With the 3D model the run comes from its own motion clip.
    if (wr > 0.001 && !this.avatar) {
      const p = this.phase;
      const s = Math.sin(p);
      const c = Math.cos(p);
      const stride = 0.85 + speedK * 0.35;
      add('hips', 0, s * 0.2, 0, wr);
      add('spine', -0.12 - speedK * 0.12, -s * 0.12, 0, wr);
      add('chest', -0.06, -s * 0.18, c * 0.03, wr);
      add('head', 0.14 + speedK * 0.08, s * 0.15, 0, wr);
      add('thighL', s * stride, 0, 0.03, wr);
      add('thighR', -s * stride, 0, -0.03, wr);
      add('kneeL', -(0.25 + 1.45 * Math.max(0, c) + 0.5 * Math.max(0, -s)), 0, 0, wr);
      add('kneeR', -(0.25 + 1.45 * Math.max(0, -c) + 0.5 * Math.max(0, s)), 0, 0, wr);
      add('footL', 0.35 * Math.max(0, -c) - 0.2 * Math.max(0, s), 0, 0, wr);
      add('footR', 0.35 * Math.max(0, c) - 0.2 * Math.max(0, -s), 0, 0, wr);
      add('shoulderL', -s * (0.75 + speedK * 0.35), 0.1, -0.12, wr);
      add('shoulderR', s * (0.75 + speedK * 0.35), -0.1, 0.12, wr);
      add('elbowL', 1.45 - 0.3 * Math.max(0, s), 0, 0, wr);
      add('elbowR', 1.45 - 0.3 * Math.max(0, -s), 0, 0, wr);
      add('handL', 0.2, 0, 0, wr);
      add('handR', 0.2, 0, 0, wr);
      bodyY += (Math.abs(c) * 0.075 - 0.04) * wr;
    }

    // ---- air: tuck on the way up, reach down for landing
    const wa = this.w.air;
    if (wa > 0.001) {
      const up = clamp(a.vy / 10 + 0.5, 0, 1);
      const dn = 1 - up;
      add('thighL', 1.35 * up + 0.5 * dn, 0, 0, wa);
      add('thighR', 0.25 * up - 0.3 * dn, 0, 0, wa);
      add('kneeL', -1.8 * up - 0.45 * dn, 0, 0, wa);
      add('kneeR', -1.25 * up - 0.3 * dn, 0, 0, wa);
      add('footL', 0.4 * up, 0, 0, wa);
      add('shoulderL', -0.6 * up - 0.3 * dn, 0, -0.6 * up - 1.1 * dn, wa);
      add('shoulderR', 0.3 * up - 0.3 * dn, 0, 0.6 * up + 1.1 * dn, wa);
      add('elbowL', 0.9, 0, 0, wa);
      add('elbowR', 0.7, 0, 0, wa);
      add('spine', -0.25 * up + 0.05 * dn, 0, 0, wa);
      add('head', 0.15, 0, 0, wa);
    }

    // ---- slide: lean back, lead leg out, trailing leg tucked, hand skims the floor
    const ws = this.w.slide;
    if (ws > 0.001) {
      add('hips', 1.2, 0.15, 0, ws);
      add('spine', -0.25, 0, 0, ws);
      add('chest', -0.15, -0.2, 0, ws);
      add('head', -0.45, 0.2, 0, ws);
      add('thighL', 0.15, 0, 0.05, ws);
      add('kneeL', -0.05, 0, 0, ws);
      add('footL', 0.3, 0, 0, ws);
      add('thighR', 0.55, 0, -0.12, ws);
      add('kneeR', -1.4, 0, 0, ws);
      add('shoulderL', -0.9, 0, -0.5, ws);
      add('elbowL', 0.3, 0, 0, ws);
      add('shoulderR', 0.9, 0, 0.7, ws);
      add('elbowR', 0.9, 0, 0, ws);
      bodyY -= 0.6 * ws;
    }

    // ---- idle (menu): confident stance, weight on one leg, laptop in hand
    const wi = this.w.idle;
    if (wi > 0.001) {
      const br = Math.sin(this.time * 2.0);
      add('hips', 0, 0.05, 0.05, wi);
      add('spine', -0.03 + br * 0.02, 0.06, -0.02, wi);
      add('chest', br * 0.015, 0.04, 0, wi);
      add('head', 0.05 - br * 0.015, -0.18 + Math.sin(this.time * 0.6) * 0.14, 0.12, wi);
      add('thighL', 0.02, 0, -0.04, wi);
      add('thighR', 0.16, -0.18, 0.08, wi);
      add('kneeR', -0.25, 0, 0, wi);
      add('footR', 0.1, 0, 0, wi);
      add('shoulderL', 0.1, 0, -0.1, wi);
      add('elbowL', this.avatar ? 0.3 : 1.5, 0, 0, wi);
      add('handL', 0, 0, 0, wi);
      add('shoulderR', -0.05, 0, 0.12 + br * 0.02, wi);
      add('elbowR', 0.25, 0, 0, wi);
      bodyY += br * 0.008 * wi;
    }

    if (wt > 0) this.poseTrick(this.trickKind!, u, wt, add);
    else {
      this.trickG.rotation.set(0, 0, 0);
      this.trickG.position.set(0, PIVOT, 0);
    }

    // ---- stumble jerk
    if (a.stumble > 0) {
      const st = a.stumble;
      add('spine', 0.45, 0, 0, st);
      add('head', 0.4, 0, 0, st);
      add('shoulderL', -1.1, 0, -1.2, st);
      add('shoulderR', -1.1, 0, 1.2, st);
      bodyTiltX += 0.12 * st;
    }

    // ---- near-miss flinch: lean away, head snaps round
    this.reactT = Math.max(0, this.reactT - dt * 3.5);
    if (this.reactT > 0) {
      const r = Math.sin(this.reactT * Math.PI);
      add('chest', 0, 0, -this.reactDir * 0.25 * r, 1);
      add('head', -0.1 * r, this.reactDir * 0.5 * r, 0, 1);
      add('shoulderL', 0, 0, -0.4 * r, 1);
      add('shoulderR', 0, 0, 0.4 * r, 1);
    }

    // Landing: absorb through the knees, arms fly out.
    this.landKick = Math.max(0, this.landKick - dt * 5);
    const lk = this.landKick;
    bodyY -= lk * 0.14;
    add('kneeL', -0.7 * lk, 0, 0, 1);
    add('kneeR', -0.7 * lk, 0, 0, 1);
    add('thighL', 0.4 * lk, 0, 0, 1);
    add('thighR', 0.4 * lk, 0, 0, 1);
    add('spine', 0.2 * lk, 0, 0, 1);
    add('shoulderL', 0, 0, -0.5 * lk, 1);
    add('shoulderR', 0, 0, 0.5 * lk, 1);

    const kj = damp(26, dt);
    for (const n of JOINTS) {
      const t = T.get(n)!;
      const r = this.j[n].rotation;
      r.x += (t.x - r.x) * kj;
      r.y += (t.y - r.y) * kj;
      r.z += (t.z - r.z) * kj;
    }

    // Lane-change lean into the turn (body banks, head stays level).
    const lean = clamp(a.laneOffset * 0.22, -0.38, 0.38);
    this.body.rotation.z += (lean - this.body.rotation.z) * damp(16, dt);
    this.j.head.rotation.z -= this.body.rotation.z * 0.6;
    this.body.rotation.x += (bodyTiltX + (a.running && !a.idle ? speedK * 0.05 : 0) - this.body.rotation.x) * damp(16, dt);
    this.body.position.y += (bodyY - this.body.position.y) * damp(24, dt);
    this.body.position.z += (0 - this.body.position.z) * damp(10, dt);

    this.secondary(a, dt);
    this.avatar?.update(this.j, this.w.run * (1 - wt), this.phase);
  }

  /** Joint targets + whole-body flips/spins for a fight move at progress u. */
  private poseTrick(k: Trick, u: number, w: number, add: (n: JointName, x: number, y: number, z: number, wgt: number) => void): void {
    const G = this.trickG;
    const e = Math.sin(Math.PI * u);
    const sd = this.trickSide;
    let lift = 0;
    G.rotation.set(0, 0, 0);
    // Strike peak: fast out, hold, return.
    const hit = Math.min(1, u / 0.3) * Math.min(1, (1 - u) / 0.35);
    const arm = sd > 0 ? 'R' : 'L';
    const leg = sd > 0 ? 'R' : 'L';
    switch (k) {
      case 'punch':
        add('chest', 0, sd * 0.55 * hit, 0, w);
        add('spine', 0.1, sd * 0.2 * hit, 0, w);
        add(`shoulder${arm}`, 1.55 * hit, 0, 0, w);
        add(`elbow${arm}`, 0.1, 0, 0, w);
        add(`shoulder${arm === 'R' ? 'L' : 'R'}`, 0.6, 0, 0, w);
        add(`elbow${arm === 'R' ? 'L' : 'R'}`, 1.8, 0, 0, w);
        add(`thigh${leg === 'R' ? 'L' : 'R'}`, 0.4, 0, 0, w);
        add(`knee${leg === 'R' ? 'L' : 'R'}`, -0.5, 0, 0, w);
        break;
      case 'kick':
        lift = 0.18 * e;
        add('spine', -0.35 * hit, 0, 0, w);
        add(`thigh${leg}`, 1.75 * hit, 0, 0, w);
        add(`knee${leg}`, -0.15 - 1.2 * (1 - hit), 0, 0, w);
        add(`foot${leg}`, -0.4, 0, 0, w);
        add(`knee${leg === 'R' ? 'L' : 'R'}`, -0.3, 0, 0, w);
        add('shoulderL', 0.3, 0, -0.9 * hit, w);
        add('shoulderR', 0.3, 0, 0.9 * hit, w);
        add('elbowL', 1.2, 0, 0, w);
        add('elbowR', 1.2, 0, 0, w);
        break;
      case 'spinL':
      case 'spinR': {
        // Spinning roundhouse: a full turn with the leg out.
        const dir = k === 'spinL' ? 1 : -1;
        lift = 0.45 * e;
        G.rotation.y = dir * Math.PI * 2 * ease(u);
        const l = k === 'spinL' ? 'R' : 'L';
        add(`thigh${l}`, 0.9 * e, 0, (l === 'R' ? -1 : 1) * 1.2 * e, w);
        add(`knee${l}`, -0.1, 0, 0, w);
        add(`knee${l === 'R' ? 'L' : 'R'}`, -1.2 * e, 0, 0, w);
        add(`thigh${l === 'R' ? 'L' : 'R'}`, 0.6 * e, 0, 0, w);
        add('shoulderL', 0, 0, -1.3 * e, w);
        add('shoulderR', 0, 0, 1.3 * e, w);
        add('spine', 0, 0, dir * 0.3 * e, w);
        break;
      }
      case 'flip':
      case 'finisher': {
        // Backflip; the finisher is higher and snaps out a flying kick at the top.
        const big = k === 'finisher';
        lift = (big ? 2.1 : 1.35) * e;
        G.rotation.x = Math.PI * 2 * ease(Math.min(1, u * 1.1));
        const tuck = Math.sin(Math.PI * Math.min(1, u * 1.25));
        const kickOut = big ? Math.max(0, Math.sin(Math.PI * (u - 0.45) / 0.35)) * (u > 0.45 && u < 0.8 ? 1 : 0) : 0;
        add('thighL', 1.5 * tuck, 0, 0, w);
        add('thighR', 1.5 * tuck * (1 - kickOut) + 1.8 * kickOut, 0, 0, w);
        add('kneeL', -2.0 * tuck, 0, 0, w);
        add('kneeR', -2.0 * tuck * (1 - kickOut), 0, 0, w);
        add('spine', 0.4 * tuck, 0, 0, w);
        add('head', 0.3 * tuck, 0, 0, w);
        add('shoulderL', 0.9 * tuck, 0, -0.5, w);
        add('shoulderR', 0.9 * tuck, 0, 0.5, w);
        add('elbowL', 1.3, 0, 0, w);
        add('elbowR', 1.3, 0, 0, w);
        break;
      }
      case 'sweep':
        // Low breakdance sweep: drop, spin, one leg straight out.
        lift = -0.45 * e;
        G.rotation.y = Math.PI * 2 * ease(u) * -sd;
        add('thighL', 0.2, 0, 1.3 * e, w);
        add('kneeL', -0.05, 0, 0, w);
        add('thighR', 1.2 * e, 0, 0, w);
        add('kneeR', -2.2 * e, 0, 0, w);
        add('spine', 0.5 * e, 0, 0, w);
        add('shoulderR', 0.8, 0, 0.9 * e, w);
        add('shoulderL', 0.8, 0, -0.9 * e, w);
        break;
    }
    G.position.y = PIVOT + lift * w;
  }

  /** Spring-driven cloth and hair: they lag and bounce with body motion. */
  private secondary(a: AnimInput, dt: number): void {
    const S = this.springs;
    const accY = (a.vy - this.prevVy) / Math.max(dt, 1e-3);
    this.prevVy = a.vy;
    const lat = (a.laneOffset - this.prevLane) / Math.max(dt, 1e-3);
    this.prevLane = a.laneOffset;
    const bob = this.w.run * Math.sin(this.phase * 2) * 0.5;
    const drag = a.running && !a.idle ? clamp(a.speed / 40, 0, 1) : 0;

    const hood = S.hood.step(-accY * 0.004 + bob * 0.15 + drag * 0.15, dt);
    this.hood.rotation.x = clamp(hood, -0.4, 0.5);
    const hair = S.hair.step(drag * 0.35 - accY * 0.006 + bob * 0.1, dt);
    const hairSide = S.hairSide.step(lat * 0.02, dt);
    this.hair.rotation.set(clamp(hair, -0.2, 0.45) * 0.4, 0, clamp(hairSide, -0.3, 0.3) * 0.3);
    const str = S.strings.step(-drag * 0.9 - accY * 0.01 + bob * 0.6 + (this.w.slide > 0.5 ? -1 : 0), dt);
    const strSide = S.stringsSide.step(lat * 0.04 + Math.sin(this.phase) * this.w.run * 0.4, dt);
    this.strings.forEach((s, i) => {
      s.rotation.x = clamp(str, -1.6, 0.8) * (i ? 1.05 : 0.95);
      s.rotation.z = clamp(strSide, -0.8, 0.8);
    });
    const ch = S.chain.step(Math.sin(this.phase) * this.w.run * 0.5 - accY * 0.008, dt);
    this.chain.rotation.x = clamp(ch, -0.5, 0.5) * 0.4;
  }

  private detectFootsteps(prev: number, cur: number): void {
    const TAU = Math.PI * 2;
    for (const [side, at] of [
      [0, Math.PI / 2],
      [1, (3 * Math.PI) / 2],
    ] as const) {
      const a0 = (((prev - at) % TAU) + TAU) % TAU;
      const a1 = (((cur - at) % TAU) + TAU) % TAU;
      if (a1 < a0 && this.lastStepSide !== side + 1) {
        this.lastStepSide = side + 1;
        this.onFootstep(side);
      }
    }
  }

  private animateDeath(dt: number): void {
    this.deathT += dt;
    const t = Math.min(this.deathT / 0.6, 1);
    const e = 1 - (1 - t) * (1 - t);
    this.body.rotation.x = e * 1.4;
    this.body.rotation.z = e * 0.3;
    this.body.position.z = e * 0.7;
    this.body.position.y = Math.sin(t * Math.PI) * 0.8 - e * 0.1;
    const kj = damp(14, dt);
    const set = (n: JointName, x: number, z = 0): void => {
      const r = this.j[n].rotation;
      r.x += (x - r.x) * kj;
      r.z += (z - r.z) * kj;
      r.y += (0 - r.y) * kj;
    };
    set('hips', 0);
    set('spine', 0.1);
    set('chest', 0.1);
    set('head', 0.5);
    set('shoulderL', -2.4, -0.5);
    set('shoulderR', -2.1, 0.6);
    set('elbowL', 0.4);
    set('elbowR', 0.6);
    set('thighL', 0.7);
    set('thighR', 0.2);
    set('kneeL', -0.9);
    set('kneeR', -0.3);
    this.secondary({ dt, speed: 0, running: false, grounded: true, vy: 0, sliding: false, laneOffset: 0, stumble: 0, dead: true, idle: false }, dt);
    this.w.run = Math.max(0, this.w.run - dt * 6);
    this.avatar?.update(this.j, this.w.run, this.phase);
  }
}
