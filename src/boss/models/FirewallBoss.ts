import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { THEME } from '../../core/Theme';
import type { MaterialLib } from '../../render/MaterialLib';
import { BossModel, chain, energyMaterial, type BossPose } from '../BossModel';

const ORANGE = '#ff6a1a';
const GOLD = '#ffb020';

/**
 * FIREWALL - the perimeter defence system: a colossal hexagonal shield of
 * molten hex-cells between two flame pylons, a crown of antennae and a core
 * eye. Rises out of the data streams, raises walls of fire, locks lanes
 * down and sweeps scan lasers. Weak point: the core eye.
 */
export class FirewallBoss extends BossModel {
  readonly height = 11;
  readonly hover = 6.2;
  private readonly frame = new THREE.Group();
  private readonly shield = new THREE.Group();
  private readonly ring = new THREE.Group();
  private readonly pylons: THREE.Group[] = [];
  private readonly vents: THREE.MeshBasicMaterial;
  private readonly cables: THREE.Object3D[][] = [];
  private readonly crown = new THREE.Group();
  private readonly hexU = { uIgnite: { value: 0 }, uTime: THEME.uTime, uRage: this.u.rage, uHurt: this.u.hurt, uHot: this.u.hot };
  private readonly eye: THREE.Mesh;

  constructor(lib: MaterialLib) {
    super(lib);
    const frameMat = this.armorMaterial(0x16141a, ORANGE, { rough: 0.26, emissive: 0x120400 });
    const darkMat = this.armorMaterial(0x0c0c10, GOLD, { rough: 0.4, rimStrength: 0.6 });
    const trim = this.glow(ORANGE, 2.4);
    this.vents = this.glow(ORANGE, 2);
    const coreMat = energyMaterial('#ffe0a0', this.u, { veins: 0.4, power: 1.1 });

    this.root.add(this.frame);
    // Hex shield frame, facing the runner (+Z).
    const hexFrame = new THREE.Mesh(new THREE.CylinderGeometry(4.3, 4.3, 0.7, 6, 1).rotateX(Math.PI / 2).rotateZ(Math.PI / 6), frameMat);
    this.shield.add(hexFrame);
    const hexFace = new THREE.Mesh(
      new THREE.CircleGeometry(3.85, 6).rotateZ(Math.PI / 6),
      new THREE.ShaderMaterial({
        uniforms: this.hexU,
        vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: /* glsl */ `
          uniform float uIgnite; uniform float uTime; uniform float uRage; uniform float uHurt; uniform float uHot;
          varying vec2 vP;
          vec2 hexCell(vec2 p) {
            vec2 r = vec2(1.0, 1.732);
            vec2 h = r * 0.5;
            vec2 a = mod(p, r) - h;
            vec2 b = mod(p - h, r) - h;
            return dot(a, a) < dot(b, b) ? a : b;
          }
          void main() {
            vec2 p = vP * 1.25;
            vec2 c = hexCell(p);
            float d = max(abs(c.x) * 0.866 + abs(c.y) * 0.5, abs(c.y));
            float edge = smoothstep(0.38, 0.47, d);
            vec2 id = p - c;
            float r = length(vP);
            float lit = (1.0 - smoothstep(uIgnite * 5.0 - 0.6, uIgnite * 5.0, r)) * step(0.02, uIgnite);
            float flow = 0.5 + 0.5 * sin(id.x * 1.7 + id.y * 2.3 + uTime * (2.0 + uRage * 5.0));
            vec3 lava = mix(vec3(1.0, 0.25, 0.02), vec3(1.0, 0.75, 0.2), flow);
            lava = mix(lava, vec3(1.0, 0.95, 0.85), uRage * 0.35 + uHot * 0.4);
            vec3 col = lava * (0.35 + flow * 0.5) * (1.0 - edge * 0.85) + lava * edge * 2.2;
            col *= lit * (1.0 + uHot);
            col = mix(col, vec3(2.0), uHurt * 0.7);
            gl_FragColor = vec4(col + vec3(0.02, 0.01, 0.0), 1.0);
          }`,
      }),
    );
    hexFace.position.z = 0.36;
    this.shield.add(hexFace);
    // Core eye (weak point).
    this.eye = new THREE.Mesh(new THREE.SphereGeometry(0.95, 32, 24), coreMat);
    this.eye.position.z = 0.9;
    const socket = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.22, 16, 48), frameMat);
    socket.position.z = 0.6;
    const iris = new THREE.Mesh(new THREE.TorusGeometry(1.02, 0.05, 8, 48), trim);
    iris.position.z = 0.95;
    this.shield.add(this.eye, socket, iris);
    this.core.position.set(0, 0, 1.6);
    this.frame.add(this.shield);

    // Rotating outer ring of armour segments.
    const segGeo = new RoundedBoxGeometry(2.1, 0.55, 0.9, 3, 0.1);
    const segLine = new THREE.BoxGeometry(1.9, 0.06, 0.06);
    const segs: THREE.Object3D[] = [];
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(segGeo, darkMat);
      const l = new THREE.Mesh(segLine, trim);
      l.position.set(0, 0.2, 0.46);
      g.add(m, l);
      const a = (i / 6) * Math.PI * 2;
      g.position.set(Math.cos(a) * 5.0, Math.sin(a) * 5.0, 0);
      g.rotation.z = a + Math.PI / 2;
      this.ring.add(g);
      segs.push(g);
    }
    this.frame.add(this.ring);

    // Flame pylons with glowing vents and burner nozzles.
    const towerGeo = new RoundedBoxGeometry(1.3, 7.4, 1.4, 3, 0.12);
    const ventGeo = new THREE.BoxGeometry(1.36, 0.1, 0.9);
    const nozzleGeo = new THREE.CylinderGeometry(0.45, 0.7, 0.8, 16, 1, true);
    const flameMat = energyMaterial(ORANGE, this.u, { veins: 1.2, power: 1.4 });
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(side * 6.6, 0, 0);
      const tower = new THREE.Mesh(towerGeo, frameMat);
      g.add(tower);
      for (let k = 0; k < 7; k++) {
        const v = new THREE.Mesh(ventGeo, this.vents);
        v.position.set(0, -2.6 + k * 0.85, 0.3);
        g.add(v);
      }
      const nozzle = new THREE.Mesh(nozzleGeo, darkMat);
      nozzle.position.y = -4.05;
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.2, 16, 1, true).rotateX(Math.PI).translate(0, -1.1, 0), flameMat);
      flame.position.y = -4.3;
      flame.name = 'flame';
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.2, 6), frameMat);
      cap.position.y = 4.3;
      g.add(nozzle, flame, cap);
      // Struts to the shield.
      const strut = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.35, 0.5), darkMat);
      strut.position.set(-side * 1.2, 1.5, 0);
      const strut2 = strut.clone();
      strut2.position.y = -1.5;
      g.add(strut, strut2);
      this.frame.add(g);
      this.pylons.push(g);
    }

    // Crown of antennae with glowing tips.
    for (let i = 0; i < 5; i++) {
      const a = (i - 2) * 0.32;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.22, 2.4 - Math.abs(i - 2) * 0.4, 8).translate(0, 1.2, 0), darkMat);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), trim);
      tip.position.y = 2.4 - Math.abs(i - 2) * 0.4;
      spike.add(tip);
      spike.position.set(Math.sin(a) * 4.6, Math.cos(a) * 4.6, -0.2);
      spike.rotation.z = -a;
      this.crown.add(spike);
    }
    this.frame.add(this.crown);

    // Hanging data cables.
    for (let c = 0; c < 4; c++) {
      const segsC: THREE.Object3D[] = [];
      for (let k = 0; k < 7; k++) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.62, 8).translate(0, -0.31, 0), k % 2 ? darkMat : frameMat);
        if (k === 6) {
          const plug = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), trim);
          plug.position.y = -0.7;
          m.add(plug);
        }
        segsC.push(m);
      }
      const anchor = new THREE.Group();
      anchor.position.set((c - 1.5) * 1.9, -3.6, 0);
      this.frame.add(anchor);
      chain(segsC, anchor, new THREE.Vector3(0, -0.62, 0));
      this.cables.push(segsC);
    }

    this.breakable(...segs, ...this.pylons, this.crown, this.shield);
    this.finish();
  }

  protected animate(p: BossPose): void {
    const t = p.time;
    const rage = this.u.rage.value;
    let rise = 0;
    let unfold = 1;
    let dip = 0;
    let flame = 0.3 + rage * 0.3;

    if (p.mode === 'intro') {
      const it = p.introT;
      rise = Math.max(0, 1 - it / 2.2);
      rise = rise * rise * (3 - 2 * rise);
      unfold = Math.min(1, Math.max(0, (it - 1.6) / 1.2));
      this.hexU.uIgnite.value = Math.min(1, Math.max(0, (it - 2.4) / 1.4));
      this.frame.rotation.y = rise * Math.PI * 1.5;
      flame = unfold;
    } else {
      this.hexU.uIgnite.value = p.mode === 'defeat' ? Math.max(0, 1 - p.defeatT * 0.5) : 1;
      this.frame.rotation.y = Math.sin(t * 0.5) * 0.08;
      if (p.mode === 'fight') {
        const k = Math.min(1, p.attackT);
        if (p.attack === 'flame') flame = 0.4 + k * 1.2;
        if (p.attack === 'lockdown') dip = k < 1 ? -k * 1.4 : -Math.max(0, 1.4 - (p.attackT - 1) * 5);
        if (p.attack === 'scan') this.eye.scale.setScalar(1 + k * 0.35);
        else this.eye.scale.setScalar(1);
      }
    }
    this.frame.position.y = -22 * rise + dip + Math.sin(t * 1.1) * 0.35;
    this.frame.rotation.z = Math.sin(t * 0.7) * 0.03 + (p.roar > 0 ? Math.sin(p.roar * 30) * 0.03 : 0);
    this.ring.rotation.z = t * (0.25 + rage * 0.9) + (p.attack === 'scan' ? Math.min(1, p.attackT) * 3 : 0);
    // Phase 3: the ring breaks loose and orbits wider.
    this.ring.scale.setScalar(1 + Math.max(0, rage - 0.7) * 0.5);
    this.pylons.forEach((g, i) => {
      const side = i ? 1 : -1;
      g.rotation.z = side * (1 - unfold) * 1.3 + side * Math.sin(t * 1.3) * 0.03;
      g.position.x = side * (6.6 - (1 - unfold) * 2.5);
      const f = g.getObjectByName('flame')!;
      f.scale.set(1, 0.4 + flame * (0.8 + Math.sin(t * 30 + i) * 0.15), 1);
    });
    this.vents.color.set(ORANGE).multiplyScalar(1.4 + flame * 1.4 + rage);
    this.crown.scale.setScalar(p.mode === 'intro' ? Math.max(0.01, unfold) : 1);
    this.cables.forEach((c, ci) => c.forEach((s, k) => (s.rotation.z = Math.sin(t * 1.8 + ci + k * 0.4) * 0.12 * (1 + rage))));
  }
}
